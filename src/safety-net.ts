import { App, normalizePath } from "obsidian";
import { buildCollectionZip } from "./backup";

/** The sync safety net: automatic, local-only snapshots kept in a hidden
 *  folder at the vault root.
 *
 *  Why a dot folder: Obsidian does not index it (so it never shows in the file
 *  explorer, search or the graph) and Obsidian Sync does not sync it — each
 *  device keeps its own history, which is the point when the thing being
 *  guarded against is ANOTHER device overwriting this one's data. File-level
 *  sync tools (iCloud, Syncthing, Dropbox) do copy dot folders, so snapshots
 *  go in a per-device subfolder and two devices never write the same file.
 *
 *  Two kinds of snapshot:
 *  - settings: the plugin's data.json (templates, bookmarks, per-document
 *    settings…) whenever it changes, at most once per SETTINGS_EVERY_MS;
 *  - outline: once a day, the whole collection as a backup zip in the same
 *    format as "Back up now", so the existing restore path reads it.
 *
 *  Retention (agreed 2026-09-28): snapshots older than RETAIN_DAYS are
 *  removed, but the newest KEEP_MIN of each kind always stay, so a device
 *  that was off for months still has its last copies. Pruning only ever
 *  touches .json / .zip files directly inside this device's own settings/
 *  and outline/ folders. */

export const SAFETY_DIR = ".trynalist-backups";
const SETTINGS_EVERY_MS = 30 * 60_000;
const DEVICE_KEY = "trynalist-device-id";
const RETAIN_DAYS = 30;
const KEEP_MIN = 5;

/** Fields never written to a snapshot: reminder bookkeeping changes every
 *  minute and is not worth restoring, and anything token-shaped must not be
 *  copied into a folder file-sync tools may carry off the device. */
function snapshotPayload(data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) {
		if (k === "reminderState" || /token|secret|password/i.test(k)) continue;
		out[k] = v;
	}
	return out;
}

function stamp(d = new Date()): string {
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface SettingsSnapshot {
	path: string;
	/** "YYYY-MM-DD HHmmss" from the file name. */
	when: string;
	data: Record<string, unknown>;
}

export interface OutlineSnapshot {
	path: string;
	when: string;
	bytes: number;
}

export class SafetyNet {
	private lastSettingsJson: string | null = null;
	private lastSettingsAt = 0;
	private pending: Record<string, unknown> | null = null;
	private timer: number | null = null;

	constructor(private app: App) {}

	/** This device's folder. The id lives in Obsidian's per-vault local storage,
	 *  which is not synced, so every device gets its own. */
	deviceDir(): string {
		let id = this.app.loadLocalStorage(DEVICE_KEY) as string | null;
		if (!id) {
			id = Math.random().toString(36).slice(2, 8);
			this.app.saveLocalStorage(DEVICE_KEY, id);
		}
		return normalizePath(`${SAFETY_DIR}/device-${id}`);
	}

	private async ensureDir(dir: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		let path = "";
		for (const seg of dir.split("/")) {
			path = path ? `${path}/${seg}` : seg;
			if (!(await adapter.exists(path))) await adapter.mkdir(path);
		}
	}

	/** Call after every settings save. Writes at most once per interval; a
	 *  change inside the interval is written when it ends. Identical content
	 *  is never written twice. */
	noteSettingsSaved(data: Record<string, unknown>): void {
		this.pending = snapshotPayload(data);
		if (this.timer !== null) return;
		const wait = Math.max(0, this.lastSettingsAt + SETTINGS_EVERY_MS - Date.now());
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flushSettings();
		}, wait);
	}

	/** Write the pending settings snapshot now (also used at startup and on
	 *  unload). `force` writes even when nothing changed — used before a
	 *  restore, so the state being replaced is always recoverable. */
	async flushSettings(data?: Record<string, unknown>, force = false): Promise<string | null> {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
		const payload = data ? snapshotPayload(data) : this.pending;
		this.pending = null;
		if (!payload) return null;
		const json = JSON.stringify(payload, null, 2);
		if (!force && json === this.lastSettingsJson) return null;
		try {
			const dir = `${this.deviceDir()}/settings`;
			await this.ensureDir(dir);
			if (!force && this.lastSettingsJson === null) {
				// First write this session: compare against the newest file on
				// disk so a restart does not duplicate an unchanged snapshot.
				const latest = (await this.listSettings())[0];
				if (latest && JSON.stringify(latest.data, null, 2) === json) {
					this.lastSettingsJson = json;
					this.lastSettingsAt = Date.now();
					return null;
				}
			}
			let path = `${dir}/${stamp()}.json`;
			let n = 2;
			while (await this.app.vault.adapter.exists(path)) path = `${dir}/${stamp()} (${n++}).json`;
			await this.app.vault.adapter.write(path, json);
			this.lastSettingsJson = json;
			this.lastSettingsAt = Date.now();
			return path;
		} catch (e) {
			console.error("Trynalist: settings snapshot failed", e);
			return null;
		}
	}

	/** Settings snapshots on this device, newest first. Unreadable files are
	 *  skipped rather than failing the list. */
	async listSettings(): Promise<SettingsSnapshot[]> {
		const dir = `${this.deviceDir()}/settings`;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) return [];
		const out: SettingsSnapshot[] = [];
		for (const path of (await adapter.list(dir)).files) {
			if (!path.endsWith(".json")) continue;
			try {
				const data = JSON.parse(await adapter.read(path)) as Record<string, unknown>;
				if (!data || typeof data !== "object" || Array.isArray(data)) continue;
				out.push({ path, when: path.slice(dir.length + 1, -".json".length), data });
			} catch { /* skip */ }
		}
		return out.sort((a, b) => b.when.localeCompare(a.when));
	}

	/** Write today's outline snapshot if there is none yet. Returns its path,
	 *  or null when one already exists / nothing to archive. */
	async dailyOutline(rootFolder: string, includeAttachments: boolean): Promise<string | null> {
		const root = normalizePath(rootFolder);
		if (!this.app.vault.getFolderByPath(root)) return null;
		const dir = `${this.deviceDir()}/outline`;
		const today = stamp().slice(0, 10);
		const adapter = this.app.vault.adapter;
		try {
			await this.ensureDir(dir);
			if ((await adapter.list(dir)).files.some((p) => p.slice(dir.length + 1).startsWith(today))) return null;
			const { bytes, fileCount } = await buildCollectionZip(this.app, root, { outlineOnly: !includeAttachments });
			if (!fileCount) return null;
			const path = `${dir}/${stamp()}.zip`;
			// Copy into a fresh ArrayBuffer: no cast needed, and it works whether the
			// zip bytes came back on a plain or a shared buffer.
			const ab = new ArrayBuffer(bytes.byteLength);
			new Uint8Array(ab).set(bytes);
			await adapter.writeBinary(path, ab);
			return path;
		} catch (e) {
			console.error("Trynalist: daily outline snapshot failed", e);
			return null;
		}
	}

	/** Outline snapshots on this device, newest first. */
	async listOutlines(): Promise<OutlineSnapshot[]> {
		const dir = `${this.deviceDir()}/outline`;
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(dir))) return [];
		const out: OutlineSnapshot[] = [];
		for (const path of (await adapter.list(dir)).files) {
			if (!path.endsWith(".zip")) continue;
			const st = await adapter.stat(path);
			out.push({ path, when: path.slice(dir.length + 1, -".zip".length), bytes: st?.size ?? 0 });
		}
		return out.sort((a, b) => b.when.localeCompare(a.when));
	}

	async readOutline(path: string): Promise<ArrayBuffer> {
		return this.app.vault.adapter.readBinary(path);
	}

	/** Apply the retention rule to both kinds. Returns how many files went.
	 *  Age comes from the stamp in the file name (what the pickers show), not
	 *  from mtime, which a file-sync tool can rewrite. */
	async prune(now = new Date()): Promise<number> {
		const cutoff = new Date(now.getTime() - RETAIN_DAYS * 86_400_000);
		const p = (n: number): string => String(n).padStart(2, "0");
		const cut = `${cutoff.getFullYear()}-${p(cutoff.getMonth() + 1)}-${p(cutoff.getDate())}`;
		const adapter = this.app.vault.adapter;
		let removed = 0;
		for (const [sub, ext] of [["settings", ".json"], ["outline", ".zip"]] as const) {
			const dir = `${this.deviceDir()}/${sub}`;
			if (!(await adapter.exists(dir))) continue;
			const files = (await adapter.list(dir)).files
				.filter((f) => f.endsWith(ext) && /^\d{4}-\d{2}-\d{2} /.test(f.slice(dir.length + 1)))
				.sort()
				.reverse();   // newest first: the stamp sorts chronologically
			for (const f of files.slice(KEEP_MIN)) {
				if (f.slice(dir.length + 1, dir.length + 11) >= cut) continue;
				try { await adapter.remove(f); removed++; } catch (e) { console.error("Trynalist: could not prune a snapshot", e); }
			}
		}
		return removed;
	}

	/** Stop the pending timer; the caller flushes first if it wants the write. */
	dispose(): void {
		if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
	}
}
