import { App, Modal, Notice } from "obsidian";
import { dedupeVersions } from "./item-history";
import type { HistoryEntry, ItemVersion } from "./item-history";

const KIND_LABEL: Record<ItemVersion["kind"], string> = {
	edit: "Edited",
	create: "Created",
	delete: "Deleted",
	move: "Moved",
	fold: "Folded or unfolded",
	snapshot: "Daily snapshot",
};

function kindLabel(v: ItemVersion): string {
	if (v.kind === "fold") return v.collapsed ? "Folded" : "Unfolded";
	return KIND_LABEL[v.kind];
}

/** What of a version can be put back. */
export type RestorePart = "text" | "position" | "fold";

/** The item as it is now, to compare each version against. */
export interface CurrentState {
	text: string;
	note: string;
	parent: string | null;
	prev: string | null;
	collapsed: boolean;
	/** Parent's text, for "under …" in the position line. */
	label: (id: string | null) => string;
}

const NOTE_PREVIEW = 400;

function when(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** One version: time, what happened, the text and (shortened) note. */
function paintVersion(row: HTMLElement, v: { text: string; note: string }, head: string, badge: string): void {
	const top = row.createDiv({ cls: "trynalist-history-head" });
	top.createSpan({ cls: "trynalist-history-when", text: head });
	top.createSpan({ cls: "trynalist-history-badge", text: badge });
	row.createDiv({ cls: "trynalist-history-text", text: v.text || "(empty)" });
	if (v.note) {
		const note = v.note.length > NOTE_PREVIEW ? `${v.note.slice(0, NOTE_PREVIEW)}…` : v.note;
		row.createDiv({ cls: "trynalist-history-note", text: note });
	}
}

/** The versions of one item this device recorded, newest first, each with a
 *  Restore button. Daily snapshots are searched only when asked: reading them
 *  means inflating up to a month of zips. */
export class ItemHistoryModal extends Modal {
	private versions: ItemVersion[] = [];
	private snapshotsLoaded = false;
	private listEl!: HTMLElement;

	constructor(app: App, private opts: {
		label: string;
		current: () => CurrentState | null;
		load: () => Promise<ItemVersion[]>;
		loadSnapshots: () => Promise<ItemVersion[]>;
		onRestore: (v: ItemVersion, part: RestorePart) => Promise<boolean>;
	}) {
		super(app);
	}

	onOpen(): void {
		const label = this.opts.label.length > 60 ? `${this.opts.label.slice(0, 60)}…` : this.opts.label;
		this.setTitle(`History of "${label || "(empty)"}"`);
		this.modalEl.addClass("trynalist-history-modal");
		this.contentEl.createEl("p", {
			cls: "trynalist-history-intro",
			text: "Versions recorded on this device in the last 30 days, newest first — your own edits, changes that arrived from other devices, and where the item sat and whether it was folded (recorded once it has stayed put for a couple of minutes). Each part can be restored on its own; undo brings the newer state back.",
		});
		this.listEl = this.contentEl.createDiv({ cls: "trynalist-history-list", text: "Loading…" });
		const foot = this.contentEl.createDiv({ cls: "trynalist-history-foot" });
		const more = foot.createEl("button", { text: "Also search daily snapshots" });
		more.addEventListener("click", () => {
			if (this.snapshotsLoaded) return;
			more.disabled = true;
			more.setText("Searching snapshots…");
			void this.opts.loadSnapshots().then((snaps) => {
				this.snapshotsLoaded = true;
				more.setText(snaps.length ? `Found ${snaps.length} in daily snapshots` : "Not in any daily snapshot");
				this.versions = [...this.versions, ...snaps];
				this.paint();
			}, (e) => {
				console.error(e);
				more.setText("Could not read the snapshots");
			});
		});
		void this.opts.load().then((v) => { this.versions = v; this.paint(); }, (e) => {
			console.error(e);
			this.listEl.setText("Could not read the history.");
		});
	}

	private paint(): void {
		this.listEl.empty();
		const sorted = dedupeVersions([...this.versions].sort((a, b) => b.when.localeCompare(a.when)));
		if (!sorted.length) {
			this.listEl.setText("Nothing recorded for this item yet. Versions are kept from the first change after item history was turned on; try the daily snapshots below.");
			return;
		}
		const cur = this.opts.current();
		for (const v of sorted) {
			const row = this.listEl.createDiv({ cls: "trynalist-history-row" });
			const hasPlace = v.parent !== undefined;
			const textDiffers = !cur || cur.text !== v.text || cur.note !== v.note;
			const placeDiffers = hasPlace && (!cur || cur.parent !== (v.parent ?? null)
				|| (v.prev !== undefined && cur.prev !== v.prev));
			const foldDiffers = hasPlace && (!cur || cur.collapsed !== !!v.collapsed);
			const isCurrent = !!cur && !textDiffers && !placeDiffers && !foldDiffers;
			paintVersion(row, v, when(v.when), isCurrent ? `${kindLabel(v)} · current` : kindLabel(v));
			if (hasPlace && cur) {
				const where = v.parent ? `under "${cur.label(v.parent)}"` : "at the top level";
				const after = v.prev === undefined ? "" : v.prev === null ? ", first" : `, after "${cur.label(v.prev)}"`;
				row.createDiv({ cls: "trynalist-history-place", text: `${where}${after}${v.collapsed ? " · folded" : ""}` });
			}
			if (isCurrent) row.addClass("is-current");
			const actions = row.createDiv({ cls: "trynalist-history-actions" });
			const add = (label: string, part: RestorePart): void => {
				const btn = actions.createEl("button", { cls: "trynalist-history-restore", text: label });
				btn.addEventListener("click", () => {
					btn.disabled = true;
					void this.opts.onRestore(v, part).then((ok) => { if (ok) this.close(); else btn.disabled = false; });
				});
			};
			if (textDiffers) add("Restore text", "text");
			if (placeDiffers) add("Restore position", "position");
			if (foldDiffers) add(v.collapsed ? "Fold it again" : "Unfold it again", "fold");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Items deleted in the last 30 days (by this device, or by a sync from
 *  another one) that exist nowhere under the root any more. */
export class RecentlyDeletedModal extends Modal {
	constructor(app: App, private opts: {
		load: () => Promise<Array<HistoryEntry & { docTitle: string | null }>>;
		onRestore: (e: HistoryEntry) => Promise<boolean>;
	}) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Recently deleted items");
		this.modalEl.addClass("trynalist-history-modal");
		this.contentEl.createEl("p", {
			cls: "trynalist-history-intro",
			text: "Items deleted in the last 30 days that are not in any document or in the trash — including ones another device deleted. Restoring adds the item back at the end of its document.",
		});
		const list = this.contentEl.createDiv({ cls: "trynalist-history-list", text: "Loading…" });
		void this.opts.load().then((entries) => {
			list.empty();
			if (!entries.length) { list.setText("Nothing deleted in the last 30 days that is missing now."); return; }
			for (const e of entries) {
				const row = list.createDiv({ cls: "trynalist-history-row" });
				const where = e.docTitle ?? `${e.doc.slice(e.doc.lastIndexOf("/") + 1)} (document gone)`;
				paintVersion(row, e, `${when(e.t)} · ${where}`, "Deleted");
				const actions = row.createDiv({ cls: "trynalist-history-actions" });
				const copy = actions.createEl("button", { text: "Copy text" });
				copy.addEventListener("click", () => {
					void navigator.clipboard.writeText(e.note ? `${e.text}\n${e.note}` : e.text)
						.then(() => new Notice("Trynalist: copied."));
				});
				if (e.docTitle !== null) {
					const btn = actions.createEl("button", { cls: "mod-cta", text: "Restore" });
					btn.addEventListener("click", () => {
						btn.disabled = true;
						void this.opts.onRestore(e).then((ok) => {
							if (ok) { btn.setText("Restored"); row.addClass("is-current"); } else btn.disabled = false;
						});
					});
				}
			}
		}, (err) => {
			console.error(err);
			list.setText("Could not read the history.");
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
