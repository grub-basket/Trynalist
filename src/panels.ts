import { ItemView, Menu, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type TrynalistPlugin from "./main";
import { listDocs, loadReadOnlyIndex, scanDocs } from "./store";
import type { DocGroup } from "./store";
import { sift } from "./search";
import type { DocRef } from "./types";
import { describeDue } from "./reminders";
import type { DueItem } from "./reminders";

export const FILES_VIEW_TYPE = "trynalist-files";
export const BOOKMARKS_VIEW_TYPE = "trynalist-bookmarks";
export const TAGS_VIEW_TYPE = "trynalist-tags";
export const RECENT_VIEW_TYPE = "trynalist-recent";
export const AGENDA_VIEW_TYPE = "trynalist-agenda";
export const ARCHIVE_VIEW_TYPE = "trynalist-archive";

/** Every individual pane, with the label the combined panel uses for it. */
export const PANE_TYPES: ReadonlyArray<readonly [string, string]> = [
	[FILES_VIEW_TYPE, "My files"],
	[BOOKMARKS_VIEW_TYPE, "Bookmarks"],
	[TAGS_VIEW_TYPE, "Tags"],
	[RECENT_VIEW_TYPE, "Recent"],
	[AGENDA_VIEW_TYPE, "Agenda"],
	[ARCHIVE_VIEW_TYPE, "Archived"],
];

/** Dynalist has separate panes for files, bookmarks and tags. The combined
 *  Documents panel stays as it is; these are the individual panes for people
 *  who want them side by side, redundancy included. */
abstract class TrynalistPane extends ItemView {
	constructor(leaf: WorkspaceLeaf, protected plugin: TrynalistPlugin) {
		super(leaf);
	}

	async onOpen(): Promise<void> {
		await this.render();
		const inRoot = (path: string) => path.startsWith(`${this.plugin.settings.rootFolder}/`);
		this.registerEvent(this.app.vault.on("create", (f) => { if (inRoot(f.path) && !this.plugin.isImporting()) this.schedule(); }));
		this.registerEvent(this.app.vault.on("delete", (f) => { if (inRoot(f.path) && !this.plugin.isImporting()) this.schedule(); }));
		this.registerEvent(this.app.vault.on("rename", (f, o) => { if ((inRoot(f.path) || inRoot(o)) && !this.plugin.isImporting()) this.schedule(); }));
	}

	private timer: number | null = null;
	protected schedule(): void {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => { this.timer = null; void this.render(); }, 250);
	}

	async onClose(): Promise<void> {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = null;
	}

	/** What this pane last drew. Typing in a document creates a file per row,
	 *  so without this every keystroke rebuilt the pane — the same bug the
	 *  combined panel had. */
	private lastSignature = "";

	/** Call at the top of render() with a cheap description of what will be
	 *  drawn. Returns false when nothing changed and the pane should bail. */
	protected shouldRedraw(signature: string): boolean {
		if (signature === this.lastSignature && this.contentEl.firstChild) return false;
		this.lastSignature = signature;
		return true;
	}

	/** Forget the last signature, so the next render definitely rebuilds. */
	protected invalidate(): void { this.lastSignature = ""; }

	/** Rebuilding resets scroll; put it back. */
	protected keepScroll(body: () => void): void {
		const scroller = this.contentEl.closest(".view-content") ?? this.contentEl;
		const top = scroller.scrollTop;
		body();
		scroller.scrollTop = top;
	}

	/** A live filter for a pane's rows. Kept in the pane rather than the
	 *  settings, because a filter is a thing you do for a moment. Filtering is
	 *  applied to the ROWS after they are drawn, so every pane gets it without
	 *  each one reimplementing its own search. */
	protected filterQuery = "";

	protected addFilter(el: HTMLElement, placeholder: string): void {
		const input = el.createEl("input", { type: "search", cls: "trynalist-pane-filter" });
		input.placeholder = placeholder;
		input.value = this.filterQuery;
		input.addEventListener("input", () => {
			this.filterQuery = input.value;
			this.applyFilter();
		});
		// Escape clears rather than closing anything — there is nothing to close.
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			input.value = "";
			this.filterQuery = "";
			this.applyFilter();
		});
		// Re-apply after a redraw, or a filtered pane would silently fill back up.
		window.setTimeout(() => this.applyFilter(), 0);
	}

	/** Hide rows that do not match. Counts in section heads are left alone —
	 *  they describe what exists, not what is showing. */
	protected applyFilter(): void {
		const q = this.filterQuery.trim();
		const rows = this.contentEl.findAll(".trynalist-doc-row, .trynalist-group-row");
		let shown = 0;
		for (const row of rows) {
			const match = !q || sift(row.textContent ?? "", q);
			row.toggle(match);
			if (match) shown++;
		}
		let empty = this.contentEl.querySelector<HTMLElement>(".trynalist-filter-empty");
		if (q && shown === 0) {
			if (!empty) {
				empty = this.contentEl.createDiv({ cls: "trynalist-panel-empty trynalist-filter-empty" });
			}
			empty.setText(`Nothing matches "${q}".`);
		} else {
			empty?.remove();
		}
	}

	/** Every individual pane gets a way back to the combined panel, so the
	 *  split is navigable in both directions rather than a one-way door. */
	protected paneHeader(el: HTMLElement, title: string, count?: number): HTMLElement {
		const header = el.createDiv({ cls: "trynalist-panel-header" });
		header.createSpan({
			cls: "trynalist-panel-title",
			text: count === undefined ? title : `${title} (${count})`,
		});
		const actions = header.createDiv({ cls: "trynalist-panel-actions" });
		const back = actions.createEl("button", { cls: "trynalist-panel-new" });
		setIcon(back, "list-tree");   // same icon the combined panel uses
		back.setAttribute("aria-label", "Back to the combined panel");
		back.addEventListener("click", () => void this.plugin.openPanel());
		return actions;
	}

	abstract render(): Promise<void>;
}

/** My files: the document tree, nothing else. */
export class FilesPane extends TrynalistPane {
	getViewType(): string { return FILES_VIEW_TYPE; }
	getDisplayText(): string { return "My files"; }
	getIcon(): string { return "folder"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		const tree = await scanDocs(this.app, this.plugin.settings.rootFolder);
		// Structure only — an item count changing inside a document is not a
		// reason to rebuild the file tree.
		const sig = tree ? describeTree(tree) : "none";
		if (!this.shouldRedraw(sig)) return;
		this.keepScroll(() => {
		el.empty();
		el.addClass("trynalist-panel");
		this.paneHeader(el, "My files", tree ? countDocs(tree) : 0);
		this.addFilter(el, "Filter files…");
		if (!tree) {
			el.createDiv({ cls: "trynalist-panel-empty", text: "No Trynalist folder yet." });
			return;
		}
		const list = el.createDiv({ cls: "trynalist-doc-list" });
		const walk = (group: DocGroup, depth: number) => {
			for (const sub of group.groups) {
				const row = list.createDiv({ cls: "trynalist-group-row" });
				row.style.paddingLeft = `${depth * 14}px`;
				const icon = row.createSpan({ cls: "trynalist-row-icon" });
				setIcon(icon, "folder");
				row.createSpan({ cls: "trynalist-group-name", text: sub.folder.name });
				walk(sub, depth + 1);
			}
			for (const doc of group.docs) {
				if (doc.manifest.archived) continue;
				const row = list.createDiv({ cls: "trynalist-doc-row" });
				row.style.paddingLeft = `${depth * 14 + 4}px`;
				const icon = row.createSpan({ cls: "trynalist-row-icon" });
				setIcon(icon, "file-text");
				row.createSpan({ cls: "trynalist-doc-name", text: doc.manifest.title });
				row.addEventListener("click", () => void this.plugin.openDoc(doc));
			}
		};
		walk(tree, 0);
		});
	}
}

/** Bookmarks, on their own. */
export class BookmarksPane extends TrynalistPane {
	getViewType(): string { return BOOKMARKS_VIEW_TYPE; }
	getDisplayText(): string { return "Bookmarks"; }
	getIcon(): string { return "bookmark"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		const bookmarks = this.plugin.settings.bookmarks;
		if (!this.shouldRedraw(bookmarks.map((b) => `${b.id}/${b.label}`).join(","))) return;
		el.empty();
		el.addClass("trynalist-panel");
		this.paneHeader(el, "Bookmarks", bookmarks.length);
		this.addFilter(el, "Filter bookmarks…");
		if (!bookmarks.length) {
			el.createDiv({
				cls: "trynalist-panel-empty",
				text: "No bookmarks yet. Use “Bookmark this view” in a document to save where you are.",
			});
			return;
		}
		const list = el.createDiv({ cls: "trynalist-doc-list" });
		for (const bm of bookmarks) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			const icon = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(icon, bm.query ? "search" : "bookmark");
			row.createSpan({ cls: "trynalist-doc-name", text: bm.label });
			row.addEventListener("click", () => void this.plugin.openBookmark(bm));
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("Remove bookmark").setIcon("trash").onClick(async () => {
					this.plugin.settings.bookmarks = this.plugin.settings.bookmarks.filter((b) => b.id !== bm.id);
					await this.plugin.saveSettings();
					this.schedule();
					this.plugin.refreshPanels();
				}));
				menu.showAtMouseEvent(e);
			});
		}
	}
}

export interface TagCount { tag: string; count: number; docs: Set<string> }

/** Every #tag and @tag across every document, with a count. Dynalist's tag
 *  pane was Pro-only; ours reads the same text the renderer already parses. */
export async function collectTags(app: TrynalistPane["app"], rootFolder: string): Promise<TagCount[]> {
	const docs: DocRef[] = await listDocs(app, rootFolder);
	const counts = new Map<string, TagCount>();
	const TAG_RE = /(?:^|\s)([#@][\w/-]+)/g;
	for (const doc of docs) {
		const index = await loadReadOnlyIndex(app, doc);
		for (const node of index.nodes.values()) {
			for (const m of `${node.text} ${node.note}`.matchAll(TAG_RE)) {
				const tag = m[1];
				const entry = counts.get(tag) ?? { tag, count: 0, docs: new Set<string>() };
				entry.count++;
				entry.docs.add(doc.manifest.title);
				counts.set(tag, entry);
			}
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export class TagsPane extends TrynalistPane {
	private query = "";
	private tags: TagCount[] = [];
	private scanned = false;
	private scanning: Promise<TagCount[]> | null = null;
	private staleTimer: number | null = null;

	async onOpen(): Promise<void> {
		await super.onOpen();
		// New tags used to appear only after pressing Rescan (L39). A full scan
		// reads every item file, so it waits for 30 s of quiet after the last
		// change under the root, and only runs while this pane is on screen.
		const inRoot = (path: string) => path.startsWith(`${this.plugin.settings.rootFolder}/`);
		this.registerEvent(this.app.metadataCache.on("changed", (f) => {
			if (!inRoot(f.path) || this.plugin.isImporting()) return;
			if (this.staleTimer) window.clearTimeout(this.staleTimer);
			this.staleTimer = window.setTimeout(() => {
				this.staleTimer = null;
				if (!this.containerEl.isShown()) { this.scanned = false; return; }
				this.scanned = false;
				this.invalidate();
				void this.render();
			}, 30_000);
		}));
	}

	async onClose(): Promise<void> {
		if (this.staleTimer) window.clearTimeout(this.staleTimer);
		this.staleTimer = null;
		await super.onClose();
	}

	getViewType(): string { return TAGS_VIEW_TYPE; }
	getDisplayText(): string { return "Tags"; }
	getIcon(): string { return "hash"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("trynalist-panel");
		const actions = this.paneHeader(el, "Tags", this.tags.length);
		const refresh = actions.createEl("button", { cls: "trynalist-panel-new" });
		setIcon(refresh, "refresh-cw");
		refresh.setAttribute("aria-label", "Rescan");
		refresh.addEventListener("click", () => { this.tags = []; this.scanned = false; void this.render(); });

		const filter = el.createEl("input", { type: "search", placeholder: "Filter tags…" });
		filter.value = this.query;
		filter.addEventListener("input", () => { this.query = filter.value; this.paint(el); });

		// "Scanned" is its own flag: an empty list used to mean "not scanned
		// yet", so a vault with no tags re-read every item file on every panel
		// refresh (M62). Overlapping renders share one scan.
		if (!this.scanned) {
			el.createDiv({ cls: "trynalist-suggest-trail", text: "Reading documents…" });
			try {
				this.scanning ??= collectTags(this.app, this.plugin.settings.rootFolder);
				this.tags = await this.scanning;
				this.scanned = true;
			} catch (e) {
				console.error("Trynalist: tag scan failed", e);
			} finally {
				this.scanning = null;
			}
		}
		this.paint(el);
	}

	private paint(el: HTMLElement): void {
		el.findAll(".trynalist-tag-list, .trynalist-suggest-trail, .trynalist-panel-empty")
			.forEach((n) => n.remove());
		const rows = this.tags.filter((t) => sift(t.tag, this.query));
		if (!rows.length) {
			el.createDiv({
				cls: "trynalist-panel-empty",
				text: this.tags.length ? "No tag matches." : "No tags found yet.",
			});
			return;
		}
		const list = el.createDiv({ cls: "trynalist-doc-list trynalist-tag-list" });
		for (const entry of rows) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			const icon = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(icon, entry.tag.startsWith("@") ? "at-sign" : "hash");
			row.createSpan({ cls: "trynalist-doc-name", text: entry.tag });
			row.createSpan({ cls: "trynalist-doc-count", text: String(entry.count) });
			row.setAttribute("aria-label", `${entry.count} in ${entry.docs.size} document(s)`);
			row.addEventListener("click", () => {
				// A tag usually means something inside the document you are in;
				// widening to the whole vault is the deliberate second step,
				// offered from the context menu.
				this.plugin.searchOpenDoc(entry.tag);
			});
			// Right-click was falling through to the click handler, so a tag
			// could only ever do one thing.
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("Search the open document").setIcon("file-search")
					.onClick(() => this.plugin.searchOpenDoc(entry.tag)));
				menu.addItem((i) => i.setTitle("Search every document").setIcon("search")
					.onClick(() => this.plugin.searchEverywhere(entry.tag)));
				menu.addSeparator();
				menu.addItem((i) => i.setTitle(`Copy "${entry.tag}"`).setIcon("clipboard-copy")
					.onClick(() => void navigator.clipboard.writeText(entry.tag)));
				menu.addItem((i) => i
					.setTitle(`In ${entry.docs.size} document${entry.docs.size === 1 ? "" : "s"}`)
					.setIcon("info").setDisabled(true));
				menu.showAtMouseEvent(e);
			});
		}
	}
}

/** Structure of the document tree, WITHOUT per-document item counts — those
 *  change on every keystroke and are not a reason to redraw a file list. */
export function describeTree(group: DocGroup): string {
	const parts: string[] = [];
	const walk = (g: DocGroup) => {
		parts.push(`g:${g.folder.path}`);
		for (const d of g.docs) parts.push(`d:${d.file.path}:${d.manifest.title}:${d.manifest.archived ? 1 : 0}`);
		for (const b of g.broken) parts.push(`b:${b.path}`);
		g.groups.forEach(walk);
	};
	walk(group);
	return parts.join("|");
}

export function countDocs(group: DocGroup, includeArchived = false): number {
	let n = group.docs.filter((d) => includeArchived || !d.manifest.archived).length;
	for (const g of group.groups) n += countDocs(g, includeArchived);
	return n;
}

export function collectArchivedDocs(group: DocGroup): DocRef[] {
	const out: DocRef[] = [];
	const walk = (g: DocGroup) => {
		out.push(...g.docs.filter((d) => d.manifest.archived));
		g.groups.forEach(walk);
	};
	walk(group);
	return out.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
}

/** Recently opened documents, on their own. */
export class RecentPane extends TrynalistPane {
	getViewType(): string { return RECENT_VIEW_TYPE; }
	getDisplayText(): string { return "Recent"; }
	getIcon(): string { return "clock"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		const files = this.plugin.settings.recentDocs
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((f): f is TFile => f instanceof TFile);
		if (!this.shouldRedraw(files.map((f) => f.path).join(","))) return;
		el.empty();
		el.addClass("trynalist-panel");
		this.paneHeader(el, "Recent", files.length);
		this.addFilter(el, "Filter recent…");
		if (!files.length) {
			el.createDiv({ cls: "trynalist-panel-empty", text: "Nothing opened yet." });
			return;
		}
		const list = el.createDiv({ cls: "trynalist-doc-list" });
		for (const file of files) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			setIcon(row.createSpan({ cls: "trynalist-row-icon" }), "clock");
			row.createSpan({ cls: "trynalist-doc-name", text: file.basename });
			row.addEventListener("click", () => void this.plugin.openDocFile(file));
		}
	}
}

/** Overdue / today / coming up, on its own. */
export class AgendaPane extends TrynalistPane {
	getViewType(): string { return AGENDA_VIEW_TYPE; }
	getDisplayText(): string { return "Agenda"; }
	getIcon(): string { return "calendar-clock"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		let items: DueItem[] = [];
		try { items = await this.plugin.agenda(); }
		catch (e) { console.error("Trynalist: agenda failed", e); }
		if (!this.shouldRedraw(items.map((i) => `${i.itemId}@${i.due}`).join(","))) return;
		el.empty();
		el.addClass("trynalist-panel");
		this.paneHeader(el, "Agenda", items.length);
		this.addFilter(el, "Filter agenda…");
		if (!items.length) {
			el.createDiv({ cls: "trynalist-panel-empty", text: "Nothing due." });
			return;
		}
		const today = window.moment().endOf("day");
		const buckets: Array<[string, DueItem[]]> = [
			["Overdue", items.filter((i) => i.overdue)],
			["Today", items.filter((i) => !i.overdue && window.moment(i.due).isSameOrBefore(today))],
			["Coming up", items.filter((i) => !i.overdue && window.moment(i.due).isAfter(today))],
		];
		const list = el.createDiv({ cls: "trynalist-doc-list" });
		for (const [label, group] of buckets) {
			if (!group.length) continue;
			list.createDiv({ cls: "trynalist-agenda-bucket", text: `${label} — ${group.length}` });
			for (const item of group) {
				const row = list.createDiv({
					cls: item.overdue ? "trynalist-doc-row trynalist-agenda-row is-overdue" : "trynalist-doc-row trynalist-agenda-row",
				});
				setIcon(row.createSpan({ cls: "trynalist-row-icon" }), item.overdue ? "alert-circle" : "calendar-clock");
				const body = row.createDiv({ cls: "trynalist-agenda-body" });
				body.createDiv({ cls: "trynalist-doc-name", text: item.text || "(empty item)" });
				body.createDiv({
					cls: "trynalist-suggest-trail",
					text: `${describeDue(item, this.plugin.settings)} · ${item.docTitle}`,
				});
				row.addEventListener("click", () => {
					const file = this.app.vault.getAbstractFileByPath(item.docPath);
					if (file instanceof TFile) void this.plugin.openDocFile(file, item.itemId);
				});
			}
		}
	}
}

/** Archived documents, on their own. */
export class ArchivePane extends TrynalistPane {
	getViewType(): string { return ARCHIVE_VIEW_TYPE; }
	getDisplayText(): string { return "Archived"; }
	getIcon(): string { return "archive"; }

	async render(): Promise<void> {
		const el = this.contentEl;
		const tree = await scanDocs(this.app, this.plugin.settings.rootFolder);
		const docs = tree ? collectArchivedDocs(tree) : [];
		if (!this.shouldRedraw(docs.map((d) => d.file.path).join(","))) return;
		el.empty();
		el.addClass("trynalist-panel");
		this.paneHeader(el, "Archived", docs.length);
		this.addFilter(el, "Filter archived…");
		if (!docs.length) {
			el.createDiv({ cls: "trynalist-panel-empty", text: "Nothing archived." });
			return;
		}
		const list = el.createDiv({ cls: "trynalist-doc-list" });
		for (const doc of docs) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			setIcon(row.createSpan({ cls: "trynalist-row-icon" }), "archive");
			row.createSpan({ cls: "trynalist-doc-name", text: doc.manifest.title });
			row.addEventListener("click", () => void this.plugin.openDoc(doc));
		}
	}
}

export function paneUnavailable(): void {
	new Notice("Trynalist: that pane is not open.");
}
