import { App, TFile, TFolder } from "obsidian";
import { DocIndex, idToString, listDocs } from "./store";
import { formatMirrorRef, parseMirrorRef } from "./types";
import type { DocManifest, MirrorRef, TreeNode, TrynaId } from "./types";

/** What a mirror resolved to, or why it didn't. A missing source is a normal
 *  state, not an error: the source document can be moved, archived or deleted
 *  entirely independently of the document holding the mirror. */
export type Resolved =
	/** `movedTo`: the source document is no longer at the path the reference
	 *  names and was found again by the item's id; the caller should rewrite
	 *  the reference to it. */
	| { ok: true; index: DocIndex; node: TreeNode; docTitle: string; movedTo?: string }
	| { ok: false; reason: "no-document" | "no-item" | "cycle" | "bad-ref"; ref: MirrorRef };

/** Resolves mirror references, caching the documents it has to open.
 *
 *  Mirrors are multi-document by design, so following one means loading
 *  another document's index. That is the expensive part, and it is why this
 *  is a per-view object with a cache rather than a free function: a document
 *  with twenty mirrors into the same source should read that source once. */
export class MirrorResolver {
	private cache = new Map<string, DocIndex | null>();
	constructor(private app: App, private own: DocIndex) {}

	/** Drop the cache — call when the view reloads, so an edit made in the
	 *  source document since the last paint is picked up. */
	invalidate(): void {
		this.cache.clear();
	}

	private async indexFor(docPath: string): Promise<DocIndex | null> {
		if (this.cache.has(docPath)) return this.cache.get(docPath) ?? null;
		let built: DocIndex | null = null;
		try {
			// The mirror may point at our own document, which is the common
			// case for a portal. Reusing the live index means edits show up
			// without a reload, and avoids a second copy that could disagree.
			if (docPath === this.own.docRef.file.path) {
				built = this.own;
			} else {
				const file = this.app.vault.getAbstractFileByPath(docPath);
				const folder = file instanceof TFile ? file.parent : null;
				if (file instanceof TFile && folder instanceof TFolder) {
					const manifest = JSON.parse(await this.app.vault.read(file)) as DocManifest;
					if (typeof manifest.title !== "string" || !manifest.title.trim()) manifest.title = folder.name;
					built = new DocIndex(this.app, { manifest, folder, file });
					await built.load();
				}
			}
		} catch (e) {
			console.error("Trynalist: could not open a mirror's source", docPath, e);
			built = null;
		}
		this.cache.set(docPath, built);
		return built;
	}

	/** The manifest path of the document that now holds `itemId`, found through
	 *  the metadata cache (no document is loaded). Item ids are unique across
	 *  the vault, so this is how a reference survives its source document
	 *  being renamed or moved — the path in the reference goes stale, the id
	 *  does not (mirrors review finding 2). */
	private locate(itemId: TrynaId): string | null {
		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== "md" || !file.parent) continue;
			const id: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.id;
			if (id === undefined || idToString(id as string | number) !== itemId) continue;
			const manifest = file.parent.children.find(
				(c): c is TFile => c instanceof TFile && c.extension === "trynalist",
			);
			if (manifest) return manifest.path;
		}
		return null;
	}

	async resolve(node: TreeNode, ownDocPath: string): Promise<Resolved | null> {
		if (!node.mirrorOf) return null;
		const ref = parseMirrorRef(node.mirrorOf);
		// A malformed reference used to resolve to nothing at all, leaving
		// "Resolving mirror…" up forever with no menu to remove it (finding 10).
		if (!ref) return { ok: false, reason: "bad-ref", ref: { docPath: node.mirrorOf, itemId: "" } };
		let index = await this.indexFor(ref.docPath);
		let movedTo: string | undefined;
		if (!index || !index.nodes.has(ref.itemId)) {
			const found = this.locate(ref.itemId);
			if (found && found !== ref.docPath) {
				const moved = await this.indexFor(found);
				if (moved?.nodes.has(ref.itemId)) { index = moved; movedTo = found; }
			}
		}
		if (!index) return { ok: false, reason: "no-document", ref };
		const target = index.nodes.get(ref.itemId);
		if (!target) return { ok: false, reason: "no-item", ref };
		// A cycle is a mirror CHAIN that leads back to this node — a mirror of
		// a mirror of itself. Follow the chain rather than testing the node
		// against its own reference, which every mirror trivially matches.
		const origin = formatMirrorRef(ownDocPath, node.id);
		const seen = new Set<string>([origin]);
		let hop: TreeNode = target;
		let hopDoc = index;
		// Follow a mirror of a mirror to the item that actually has content.
		// Stopping at the first hop showed that hop — itself an empty mirror
		// node — so the head and body came out blank (finding 7).
		for (let i = 0; i < 32; i++) {
			const here = formatMirrorRef(hopDoc.docRef.file.path, hop.id);
			if (seen.has(here)) return { ok: false, reason: "cycle", ref };
			seen.add(here);
			if (!hop.mirrorOf) break;
			const nextRef = parseMirrorRef(hop.mirrorOf);
			if (!nextRef) return { ok: false, reason: "bad-ref", ref };
			const nextDoc = await this.indexFor(nextRef.docPath);
			if (!nextDoc) return { ok: false, reason: "no-document", ref: nextRef };
			const next = nextDoc.nodes.get(nextRef.itemId);
			if (!next) return { ok: false, reason: "no-item", ref: nextRef };
			hopDoc = nextDoc;
			hop = next;
		}
		if (hop.mirrorOf) return { ok: false, reason: "cycle", ref };   // chain too long to be real
		return { ok: true, index: hopDoc, node: hop, docTitle: hopDoc.docRef.manifest.title, movedTo };
	}

	/** The rows a resolved mirror contributes. `item` mode shows the source
	 *  item itself (its subtree comes from walking it); `children` mode — the
	 *  portal — shows only what sits under the source. */
	rowsFor(hit: Extract<Resolved, { ok: true }>, mode: TreeNode["mirrorMode"]): TreeNode[] {
		return mode === "children" ? hit.index.children(hit.node.id) : [hit.node];
	}

	/** The full story, for a tooltip: what happened, and that nothing was lost. */
	static explain(miss: Extract<Resolved, { ok: false }>, ref: string): string {
		const shared = "A mirror never holds content of its own — it is a window onto a "
			+ "subtree that lives elsewhere — so nothing you wrote has been lost. "
			+ "Remove the mirror from its menu, or put the source back.";
		switch (miss.reason) {
			case "no-document":
				return `The document this mirror points at is not there.\nIt may have been moved, `
					+ `renamed or deleted.\n\nLooking for: ${ref}\n\n${shared}`;
			case "no-item":
				return `The document is there, but the item this mirror points at is not.\n`
					+ `It was probably deleted in the source document.\n\nLooking for: ${ref}\n\n${shared}`;
			case "cycle":
				return `This mirror leads into a loop of mirrors that point at each other, so there `
					+ `is nothing underneath it to show.\n\n${shared}`;
			case "bad-ref":
				return `This mirror's reference is not in a form Trynalist can read (it needs a `
					+ `document path and an item id).\n\nReference: ${ref}\n\n${shared}`;
		}
	}

	/** Human-readable reason a mirror shows nothing, for the placeholder row. */
	static describe(miss: Extract<Resolved, { ok: false }>): string {
		const where = `${miss.ref.docPath.split("/").pop() ?? miss.ref.docPath}`;
		switch (miss.reason) {
			case "no-document": return `Mirror source document is missing (${where})`;
			case "no-item": return `Mirror source item is gone (was in ${where})`;
			case "cycle": return "Mirror leads into a loop of mirrors";
			case "bad-ref": return "Mirror reference is unreadable";
		}
	}
}

/** Every mirror in a document, with what it points at — used by the integrity
 *  check and by "find mirrors of this item". */
export function mirrorsIn(index: DocIndex): Array<{ node: TreeNode; ref: MirrorRef }> {
	const out: Array<{ node: TreeNode; ref: MirrorRef }> = [];
	for (const node of index.nodes.values()) {
		if (!node.mirrorOf) continue;
		const ref = parseMirrorRef(node.mirrorOf);
		if (ref) out.push({ node, ref });
	}
	return out;
}

/** The reference string for mirroring a given item of a given document. */
export function refTo(index: DocIndex, id: TrynaId): string {
	return formatMirrorRef(index.docRef.file.path, id);
}


/** Every mirror in a document, resolved. Built once before an export or an
 *  integrity pass, so those stay synchronous while still seeing through
 *  mirrors into other documents. */
export async function resolveAll(
	app: App,
	index: DocIndex,
): Promise<Map<TrynaId, Resolved>> {
	const resolver = new MirrorResolver(app, index);
	const out = new Map<TrynaId, Resolved>();
	for (const node of index.nodes.values()) {
		if (!node.mirrorOf) continue;
		const hit = await resolver.resolve(node, index.docRef.file.path);
		if (hit) out.set(node.id, hit);
	}
	return out;
}

/** Which documents hold a mirror pointing at `itemId` in `docPath`. Used to
 *  warn before deleting something other documents are showing — a mirror is
 *  the one way a change here can blank a row somewhere else. */
export async function findMirrorsOf(
	app: App,
	rootFolder: string,
	docPath: string,
	itemIds: Set<TrynaId>,
): Promise<Array<{ docTitle: string; docPath: string; count: number }>> {
	// From the metadata cache, not by loading every document: that made each
	// delete take seconds once a single mirror existed anywhere (mirrors
	// review finding 13). Matched on the item id — ids are unique across the
	// vault — so a mirror whose stored path went stale after a rename still
	// counts. `docPath` is kept for callers; the id is what identifies.
	void docPath;
	const docs = await listDocs(app, rootFolder, { includeArchived: true });
	const out: Array<{ docTitle: string; docPath: string; count: number }> = [];
	for (const doc of docs) {
		let count = 0;
		for (const child of doc.folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			const raw: unknown = app.metadataCache.getFileCache(child)?.frontmatter?.mirrorOf;
			if (typeof raw !== "string") continue;
			const ref = parseMirrorRef(raw);
			if (ref && itemIds.has(ref.itemId)) count++;
		}
		if (count) out.push({ docTitle: doc.manifest.title, docPath: doc.file.path, count });
	}
	return out;
}


/** Does ANY document hold a mirror? Cached, because the delete path asks on
 *  every delete and the honest answer requires opening every document — which
 *  made deleting a row take seconds in a vault with many documents. Almost
 *  every vault answers "no", and that answer makes the whole scan skippable.
 *
 *  Invalidated by the plugin on any vault change under the root. */
let mirrorsExistCache: { value: boolean; at: number } | null = null;

export function invalidateMirrorPresence(): void {
	mirrorsExistCache = null;
}

/** A single file under the root changed and its metadata now says whether it
 *  holds a mirror. A cached "no" can only become "yes" this way (one more
 *  mirror in the vault); a cached "yes" stays — removing a mirror is only ever
 *  discovered by a full reset, which the delete/rename events trigger. This is
 *  what lets the plugin's OWN saves (a `modify` per keystroke) leave the cache
 *  alone instead of throwing away the answer that makes deleting a row instant. */
export function noteFileMirrorState(hasMirror: boolean): void {
	if (!mirrorsExistCache) return;
	if (hasMirror && !mirrorsExistCache.value) mirrorsExistCache = { value: true, at: Date.now() };
}

/** Only a cached "yes" can be stale after a delete or rename. */
export function invalidateMirrorPresenceIfTrue(): void {
	if (mirrorsExistCache?.value) mirrorsExistCache = null;
}

export async function anyMirrorsExist(app: App, rootFolder: string): Promise<boolean> {
	if (mirrorsExistCache) return mirrorsExistCache.value;
	let found = false;
	try {
		// Read the RAW files rather than building indexes: this is a substring
		// question, not a structural one.
		const docs = await listDocs(app, rootFolder, { includeArchived: true });
		outer: for (const doc of docs) {
			for (const child of doc.folder.children) {
				if (!(child instanceof TFile) || child.extension !== "md") continue;
				const raw = await app.vault.cachedRead(child);
				if (raw.includes("mirrorOf")) { found = true; break outer; }
			}
		}
	} catch (e) {
		console.error("Trynalist: mirror presence check failed", e);
		// Unknown means "assume yes" — a missed warning is worse than a slow one.
		found = true;
	}
	mirrorsExistCache = { value: found, at: Date.now() };
	return found;
}
