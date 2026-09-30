import { App, TFile, TFolder, normalizePath } from "obsidian";
import { unzipSync, strFromU8 } from "fflate";
import { idToString, readItemFile } from "./store";
import { DOC_EXTENSION, isReservedFolderName } from "./types";

// The installed fflate types declare their return values with the TS 5.7+
// generic `Uint8Array<TArrayBuffer>` syntax, which the store-lint tool's own
// bundled (older) TypeScript cannot parse — see the matching comment in
// backup.ts. These thin wrappers, round-tripped through `unknown`, keep both
// TS versions satisfied without changing what gets unzipped or decoded.
function unzipSyncTyped(
	data: Uint8Array,
	opts?: { filter?: (file: { name: string; size: number; originalSize: number; compression: number }) => boolean },
): Record<string, Uint8Array> {
	const result: unknown = unzipSync(data, opts);
	return result as Record<string, Uint8Array>;
}
function strFromU8Typed(dat: Uint8Array): string {
	const result: unknown = strFromU8(dat);
	return result as string;
}

/** Per-item edit history, part of the sync safety net.
 *
 *  The daily outline snapshot keeps one copy of everything per day; this keeps
 *  the versions in between. Every change to an item file under the root —
 *  typed here, or arriving from another device — is appended to a per-device
 *  log in the hidden safety-net folder:
 *
 *    .trynalist-backups/device-<id>/history/YYYY-MM-DD.jsonl
 *
 *  one JSON line per version: when, what happened, the item's id, where it
 *  lived, its text and note. Changes are gathered and written once a minute
 *  (and on quit / backgrounding), so typing produces about one version per
 *  item per minute, not one per keystroke. A version identical to the last
 *  one recorded for that item is skipped, which also drops frontmatter-only
 *  writes (fold, reorder).
 *
 *  Kept for RETAIN_DAYS by the file name's date, like the other snapshots.
 *  Local-only: the folder is a dot folder, which Obsidian Sync ignores. */

export const HISTORY_SUBDIR = "history";
const FLUSH_MS = 60_000;
const RETAIN_DAYS = 30;
/** One flush writes at most this many CREATE entries. Beyond it the batch is
 *  an import or a bulk paste: its content is in the import itself and in the
 *  daily snapshot, and logging it would dwarf the log. Edits are not capped. */
const CREATE_CAP = 200;
/** Structure (where the item sits, and whether it is folded) is recorded at a
 *  lower rate than text: only once the item has stayed put for
 *  STRUCT_SETTLE_MS — a run of reorders or fold toggles yields the state it
 *  settled in, not every step — and at most once per STRUCT_GAP_MS per item.
 *  Quitting writes whatever is still waiting. */
const STRUCT_SETTLE_MS = 2 * 60_000;
const STRUCT_GAP_MS = 10 * 60_000;

/** "move" and "fold" are structure-only versions: same text, new place or
 *  fold state. */
export type HistoryKind = "edit" | "create" | "delete" | "move" | "fold";

export interface HistoryEntry {
	/** ISO time the version was recorded. */
	t: string;
	kind: HistoryKind;
	id: string;
	/** Item file path at the time. */
	path: string;
	/** Document folder path (the item's parent folder). */
	doc: string;
	text: string;
	note: string;
	checked?: boolean;
	/** Where it sat: parent id (null = top level), the sibling just above it
	 *  (null = first; undefined = not known), its order value, fold state. */
	parent?: string | null;
	prev?: string | null;
	order?: number;
	collapsed?: boolean;
}

export interface ItemVersion {
	when: string;          // ISO, or "YYYY-MM-DD HHmmss" for a snapshot
	source: "log" | "snapshot";
	kind: HistoryKind | "snapshot";
	text: string;
	note: string;
	checked?: boolean;
	path: string;
	doc: string;
	parent?: string | null;
	prev?: string | null;
	order?: number;
	collapsed?: boolean;
}

/** The id an item file name ends with: `<slug>-<id>.md` or `<slug>-<id> 2.md`
 *  (ids are 10 lowercase letters/digits). Undefined for any other name. */
function idFromName(path: string): string | undefined {
	const m = /-([a-z0-9]{10})(?: \d+)?\.md$/.exec(path);
	return m ? m[1] : undefined;
}

function dayStamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function contentKey(e: { text: string; note: string; checked?: boolean }): string {
	return `${e.text}\u0000${e.note}\u0000${e.checked ? 1 : 0}`;
}

/** Position by neighbour, not by order value: renumbering rewrites every
 *  sibling's order without moving anything, and must not look like a move. */
function structKey(e: { parent?: string | null; prev?: string | null; collapsed?: boolean }): string {
	return `${e.parent ?? ""}\u0000${e.prev ?? ""}\u0000${e.collapsed ? 1 : 0}`;
}

function parentOf(fm: Record<string, unknown>): string | null {
	return typeof fm.parent === "string" && fm.parent !== "__root__" && fm.parent !== "" ? fm.parent : null;
}

export class ItemHistory {
	/** path → what happened since the last flush. */
	private pending = new Map<string, HistoryKind>();
	/** Last content recorded per item id (today's log seeds it), to skip
	 *  repeats. */
	private lastById = new Map<string, string>();
	/** Last structure recorded per id, when it was written, and structure
	 *  changes waiting to settle (id → latest entry + when it last changed). */
	private lastStructById = new Map<string, string>();
	private lastStructAt = new Map<string, number>();
	private structPending = new Map<string, { entry: HistoryEntry; changedAt: number }>();
	/** Last full entry per path, so a delete can say what was deleted — the
	 *  file itself is gone by the time the event arrives. */
	private lastByPath = new Map<string, HistoryEntry>();
	/** A rename out of every document (into _trash, out of the root): old
	 *  path → where the file went, so the delete can read what it held. */
	private movedOut = new Map<string, string>();
	private timer: number | null = null;
	/** Obsidian fires "create" for every existing file while the vault loads;
	 *  those are not changes. Events count only after the layout is ready. */
	private ready = false;
	private seededDay: string | null = null;
	private flushing: Promise<void> | null = null;

	constructor(
		private app: App,
		private deviceDir: () => string,
		private rootFolder: () => string,
		private enabled: () => boolean,
	) {}

	private dir(): string {
		return normalizePath(`${this.deviceDir()}/${HISTORY_SUBDIR}`);
	}

	/** Whether `path` is an outline item: a Markdown file directly inside a
	 *  document folder (one holding a `.trynalist` manifest) under the root,
	 *  and not in a reserved folder such as _trash or _attachments. */
	isItemPath(path: string): boolean {
		const root = normalizePath(this.rootFolder());
		if (!path.endsWith(".md") || !path.startsWith(`${root}/`)) return false;
		const slash = path.lastIndexOf("/");
		const folderPath = path.slice(0, slash);
		const folderName = folderPath.slice(folderPath.lastIndexOf("/") + 1);
		if (isReservedFolderName(folderName)) return false;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		return folder instanceof TFolder
			&& folder.children.some((c) => c instanceof TFile && c.extension === DOC_EXTENSION);
	}

	/** Called from the vault events. Cheap: it only notes the path.
	 *  `file` (when the event has one) lets a delete read the id the
	 *  metadata cache still holds. */
	note(kind: HistoryKind, path: string, file?: TFile): void {
		if (!this.ready || !this.enabled() || !this.isItemPath(path)) return;
		if (kind === "delete" && !this.lastByPath.has(path)) {
			// The file is gone; what we can still say about it is its id — from
			// the metadata cache if it still has it, else from the file name
			// (`<slug>-<id>.md`, maybe with a " 2" collision suffix), which is
			// all a deletion synced from another device leaves behind.
			const fromCache: unknown = file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.id : undefined;
			const cachedId = fromCache !== undefined && fromCache !== null && fromCache !== "" ? fromCache : idFromName(path);
			if (cachedId === undefined || cachedId === null || cachedId === "") {
				this.pending.delete(path);
				return;   // nothing to say about a file we never saw
			}
			this.lastByPath.set(path, {
				t: "", kind: "delete", id: idToString(cachedId as string | number), path,
				doc: path.slice(0, path.lastIndexOf("/")), text: "", note: "",
			});
		}
		const prev = this.pending.get(path);
		// create then edit is still a create; anything then delete is a delete.
		if (!(prev === "create" && kind === "edit")) this.pending.set(path, kind);
		this.schedule();
	}

	/** A rename. Within documents (slug change, move between documents) the
	 *  item lives on under its new path; out of every document (into _trash,
	 *  or out of the root) it is gone, which is a delete. */
	noteRename(file: TFile, oldPath: string): void {
		if (!this.ready || !this.enabled()) return;
		const last = this.lastByPath.get(oldPath);
		const wasItem = this.isItemPath(oldPath);
		const isItem = this.isItemPath(file.path);
		if (wasItem && !isItem) {
			// A delete under the old path. The file still exists where it went,
			// so the flush reads its content from there.
			this.movedOut.set(oldPath, file.path);
			this.pending.set(oldPath, "delete");
			this.schedule();
			return;
		}
		if (last) {
			this.lastByPath.delete(oldPath);
			this.lastByPath.set(file.path, { ...last, path: file.path, doc: file.path.slice(0, file.path.lastIndexOf("/")) });
		}
		const pendingKind = this.pending.get(oldPath);
		this.pending.delete(oldPath);
		if (isItem) {
			this.pending.set(file.path, pendingKind === "create" ? "create" : "edit");
			this.schedule();
		}
	}

	private schedule(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, FLUSH_MS);
	}

	/** Seed repeat-detection from today's log, once per day, so a restart
	 *  does not record every touched item again. */
	private async seedToday(): Promise<void> {
		const day = dayStamp();
		if (this.seededDay === day) return;
		this.seededDay = day;
		this.lastById.clear();
		this.lastStructById.clear();
		this.lastStructAt.clear();
		const path = `${this.dir()}/${day}.jsonl`;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) return;
		for (const line of (await adapter.read(path)).split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line) as HistoryEntry;
				if (!e || typeof e.id !== "string") continue;
				this.lastById.set(e.id, contentKey(e));
				if (e.parent !== undefined) {
					this.lastStructById.set(e.id, structKey(e));
					if (e.kind === "move" || e.kind === "fold") this.lastStructAt.set(e.id, Date.parse(e.t) || 0);
				}
			} catch { /* a torn line: skip */ }
		}
	}

	/** Write everything pending. Safe to call any time; overlapping calls
	 *  share one run. `force` also writes structure changes that have not
	 *  settled yet (quit, unload, a phone going to the background). */
	flush(force = false): Promise<void> {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		if (this.flushing) return this.flushing.then(() => (this.pending.size || (force && this.structPending.size)) ? this.flush(force) : undefined);
		this.flushing = this.flushNow(force).finally(() => {
			this.flushing = null;
			// Structure changes still settling need a later pass even if no
			// further event arrives.
			if (this.structPending.size) this.schedule();
		});
		return this.flushing;
	}

	/** Parent and the sibling just above each item in a document folder, from
	 *  the metadata cache — one pass per folder per flush. */
	private siblingsOf(folderPath: string, memo: Map<string, Map<string, { parent: string | null; prev: string | null }>>): Map<string, { parent: string | null; prev: string | null }> {
		const hit = memo.get(folderPath);
		if (hit) return hit;
		const byParent = new Map<string, Array<{ id: string; order: number }>>();
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (folder instanceof TFolder) {
			for (const c of folder.children) {
				if (!(c instanceof TFile) || c.extension !== "md") continue;
				const fm = this.app.metadataCache.getFileCache(c)?.frontmatter;
				if (!fm || fm.id === undefined || fm.id === null) continue;
				const key = parentOf(fm) ?? "";
				const list = byParent.get(key) ?? [];
				list.push({ id: String(fm.id), order: typeof fm.order === "number" ? fm.order : 0 });
				byParent.set(key, list);
			}
		}
		const out = new Map<string, { parent: string | null; prev: string | null }>();
		for (const [parent, list] of byParent) {
			list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
			list.forEach((x, i) => out.set(x.id, { parent: parent || null, prev: i ? list[i - 1].id : null }));
		}
		memo.set(folderPath, out);
		return out;
	}

	private async flushNow(force: boolean): Promise<void> {
		if (!this.enabled()) { this.pending.clear(); this.structPending.clear(); return; }
		if (!this.pending.size && !this.structPending.size) return;
		const batch = [...this.pending];
		this.pending.clear();
		try {
			await this.seedToday();
			const now = new Date().toISOString();
			const nowMs = Date.now();
			const lines: string[] = [];
			const memo = new Map<string, Map<string, { parent: string | null; prev: string | null }>>();
			let creates = 0;
			for (const [path, kind] of batch) {
				let entry: HistoryEntry | null = null;
				if (kind === "delete") {
					let last = this.lastByPath.get(path);
					this.lastByPath.delete(path);
					const movedTo = this.movedOut.get(path);
					this.movedOut.delete(path);
					if ((!last || (!last.text && !last.note)) && movedTo && this.app.vault.getFileByPath(movedTo)) {
						const item = readItemFile(await this.app.vault.adapter.read(movedTo));
						if (item) {
							last = {
								t: now, kind: "delete", id: item.id, path, doc: path.slice(0, path.lastIndexOf("/")),
								text: item.text, note: item.note, ...(item.fm.checked === true ? { checked: true } : {}),
							};
						}
					}
					if (!last) continue;
					entry = { ...last, t: now, kind: "delete", path };
				} else {
					if (kind === "create" && ++creates > CREATE_CAP) continue;
					const file = this.app.vault.getFileByPath(path);
					if (!file) continue;
					const item = readItemFile(await this.app.vault.adapter.read(path));
					if (!item) continue;
					const doc = path.slice(0, path.lastIndexOf("/"));
					const place = this.siblingsOf(doc, memo).get(item.id);
					entry = {
						t: now, kind, id: item.id, path, doc,
						text: item.text, note: item.note,
						parent: place ? place.parent : parentOf(item.fm),
						prev: place ? place.prev : undefined,
					};
					if (typeof item.fm.order === "number") entry.order = item.fm.order;
					if (item.fm.checked === true) entry.checked = true;
					if (item.fm.collapsed === true) entry.collapsed = true;
					this.lastByPath.set(path, entry);
					const key = contentKey(entry);
					const sKey = structKey(entry);
					if (kind === "edit" && this.lastById.get(item.id) === key) {
						// Same text: at most a structure change, which waits to settle.
						const lastS = this.lastStructById.get(item.id);
						if (lastS === sKey) { this.structPending.delete(item.id); continue; }
						const moved = lastS === undefined || lastS.split("\u0000").slice(0, 2).join("\u0000") !== sKey.split("\u0000").slice(0, 2).join("\u0000");
						this.structPending.set(item.id, { entry: { ...entry, kind: moved ? "move" : "fold" }, changedAt: nowMs });
						continue;
					}
					this.lastById.set(item.id, key);
					// A text version carries its place too, so nothing waits.
					this.lastStructById.set(item.id, sKey);
					this.structPending.delete(item.id);
				}
				lines.push(JSON.stringify(entry));
			}
			// Structure changes that have settled (or all of them, when forced).
			for (const [id, p] of this.structPending) {
				const settled = nowMs - p.changedAt >= STRUCT_SETTLE_MS;
				const spaced = nowMs - (this.lastStructAt.get(id) ?? 0) >= STRUCT_GAP_MS;
				if (!force && !(settled && spaced)) continue;
				this.structPending.delete(id);
				const sKey = structKey(p.entry);
				if (this.lastStructById.get(id) === sKey) continue;   // moved back
				this.lastStructById.set(id, sKey);
				this.lastStructAt.set(id, nowMs);
				lines.push(JSON.stringify({ ...p.entry, t: now }));
			}
			if (!lines.length) return;
			const dir = this.dir();
			await this.ensureDir(dir);
			const file = `${dir}/${dayStamp()}.jsonl`;
			const adapter = this.app.vault.adapter;
			const data = `${lines.join("\n")}\n`;
			if (await adapter.exists(file)) await adapter.append(file, data);
			else await adapter.write(file, data);
		} catch (e) {
			console.error("Trynalist: item history write failed", e);
		}
	}

	private async ensureDir(dir: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		let path = "";
		for (const seg of dir.split("/")) {
			path = path ? `${path}/${seg}` : seg;
			if (!(await adapter.exists(path))) await adapter.mkdir(path);
		}
	}

	/** Every logged version of one item, newest first. Reads the log files
	 *  newest first and parses only lines that mention the id. */
	async versionsOf(id: string): Promise<ItemVersion[]> {
		await this.flush();
		const out: ItemVersion[] = [];
		const needle = `"id":${JSON.stringify(id)}`;
		for (const path of await this.logFiles()) {
			const lines = (await this.app.vault.adapter.read(path)).split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i];
				if (!line.includes(needle)) continue;
				try {
					const e = JSON.parse(line) as HistoryEntry;
					if (e.id !== id) continue;
					out.push({
						when: e.t, source: "log", kind: e.kind, text: e.text, note: e.note, checked: e.checked, path: e.path, doc: e.doc,
						parent: e.parent, prev: e.prev, order: e.order, collapsed: e.collapsed,
					});
				} catch { /* skip */ }
			}
		}
		return out;
	}

	/** Items deleted in the last RETAIN_DAYS whose id no longer exists
	 *  anywhere under the root, newest first, one per id. */
	async recentlyDeleted(existingIds: Set<string>): Promise<HistoryEntry[]> {
		await this.flush();
		const seen = new Set<string>();
		const out: HistoryEntry[] = [];
		// A delete noted before this session saw the item carries no text; the
		// item's last logged version (older, so met later in this scan) fills it.
		const blank = new Map<string, HistoryEntry>();
		for (const path of await this.logFiles()) {
			const lines = (await this.app.vault.adapter.read(path)).split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				if (!lines[i]) continue;
				try {
					const e = JSON.parse(lines[i]) as HistoryEntry;
					if (e.kind !== "delete") {
						const b = blank.get(e.id);
						if (b) { b.text = e.text; b.note = e.note; b.checked = e.checked; blank.delete(e.id); }
						continue;
					}
					if (seen.has(e.id) || existingIds.has(e.id)) continue;
					seen.add(e.id);
					out.push(e);
					if (!e.text && !e.note) blank.set(e.id, e);
				} catch { /* skip */ }
			}
		}
		// Still blank: the item was deleted before this device ever logged it.
		// The caller can fill these from the daily snapshots.
		return out;
	}

	/** Log files, newest first. */
	private async logFiles(): Promise<string[]> {
		const dir = this.dir();
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) return [];
		return (await adapter.list(dir)).files
			.filter((f) => /\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
			.sort()
			.reverse();
	}

	/** Versions of one item found in daily outline snapshots (newest first),
	 *  reading at most `limit` zips. Only entries whose name contains the id
	 *  are inflated. */
	async snapshotVersionsOf(id: string, zips: Array<{ path: string; when: string }>, limit: number): Promise<ItemVersion[]> {
		const out: ItemVersion[] = [];
		for (const zip of zips.slice(0, limit)) {
			try {
				const data = new Uint8Array(await this.app.vault.adapter.readBinary(zip.path));
				const files = unzipSyncTyped(data, { filter: (f) => f.name.endsWith(".md") && f.name.includes(id) });
				for (const [name, bytes] of Object.entries(files)) {
					const item = readItemFile(strFromU8Typed(bytes));
					if (!item || item.id !== id) continue;
					out.push({
						when: snapshotIso(zip.when), source: "snapshot", kind: "snapshot", text: item.text, note: item.note,
						checked: item.fm.checked === true ? true : undefined,
						path: name, doc: name.slice(0, name.lastIndexOf("/")),
						// A snapshot holds only this file: its parent and order
						// are known, the sibling above it is not.
						parent: parentOf(item.fm),
						order: typeof item.fm.order === "number" ? item.fm.order : undefined,
						collapsed: item.fm.collapsed === true ? true : undefined,
					});
				}
			} catch (e) {
				console.error("Trynalist: could not read a snapshot for item history", e);
			}
		}
		return out;
	}

	/** Fill blank delete entries from the newest daily snapshots that hold
	 *  them: one pass per zip, inflating only the matching entries. */
	async fillFromSnapshots(entries: HistoryEntry[], zips: Array<{ path: string }>, limit: number): Promise<void> {
		const want = new Map<string, HistoryEntry>();
		for (const e of entries) if (!e.text && !e.note) want.set(e.id, e);
		for (const zip of zips.slice(0, limit)) {
			if (!want.size) return;
			try {
				const data = new Uint8Array(await this.app.vault.adapter.readBinary(zip.path));
				const ids = [...want.keys()];
				const files = unzipSyncTyped(data, { filter: (f) => f.name.endsWith(".md") && ids.some((id) => f.name.includes(id)) });
				for (const bytes of Object.values(files)) {
					const item = readItemFile(strFromU8Typed(bytes));
					const e = item ? want.get(item.id) : undefined;
					if (!item || !e || (!item.text && !item.note)) continue;
					e.text = item.text;
					e.note = item.note;
					want.delete(item.id);
				}
			} catch (err) {
				console.error("Trynalist: could not read a snapshot for recently deleted items", err);
			}
		}
	}

	/** Remove log files older than RETAIN_DAYS (by the date in the name). */
	async prune(now = new Date()): Promise<number> {
		const cut = dayStamp(new Date(now.getTime() - RETAIN_DAYS * 86_400_000));
		let removed = 0;
		for (const f of await this.logFiles()) {
			if (f.slice(f.lastIndexOf("/") + 1, -".jsonl".length) >= cut) continue;
			try { await this.app.vault.adapter.remove(f); removed++; } catch (e) { console.error("Trynalist: could not prune item history", e); }
		}
		return removed;
	}

	/** Start listening (call from workspace.onLayoutReady). */
	markReady(): void {
		this.ready = true;
	}

	dispose(): void {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
	}
}

/** "YYYY-MM-DD HHmmss" (local time, from a snapshot's file name) → ISO, so
 *  snapshot and log versions sort together. */
function snapshotIso(stamp: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})(\d{2})(\d{2})/.exec(stamp);
	if (!m) return stamp;
	return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
}

/** Collapse consecutive identical versions (a snapshot equal to a logged
 *  version, repeated snapshots of an unchanged item). Input newest first. */
export function dedupeVersions(versions: ItemVersion[]): ItemVersion[] {
	const out: ItemVersion[] = [];
	for (const v of versions) {
		const prev = out[out.length - 1];
		if (prev && contentKey(prev) === contentKey(v) && structKey(prev) === structKey(v)
			&& v.kind !== "delete" && prev.kind !== "delete") continue;
		out.push(v);
	}
	return out;
}
