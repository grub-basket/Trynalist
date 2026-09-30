import { App, normalizePath } from "obsidian";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

/** Whole-collection backup / restore.
 *
 *  A Trynalist document already IS its lossless representation on disk — a
 *  folder with a `.trynalist` manifest and one Markdown file per item, each
 *  carrying every field in frontmatter (dlId, timestamps, colour, checkbox…).
 *  So the highest-fidelity backup is simply a faithful archive of the whole
 *  tree: no conversion, nothing to drop. Restoring re-lays those exact files
 *  down, so a round trip is byte-identical.
 *
 *  Everything under the root is archived as BINARY, so attachments embedded in
 *  document folders survive alongside the outline. */

const MANIFEST_NAME = "trynalist-backup.json";

interface BackupManifest {
	format: "trynalist-backup";
	version: 1;
	created: string;
	rootFolder: string;
	fileCount: number;
	docCount: number;
}

function stamp(): string {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

export interface BackupResult {
	path: string;
	fileCount: number;
	docCount: number;
}

/** Build the backup archive for everything under the root folder, in memory.
 *  `outlineOnly` keeps just the Markdown items and `.trynalist` manifests —
 *  what the automatic daily snapshot uses, so it stays small; attachments
 *  are included otherwise. Shared by the manual backup and the safety net so
 *  both produce archives restoreCollection accepts. */
export async function buildCollectionZip(
	app: App, rootFolder: string, opts: { outlineOnly?: boolean } = {},
): Promise<{ bytes: Uint8Array; fileCount: number; docCount: number }> {
	const root = normalizePath(rootFolder);
	const prefix = `${root}/`;
	// Archive from the raw adapter, not just Markdown files, so `.trynalist`
	// manifests and any attachments in document folders are all included.
	const all = app.vault.getFiles().filter((f) => f.path.startsWith(prefix)
		&& (!opts.outlineOnly || f.extension === "md" || f.extension === "trynalist"));
	const entries: Record<string, Uint8Array> = {};
	let docCount = 0;
	for (const f of all) {
		const rel = f.path.slice(prefix.length);
		const buf = await app.vault.readBinary(f);
		entries[rel] = new Uint8Array(buf);
		if (f.extension === "trynalist") docCount++;
	}
	const manifest: BackupManifest = {
		format: "trynalist-backup", version: 1, created: new Date().toISOString(),
		rootFolder: root, fileCount: all.length, docCount,
	};
	entries[MANIFEST_NAME] = strToU8(JSON.stringify(manifest, null, 2));
	// Level 3: most of the size saving at a fraction of level 6's time — the
	// whole zip is built synchronously on the main thread (L63).
	return { bytes: zipSync(entries, { level: 3 }), fileCount: all.length, docCount };
}

/** Archive every file under the root folder into one zip written into the vault.
 *  Returns the vault-relative path and counts. */
export async function exportCollection(app: App, rootFolder: string): Promise<BackupResult> {
	const root = normalizePath(rootFolder);
	const { bytes: zipped, fileCount, docCount } = await buildCollectionZip(app, root);
	// Write beside the root folder, not inside it, so a backup is never swept
	// into the next backup.
	const parent = root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : "";
	let path = normalizePath(`${parent ? parent + "/" : ""}Trynalist backup ${stamp()}.zip`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = normalizePath(`${parent ? parent + "/" : ""}Trynalist backup ${stamp()} (${n++}).zip`);
	}
	const view = new Uint8Array(zipped);
	const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
	await app.vault.createBinary(path, ab);
	return { path, fileCount, docCount };
}

export interface RestoreResult {
	folder: string;
	fileCount: number;
	docCount: number;
}

/** Restore a backup zip into a fresh dated folder under the root, so a restore
 *  never clobbers what is already there — the same isolation an import run gets.
 *  Returns where it landed. */
/** Refuse archives that would not fit comfortably in memory once unpacked:
 *  unzipSync inflates everything at once (L62). */
const RESTORE_MAX_BYTES = 1024 * 1024 * 1024;

export async function restoreCollection(app: App, rootFolder: string, zipData: ArrayBuffer): Promise<RestoreResult> {
	// Size first, from the archive's own directory — the filter sees each
	// entry's uncompressed size and declines it, so nothing is inflated.
	let unpacked = 0;
	unzipSync(new Uint8Array(zipData), { filter: (f) => { unpacked += f.originalSize; return false; } });
	if (unpacked > RESTORE_MAX_BYTES) {
		throw new Error(`This archive unpacks to ${Math.round(unpacked / 1048576)} MB, more than a Trynalist backup should be; it was not restored.`);
	}
	const files = unzipSync(new Uint8Array(zipData));
	const manifestRaw = files[MANIFEST_NAME];
	if (!manifestRaw) throw new Error("Not a Trynalist backup — the archive has no trynalist-backup.json.");
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(strFromU8(manifestRaw)) as BackupManifest;
	} catch {
		throw new Error("The backup manifest is corrupt.");
	}
	if (manifest.format !== "trynalist-backup") throw new Error("Unrecognised backup format.");
	// Validate every entry BEFORE touching the vault, so a refused archive
	// leaves nothing behind — not even the empty dated folder.
	// Two entries that differ only in case are one file on macOS and Windows (L61).
	const seen = new Set<string>();
	for (const rel of Object.keys(files)) {
		if (rel === MANIFEST_NAME || rel.endsWith("/")) continue;
		if (!isSafeArchivePath(rel)) throw new Error(`The backup contains an unsafe path ("${rel}") and was not restored.`);
		const lower = rel.toLowerCase();
		if (seen.has(lower)) throw new Error(`The backup contains two files that differ only in case ("${rel}") and was not restored.`);
		seen.add(lower);
	}

	const root = normalizePath(rootFolder);
	if (!app.vault.getFolderByPath(root)) await app.vault.createFolder(root);
	let dest = normalizePath(`${root}/Restored backup ${stamp()}`);
	let n = 2;
	while (app.vault.getAbstractFileByPath(dest)) dest = normalizePath(`${root}/Restored backup ${stamp()} (${n++})`);
	await app.vault.createFolder(dest);

	let fileCount = 0;
	let docCount = 0;
	try {
		for (const [rel, bytes] of Object.entries(files)) {
			if (rel === MANIFEST_NAME) continue;
			if (rel.endsWith("/")) continue;                 // directory entry
			// An import's bookkeeping is not content: restored, a plan file made the
			// next launch offer to "resume" an import that never ran here (L27).
			if (/(^|\/)_import-[^/]*\.json$/.test(rel)) continue;
			// Zip-slip guard. normalizePath collapses slashes but does not resolve
			// `..`, so an entry named `../../x.md` in a hostile archive would land
			// outside the restore folder (and createFolder would build the path to
			// it). Only plain relative paths with ordinary segments are restored.
			if (!isSafeArchivePath(rel)) throw new Error(`The backup contains an unsafe path ("${rel}") and was not restored.`);
			const target = normalizePath(`${dest}/${rel}`);
			const dir = target.slice(0, target.lastIndexOf("/"));
			if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
			const view = new Uint8Array(bytes);
			const ab = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
			await app.vault.createBinary(target, ab);
			fileCount++;
			if (rel.endsWith(".trynalist")) docCount++;
		}
	} catch (e) {
		// A half-restored folder looked like a finished one. Say what it is.
		const partial = app.vault.getFolderByPath(dest);
		if (partial) {
			try { await app.fileManager.renameFile(partial, `${dest} (incomplete)`); } catch { /* the error below is what matters */ }
		}
		throw e;
	}
	return { folder: dest, fileCount, docCount };
}

/** A relative archive path made only of ordinary segments: no absolute root,
 *  no drive letter, no backslashes, no `.`/`..`, no empty segment. */
export function isSafeArchivePath(rel: string): boolean {
	if (!rel || rel.startsWith("/") || rel.includes("\\") || /^[A-Za-z]:/.test(rel)) return false;
	// Control characters (written as escapes, not raw bytes), and the
	// characters Obsidian's own path check refuses on some platform — a
	// restore made on one OS used to die half-way on another (L61).
	if (/[\u0000-\u001f*"<>:|?]/.test(rel)) return false;
	return rel.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
