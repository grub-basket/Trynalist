import { App, Modal, Notice, Setting, TFile, TFolder, setIcon } from "obsidian";
import { DocIndex, listDocs, loadReadOnlyIndex, stripMatches } from "./store";
import { sift } from "./search";
import { ATTACHMENTS_SUBFOLDER } from "./types";
import type { DocRef, TreeNode } from "./types";

export interface AttachmentUse {
	docPath: string;
	docTitle: string;
	itemId: string;
	itemText: string;
}

export interface AttachmentEntry {
	/** null when an item links to something that isn't there. */
	file: TFile | null;
	/** The link target as written, for a missing file. */
	target: string;
	/** Every spelling the items used to reach this file (`photo.png`,
	 *  `_attachments/photo.png`…). Unlinking has to strip each of them; the
	 *  resolved path alone never matches a short-form embed. */
	rawTargets: Set<string>;
	uses: AttachmentUse[];
	sizeBytes: number;
	mtime: number;
	isImage: boolean;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
const EMBED_RE = /!?\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;

/** Every attachment referenced by any document, plus anything sitting unused
 *  in a document's own `_attachments` folder. */
export async function collectAttachments(app: App, rootFolder: string): Promise<AttachmentEntry[]> {
	const docs: DocRef[] = await listDocs(app, rootFolder, { includeArchived: true });
	const byPath = new Map<string, AttachmentEntry>();
	const missing = new Map<string, AttachmentEntry>();

	const record = (file: TFile | null, target: string, use: AttachmentUse) => {
		if (!file) {
			const entry = missing.get(target) ?? {
				file: null, target, rawTargets: new Set<string>([target]), uses: [], sizeBytes: 0, mtime: 0, isImage: false,
			};
			entry.uses.push(use);
			missing.set(target, entry);
			return;
		}
		const entry = byPath.get(file.path) ?? {
			file,
			target: file.path,
			rawTargets: new Set<string>(),
			uses: [],
			sizeBytes: file.stat.size,
			mtime: file.stat.mtime,
			isImage: IMAGE_EXTS.has(file.extension.toLowerCase()),
		};
		entry.rawTargets.add(target);
		entry.uses.push(use);
		byPath.set(file.path, entry);
	};

	for (const doc of docs) {
		const index = await loadReadOnlyIndex(app, doc);
		for (const node of index.nodes.values()) {
			const haystack = `${node.text}\n${node.note}`;
			for (const m of haystack.matchAll(EMBED_RE)) {
				const target = m[1].trim();
				// Only treat it as an attachment if it resolves to a non-markdown
				// file; `[[item]]` links between outline items are not attachments.
				const dest = app.metadataCache.getFirstLinkpathDest(target, doc.file.path);
				if (dest && dest.extension === "md") continue;
				// Documents, canvases and bases are things you link to, not
				// attachments — listed here, they were one confirm away from being
				// trashed with "Delete". A bare link (no `!`) to a file outside a
				// document's _attachments is a reference to something that lives
				// elsewhere, not an attachment either (L45).
				if (dest && ["trynalist", "canvas", "base"].includes(dest.extension.toLowerCase())) continue;
				const embedded = m[0].startsWith("!");
				if (dest && !embedded && !dest.path.split("/").includes(ATTACHMENTS_SUBFOLDER)) continue;
				// A bare `[[wikilink]]` that resolves to nothing is a note that
				// hasn't been written yet — unless it names a file type other than a
				// note (`[[report.pdf]]`), which is a missing attachment (L46).
				const ext = /\.([A-Za-z0-9]{1,8})$/.exec(target)?.[1]?.toLowerCase();
				if (!dest && !embedded && (!ext || ext === "md")) continue;
				record(dest, target, {
					docPath: doc.file.path,
					docTitle: doc.manifest.title,
					itemId: node.id,
					itemText: describeItem(node),
				});
			}
		}
		// Unreferenced files in the document's own attachments folder.
		const attachFolder = doc.folder.children.find(
			(c): c is TFolder => c instanceof TFolder && c.name === ATTACHMENTS_SUBFOLDER,
		);
		if (!attachFolder) continue;
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (c instanceof TFolder) { walk(c); continue; }
				if (!(c instanceof TFile) || c.extension === "md") continue;
				if (byPath.has(c.path)) continue;
				byPath.set(c.path, {
					file: c,
					target: c.path,
					rawTargets: new Set<string>(),
					uses: [],
					sizeBytes: c.stat.size,
					mtime: c.stat.mtime,
					isImage: IMAGE_EXTS.has(c.extension.toLowerCase()),
				});
			}
		};
		walk(attachFolder);
	}
	return [...byPath.values(), ...missing.values()]
		.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

/** The item's line, without the embed syntax and date markup — the row already
 *  names the file, so repeating the raw `![[…]]` made the label unreadable. */
function describeItem(node: TreeNode): string {
	const clean = node.text
		.replace(/!?\[\[[^[\]]+\]\]/g, "")
		.replace(/!\([^)]*\)/g, "")
		.replace(/[*_~`]/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
	return clean || "(item with no other text)";
}

export function formatBytes(n: number): string {
	if (!n) return "—";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type Filter = "all" | "orphans" | "missing";

/** Dynalist had a list of links, which the user found unhelpful. This is the
 *  same idea with the actions that make it useful: jump to the item that uses
 *  it, reveal it on disk, preview it, and delete it safely. */
export class AttachmentsModal extends Modal {
	private entries: AttachmentEntry[] = [];
	private query = "";
	private filter: Filter = "all";
	private listEl: HTMLElement | null = null;
	private previewEl: HTMLElement | null = null;

	constructor(
		app: App,
		private rootFolder: string,
		private onJump: (use: AttachmentUse) => void,
		// Unlink writes through its own DocIndex; an open tab on the same
		// document still holds the old text and would write it back on its
		// next save, so the caller reloads those views.
		private onDocChanged?: (folderPath: string) => Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("trynalist-attachments-modal");
		this.setTitle("Attachments");
		this.contentEl.createDiv({ cls: "trynalist-suggest-trail", text: "Reading documents…" });
		this.entries = await collectAttachments(this.app, this.rootFolder);
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();

		const orphans = this.entries.filter((e) => e.file && !e.uses.length).length;
		const broken = this.entries.filter((e) => !e.file).length;
		const bytes = this.entries.reduce((n, e) => n + e.sizeBytes, 0);
		el.createDiv({
			cls: "trynalist-integrity-summary",
			text: `${this.entries.length} attachment${this.entries.length === 1 ? "" : "s"} · ${formatBytes(bytes)}`
				+ (orphans ? ` · ${orphans} unused` : "")
				+ (broken ? ` · ${broken} missing` : ""),
		});

		const controls = el.createDiv({ cls: "trynalist-attach-controls" });
		const search = controls.createEl("input", { type: "search", placeholder: "Filter attachments…" });
		search.value = this.query;
		search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
		const tabs: Array<[Filter, string]> = [
			["all", "All"],
			["orphans", `Unused${orphans ? ` (${orphans})` : ""}`],
			["missing", `Missing${broken ? ` (${broken})` : ""}`],
		];
		for (const [key, label] of tabs) {
			const btn = controls.createEl("button", {
				text: label,
				cls: this.filter === key ? "trynalist-attach-tab is-active" : "trynalist-attach-tab",
			});
			btn.addEventListener("click", () => { this.filter = key; this.render(); });
		}

		this.listEl = el.createDiv({ cls: "trynalist-attach-list" });
		this.renderList();
	}

	private visibleEntries(): AttachmentEntry[] {
		return this.entries.filter((e) => {
			if (this.filter === "orphans" && (!e.file || e.uses.length)) return false;
			if (this.filter === "missing" && e.file) return false;
			if (!this.query.trim()) return true;
			const hay = `${e.target} ${e.uses.map((u) => `${u.docTitle} ${u.itemText}`).join(" ")}`;
			return sift(hay, this.query);
		});
	}

	private renderList(): void {
		const host = this.listEl;
		if (!host) return;
		host.empty();
		const rows = this.visibleEntries();
		if (!rows.length) {
			host.createDiv({ cls: "trynalist-panel-empty", text: "Nothing matches." });
			return;
		}
		for (const entry of rows) this.renderRow(host, entry);
	}

	private renderRow(host: HTMLElement, entry: AttachmentEntry): void {
		const row = host.createDiv({ cls: "trynalist-attach-row" });
		if (!entry.file) row.addClass("is-missing");
		else if (!entry.uses.length) row.addClass("is-orphan");

		// Thumbnail for images, an icon otherwise; hovering enlarges it.
		const thumb = row.createDiv({ cls: "trynalist-attach-thumb" });
		if (entry.file && entry.isImage) {
			const img = thumb.createEl("img");
			img.loading = "lazy";   // only what scrolls into view loads (L91)
			img.decoding = "async";
			img.src = this.app.vault.getResourcePath(entry.file);
			row.addEventListener("mouseenter", () => this.showPreview(row, entry));
			row.addEventListener("mouseleave", () => this.hidePreview());
		} else {
			setIcon(thumb, entry.file ? "file" : "alert-triangle");
		}

		const body = row.createDiv({ cls: "trynalist-attach-body" });
		const name = entry.file ? entry.file.name : entry.target;
		body.createDiv({ cls: "trynalist-doc-name", text: name });
		const meta = entry.file
			? `${formatBytes(entry.sizeBytes)} · ${window.moment(entry.mtime).calendar()}`
			: "file not found";
		body.createDiv({ cls: "trynalist-suggest-trail", text: meta });
		if (entry.uses.length) {
			for (const use of entry.uses.slice(0, 3)) {
				const useRow = body.createDiv({ cls: "trynalist-attach-use" });
				const jump = useRow.createEl("button", { cls: "trynalist-attach-jump" });
				setIcon(jump, "corner-down-right");
				jump.setAttribute("aria-label", "Jump to the item using this");
				jump.addEventListener("click", () => { this.close(); this.onJump(use); });
				useRow.createSpan({ text: `${use.itemText} — ${use.docTitle}` });
			}
			if (entry.uses.length > 3) {
				body.createDiv({ cls: "trynalist-suggest-trail", text: `…and ${entry.uses.length - 3} more use(s)` });
			}
		} else if (entry.file) {
			body.createDiv({ cls: "trynalist-attach-orphan-note", text: "Not referenced by any item." });
		}

		const actions = row.createDiv({ cls: "trynalist-attach-actions" });
		if (entry.file) {
			this.action(actions, "folder-open", "Reveal on disk", () => this.reveal(entry.file!));
			this.action(actions, "external-link", "Open", () => {
				void this.app.workspace.getLeaf(true).openFile(entry.file!);
			});
			this.action(actions, "link", "Copy link", () => {
				void (async () => {
					await navigator.clipboard.writeText(`![[${entry.file!.path}]]`);
					new Notice("Trynalist: link copied.");
				})();
			});
			this.action(actions, "trash", "Delete", () => this.confirmDelete(entry));
		}
	}

	private action(host: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const btn = host.createSpan({ cls: "trynalist-row-action is-visible" });
		setIcon(btn, icon);
		btn.setAttribute("aria-label", label);
		btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
	}

	// ── preview ─────────────────────────────────────────────────────────

	private showPreview(anchor: HTMLElement, entry: AttachmentEntry): void {
		if (!entry.file || !entry.isImage) return;
		this.hidePreview();
		const tip = anchor.doc.body.createDiv({ cls: "trynalist-attach-preview" });
		const img = tip.createEl("img");
		img.loading = "lazy";   // only what scrolls into view loads (L91)
		img.decoding = "async";
		img.src = this.app.vault.getResourcePath(entry.file);
		const r = anchor.getBoundingClientRect();
		tip.style.top = `${Math.max(8, Math.min(r.top, anchor.win.innerHeight - 320))}px`;
		tip.style.left = `${Math.max(8, r.left - 330)}px`;
		this.previewEl = tip;
	}

	private hidePreview(): void {
		this.previewEl?.remove();
		this.previewEl = null;
	}

	// ── actions ─────────────────────────────────────────────────────────

	private reveal(file: TFile): void {
		const app = this.app as unknown as { showInFolder?: (path: string) => void };
		if (typeof app.showInFolder === "function") {
			app.showInFolder(file.path);
			return;
		}
		new Notice("Trynalist: revealing files is desktop-only.");
	}

	/** Deleting is the one destructive action here, so it says what depends on
	 *  the file and lets the links be cleaned up in the same step. */
	private confirmDelete(entry: AttachmentEntry): void {
		const file = entry.file;
		if (!file) return;
		let alsoUnlink = entry.uses.length > 0;
		const modal = new Modal(this.app);
		modal.setTitle(`Delete "${file.name}"?`);
		modal.contentEl.createDiv({
			text: entry.uses.length
				? `${entry.uses.length} item${entry.uses.length === 1 ? "" : "s"} link to this file. It goes to the vault trash, so it can be restored from there.`
				: "Nothing links to this file. It goes to the vault trash, so it can be restored from there.",
		});
		if (entry.uses.length) {
			new Setting(modal.contentEl)
				.setName("Also remove the link from those items")
				.setDesc("Leave this off to keep the links, which will show as missing until you restore the file.")
				.addToggle((t) => t.setValue(alsoUnlink).onChange((v) => (alsoUnlink = v)));
		}
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((b) => b.setButtonText("Move to trash").setWarning().onClick(async () => {
				modal.close();
				if (alsoUnlink) await this.unlink(entry);
				await this.app.fileManager.trashFile(file);
				this.entries = this.entries.filter((e) => e !== entry);
				this.render();
				new Notice(`Trynalist: "${file.name}" moved to trash.`);
			}));
		modal.open();
	}

	/** Strip the embed for a file out of every item that references it. */
	private async unlink(entry: AttachmentEntry): Promise<void> {
		const docs = await listDocs(this.app, this.rootFolder, { includeArchived: true });
		const byPath = new Map(docs.map((d) => [d.file.path, d]));
		const grouped = new Map<string, AttachmentUse[]>();
		for (const use of entry.uses) {
			grouped.set(use.docPath, [...(grouped.get(use.docPath) ?? []), use]);
		}
		for (const [docPath, uses] of grouped) {
			const doc = byPath.get(docPath);
			if (!doc) continue;
			const index = new DocIndex(this.app, doc);
			await index.load();
			for (const use of uses) {
				const node: TreeNode | undefined = index.nodes.get(use.itemId);
				if (!node) continue;
				// Strip every spelling that reached this file, not just the resolved
				// path: `![[photo.png]]` resolved to `_attachments/photo.png` and
				// a regex built from the latter never matched the former, so the
				// toggle silently did nothing for short-form embeds.
				const targets = [...new Set([entry.target, ...entry.rawTargets])].map(escapeRe).join("|");
				const re = new RegExp(`!?\\[\\[(?:${targets})(\\|[^\\]]*)?\\]\\]`, "g");
				// Only the matched links go, and only the lines that held one are
				// tidied; the rest of the note keeps its paragraphs and indents.
				const text = stripMatches(node.text, re).trim();
				const note = stripMatches(node.note, re);
				if (text !== node.text || note !== node.note) await index.setBody(node.id, text, note);
			}
			await this.onDocChanged?.(doc.folder.path);
		}
	}

	onClose(): void {
		this.hidePreview();
		this.contentEl.empty();
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
