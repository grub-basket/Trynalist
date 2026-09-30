import { App, Modal, Notice, Platform, setIcon, setTooltip } from "obsidian";
import type TrynalistPlugin from "./main";
import type { TrynalistDocView } from "./outline-view";

/** One button on the mobile toolbar. `run` gets the view it belongs to. */
export interface ToolbarAction {
	id: string;
	label: string;
	icon: string;
	run: (view: TrynalistDocView) => void | Promise<void>;
}

/** Every action the toolbar can carry, in Dynalist's own order — the seventeen
 *  it ships enabled, then the four it keeps under "More actions".
 *
 *  Order here is the DEFAULT order, not the user's: what is shown and in what
 *  sequence lives in settings, so this list only has to stay complete. */
export const TOOLBAR_ACTIONS: ToolbarAction[] = [
	{ id: "outdent", label: "Unindent", icon: "indent-decrease", run: (v) => v.cmdIndent(true) },
	{ id: "indent", label: "Indent", icon: "indent-increase", run: (v) => v.cmdIndent(false) },
	// The magnifier the document itself uses, not the plain search glass.
	{ id: "zoom-in", label: "Zoom in", icon: "zoom-in", run: (v) => v.cmdZoomIn() },
	{ id: "edit-note", label: "Edit note", icon: "text", run: (v) => v.focusNoteOfFocused() },
	{ id: "check", label: "Check off", icon: "check", run: (v) => v.cmdToggleChecked() },
	{ id: "up", label: "Move item up", icon: "arrow-up", run: (v) => v.cmdMove(true) },
	{ id: "down", label: "Move item down", icon: "arrow-down", run: (v) => v.cmdMove(false) },
	{ id: "upload", label: "Upload a file", icon: "paperclip", run: (v) => v.uploadFileToFocused() },
	{ id: "move-to", label: "Move item", icon: "send", run: (v) => v.openMoveTo() },
	{ id: "checkbox", label: "Toggle checkbox", icon: "square", run: (v) => v.cmdToggleCheckbox() },
	{ id: "colour", label: "Set colour label", icon: "palette", run: (v) => v.cmdCycleColor() },
	{ id: "newline", label: "Insert new line", icon: "corner-down-left", run: (v) => v.cmdLineBreak() },
	{ id: "delete", label: "Delete", icon: "trash-2", run: (v) => v.cmdDeleteLine() },
	{ id: "open-trash", label: "Open trash", icon: "trash", run: (v) => v.openTrashPanel() },
	{ id: "heading", label: "Set heading level", icon: "heading", run: (v) => v.cmdCycleHeading() },
	{ id: "copy-link", label: "Copy item link", icon: "link", run: (v) => v.copyItemLink() },
	{ id: "date", label: "Add date", icon: "calendar", run: (v) => v.openDatePicker() },
	{ id: "duplicate", label: "Duplicate current item", icon: "copy", run: (v) => v.duplicateFocused() },
	// Dynalist's "More actions" — available, off by default.
	{ id: "hash-tag", label: "Insert hash tag", icon: "hash", run: (v) => v.insertAtCaret("#") },
	{ id: "at-tag", label: "Insert at tag", icon: "at-sign", run: (v) => v.insertAtCaret("@") },
	{ id: "export", label: "Export item", icon: "share", run: (v) => v.exportFocused() },
	{ id: "delete-checked", label: "Delete checked items", icon: "clipboard-x", run: (v) => v.cmdDeleteChecked() },
	// Menu-only actions, reachable from the command bar and available to the
	// toolbar customiser. Appended AFTER the "More actions" block so the
	// default-set slice below keeps meaning what it meant.
	{ id: "collapse", label: "Collapse or expand", icon: "chevrons-down-up", run: (v) => v.cmdToggleCollapse() },
	{ id: "collapse-all", label: "Collapse all", icon: "chevrons-down-up", run: (v) => v.cmdCollapseAll(true) },
	{ id: "expand-all", label: "Expand all", icon: "chevrons-up-down", run: (v) => v.cmdCollapseAll(false) },
	{ id: "collapse-siblings", label: "Collapse all siblings", icon: "fold-vertical", run: (v) => v.cmdCollapseSiblings(true) },
	{ id: "zoom-out", label: "Zoom out", icon: "zoom-out", run: (v) => v.cmdZoomOut() },
	{ id: "bookmark", label: "Bookmark this item", icon: "bookmark-plus", run: (v) => v.bookmarkFocusedItem() },
	{ id: "references", label: "Show all references", icon: "git-fork", run: (v) => v.showReferencesForFocused() },
	{ id: "replace", label: "Search and replace…", icon: "replace", run: (v) => v.openReplace() },
	{ id: "cleanup", label: "Clean up empty items", icon: "eraser", run: (v) => v.cmdCleanupEmpty() },
];

/** One list, three surfaces. The mobile toolbar, the command bar and the
 *  toolbar customiser all read this, so an action cannot exist in one and be
 *  quietly missing from another. */
export const ITEM_ACTIONS = TOOLBAR_ACTIONS;

/** Shown by default: everything down to and including Duplicate. */
export const DEFAULT_TOOLBAR: string[] = TOOLBAR_ACTIONS
	.slice(0, TOOLBAR_ACTIONS.findIndex((a) => a.id === "hash-tag"))
	.map((a) => a.id);

export function actionById(id: string): ToolbarAction | undefined {
	return TOOLBAR_ACTIONS.find((a) => a.id === id);
}

/** The keyboard accessory bar.
 *
 *  On a phone there is no Tab, no modifier chords and no right-click, so every
 *  structural action is otherwise unreachable — indenting an item is the whole
 *  point of an outliner and there was no way to do it. */
export class MobileToolbar {
	private el: HTMLElement | null = null;
	private onViewportChange: (() => void) | null = null;

	constructor(private view: TrynalistDocView, private plugin: TrynalistPlugin) {}

	get isMounted(): boolean { return !!this.el; }

	mount(container: HTMLElement): void {
		if (this.el || !MobileToolbar.shouldShow()) return;
		this.el = container.createDiv({ cls: "trynalist-mobile-toolbar" });
		this.renderButtons();
		this.trackKeyboard();
	}

	/** Rebuild the strip from settings — called on mount and whenever the
	 *  customise dialog saves, so a reorder shows up without a reload. */
	renderButtons(): void {
		const bar = this.el;
		if (!bar) return;
		bar.empty();
		// Horizontal scroll rather than wrapping or squeezing: the actions do
		// not fit a phone's width, and a bar that reflows to two rows eats the
		// little screen the outline itself has.
		const strip = bar.createDiv({ cls: "trynalist-mobile-toolbar-strip" });
		const chosen = this.plugin.settings.mobileToolbar?.length
			? this.plugin.settings.mobileToolbar
			: DEFAULT_TOOLBAR;
		for (const id of chosen) {
			const action = actionById(id);
			if (!action) continue;   // an id from a newer version, or a removed one
			this.addButton(strip, action.icon, action.label, () => {
				void Promise.resolve(action.run(this.view)).catch((err) => {
					console.error(`Trynalist: toolbar action "${action.id}" failed`, err);
					new Notice(`Trynalist: "${action.label}" failed — see the console.`);
				});
			});
		}
		// Pinned last, as Dynalist does, and outside the scrolling strip would
		// cost width the actions need — so it simply sits at the end.
		this.addButton(strip, "settings", "Customise toolbar", () => {
			new CustomiseToolbarModal(this.plugin.app, this.plugin, () => this.renderButtons()).open();
		});
	}

	private addButton(strip: HTMLElement, icon: string, label: string, onTap: () => void): void {
		const btn = strip.createEl("button", { cls: "trynalist-mobile-tool" });
		setIcon(btn.createSpan({ cls: "trynalist-mobile-tool-icon" }), icon);
		// Above the button: the bar sits at the bottom of the screen, so a
		// tooltip placed below it is off-screen or under the keyboard.
		setTooltip(btn, label, { placement: "top" });
		btn.setAttribute("aria-label", label);
		// The row being edited must KEEP focus. A plain click blurs the
		// contenteditable first, which collapses the caret and takes the
		// keyboard down — so the action would run against nothing.
		btn.addEventListener("pointerdown", (e) => e.preventDefault());
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onTap();
		});
	}

	/** Sit directly above the on-screen keyboard.
	 *
	 *  `position: fixed; bottom: 0` is wrong on iOS: the visual viewport shrinks
	 *  when the keyboard opens but the layout viewport does not, so the bar
	 *  stays pinned to the bottom of the PAGE, underneath the keyboard. The gap
	 *  between the two viewports is exactly the keyboard's height. */
	private trackKeyboard(): void {
		const vv = window.visualViewport;
		if (!vv || !this.el) return;
		const apply = (): void => {
			if (!this.el) return;
			const hidden = window.innerHeight - vv.height - vv.offsetTop;
			this.el.style.bottom = `${Math.max(0, hidden)}px`;
		};
		this.onViewportChange = apply;
		vv.addEventListener("resize", apply);
		vv.addEventListener("scroll", apply);
		apply();
	}

	unmount(): void {
		const vv = window.visualViewport;
		if (vv && this.onViewportChange) {
			vv.removeEventListener("resize", this.onViewportChange);
			vv.removeEventListener("scroll", this.onViewportChange);
		}
		this.onViewportChange = null;
		this.el?.remove();
		this.el = null;
	}

	/** Phones and tablets in mobile mode. */
	static shouldShow(): boolean {
		return Platform.isMobile;
	}
}

/** Dynalist's "Customize toolbar" screen: added actions in order, each with
 *  remove and move controls, then the ones left over. */
class CustomiseToolbarModal extends Modal {
	private chosen: string[];

	constructor(app: App, private plugin: TrynalistPlugin, private onSave: () => void) {
		super(app);
		this.chosen = [...(plugin.settings.mobileToolbar?.length
			? plugin.settings.mobileToolbar
			: DEFAULT_TOOLBAR)];
	}

	onOpen(): void {
		this.titleEl.setText("Customise toolbar");
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("trynalist-customise-toolbar");

		contentEl.createDiv({ cls: "trynalist-customise-head", text: "Added actions" });
		const added = contentEl.createDiv();
		if (!this.chosen.length) {
			added.createDiv({ cls: "trynalist-customise-empty", text: "No actions — the bar will be empty." });
		}
		this.chosen.forEach((id, at) => {
			const action = actionById(id);
			if (!action) return;
			const row = added.createDiv({ cls: "trynalist-customise-row" });
			this.iconButton(row, "minus-circle", `Remove ${action.label}`, "is-remove", () => {
				this.chosen.splice(at, 1);
				this.render();
			});
			setIcon(row.createSpan({ cls: "trynalist-customise-icon" }), action.icon);
			row.createSpan({ cls: "trynalist-customise-label", text: action.label });
			const moves = row.createDiv({ cls: "trynalist-customise-moves" });
			// The first row has no "up" and the last no "down", rather than dead
			// buttons that look tappable and do nothing.
			if (at > 0) {
				this.iconButton(moves, "arrow-up", `Move ${action.label} up`, "", () => {
					[this.chosen[at - 1], this.chosen[at]] = [this.chosen[at], this.chosen[at - 1]];
					this.render();
				});
			}
			if (at < this.chosen.length - 1) {
				this.iconButton(moves, "arrow-down", `Move ${action.label} down`, "", () => {
					[this.chosen[at + 1], this.chosen[at]] = [this.chosen[at], this.chosen[at + 1]];
					this.render();
				});
			}
		});

		const rest = TOOLBAR_ACTIONS.filter((a) => !this.chosen.includes(a.id));
		if (rest.length) {
			contentEl.createDiv({ cls: "trynalist-customise-head", text: "More actions" });
			const more = contentEl.createDiv();
			for (const action of rest) {
				const row = more.createDiv({ cls: "trynalist-customise-row" });
				this.iconButton(row, "plus-circle", `Add ${action.label}`, "is-add", () => {
					this.chosen.push(action.id);
					this.render();
				});
				setIcon(row.createSpan({ cls: "trynalist-customise-icon" }), action.icon);
				row.createSpan({ cls: "trynalist-customise-label", text: action.label });
			}
		}

		const foot = contentEl.createDiv({ cls: "trynalist-customise-foot" });
		const reset = foot.createEl("button", { text: "Reset to default" });
		reset.addEventListener("click", () => { this.chosen = [...DEFAULT_TOOLBAR]; this.render(); });
		const save = foot.createEl("button", { cls: "mod-cta", text: "Save" });
		save.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.mobileToolbar = [...this.chosen];
				await this.plugin.saveSettings();
				this.onSave();
				this.close();
			})();
		});
	}

	private iconButton(
		host: HTMLElement, icon: string, label: string, extra: string, onClick: () => void,
	): void {
		const btn = host.createEl("button", {
			cls: `trynalist-customise-btn ${extra}`.trim(),
		});
		setIcon(btn, icon);
		setTooltip(btn, label, { placement: "top" });
		btn.setAttribute("aria-label", label);
		btn.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Human labels for item-menu entry ids. The menu builds its own titles from
 *  the item (Add note / Edit note), so the customiser needs its own names —
 *  and a separator has to be nameable to be movable. */
export const MENU_ENTRY_LABELS: Record<string, string> = {
	"collapse": "Collapse / Expand",
	"folding": "Folding \u25b8",
	"customise": "Customise this menu\u2026",
	"collapse-all": "Collapse all",
	"expand-all": "Expand all",
	"expand-to-level": "Expand to level ▸",
	"collapse-siblings": "Collapse all siblings",
	"zoom-in": "Zoom in",
	"add-note": "Add / Edit note",
	"indent": "Indent",
	"unindent": "Unindent",
	"move-to": "Move to…",
	"bookmark": "Bookmark this item",
	"deep-link": "Copy deep link",
	"deep-link-zoom": "Copy deep link (zoomed in)",
	"copy-mirror": "Copy as mirror",
	"paste-mirror": "Paste mirror",
	"paste-portal": "Paste portal",
	"copy": "Copy (with children)",
	"cut": "Cut (with children)",
	"copy-timestamps": "Copy with creation timestamps",
	"duplicate": "Duplicate (with children)",
	"date": "Add / Edit date",
	"check": "Check off / Uncheck",
	"checkbox": "Add / Remove checkbox",
	"checkbox-children": "Add checkbox to children",
	"uncheckbox-children": "Remove checkboxes from children",
	"set-inbox": "Set as inbox",
	"numbered": "Number children",
	"cycle-heading": "Cycle heading",
	"cycle-colour": "Cycle colour",
	"sort": "Sort children ▸",
	"references": "Show all references",
	"history": "Item history…",
	"export": "Export…",
	"replace": "Search and replace…",
	"template": "Insert template…",
	"delete-checked": "Delete checked items",
	"delete": "Delete (with children)",
};

export function menuEntryLabel(id: string): string {
	if (id.startsWith("sep")) return "— separator —";
	const known = MENU_ENTRY_LABELS[id];
	if (known) return known;
	// Derive something readable rather than showing an internal id. The map has
	// to be kept in step with the menu by hand, and it will fall behind — a new
	// entry then appeared in the customiser as "folding" or "customise", which
	// reads as a bug rather than a missing translation. This is the floor.
	return id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Reorder and hide item-menu entries. Same shape as the toolbar customiser,
 *  because it is the same job — but here everything starts shown, so it is a
 *  visibility toggle rather than an added/available split. */
export class CustomiseMenuModal extends Modal {
	private order: string[];
	private hidden: Set<string>;

	constructor(
		app: App,
		private plugin: TrynalistPlugin,
		private catalogue: string[],
		private onSave: () => void,
	) {
		super(app);
		const saved = plugin.settings.itemMenuOrder ?? [];
		// Saved order first, then anything it has never seen — the same rule the
		// menu itself applies, so this screen shows the real order.
		const known = saved.filter((id) => catalogue.includes(id));
		this.order = [...known, ...catalogue.filter((id) => !known.includes(id))];
		this.hidden = new Set(plugin.settings.itemMenuHidden ?? []);
	}

	onOpen(): void {
		this.titleEl.setText("Customise the item menu");
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("trynalist-customise-toolbar");
		contentEl.createDiv({
			cls: "trynalist-customise-empty",
			text: "Right-click an item to see this menu. Hidden entries stay available from Mod+K.",
		});
		this.order.forEach((id, at) => {
			const row = contentEl.createDiv({ cls: "trynalist-customise-row" });
			const shown = !this.hidden.has(id);
			const eye = row.createEl("button", {
				cls: `trynalist-customise-btn ${shown ? "is-add" : "is-remove"}`,
			});
			setIcon(eye, shown ? "eye" : "eye-off");
			setTooltip(eye, shown ? `Hide ${menuEntryLabel(id)}` : `Show ${menuEntryLabel(id)}`,
				{ placement: "top" });
			eye.setAttribute("aria-label", shown ? `Hide ${menuEntryLabel(id)}` : `Show ${menuEntryLabel(id)}`);
			eye.addEventListener("click", () => {
				if (shown) this.hidden.add(id); else this.hidden.delete(id);
				this.render();
			});
			const label = row.createSpan({ cls: "trynalist-customise-label", text: menuEntryLabel(id) });
			if (!shown) label.addClass("is-hidden-entry");
			const moves = row.createDiv({ cls: "trynalist-customise-moves" });
			if (at > 0) this.move(moves, id, at, -1);
			if (at < this.order.length - 1) this.move(moves, id, at, 1);
		});

		const foot = contentEl.createDiv({ cls: "trynalist-customise-foot" });
		const reset = foot.createEl("button", { text: "Reset to default" });
		reset.addEventListener("click", () => {
			this.order = [...this.catalogue];
			this.hidden.clear();
			this.render();
		});
		const save = foot.createEl("button", { cls: "mod-cta", text: "Save" });
		save.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.itemMenuOrder = [...this.order];
				this.plugin.settings.itemMenuHidden = [...this.hidden];
				await this.plugin.saveSettings();
				this.onSave();
				this.close();
			})();
		});
	}

	private move(host: HTMLElement, id: string, at: number, by: number): void {
		const btn = host.createEl("button", { cls: "trynalist-customise-btn" });
		setIcon(btn, by < 0 ? "arrow-up" : "arrow-down");
		const what = `Move ${menuEntryLabel(id)} ${by < 0 ? "up" : "down"}`;
		setTooltip(btn, what, { placement: "top" });
		btn.setAttribute("aria-label", what);
		btn.addEventListener("click", () => {
			[this.order[at + by], this.order[at]] = [this.order[at], this.order[at + by]];
			this.render();
		});
	}

	onClose(): void { this.contentEl.empty(); }
}
