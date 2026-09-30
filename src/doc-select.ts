import { App, Modal, Notice, Setting } from "obsidian";
import type { AccountDoc } from "./dynalist-api";

/** Pick a subset of Dynalist documents to import/update — for running over just
 *  a few (e.g. the ones a rate limit left unfinished) instead of the whole
 *  account. A searchable checkbox list with select-all-of-the-current-filter. */
export class DocSelectModal extends Modal {
	private selected = new Set<string>();
	private filter = "";
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;

	constructor(
		app: App,
		private docs: AccountDoc[],
		private ctaLabel: string,
		private onConfirm: (ids: string[]) => void,
	) {
		super(app);
	}

	private pathOf(d: AccountDoc): string { return d.folder.length ? d.folder.join(" / ") : ""; }

	private matches(): AccountDoc[] {
		const q = this.filter.trim().toLowerCase();
		if (!q) return this.docs;
		return this.docs.filter((d) => d.title.toLowerCase().includes(q) || this.pathOf(d).toLowerCase().includes(q));
	}

	onOpen(): void {
		this.modalEl.addClass("trynalist-diff-modal");
		this.titleEl.setText(`Select documents (${this.docs.length} total)`);
		const { contentEl } = this;

		const search = contentEl.createEl("input", { type: "text", cls: "trynalist-docselect-search", attr: { placeholder: "Filter by title or folder…" } });
		search.addEventListener("input", () => { this.filter = search.value; this.paint(); });
		window.setTimeout(() => search.focus(), 0);

		const bar = new Setting(contentEl);
		bar.addButton((b) => b.setButtonText("Select all (filtered)").onClick(() => {
			for (const d of this.matches()) this.selected.add(d.id);
			this.paint();
		}));
		bar.addButton((b) => b.setButtonText("Clear").onClick(() => { this.selected.clear(); this.paint(); }));
		this.countEl = contentEl.createDiv({ cls: "trynalist-diff-summary" });

		this.listEl = contentEl.createDiv({ cls: "trynalist-diff-list" });

		new Setting(contentEl).addButton((b) =>
			b.setButtonText(this.ctaLabel).setCta().onClick(() => {
				if (!this.selected.size) { new Notice("Trynalist: select at least one document."); return; }
				this.close();
				this.onConfirm([...this.selected]);
			}),
		);
		this.paint();
	}

	private paint(): void {
		if (this.countEl) this.countEl.setText(`${this.selected.size} selected`);
		const host = this.listEl;
		if (!host) return;
		host.empty();
		const rows = this.matches();
		if (!rows.length) { host.createDiv({ cls: "trynalist-panel-empty", text: "No documents match." }); return; }
		for (const d of rows) {
			const row = host.createDiv({ cls: "trynalist-docselect-row" });
			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected.has(d.id);
			cb.addEventListener("change", () => {
				if (cb.checked) this.selected.add(d.id); else this.selected.delete(d.id);
				if (this.countEl) this.countEl.setText(`${this.selected.size} selected`);
			});
			const body = row.createDiv({ cls: "trynalist-docselect-body" });
			body.createDiv({ cls: "trynalist-docselect-title", text: d.title });
			const path = this.pathOf(d);
			if (path) body.createDiv({ cls: "trynalist-docselect-path", text: path });
			// Clicking the row toggles too — a wider target than the checkbox.
			row.addEventListener("click", (e) => {
				if (e.target === cb) return;
				cb.checked = !cb.checked;
				cb.dispatchEvent(new Event("change"));
			});
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
