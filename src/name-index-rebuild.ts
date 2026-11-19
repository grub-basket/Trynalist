import { App, TFile, TFolder, normalizePath } from "obsidian";
import { FOLDER_NAME_MAX, MAX_VAULT_PATH, fileNameTemplateUses, fitToPath, itemFileName, refreshFileNameFormat, safeName } from "./id-service";
import { NAME_INDEX_FILE, flushNameIndex, formatNameIndex, isNameIndexText, nameIndexPath, parseNameIndex, runNameIndexExclusive } from "./name-index";
import { idToString, readItemFile } from "./store";
import { DOC_EXTENSION } from "./types";

export interface RebuildResult { rows: number; added: number; removed: number }

/** Rebuild the shortened-names index from the vault: rows whose file or
 *  folder is gone are dropped, and every shortened name that can be worked
 *  out again is added — document folders (from the title in their manifest)
 *  and item files (from the item's text, when it still gives the name the
 *  file was shortened from). Rows already in the index are kept otherwise:
 *  plain folders, attachments and items edited since keep their full names
 *  only there. */
export async function rebuildNameIndex(app: App, rootFolder: string): Promise<RebuildResult> {
	// Anything still queued lands first, so it isn't overwritten; writes queued
	// while this runs wait for it.
	await flushNameIndex();
	return runNameIndexExclusive(() => rebuild(app, rootFolder));
}

async function rebuild(app: App, rootFolder: string): Promise<RebuildResult> {
	const root = normalizePath(rootFolder || "/").replace(/^\/+|\/+$/g, "");
	const path = nameIndexPath(root);
	const existing = app.vault.getAbstractFileByPath(path);
	const raw = existing instanceof TFile ? await app.vault.read(existing) : "";
	// An empty file holds nothing to lose; the rebuild was asked for.
	if (raw.trim() && !isNameIndexText(raw)) {
		throw new Error(`"${path}" is a note of yours, not the shortened-names index. Rename it, then rebuild.`);
	}
	const before = parseNameIndex(raw);
	const rows = new Map<string, string>();
	let removed = 0;
	for (const [p, full] of before) {
		if (app.vault.getAbstractFileByPath(p)) rows.set(p, full);
		else removed++;
	}
	const kept = rows.size;

	await refreshFileNameFormat();
	const usesParent = fileNameTemplateUses("parent");
	const prefix = root ? `${root}/` : "";
	const manifests = app.vault.getFiles().filter((f) => f.extension === DOC_EXTENSION && f.path.startsWith(prefix));
	for (const manifest of manifests) {
		const folder = manifest.parent;
		if (!folder) continue;
		let title = "";
		try {
			const parsed: unknown = JSON.parse(await app.vault.cachedRead(manifest));
			const t = parsed && typeof parsed === "object" ? (parsed as { title?: unknown }).title : undefined;
			if (typeof t === "string") title = t;
		} catch { /* unreadable manifest: nothing to say about its folder */ }
		if (title) {
			const full = safeName(title, "Untitled");
			const short = safeName(title, "Untitled", FOLDER_NAME_MAX);
			// The folder is the capped name, or that name numbered (`… 2`).
			if (short !== full && !rows.has(folder.path)
				&& (folder.name === short || new RegExp(`^${escapeRe(short)} \\d+$`).test(folder.name))) {
				rows.set(folder.path, full);
			}
		}
		await addShortenedItems(app, folder, title, usesParent, rows);
	}
	if (rows.size || existing instanceof TFile) {
		const text = formatNameIndex(rows);
		// Re-checked inside the write: never replace a note that isn't ours.
		if (existing instanceof TFile) await app.vault.process(existing, (now) => (!now.trim() || isNameIndexText(now) ? text : now));
		else {
			if (root && !app.vault.getFolderByPath(root)) await app.vault.createFolder(root);
			await app.vault.create(path, text);
		}
	}
	return { rows: rows.size, added: rows.size - kept, removed };
}

/** Item files in `folder` whose name is the shortened form of the name their
 *  text gives today. Only files whose path is near the budget are read: a
 *  name fitToPath never touched can't be one. */
async function addShortenedItems(app: App, folder: TFolder, docTitle: string, usesParent: boolean, rows: Map<string, string>): Promise<void> {
	const room = Math.max(20, MAX_VAULT_PATH - folder.path.length - 1 - 3 - 3);
	const files = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md" && c.name !== NAME_INDEX_FILE);
	let parentText: Map<string, string> | null = null;
	for (const file of files) {
		if (rows.has(file.path)) continue;
		// The name as fitted, before any collision suffix (`… 2`).
		const bases = [file.basename];
		const numbered = / \d+$/.exec(file.basename);
		if (numbered) bases.push(file.basename.slice(0, numbered.index));
		// A cut name is within a few characters of the room (trailing dashes
		// and spaces are trimmed); the 20-character floor is its own case.
		if (!bases.some((b) => b.length <= room && b.length >= room - 12)) continue;
		const item = readItemFile(await app.vault.cachedRead(file));
		if (!item) continue;
		if (usesParent && !parentText) parentText = await parentTexts(app, folder);
		const parentId = typeof item.fm.parent === "string" || typeof item.fm.parent === "number" ? idToString(item.fm.parent) : "";
		const created = typeof item.fm.created === "string" ? item.fm.created : undefined;
		const full = itemFileName({ text: item.text, id: item.id, parentText: parentText?.get(parentId) ?? "", docTitle, created });
		const fitted = fitToPath(folder.path, full);
		if (fitted !== full && bases.includes(fitted)) rows.set(file.path, `${full}.md`);
	}
}

async function parentTexts(app: App, folder: TFolder): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const c of folder.children) {
		if (!(c instanceof TFile) || c.extension !== "md") continue;
		const item = readItemFile(await app.vault.cachedRead(c));
		if (item) out.set(item.id, item.text);
	}
	return out;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
