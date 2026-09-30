import { App, ButtonComponent, Modal, Notice, Setting, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { TRASH_FOLDER } from "./types";
import { idToString, listDocs, parseFrontmatterBlock } from "./store";
import { ConfirmModal } from "./modals";

/** Trynalist's own trash — an enhancement over Dynalist, which has none. Deleted
 *  subtrees are moved (by deleteNode) into dated groups under `<root>/_trash`
 *  rather than removed, so they can be restored. Emptying the trash routes the
 *  files through `app.fileManager.trashFile`, which honours the user's Obsidian
 *  trash setting (system trash / vault .trash / permanent) — so there is no
 *  separate destructive path of our own. */

interface TrashInfo {
	docFolder: string;
	docId: string;
	docTitle: string;
	trashedAt: string;
	files: string[];
}

export interface TrashGroup {
	folder: TFolder;
	info: TrashInfo | null;
	itemCount: number;
}

function trashRoot(rootFolder: string): string {
	return normalizePath(`${rootFolder}/${TRASH_FOLDER}`);
}

export async function listTrash(app: App, rootFolder: string): Promise<TrashGroup[]> {
	const root = app.vault.getFolderByPath(trashRoot(rootFolder));
	if (!root) return [];
	// Info files read in parallel, not one await per group (M65).
	const folders = root.children.filter((c): c is TFolder => c instanceof TFolder);
	const groups: TrashGroup[] = await Promise.all(folders.map(async (child) => {
		const infoFile = app.vault.getAbstractFileByPath(`${child.path}/_trashinfo.json`);
		let info: TrashInfo | null = null;
		if (infoFile instanceof TFile) {
			try { info = JSON.parse(await app.vault.cachedRead(infoFile)) as TrashInfo; } catch { info = null; }
		}
		const itemCount = child.children.filter((c) => c instanceof TFile && c.name !== "_trashinfo.json" && c.name.endsWith(".md")).length;
		return { folder: child, info, itemCount };
	}));
	// Newest first.
	groups.sort((a, b) => (b.info?.trashedAt ?? "").localeCompare(a.info?.trashedAt ?? ""));
	return groups;
}

/** Where a group's document lives NOW. Found by the document id recorded at
 *  delete time, so a rename or move since then does not strand the items —
 *  and a new, unrelated document that took the old folder name never
 *  receives them (M33). The recorded path is only a fallback, and only when
 *  its manifest agrees on the id (or no id was recorded). */
async function resolveDocFolder(app: App, rootFolder: string, info: TrashInfo): Promise<string | null> {
	const docs = await listDocs(app, rootFolder, { includeArchived: true });
	if (info.docId) {
		const byId = docs.find((d) => d.manifest.id === info.docId);
		if (byId) return byId.folder.path;
	}
	const atPath = docs.find((d) => d.folder.path === info.docFolder);
	if (atPath && (!info.docId || atPath.manifest.id === info.docId)) return atPath.folder.path;
	return null;
}

/** The item id in a node file's frontmatter. */
async function idOf(app: App, file: TFile): Promise<string | null> {
	const cached: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.id;
	if (cached !== undefined && cached !== null && cached !== "") return idToString(cached as string | number);
	const fm = parseFrontmatterBlock(await app.vault.cachedRead(file));
	return fm?.id !== undefined && fm.id !== null && fm.id !== "" ? idToString(fm.id as string | number) : null;
}

export interface RestoreResult {
	/** The document folder the items went back into. */
	folder: string;
	restored: number;
	/** Items whose id is already in the document (an undo brought them back
	 *  earlier). Left in the trash rather than laid down as a second file with
	 *  the same id, which one of the two copies silently lost (M27). */
	alreadyThere: number;
}

/** Move a trashed group's item files back into their document folder. Their
 *  frontmatter (id, parent, doc) is intact, so the document rebuilds the
 *  structure on its own. */
export async function restoreGroup(app: App, rootFolder: string, group: TrashGroup): Promise<RestoreResult> {
	const info = group.info;
	if (!info?.docFolder && !info?.docId) throw new Error("This trash group has no record of where it came from.");
	const dest = await resolveDocFolder(app, rootFolder, info);
	if (!dest) {
		throw new Error(`The document "${info.docTitle || info.docFolder}" no longer exists.`);
	}
	const folder = app.vault.getFolderByPath(dest);
	const present = new Set<string>();
	for (const c of folder?.children ?? []) {
		if (c instanceof TFile && c.extension === "md") {
			const id = await idOf(app, c);
			if (id) present.add(id);
		}
	}
	let restored = 0;
	let alreadyThere = 0;
	for (const child of [...group.folder.children]) {
		if (!(child instanceof TFile) || child.name === "_trashinfo.json") continue;
		const id = child.extension === "md" ? await idOf(app, child) : null;
		if (id && present.has(id)) { alreadyThere++; continue; }
		let target = normalizePath(`${dest}/${child.name}`);
		let j = 2;
		while (app.vault.getAbstractFileByPath(target)) target = normalizePath(`${dest}/${child.basename} ${j++}.${child.extension}`);
		await app.vault.rename(child, target);
		if (id) present.add(id);
		restored++;
	}
	// Nothing left but the info file: remove the empty group entirely.
	if (!alreadyThere) await app.fileManager.trashFile(group.folder);
	return { folder: dest, restored, alreadyThere };
}

/** Permanently remove everything in the trash, via Obsidian's configured trash. */
export async function emptyTrash(app: App, rootFolder: string): Promise<number> {
	const root = app.vault.getFolderByPath(trashRoot(rootFolder));
	if (!root) return 0;
	const groups = [...root.children];
	let n = 0;
	for (const g of groups) { await app.fileManager.trashFile(g); n++; }
	return n;
}

/** `onChange` gets the document folder a restore went into (nothing for
 *  emptying the trash, which touches no document), so the caller can reload
 *  exactly that document — a render of the stale in-memory tree does not
 *  show restored items (M22/M23). */
export function openTrash(app: App, rootFolder: string, onChange: (restoredInto?: string) => void): void {
	void (async () => {
		const groups = await listTrash(app, rootFolder);
		new TrashModal(app, rootFolder, groups, onChange).open();
	})();
}

/** More deletions than this and "Restore all" asks first. */
const RESTORE_ALL_CONFIRM_ABOVE = 10;

class TrashModal extends Modal {
	/** Folder paths of the checked rows. Paths, not group objects: the list is
	 *  re-read from disk after a bulk restore, which yields new objects. */
	private selected = new Set<string>();
	private busy = false;
	private closed = false;
	/** Progress label for the button that started the running restore. */
	private progress: { which: "selected" | "all"; text: string } | null = null;
	/** Refreshes the toolbar and the row controls in place, without rebuilding
	 *  the list (a rebuild would drop scroll position and checkbox focus). */
	private syncControls: () => void = () => {};

	constructor(app: App, private rootFolder: string, private groups: TrashGroup[], private onChange: (restoredInto?: string) => void) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.modalEl.addClass("trynalist-diff-modal");
		this.titleEl.setText("Trash");
		this.render();
	}

	private selectedGroups(): TrashGroup[] {
		return this.groups.filter((g) => this.selected.has(g.folder.path));
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.syncControls = () => {};
		// Drop selections whose group is gone.
		const live = new Set(this.groups.map((g) => g.folder.path));
		for (const path of [...this.selected]) if (!live.has(path)) this.selected.delete(path);
		if (!this.groups.length) {
			contentEl.createDiv({ cls: "trynalist-panel-empty", text: "The trash is empty." });
			return;
		}
		const total = this.groups.reduce((n, g) => n + g.itemCount, 0);
		const head = new Setting(contentEl)
			.setName(`${total} item${total === 1 ? "" : "s"} in ${this.groups.length} deletion${this.groups.length === 1 ? "" : "s"}`);
		let emptyBtn: ButtonComponent | null = null;
		head.addButton((b) => {
			emptyBtn = b;
			b.setButtonText("Empty trash").setWarning().onClick(() => {
				if (this.busy) return;
				new ConfirmModal(this.app, {
					title: "Empty trash?",
					body: `Permanently remove ${total} item${total === 1 ? "" : "s"}? They go to your Obsidian trash (system trash, vault .trash, or permanent — per your Obsidian settings).`,
					cta: "Empty trash",
					warning: true,
					onConfirm: async () => {
						if (this.busy) return;
						await emptyTrash(this.app, this.rootFolder);
						this.groups = [];
						this.selected.clear();
						this.onChange();
						if (!this.closed) this.render();
						new Notice("Trynalist: trash emptied.");
					},
				}).open();
			});
		});

		const toolbar = contentEl.createDiv({ cls: "trynalist-trash-toolbar" });
		const selectAllLabel = toolbar.createEl("label", { cls: "trynalist-trash-select-all" });
		const selectAll = selectAllLabel.createEl("input", { type: "checkbox" });
		selectAllLabel.createSpan({ text: "Select all" });
		const restoreSelectedBtn = toolbar.createEl("button", { cls: "trynalist-trash-restore-selected mod-cta" });
		const restoreAllBtn = toolbar.createEl("button", { cls: "trynalist-trash-restore-all" });

		const rowBoxes: HTMLInputElement[] = [];
		const rowButtons: ButtonComponent[] = [];

		this.syncControls = () => {
			const n = this.selectedGroups().length;
			const p = this.progress;
			selectAll.checked = n > 0 && n === this.groups.length;
			selectAll.indeterminate = n > 0 && n < this.groups.length;
			selectAll.disabled = this.busy;
			for (const box of rowBoxes) box.disabled = this.busy;
			for (const b of rowButtons) b.setDisabled(this.busy);
			emptyBtn?.setDisabled(this.busy);
			restoreSelectedBtn.setText(p?.which === "selected" ? p.text : n ? `Restore ${n} selected` : "Restore selected");
			restoreSelectedBtn.disabled = this.busy || n === 0;
			restoreAllBtn.setText(p?.which === "all" ? p.text : "Restore all");
			restoreAllBtn.disabled = this.busy || !this.groups.length;
		};

		selectAll.addEventListener("change", () => {
			if (this.busy) return;
			if (selectAll.checked) for (const g of this.groups) this.selected.add(g.folder.path);
			else this.selected.clear();
			for (let i = 0; i < rowBoxes.length; i++) rowBoxes[i].checked = this.selected.has(this.groups[i].folder.path);
			this.syncControls();
		});
		restoreSelectedBtn.addEventListener("click", () => {
			const chosen = this.selectedGroups();
			if (!chosen.length) return;
			void this.restoreMany(chosen, "selected");
		});
		restoreAllBtn.addEventListener("click", () => {
			if (this.busy || !this.groups.length) return;
			const all = [...this.groups];
			const run = () => { void this.restoreMany(all, "all"); };
			if (all.length <= RESTORE_ALL_CONFIRM_ABOVE) { run(); return; }
			const items = all.reduce((n, g) => n + g.itemCount, 0);
			new ConfirmModal(this.app, {
				title: "Restore everything?",
				body: `Restore ${items} item${items === 1 ? "" : "s"} from ${all.length} deletions back into their documents?`,
				cta: "Restore all",
				onConfirm: run,
			}).open();
		});

		const list = contentEl.createDiv({ cls: "trynalist-diff-list" });
		for (const g of this.groups) {
			const row = list.createDiv({ cls: "trynalist-diff-item trynalist-trash-row" });
			const box = row.createEl("input", { type: "checkbox", cls: "trynalist-trash-select" });
			box.setAttribute("aria-label", `Select ${g.info?.docTitle ?? g.folder.name}`);
			box.checked = this.selected.has(g.folder.path);
			box.addEventListener("change", () => {
				if (this.busy) return;
				if (box.checked) this.selected.add(g.folder.path); else this.selected.delete(g.folder.path);
				this.syncControls();
			});
			rowBoxes.push(box);
			const badge = row.createSpan({ cls: "trynalist-diff-badge is-removed" });
			setIcon(badge, "trash-2");
			const body = row.createDiv({ cls: "trynalist-diff-item-body" });
			body.createDiv({ cls: "trynalist-diff-text", text: `${g.info?.docTitle ?? g.folder.name} — ${g.itemCount} item${g.itemCount === 1 ? "" : "s"}` });
			if (g.info?.trashedAt) body.createDiv({ cls: "trynalist-diff-fields", text: `deleted ${new Date(g.info.trashedAt).toLocaleString()}` });
			new Setting(row).addButton((b) => {
				rowButtons.push(b);
				b.setButtonText("Restore").onClick(async () => {
					if (this.busy) return;
					try {
						const { folder, restored: n, alreadyThere } = await restoreGroup(this.app, this.rootFolder, g);
						if (alreadyThere) g.itemCount = alreadyThere;
						else this.groups = this.groups.filter((x) => x !== g);
						this.onChange(folder);
						if (!this.closed) this.render();
						new Notice(`Trynalist: restored ${n} item${n === 1 ? "" : "s"}.`
							+ (alreadyThere
								? ` ${alreadyThere} ${alreadyThere === 1 ? "is" : "are"} already in the document (brought back by undo) and stayed in the trash.`
								: ""), alreadyThere ? 10000 : 5000);
					} catch (e) {
						new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}`, 8000);
					}
				});
			});
		}
		this.syncControls();
	}

	/** Restore several deletions one after another — never in parallel, since
	 *  two groups can go back into the same document — oldest delete first so
	 *  items return in the order they were deleted. A group that fails is
	 *  recorded and the rest carry on. */
	private async restoreMany(chosen: TrashGroup[], which: "selected" | "all"): Promise<void> {
		if (this.busy) return;
		const queue = [...chosen].sort((a, b) => (a.info?.trashedAt ?? "").localeCompare(b.info?.trashedAt ?? ""));
		this.busy = true;
		let restored = 0;
		let alreadyThere = 0;
		let done = 0;
		const failures: string[] = [];
		const folders = new Set<string>();
		try {
			for (const g of queue) {
				this.progress = { which, text: `Restoring ${done + 1} of ${queue.length}…` };
				if (!this.closed) this.syncControls();
				try {
					const r = await restoreGroup(this.app, this.rootFolder, g);
					restored += r.restored;
					alreadyThere += r.alreadyThere;
					if (r.restored > 0) folders.add(r.folder);
					done++;
				} catch (e) {
					failures.push(e instanceof Error ? e.message : String(e));
					done++;
				}
			}
			// Every document that received items reloads, once each.
			for (const folder of folders) this.onChange(folder);
			this.selected.clear();
			if (!this.closed) {
				try { this.groups = await listTrash(this.app, this.rootFolder); } catch { /* keep the old list; the next open re-reads it */ }
			}
		} finally {
			this.busy = false;
			this.progress = null;
		}
		if (!this.closed) this.render();
		const ok = queue.length - failures.length;
		let msg = `Trynalist: restored ${restored} item${restored === 1 ? "" : "s"} from ${ok} deletion${ok === 1 ? "" : "s"}.`;
		if (alreadyThere) msg += ` ${alreadyThere} ${alreadyThere === 1 ? "is" : "are"} already in the document (brought back by undo) and stayed in the trash.`;
		if (failures.length) msg += ` ${failures.length} deletion${failures.length === 1 ? "" : "s"} could not be restored: ${failures[0]}`;
		new Notice(msg, alreadyThere || failures.length ? 10000 : 5000);
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}
}
