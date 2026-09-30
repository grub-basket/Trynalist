import { App, Notice } from "obsidian";
import { listDocs, loadReadOnlyIndex } from "./store";
import { sift } from "./search";
import type { DocRef, TreeNode } from "./types";

export interface LinkTarget {
	/** Vault path of the file the link points at. */
	path: string;
	/** Item text (or document title) shown in the popover and as link text. */
	label: string;
	/** Document this belongs to, for the subtitle. */
	context: string;
}

/** Popover offering Trynalist items and documents after a `[[` trigger.
 *  Links are written as `[[path|label]]`, i.e. ordinary Obsidian wikilinks —
 *  so they also resolve in Obsidian's graph, backlinks and search. */
export class LinkSuggest {
	private el: HTMLElement | null = null;
	private targets: LinkTarget[] = [];
	private filtered: LinkTarget[] = [];
	private active = -1;
	/** In-flight load, shared by concurrent triggers. Without this, two
	 *  keystrokes could each start a scan and append the same targets twice. */
	private loading: Promise<void> | null = null;
	private loadedAt = 0;

	/** `live` hands over the document open in the calling view. Its items
	 *  are taken straight from that view's index on every open, so the
	 *  popover always offers what is on screen — the cached scan only has to
	 *  keep up with OTHER documents and ordinary notes. */
	constructor(
		private app: App,
		private rootFolder: string,
		private onPick: (target: LinkTarget) => void,
		private live: () => { folder: string; title: string; nodes: Iterable<TreeNode> } | null = () => null,
	) {}

	get isOpen(): boolean { return !!this.el; }

	private async loadTargets(): Promise<void> {
		// Cached briefly so typing doesn't rescan the vault per keystroke, but
		// not for the whole session — items created since should be linkable.
		if (this.loading) return this.loading;
		// This document's own items come live from the view (see `live`), and
		// files created, renamed or deleted elsewhere call invalidate(), so the
		// timer only has to catch edits to other documents' item text; two
		// minutes is plenty and stops a long linking session re-reading every
		// item every 30 s. Typing in this document never rescans the vault.
		if (this.loadedAt && Date.now() - this.loadedAt < 120_000) return;
		this.loading = this.scan();
		try { await this.loading; } finally { this.loading = null; }
	}

	private async scan(): Promise<void> {
		const collected: LinkTarget[] = [];
		try {
			const docs: DocRef[] = await listDocs(this.app, this.rootFolder);   // archived excluded
			for (const doc of docs) {
				collected.push({
					path: doc.file.path,
					label: doc.manifest.title,
					context: "document",
				});
				const index = await loadReadOnlyIndex(this.app, doc);
				for (const node of index.nodes.values()) {
					if (!node.text.trim() || !node.file) continue;
					collected.push({
						path: node.file.path,
						label: node.text,
						context: doc.manifest.title,
					});
				}
			}
			// Ordinary vault files too. Offering only Trynalist items meant a
			// wikilink to a normal note could not be completed at all — you had
			// to know and type the path, which is exactly how they ended up
			// wrong. Trynalist's own item files live inside document folders and
			// are already listed above, so they are skipped here.
			// Item files sit DIRECTLY in their document folder, so the parent path
			// is an exact key — an O(1) lookup instead of a prefix test against
			// every document for each of the vault's files.
			const ownFolders = new Set(docs.map((d) => d.folder.path));
			for (const file of this.app.vault.getFiles()) {
				if (file.extension === "trynalist") continue;
				if (file.parent && ownFolders.has(file.parent.path)) continue;
				collected.push({
					path: file.path,
					label: file.basename,
					context: file.parent?.path && file.parent.path !== "/" ? file.parent.path : "vault",
				});
			}
			// Swap in atomically, so a failed scan never half-replaces the list.
			this.targets = collected;
			this.loadedAt = Date.now();
		} catch (e) {
			console.error("Trynalist: link targets failed to load", e);
			new Notice("Trynalist: could not load link targets.");
		}
	}

	async open(anchor: HTMLElement, query: string): Promise<void> {
		await this.loadTargets();
		this.filter(query);
		if (!this.filtered.length) { this.close(); return; }
		if (!this.el) {
			this.el = anchor.doc.body.createDiv({ cls: "trynalist-link-suggest" });
		}
		this.renderList();
		const r = anchor.getBoundingClientRect();
		const win = anchor.win;
		this.el.style.left = `${Math.min(r.left, win.innerWidth - 340)}px`;
		this.el.style.top = `${r.bottom + 4}px`;
		if (r.bottom + 260 > win.innerHeight) {
			this.el.style.top = `${Math.max(8, r.top - 260)}px`;
		}
	}

	private filter(query: string): void {
		const doc = this.live();
		let pool = this.targets;
		if (doc) {
			// Drop the scan's (possibly stale) copy of this document's items and
			// use the live ones instead. Item files sit directly in the folder.
			const own = (path: string): boolean => path.slice(0, path.lastIndexOf("/")) === doc.folder;
			const fresh: LinkTarget[] = [];
			for (const node of doc.nodes) {
				if (!node.text.trim() || !node.file) continue;
				fresh.push({ path: node.file.path, label: node.text, context: doc.title });
			}
			pool = [...this.targets.filter((t) => !(own(t.path) && t.path.endsWith(".md"))), ...fresh];
		}
		this.filtered = pool
			.filter((t) => sift(`${t.label} ${t.context}`, query))
			.slice(0, 30);
		this.active = 0;
	}

	private renderList(): void {
		if (!this.el) return;
		this.el.empty();
		this.filtered.forEach((t, i) => {
			const row = this.el!.createDiv({
				cls: i === this.active ? "trynalist-link-item is-active" : "trynalist-link-item",
			});
			row.createDiv({ text: t.label });
			row.createDiv({ cls: "trynalist-suggest-trail", text: t.context });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();   // keep caret in the row
				this.onPick(t);
				this.close();
			});
		});
	}

	/** Returns true when the key was consumed by the popover. */
	handleKey(e: KeyboardEvent): boolean {
		if (!this.el || !this.filtered.length) return false;
		if (e.key === "ArrowDown") {
			this.active = (this.active + 1) % this.filtered.length;
			this.renderList();
			return true;
		}
		if (e.key === "ArrowUp") {
			this.active = (this.active - 1 + this.filtered.length) % this.filtered.length;
			this.renderList();
			return true;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			this.onPick(this.filtered[this.active]);
			this.close();
			return true;
		}
		if (e.key === "Escape") { this.close(); return true; }
		return false;
	}

	/** Forget cached targets — call when files elsewhere are created, renamed
	 *  or deleted. Edits inside the open document do not need it. */
	invalidate(): void { this.loadedAt = 0; }

	close(): void {
		this.el?.remove();
		this.el = null;
		this.filtered = [];
		this.active = -1;
	}
}
