import { ItemView, Menu, Modal, Notice, Setting, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import type TrynalistPlugin from "./main";
import { ConfirmModal, PromptModal } from "./modals";
import { createDoc, duplicateDoc, renameDoc, scanDocs, setDocArchived } from "./store";
import type { DocGroup } from "./store";
import type { DocRef } from "./types";
import { describeDue } from "./reminders";
import type { DueItem } from "./reminders";
import { DOC_EXTENSION, PANEL_VIEW_TYPE, isReservedFolderName } from "./types";
import { newId, safeName } from "./id-service";
import { parseImport, writeImport } from "./import";
import { openTrash } from "./trash";
import {
	AGENDA_VIEW_TYPE, ARCHIVE_VIEW_TYPE, BOOKMARKS_VIEW_TYPE, FILES_VIEW_TYPE,
	PANE_TYPES, RECENT_VIEW_TYPE, TAGS_VIEW_TYPE, countDocs,
} from "./panels";

/** Icons for the pane launcher row, keyed by view type. */
const PANE_ICONS: Record<string, string> = {
	[FILES_VIEW_TYPE]: "folder",
	[BOOKMARKS_VIEW_TYPE]: "bookmark",
	[TAGS_VIEW_TYPE]: "hash",
	[RECENT_VIEW_TYPE]: "clock",
	[AGENDA_VIEW_TYPE]: "calendar-clock",
	[ARCHIVE_VIEW_TYPE]: "archive",
};

/** Every folder a document (or another folder) can be created in: the root and
 *  each grouping folder under it. Document folders themselves are excluded —
 *  nesting a document inside a document is what the integrity check complains
 *  about. */
function groupFolders(app: TrynalistPanelView["app"], rootFolder: string): string[] {
	const out: string[] = [rootFolder];
	const root = app.vault.getFolderByPath(rootFolder);
	if (!root) return out;
	const walk = (folder: TFolder) => {
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			// A folder holding a manifest IS a document, not a group.
			const isDoc = child.children.some(
				(c) => c instanceof TFile && c.extension === DOC_EXTENSION,
			);
			if (isDoc || child.name.startsWith("_")) continue;
			out.push(child.path);
			walk(child);
		}
	};
	walk(root);
	// Dedupe: a vault can legitimately produce the same path twice if the root
	// is also reachable as a child, and a repeated option looks like a bug.
	return [...new Set(out)];
}

/** New grouping folder, with a choice of where it goes — so a folder can be
 *  made a subfolder of an existing one rather than always landing at the top. */
class NewFolderModal extends Modal {
	constructor(
		private plugin: TrynalistPlugin,
		private onSubmit: (parent: string, name: string) => void,
	) {
		super(plugin.app);
	}
	onOpen(): void {
		let name = "";
		let parent = this.plugin.settings.rootFolder;
		this.setTitle("New folder");
		this.modalEl.addClass("trynalist-compact-modal");
		new Setting(this.contentEl).setName("Folder name").addText((t) => {
			t.onChange((v) => (name = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); submit(); }
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).setName("Inside").addDropdown((d) => {
			for (const path of groupFolders(this.app, this.plugin.settings.rootFolder)) {
				d.addOption(path, path === this.plugin.settings.rootFolder
					? "(top level)"
					: path.slice(this.plugin.settings.rootFolder.length + 1));
			}
			d.setValue(parent);
			d.onChange((v) => (parent = v));
		});
		const submit = () => {
			// Path separators and the rest would silently create nesting or fail
			// on some filesystems; fold them to a dash. safeName also refuses
			// `..` (the parent folder) and leading dots (hidden from Obsidian).
			const clean = safeName(name, "");
			if (!clean) return;
			if (isReservedFolderName(clean)) { new Notice(`Trynalist: "${clean}" is a reserved folder name.`); return; }
			this.close();
			this.onSubmit(parent, clean);
		};
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Create").setCta().onClick(submit),
		);
	}
	onClose(): void { this.contentEl.empty(); }
}

class NewDocModal extends Modal {
	/** targetFolder: vault path the doc folder is created under (a grouping
	 *  folder, or the root). */
	constructor(
		private plugin: TrynalistPlugin,
		private targetFolder: string,
		private onDone: () => void,
	) {
		super(plugin.app);
	}
	onOpen(): void {
		let title = "";
		let folder = this.targetFolder;
		this.setTitle("New document");
		this.modalEl.addClass("trynalist-compact-modal");
		new Setting(this.contentEl).setName("Title").addText((t) => {
			t.onChange((v) => (title = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); void submit(); }
			});
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		// Where it goes. Defaults to wherever the modal was opened from, so the
		// + on a grouping folder still does the obvious thing.
		new Setting(this.contentEl).setName("In folder").addDropdown((d) => {
			for (const path of groupFolders(this.app, this.plugin.settings.rootFolder)) {
				d.addOption(path, path === this.plugin.settings.rootFolder ? "(top level)" : path.slice(this.plugin.settings.rootFolder.length + 1));
			}
			d.setValue(folder);
			d.onChange((v) => (folder = v));
		});
		const submit = async () => {
			if (!title.trim()) return;
			this.close();
			try {
				const ref = await createDoc(this.app, folder, title.trim());
				this.onDone();
				await this.plugin.openDoc(ref);
			} catch (e) {
				console.error("Trynalist: could not create the document", e);
				new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		};
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Create").setCta().onClick(() => void submit()),
		);
	}
}

export class TrynalistPanelView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: TrynalistPlugin) {
		super(leaf);
	}

	getViewType(): string { return PANEL_VIEW_TYPE; }
	getDisplayText(): string { return "Trynalist"; }
	getIcon(): string { return "list-tree"; }

	async onOpen(): Promise<void> {
		await this.render();
		// Re-list when files inside the root folder change.
		const inRoot = (path: string) =>
			path.startsWith(this.plugin.settings.rootFolder + "/");
		this.registerEvent(this.app.vault.on("create", (f) => { if (inRoot(f.path) && !this.plugin.isImporting()) this.scheduleRender(); }));
		this.registerEvent(this.app.vault.on("delete", (f) => { if (inRoot(f.path) && !this.plugin.isImporting()) this.scheduleRender(); }));
		this.registerEvent(this.app.vault.on("rename", (f, old) => { if ((inRoot(f.path) || inRoot(old)) && !this.plugin.isImporting()) this.scheduleRender(); }));
	}

	private renderTimer: number | null = null;
	private scheduleRender(): void {
		if (this.renderTimer) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => { this.renderTimer = null; void this.render(); }, 250);
	}

	async onClose(): Promise<void> {
		// A render queued just before the pane closed would scan the vault into a
		// detached element.
		if (this.renderTimer) window.clearTimeout(this.renderTimer);
		this.renderTimer = null;
	}

	/** What the panel last drew, so a vault event that changes nothing visible
	 *  doesn't rebuild the list under the cursor. Typing in a document fires a
	 *  create event for every new row, and rebuilding on each one is what made
	 *  the panel flicker while editing. */
	private lastSignature = "";

	/** A section head that collapses, remembers, and can launch its own pane. */
	private sectionHead(
		host: HTMLElement,
		key: string,
		label: string,
		count: number,
		paneType?: string,
	): boolean {
		const collapsed = this.plugin.settings.collapsedSections.includes(key);
		const head = host.createDiv({ cls: "trynalist-panel-section trynalist-section-head" });
		const tri = head.createSpan({ cls: "trynalist-group-tri" });
		setIcon(tri, collapsed ? "chevron-right" : "chevron-down");
		head.createSpan({ cls: "trynalist-section-label", text: label });
		head.createSpan({ cls: "trynalist-section-count", text: String(count) });
		if (paneType) {
			const open = head.createSpan({ cls: "trynalist-row-action" });
			setIcon(open, "panel-left");
			open.setAttribute("aria-label", `Open the ${label} pane`);
			open.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.revealPane(paneType);
			});
		}
		head.addEventListener("click", () => {
			const set = new Set(this.plugin.settings.collapsedSections);
			if (collapsed) set.delete(key); else set.add(key);
			this.plugin.settings.collapsedSections = [...set];
			void this.plugin.saveSettings();
			this.lastSignature = "";
			void this.render();
		});
		return !collapsed;
	}

	async render(): Promise<void> {
		const el = this.contentEl;

		let tree: DocGroup | null = null;
		try {
			tree = await scanDocs(this.app, this.plugin.settings.rootFolder);
		} catch (e) {
			console.error("Trynalist: doc listing failed", e);
		}

		// The agenda has to be read before the comparison, or a changed due date
		// would be judged "nothing new" and then never drawn.
		let due: DueItem[] = [];
		if (this.plugin.settings.showAgenda) {
			try { due = await this.plugin.agenda(); }
			catch (e) { console.error("Trynalist: agenda failed", e); }
		}
		this.agendaSignature = due.map((i) => `${i.itemId}@${i.due}`).join(",");

		// Scan first, compare, and only rebuild when something visible actually
		// changed. Editing a document creates a file per row, and each of those
		// used to redraw the whole panel.
		const signature = this.signatureOf(tree);
		if (signature === this.lastSignature && el.firstChild) { this.patchCounts(); return; }
		this.lastSignature = signature;
		this.countEls.clear();

		// Rebuilding throws the list back to the top, which is what made
		// collapsing "Archived" jump. Put the scroll back where it was.
		const scroller = el.closest(".view-content") ?? el;
		const scrollTop = scroller.scrollTop;
		el.empty();
		el.addClass("trynalist-panel");

		const header = el.createDiv({ cls: "trynalist-panel-header" });
		header.createSpan({ text: "Documents", cls: "trynalist-panel-title" });
		// Grouped, so the two actions sit together rather than being pushed to
		// opposite ends by the header's space-between.
		const actions = header.createDiv({ cls: "trynalist-panel-actions" });
		const attachBtn = actions.createEl("button", { cls: "trynalist-panel-new" });
		setIcon(attachBtn, "paperclip");
		attachBtn.setAttribute("aria-label", "Attachments");
		attachBtn.addEventListener("click", () => this.plugin.openAttachments());
		const trashBtn = actions.createEl("button", { cls: "trynalist-panel-new" });
		setIcon(trashBtn, "trash-2");
		trashBtn.setAttribute("aria-label", "Trash");
		trashBtn.addEventListener("click", () => openTrash(this.app, this.plugin.settings.rootFolder, (into) => {
			this.scheduleRender();
			if (into) void this.plugin.reloadDocViews(into);
		}));
		const newBtn = actions.createEl("button", { cls: "trynalist-panel-new" });
		setIcon(newBtn, "plus");
		newBtn.setAttribute("aria-label", "New document, folder or import");
		// Three ways to add something, behind one button. A sidebar header has
		// no room for three side by side, and a menu keeps each one labelled
		// and iconed rather than guessable from a glyph.
		newBtn.addEventListener("click", (e) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("New document").setIcon("file-plus").onClick(() =>
				new NewDocModal(this.plugin, this.plugin.settings.rootFolder, () => this.scheduleRender()).open(),
			));
			menu.addItem((i) => i.setTitle("New folder").setIcon("folder-plus").onClick(() => {
				new NewFolderModal(this.plugin, (parent, clean) => {
					void (async () => {
						const path = `${parent}/${clean}`;
						if (this.app.vault.getAbstractFileByPath(path)) {
							new Notice(`Trynalist: "${clean}" already exists.`);
							return;
						}
						await this.app.vault.createFolder(path);
						this.lastSignature = "";
						this.scheduleRender();
						new Notice(`Trynalist: created the folder "${clean}".`);
					})();
				}).open();
			}));
			menu.addItem((i) => i.setTitle("Import from OPML…").setIcon("upload").onClick(() => {
				void this.importOpml();
			}));
			menu.showAtMouseEvent(e);
		});

		const launcher = el.createDiv({ cls: "trynalist-pane-launcher" });
		launcher.createSpan({ cls: "trynalist-suggest-trail", text: "Open as pane:" });
		for (const [type, label] of PANE_TYPES) {
			const btn = launcher.createEl("button", { cls: "trynalist-pane-launch" });
			setIcon(btn, PANE_ICONS[type] ?? "panel-left");
			btn.setAttribute("aria-label", label);
			btn.addEventListener("click", () => void this.plugin.revealPane(type));
		}

		if (!tree || (!tree.docs.length && !tree.groups.length && !tree.broken.length)) {
			el.createDiv({
				cls: "trynalist-panel-empty",
				text: `No documents yet. Create one — it lives as a folder under "${this.plugin.settings.rootFolder}/".`,
			});
			return;
		}
		this.renderAgenda(el, due);
		this.renderBookmarks(el);
		this.renderRecents(el);
		if (this.sectionHead(el, "docs", "All documents", countDocs(tree), FILES_VIEW_TYPE)) {
			this.renderGroupInto(el.createDiv({ cls: "trynalist-doc-list" }), tree, 0);
		}

		const archived = this.collectArchived(tree);
		if (archived.length && this.sectionHead(el, "archived", "Archived", archived.length, ARCHIVE_VIEW_TYPE)) {
			const list = el.createDiv({ cls: "trynalist-doc-list" });
			for (const doc of archived) this.renderDocRow(list, doc, 0);
		}
		scroller.scrollTop = scrollTop;
	}

	/** Everything the panel draws EXCEPT the per-document item counts. Counts
	 *  change on every new row, so they are patched in place instead — that is
	 *  the difference between a badge ticking over and the list rebuilding. */
	private signatureOf(tree: DocGroup | null): string {
		if (!tree) return "none";
		const parts: string[] = [];
		const walk = (g: DocGroup) => {
			parts.push(`g:${g.folder.path}`);
			for (const d of g.docs) parts.push(`d:${d.file.path}:${d.manifest.title}:${d.manifest.archived ? 1 : 0}`);
			for (const b of g.broken) parts.push(`b:${b.path}`);
			g.groups.forEach(walk);
		};
		walk(tree);
		parts.push(`c:${[...this.collapsedGroups].sort().join(",")}`);
		parts.push(`s:${[...this.plugin.settings.collapsedSections].sort().join(",")}`);
		parts.push(`m:${this.plugin.settings.bookmarks.map((b) => `${b.id}/${b.label}`).join(",")}`);
		parts.push(`r:${this.plugin.settings.recentDocs.join(",")}`);
		parts.push(`a:${this.agendaSignature}`);
		return parts.join("|");
	}

	/** Set by renderAgenda, so a changed due date still redraws the panel. */
	private agendaSignature = "";

	/** Item counts, patched without touching the rest of the DOM. */
	private countEls = new Map<string, HTMLElement>();

	private patchCounts(): void {
		for (const [path, el] of this.countEls) {
			if (!el.isConnected) { this.countEls.delete(path); continue; }
			const folder = this.app.vault.getAbstractFileByPath(path);
			if (!(folder instanceof TFolder)) continue;
			const n = folder.children.filter((c) => c instanceof TFile && c.extension === "md").length;
			const text = String(n);
			if (el.getText() !== text) el.setText(text);
		}
	}

	private collectArchived(group: DocGroup): DocRef[] {
		const out: DocRef[] = [];
		const walk = (g: DocGroup) => {
			out.push(...g.docs.filter((d) => d.manifest.archived));
			g.groups.forEach(walk);
		};
		walk(group);
		return out.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
	}

	/** Overdue / today / this week, from the due dates in frontmatter. */
	private renderAgenda(host: HTMLElement, items: DueItem[]): void {
		if (!items.length) return;
		const today = window.moment().endOf("day");
		const buckets: Array<[string, DueItem[]]> = [
			["Overdue", items.filter((i) => i.overdue)],
			["Today", items.filter((i) => !i.overdue && window.moment(i.due).isSameOrBefore(today))],
			["Coming up", items.filter((i) => !i.overdue && window.moment(i.due).isAfter(today))],
		];
		if (!this.sectionHead(host, "agenda", "Agenda", items.length, AGENDA_VIEW_TYPE)) return;
		const list = host.createDiv({ cls: "trynalist-doc-list" });
		for (const [label, group] of buckets) {
			if (!group.length) continue;
			const key = `agenda:${label}`;
			const folded = this.plugin.settings.collapsedSections.includes(key);
			const bucket = list.createDiv({ cls: "trynalist-agenda-bucket" });
			const btri = bucket.createSpan({ cls: "trynalist-group-tri" });
			setIcon(btri, folded ? "chevron-right" : "chevron-down");
			bucket.createSpan({ text: `${label} — ${group.length}` });
			bucket.addEventListener("click", () => {
				const set = new Set(this.plugin.settings.collapsedSections);
				if (folded) set.delete(key); else set.add(key);
				this.plugin.settings.collapsedSections = [...set];
				void this.plugin.saveSettings();
				this.lastSignature = "";
				void this.render();
			});
			if (folded) continue;
			for (const item of group.slice(0, 12)) {
				const row = list.createDiv({
					cls: item.overdue ? "trynalist-doc-row trynalist-agenda-row is-overdue" : "trynalist-doc-row trynalist-agenda-row",
				});
				const ic = row.createSpan({ cls: "trynalist-row-icon" });
				setIcon(ic, item.overdue ? "alert-circle" : "calendar-clock");
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
				const snooze = row.createSpan({ cls: "trynalist-row-action" });
				setIcon(snooze, "alarm-clock-off");
				snooze.setAttribute("aria-label", `Snooze ${this.plugin.settings.snoozeMinutes} minutes`);
				snooze.addEventListener("click", (e) => {
					e.stopPropagation();
					void this.plugin.snooze(item).then(() => this.scheduleRender());
				});
			}
			if (group.length > 12) {
				list.createDiv({ cls: "trynalist-suggest-trail", text: `…and ${group.length - 12} more` });
			}
		}
	}

	private renderBookmarks(host: HTMLElement): void {
		const bookmarks = this.plugin.settings.bookmarks;
		if (!bookmarks.length) return;
		if (!this.sectionHead(host, "bookmarks", "Bookmarks", bookmarks.length, BOOKMARKS_VIEW_TYPE)) return;
		const list = host.createDiv({ cls: "trynalist-doc-list" });
		for (const bm of bookmarks) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			const ic = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(ic, bm.query ? "search" : "bookmark");
			row.createSpan({ cls: "trynalist-doc-name", text: bm.label });
			if (bm.query) row.createSpan({ cls: "trynalist-doc-count", text: "search" });
			row.addEventListener("click", () => void this.plugin.openBookmark(bm));
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("Rename bookmark").setIcon("pencil").onClick(() => {
					new PromptModal(this.app, {
						title: "Rename bookmark",
						label: "Name",
						initial: bm.label,
						cta: "Rename",
						onSubmit: async (value) => {
							bm.label = value;
							await this.plugin.saveSettings();
							this.scheduleRender();
						},
					}).open();
				}));
				menu.addItem((i) => i.setTitle("Remove bookmark").setIcon("trash").onClick(async () => {
					this.plugin.settings.bookmarks = this.plugin.settings.bookmarks.filter((b) => b.id !== bm.id);
					await this.plugin.saveSettings();
					this.scheduleRender();
					new Notice(`Trynalist: removed bookmark "${bm.label}".`);
				}));
				menu.showAtMouseEvent(e);
			});
		}
	}

	private renderRecents(host: HTMLElement): void {
		const recents = this.plugin.settings.recentDocs
			.map((path) => this.app.vault.getAbstractFileByPath(path))
			.filter((f): f is TFile => f instanceof TFile);
		if (!recents.length) return;
		if (!this.sectionHead(host, "recent", "Recent", recents.length, RECENT_VIEW_TYPE)) return;
		const list = host.createDiv({ cls: "trynalist-doc-list" });
		for (const file of recents) {
			const row = list.createDiv({ cls: "trynalist-doc-row" });
			const ic = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(ic, "clock");
			row.createSpan({ cls: "trynalist-doc-name", text: file.basename });
			row.addEventListener("click", () => void this.plugin.openDocFile(file));
		}
	}

	/** Grouping folders the user collapsed this session (by vault path). */
	private collapsedGroups = new Set<string>();
	/** Manifest path of the document being dragged in the panel. */
	private draggingDoc: DocRef | null = null;

	private renderDocRow(host: HTMLElement, doc: DocRef, depth: number): void {
		const row = host.createDiv({ cls: "trynalist-doc-row" });
		// Addressable, so "show in panel" can find and flash this exact row.
		row.dataset.path = doc.file.path;
		row.style.paddingLeft = `${depth * 14 + 4}px`;
		const icon = row.createSpan({ cls: "trynalist-row-icon" });
		setIcon(icon, doc.manifest.archived ? "archive" : "file-text");
		row.createSpan({ cls: "trynalist-doc-name", text: doc.manifest.title });
		const count = doc.folder.children.filter(
			(c) => c instanceof TFile && c.extension === "md",
		).length;
		const countEl = row.createSpan({ cls: "trynalist-doc-count", text: String(count) });
		this.countEls.set(doc.folder.path, countEl);
		row.addEventListener("click", () => void this.plugin.openDoc(doc));

		// Drag a document onto a folder row to file it there.
		row.draggable = true;
		row.addEventListener("dragstart", (e) => {
			this.draggingDoc = doc;
			e.dataTransfer?.setData("application/x-trynalist-doc", doc.file.path);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
		});
		row.addEventListener("dragend", () => {
			this.draggingDoc = null;
			this.contentEl.findAll(".is-drop-target").forEach((r) => r.removeClass("is-drop-target"));
		});

		const menuBtn = row.createSpan({ cls: "trynalist-row-action" });
		setIcon(menuBtn, "more-horizontal");
		menuBtn.setAttribute("aria-label", "Document menu");
		const openMenu = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.openDocMenu(e, doc);
		};
		menuBtn.addEventListener("click", openMenu);
		row.addEventListener("contextmenu", openMenu);
	}

	/** A folder row accepts a dragged document and moves its folder inside. */
	private wireFolderDrop(row: HTMLElement, folder: TFolder): void {
		row.addEventListener("dragover", (e) => {
			if (!this.draggingDoc) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
			row.addClass("is-drop-target");
		});
		row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
		row.addEventListener("drop", (e) => {
			const doc = this.draggingDoc;
			row.removeClass("is-drop-target");
			if (!doc) return;
			e.preventDefault();
			e.stopPropagation();
			void this.moveDocToFolder(doc, folder);
		});
	}

	private async moveDocToFolder(doc: DocRef, folder: TFolder): Promise<void> {
		if (doc.folder.parent?.path === folder.path) return;
		if (folder.path === doc.folder.path || folder.path.startsWith(`${doc.folder.path}/`)) {
			new Notice("Trynalist: a document cannot be filed inside itself.");
			return;
		}
		const target = `${folder.path}/${doc.folder.name}`;
		if (this.app.vault.getAbstractFileByPath(target)) {
			new Notice(`Trynalist: "${folder.name}" already contains something called "${doc.folder.name}".`);
			return;
		}
		try {
			await this.app.fileManager.renameFile(doc.folder, target);
			this.scheduleRender();
			new Notice(`Trynalist: moved "${doc.manifest.title}" into ${folder.name}.`);
		} catch (e) {
			console.error(e);
			new Notice("Trynalist: could not move that document — see console.");
		}
	}

	private openDocMenu(e: MouseEvent, doc: DocRef): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Rename document").setIcon("pencil").onClick(() => {
			new PromptModal(this.app, {
				title: "Rename document",
				label: "Document name",
				initial: doc.manifest.title,
				cta: "Rename",
				onSubmit: async (value) => {
					try {
						await renameDoc(this.app, doc, value);
						this.scheduleRender();
					} catch (err) {
						new Notice(`Trynalist: ${err instanceof Error ? err.message : "rename failed"}`);
					}
				},
			}).open();
		}));
		menu.addItem((i) => i.setTitle("Duplicate document").setIcon("copy").onClick(async () => {
			try {
				const copy = await duplicateDoc(this.app, doc, this.plugin.settings.rootFolder);
				this.scheduleRender();
				new Notice(`Trynalist: created "${copy.manifest.title}".`);
			} catch (err) {
				console.error(err);
				new Notice("Trynalist: duplicate failed — see console.");
			}
		}));
		menu.addItem((i) => i
			.setTitle(doc.manifest.archived ? "Unarchive" : "Archive")
			.setIcon("archive")
			.onClick(async () => {
				await setDocArchived(this.app, doc, !doc.manifest.archived);
				// All panes: the separate Files and Archive panes list by the
				// archived flag too and were left stale (L38).
				this.plugin.refreshPanels();
			}));
		menu.addItem((i) => i.setTitle("Export as .trynalist.zip").setIcon("download")
			.onClick(() => void this.plugin.exportDoc(doc)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Delete document").setIcon("trash").onClick(() => {
			new ConfirmModal(this.app, {
				title: `Delete "${doc.manifest.title}"?`,
				body: "The whole document folder goes to the vault trash, so it can be restored from there.",
				cta: "Move to trash",
				warning: true,
				onConfirm: async () => {
					await this.app.fileManager.trashFile(doc.folder);
					this.scheduleRender();
					new Notice(`Trynalist: "${doc.manifest.title}" moved to trash.`);
				},
			}).open();
		}));
		menu.showAtMouseEvent(e);
	}

	/** A manifest we could not read is the one case where the panel cannot do
	 *  anything useful by itself, so the menu is all escape hatches: see the
	 *  actual error, open it in whatever the OS uses, or rebuild it. */
	private openBrokenMenu(e: MouseEvent, file: TFile): void {
		const menu = new Menu();
		// Two very different faults land in the same list. A folder with TWO
		// manifests is not corrupt — the first one won and this is the extra —
		// so rebuilding it would just make a second valid document out of the
		// same folder. Offer the fix that matches the fault.
		const siblings = file.parent
			? file.parent.children.filter((c): c is TFile => c instanceof TFile && c.extension === DOC_EXTENSION)
			: [file];
		const isDuplicate = siblings.length > 1 && siblings[0].path !== file.path;
		if (isDuplicate) {
			menu.addItem((i) => i.setTitle("This is a duplicate manifest").setIcon("info").setDisabled(true));
			menu.addItem((i) => i.setTitle("Make it a separate document…").setIcon("copy").onClick(() => {
				new PromptModal(this.app, {
					title: "Name the second document",
					label: "Folder name",
					initial: `${file.parent?.name ?? file.basename} (copy)`,
					cta: "Create",
					onSubmit: async (value) => {
						// A duplicate manifest is not damage — it is two documents
						// sharing one folder. Give the second its own folder rather
						// than making the user choose between deleting it and
						// living with a warning.
						await this.splitDuplicate(file, value);
					},
				}).open();
			}));
		}
		menu.addItem((i) => i.setTitle("Inspect the error").setIcon("bug").onClick(async () => {
			let detail: string;
			try {
				const raw = await this.app.vault.adapter.read(file.path);
				JSON.parse(raw);
				detail = "The JSON parses. The likely cause is a second .trynalist file in the same folder — a document folder needs exactly one.";
			} catch (err) {
				detail = err instanceof Error ? err.message : String(err);
			}
			new Notice(`Trynalist — ${file.path}\n\n${detail}`, 15000);
			console.error("Trynalist: broken manifest", file.path, detail);
		}));
		menu.addItem((i) => i.setTitle("Open in the system editor").setIcon("external-link").onClick(() => {
			// Whatever the OS has registered; the file is plain JSON.
			void this.hostOpen(file, "open");
		}));
		menu.addItem((i) => i.setTitle("Reveal in the file manager").setIcon("folder-open").onClick(() => {
			void this.hostOpen(file, "reveal");
		}));
		menu.addSeparator();
		if (!isDuplicate) menu.addItem((i) => i.setTitle("Rebuild this manifest").setIcon("wrench").onClick(() => {
			new ConfirmModal(this.app, {
				title: "Rebuild the document manifest?",
				body: `A fresh manifest is written for "${file.parent?.name ?? file.basename}", titled after its folder. `
					+ "The old one is kept beside it as .trynalist.broken, and no item file is touched.",
				cta: "Rebuild",
				onConfirm: async () => {
					try {
						const backup = `${file.path}.broken`;
						if (!this.app.vault.getAbstractFileByPath(backup)) {
							await this.app.vault.adapter.copy(file.path, backup);
						}
						const title = file.parent?.name ?? file.basename;
						const now = new Date().toISOString();
						// A manifest missing `format` is still rejected by the
						// scanner, so the document would stay broken and never
						// appear — write the whole shape, id included.
						await this.app.vault.adapter.write(file.path, JSON.stringify({
							format: "trynalist-doc",
							version: 1,
							id: newId(),
							title,
							created: now,
							modified: now,
						}, null, 2));
						this.lastSignature = "";
						this.scheduleRender();
						new Notice(`Trynalist: rebuilt the manifest for "${title}". The previous one is at ${backup}.`, 8000);
					} catch (err) {
						console.error(err);
						new Notice("Trynalist: could not rebuild that manifest — see console.");
					}
				},
			}).open();
		}));
		menu.addItem((i) => i
			.setTitle(isDuplicate ? "Remove this duplicate manifest" : "Delete this manifest")
			.setIcon("trash").onClick(() => {
			new ConfirmModal(this.app, {
				title: "Move this manifest to trash?",
				body: "Only the .trynalist file goes to the vault trash — the item files stay where they are, "
					+ "so the folder stops being a document but nothing you wrote is lost.",
				cta: "Move to trash",
				warning: true,
				onConfirm: async () => {
					await this.app.fileManager.trashFile(file);
					this.lastSignature = "";
					this.scheduleRender();
				},
			}).open();
		}));
		menu.showAtMouseEvent(e);
	}

	/** Hand a file to the operating system. Neither call is in Obsidian's public
	 *  typings and neither exists on mobile, so both are probed at runtime and
	 *  fall back to putting the full path on the clipboard — which is still a
	 *  way out of a broken document, just a slower one. */
	private async hostOpen(file: TFile, how: "open" | "reveal"): Promise<void> {
		const host = this.app as unknown as {
			openWithDefaultApp?: (path: string) => void;
			showInFolder?: (path: string) => void;
		};
		const fn = how === "open" ? host.openWithDefaultApp : host.showInFolder;
		if (typeof fn === "function") { fn.call(this.app, file.path); return; }
		const base = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
		const full = base ? `${base}/${file.path}` : file.path;
		await navigator.clipboard.writeText(full);
		new Notice(`Trynalist: this platform cannot open files directly. Path copied:\n${full}`, 10000);
	}

	/** Move a duplicate manifest into a folder of its own, so both documents
	 *  are real. No item file moves: the items belong to the FIRST manifest,
	 *  and the new document starts empty rather than stealing them. */
	/** Pick an OPML file from the OS and import it as a new document. Uses a
	 *  hidden file input rather than a vault picker: the whole point is to bring
	 *  in a file that is NOT in the vault yet. */
	private async importOpml(): Promise<void> {
		const input = createEl("input", { type: "file" });
		input.accept = ".opml,.xml,.json,.txt,.md";
		input.addEventListener("change", () => {
			void (async () => {
				const file = input.files?.[0];
				if (!file) return;
				try {
					const text = await file.text();
					const parsed = parseImport(file.name, text);
					if (!parsed.roots.length) {
						new Notice(`Trynalist: found nothing to import in "${file.name}".`);
						return;
					}
					const { doc, items } = await writeImport(this.app, this.plugin.settings.rootFolder, parsed);
					this.lastSignature = "";
					this.scheduleRender();
					// Warnings are surfaced, not swallowed — an import that quietly
					// dropped content would be the worst kind of success.
					const warn = parsed.warnings.length ? ` (${parsed.warnings.length} warning${parsed.warnings.length === 1 ? "" : "s"} — see console)` : "";
					if (parsed.warnings.length) console.warn("Trynalist import warnings", parsed.warnings);
					new Notice(`Trynalist: imported ${items} items as "${doc.manifest.title}"${warn}.`, 8000);
					await this.plugin.openDoc(doc);
				} catch (e) {
					console.error("Trynalist: import failed", e);
					new Notice(`Trynalist: could not import "${file.name}" — see console.`);
				}
			})();
		});
		input.click();
	}

	private async splitDuplicate(file: TFile, folderName: string): Promise<void> {
		const parent = file.parent?.parent?.path ?? this.plugin.settings.rootFolder;
		const clean = safeName(folderName, "");
		if (!clean) return;
		const dest = `${parent}/${clean}`;
		if (this.app.vault.getAbstractFileByPath(dest)) {
			new Notice(`Trynalist: "${clean}" already exists.`);
			return;
		}
		try {
			await this.app.vault.createFolder(dest);
			await this.app.fileManager.renameFile(file, `${dest}/${clean}.${DOC_EXTENSION}`);
			// Its title should match its new home.
			const raw = await this.app.vault.adapter.read(`${dest}/${clean}.${DOC_EXTENSION}`);
			const manifest = JSON.parse(raw) as Record<string, unknown>;
			manifest.title = clean;
			manifest.modified = new Date().toISOString();
			await this.app.vault.adapter.write(`${dest}/${clean}.${DOC_EXTENSION}`, JSON.stringify(manifest, null, 2));
			this.lastSignature = "";
			this.scheduleRender();
			new Notice(`Trynalist: "${clean}" is now its own document. It starts empty — the items stayed with the original.`, 9000);
		} catch (e) {
			console.error(e);
			new Notice("Trynalist: could not split that duplicate — see console.");
		}
	}

	private renderGroupInto(host: HTMLElement, group: DocGroup, depth: number): void {
		for (const sub of group.groups) {
			const collapsed = this.collapsedGroups.has(sub.folder.path);
			const row = host.createDiv({ cls: "trynalist-group-row" });
			row.style.paddingLeft = `${depth * 14}px`;
			const tri = row.createSpan({ cls: "trynalist-group-tri" });
			setIcon(tri, collapsed ? "chevron-right" : "chevron-down");
			const folderIcon = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(folderIcon, collapsed ? "folder" : "folder-open");
			row.createSpan({ cls: "trynalist-group-name", text: sub.folder.name });
			this.wireFolderDrop(row, sub.folder);
			row.addEventListener("click", () => {
				if (collapsed) this.collapsedGroups.delete(sub.folder.path);
				else this.collapsedGroups.add(sub.folder.path);
				this.scheduleRender();
			});
			const add = row.createSpan({ cls: "trynalist-doc-export", text: "+" });
			add.setAttribute("aria-label", "New document in this folder");
			add.addEventListener("click", (e) => {
				e.stopPropagation();
				new NewDocModal(this.plugin, sub.folder.path, () => this.scheduleRender()).open();
			});
			if (!collapsed) this.renderGroupInto(host, sub, depth + 1);
		}
		for (const doc of group.docs) {
			if (doc.manifest.archived) continue;   // shown in its own section
			this.renderDocRow(host, doc, depth);
		}
		for (const file of group.broken) {
			const row = host.createDiv({ cls: "trynalist-doc-row trynalist-doc-broken" });
			row.style.paddingLeft = `${depth * 14 + 4}px`;
			const warn = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(warn, "alert-triangle");
			row.createSpan({ cls: "trynalist-doc-name", text: file.path });
			row.setAttribute("aria-label", "Unreadable or duplicate .trynalist manifest");
			const openBroken = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this.openBrokenMenu(e, file);
			};
			row.addEventListener("click", openBroken);
			row.addEventListener("contextmenu", openBroken);
			const menuBtn = row.createSpan({ cls: "trynalist-row-action" });
			setIcon(menuBtn, "more-horizontal");
			menuBtn.setAttribute("aria-label", "Repair options");
			menuBtn.addEventListener("click", openBroken);
		}
	}
}
