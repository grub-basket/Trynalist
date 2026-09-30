import { App, Modal, Notice, TFile, setIcon } from "obsidian";
import { DocIndex, listDocs, loadReadOnlyIndex } from "./store";
import { parseMirrorRef } from "./types";
import type { DocRef } from "./types";

/** Scan every Trynalist document for links that point nowhere, and show them
 *  grouped by document. Catches the two ways an item can reference something
 *  that isn't there:
 *
 *   - Obsidian wikilinks and embeds — `[[target]]`, `[[target|label]]`,
 *     `![[target]]` — whose target no vault file resolves to.
 *   - Mirrors/portals whose source item (mirrorOf = `<doc path>#<item id>`) no
 *     longer exists.
 *
 *  Import makes this worth having: a Dynalist export can carry links to notes
 *  that were never imported (shared docs skipped, say), and those should be
 *  visible rather than silently dead. */

interface BrokenLink {
	docTitle: string;
	itemText: string;
	target: string;
	kind: "wikilink" | "embed" | "mirror";
}

// One pattern for wikilinks and embeds: optional leading "!", target up to a
// "#" anchor or "|" label. Global so every link on a line is found.
const LINK_RE = /(!)?\[\[([^\[\]|#]+)(?:#[^\[\]|]+)?(?:\|[^\[\]]+)?\]\]/g;

export async function auditLinks(app: App, rootFolder: string): Promise<BrokenLink[]> {
	const docs = await listDocs(app, rootFolder, { includeArchived: true });
	const broken: BrokenLink[] = [];
	// Each document is loaded at most once for the whole audit. A mirror's
	// source used to be re-read for EVERY mirror pointing at it — two hundred
	// mirrors into one big document meant two hundred full loads.
	const byPath = new Map(docs.map((d) => [d.file.path, d]));
	const loaded = new Map<string, Promise<DocIndex>>();
	const indexFor = (doc: DocRef): Promise<DocIndex> => {
		let p = loaded.get(doc.file.path);
		if (!p) {
			p = loadReadOnlyIndex(app, doc);
			loaded.set(doc.file.path, p);
		}
		return p;
	};
	for (const doc of docs) {
		const idx = await indexFor(doc);
		const sourcePath = doc.file.path;
		for (const n of idx.nodes.values()) {
			// Wikilinks + embeds in the item text and its note.
			for (const field of [n.text, n.note]) {
				if (!field) continue;
				for (const m of field.matchAll(LINK_RE)) {
					const target = m[2].trim();
					if (!target) continue;
					const dest = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
					if (!dest) {
						broken.push({
							docTitle: doc.manifest.title,
							itemText: n.text || "(empty item)",
							target,
							kind: m[1] ? "embed" : "wikilink",
						});
					}
				}
			}
			// A mirror whose source is gone.
			if (n.mirrorOf) {
				// Same parser as the resolver (last `#`), not a first-`#` split.
				const ref = parseMirrorRef(n.mirrorOf);
				const path = ref?.docPath ?? "";
				const itemId = ref?.itemId ?? "";
				const srcDoc = ref ? app.vault.getAbstractFileByPath(path) : null;
				let ok = srcDoc instanceof TFile;
				if (ok && itemId) {
					// The source ITEM must still exist, not just its document.
					const srcRef = byPath.get(path);
					if (srcRef) ok = (await indexFor(srcRef)).nodes.has(itemId);
				}
				// Its document was renamed or moved: the item is still in the
				// vault under its id, and the mirror repoints itself when shown.
				if (!ok && itemId) {
					ok = app.vault.getFiles().some((f) => f.extension === "md"
						&& String(app.metadataCache.getFileCache(f)?.frontmatter?.id ?? "") === itemId);
				}
				if (!ok) {
					broken.push({ docTitle: doc.manifest.title, itemText: n.text || "(mirror)", target: n.mirrorOf, kind: "mirror" });
				}
			}
		}
	}
	return broken;
}

const KIND_ICON: Record<BrokenLink["kind"], string> = {
	wikilink: "link", embed: "image", mirror: "copy",
};
const KIND_LABEL: Record<BrokenLink["kind"], string> = {
	wikilink: "link", embed: "embed", mirror: "mirror",
};

export function openLinkAudit(app: App, rootFolder: string): void {
	const notice = new Notice("Trynalist: auditing links…", 0);
	void (async () => {
		try {
			const broken = await auditLinks(app, rootFolder);
			notice.hide();
			new LinkAuditModal(app, broken).open();
		} catch (e) {
			notice.hide();
			console.error("Trynalist: link audit failed", e);
			new Notice(`Trynalist: link audit failed — ${e instanceof Error ? e.message : String(e)}`);
		}
	})();
}

class LinkAuditModal extends Modal {
	constructor(app: App, private broken: BrokenLink[]) { super(app); }

	onOpen(): void {
		this.modalEl.addClass("trynalist-diff-modal");   // reuse the report styling
		this.titleEl.setText("Broken links");
		const { contentEl } = this;
		if (!this.broken.length) {
			contentEl.createDiv({ cls: "trynalist-panel-empty", text: "No broken links found." });
			return;
		}
		contentEl.createDiv({
			cls: "trynalist-diff-summary",
			text: `${this.broken.length} broken link${this.broken.length === 1 ? "" : "s"} across ${new Set(this.broken.map((b) => b.docTitle)).size} document(s).`,
		});
		const list = contentEl.createDiv({ cls: "trynalist-diff-list" });
		const groups = new Map<string, BrokenLink[]>();
		for (const b of this.broken) {
			const g = groups.get(b.docTitle);
			if (g) g.push(b); else groups.set(b.docTitle, [b]);
		}
		for (const [title, items] of groups) {
			const group = list.createDiv({ cls: "trynalist-diff-group" });
			const head = group.createDiv({ cls: "trynalist-diff-doc" });
			head.createSpan({ cls: "trynalist-diff-doc-title", text: title });
			head.createSpan({ cls: "trynalist-diff-doc-counts", text: `${items.length} broken` });
			for (const b of items) {
				const row = group.createDiv({ cls: "trynalist-diff-item" });
				const badge = row.createSpan({ cls: "trynalist-diff-badge is-removed" });
				setIcon(badge, KIND_ICON[b.kind]);
				badge.setAttribute("aria-label", KIND_LABEL[b.kind]);
				const body = row.createDiv({ cls: "trynalist-diff-item-body" });
				body.createDiv({ cls: "trynalist-diff-text", text: b.itemText });
				body.createDiv({ cls: "trynalist-diff-fields", text: `${KIND_LABEL[b.kind]} → ${b.target}` });
			}
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
