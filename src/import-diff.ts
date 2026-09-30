import { App, FuzzySuggestModal, Modal, Notice, Setting, TFolder, setIcon } from "obsidian";
import { listDocs, loadReadOnlyIndex } from "./store";

/** Compare two Dynalist import runs and show what changed between them.
 *
 *  Re-importing is additive (each run lands in its own dated folder), so the
 *  question a second import raises is "what actually moved since last time?".
 *  That is answered by joining the two runs on the STABLE Dynalist id — the
 *  `dlId` frontmatter the importer now records — never on text or path, which
 *  change precisely when the thing you want to detect changes.
 *
 *  Attachments need no special handling here: a Dynalist upload can be deleted
 *  but never edited, and its reference lives in the item's text as a URL — so a
 *  changed/removed attachment shows up as an ordinary text difference, and no
 *  content hashing is required. */

/** The comparable state of one imported item. */
interface Snap {
	sourceId: string;
	docKey: string;      // dlFileId when present, else the doc's title
	docTitle: string;
	text: string;
	note: string;
	checked: boolean;
	checkbox: boolean;
	heading: number;
	color: number;
}

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface DiffItem {
	sourceId: string;
	docTitle: string;
	status: DiffStatus;
	/** Which fields differ, for a "changed" item. */
	changedFields: string[];
	/** Text to show — the newer side for changed/added, the older for removed. */
	text: string;
	beforeText?: string;
}

export interface DiffDocGroup {
	docTitle: string;
	items: DiffItem[];
	counts: Record<DiffStatus, number>;
}

export interface DiffResult {
	groups: DiffDocGroup[];
	totals: Record<DiffStatus, number>;
	/** Items skipped because they carried no dlId on one/both sides — an older
	 *  run made before the id was recorded cannot be joined. Surfaced, never
	 *  silently dropped. */
	unmatchedNoId: number;
}

const COMPARED: Array<keyof Snap> = ["text", "note", "checked", "checkbox", "heading", "color"];

/** Pure diff of two snapshot sets, joined by sourceId. Kept free of Obsidian so
 *  it can be tested directly. */
export function diffSnapshots(a: Snap[], b: Snap[], noIdCount: number): DiffResult {
	const byIdA = new Map<string, Snap>();
	const byIdB = new Map<string, Snap>();
	for (const s of a) byIdA.set(s.sourceId, s);
	for (const s of b) byIdB.set(s.sourceId, s);

	const groups = new Map<string, DiffDocGroup>();
	const blankCounts = (): Record<DiffStatus, number> => ({ added: 0, removed: 0, changed: 0, unchanged: 0 });
	const totals = blankCounts();
	const group = (title: string): DiffDocGroup => {
		let g = groups.get(title);
		if (!g) { g = { docTitle: title, items: [], counts: blankCounts() }; groups.set(title, g); }
		return g;
	};
	const record = (item: DiffItem): void => {
		const g = group(item.docTitle);
		g.items.push(item);
		g.counts[item.status]++;
		totals[item.status]++;
	};

	// Every id present in either run.
	const ids = new Set<string>([...byIdA.keys(), ...byIdB.keys()]);
	for (const id of ids) {
		const prev = byIdA.get(id);
		const next = byIdB.get(id);
		if (prev && !next) {
			record({ sourceId: id, docTitle: prev.docTitle, status: "removed", changedFields: [], text: prev.text });
		} else if (!prev && next) {
			record({ sourceId: id, docTitle: next.docTitle, status: "added", changedFields: [], text: next.text });
		} else if (prev && next) {
			const changed = COMPARED.filter((f) => prev[f] !== next[f]);
			record({
				sourceId: id,
				docTitle: next.docTitle,
				status: changed.length ? "changed" : "unchanged",
				changedFields: changed,
				text: next.text,
				beforeText: changed.includes("text") ? prev.text : undefined,
			});
		}
	}

	// Stable, useful ordering: documents with the most churn first; within a
	// document, changed then added then removed then unchanged.
	const order: Record<DiffStatus, number> = { changed: 0, added: 1, removed: 2, unchanged: 3 };
	const groupList = [...groups.values()];
	for (const g of groupList) g.items.sort((x, y) => order[x.status] - order[y.status]);
	groupList.sort((x, y) => churn(y) - churn(x));

	return { groups: groupList, totals, unmatchedNoId: noIdCount };
}

function churn(g: DiffDocGroup): number {
	return g.counts.changed + g.counts.added + g.counts.removed;
}

/** Walk every document under a folder into snapshots, keyed by dlId. Returns the
 *  snapshots plus a count of items that had no dlId (and so cannot be joined). */
async function collect(app: App, folderPath: string): Promise<{ snaps: Snap[]; noId: number }> {
	const docs = await listDocs(app, folderPath, { includeArchived: true });
	const snaps: Snap[] = [];
	let noId = 0;
	for (const doc of docs) {
		const idx = await loadReadOnlyIndex(app, doc);
		const docKey = doc.manifest.dlFileId || doc.manifest.title;
		for (const n of idx.nodes.values()) {
			if (!n.sourceId) { noId++; continue; }
			snaps.push({
				sourceId: n.sourceId,
				docKey,
				docTitle: doc.manifest.title,
				text: n.text,
				note: n.note,
				checked: n.checked,
				checkbox: n.checkbox,
				heading: n.heading,
				color: n.color,
			});
		}
	}
	return { snaps, noId };
}

/** Compute the diff between two run folders. */
export async function diffRuns(app: App, folderA: string, folderB: string): Promise<DiffResult> {
	const [a, b] = await Promise.all([collect(app, folderA), collect(app, folderB)]);
	return diffSnapshots(a.snaps, b.snaps, a.noId + b.noId);
}

// ── UI ──────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<DiffStatus, string> = {
	changed: "Changed", added: "Added", removed: "Removed", unchanged: "Unchanged",
};
const STATUS_ICON: Record<DiffStatus, string> = {
	changed: "pencil", added: "plus", removed: "minus", unchanged: "equal",
};

/** Pick a folder from the immediate subfolders of the root (the import runs). */
class RunFolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private folders: TFolder[], private label: string, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder(label);
	}
	getItems(): TFolder[] { return this.folders; }
	getItemText(f: TFolder): string { return f.name; }
	onChooseItem(f: TFolder): void { this.onPick(f); }
}

/** Kick off the compare flow: pick the older run, then the newer, then show it. */
export function openImportDiff(app: App, rootFolder: string): void {
	const root = app.vault.getFolderByPath(rootFolder.replace(/\/+$/, ""));
	const subfolders = root
		? root.children.filter((c): c is TFolder => c instanceof TFolder)
		: [];
	if (subfolders.length < 2) {
		new Notice("Trynalist: need at least two import folders to compare. Import more than once first.");
		return;
	}
	new RunFolderPicker(app, subfolders, "Older run (compare FROM)…", (a) => {
		const rest = subfolders.filter((f) => f.path !== a.path);
		new RunFolderPicker(app, rest, "Newer run (compare TO)…", (b) => {
			void (async () => {
				const notice = new Notice("Trynalist: comparing runs…", 0);
				try {
					const result = await diffRuns(app, a.path, b.path);
					notice.hide();
					new ImportDiffModal(app, a.name, b.name, result).open();
				} catch (e) {
					notice.hide();
					console.error("Trynalist: import diff failed", e);
					new Notice(`Trynalist: compare failed — ${e instanceof Error ? e.message : String(e)}`);
				}
			})();
		}).open();
	}).open();
}

class ImportDiffModal extends Modal {
	private hideUnchanged = true;
	private hideMissing = false;

	constructor(app: App, private fromName: string, private toName: string, private result: DiffResult) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("trynalist-diff-modal");
		this.titleEl.setText(`Compare imports: ${this.fromName} → ${this.toName}`);
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const t = this.result.totals;

		// Summary line — the answer to "what moved" before any scrolling.
		const summary = contentEl.createDiv({ cls: "trynalist-diff-summary" });
		const chip = (status: DiffStatus, n: number): void => {
			const c = summary.createSpan({ cls: `trynalist-diff-chip is-${status}` });
			setIcon(c.createSpan({ cls: "trynalist-diff-chip-icon" }), STATUS_ICON[status]);
			c.createSpan({ text: ` ${n} ${STATUS_LABEL[status].toLowerCase()}` });
		};
		chip("changed", t.changed); chip("added", t.added); chip("removed", t.removed); chip("unchanged", t.unchanged);
		if (this.result.unmatchedNoId) {
			summary.createDiv({
				cls: "trynalist-diff-warn",
				text: `${this.result.unmatchedNoId} item${this.result.unmatchedNoId === 1 ? "" : "s"} had no Dynalist id and could not be compared (imported before ids were recorded).`,
			});
		}

		// Filters — "hide missing" is the free-up-space toggle: it drops the
		// added/removed items so what remains is only what exists in both runs
		// and actually differs.
		const filters = contentEl.createDiv({ cls: "trynalist-diff-filters" });
		new Setting(filters).setName("Hide unchanged").addToggle((tg) =>
			tg.setValue(this.hideUnchanged).onChange((v) => { this.hideUnchanged = v; this.render(); }),
		);
		new Setting(filters).setName("Hide added / removed").setDesc("Show only items present in both runs.").addToggle((tg) =>
			tg.setValue(this.hideMissing).onChange((v) => { this.hideMissing = v; this.render(); }),
		);

		const list = contentEl.createDiv({ cls: "trynalist-diff-list" });
		const visibleStatuses = new Set<DiffStatus>(["changed", "added", "removed", "unchanged"]);
		if (this.hideUnchanged) visibleStatuses.delete("unchanged");
		if (this.hideMissing) { visibleStatuses.delete("added"); visibleStatuses.delete("removed"); }

		// Painted in slices: one row per item synchronously meant ~44,000 rows
		// for a partial-vs-full run comparison, on every filter toggle (M66).
		// Each document shows its first rows; "Show more" appends the next
		// slice in place, and past a total budget a document starts folded.
		let budget = 1000;
		const appendSlice = (groupEl: HTMLElement, items: DiffItem[], from: number, size: number): void => {
			groupEl.querySelector(":scope > .trynalist-diff-more")?.remove();
			const end = Math.min(items.length, from + size);
			for (let k = from; k < end; k++) this.renderItem(groupEl, items[k]);
			if (end < items.length) {
				const more = groupEl.createEl("button", {
					cls: "trynalist-diff-more",
					text: `Show ${Math.min(200, items.length - end)} more of ${items.length - end}`,
				});
				more.addEventListener("click", () => appendSlice(groupEl, items, end, 200));
			}
		};
		let shownAny = false;
		for (const g of this.result.groups) {
			const items = g.items.filter((i) => visibleStatuses.has(i.status));
			if (!items.length) continue;
			shownAny = true;
			const groupEl = list.createDiv({ cls: "trynalist-diff-group" });
			const head = groupEl.createDiv({ cls: "trynalist-diff-doc" });
			head.createSpan({ cls: "trynalist-diff-doc-title", text: g.docTitle });
			const parts: string[] = [];
			for (const s of ["changed", "added", "removed"] as DiffStatus[]) {
				if (g.counts[s]) parts.push(`${g.counts[s]} ${STATUS_LABEL[s].toLowerCase()}`);
			}
			if (parts.length) head.createSpan({ cls: "trynalist-diff-doc-counts", text: parts.join(" · ") });
			const first = Math.min(50, budget);
			budget -= first;
			appendSlice(groupEl, items, 0, first);
		}
		if (!shownAny) list.createDiv({ cls: "trynalist-panel-empty", text: "Nothing to show with these filters." });
	}

	private renderItem(host: HTMLElement, item: DiffItem): void {
		const row = host.createDiv({ cls: `trynalist-diff-item is-${item.status}` });
		const badge = row.createSpan({ cls: `trynalist-diff-badge is-${item.status}` });
		setIcon(badge, STATUS_ICON[item.status]);
		badge.setAttribute("aria-label", STATUS_LABEL[item.status]);
		const body = row.createDiv({ cls: "trynalist-diff-item-body" });
		body.createDiv({ cls: "trynalist-diff-text", text: item.text || "(empty item)" });
		if (item.status === "changed") {
			if (item.beforeText !== undefined) {
				body.createDiv({ cls: "trynalist-diff-before", text: `was: ${item.beforeText || "(empty)"}` });
			}
			const others = item.changedFields.filter((f) => f !== "text");
			if (others.length) body.createDiv({ cls: "trynalist-diff-fields", text: `also changed: ${others.join(", ")}` });
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
