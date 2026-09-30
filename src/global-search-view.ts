import { ItemView, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { searchAllDocs } from "./search";
import type { GlobalHit } from "./search";
import type TrynalistPlugin from "./main";
import type { DocIndex } from "./store";
import type { TreeNode, TrynaId } from "./types";

export const GLOBAL_SEARCH_VIEW = "trynalist-global-search";

/** Global search as a PAGE, not a modal.
 *
 *  A modal can only ever be a ranked list: it has one row per hit and nowhere
 *  to put the outline each hit came from. Dynalist shows results grouped by
 *  document with their ancestors intact, because "where did this match" is
 *  usually the question — and because a result you can see in context is one
 *  you can act on without opening it first.
 *
 *  Being a view rather than a modal is also what makes a search a place you
 *  navigated to: Obsidian records leaf history, so Back returns to it. */
export class GlobalSearchView extends ItemView {
	private query = "";
	private hits: GlobalHit[] = [];
	private searching = false;
	/** Ancestor ids of each hit, so a group can draw the path down to it. */
	private results: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TrynalistPlugin) {
		super(leaf);
		this.navigation = true;
		this.scope = new Scope(this.app.scope);
		this.scope.register([], "Escape", () => {
			this.goBack();
			return false;
		});
	}

	getViewType(): string { return GLOBAL_SEARCH_VIEW; }
	getIcon(): string { return "search"; }
	getDisplayText(): string {
		return this.query ? `Search: ${this.query}` : "Search all documents";
	}

	/** Seeded by whoever opened the view. */
	async setQuery(query: string): Promise<void> {
		this.query = query;
		this.render();
		await this.runSearch();
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private goBack(): void {
		// Obsidian's own history, since the view IS the page. Falling back to
		// closing the leaf would strand people who arrived here directly.
		const history = (this.leaf as unknown as { history?: { back?: () => void } }).history;
		if (history?.back) history.back();
		else this.leaf.detach();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("trynalist-globalsearch");

		const head = el.createDiv({ cls: "trynalist-gs-head" });
		head.createEl("h2", {
			cls: "trynalist-gs-title",
			text: this.query ? `Search results for "${this.query}"` : "Search all documents",
		});
		const back = head.createDiv({ cls: "trynalist-gs-back" });
		const backLink = back.createEl("a", { text: "Go back" });
		backLink.addEventListener("click", (e) => { e.preventDefault(); this.goBack(); });
		back.createSpan({ cls: "trynalist-gs-key", text: "[Esc]" });

		const bar = el.createDiv({ cls: "trynalist-gs-bar" });
		const input = bar.createEl("input", { type: "text", placeholder: "Search every document…" });
		input.value = this.query;
		const run = (): void => {
			this.query = input.value;
			void this.runSearch();
		};
		// Enter runs it, and so does the button. Typing does NOT: this reads every
		// document in the vault, which is not a per-keystroke operation.
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); run(); }
		});
		const go = bar.createEl("button", { cls: "mod-cta", text: "Search" });
		go.addEventListener("click", run);

		this.results = el.createDiv({ cls: "trynalist-gs-results" });
		this.paintResults();
		window.setTimeout(() => input.focus(), 0);
	}

	/** Set when Enter lands mid-search, so the newer query runs afterwards
	 *  instead of being dropped. */
	private rerun = false;

	private async runSearch(): Promise<void> {
		const q = this.query.trim();
		if (!q) { this.hits = []; this.paintResults(); return; }
		if (this.searching) { this.rerun = true; return; }
		this.searching = true;
		if (this.results) {
			this.results.empty();
			this.results.createDiv({ cls: "trynalist-panel-empty", text: "Searching…" });
		}
		try {
			this.hits = await searchAllDocs(
				this.app, this.plugin.settings.rootFolder, q, 300,
				this.plugin.settings.searchArchived,
			);
		} finally {
			this.searching = false;
		}
		// The title carries the query, so the tab label should follow it.
		this.app.workspace.requestSaveLayout();
		const title = this.contentEl.querySelector(".trynalist-gs-title");
		if (title) title.setText(`Search results for "${this.query}"`);
		this.paintResults();
		if (this.rerun) { this.rerun = false; await this.runSearch(); }
	}

	private paintResults(): void {
		const host = this.results;
		if (!host) return;
		host.empty();
		if (!this.query.trim()) return;
		if (!this.hits.length) {
			host.createDiv({ cls: "trynalist-panel-empty", text: `No items match "${this.query}".` });
			return;
		}
		host.createDiv({
			cls: "trynalist-gs-count",
			text: `Found ${this.hits.length} match${this.hits.length === 1 ? "" : "es"}:`,
		});

		// Group by document, keeping the order the results came back in so the
		// first document you see is the one with the first hit.
		const groups = new Map<string, GlobalHit[]>();
		for (const hit of this.hits) {
			const key = hit.doc.file.path;
			const list = groups.get(key);
			if (list) list.push(hit); else groups.set(key, [hit]);
		}
		for (const [path, hits] of groups) {
			this.paintGroup(host, path, hits);
		}
	}

	private paintGroup(host: HTMLElement, path: string, hits: GlobalHit[]): void {
		const idx = hits[0].index;
		const group = host.createDiv({ cls: "trynalist-gs-group" });
		const title = group.createDiv({ cls: "trynalist-gs-doc" });
		setIcon(title.createSpan({ cls: "trynalist-gs-doc-icon" }), "file-text");
		title.createSpan({ text: hits[0].doc.manifest.title });
		title.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) void this.plugin.openDocFile(file);
		});

		// Every hit WITH its ancestors, so each result reads as part of its
		// outline. Ancestors are drawn once even when several hits share them.
		const keep = new Set<TrynaId>();
		const matched = new Set<TrynaId>();
		for (const hit of hits) {
			matched.add(hit.node.id);
			keep.add(hit.node.id);
			let up: TreeNode | null = hit.node.parent ? idx.nodes.get(hit.node.parent) ?? null : null;
			const seen = new Set<TrynaId>();
			while (up && !seen.has(up.id)) {
				seen.add(up.id);
				keep.add(up.id);
				up = up.parent ? idx.nodes.get(up.parent) ?? null : null;
			}
		}
		const body = group.createDiv({ cls: "trynalist-gs-body" });
		this.paintBranch(body, idx, null, keep, matched, path);
	}

	private paintBranch(
		host: HTMLElement, idx: DocIndex, parent: TrynaId | null,
		keep: Set<TrynaId>, matched: Set<TrynaId>, docPath: string,
	): void {
		for (const n of idx.children(parent)) {
			if (!keep.has(n.id)) continue;
			const item = host.createDiv({ cls: "trynalist-gs-item" });
			// Only the INNERMOST hovered item lights its row. mouseover bubbles
			// through every ancestor item, so the first item to see it claims the
			// hover and stops the event; a plain :hover rule would light them all.
			item.addEventListener("mouseover", (e) => { e.stopPropagation(); item.addClass("is-hovered"); });
			item.addEventListener("mouseout", (e) => { e.stopPropagation(); item.removeClass("is-hovered"); });
			const row = item.createDiv({
				cls: matched.has(n.id) ? "trynalist-gs-row is-match" : "trynalist-gs-row",
			});
			row.createSpan({ cls: "trynalist-gs-bullet", text: "•" });
			const text = row.createSpan({ cls: "trynalist-gs-text" });
			this.paintHighlighted(text, n.text || "(empty item)");
			// Clicking ZOOMS to the item rather than merely opening the document —
			// you searched for this row, not for the file it lives in.
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				const file = this.app.vault.getAbstractFileByPath(docPath);
				if (file instanceof TFile) void this.plugin.openDeepLink({ doc: docPath, item: n.id, zoom: "1" });
			});
			const kids = idx.children(n.id).filter((c) => keep.has(c.id));
			if (kids.length) {
				const wrap = item.createDiv({ cls: "trynalist-gs-children" });
				this.paintBranch(wrap, idx, n.id, keep, matched, docPath);
			}
		}
	}

	/** The query's words marked inside the text, so you can see WHY a row
	 *  matched without re-reading it. Operators are stripped: `is:completed`
	 *  matched the item without appearing in it. */
	private paintHighlighted(host: HTMLElement, text: string): void {
		const words = this.query
			.replace(/\b\w+:[^\s]+/g, " ")
			.replace(/[-"]/g, " ")
			.split(/\s+/)
			.map((w) => w.trim())
			.filter((w) => w && w.toUpperCase() !== "OR");
		if (!words.length) { host.setText(text); return; }
		const pattern = new RegExp(`(${words.map(escapeRe).join("|")})`, "ig");
		let last = 0;
		for (const m of text.matchAll(pattern)) {
			const at = m.index ?? 0;
			if (at > last) host.createSpan({ text: text.slice(last, at) });
			host.createSpan({ cls: "trynalist-gs-hit", text: m[0] });
			last = at + m[0].length;
		}
		if (last < text.length) host.createSpan({ text: text.slice(last) });
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
