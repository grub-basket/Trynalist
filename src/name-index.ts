import { App, TFile, normalizePath } from "obsidian";

/** The shortened-names index: one Markdown file at the top of the Trynalist
 *  folder that pairs every name Trynalist shortened (to keep paths within
 *  Windows' limit, see fitToPath and FOLDER_NAME_MAX) with the full name it
 *  would otherwise have had. Nothing is lost without it — a document's title
 *  is in its manifest, an item's text in its file — but outside Obsidian
 *  (File Explorer, OneDrive, a zip) only the short names show, and this file
 *  is how a person matches them up.
 *
 *  Rows are written as names are shortened, follow renames, moves and
 *  copies, and go when their file or folder is deleted. Every change is
 *  queued and applied to what the file holds at write time, so edits from
 *  another device that synced in meanwhile are kept. */

export const NAME_INDEX_FILE = "_Shortened names.md";

type Op = { ix: string } & OpBody;
type OpBody =
	| { kind: "set"; path: string; full: string; tries: number }
	/** The path and everything under it went (a delete). */
	| { kind: "remove"; path: string }
	/** This one path is no longer shortened; rows inside it stay. */
	| { kind: "unset"; path: string }
	| { kind: "move"; from: string; to: string }
	/** Rows under `from` are duplicated under `to` (a copied folder). */
	| { kind: "copy"; from: string; to: string };

let rootOf: (() => string) | null = null;
let appRef: App | null = null;
let queue: Op[] = [];
let timer: number | null = null;
let writing: Promise<void> = Promise.resolve();
const FLUSH_MS = 2000;
/** A row is recorded when its name is chosen, which can be just before the
 *  file or folder is created. Rows whose path doesn't exist yet are tried
 *  again on the next few writes before they are dropped. */
const MAX_TRIES = 5;

/** What each index file held when last read or written, keyed by its path:
 *  its rows and every folder above them. A queued move or delete that names
 *  none of them is dropped without reading the file — the first save of every
 *  new item is a rename, and deleting a big folder is one event per file. */
interface Known { mtime: number; rows: Set<string>; dirs: Set<string> }
const known = new Map<string, Known>();
/** Index paths already reported as being someone else's note. */
const foreignWarned = new Set<string>();

/** Wired by the plugin on load. */
export function setNameIndexHost(app: App, root: () => string): void {
	appRef = app;
	rootOf = root;
}

/** How long recording stays open after unload starts. Obsidian closes the
 *  document tabs before the plugin's onunload runs and doesn't wait for
 *  their last saves, which can still name (and shorten) a file. */
const CLOSE_GRACE_MS = 3000;

/** Unload: write what's queued now, keep recording for a short grace so
 *  the closing tabs' last saves are indexed, then write again and stop.
 *  Bounded by time, not by those saves, so a save that never settles
 *  can't keep a disabled plugin writing. */
export function closeNameIndex(): void {
	void flushNameIndex();
	window.setTimeout(() => {
		void flushNameIndex().finally(() => {
			appRef = null;
			rootOf = null;
			if (timer !== null) { window.clearTimeout(timer); timer = null; }
			queue = [];
		});
	}, CLOSE_GRACE_MS);
}

/** The index file's vault path for the current Trynalist folder. */
export function nameIndexPath(root = rootOf?.() ?? ""): string {
	const clean = normalizePath(root || "/").replace(/^\/+|\/+$/g, "");
	return clean ? `${clean}/${NAME_INDEX_FILE}` : NAME_INDEX_FILE;
}

/** Whether `raw` is an index file this module wrote. Anything else at that
 *  path — an empty file included, which is what a note the user just made
 *  looks like — is a user's note, and is left alone. */
export function isNameIndexText(raw: string): boolean {
	return raw.replace(/\r\n?/g, "\n").includes(`\n${TABLE_HEAD}\n`);
}

/** Record that `path` got a shortened name; `full` is the name it would have
 *  had. Null (or a full name equal to the one on disk) removes the row for
 *  `path` alone — a document renamed to a short title is no longer
 *  shortened, but the items inside it still are. */
export function noteShortened(path: string, full: string | null): void {
	if (!appRef) return;
	const p = normalizePath(path);
	const onDisk = p.slice(p.lastIndexOf("/") + 1);
	if (full === null || full === onDisk) push({ kind: "unset", path: p });
	else push({ kind: "set", path: p, full, tries: 0 });
}

/** Vault events: keep rows on the paths they describe. */
export function noteRenamed(from: string, to: string): void {
	if (from === to || isIndexFile(from) || isIndexFile(to)) return;
	push({ kind: "move", from, to });
}
export function noteDeleted(path: string): void {
	if (isIndexFile(path)) return;
	push({ kind: "remove", path });
}
/** A folder was copied: rows inside it apply to the copies too. */
export function noteCopied(from: string, to: string): void {
	push({ kind: "copy", from: normalizePath(from), to: normalizePath(to) });
}

/** Queued with the index it belongs to NOW, so changing the Trynalist folder
 *  mid-import doesn't send the old folder's rows to the new one's index. */
function push(op: OpBody): void {
	if (!appRef) return;
	queue.push({ ...op, ix: nameIndexPath() });
	if (timer === null) timer = window.setTimeout(() => { timer = null; void flushNameIndex(); }, FLUSH_MS);
}

function isIndexFile(path: string): boolean {
	return path === nameIndexPath() || path.endsWith(`/${NAME_INDEX_FILE}`) || path === NAME_INDEX_FILE;
}

/** Write queued changes now (also on quit, unload and when a phone hides the
 *  app). Serialised: one write at a time. */
export function flushNameIndex(): Promise<void> {
	if (timer !== null) { window.clearTimeout(timer); timer = null; }
	const app = appRef;
	writing = writing.then(() => (app ? writeQueued(app) : undefined))
		.catch((e) => console.error("Trynalist: shortened-names index not written", e));
	return writing;
}

/** Run `fn` with no index write in flight, and none starting until it ends. */
export function runNameIndexExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = writing.then(fn);
	writing = run.then(() => undefined, () => undefined);
	return run;
}

async function writeQueued(app: App): Promise<void> {
	if (!queue.length) return;
	const ops = queue;
	queue = [];
	const byIndex = new Map<string, Op[]>();
	for (const op of ops) {
		const list = byIndex.get(op.ix);
		if (list) list.push(op);
		else byIndex.set(op.ix, [op]);
	}
	const retry: Op[] = [];
	// One index failing (deleted mid-write, a disk error) doesn't take the
	// others' changes with it.
	for (const [ix, group] of byIndex) {
		try {
			retry.push(...await writeOne(app, ix, group));
		} catch (e) {
			console.error(`Trynalist: shortened-names index "${ix}" not written`, e);
		}
	}
	if (retry.length && appRef) {
		queue = [...retry, ...queue];
		if (timer === null) timer = window.setTimeout(() => { timer = null; void flushNameIndex(); }, FLUSH_MS);
	}
}

async function writeOne(app: App, ix: string, ops: Op[]): Promise<Op[]> {
	const exists = (p: string): boolean => !!app.vault.getAbstractFileByPath(p);
	const existing = app.vault.getAbstractFileByPath(ix);
	if (!(existing instanceof TFile)) {
		// Only a recorded name is a reason to create the file; moves and
		// deletes of things the index doesn't hold must not.
		if (!ops.some((o) => o.kind === "set")) return [];
		const rows = new Map<string, string>();
		const retry = applyOps(rows, ops, exists);
		if (rows.size) {
			const folder = ix.includes("/") ? ix.slice(0, ix.lastIndexOf("/")) : "";
			if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder).catch(() => { /* raced */ });
			const file = await app.vault.create(ix, formatNameIndex(rows));
			remember(ix, file, rows);
		}
		return retry;
	}
	// Nothing queued touches a row we know of, and the file hasn't changed
	// since: no read, no write.
	const k = known.get(ix);
	if (k && k.mtime === existing.stat.mtime && !ops.some((o) => touches(o, k))) return [];
	const current = await app.vault.read(existing);
	if (!isNameIndexText(current)) {
		if (!foreignWarned.has(ix)) {
			foreignWarned.add(ix);
			console.warn(`Trynalist: "${ix}" is not the shortened-names index, so it is left alone and no index is kept there. Rename that note to keep one.`);
		}
		return [];
	}
	const rows = parseNameIndex(current);
	const retry = applyOps(rows, ops, exists);
	const next = formatNameIndex(rows);
	if (next !== current) {
		let finalRows = rows;
		await app.vault.process(existing, (raw) => {
			if (raw === current) return next;
			// Changed between the read and the write (a sync): apply again.
			if (!isNameIndexText(raw)) return raw;
			finalRows = parseNameIndex(raw);
			applyOps(finalRows, ops, exists);
			return formatNameIndex(finalRows);
		});
		remember(ix, existing, finalRows);
	} else {
		remember(ix, existing, rows);
	}
	return retry;
}

function remember(ix: string, file: TFile, rows: Map<string, string>): void {
	const dirs = new Set<string>();
	for (const p of rows.keys()) addDirs(dirs, p);
	known.set(ix, { mtime: file.stat.mtime, rows: new Set(rows.keys()), dirs });
}

function addDirs(dirs: Set<string>, path: string): void {
	for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
		const dir = path.slice(0, i);
		if (dirs.has(dir)) break;   // its parents are in already
		dirs.add(dir);
	}
}

function touches(op: Op, k: { rows: Set<string>; dirs: Set<string> }): boolean {
	switch (op.kind) {
		case "set": return true;
		case "unset": return k.rows.has(op.path);
		case "remove": return k.rows.has(op.path) || k.dirs.has(op.path);
		case "move": case "copy": return k.rows.has(op.from) || k.dirs.has(op.from);
	}
}

/** Apply `ops` in order to `rows`. A recorded row whose path doesn't exist
 *  yet is taken out and returned for a later try (or dropped after
 *  MAX_TRIES). Moves, deletes and copies that name no row and no folder
 *  above one cost a lookup, not a scan of every row. Exported for tests. */
export function applyOps(rows: Map<string, string>, ops: Op[], exists: (path: string) => boolean): Op[] {
	const fresh = new Map<string, number>();   // path -> tries, for rows set in this batch
	// Folders above some row. Only ever grows within a batch: a stale entry
	// costs one scan that finds nothing, never a wrong answer.
	const dirs = new Set<string>();
	for (const p of rows.keys()) addDirs(dirs, p);
	const under = (key: string, path: string): boolean => key === path || key.startsWith(`${path}/`);
	for (const op of ops) {
		if (op.kind === "set") {
			rows.set(op.path, op.full);
			fresh.set(op.path, op.tries);
			addDirs(dirs, op.path);
		} else if (op.kind === "unset") {
			rows.delete(op.path);
			fresh.delete(op.path);
		} else if (op.kind === "remove") {
			if (!dirs.has(op.path)) { rows.delete(op.path); fresh.delete(op.path); continue; }
			for (const key of [...rows.keys()]) if (under(key, op.path)) { rows.delete(key); fresh.delete(key); }
		} else {
			if (!rows.has(op.from) && !dirs.has(op.from)) continue;
			for (const [key, full] of [...rows]) {
				if (!under(key, op.from)) continue;
				const target = op.to + key.slice(op.from.length);
				if (op.kind === "move") {
					rows.delete(key);
					if (fresh.has(key)) { fresh.set(target, fresh.get(key) ?? 0); fresh.delete(key); }
				}
				rows.set(target, full);
				addDirs(dirs, target);
			}
		}
	}
	const retry: Op[] = [];
	for (const [p, tries] of fresh) {
		if (exists(p)) continue;
		const full = rows.get(p);
		rows.delete(p);
		const ix = ops.find((o) => o.kind === "set" && o.path === p)?.ix ?? ops[0]?.ix ?? "";
		if (full !== undefined && tries + 1 < MAX_TRIES) retry.push({ kind: "set", path: p, full, tries: tries + 1, ix });
	}
	return retry;
}

// ── File format ─────────────────────────────────────────────────────────────

const TABLE_HEAD = "| Shortened path | Full name |";

const HEADER = [
	"# Shortened names",
	"",
	"Windows limits a whole file path to 260 characters, so Trynalist shortens",
	"the names of files and folders that would go past it. Each row pairs a",
	"shortened name, by its full path in the vault, with the full name it would",
	"otherwise have had.",
	"",
	"- Item files keep their item id at the end, so the id says which item it is.",
	"- A document's folder and its `.trynalist` file share the short name. The",
	"  full title is also kept inside the `.trynalist` file.",
	"",
	"Trynalist keeps this file up to date: rows follow renames and moves, and go",
	"when the file or folder is deleted. To rebuild it, run the command",
	"\"Trynalist: Rebuild the shortened-names index\". Edits made here are",
	"overwritten.",
	"",
	TABLE_HEAD,
	"| --- | --- |",
];

/** A table cell holding `s` literally: a code span (so `_`, `*` and `[` in a
 *  name aren't read as formatting), fenced with one more backtick than the
 *  longest run inside, and with `|` escaped as tables require. */
function cell(s: string): string {
	const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
	const fence = "`".repeat(longest + 1);
	return `${fence} ${s.replace(/\|/g, "\\|")} ${fence}`;
}

function uncell(raw: string): string {
	const t = raw.trim();
	const m = /^(`+) ([\s\S]*) \1$/.exec(t);
	return (m ? m[2] : t).replace(/\\\|/g, "|");
}

export function formatNameIndex(rows: Map<string, string>): string {
	const lines = [...HEADER];
	for (const key of [...rows.keys()].sort((a, b) => a.localeCompare(b))) {
		lines.push(`| ${cell(key)} | ${cell(rows.get(key) ?? "")} |`);
	}
	return `${lines.join("\n")}\n`;
}

/** Rows from the file's table. Anything that isn't a two-cell row is skipped. */
export function parseNameIndex(raw: string): Map<string, string> {
	const rows = new Map<string, string>();
	for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
		if (!line.startsWith("| ") || !line.trimEnd().endsWith("|")) continue;
		const body = line.trimEnd().slice(2, -1);
		// Split on the one unescaped " | " between the two cells.
		const parts = body.split(/(?<!\\) \| /);
		if (parts.length !== 2) continue;
		const path = uncell(parts[0]);
		const full = uncell(parts[1]);
		if (!path || path === "Shortened path" || /^-+$/.test(path)) continue;
		rows.set(path, full);
	}
	return rows;
}
