import { App, Modal, Notice, Setting, TFile, moment } from "obsidian";
import { describeRecurrence, parseRecurrence, timeFormatOf } from "./dates";
import type { Recurrence } from "./dates";
import type { TrynalistSettings } from "./types";

/** Single-field prompt. Enter submits, Escape cancels. */
export class PromptModal extends Modal {
	private value: string;

	constructor(
		app: App,
		private opts: {
			title: string;
			label: string;
			initial?: string;
			cta?: string;
			onSubmit: (value: string) => void | Promise<void>;
		},
	) {
		super(app);
		this.value = opts.initial ?? "";
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		const submit = async () => {
			const v = this.value.trim();
			if (!v) return;
			this.close();
			// The modal is gone by the time onSubmit runs, so a throw here (a
			// reserved document name, a folder clash) used to be an unhandled
			// rejection: the dialog closed and nothing happened. Say what went wrong.
			try {
				await this.opts.onSubmit(v);
			} catch (e) {
				console.error("Trynalist: prompt action failed", e);
				new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		};
		new Setting(this.contentEl).setName(this.opts.label).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") { e.preventDefault(); void submit(); }
			});
			window.setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
		});
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText(this.opts.cta ?? "Save").setCta().onClick(() => void submit()),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Date + optional time picker. Mirrors Dynalist's `!(date)` popup; honours
 *  the 12/24-hour, AM/PM and first-day-of-week preferences. */
export class DatePickerModal extends Modal {
	private date: string;
	private time: string;
	private useTime: boolean;

	constructor(
		app: App,
		private opts: {
			initial: string | null;
			initialHasTime: boolean;
			initialRecurrence?: Recurrence | null;
			settings: TrynalistSettings;
			onSubmit: (iso: string | null, hasTime: boolean, recurrence: Recurrence | null) => void | Promise<void>;
		},
	) {
		super(app);
		const start = opts.initial ? moment(opts.initial) : moment();
		this.date = start.format("YYYY-MM-DD");
		this.time = start.format("HH:mm");
		this.useTime = opts.initialHasTime;
		this.repeat = opts.initialRecurrence ?? null;
	}

	private repeat: Recurrence | null;

	onOpen(): void {
		this.setTitle(this.opts.initial ? "Edit date" : "Add date");
		const preview = () => {
			const m = moment(`${this.date} ${this.time}`, "YYYY-MM-DD HH:mm");
			if (!m.isValid()) return "Invalid date";
			const d = m.format(this.opts.settings.dateFormat || "MMM D, YYYY");
			return this.useTime ? `${d} ${m.format(timeFormatOf(this.opts.settings))}` : d;
		};
		const previewEl = this.contentEl.createDiv({ cls: "trynalist-date-preview", text: preview() });

		new Setting(this.contentEl).setName("Date").addText((t) => {
			t.inputEl.type = "date";
			t.setValue(this.date).onChange((v) => { this.date = v; previewEl.setText(preview()); });
			// Weeks start where the user's preference says (browser honours the
			// locale, so nudge it via the lang attribute).
			t.inputEl.lang = this.opts.settings.firstDayOfWeek === "monday" ? "en-GB" : "en-US";
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(this.contentEl).setName("Include a time").addToggle((tg) =>
			tg.setValue(this.useTime).onChange((v) => { this.useTime = v; previewEl.setText(preview()); }),
		);

		new Setting(this.contentEl).setName("Time").addText((t) => {
			t.inputEl.type = "time";
			t.setValue(this.time).onChange((v) => { this.time = v; previewEl.setText(preview()); });
		});

		// ── repeat (Dynalist's `| 2d`, `| 3w135`, `| ~30d`) ──
		const repeatSummary = this.contentEl.createDiv({ cls: "trynalist-repeat-summary" });
		const paintRepeat = () => {
			repeatSummary.setText(this.repeat ? `Repeats ${describeRecurrence(this.repeat)}` : "Does not repeat");
		};
		paintRepeat();

		let count = String(this.repeat?.n ?? 1);
		let unit: Recurrence["unit"] = this.repeat?.unit ?? "w";
		let weekdays = new Set<number>(this.repeat?.weekdays ?? []);
		let fromCompletion = this.repeat?.fromCompletion ?? false;
		const rebuild = () => {
			const n = Math.max(1, parseInt(count, 10) || 1);
			const days = unit === "w" ? [...weekdays].sort().join("") : "";
			this.repeat = parseRecurrence(`${fromCompletion ? "~" : ""}${n}${unit}${days}`);
			paintRepeat();
			dayRow.toggleClass("is-hidden", unit !== "w");
		};

		new Setting(this.contentEl).setName("Repeat")
			.addToggle((tg) => tg.setValue(!!this.repeat).onChange((v) => {
				if (v) rebuild(); else { this.repeat = null; paintRepeat(); }
			}))
			.addText((t2) => {
				t2.inputEl.type = "number";
				t2.inputEl.min = "1";
				t2.inputEl.addClass("trynalist-repeat-count");
				t2.setValue(count).onChange((v) => { count = v; if (this.repeat) rebuild(); });
			})
			.addDropdown((d) =>
				d.addOptions({ d: "days", w: "weeks", m: "months", y: "years" })
					.setValue(unit)
					.onChange((v) => { unit = v as Recurrence["unit"]; if (this.repeat) rebuild(); }),
			);

		const dayRow = this.contentEl.createDiv({ cls: "trynalist-weekday-row" });
		["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((label, i) => {
			const iso = i + 1;
			const btn = dayRow.createEl("button", { text: label, cls: "trynalist-weekday" });
			btn.toggleClass("is-on", weekdays.has(iso));
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				if (weekdays.has(iso)) weekdays.delete(iso); else weekdays.add(iso);
				btn.toggleClass("is-on", weekdays.has(iso));
				if (this.repeat) rebuild();
			});
		});
		dayRow.toggleClass("is-hidden", unit !== "w");

		new Setting(this.contentEl)
			.setName("Count from completion")
			.setDesc("Repeat this long after the item is ticked off, rather than after its due date.")
			.addToggle((tg) => tg.setValue(fromCompletion).onChange((v) => {
				fromCompletion = v;
				if (this.repeat) rebuild();
			}));

		const submit = async (clear: boolean) => {
			this.close();
			if (clear) { await this.opts.onSubmit(null, false, null); return; }
			const m = moment(`${this.date} ${this.time}`, "YYYY-MM-DD HH:mm");
			if (!m.isValid()) return;
			await this.opts.onSubmit(m.toISOString(), this.useTime, this.repeat);
		};
		const buttons = new Setting(this.contentEl);
		if (this.opts.initial) {
			buttons.addButton((b) => b.setButtonText("Remove date").setWarning().onClick(() => void submit(true)));
		}
		buttons.addButton((b) => b.setButtonText("Save").setCta().onClick(() => void submit(false)));
		this.contentEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { e.preventDefault(); void submit(false); }
		});
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Yes/no confirmation for destructive-ish actions. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private opts: {
			title: string;
			body: string;
			cta: string;
			warning?: boolean;
			onConfirm: () => void | Promise<void>;
			/** Called when the dialog is dismissed without confirming — needed
			 *  when a caller is awaiting a yes/no rather than firing and
			 *  forgetting, or the promise never settles. */
			onCancel?: () => void;
		},
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.opts.title);
		this.contentEl.createDiv({ text: this.opts.body });
		// `Setting` draws a divider above itself, which reads as a stray rule
		// between the sentence and the buttons in a two-line dialog.
		new Setting(this.contentEl)
			.setClass("trynalist-modal-buttons")
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.opts.cta).onClick(async () => {
					this.confirmed = true;
					this.close();
					await this.opts.onConfirm();
				});
				if (this.opts.warning) b.setWarning(); else b.setCta();
			});
	}

	/** Dismissing the dialog has to settle a caller that is awaiting an answer,
	 *  or the promise hangs forever and the action silently never happens. */
	private confirmed = false;

	onClose(): void {
		this.contentEl.empty();
		if (!this.confirmed) this.opts.onCancel?.();
	}
}

/** Results of the integrity check, grouped by kind so one noisy category
 *  can't bury the others, with a one-click fix for orphans. */
export class IntegrityModal extends Modal {
	constructor(
		private appRef: App,
		private report: { docs: number; nodes: number; problems: Array<{ kind: string; detail: string; path: string }> },
		private onFixOrphans?: (paths: string[]) => Promise<number>,
	) {
		super(appRef);
	}

	private static readonly LABELS: Record<string, string> = {
		"orphan": "Items whose parent is missing",
		"doc-in-doc": "Documents nested inside another document",
		"duplicate-manifest": "Folders with more than one .trynalist file",
		"unreadable-manifest": "Unreadable .trynalist files",
		"duplicate-doc-id": "Documents sharing an id",
		"duplicate-node-id": "Items sharing an id",
		"not-a-node": "Markdown files that are not Trynalist items",
		"missing-root": "Missing root folder",
	};

	onOpen(): void {
		this.setTitle("Trynalist integrity check");
		const { docs, nodes, problems } = this.report;
		this.contentEl.createDiv({
			cls: "trynalist-integrity-summary",
			text: `Scanned ${docs} document${docs === 1 ? "" : "s"} and ${nodes} item${nodes === 1 ? "" : "s"}.`,
		});
		if (!problems.length) {
			this.contentEl.createDiv({ text: "No problems found." });
			return;
		}
		const byKind = new Map<string, typeof problems>();
		for (const p of problems) {
			const list = byKind.get(p.kind) ?? [];
			list.push(p);
			byKind.set(p.kind, list);
		}
		this.contentEl.createDiv({
			cls: "trynalist-integrity-count",
			text: `${problems.length} thing${problems.length === 1 ? "" : "s"} to look at, in ${byKind.size} categor${byKind.size === 1 ? "y" : "ies"}:`,
		});
		const list = this.contentEl.createDiv({ cls: "trynalist-integrity-list" });
		for (const [kind, group] of byKind) {
			const block = list.createDiv({ cls: "trynalist-integrity-item" });
			block.createDiv({
				cls: "trynalist-integrity-kind",
				text: `${IntegrityModal.LABELS[kind] ?? kind} — ${group.length}`,
			});
			block.createDiv({ text: group[0].detail });
			const shown = group.slice(0, 5);
			for (const p of shown) block.createDiv({ cls: "trynalist-suggest-trail", text: p.path });
			if (group.length > shown.length) {
				block.createDiv({
					cls: "trynalist-suggest-trail",
					text: `…and ${group.length - shown.length} more`,
				});
			}
			if (kind === "orphan" && this.onFixOrphans) {
				new Setting(block).addButton((b) =>
					b.setButtonText(`Reattach ${group.length} item${group.length === 1 ? "" : "s"} to the top level`)
						.onClick(() => {
							// A rewrite of many files' parent field with no undo, so it
							// says so and asks first.
							const count = group.length;
							new ConfirmModal(this.app, {
								title: `Reattach ${count} item${count === 1 ? "" : "s"} to the top level?`,
								body: `Each item's parent field is cleared on disk, so it sits at the top level of its document. This cannot be undone from Trynalist.\n\nIf you just imported, or another device is still syncing, wait until that finishes and run the check again — a parent that has not arrived yet looks missing. Items whose parent turns up before you confirm are left alone.`,
								cta: "Reattach",
								warning: true,
								onConfirm: async () => {
									b.setDisabled(true);
									const fixed = await this.onFixOrphans!(group.map((g) => g.path));
									new Notice(`Trynalist: reattached ${fixed} item${fixed === 1 ? "" : "s"}.`);
									this.close();
								},
							}).open();
						}),
				);
			}
		}
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Paste-an-outline importer, for when the export isn't a file in the vault. */
export class ImportTextModal extends Modal {
	private text = "";
	private title = "";

	constructor(
		app: App,
		private onSubmit: (title: string, text: string) => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Import an outline");
		this.contentEl.createDiv({
			cls: "trynalist-suggest-trail",
			text: "Paste OPML, Dynalist JSON, or an indented list. The format is detected.",
		});
		new Setting(this.contentEl).setName("Document name").addText((t) =>
			t.setPlaceholder("Taken from the file if left blank").onChange((v) => (this.title = v)),
		);
		const area = this.contentEl.createEl("textarea", { cls: "trynalist-import-area" });
		area.rows = 14;
		area.addEventListener("input", () => (this.text = area.value));
		window.setTimeout(() => area.focus(), 0);
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Import").setCta().onClick(async () => {
				if (!this.text.trim()) { new Notice("Trynalist: nothing pasted."); return; }
				this.close();
				await this.onSubmit(this.title, this.text);
			}),
		);
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Paste-a-token prompt shown when the import command runs with nothing stored,
 *  so the flow starts from the command, not a detour into Settings. */
export class DynalistTokenModal extends Modal {
	private token = "";
	private remember: boolean;

	constructor(
		app: App,
		private keychainAvailable: boolean,
		private onSubmit: (token: string, remember: boolean) => void | Promise<void>,
	) {
		super(app);
		// Default to remembering only where it can be kept safely (keychain).
		this.remember = keychainAvailable;
	}

	onOpen(): void {
		this.setTitle("Connect Dynalist");
		const intro = this.contentEl.createDiv({ cls: "trynalist-suggest-trail" });
		intro.appendText("Paste your Dynalist API token. Get one from ");
		intro.createEl("a", { text: "dynalist.io/developer", href: "https://dynalist.io/developer" });
		intro.appendText(" (Generate → copy the secret). Trynalist only READS your Dynalist.");

		let field: import("obsidian").TextComponent | null = null;
		new Setting(this.contentEl).setName("API token").addText((t) => {
			field = t;
			t.setPlaceholder("Secret token").onChange((v) => (this.token = v));
			t.inputEl.type = "password";
			t.inputEl.addClass("trynalist-full-width");
			window.setTimeout(() => t.inputEl.focus(), 0);
		});

		new Setting(this.contentEl)
			.setName(this.keychainAvailable ? "Remember in my keychain" : "Remember (plain text — no keychain here)")
			.setDesc(this.keychainAvailable
				? "Stored in your OS keychain via Obsidian, never in the vault. Off = use once, not saved."
				: "No OS keychain is available here; if on, the token is saved in plain text in this vault.")
			.addToggle((tg) => tg.setValue(this.remember).onChange((v) => (this.remember = v)));

		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Import").setCta().onClick(async () => {
				const tok = this.token.trim();
				if (!tok) { new Notice("Trynalist: paste a token first."); return; }
				this.close();
				await this.onSubmit(tok, this.remember);
			}),
		);
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Search and replace across a document, or within one item's subtree —
 *  Dynalist offered both scopes. Counts matches before changing anything. */
export class ReplaceModal extends Modal {
	private find = "";
	private replace = "";
	private matchCase = false;
	private scopeSubtree = false;

	constructor(
		app: App,
		private opts: {
			scopeLabel: string | null;
			count: (find: string, matchCase: boolean, subtree: boolean) => number;
			onRun: (find: string, replace: string, matchCase: boolean, subtree: boolean) => Promise<number>;
		},
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Search and replace");
		const summary = this.contentEl.createDiv({ cls: "trynalist-suggest-trail" });
		const paint = () => {
			if (!this.find) { summary.setText("Type something to find."); return; }
			const n = this.opts.count(this.find, this.matchCase, this.scopeSubtree);
			summary.setText(`${n} match${n === 1 ? "" : "es"} in ${this.scopeSubtree ? "this item and its children" : "the whole document"}.`);
		};
		new Setting(this.contentEl).setName("Find").addText((t) => {
			t.onChange((v) => { this.find = v; paint(); });
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).setName("Replace with")
			.setDesc("Leave empty to delete the matched text.")
			.addText((t) => t.onChange((v) => (this.replace = v)));
		new Setting(this.contentEl).setName("Match case")
			.addToggle((t) => t.setValue(false).onChange((v) => { this.matchCase = v; paint(); }));
		if (this.opts.scopeLabel) {
			new Setting(this.contentEl)
				.setName(`Only within "${this.opts.scopeLabel}"`)
				.setDesc("Off searches the whole document.")
				.addToggle((t) => t.setValue(false).onChange((v) => { this.scopeSubtree = v; paint(); }));
		}
		paint();
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText("Replace all").setCta().onClick(async () => {
				if (!this.find) { new Notice("Trynalist: nothing to find."); return; }
				this.close();
				const n = await this.opts.onRun(this.find, this.replace, this.matchCase, this.scopeSubtree);
				new Notice(`Trynalist: replaced ${n} occurrence${n === 1 ? "" : "s"}. Undo with the Trynalist undo command.`);
			}),
		);
	}

	onClose(): void { this.contentEl.empty(); }
}

/** The search-operator reference, as a dialog rather than a wall of text under
 *  the search box.
 *
 *  Written from OUR parser, not copied from Dynalist's help page — the two
 *  differ (we have no `within:`, they have no `has:children`), and a lifted
 *  list would quietly claim support we do not have. The page is credited and
 *  linked for the operators we inherited the syntax from. */
export class OperatorHelpModal extends Modal {
	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText("Search operators");
		contentEl.addClass("trynalist-operator-help");

		const groups: Array<[string, Array<[string, string]>]> = [
			["Matching", [
				['"exact phrase"', "The words together, in that order."],
				["-word", "Exclude items containing it."],
				["OR", "Either side — cat OR dog matches items with one or the other."],
			]],
			["State", [
				["is:completed", "Ticked items."],
				["is:heading", "Items set to any heading level."],
				["is:checklist", "Items in a checklist."],
				["is:numbered", "Items in a numbered list."],
				["is:collapsed", "Items whose children are folded away."],
				["is:recurring", "Items whose date repeats."],
				["heading:2", "Items at that heading level specifically."],
			]],
			["Content", [
				["has:note", "Items carrying a note."],
				["has:children", "Items with something underneath them."],
				["has:color", "Items with a colour label."],
				["has:checkbox", "Items showing a checkbox."],
				["has:date", "Items carrying a date."],
				["has:link", "Items containing a wikilink."],
				["color:red", "A specific colour — red, orange, yellow, green, blue, purple."],
			]],
			["Dates", [
				["within:1w", "Dated in the week ahead. Use -1w for the week behind."],
				["since:-1m", "Dated on or after that point."],
				["until:2w", "Dated on or before that point."],
				["created:-7d", "Created on or after that point."],
				["edited:-1d", "Edited on or after that point."],
			]],
			["Where to look", [
				["in:title", "Only the item's own text."],
				["in:note", "Only its note."],
			]],
			["Structure", [
				["parent:word", "Items whose immediate parent matches."],
				["ancestor:word", "Items with any ancestor that matches."],
			]],
		];
		for (const [heading, rows] of groups) {
			contentEl.createDiv({ cls: "trynalist-oh-heading", text: heading });
			const table = contentEl.createDiv({ cls: "trynalist-oh-table" });
			for (const [op, meaning] of rows) {
				const row = table.createDiv({ cls: "trynalist-oh-row" });
				row.createEl("code", { cls: "trynalist-oh-op", text: op });
				row.createSpan({ cls: "trynalist-oh-meaning", text: meaning });
			}
		}

		contentEl.createDiv({ cls: "trynalist-oh-heading", text: "Combining them" });
		const combining = contentEl.createDiv({ cls: "trynalist-oh-meaning" });
		combining.appendText("Operators stack: ");
		combining.createEl("code", { text: "is:completed has:note -draft" });
		combining.appendText(" finds ticked items that carry a note and do not mention "
			+ "\u201cdraft\u201d. Anything either side of OR is matched independently.");

		contentEl.createDiv({ cls: "trynalist-oh-heading", text: "Writing a date" });
		const dates = contentEl.createDiv({ cls: "trynalist-oh-meaning" });
		dates.appendText("Relative: a number with ");
		dates.createEl("code", { text: "d" });
		dates.appendText(" / ");
		dates.createEl("code", { text: "w" });
		dates.appendText(" / ");
		dates.createEl("code", { text: "m" });
		dates.appendText(" / ");
		dates.createEl("code", { text: "y" });
		dates.appendText(". A leading minus means the PAST — ");
		dates.createEl("code", { text: "-1w" });
		dates.appendText(" is a week back, ");
		dates.createEl("code", { text: "1w" });
		dates.appendText(" a week ahead. Also ");
		dates.createEl("code", { text: "today" });
		dates.appendText(", ");
		dates.createEl("code", { text: "tomorrow" });
		dates.appendText(", ");
		dates.createEl("code", { text: "yesterday" });
		dates.appendText(", or an absolute ");
		dates.createEl("code", { text: "2026-08-16" });
		dates.appendText(".");

		const credit = contentEl.createDiv({ cls: "trynalist-oh-credit" });
		credit.appendText("This syntax follows Dynalist's. Their reference — which covers "
			+ "operators Trynalist does not implement — is at ");
		credit.createEl("a", {
			text: "help.dynalist.io/article/93-search-operators-reference",
			href: "https://help.dynalist.io/article/93-search-operators-reference",
		});
		credit.appendText(".");
	}

	onClose(): void { this.contentEl.empty(); }
}

/** Full-size image viewer with a rail of every image in the document.
 *
 *  An inline image in an outline is necessarily small — it sits in a row. The
 *  rail is what makes this more than a lightbox: images in an outline are
 *  usually a set (screenshots of one thing, photos from one day), and finding
 *  the next one otherwise means closing this, scrolling, and clicking again. */
export class ImageViewerModal extends Modal {
	private at = 0;

	constructor(app: App, private images: TFile[], startPath: string) {
		super(app);
		const found = images.findIndex((f) => f.path === startPath);
		this.at = found >= 0 ? found : 0;
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass("trynalist-viewer-modal");
		contentEl.addClass("trynalist-viewer");
		this.scope.register([], "ArrowLeft", () => { this.step(-1); return false; });
		this.scope.register([], "ArrowRight", () => { this.step(1); return false; });
		this.paint();
	}

	private step(by: number): void {
		if (this.images.length < 2) return;
		// Wraps: a rail you can walk off the end of just stops working at the
		// edges, and there is no other way to reach the far end quickly.
		this.at = (this.at + by + this.images.length) % this.images.length;
		this.paint();
	}

	private paint(): void {
		const { contentEl } = this;
		contentEl.empty();
		const file = this.images[this.at];
		if (!file) { contentEl.createDiv({ text: "No image." }); return; }

		const stage = contentEl.createDiv({ cls: "trynalist-viewer-stage" });
		const img = stage.createEl("img", { cls: "trynalist-viewer-image" });
		img.src = this.app.vault.getResourcePath(file);
		img.alt = file.name;

		const bar = contentEl.createDiv({ cls: "trynalist-viewer-bar" });
		bar.createSpan({ cls: "trynalist-viewer-name", text: file.name });
		if (this.images.length > 1) {
			bar.createSpan({
				cls: "trynalist-viewer-count",
				text: `${this.at + 1} of ${this.images.length}`,
			});
		}

		if (this.images.length > 1) {
			const rail = contentEl.createDiv({ cls: "trynalist-viewer-rail" });
			this.images.forEach((f, i) => {
				const cell = rail.createDiv({
					cls: i === this.at ? "trynalist-viewer-thumb is-on" : "trynalist-viewer-thumb",
				});
				const thumb = cell.createEl("img");
				thumb.loading = "lazy";   // only what scrolls into view loads (L91)
				thumb.decoding = "async";
				thumb.src = this.app.vault.getResourcePath(f);
				thumb.alt = f.name;
				cell.setAttribute("aria-label", f.name);
				cell.addEventListener("click", () => { this.at = i; this.paint(); });
				if (i === this.at) {
					// Keep the current thumbnail in view when arrowing along a rail
					// wider than the dialog.
					window.setTimeout(() => cell.scrollIntoView({ block: "nearest", inline: "center" }), 0);
				}
			});
		}
	}

	onClose(): void { this.contentEl.empty(); }
}
