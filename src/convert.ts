import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import { newId } from "./id-service";
import { colorIndexOf, parseFrontmatterBlock } from "./store";
import { DOC_EXTENSION } from "./types";
import type { DocManifest } from "./types";

/** Which plugin owns a folder, decided on artifacts each plugin OWNS rather
 *  than on generic frontmatter (see dev-docs/interop.md). */
export type FolderKind = "trynalist" | "stashpad" | "plain" | "empty";

const STASHPAD_ROOT_ID = "__root__";
const ATTACHMENTS_NAME = "_attachments";
/** Stashpad's sibling order. A DOTFILE — invisible to the vault index, so it
 *  must be read and written through the adapter, and copied into the backup by
 *  hand. Shape: { "<parentId|__root__>": ["<childId>", …] }. Ids present sort
 *  in array order; ids absent sort by `created`, after the listed ones. */
const ORDER_FILE = ".stashpad-order.json";
/** Stashpad's recovery sidecar (0.206.0) and its rotated previous copy — the
 *  map it uses to rebuild a note whose frontmatter was wiped. Same blind spot
 *  as the order file: invisible to `folder.children`, so it must be handled
 *  through the adapter. It describes the PRE-conversion tree, so it is backed
 *  up and then removed; a stale recovery map is the thing both sides agreed is
 *  worse than none, and Stashpad regenerates it. */
const STRUCTURE_FILES = [".stashpad-structure.json", ".stashpad-structure.prev.json"];
/** Per-parent sort mode. Meaningless once the folder is an outline (we sort on
 *  demand and persist nothing), and misleading if it survived a round trip, so
 *  it gets the same carry-or-delete treatment as the recovery snapshot. */
const SORT_FILE = ".stashpad-sort.json";
/** MIRRORS `STASHPAD_SIDECAR_FILES` in the other plugin's `src/types.ts`, which
 *  is the canonical list. All are dotfiles the vault index cannot see, so every
 *  one of them has to be handled through the adapter. If that list grows, this
 *  one must too — a missed entry shows up as silent weirdness, not an error. */
const SIDECAR_FILES = [ORDER_FILE, SORT_FILE, ...STRUCTURE_FILES];
/** Sidecars that describe state which cannot survive conversion. */
const STALE_AFTER_CONVERSION = [SORT_FILE, ...STRUCTURE_FILES];
type OrderMap = Record<string, string[]>;

/** Back up every sidecar dotfile; the vault API cannot see them, so
 *  `vault.copy` skipped them and the backup was quietly incomplete. */
async function backupSidecars(app: App, folderPath: string, base: string): Promise<string[]> {
	const copied: string[] = [];
	for (const name of SIDECAR_FILES) {
		try {
			const from = `${folderPath}/${name}`;
			if (!(await app.vault.adapter.exists(from))) continue;
			await app.vault.adapter.write(`${base}/${name}`, await app.vault.adapter.read(from));
			copied.push(name);
		} catch (e) {
			console.warn("Trynalist: could not back up", name, e);
		}
	}
	return copied;
}

/** Remove the sidecars that describe the folder as it was before. */
async function removeStaleStructure(app: App, folderPath: string, notes: string[], backupPath: string): Promise<void> {
	let removed = 0;
	for (const name of STALE_AFTER_CONVERSION) {
		try {
			const path = `${folderPath}/${name}`;
			if (!(await app.vault.adapter.exists(path))) continue;
			// Only what the backup actually holds: a failed copy used to be
			// followed by the removal anyway, losing Stashpad's recovery
			// snapshot for good (L58).
			if (!(await app.vault.adapter.exists(`${backupPath}/${name}`))) {
				notes.push(`Kept ${name}: it could not be backed up, so it was not removed.`);
				continue;
			}
			await app.vault.adapter.remove(path);
			removed++;
		} catch (e) {
			console.warn("Trynalist: could not remove", name, e);
		}
	}
	if (removed) {
		notes.push(`Removed ${removed} stale Stashpad sidecar file(s) — recovery snapshots and per-parent sort modes describing the folder as it was before. Stashpad rebuilds them. Copies are in the backup.`);
	}
}

/** Scalar frontmatter read straight from the file. The metadata cache lags
 *  behind recent writes, and trusting it here silently lost BOTH the imported
 *  order and the exported one — the same staleness that lost the attachment
 *  list. Anything conversion depends on is read from disk. */
async function readFrontmatterScalars(
	app: App,
	file: TFile,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	try {
		const raw = await app.vault.read(file);
		if (!raw.startsWith("---\n")) return out;
		const end = raw.indexOf("\n---", 4);
		if (end === -1) return out;
		for (const line of raw.slice(4, end).split("\n")) {
			const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
			if (!m) continue;
			out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
		}
	} catch (e) {
		console.warn("Trynalist: could not read frontmatter", file.path, e);
	}
	return out;
}

async function readOrderFile(app: App, folderPath: string): Promise<OrderMap> {
	const path = `${folderPath}/${ORDER_FILE}`;
	try {
		if (!(await app.vault.adapter.exists(path))) return {};
		const parsed = JSON.parse(await app.vault.adapter.read(path)) as OrderMap;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (e) {
		console.warn("Trynalist: could not read the Stashpad order file", e);
		return {};
	}
}

async function writeOrderFile(app: App, folderPath: string, order: OrderMap): Promise<void> {
	await app.vault.adapter.write(`${folderPath}/${ORDER_FILE}`, JSON.stringify(order, null, 2));
}
/** Our six labels, as hex, for the colour round trip. */
const COLOR_HEX = ["", "#ff6a6a", "#ffa84c", "#ffdc5a", "#70c878", "#60aaff", "#be82ff"];

export function detectFolderKind(app: App, folder: TFolder): FolderKind {
	const files = folder.children.filter((c): c is TFile => c instanceof TFile);
	if (files.some((f) => f.extension === DOC_EXTENSION)) return "trynalist";
	const mds = files.filter((f) => f.extension === "md");
	if (!mds.length) return "empty";
	for (const f of mds) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) continue;
		// Stashpad's own signatures: the home note, or a note with Stashpad's
		// node shape — its id, parent AND attachments keys together. An
		// `attachments:` key alone is common in ordinary notes, and treating
		// such a folder as Stashpad rewrote or dropped properties on every note
		// in it (L56).
		if (fm.id === STASHPAD_ROOT_ID) return "stashpad";
		if ("attachments" in fm && typeof fm.id === "string" && "parent" in fm) return "stashpad";
	}
	return "plain";
}

export interface ConversionReport {
	items: number;
	backupPath: string;
	notes: string[];
}

/** Anything inside the folder that conversion does NOT touch. Reported rather
 *  than quietly skipped: a folder that loses sight of its own contents looks
 *  exactly like data loss, even when every file is still on disk. */
function auditSubfolders(folder: TFolder, notes: string[]): void {
	const subs = folder.children.filter((c): c is TFolder => c instanceof TFolder);
	if (!subs.length) return;
	for (const sub of subs) {
		let md = 0;
		let other = 0;
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (c instanceof TFolder) walk(c);
				else if (c instanceof TFile) (c.extension === "md" ? md++ : other++);
			}
		};
		walk(sub);
		if (sub.name === ATTACHMENTS_NAME) {
			notes.push(`"${sub.name}/" (${other + md} file(s)) was left in place — attachments stay with the folder.`);
			continue;
		}
		notes.push(
			md
				? `"${sub.name}/" holds ${md} note(s) in subfolders, which conversion does NOT touch — they stay exactly as they are, and are in the backup. Move them up into this folder first if you want them converted.`
				: `"${sub.name}/" (${other} file(s)) was left in place.`,
		);
	}
}

/** Files sitting directly in the folder that conversion does not convert —
 *  most importantly Stashpad's locked notes, which would otherwise vanish from
 *  the outline with no explanation at all. */
function auditRootFiles(folder: TFolder, notes: string[]): void {
	const others = folder.children.filter(
		(c): c is TFile => c instanceof TFile
			&& c.extension !== "md"
			&& c.extension !== DOC_EXTENSION
			&& !c.name.startsWith("."),
	);
	if (!others.length) return;
	const locked = others.filter((f) => f.extension === "stashenc");
	if (locked.length) {
		notes.push(`${locked.length} locked note(s) (.stashenc) were NOT converted — they stay encrypted and untouched, and are in the backup. Unlock them in Stashpad first if you want them in the outline.`);
	}
	const rest = others.filter((f) => f.extension !== "stashenc");
	if (rest.length) {
		notes.push(`${rest.length} other file(s) in the folder (${[...new Set(rest.map((f) => f.extension))].join(", ")}) were left exactly as they are.`);
	}
}

/** Copy a folder's files somewhere safe before rewriting them in place.
 *  Conversion edits real notes, so it always happens behind a backup. */
async function backupFolder(app: App, folder: TFolder, rootFolder: string): Promise<string> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const base = normalizePath(`${rootFolder}/_conversion-backups/${folder.name}-${stamp}`);
	const parts = base.split("/");
	let sofar = "";
	for (const part of parts) {
		sofar = sofar ? `${sofar}/${part}` : part;
		if (!app.vault.getFolderByPath(sofar)) await app.vault.createFolder(sofar);
	}
	const copy = async (src: TFolder, dest: string) => {
		// Snapshot the list: `children` is live, and when the chosen folder is an
		// ancestor of the backup location the copies being written would append
		// to the very array being walked — descending into the backup itself.
		for (const child of [...src.children]) {
			if (child instanceof TFile) {
				await app.vault.copy(child, `${dest}/${child.name}`);
			} else if (child instanceof TFolder) {
				if (child.name === "_conversion-backups") continue;
				const sub = `${dest}/${child.name}`;
				if (!app.vault.getFolderByPath(sub)) await app.vault.createFolder(sub);
				await copy(child, sub);
			}
		}
	};
	await copy(folder, base);
	// Sidecar dotfiles are invisible to the vault API, so vault.copy skipped
	// them; without this the backup could not restore the arrangement or the
	// recovery map.
	await backupSidecars(app, folder.path, base);
	// A backup of a Stashpad folder still LOOKS like a Stashpad folder. That
	// plugin skips `_`-prefixed folders, but that is a user setting it can turn
	// off; a file with our manifest extension is an exact, unconditional skip
	// on its side. Cheap insurance against a backup being adopted as live data.
	const marker = {
		format: "trynalist-backup",
		version: 1,
		note: "Conversion backup. Not a live document — Trynalist skips this folder, and this file makes Stashpad skip it too.",
		created: nowIsoStamp(),
	};
	await app.vault.create(`${base}/backup.${DOC_EXTENSION}`, JSON.stringify(marker, null, 2));
	return base;
}

function nowIsoStamp(): string {
	return new Date().toISOString();
}

// ── Stashpad folder → Trynalist document ────────────────────────────────

export async function convertStashpadToTrynalist(
	app: App,
	folder: TFolder,
	rootFolder: string,
): Promise<ConversionReport> {
	const notes: string[] = [];
	const backupPath = await backupFolder(app, folder, rootFolder);
	const mds = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");

	// Pass 1: read everything, so ordering and parent rewrites see the whole set.
	const seen = new Map<string, { file: TFile; fm: Record<string, unknown> }>();
	for (const file of mds) {
		// The file's own frontmatter when the metadata cache has not indexed it
		// yet: with a cold cache every id was missing, every parent was
		// treated as unknown, and the converted folder came out flat (L57).
		const fm = app.metadataCache.getFileCache(file)?.frontmatter
			?? parseFrontmatterBlock(await app.vault.cachedRead(file)) ?? {};
		const id = typeof fm.id === "string" ? fm.id : "";
		if (id) seen.set(id, { file, fm: fm as Record<string, unknown> });
	}

	// The real arrangement: parent -> ordered child ids, from the dotfile.
	const orderMap = await readOrderFile(app, folder.path);
	const orderOf = new Map<string, number>();
	{
		const scalars = new Map<string, Record<string, string>>();
		for (const file of mds) scalars.set(file.path, await readFrontmatterScalars(app, file));
		const buckets = new Map<string, TFile[]>();
		for (const file of mds) {
			const fm = scalars.get(file.path) ?? {};
			const parent = fm.parent && fm.parent !== "null" ? fm.parent : STASHPAD_ROOT_ID;
			buckets.set(parent, [...(buckets.get(parent) ?? []), file]);
		}
		const idOf = (f: TFile) => scalars.get(f.path)?.id ?? "";
		const createdOf = (f: TFile) =>
			scalars.get(f.path)?.created ?? new Date(f.stat.ctime).toISOString();
		for (const [parent, files] of buckets) {
			const listed = orderMap[parent] ?? [];
			const rank = new Map(listed.map((id, i) => [id, i]));
			// Listed ids in their listed order; everything else after, by created.
			files.sort((a, b) => {
				const ra = rank.get(idOf(a));
				const rb = rank.get(idOf(b));
				if (ra !== undefined && rb !== undefined) return ra - rb;
				if (ra !== undefined) return -1;
				if (rb !== undefined) return 1;
				return createdOf(a).localeCompare(createdOf(b));
			});
			files.forEach((f, i) => orderOf.set(f.path, (i + 1) * 100));
		}
		if (Object.keys(orderMap).length) {
			notes.push("Sibling order was taken from Stashpad's .stashpad-order.json, so the arrangement is preserved.");
		}
	}

	const docId = newId();
	let order = 0;
	for (const file of mds) {
		order += 100;
		// Captured INSIDE processFrontMatter: that callback sees the file's real
		// current frontmatter, whereas the metadata cache can still be stale on
		// a recently written file — which silently lost the attachment list.
		let attachments: string[] = [];
		await app.fileManager.processFrontMatter(file, (fm) => {
			if (Array.isArray(fm.attachments)) attachments = fm.attachments as string[];
			// Identity: keep Stashpad's id where there is one; the home note gets
			// a fresh id so it becomes an ordinary top-level item.
			const wasHome = fm.id === STASHPAD_ROOT_ID;
			if (wasHome || typeof fm.id !== "string" || !fm.id) fm.id = newId();
			if (wasHome) {
				// Remembered so converting back restores the home note rather
				// than leaving the folder rootless.
				fm.wasStashpadHome = true;
				notes.push(`"${file.basename}" was the Stashpad home note; it is now a normal top-level item, and will be restored if you convert back.`);
			}
			fm.doc = docId;
			const parent = fm.parent;
			fm.parent = typeof parent === "string" && parent !== STASHPAD_ROOT_ID && seen.has(parent)
				? parent
				: null;
			// From Stashpad's order file where possible. `position` is NOT what
			// that plugin sorts by, so it is only a last resort.
			fm.order = orderOf.get(file.path)
				?? (typeof fm.position === "number" ? fm.position : order);
			if (typeof fm.created !== "string") fm.created = new Date(file.stat.ctime).toISOString();
			fm.modified = new Date(file.stat.mtime).toISOString();
			if (fm.completed === true) fm.checked = true;
			if (fm.color !== undefined && fm.color !== null) fm.color = colorIndexOf(fm.color);
			// Dropping `attachments` is what releases Stashpad's claim on the
			// folder. The list is remembered verbatim so converting back
			// restores exactly what was there, and is ALSO written into the
			// body as embeds so the attachments stay visible and usable in the
			// outline meanwhile.
			if (attachments.length) fm.wasStashpadAttachments = [...attachments];
			delete fm.attachments;
			// Stashpad's recovery links describe the OLD tree. After reparenting
			// here they would point at the wrong places, and stale recovery
			// links are worse than none; Stashpad regenerates them.
			delete fm.parentLink;
			delete fm.children;
			delete fm.position;
			delete fm.completed;
		});
		if (attachments.length) {
			await app.vault.process(file, (raw) => {
				const links = attachments
					.map((a) => `![[${a.replace(/^!?\[\[/, "").replace(/\]\]$/, "")}]]`)
					.join(" ");
				return raw.trimEnd() + `\n\n${links}\n`;
			});
			notes.push(`"${file.basename}" had ${attachments.length} attachment(s); they are now links in the item.`);
		}
	}

	// Depth/indent, once the parent graph is settled.
	await stampDepths(app, folder);
	await removeStaleStructure(app, folder.path, notes, backupPath);
	auditRootFiles(folder, notes);
	auditSubfolders(folder, notes);
	if (!folder.path.startsWith(`${rootFolder.replace(/\/+$/, "")}/`)) {
		notes.push(`This folder sits outside "${rootFolder}", so it will not appear in the Trynalist panel until you move it there. It opens fine from the file explorer.`);
	}

	// The manifest is what makes the folder ours.
	const manifest: DocManifest = {
		format: "trynalist-doc",
		version: 1,
		id: docId,
		title: folder.name,
		created: new Date().toISOString(),
		modified: new Date().toISOString(),
	};
	const manifestPath = `${folder.path}/${folder.name}.${DOC_EXTENSION}`;
	if (!app.vault.getAbstractFileByPath(manifestPath)) {
		await app.vault.create(manifestPath, JSON.stringify(manifest, null, 2));
	}
	return { items: mds.length, backupPath, notes };
}

/** Recompute indent/depth from the parent chain across a whole folder. */
async function stampDepths(app: App, folder: TFolder): Promise<void> {
	const mds = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
	const parentOf = new Map<string, string | null>();
	const fileOf = new Map<string, TFile>();
	for (const f of mds) {
		// From disk, not the metadata cache: this runs right after the parent
		// rewrite above, and the cache still holds the pre-rewrite values (the
		// same staleness noted for order and attachments). Trusting it stamped a
		// top-level item with depth 1 — and `indent` is only written when absent,
		// so the wrong value stuck.
		const fm = await readFrontmatterScalars(app, f);
		if (!fm.id) continue;
		fileOf.set(fm.id, f);
		parentOf.set(fm.id, fm.parent && fm.parent !== "null" ? fm.parent : null);
	}
	const depthOf = (id: string): number => {
		let depth = 0;
		let cur = parentOf.get(id) ?? null;
		const guard = new Set<string>([id]);
		while (cur && !guard.has(cur)) { guard.add(cur); depth++; cur = parentOf.get(cur) ?? null; }
		return depth;
	};
	for (const [id, file] of fileOf) {
		const depth = depthOf(id);
		await app.fileManager.processFrontMatter(file, (fm) => {
			fm.depth = depth;
			if (typeof fm.indent !== "number") fm.indent = depth;
		});
	}
}

// ── Trynalist document → Stashpad folder ────────────────────────────────

export async function convertTrynalistToStashpad(
	app: App,
	folder: TFolder,
	rootFolder: string,
): Promise<ConversionReport> {
	const notes: string[] = [];
	const backupPath = await backupFolder(app, folder, rootFolder);
	const mds = folder.children.filter((c): c is TFile => c instanceof TFile && c.extension === "md");

	// Read the bodies first: processFrontMatter and vault.process must not be
	// interleaved on the same file.
	const bodyEmbeds = new Map<string, string[]>();
	for (const file of mds) {
		const raw = await app.vault.cachedRead(file);
		// Embeds only. Making the `!` optional turned an ordinary [[note link]]
		// into an "attachment" on the way back; the alias is stripped too.
		const found = [...raw.matchAll(/!\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g)]
			.map((m) => `[[${m[1].trim()}]]`);
		if (found.length) bodyEmbeds.set(file.path, [...new Set(found)]);
	}

	let restoredHome = false;
	for (const file of mds) {
		await app.fileManager.processFrontMatter(file, (fm) => {
			if (fm.wasStashpadHome === true) {
				// This file was Stashpad's home note before an earlier
				// conversion; put it back so the round trip is lossless.
				fm.id = STASHPAD_ROOT_ID;
				fm.parent = null;
				delete fm.wasStashpadHome;
				restoredHome = true;
			} else if (typeof fm.id !== "string" || !fm.id) fm.id = newId();
			// Stashpad's root sentinel, and its per-note signature.
			if (fm.id !== STASHPAD_ROOT_ID && (fm.parent === null || fm.parent === undefined)) {
				fm.parent = STASHPAD_ROOT_ID;
			}
			if (!Array.isArray(fm.attachments)) {
				// Prefer the list this file arrived with; otherwise reconstruct
				// it from the embeds in the body, so attachments added while the
				// folder was a Trynalist document are handed over rather than
				// silently left behind.
				const remembered = fm.wasStashpadAttachments;
				fm.attachments = Array.isArray(remembered)
					? remembered
					: (bodyEmbeds.get(file.path) ?? []);
			}
			delete fm.wasStashpadAttachments;
			if (typeof fm.order === "number" && typeof fm.position !== "number") fm.position = fm.order;
			if (fm.checked === true) fm.completed = true;
			if (typeof fm.color === "number" && fm.color > 0) fm.color = COLOR_HEX[fm.color] ?? null;
			// Line-level bookkeeping means nothing to a note-level plugin.
			delete fm.doc;
			delete fm.indent;
			delete fm.depth;
		});
	}

	// Stashpad expects a home note; without it the folder has no root.
	// Stashpad names these `Home-<Folder>.md`; discovery is by frontmatter, but
	// matching the convention keeps its folders looking consistent.
	const homePath = `${folder.path}/Home-${folder.name}.md`;
	if (restoredHome) {
		notes.push("The original Stashpad home note was restored.");
	} else if (!app.vault.getAbstractFileByPath(homePath)) {
		const created = new Date().toISOString();
		await app.vault.create(
			homePath,
			`---\nid: ${STASHPAD_ROOT_ID}\nparent: null\ncreated: ${created}\nattachments: []\n---\n\n# ${folder.name}\n`,
		);
		notes.push("Added a Home note, which is how Stashpad recognises a folder.");
	}

	// Releasing our claim: the manifest is kept (it holds the document id and
	// title) but renamed so our own scan stops seeing it.
	//
	// CONTRACT: the retired name must NOT end in ".trynalist". Stashpad skips
	// any folder holding a file with that exact extension, so a retired name
	// like "<doc>.trynalist" or "<doc>.bak.trynalist" would make the folder
	// invisible to BOTH plugins, with no error to explain it. Keep the suffix
	// form. (Their side: docs/interop-trynalist.md in the Stashpad repo.)
	for (const file of folder.children) {
		if (file instanceof TFile && file.extension === DOC_EXTENSION) {
			await app.fileManager.renameFile(file, `${folder.path}/${file.basename}.trynalist-converted`);
			notes.push(`"${file.name}" was renamed to .trynalist-converted, so Trynalist no longer claims this folder. Rename it back to undo.`);
		}
	}
	// Write the arrangement where Stashpad actually reads it. Without this the
	// stale pre-conversion file would silently reinstate the OLD order, and a
	// natively-Trynalist document would fall back to creation order entirely.
	const orderMap: OrderMap = {};
	{
		const rows: Array<{ id: string; parent: string; order: number }> = [];
		for (const file of mds) {
			const fm = await readFrontmatterScalars(app, file);
			const id = fm.id;
			// The home note IS the root; listing it as a child of itself made
			// the order file describe a folder containing its own root.
			if (!id || id === STASHPAD_ROOT_ID) continue;
			const parent = fm.parent && fm.parent !== "null" ? fm.parent : STASHPAD_ROOT_ID;
			// parseFloat: Trynalist orders are fractional (an insert between 1000
			// and 2000 gets 1500.5…); parseInt truncated them and scrambled
			// sibling order in the converted folder (L59/L60).
			const parsed = parseFloat(fm.order ?? "");
			rows.push({ id, parent, order: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER });
		}
		for (const row of rows) {
			orderMap[row.parent] = orderMap[row.parent] ?? [];
		}
		for (const parent of Object.keys(orderMap)) {
			orderMap[parent] = rows
				.filter((r) => r.parent === parent)
				.sort((a, b) => a.order - b.order)
				.map((r) => r.id);
		}
		await writeOrderFile(app, folder.path, orderMap);
		notes.push("The outline's order was written to .stashpad-order.json, which is what Stashpad actually sorts by.");
	}

	await removeStaleStructure(app, folder.path, notes, backupPath);
	auditRootFiles(folder, notes);
	auditSubfolders(folder, notes);
	const handed = [...bodyEmbeds.values()].reduce((n, list) => n + list.length, 0);
	if (handed) notes.push(`${handed} attachment link(s) were listed in the notes' frontmatter for Stashpad.`);
	return { items: mds.length, backupPath, notes };
}

export async function convertFolder(
	app: App,
	folder: TFolder,
	rootFolder: string,
	to: "trynalist" | "stashpad",
): Promise<ConversionReport | null> {
	try {
		return to === "trynalist"
			? await convertStashpadToTrynalist(app, folder, rootFolder)
			: await convertTrynalistToStashpad(app, folder, rootFolder);
	} catch (e) {
		console.error("Trynalist: conversion failed", e);
		new Notice("Trynalist: conversion failed — see console. Your backup is intact.");
		return null;
	}
}
