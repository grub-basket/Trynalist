import { App, Notice, TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import { newId, safeName, slugFor } from "./id-service";
import { primaryDate } from "./dates";
import { stableStringify } from "./settings-merge";
import type { DocManifest, DocRef, NodeSnapshot, TreeNode, TrynaId, MirrorMode } from "./types";
import { DOC_EXTENSION, MAX_HEADING, isReservedFolderName, ATTACHMENTS_SUBFOLDER, formatMirrorRef, parseMirrorRef } from "./types";

const ORDER_STEP = 100;
const MIN_GAP = 1e-6;

/** Our colour is an index 0–6 (Dynalist's labels); Stashpad stores a hex
 *  string. Accept either so a shared folder keeps its colours instead of
 *  silently losing them. */
const COLOR_HEX = ["", "#ff6a6a", "#ffa84c", "#ffdc5a", "#70c878", "#60aaff", "#be82ff"];

export function colorIndexOf(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.min(6, Math.round(value))) : 0;
	if (typeof value !== "string" || !value.trim()) return 0;
	const hex = value.trim().toLowerCase();
	const exact = COLOR_HEX.indexOf(hex);
	if (exact > 0) return exact;
	// Not one of ours — pick the nearest of the six rather than dropping it.
	const rgb = hexToRgb(hex);
	if (!rgb) return 0;
	let best = 0;
	let bestDist = Infinity;
	for (let i = 1; i < COLOR_HEX.length; i++) {
		const other = hexToRgb(COLOR_HEX[i]);
		if (!other) continue;
		const d = (rgb[0] - other[0]) ** 2 + (rgb[1] - other[1]) ** 2 + (rgb[2] - other[2]) ** 2;
		if (d < bestDist) { bestDist = d; best = i; }
	}
	return best;
}

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
	if (!m) return null;
	let h = m[1];
	if (h.length === 3) h = h.split("").map((c) => c + c).join("");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Split a node file body into (line text, note). First line is the outline
 *  line; everything after the first newline is the Dynalist-style note. */
/** The body contract is "first line is the item, the rest is its note". An
 *  item can itself contain line breaks (Dynalist's Ctrl+Shift+Enter), so those
 *  are escaped on the way to disk and restored on the way back — the file keeps
 *  exactly one line per item and no existing document needs migrating. */
export function splitBody(body: string): { text: string; note: string } {
	const idx = body.indexOf("\n");
	const rawText = idx === -1 ? body : body.slice(0, idx);
	const note = idx === -1 ? "" : body.slice(idx + 1);
	// Only TRAILING whitespace is dropped from the note: a leading trim would
	// eat the indentation of its first line.
	return { text: unescapeBreaks(rawText.trim()), note: note.replace(/\s+$/, "") };
}

/** Remove every match of `re` (which must be global) from an item's text or
 *  note, touching ONLY the lines that contained a match: on those, runs of
 *  spaces/tabs left behind collapse to one and the line's own indent is kept;
 *  a line that held nothing but the match is dropped (with one neighbouring
 *  blank line, so a removed embed between paragraphs leaves one gap, not
 *  two). Every other line — blank lines, indentation, code blocks — is left
 *  byte-identical. Replaces a whole-field `.replace(/\s{2,}/g, " ")` that
 *  flattened notes whenever a chip or link was removed. */
export function stripMatches(s: string, re: RegExp): string {
	const hits = (line: string): boolean => { re.lastIndex = 0; return re.test(line); };
	if (!hits(s)) return s;
	const out: string[] = [];
	let droppedAfterBlank = false;
	for (const line of s.split("\n")) {
		if (droppedAfterBlank && line.trim() === "") { droppedAfterBlank = false; continue; }
		droppedAfterBlank = false;
		if (!hits(line)) { out.push(line); continue; }
		const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
		re.lastIndex = 0;
		const rest = line.slice(lead.length).replace(re, "").replace(/[ \t]{2,}/g, " ").trim();
		if (rest) { out.push(lead + rest); continue; }
		droppedAfterBlank = out.length > 0 && out[out.length - 1].trim() === "";
	}
	return out.join("\n");
}

function joinBody(text: string, note: string): string {
	const line = escapeBreaks(text);
	return note ? `${line}\n${note}\n` : `${line}\n`;
}

// Built via String.fromCharCode, not a regex/string literal, so eslint's
// no-control-regex rule doesn't flag the NUL placeholder below.
const NUL = String.fromCharCode(0);
const NUL_RE = new RegExp(NUL, "g");

function escapeBreaks(s: string): string {
	// Backslashes first, so an escaped break is never confused with a literal
	// backslash the user typed. A carriage return is a break too: left raw, the
	// line-ending normalisation on the next load turned it into a newline and
	// split the item in two (L31). NUL is dropped — it is the placeholder
	// unescapeBreaks uses, and has no business in item text.
	return s.replace(NUL_RE, "").replace(/\\/g, "\\\\").replace(/\r\n?|\n/g, "\\n");
}

function unescapeBreaks(s: string): string {
	return s.replace(/\\\\/g, NUL).replace(/\\n/g, "\n").replace(NUL_RE, "\\");
}

/** Parse a file's own YAML frontmatter into an object, or null if it has none
 *  or the YAML is malformed. Used as a fallback when the metadata cache hasn't
 *  indexed a freshly written file yet. */
export function parseFrontmatterBlock(raw: string): Record<string, unknown> | null {
	const m = /^---\n([\s\S]*?)\n---/.exec(raw);
	if (!m) return null;
	try {
		const parsed: unknown = parseYaml(m[1]);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/** Frontmatter ids are always written as strings or numbers (`newId()`
 *  returns a string; legacy data can carry a numeric id). The narrow param
 *  type — rather than `unknown` going straight into `String()` — is what
 *  keeps this assignable-from-`any`-so-"unnecessary" vs.
 *  not-safely-stringifiable lint rules both satisfied without changing what
 *  actually gets printed for a well-formed id. */
export function idToString(id: string | number): string {
	return String(id);
}

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---\n")) return raw;
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return raw;
	const after = raw.indexOf("\n", end + 4);
	return after === -1 ? "" : raw.slice(after + 1);
}

/** An item file's id, text and note, from its raw content — for readers
 *  outside a DocIndex (item history, snapshots). Null when it carries no id. */
export function readItemFile(raw: string): { id: string; fm: Record<string, unknown>; text: string; note: string } | null {
	const text = normalizeEol(raw);
	const fm = parseFrontmatterBlock(text);
	if (!fm || fm.id === undefined || fm.id === null || fm.id === "") return null;
	const body = splitBody(stripFrontmatter(text));
	return { id: idToString(fm.id as string | number), fm, text: body.text, note: body.note };
}

/** Node files are written with LF, but a file that passed through a Windows
 *  editor or another tool can come back CRLF — and every frontmatter splice
 *  here keys on `---\n`. Normalising first means such a file is repaired on its
 *  next save rather than having its frontmatter block silently dropped. */
function normalizeEol(raw: string): string {
	// A UTF-8 byte-order mark in front of `---` hid the frontmatter from every
	// `startsWith("---\n")` test, so the next save replaced the whole file with
	// the body and the item lost its id (L55).
	const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Rewrite a file's frontmatter block through `edit`, leaving the body.
 *  Throws when the existing YAML can't be parsed (the caller falls back). */
function withFrontmatter(raw: string, edit: (fm: Record<string, unknown>) => void): string {
	const text = normalizeEol(raw);
	let fm: Record<string, unknown> = {};
	let rest = text;
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		if (end !== -1) {
			const parsed: unknown = parseYaml(text.slice(4, end));
			if (parsed !== null && parsed !== undefined && typeof parsed !== "object") throw new Error("frontmatter is not a map");
			fm = (parsed ?? {}) as Record<string, unknown>;
			const after = text.indexOf("\n", end + 4);
			rest = after === -1 ? "" : text.slice(after + 1);
		}
	}
	edit(fm);
	return `---\n${stringifyYaml(fm)}---\n${rest}`;
}

/** Replace the body of a node file, keeping its frontmatter block intact. */
function spliceBody(raw: string, body: string): string {
	const text = normalizeEol(raw);
	const fmEnd = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
	if (fmEnd === -1) return body;
	const afterFm = text.indexOf("\n", fmEnd + 4);
	// A block that ends exactly at `\n---` with no trailing newline: keep it
	// whole and start the body on a fresh line.
	if (afterFm === -1) return `${text}\n${body}`;
	return text.slice(0, afterFm + 1) + body;
}

/** The scan cache. Listing documents means reading every manifest, and the
 *  panels, the agenda, search, link suggestions and the reminder tick all ask
 *  for the same tree — many times per minute in a busy vault. The tree only
 *  changes when a folder or manifest under the root does, and the plugin bumps
 *  the generation from the vault events that say so (see main.ts), so between
 *  those the cached answer is exact. Keyed by root, so a settings change misses
 *  naturally. */
let scanGeneration = 0;
const scanCache = new Map<string, { gen: number; tree: Promise<DocGroup | null> }>();

/** Called by the plugin whenever a create/delete/rename lands under the root,
 *  or a `.trynalist` manifest is modified. */
export function invalidateDocScan(): void {
	scanGeneration++;
	readIndexCache.clear();
}

/** Loaded documents shared by the READ-ONLY whole-vault features — tags,
 *  attachments, link suggestions, global search, import diff, link audit
 *  (audit L75, the interim fix). Each used to load every document from
 *  scratch on every run. An entry is dropped as soon as anything under its
 *  folder is created, modified, deleted, renamed or re-indexed
 *  (invalidateDocItems, wired in main.ts), and the whole cache goes with
 *  invalidateDocScan. Least-recently-used past READ_INDEX_MAX documents.
 *
 *  Callers must not mutate what they get: anything that writes (move to
 *  another document, duplicate, restore) loads its own DocIndex. */
const READ_INDEX_MAX = 150;
const readIndexCache = new Map<string, { folder: string; index: Promise<DocIndex> }>();

export function loadReadOnlyIndex(app: App, doc: DocRef): Promise<DocIndex> {
	const key = doc.file.path;
	const hit = readIndexCache.get(key);
	if (hit && hit.folder === doc.folder.path) {
		readIndexCache.delete(key);   // re-insert: most recently used last
		readIndexCache.set(key, hit);
		return hit.index;
	}
	const index = new DocIndex(app, doc);
	const entry = { folder: doc.folder.path, index: index.load().then(() => index) };
	readIndexCache.set(key, entry);
	// A failed load must not be served from the cache.
	entry.index.catch(() => { if (readIndexCache.get(key) === entry) readIndexCache.delete(key); });
	while (readIndexCache.size > READ_INDEX_MAX) {
		const oldest = readIndexCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		readIndexCache.delete(oldest);
	}
	return entry.index;
}

/** Drop any cached document that `path` lies in (or is). */
export function invalidateDocItems(path: string): void {
	for (const [key, entry] of readIndexCache) {
		if (path === key || path === entry.folder || path.startsWith(`${entry.folder}/`)) readIndexCache.delete(key);
	}
}

/** One level of the doc hierarchy. A folder WITH a `.trynalist` manifest is a
 *  document (its md children are outline nodes — not recursed); a folder
 *  WITHOUT one is a grouping folder and is recursed. Identity comes from the
 *  manifest's presence + id, never from folder names, and there is no central
 *  index file to corrupt — the tree is rebuilt from a scan every time. */
export interface DocGroup {
	folder: TFolder;
	docs: DocRef[];
	groups: DocGroup[];
	/** Manifest files that exist but can't be parsed — surfaced, not hidden. */
	broken: TFile[];
}

function manifestsIn(folder: TFolder): TFile[] {
	return folder.children
		.filter((c): c is TFile => c instanceof TFile && c.extension === DOC_EXTENSION)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function scanDocs(app: App, rootFolder: string): Promise<DocGroup | null> {
	const key = normalizePath(rootFolder);
	const hit = scanCache.get(key);
	if (hit && hit.gen === scanGeneration) return hit.tree;
	const gen = scanGeneration;
	const tree = scanDocsUncached(app, key);
	scanCache.set(key, { gen, tree });
	// A failed scan must not be served from the cache.
	tree.catch(() => { if (scanCache.get(key)?.tree === tree) scanCache.delete(key); });
	return tree;
}

async function scanDocsUncached(app: App, rootPath: string): Promise<DocGroup | null> {
	const root = app.vault.getFolderByPath(rootPath);
	if (!root) return null;
	// Every manifest under the root, read in parallel batches up front — the
	// walk below used to await them one at a time (L78).
	const prefix = `${root.path}/`;
	const manifestFiles = app.vault.getFiles().filter((f) => f.extension === DOC_EXTENSION && f.path.startsWith(prefix));
	const texts = new Map<string, string>();
	for (let i = 0; i < manifestFiles.length; i += 64) {
		const slice = manifestFiles.slice(i, i + 64);
		const read = await Promise.all(slice.map((f) => app.vault.cachedRead(f).catch(() => "")));
		slice.forEach((f, k) => texts.set(f.path, read[k]));
	}
	const scan = async (folder: TFolder): Promise<DocGroup> => {
		const group: DocGroup = { folder, docs: [], groups: [], broken: [] };
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			// Attachments, backups and the other plugin's machinery are not
			// documents and are not groups; they are simply not listed.
			if (isReservedFolderName(child.name)) continue;
			const manifests = manifestsIn(child);
			if (manifests.length) {
				// First manifest (alphabetically) wins; extras are reported broken
				// so a stray duplicate never silently forks the doc.
				let placed = false;
				for (const file of manifests) {
					if (placed) { group.broken.push(file); continue; }
					try {
						const manifest = JSON.parse(texts.get(file.path) ?? await app.vault.cachedRead(file)) as DocManifest;
						if (manifest?.format !== "trynalist-doc") throw new Error("bad format");
						// A hand-edited or half-synced manifest with no title used to
						// throw in the sort below — outside this try — and take the
						// whole listing down with it. The folder name is a fine title.
						// An empty title too: it opened untitled and broke export (L36).
						if (typeof manifest.title !== "string" || !manifest.title.trim()) manifest.title = child.name;
						if (typeof manifest.id !== "string") manifest.id = String(manifest.id ?? "");
						group.docs.push({ manifest, folder: child, file });
						placed = true;
					} catch {
						group.broken.push(file);
					}
				}
			} else {
				const sub = await scan(child);
				// Empty grouping folders still render (people organize ahead of time).
				group.groups.push(sub);
			}
		}
		group.docs.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
		group.groups.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
		return group;
	};
	return scan(root);
}

/** Flat list of documents at any depth. Archived documents are left out
 *  unless asked for: an archive you still have to wade through in every
 *  picker and search isn't an archive. */
export async function listDocs(
	app: App,
	rootFolder: string,
	opts: { includeArchived?: boolean } = {},
): Promise<DocRef[]> {
	const tree = await scanDocs(app, rootFolder);
	if (!tree) return [];
	const out: DocRef[] = [];
	const walk = (g: DocGroup) => { out.push(...g.docs); g.groups.forEach(walk); };
	walk(tree);
	const filtered = opts.includeArchived ? out : out.filter((d) => !d.manifest.archived);
	filtered.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
	return filtered;
}

/** The minimal node shape a bulk import needs. Structurally matches ImportNode
 *  without importing it (which would make store depend on import). */
export interface ImportedNode {
	text: string;
	note: string;
	checked: boolean;
	checkbox: boolean;
	collapsed: boolean;
	heading: number;
	color: number;
	created?: string;
	modified?: string;
	sourceId?: string;
	dlExtra?: Record<string, unknown>;
	children: ImportedNode[];
}

/** Write a whole imported tree into a document folder as fast as the vault
 *  allows: ONE `vault.create` per item, with complete frontmatter+body composed
 *  up front. The normal path (createNode → writeMeta → writeBody) does three or
 *  four disk operations per item plus an O(n) rebuild each time — fine for a few
 *  edits, murder for a 44,000-item import. This bypasses all of that; the
 *  document is read fresh from disk when next opened, so no in-memory index need
 *  be maintained here. Returns the item count. */
export async function writeImportedTree(
	app: App,
	docRef: DocRef,
	roots: ImportedNode[],
	provenance?: { source: string; dlPermission?: number; dlPermissionLabel?: string },
): Promise<number> {
	const docId = docRef.manifest.id;
	const folder = docRef.folder.path;
	const now = nowIso();
	let count = 0;

	// Ids are assigned up front and a child's file does not need its parent's
	// to exist first (load() reads a folder in any order), so the files are
	// written 16 at a time instead of one awaited create per item (L77).
	const planned: Array<{ n: ImportedNode; id: string; parentId: string | null; depth: number; order: number }> = [];
	const plan = (n: ImportedNode, parentId: string | null, depth: number, order: number): void => {
		const id = newId();
		planned.push({ n, id, parentId, depth, order });
		let childOrder = ORDER_STEP;
		for (const c of n.children) {
			plan(c, id, depth + 1, childOrder);
			childOrder += ORDER_STEP;
		}
	};

	const writeOne = async (n: ImportedNode, id: string, parentId: string | null, depth: number, order: number): Promise<void> => {
		// Same field set and conditional inclusion as writeMeta, so a bulk-written
		// file is indistinguishable from an incrementally-saved one.
		const fm: Record<string, unknown> = {
			id, doc: docId, parent: parentId, order, indent: depth, depth,
			created: n.created || now, modified: n.modified || now,
		};
		if (n.checked) fm.checked = true;
		if (n.checkbox || n.checked) fm.checkbox = true;
		if (n.collapsed) fm.collapsed = true;
		if (n.heading) fm.heading = Math.max(0, Math.min(MAX_HEADING, n.heading));
		if (n.color) fm.color = n.color;
		const due = primaryDate(n.text, n.note);
		if (due) fm.due = due;
		if (n.sourceId) fm.dlId = n.sourceId;
		if (provenance) {
			fm.source = provenance.source;
			if (typeof provenance.dlPermission === "number") fm.dlPermission = provenance.dlPermission;
			if (provenance.dlPermissionLabel) fm.dlPermissionLabel = provenance.dlPermissionLabel;
		}
		if (n.dlExtra && Object.keys(n.dlExtra).length) fm.dlExtra = n.dlExtra;

		const content = `---\n${stringifyYaml(fm)}---\n${joinBody(n.text, n.note)}`;
		let path = `${folder}/${slugFor(n.text)}-${id}.md`;
		let k = 2;
		while (app.vault.getAbstractFileByPath(path)) path = `${folder}/${slugFor(n.text)}-${id} ${k++}.md`;
		await app.vault.create(path, content);
		count++;
	};

	let order = ORDER_STEP;
	for (const r of roots) {
		plan(r, null, 0, order);
		order += ORDER_STEP;
	}
	for (let i = 0; i < planned.length; i += 16) {
		await Promise.all(planned.slice(i, i + 16).map((p) => writeOne(p.n, p.id, p.parentId, p.depth, p.order)));
	}
	return count;
}

/** Add one item at the end of `parentId`'s children (top level for null)
 *  WITHOUT loading the document: the order comes from the siblings'
 *  frontmatter in the metadata cache, and one file is written. For writers
 *  outside any open view, such as Capture to inbox (L86). */
export async function appendItemFile(app: App, docRef: DocRef, parentId: string | null, text: string, note = ""): Promise<void> {
	let lastOrder = 0;
	let parentDepth = -1;
	for (const c of docRef.folder.children) {
		if (!(c instanceof TFile) || c.extension !== "md") continue;
		const fm = app.metadataCache.getFileCache(c)?.frontmatter;
		if (!fm?.id) continue;
		const p = typeof fm.parent === "string" && fm.parent !== "__root__" ? fm.parent : null;
		if (p === parentId && typeof fm.order === "number") lastOrder = Math.max(lastOrder, fm.order);
		if (parentId && String(fm.id) === parentId) parentDepth = typeof fm.depth === "number" ? fm.depth : 0;
	}
	if (parentId && parentDepth < 0) parentId = null;   // parent not found: top level
	const depth = parentId ? parentDepth + 1 : 0;
	const id = newId();
	const now = nowIso();
	const fm: Record<string, unknown> = {
		id, doc: docRef.manifest.id, parent: parentId, order: lastOrder + ORDER_STEP,
		indent: depth, depth, created: now, modified: now,
	};
	const due = primaryDate(text, note);
	if (due) fm.due = due;
	let path = `${docRef.folder.path}/${slugFor(text)}-${id}.md`;
	let k = 2;
	while (app.vault.getAbstractFileByPath(path)) path = `${docRef.folder.path}/${slugFor(text)}-${id} ${k++}.md`;
	await app.vault.create(path, `---\n${stringifyYaml(fm)}---\n${joinBody(text, note)}`);
}

export async function createDoc(app: App, rootFolder: string, title: string): Promise<DocRef> {
	const safe = safeName(title, "Untitled");
	if (isReservedFolderName(safe)) {
		throw new Error(`"${safe}" is a reserved folder name — Trynalist and Stashpad both use it for machinery.`);
	}
	const rootPath = normalizePath(rootFolder);
	if (!app.vault.getFolderByPath(rootPath)) await app.vault.createFolder(rootPath);
	let folderPath = normalizePath(`${rootPath}/${safe}`);
	let n = 2;
	// Taken also when a sibling differs only in case: on macOS and Windows
	// "Work" and "work" are the same folder, so the create failed and that
	// document's import aborted (L28).
	const siblings = new Set((app.vault.getFolderByPath(rootPath)?.children ?? []).map((c) => c.name.toLowerCase()));
	const taken = (p: string): boolean => !!app.vault.getAbstractFileByPath(p) || siblings.has(p.slice(p.lastIndexOf("/") + 1).toLowerCase());
	while (taken(folderPath)) folderPath = normalizePath(`${rootPath}/${safe} ${n++}`);
	const folder = await app.vault.createFolder(folderPath);
	const manifest: DocManifest = {
		format: "trynalist-doc",
		version: 1,
		id: newId(),
		title: safe,
		created: nowIso(),
		modified: nowIso(),
	};
	const file = await app.vault.create(
		`${folderPath}/${safe}.${DOC_EXTENSION}`,
		JSON.stringify(manifest, null, 2),
	);
	return { manifest, folder, file };
}

/** Rename a document: folder, manifest file, and the manifest's title, kept in
 *  step. The doc's `id` never changes, so nothing that references it breaks.
 *  Returns the sanitized title actually used. */
export async function renameDoc(app: App, doc: DocRef, title: string): Promise<string> {
	const safe = safeName(title, "");
	if (!safe) throw new Error("A document needs a name.");
	if (isReservedFolderName(safe)) {
		throw new Error(`"${safe}" is a reserved folder name — pick another.`);
	}
	const parentPath = doc.folder.parent?.path ?? "";
	const targetFolder = normalizePath(parentPath ? `${parentPath}/${safe}` : safe);
	// Folder first (children move with it), then the manifest inside it.
	if (targetFolder !== doc.folder.path) {
		const clash = app.vault.getAbstractFileByPath(targetFolder);
		if (clash) throw new Error(`"${safe}" already exists in that folder.`);
		await app.fileManager.renameFile(doc.folder, targetFolder);
	}
	const manifestTarget = normalizePath(`${doc.folder.path}/${safe}.${DOC_EXTENSION}`);
	if (manifestTarget !== doc.file.path) {
		await app.fileManager.renameFile(doc.file, manifestTarget);
	}
	await patchManifest(app, doc, (m) => { m.title = safe; });
	return safe;
}

/** Change fields of a document's manifest ON DISK, then mirror the result
 *  into `doc.manifest`. The panel and every open tab hold their own copy of
 *  the manifest, read at different times; writing a whole in-memory copy back
 *  reverted whatever another copy had changed — renaming from a tab
 *  un-archived a document archived from the panel (M26/L33/L34). Only the
 *  fields named here change; everything else is whatever the file holds now. */
export async function patchManifest(app: App, doc: DocRef, edit: (m: DocManifest) => void): Promise<void> {
	let result: DocManifest | null = null;
	await app.vault.process(doc.file, (raw) => {
		let current: DocManifest;
		try {
			const parsed: unknown = JSON.parse(raw);
			current = parsed && typeof parsed === "object" ? parsed as DocManifest : { ...doc.manifest };
		} catch {
			current = { ...doc.manifest };   // unreadable on disk: our copy is the best we have
		}
		edit(current);
		current.modified = nowIso();
		result = current;
		return JSON.stringify(current, null, 2);
	});
	if (result) {
		for (const key of Object.keys(doc.manifest)) delete (doc.manifest as unknown as Record<string, unknown>)[key];
		Object.assign(doc.manifest, result);
	}
}

/** In-memory tree for one doc folder. Loaded from node-file frontmatter;
 *  every mutation writes straight back to the files (database-first). */
/** Every sort a document supports, matching Dynalist's submenu. */
export type SortMode =
	| "alpha" | "alpha-desc"
	| "created" | "created-desc"
	| "modified" | "modified-asc"
	| "checked-last" | "checked-first"
	| "due" | "due-desc"
	| "reverse";

/** The import-provenance fields of a node or snapshot, only those that are
 *  set, with dlExtra deep-copied so a snapshot never aliases live state. */
function provenanceOf(n: {
	sourceId?: string; source?: string; dlPermission?: number; dlPermissionLabel?: string;
	dlExtra?: Record<string, unknown>; dlRemoved?: string;
}): Pick<NodeSnapshot, "sourceId" | "source" | "dlPermission" | "dlPermissionLabel" | "dlExtra" | "dlRemoved"> {
	const out: Pick<NodeSnapshot, "sourceId" | "source" | "dlPermission" | "dlPermissionLabel" | "dlExtra" | "dlRemoved"> = {};
	if (n.sourceId) out.sourceId = n.sourceId;
	if (n.source) out.source = n.source;
	if (typeof n.dlPermission === "number") out.dlPermission = n.dlPermission;
	if (n.dlPermissionLabel) out.dlPermissionLabel = n.dlPermissionLabel;
	if (n.dlExtra && Object.keys(n.dlExtra).length) out.dlExtra = JSON.parse(JSON.stringify(n.dlExtra)) as Record<string, unknown>;
	if (n.dlRemoved) out.dlRemoved = n.dlRemoved;
	return out;
}

export class DocIndex {
	nodes = new Map<TrynaId, TreeNode>();
	/** Whether this index already warned about duplicate item files (L52). */
	private duplicatesReported = false;
	/** Nodes shown at the top level because their parent was missing when the
	 *  document loaded, with the parent their file names. See load(). */
	private detachedParent = new Map<TrynaId, TrynaId>();
	private childMap = new Map<TrynaId | null, TreeNode[]>();

	constructor(
		private app: App,
		public docRef: DocRef,
	) {}

	async load(): Promise<void> {
		// Built off to the side and swapped in at the end. Clearing the live
		// map first left the document EMPTY for the whole batched read; a
		// keystroke in that window pushed an empty undo snapshot, and the next
		// Undo trashed every item (M19).
		const next = new Map<TrynaId, TreeNode>();
		const duplicates: string[] = [];
		const files = this.docRef.folder.children
			.filter((c): c is TFile => c instanceof TFile && c.extension === "md");
		// Read in bounded parallel batches rather than one await per file: a
		// 44,000-item document was 44,000 serial round-trips to the adapter.
		const BATCH = 64;
		const raws = new Map<TFile, string>();
		for (let i = 0; i < files.length; i += BATCH) {
			const slice = files.slice(i, i + BATCH);
			const texts = await Promise.all(slice.map((f) => this.app.vault.cachedRead(f)));
			slice.forEach((f, k) => raws.set(f, texts[k]));
		}
		for (const child of files) {
			const raw = normalizeEol(raws.get(child) ?? "");
			// Prefer the metadata cache, but fall back to parsing the file's own
			// frontmatter when the cache is cold — right after an import writes a
			// document, its files aren't indexed yet, so the cache returns nothing
			// and EVERY item would be skipped, opening the document blank. Parsing
			// the raw text makes load independent of the cache's timing.
			// A file written in the last few seconds may not be re-indexed yet, and
			// then the cache holds its OLD frontmatter (a checkbox just ticked, a
			// parent just changed) while the body read above is new (L24). Those
			// few files are parsed from their own text; the rest trust the cache
			// (parsing 44,000 files' YAML ourselves would cost seconds).
			const recent = Date.now() - child.stat.mtime < 10_000;
			let fm = (recent ? parseFrontmatterBlock(raw) : null) ?? this.app.metadataCache.getFileCache(child)?.frontmatter ?? {};
			if (!fm.id) fm = parseFrontmatterBlock(raw) ?? fm;
			if (fm.id === undefined || fm.id === null || fm.id === "") continue;
			// Ids are strings everywhere downstream (map keys, CSS selectors,
			// wikilinks). A hand-written `id: 123` parses as a number and would
			// silently miss every lookup, so coerce once here.
			const id = String(fm.id);
			// Trim the END only. An item with empty text and a note is written
			// as "\n<note>\n" (joinBody), and the importer writes that shape for
			// every note-only Dynalist bullet; a leading trim removed the empty
			// first line and promoted the note's first line into the item text.
			const { text, note } = splitBody(stripFrontmatter(raw).replace(/\s+$/, ""));
			// Unquoted ISO timestamps parse as Date objects; the sorts call
			// localeCompare on these, so they have to be strings.
			const stampOf = (v: unknown): string =>
				typeof v === "string" ? v : v instanceof Date && !isNaN(v.getTime()) ? v.toISOString() : nowIso();
			// Two files with one id — a sync conflict copy beside the real file.
			// Whichever the folder listed last used to win, silently; the newer
			// one (by `modified`, then file time) wins now, and it is said (L52).
			const prior = next.get(id);
			if (prior) {
				const priorStamp = `${prior.modified}|${String(prior.file?.stat.mtime ?? 0).padStart(15, "0")}`;
				const mine = `${stampOf(fm.modified)}|${String(child.stat.mtime).padStart(15, "0")}`;
				duplicates.push(prior.file?.path ?? id, child.path);
				if (mine <= priorStamp) continue;
			}
			next.set(id, {
				id,
				// Another plugin in the same vault (Stashpad) writes "__root__" as
				// its root sentinel. Treat any non-string / sentinel value as
				// top-level rather than as a dangling parent id.
				parent: typeof fm.parent === "string" && fm.parent !== "__root__" ? fm.parent : null,
				// `position` is the sibling-order key Stashpad uses; reading it
				// lets a folder written by that plugin open here in the right
				// order instead of collapsing to 0. See dev-docs/interop.md.
				order: typeof fm.order === "number" ? fm.order
					: typeof fm.position === "number" ? fm.position : 0,
				indent: typeof fm.indent === "number" ? fm.indent : 0,
				depth: typeof fm.depth === "number" ? fm.depth : 0,
				created: stampOf(fm.created),
				modified: stampOf(fm.modified),
				// Stashpad marks a done task `completed`; treat either as ticked.
				checked: !!(fm.checked ?? fm.completed),
				checkbox: !!fm.checkbox,
				checklist: !!fm.checklist,
				numbered: !!fm.numbered,
				collapsed: !!fm.collapsed,
				heading: typeof fm.heading === "number" ? fm.heading : 0,
				color: colorIndexOf(fm.color),
				due: primaryDate(text, note),
				mirrorOf: typeof fm.mirrorOf === "string" && fm.mirrorOf ? fm.mirrorOf : null,
				mirrorMode: fm.mirrorMode === "children" ? "children" : "item",
				text,
				note,
				file: child,
				sourceId: typeof fm.dlId === "string" && fm.dlId ? fm.dlId : undefined,
				source: typeof fm.source === "string" && fm.source ? fm.source : undefined,
				dlPermission: typeof fm.dlPermission === "number" ? fm.dlPermission : undefined,
				dlPermissionLabel: typeof fm.dlPermissionLabel === "string" && fm.dlPermissionLabel ? fm.dlPermissionLabel : undefined,
				dlExtra: fm.dlExtra && typeof fm.dlExtra === "object" ? fm.dlExtra as Record<string, unknown> : undefined,
				dlRemoved: typeof fm.dlRemoved === "string" && fm.dlRemoved ? fm.dlRemoved : undefined,
			});
		}
		this.nodes = next;
		if (duplicates.length && !this.duplicatesReported) {
			this.duplicatesReported = true;
			new Notice(`Trynalist: "${this.docRef.manifest.title}" has ${duplicates.length / 2} item file(s) sharing an id with another (probably sync conflict copies). The newer copy is shown; the integrity check lists both.`, 12000);
		}
		// Orphan guard: a parent id pointing outside the doc shows at the top
		// level — in memory only. The parent's file may simply not have arrived
		// yet (sync still delivering the folder), so the original parent is
		// remembered and keeps being written back; writing `parent: null`
		// on the next tick or keystroke made the detachment permanent (M34).
		this.detachedParent.clear();
		for (const n of this.nodes.values()) {
			if (n.parent && !this.nodes.has(n.parent)) {
				this.detachedParent.set(n.id, n.parent);
				n.parent = null;
			}
		}
		this.rebuild();
	}

	private rebuild(): void {
		this.childMap.clear();
		for (const n of this.nodes.values()) {
			const list = this.childMap.get(n.parent) ?? [];
			list.push(n);
			this.childMap.set(n.parent, list);
		}
		for (const list of this.childMap.values()) list.sort((a, b) => a.order - b.order);
		// Cycle guard + depth recompute. Memoised per pass: without the memo a
		// chain of k ancestors was re-walked for every one of its descendants,
		// and the per-node Set allocation showed up on every Enter in a big doc.
		const memo = new Map<TrynaId, number>();
		const depthOf = (n: TreeNode, seen: Set<TrynaId>): number => {
			if (!n.parent) return 0;
			const known = memo.get(n.id);
			if (known !== undefined) return known;
			if (seen.has(n.id)) { n.parent = null; return 0; }
			seen.add(n.id);
			const p = this.nodes.get(n.parent);
			// Breaking a cycle below can null THIS node's parent mid-recursion;
			// its depth is then 0, whatever the walk added up.
			const d = p && n.parent ? depthOf(p, seen) + 1 : 0;
			const final = n.parent ? d : 0;
			memo.set(n.id, final);
			return final;
		};
		const seen = new Set<TrynaId>();
		for (const n of this.nodes.values()) {
			seen.clear();
			n.depth = depthOf(n, seen);
		}
	}

	/** Add one node to its parent's (order-sorted) child list. */
	private insertIntoChildMap(node: TreeNode): void {
		const list = this.childMap.get(node.parent) ?? [];
		let lo = 0;
		let hi = list.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (list[mid].order <= node.order) lo = mid + 1; else hi = mid;
		}
		list.splice(lo, 0, node);
		this.childMap.set(node.parent, list);
	}

	children(parent: TrynaId | null): TreeNode[] {
		return this.childMap.get(parent) ?? [];
	}

	descendants(id: TrynaId): TreeNode[] {
		const out: TreeNode[] = [];
		const walk = (pid: TrynaId) => {
			for (const c of this.children(pid)) { out.push(c); walk(c.id); }
		};
		walk(id);
		return out;
	}

	/** Flat visible list under a zoom root, honoring collapsed state. */
	visible(zoomRoot: TrynaId | null, hideCompleted: boolean): TreeNode[] {
		const out: TreeNode[] = [];
		const walk = (pid: TrynaId | null) => {
			for (const c of this.children(pid)) {
				if (hideCompleted && c.checked) continue;
				out.push(c);
				if (!c.collapsed) walk(c.id);
			}
		};
		walk(zoomRoot);
		return out;
	}

	private orderBetween(parent: TrynaId | null, afterId: TrynaId | null): number {
		const sibs = this.children(parent);
		if (!sibs.length) return ORDER_STEP;
		if (afterId === null) return sibs[0].order - ORDER_STEP;
		const i = sibs.findIndex((s) => s.id === afterId);
		if (i === -1 || i === sibs.length - 1) return sibs[sibs.length - 1].order + ORDER_STEP;
		const gap = sibs[i + 1].order - sibs[i].order;
		if (gap > MIN_GAP) return sibs[i].order + gap / 2;
		return NaN; // caller renumbers
	}

	private async renumber(parent: TrynaId | null): Promise<void> {
		const sibs = this.children(parent);
		for (let i = 0; i < sibs.length; i++) {
			sibs[i].order = (i + 1) * ORDER_STEP;
			// Renumbering is bookkeeping; none of these items was edited (L18).
			await this.writeMeta(sibs[i], { preserveModified: true });
		}
	}

	/** Create the on-disk file for a phantom node, named from its current text. */
	/** A node whose file was deleted outside this view (another device, sync)
	 *  while the document stayed open. Writing to the dead TFile threw ENOENT,
	 *  unhandled, and the typing was silently lost (M25). The edit wins: the
	 *  file reference is dropped so the write re-creates it, and the user is
	 *  told once per item. */
	private dropIfGone(n: TreeNode): void {
		if (!n.file) return;
		// Still the file at that path AND still in this document. A second view
		// of the same document deleting the item moves its file into the trash:
		// the TFile lives on under the trash path, and writes went there —
		// the typing vanished into the trash (L5).
		if (this.app.vault.getAbstractFileByPath(n.file.path) === n.file
			&& n.file.parent?.path === this.docRef.folder.path) return;
		n.file = null;
		if (!this.recreated.has(n.id)) {
			this.recreated.add(n.id);
			new Notice(`Trynalist: "${n.text || "(empty item)"}" was deleted elsewhere while you were editing it; your edit brought it back.`, 8000);
		}
	}
	private recreated = new Set<TrynaId>();

	private async materialize(n: TreeNode): Promise<void> {
		this.dropIfGone(n);
		if (n.file) return;
		const base = `${this.docRef.folder.path}/${slugFor(n.text)}-${n.id}`;
		// The id keeps this unique in normal use, but an update can re-add an item
		// whose file the metadata cache didn't report (so it looked new) while the
		// file is still on disk — a bare create would then throw "File already
		// exists" and fail the document. If the path is taken, adopt the existing
		// file rather than colliding.
		let path = `${base}.md`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) { n.file = existing; return; }
		let k = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${base} ${k++}.md`;
		n.file = await this.io(this.app.vault.create(path, joinBody(n.text, n.note)));
	}

	/** Public wrapper used when copying nodes between documents. */
	/** Own-write bookkeeping for foreign-change detection (outline-view's
	 *  checkForeignChanges). Every vault write this index makes goes through
	 *  io(); while one is in flight, or for a moment after, the files on disk
	 *  may be half-updated relative to memory (frontmatter and body are two
	 *  separate writes), so a comparison then would mistake our own write for
	 *  someone else's. */
	private inflight = 0;
	private lastWriteAt = 0;
	// Takes the write's promise: the call has already started, and inflight
	// goes up synchronously, before any vault event for it can be delivered.
	private async io<T>(write: Promise<T>): Promise<T> {
		this.inflight++;
		this.lastWriteAt = Date.now();
		try { return await write; } finally { this.inflight--; this.lastWriteAt = Date.now(); }
	}
	/** No write in flight and none in the last `ms`. */
	isQuiet(ms = 1200): boolean {
		return this.inflight === 0 && Date.now() - this.lastWriteAt > ms;
	}

	/** Does this node file on disk say what memory says? False when it holds a
	 *  node this index does not know (created elsewhere) or any field the
	 *  outline shows differs. True for files that are not nodes at all. Only
	 *  meaningful when isQuiet(). */
	matchesDisk(raw: string): boolean {
		const text0 = normalizeEol(raw);
		const fm = parseFrontmatterBlock(text0);
		if (!fm || fm.id === undefined || fm.id === null || fm.id === "") return true;
		const n = this.nodes.get(idToString(fm.id as string | number));
		if (!n) return false;
		const { text, note } = splitBody(stripFrontmatter(text0).replace(/\s+$/, ""));
		const parent = typeof fm.parent === "string" && fm.parent !== "__root__" ? fm.parent : null;
		const order = typeof fm.order === "number" ? fm.order : typeof fm.position === "number" ? fm.position : 0;
		// A detached node (see load) still has its original parent on disk.
		const memParent = n.parent ?? this.detachedParent.get(n.id) ?? null;
		return n.text === text && n.note === note && memParent === parent && n.order === order
			&& n.checked === !!(fm.checked ?? fm.completed) && n.checkbox === !!fm.checkbox
			&& n.collapsed === !!fm.collapsed && n.heading === (typeof fm.heading === "number" ? fm.heading : 0)
			&& n.color === colorIndexOf(fm.color);
	}

	async writeNode(n: TreeNode, opts?: { preserveModified?: boolean }): Promise<void> {
		await this.writeMeta(n, opts);
		await this.writeBody(n);
	}

	private async writeMeta(n: TreeNode, opts?: { preserveModified?: boolean }): Promise<void> {
		// A node's frontmatter must never reference a parent that isn't on
		// disk — materialize the whole phantom ancestor chain first.
		const p = n.parent ? this.nodes.get(n.parent) : null;
		if (p && !p.file) await this.writeMeta(p);
		await this.materialize(n);
		if (!n.file) return;
		// Every write is a modification and re-stamps `modified` — except an
		// import, which asks to keep the source's own timestamp (opts set it on
		// n.modified beforehand). Guard on the flag AND a real value so a missing
		// timestamp still falls back to now rather than writing undefined.
		if (!(opts?.preserveModified && n.modified)) n.modified = nowIso();
		await this.io(this.app.fileManager.processFrontMatter(n.file, (fm: Record<string, unknown>) => this.applyMeta(fm, n)));
	}

	/** The frontmatter a node file carries, applied onto `fm`. Shared by
	 *  writeMeta (processFrontMatter) and the one-write text save. */
	private applyMeta(fm: Record<string, unknown>, n: TreeNode): void {
		// Still detached (see load)? Leave where it lives on disk alone.
		const detached = n.parent === null && this.detachedParent.has(n.id);
		fm.id = n.id;
		fm.doc = this.docRef.manifest.id;
		if (!detached) {
			fm.parent = n.parent;
			fm.indent = n.indent;
			fm.depth = n.depth;
		}
		fm.order = n.order;
		fm.created = n.created;
		fm.modified = n.modified;
		if (n.checked) fm.checked = true; else delete fm.checked;
		if (n.checkbox) fm.checkbox = true; else delete fm.checkbox;
		if (n.checklist) fm.checklist = true; else delete fm.checklist;
		if (n.numbered) fm.numbered = true; else delete fm.numbered;
		if (n.collapsed) fm.collapsed = true; else delete fm.collapsed;
		if (n.heading) fm.heading = n.heading; else delete fm.heading;
		if (n.color) fm.color = n.color; else delete fm.color;
		if (n.due) fm.due = n.due; else delete fm.due;
		if (n.mirrorOf) { fm.mirrorOf = n.mirrorOf; fm.mirrorMode = n.mirrorMode; }
		else { delete fm.mirrorOf; delete fm.mirrorMode; }
		if (n.sourceId) fm.dlId = n.sourceId; else delete fm.dlId;
		if (n.source) fm.source = n.source; else delete fm.source;
		if (typeof n.dlPermission === "number") fm.dlPermission = n.dlPermission; else delete fm.dlPermission;
		if (n.dlPermissionLabel) fm.dlPermissionLabel = n.dlPermissionLabel; else delete fm.dlPermissionLabel;
		if (n.dlExtra && Object.keys(n.dlExtra).length) fm.dlExtra = n.dlExtra; else delete fm.dlExtra;
		// Written when set, never deleted here: an update clears it itself,
		// and a file that already carries it keeps it.
		if (n.dlRemoved) fm.dlRemoved = n.dlRemoved;
	}

	/** Persist a node whose fields were changed in place (mirror mode, say).
	 *  Nothing else here writes without also mutating, so this is the one
	 *  explicit "I already changed it, write it out" door. */
	async touch(id: TrynaId): Promise<void> {
		const n = this.nodes.get(id);
		if (n) await this.writeMeta(n);
	}

	/** Create a mirror of `sourceRef` as a child of `parent`. The node carries
	 *  no text of its own — see dev-docs/mirrors-and-portals.md. */
	async createMirror(
		sourceRef: string,
		mode: MirrorMode,
		parent: TrynaId | null,
		afterId: TrynaId | null,
		label = "",
	): Promise<TreeNode> {
		const node = await this.createNode(label, parent, afterId);
		node.mirrorOf = sourceRef;
		node.mirrorMode = mode;
		// A mirror must exist on disk even with empty text, or it would stay a
		// RAM-only phantom and vanish on reload.
		await this.writeMeta(node);
		return node;
	}

	async createNode(text: string, parent: TrynaId | null, afterId: TrynaId | null): Promise<TreeNode> {
		// Nothing lives under a mirror (it would never be drawn): a new item
		// aimed there — a copy-drop, a paste — lands right after it instead.
		const host = parent ? this.nodes.get(parent) : undefined;
		if (host?.mirrorOf) { afterId = host.id; parent = host.parent; }
		// A parent that no longer exists (deleted by a concurrent action) would
		// file the item under a ghost: on disk, and invisible (L11).
		if (parent && !this.nodes.has(parent)) { parent = null; afterId = null; }
		const id = newId();
		let order = this.orderBetween(parent, afterId);
		if (Number.isNaN(order)) {
			await this.renumber(parent);
			order = this.orderBetween(parent, afterId);
		}
		const p = parent ? this.nodes.get(parent) : null;
		const depth = p ? p.depth + 1 : 0;
		const created = nowIso();
		const node: TreeNode = {
			id, parent, order, indent: depth, depth, created, modified: created,
			checked: false, checkbox: false, checklist: false, numbered: false, collapsed: false,
			heading: 0, color: 0, due: primaryDate(text, ""),
			mirrorOf: null, mirrorMode: "item",
			text, note: "", file: null,
		};
		this.nodes.set(id, node);
		// Slot it into its sibling list instead of rebuilding the whole index:
		// a rebuild per insert made every bulk insert — Duplicate document,
		// paste, templates, copy to another document — quadratic (M63: ~9 s of
		// rebuilds to grow a document to 10,000 items). A new leaf cannot form a
		// cycle, and its depth is already known from its parent.
		this.insertIntoChildMap(node);
		// Blank rows stay RAM-only (no SSD write per empty Enter); the file is
		// created on the first save with real content, named from that text.
		if (text) await this.writeMeta(node);
		return node;
	}

	/** One write at a time per node. A debounced save and an immediate one (blur,
	 *  a chord) can overlap on the same row; both used to race through the
	 *  rename-on-first-save and the two disk writes, with whichever finished last
	 *  winning. The fields are set synchronously up front so a render between
	 *  the calls still sees the newest text; only the disk work is serialised. */
	private writeChains = new Map<TrynaId, Promise<void>>();

	async setBody(id: TrynaId, text: string, note: string): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n.text = text;
		n.note = note;
		n.due = primaryDate(text, note);
		const prev = this.writeChains.get(id) ?? Promise.resolve();
		const run = prev.catch(() => undefined).then(() => this.writeBodyNow(n, text, note));
		this.writeChains.set(id, run);
		try {
			await run;
		} finally {
			if (this.writeChains.get(id) === run) this.writeChains.delete(id);
		}
	}

	private async writeBodyNow(n: TreeNode, text: string, note: string): Promise<void> {
		this.dropIfGone(n);
		if (!n.file) {
			if (!text && !note) return; // still blank — stays in RAM
			await this.writeMeta(n); // creates the file, named from the text
			return;
		}
		// Rename-on-first-save: files created blank (legacy) carry the
		// placeholder "item" slug; fix it once, then the name is frozen.
		// The id suffix makes collisions impossible.
		if (n.file.name === `item-${n.id}.md`) {
			const slug = slugFor(text);
			if (slug !== "item") {
				await this.io(this.app.fileManager.renameFile(
					n.file,
					`${this.docRef.folder.path}/${slug}-${n.id}.md`,
				));
			}
		}
		// One write for body and frontmatter together: a save used to rewrite
		// the file twice — the body, then processFrontMatter — doubling disk
		// and sync traffic on every debounced keystroke save (L85).
		const p = n.parent ? this.nodes.get(n.parent) : null;
		if (p && !p.file) await this.writeMeta(p);
		n.modified = nowIso();
		const file = n.file;
		try {
			await this.io(this.app.vault.process(file, (raw) => spliceBody(
				withFrontmatter(raw, (fm) => this.applyMeta(fm, n)), joinBody(text, note),
			)));
		} catch {
			// Frontmatter this parser can't read: the old two-step write, which
			// lets Obsidian's own processFrontMatter deal with it.
			await this.io(this.app.vault.process(file, (raw) => spliceBody(raw, joinBody(text, note))));
			await this.writeMeta(n);
		}
	}

	/** Move a node (with its subtree) under a new parent, after a sibling. */
	async move(id: TrynaId, parent: TrynaId | null, afterId: TrynaId | null): Promise<boolean> {
		const n = this.nodes.get(id);
		if (!n) return false;
		// A stale parent id (row deleted by a concurrent action, a drop across a
		// re-render) would file the node under a ghost and write that to disk.
		if (parent && !this.nodes.has(parent)) return false;
		// A mirror is a window onto another item and draws none of its own
		// children, so anything filed under it vanished from view — Tab below
		// a mirror, a drop one level in (mirrors review finding 3).
		if (parent && this.nodes.get(parent)?.mirrorOf) {
			new Notice("Trynalist: a mirror can't hold items of its own — add them to its source instead.");
			return false;
		}
		// Cycle guard: cannot move under own descendant (or self).
		let probe: TrynaId | null = parent;
		while (probe) {
			if (probe === id) { new Notice("Trynalist: can't move an item into itself."); return false; }
			probe = this.nodes.get(probe)?.parent ?? null;
		}
		let order = this.orderBetween(parent, afterId === id ? null : afterId);
		if (Number.isNaN(order)) {
			await this.renumber(parent);
			order = this.orderBetween(parent, afterId === id ? null : afterId);
		}
		const depthBefore = n.depth;
		n.parent = parent;
		n.order = order;
		// Placed on purpose: it is no longer waiting for its old parent.
		this.detachedParent.delete(id);
		this.rebuild();
		n.indent = n.depth;
		await this.writeMeta(n);
		// Descendants store depth/indent, which only change when the moved node's
		// depth did. A move among siblings (Alt+arrows, a same-level drop) used to
		// rewrite every descendant anyway — 1,200 serial writes for a big branch —
		// and stamp each "just edited" (M64). Restamps keep their `modified`.
		if (n.depth !== depthBefore) {
			for (const d of this.descendants(id)) {
				d.indent = d.depth;
				await this.writeMeta(d, { preserveModified: true });
			}
		}
		return true;
	}

	async toggleChecked(id: TrynaId): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n.checked = !n.checked;
		await this.writeMeta(n);
	}

	/** Add or remove this item's own checkbox (Dynalist's post-2020 model). */
	async setCheckbox(id: TrynaId, value: boolean): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n.checkbox = value;
		if (!value) n.checked = false;   // no checkbox, no checked state
		await this.writeMeta(n);
	}

	/** "Add checkbox to children" — every descendant, all levels, as Dynalist's
	 *  bulk convenience does. */
	async setCheckboxDeep(id: TrynaId, value: boolean): Promise<void> {
		for (const d of this.descendants(id)) {
			d.checkbox = value;
			if (!value) d.checked = false;
			await this.writeMeta(d);
		}
	}

	/** Delete every checked item in a subtree (or the whole document). */
	async deleteChecked(root: TrynaId | null, opts?: { trashDir?: string }): Promise<number> {
		const scope = root ? this.descendants(root) : [...this.nodes.values()];
		// Deepest first, so a checked parent doesn't take its checked children
		// with it and leave the loop deleting ghosts.
		const checked = scope.filter((n) => n.checked).map((n) => n.id);
		// One batch: one trash group and one rebuild, not one per item (M65).
		return await this.deleteNodes(checked, opts);
	}

	async setFlag(
		id: TrynaId,
		key: "checklist" | "collapsed" | "numbered",
		value: boolean,
	): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n[key] = value;
		// Folding is view state, not an edit: it must not make the item "just
		// modified" (sorts, the Edited filter, the Dynalist update's local-edit
		// check). Checklist/numbered do change what the item shows (L18).
		await this.writeMeta(n, { preserveModified: key === "collapsed" });
	}

	/** Set the fold state of many items at once: all in memory first, then
	 *  the files written in parallel batches. Collapse all / expand to level
	 *  wrote one file per item, strictly in turn (L76). `onProgress` is told
	 *  how many are done, for a notice on big runs. */
	async setCollapsedMany(changes: Array<{ id: TrynaId; collapsed: boolean }>, onProgress?: (done: number, total: number) => void): Promise<void> {
		const nodes: TreeNode[] = [];
		for (const { id, collapsed } of changes) {
			const n = this.nodes.get(id);
			if (!n || n.collapsed === collapsed) continue;
			n.collapsed = collapsed;
			nodes.push(n);
		}
		for (let i = 0; i < nodes.length; i += 16) {
			await Promise.all(nodes.slice(i, i + 16).map((n) => this.writeMeta(n, { preserveModified: true })));
			onProgress?.(Math.min(i + 16, nodes.length), nodes.length);
		}
	}

	async setColor(id: TrynaId, color: number): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n.color = colorIndexOf(color);
		await this.writeMeta(n);
	}

	async setHeading(id: TrynaId, level: number): Promise<void> {
		const n = this.nodes.get(id);
		if (!n) return;
		n.heading = Math.max(0, Math.min(MAX_HEADING, level));
		await this.writeMeta(n);
	}

	/** Delete node + descendants to the vault trash (recoverable). */
	async deleteNode(id: TrynaId, opts?: { trashDir?: string }): Promise<void> {
		await this.deleteNodes([id], opts);
	}

	/** Delete several nodes with their subtrees as ONE operation: one dated
	 *  trash group (one _trashinfo.json) and one index rebuild. Deleting 600
	 *  ticked items used to make 600 groups — the Trash then read each one's
	 *  info file on every open — and 600 rebuilds (M65). Returns how many
	 *  nodes went, descendants included. */
	async deleteNodes(ids: TrynaId[], opts?: { trashDir?: string }): Promise<number> {
		const doomed = new Map<TrynaId, TreeNode>();
		for (const id of ids) {
			const n = this.nodes.get(id);
			if (!n || doomed.has(id)) continue;
			doomed.set(id, n);
			for (const d of this.descendants(id)) doomed.set(d.id, d);
		}
		if (!doomed.size) return 0;
		const list = [...doomed.values()];
		if (opts?.trashDir) {
			await this.moveToTrash(list, opts.trashDir);
			for (const n of list) this.nodes.delete(n.id);
			this.rebuild();
			return list.length;
		}
		for (const n of list) {
			this.nodes.delete(n.id);
			if (n.file) await this.io(this.app.fileManager.trashFile(n.file)); // phantoms never touched disk
		}
		this.rebuild();
		return list.length;
	}

	/** Where this session's deletes put each item file, by its old path — so
	 *  an undo can move the file BACK instead of writing a new one and leaving
	 *  the original in the trash, where a later Restore laid down a second
	 *  file with the same id (M27–M29). */
	private trashedFrom = new Map<string, { dest: string; group: string }>();

	/** Move a deleted subtree into a dated group under the Trynalist trash folder
	 *  instead of trashing it outright — recoverable within Trynalist until the
	 *  user empties the trash. Files keep their frontmatter (id, parent, doc), so
	 *  restoring is just moving them back into the document folder. `vault.rename`
	 *  (not fileManager.renameFile) is deliberate: a link to a trashed item should
	 *  dangle, not silently be rewritten to point into the trash. */
	private async moveToTrash(nodes: TreeNode[], trashDir: string): Promise<void> {
		const withFiles = nodes.filter((n) => n.file);
		if (!withFiles.length) return;
		if (!this.app.vault.getFolderByPath(trashDir)) await this.app.vault.createFolder(trashDir);
		const title = this.docRef.manifest.title || "Document";
		const safe = safeName(title, "Document");
		const stamp = nowIso().replace(/[:.]/g, "-");
		let group = normalizePath(`${trashDir}/${safe} — ${stamp}`);
		let k = 2;
		while (this.app.vault.getAbstractFileByPath(group)) group = normalizePath(`${trashDir}/${safe} — ${stamp} (${k++})`);
		await this.app.vault.createFolder(group);
		const info = {
			format: "trynalist-trash", version: 1,
			docFolder: this.docRef.folder.path,
			docId: this.docRef.manifest.id,
			docTitle: title,
			trashedAt: nowIso(),
			files: [] as string[],
		};
		for (const n of withFiles) {
			if (!n.file) continue;
			const from = n.file.path;
			let dest = normalizePath(`${group}/${n.file.name}`);
			let j = 2;
			while (this.app.vault.getAbstractFileByPath(dest)) dest = normalizePath(`${group}/${n.file.basename} ${j++}.${n.file.extension}`);
			await this.io(this.app.vault.rename(n.file, dest));
			info.files.push(dest.slice(group.length + 1));
			this.trashedFrom.set(from, { dest, group });
		}
		await this.io(this.app.vault.create(normalizePath(`${group}/_trashinfo.json`), JSON.stringify(info, null, 2)));
	}

	// ── snapshots / undo ────────────────────────────────────────────────

	/** Clone the whole doc's in-memory state. Cheap (no disk reads) because
	 *  text/note are already resident; restore() reconciles disk to it. */
	snapshot(): NodeSnapshot[] {
		return [...this.nodes.values()].map((n) => ({
			id: n.id, parent: n.parent, order: n.order, indent: n.indent, depth: n.depth,
			created: n.created, modified: n.modified, checked: n.checked,
			checkbox: n.checkbox, checklist: n.checklist, numbered: n.numbered, collapsed: n.collapsed, heading: n.heading,
			color: n.color, due: n.due, mirrorOf: n.mirrorOf, mirrorMode: n.mirrorMode,
			text: n.text, note: n.note,
			path: n.file?.path ?? null,
			...provenanceOf(n),
		}));
	}

	/** Reconcile the doc back to a snapshot: revive deleted nodes, trash nodes
	 *  created since, and restore fields/bodies. Used by undo AND redo. */
	async restore(snap: NodeSnapshot[]): Promise<void> {
		const wanted = new Map(snap.map((s) => [s.id, s]));
		// One failed file operation must not stop the rest: an undo that
		// stopped half-way left the document half-reverted (L6). Failures are
		// collected and reported once everything else has been written.
		const failures: string[] = [];
		const attempt = async (what: string, op: () => Promise<unknown>): Promise<void> => {
			try { await op(); } catch (e) { failures.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); }
		};
		// 1. Trash anything created after the snapshot.
		for (const n of [...this.nodes.values()]) {
			if (wanted.has(n.id)) continue;
			const f = n.file;
			if (f) await attempt(f.path, () => this.io(this.app.fileManager.trashFile(f)));
			this.nodes.delete(n.id);
		}
		// 2. Revive or update each snapshotted node. Only nodes that actually
		//    differ get rewritten — an undo must not rewrite every file in the
		//    doc (needless SSD churn and sync noise).
		const dirty = new Set<TrynaId>();
		const differs = (n: TreeNode, s: NodeSnapshot): boolean =>
			n.parent !== s.parent || n.order !== s.order || n.indent !== s.indent ||
			n.depth !== s.depth || n.checked !== s.checked || n.checkbox !== s.checkbox ||
			n.checklist !== s.checklist ||
			n.numbered !== s.numbered ||
			n.collapsed !== s.collapsed || n.heading !== s.heading || n.color !== s.color ||
			n.text !== s.text || n.note !== s.note || n.created !== s.created ||
			n.due !== s.due || n.mirrorOf !== s.mirrorOf || n.mirrorMode !== s.mirrorMode ||
			stableStringify(provenanceOf(n)) !== stableStringify(provenanceOf(s));
		const reclaimedGroups = new Set<string>();
		for (const s of snap) {
			let n = this.nodes.get(s.id);
			if (n && differs(n, s)) dirty.add(s.id);
			if (!n) {
				dirty.add(s.id);
				let existing = s.path
					? this.app.vault.getAbstractFileByPath(s.path)
					: null;
				// Deleted into Trynalist's trash this session: take the very file
				// back out rather than writing a fresh one beside the old.
				const parked = !existing && s.path ? this.trashedFrom.get(s.path) : undefined;
				const parkedFile = parked ? this.app.vault.getAbstractFileByPath(parked.dest) : null;
				if (s.path && parked && parkedFile instanceof TFile) {
					await this.io(this.app.vault.rename(parkedFile, s.path));
					existing = parkedFile;
					this.trashedFrom.delete(s.path);
					reclaimedGroups.add(parked.group);
				}
				n = {
					id: s.id, parent: s.parent, order: s.order, indent: s.indent,
					depth: s.depth, created: s.created, modified: s.modified,
					checked: s.checked, checkbox: s.checkbox, checklist: s.checklist, numbered: s.numbered,
					collapsed: s.collapsed, heading: s.heading, color: s.color,
					due: s.due, mirrorOf: s.mirrorOf, mirrorMode: s.mirrorMode,
					text: s.text, note: s.note,
					file: existing instanceof TFile ? existing : null,
					...provenanceOf(s),
				};
				this.nodes.set(s.id, n);
			} else {
				Object.assign(n, {
					parent: s.parent, order: s.order, indent: s.indent, depth: s.depth,
					created: s.created, checked: s.checked, checkbox: s.checkbox, checklist: s.checklist,
					numbered: s.numbered, collapsed: s.collapsed, heading: s.heading, color: s.color,
					due: s.due, mirrorOf: s.mirrorOf, mirrorMode: s.mirrorMode,
					text: s.text, note: s.note,
					// Explicit undefineds too, so a field added since the
					// snapshot is taken back off.
					sourceId: undefined, source: undefined, dlPermission: undefined,
					dlPermissionLabel: undefined, dlExtra: undefined, dlRemoved: undefined,
					...provenanceOf(s),
				});
			}
		}
		this.rebuild();
		// A trash group emptied by the undo is removed with its info file, so
		// the Trash no longer offers to restore what is already back.
		for (const group of reclaimedGroups) {
			const folder = this.app.vault.getFolderByPath(group);
			if (!folder) continue;
			if (folder.children.some((c) => c instanceof TFile && c.extension === "md")) continue;
			await this.io(this.app.fileManager.trashFile(folder));
		}
		// 3. Write back only what changed (skips nodes that were phantom and
		//    stayed phantom — snapshot path null and no content).
		for (const s of snap) {
			if (!dirty.has(s.id)) continue;
			const n = this.nodes.get(s.id);
			if (!n) continue;
			if (!n.file && !s.path && !n.text && !n.note) continue;
			await attempt(n.text || n.id, async () => { await this.writeBody(n); await this.writeMeta(n); });
		}
		if (failures.length) {
			throw new Error(`${failures.length} item${failures.length === 1 ? "" : "s"} could not be written (first: ${failures[0]})`);
		}
	}

	/** Write a node's body without touching frontmatter ordering rules. */
	private async writeBody(n: TreeNode): Promise<void> {
		this.dropIfGone(n);
		if (!n.file) return;
		await this.io(this.app.vault.process(n.file, (raw) => spliceBody(raw, joinBody(n.text, n.note))));
	}

	// ── structural operations ───────────────────────────────────────────

	/** Deep-copy a node and its whole subtree, inserted right after the
	 *  original. Returns the new root node id. */
	async duplicateSubtree(id: TrynaId): Promise<TrynaId | null> {
		const src = this.nodes.get(id);
		if (!src) return null;
		const copyInto = async (
			node: TreeNode,
			parent: TrynaId | null,
			afterId: TrynaId | null,
		): Promise<TrynaId> => {
			const clone = await this.createNode(node.text, parent, afterId);
			// carriedFields, so a duplicated mirror stays a mirror instead of
			// becoming a blank row (mirrors review finding 9).
			Object.assign(clone, carriedFields(node), { checked: node.checked, due: node.due });
			await this.writeMeta(clone);
			await this.writeBody(clone);
			let prev: TrynaId | null = null;
			for (const child of this.children(node.id)) {
				prev = await copyInto(child, clone.id, prev);
			}
			return clone.id;
		};
		return copyInto(src, src.parent, src.id);
	}

	/** Sort a node's immediate children. Rewrites `order` only. */
	async sortChildren(
		parent: TrynaId | null,
		mode: SortMode,
	): Promise<void> {
		const sibs = [...this.children(parent)];
		const cmp: Record<string, (a: TreeNode, b: TreeNode) => number> = {
			"alpha": (a, b) => a.text.localeCompare(b.text),
			"alpha-desc": (a, b) => b.text.localeCompare(a.text),
			// "created"/"modified" read as OLDEST first and NEWEST first
			// respectively in the original pair, which is a trap when adding the
			// opposites — so each direction is now spelled out rather than
			// inferred from the name.
			"created": (a, b) => a.created.localeCompare(b.created),
			"created-desc": (a, b) => b.created.localeCompare(a.created),
			"modified": (a, b) => b.modified.localeCompare(a.modified),
			"modified-asc": (a, b) => a.modified.localeCompare(b.modified),
			"checked-last": (a, b) => Number(a.checked) - Number(b.checked),
			"checked-first": (a, b) => Number(b.checked) - Number(a.checked),
			// Undated items sink to the bottom rather than sorting as "oldest".
			"due": (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"),
			"due-desc": (a, b) => (b.due ?? "0000").localeCompare(a.due ?? "0000"),
		};
		// Reversing is not a comparison — it has no key to sort on, it just flips
		// whatever order the siblings are in now.
		if (mode === "reverse") sibs.reverse();
		else sibs.sort(cmp[mode]);
		for (let i = 0; i < sibs.length; i++) sibs[i].order = (i + 1) * ORDER_STEP;
		this.rebuild();
		for (const s of sibs) await this.writeMeta(s);
	}

	/** Merge a node into the one before it (Backspace at line start):
	 *  text is appended, children are re-parented, the node is trashed. */
	async mergeIntoPrevious(id: TrynaId, previousId: TrynaId): Promise<number> {
		const n = this.nodes.get(id);
		const prev = this.nodes.get(previousId);
		if (!n || !prev) return -1;
		// Merging into a mirror would hand its text and children to a node that
		// never shows them (finding 3). Callers check first; this is the backstop.
		if (prev.mirrorOf || n.mirrorOf) return -1;
		const caret = prev.text.length;
		const kids = [...this.children(n.id)];
		// One rebuild for the whole batch, not one per child: the order keys run
		// from the previous item's last child, so a counter does the job.
		let order = this.children(prev.id).at(-1)?.order ?? 0;
		for (const k of kids) {
			k.parent = prev.id;
			order += ORDER_STEP;
			k.order = order;
		}
		const mergedNote = [prev.note, n.note].filter(Boolean).join("\n");
		this.nodes.delete(n.id);
		this.rebuild();
		if (n.file) await this.io(this.app.fileManager.trashFile(n.file));
		await this.setBody(prev.id, prev.text + n.text, mergedNote);
		for (const k of kids) await this.writeMeta(k);
		return caret;
	}

	/** Dynalist parity: deliberately-blank rows survive reload. Called when the
	 *  view closes — batches the phantom writes to one moment instead of one
	 *  write per empty Enter. */
	async persistPhantoms(): Promise<void> {
		for (const n of this.nodes.values()) {
			if (!n.file) await this.writeMeta(n);
		}
	}

	async touchDoc(): Promise<void> {
		await this.io(patchManifest(this.app, this.docRef, () => { /* only `modified` */ }));
	}
}

// ── document-level operations (Phase E) ──────────────────────────────────

/** Flip a document's archived flag. Nothing moves on disk. */
export async function setDocArchived(app: App, doc: DocRef, archived: boolean): Promise<void> {
	await patchManifest(app, doc, (m) => {
		if (archived) m.archived = true; else delete m.archived;
	});
}

/** Copy a whole document — new doc id and new node ids, so links and the
 *  parent graph in the copy can never point back into the original. */
export async function duplicateDoc(app: App, doc: DocRef, rootFolder: string): Promise<DocRef> {
	const source = new DocIndex(app, doc);
	await source.load();
	const target = await createDoc(app, doc.folder.parent?.path ?? rootFolder, `${doc.manifest.title} copy`);
	const targetIndex = new DocIndex(app, target);
	const ids = new Map<TrynaId, TrynaId>();
	await copySubtree(source, null, targetIndex, null, { ids });
	// A mirror or portal of an item in the SAME document should, in the copy,
	// show the copy's own item — otherwise the duplicate keeps reaching back
	// into the original. Mirrors of other documents are left alone.
	for (const n of targetIndex.nodes.values()) {
		const ref = n.mirrorOf ? parseMirrorRef(n.mirrorOf) : null;
		const mapped = ref && ref.docPath === doc.file.path ? ids.get(ref.itemId) : undefined;
		if (!mapped) continue;
		n.mirrorOf = formatMirrorRef(target.file.path, mapped);
		await targetIndex.writeNode(n);
	}
	// The copy's items embed the original's pasted files; without their own
	// copies, deleting the original broke every image in the duplicate (L37).
	// Copy the folder, then point full-path embeds at the copies.
	const attach = doc.folder.children.find((c): c is TFolder => c instanceof TFolder && c.name === ATTACHMENTS_SUBFOLDER);
	if (attach) {
		const destAttach = normalizePath(`${target.folder.path}/${ATTACHMENTS_SUBFOLDER}`);
		const copyFolder = async (from: TFolder, to: string): Promise<void> => {
			if (!app.vault.getFolderByPath(to)) await app.vault.createFolder(to);
			for (const c of from.children) {
				if (c instanceof TFolder) await copyFolder(c, `${to}/${c.name}`);
				else if (c instanceof TFile) await app.vault.copy(c, normalizePath(`${to}/${c.name}`));
			}
		};
		await copyFolder(attach, destAttach);
		const oldPrefix = `${attach.path}/`;
		const newPrefix = `${destAttach}/`;
		for (const n of targetIndex.nodes.values()) {
			if (!n.text.includes(oldPrefix) && !n.note.includes(oldPrefix)) continue;
			await targetIndex.setBody(n.id, n.text.split(oldPrefix).join(newPrefix), n.note.split(oldPrefix).join(newPrefix));
		}
	}
	return target;
}

/** Recursively copy children of `sourceParent` under `targetParent`. */
/** What a copy of an item carries across from the original, beyond its
 *  text: one list, so the recurrence roll, cross-document moves and
 *  duplicates stop drifting apart (each had its own, and two forgot the
 *  item's own checkbox — M39/M40). Not `checked`, `created` or provenance:
 *  whether those carry depends on the caller. */
export function carriedFields(n: TreeNode): Pick<TreeNode,
	"note" | "checkbox" | "checklist" | "numbered" | "collapsed" | "heading" | "color" | "mirrorOf" | "mirrorMode"> {
	return {
		note: n.note, checkbox: n.checkbox, checklist: n.checklist, numbered: n.numbered,
		collapsed: n.collapsed, heading: n.heading, color: n.color,
		// A mirror is a reference to a path+id, which stays valid across a
		// duplicate or a move; without this it became a blank item.
		mirrorOf: n.mirrorOf, mirrorMode: n.mirrorMode,
	};
}

/** What a MOVE keeps on top of carriedFields: the creation time and the
 *  Dynalist provenance. Without the dl* fields a moved imported item is a
 *  stranger to the next Update, which re-creates it (M12). A COPY must not
 *  take them — two items claiming one Dynalist id confuse the update. */
export function movedFields(n: TreeNode): Pick<TreeNode,
	"created" | "sourceId" | "source" | "dlPermission" | "dlPermissionLabel" | "dlExtra"> {
	return {
		created: n.created, sourceId: n.sourceId, source: n.source,
		dlPermission: n.dlPermission, dlPermissionLabel: n.dlPermissionLabel, dlExtra: n.dlExtra,
	};
}

export async function copySubtree(
	source: DocIndex,
	sourceParent: TrynaId | null,
	target: DocIndex,
	targetParent: TrynaId | null,
	opts?: { move?: boolean; ids?: Map<TrynaId, TrynaId> },
): Promise<void> {
	let after: TrynaId | null = null;
	for (const child of source.children(sourceParent)) {
		const clone = await target.createNode(child.text, targetParent, after);
		opts?.ids?.set(child.id, clone.id);
		Object.assign(clone, carriedFields(child), { checked: child.checked, due: child.due });
		if (opts?.move) Object.assign(clone, movedFields(child));
		await target.writeNode(clone);
		after = clone.id;
		await copySubtree(source, child.id, target, clone.id, opts);
	}
}

export interface IntegrityReport {
	docs: number;
	nodes: number;
	problems: Array<{ kind: string; detail: string; path: string }>;
}

/** Look for the states that can't be seen from inside a single document:
 *  duplicate/unreadable manifests, a document folder nested inside another
 *  document, node files missing their id, and cross-document id collisions. */
export async function checkIntegrity(app: App, rootFolder: string): Promise<IntegrityReport> {
	const report: IntegrityReport = { docs: 0, nodes: 0, problems: [] };
	const root = app.vault.getFolderByPath(normalizePath(rootFolder));
	if (!root) {
		report.problems.push({ kind: "missing-root", detail: `Root folder "${rootFolder}" does not exist.`, path: rootFolder });
		return report;
	}
	const seenDocIds = new Map<string, string>();
	const walk = async (folder: TFolder, insideDoc: string | null): Promise<void> => {
		const manifests = manifestsIn(folder);
		let docId: string | null = null;
		if (manifests.length) {
			if (insideDoc) {
				report.problems.push({
					kind: "doc-in-doc",
					detail: `This document sits inside "${insideDoc}", so the panel cannot see it. Move it out of that folder.`,
					path: folder.path,
				});
			}
			for (let i = 0; i < manifests.length; i++) {
				const file = manifests[i];
				try {
					const manifest = JSON.parse(await app.vault.read(file)) as DocManifest;
					if (manifest?.format !== "trynalist-doc") throw new Error("bad format");
					if (i > 0) {
						report.problems.push({ kind: "duplicate-manifest", detail: "A document folder has more than one .trynalist file; only the first is used.", path: file.path });
						continue;
					}
					report.docs++;
					docId = manifest.id;
					const prior = seenDocIds.get(manifest.id);
					if (prior) {
						report.problems.push({ kind: "duplicate-doc-id", detail: `Shares its document id with "${prior}" — duplicate the document properly instead of copying the folder.`, path: file.path });
					} else {
						seenDocIds.set(manifest.id, file.path);
					}
				} catch {
					report.problems.push({ kind: "unreadable-manifest", detail: "Not valid Trynalist JSON.", path: file.path });
				}
			}
			// Node-level checks for this document. Frontmatter comes from the
			// metadata cache, falling back to the file itself when the cache has
			// no id yet — the same fallback DocIndex.load uses. Right after a big
			// import, or while sync is still delivering files, a cache-only read
			// reported indexed children of unindexed parents as orphans, and the
			// one-click fix then flattened them.
			const fmByPath = new Map<string, Record<string, unknown> | undefined>();
			for (const child of folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				let fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(child)?.frontmatter;
				if (!fm?.id) fm = parseFrontmatterBlock(normalizeEol(await app.vault.cachedRead(child))) ?? fm;
				fmByPath.set(child.path, fm);
			}
			const ids = new Set<string>();
			const firstFile = new Map<string, TFile>();
			const stampOfFile = (f: TFile): string => {
				const m = fmByPath.get(f.path)?.modified;
				return `${typeof m === "string" ? m : ""}|${String(f.stat.mtime).padStart(15, "0")}`;
			};
			for (const child of folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const fm = fmByPath.get(child.path);
				if (!fm?.id) {
					report.problems.push({ kind: "not-a-node", detail: "Markdown file in a document folder with no Trynalist id — it will not appear in the outline.", path: child.path });
					continue;
				}
				report.nodes++;
				const id = idToString(fm.id as string | number);
				const other = firstFile.get(id);
				if (other) {
					// Name both, and which one the outline shows — the one load()
					// keeps, the newer (L53).
					const kept = stampOfFile(child) > stampOfFile(other) ? child : other;
					const hidden = kept === child ? other : child;
					report.problems.push({ kind: "duplicate-node-id", detail: `Shares its id with "${other.path}". The outline shows "${kept.path}"; "${hidden.path}" is hidden.`, path: hidden.path });
				} else {
					firstFile.set(id, child);
				}
				ids.add(id);
			}
			for (const child of folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const fm = fmByPath.get(child.path);
				const parent = typeof fm?.parent === "string" && fm.parent !== "__root__" ? fm.parent : null;
				if (parent && !ids.has(parent)) {
					report.problems.push({ kind: "orphan", detail: `Parent "${parent}" is missing; the item is shown at the top level.`, path: child.path });
				}
			}
		}
		for (const child of folder.children) {
			// Trynalist's own machinery (_trash, _conversion-backups,
			// _attachments …) holds no documents; the converter's backups were
			// being reported as broken documents (L54).
			if (child instanceof TFolder && !isReservedFolderName(child.name)) {
				await walk(child, manifests.length ? (docId ?? folder.name) : insideDoc);
			}
		}
	};
	await walk(root, null);
	return report;
}

/** Clear the `parent` of node files whose parent id no longer exists, so they
 *  sit at the top level of their document. The outline already treats an
 *  unknown parent this way in memory; this makes it true on disk. */
export async function reattachOrphans(app: App, paths: string[]): Promise<number> {
	let fixed = 0;
	for (const path of paths) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		// Re-check at fix time from the file itself: a parent that arrived (by
		// sync, or a slow index) since the check ran means this is no orphan.
		const parent = parseFrontmatterBlock(normalizeEol(await app.vault.read(file)))?.parent;
		if (typeof parent !== "string" || parent === "__root__") continue;
		const siblings = file.parent?.children ?? [];
		let present = false;
		for (const sib of siblings) {
			if (!(sib instanceof TFile) || sib.extension !== "md" || sib === file) continue;
			const cached: unknown = app.metadataCache.getFileCache(sib)?.frontmatter?.id;
			const id = cached ?? parseFrontmatterBlock(normalizeEol(await app.vault.cachedRead(sib)))?.id;
			if (id !== undefined && idToString(id as string | number) === parent) { present = true; break; }
		}
		if (present) continue;
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm.parent = null; });
		fixed++;
	}
	return fixed;
}
