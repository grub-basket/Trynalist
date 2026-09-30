import { Platform, setIcon, setTooltip } from "obsidian";
import type { DocViewMode, NoteDisplay, TextDirection } from "./types";
import type { TrynalistDocView } from "./outline-view";

/** One choice in a row of pills. `null` means "follow the global setting". */
interface Choice<T> {
	label: string;
	value: T | null;
}

/** The per-document visibility popover, behind the eye in the header.
 *
 *  Every row offers a "Global" pill alongside the explicit ones, and Global
 *  says what it currently resolves to — "Global (show)". Without that you
 *  cannot tell what following the global setting will actually do without
 *  leaving to go and read the settings tab.
 *
 *  A document following the global setting is stored as the ABSENCE of an
 *  override, not as a copy of the global value. That is what makes changing a
 *  global setting move every document that has not been given its own answer. */
export class VisibilityMenu {
	private el: HTMLElement | null = null;
	private onOutside: ((e: MouseEvent) => void) | null = null;
	/** The window the popover opened in (a popout has its own document). */
	private outsideDoc: Document | null = null;

	constructor(private view: TrynalistDocView) {}

	get isOpen(): boolean { return !!this.el; }

	toggle(anchor: HTMLElement): void {
		if (this.el) { this.close(); return; }
		this.open(anchor);
	}

	open(anchor: HTMLElement): void {
		this.close();
		const el = anchor.doc.body.createDiv({ cls: "trynalist-visibility" });
		this.el = el;
		this.render();
		// Anchored under the eye, pulled back inside the window if it would run
		// off the right edge — the header sits at the top right of a pane that
		// can itself be narrow.
		const r = anchor.getBoundingClientRect();
		const width = el.offsetWidth || 300;
		// Mobile lays the popover out full width from the stylesheet (left/right
		// 8px), so the anchored left offset is skipped there instead of overridden.
		if (!Platform.isMobile) {
			el.style.left = `${Math.max(8, Math.min(r.right - width, anchor.win.innerWidth - width - 8))}px`;
		}
		el.style.top = `${r.bottom + 6}px`;
		// Deferred, or the click that OPENED the popover closes it immediately.
		window.setTimeout(() => {
			this.onOutside = (e: MouseEvent) => {
				const t = e.target as Node;
				if (el.contains(t) || anchor.contains(t)) return;
				this.close();
			};
			this.outsideDoc = anchor.doc;
			this.outsideDoc.addEventListener("mousedown", this.onOutside);
		}, 0);
	}

	close(): void {
		if (this.onOutside) this.outsideDoc?.removeEventListener("mousedown", this.onOutside);
		this.onOutside = null;
		this.el?.remove();
		this.el = null;
	}

	private render(): void {
		const el = this.el;
		if (!el) return;
		el.empty();
		const v = this.view;
		const globals = v.globalVisibility();

		this.row<boolean>(el, "Checked items", [
			{ label: `Global (${globals.hideCompleted ? "hide" : "show"})`, value: null },
			{ label: "Show", value: false },
			{ label: "Hide", value: true },
		], v.overrideOf("checked") as boolean | null, (value) => void v.setDocOverride("checked", value));

		this.row<NoteDisplay>(el, "Notes", [
			{ label: `Global (${globals.noteDisplay === "hidden" ? "hide"
				: globals.noteDisplay === "one-line" ? "1st line" : "show"})`, value: null },
			{ label: "Show", value: "full" },
			{ label: "1st line", value: "one-line" },
			{ label: "Hide", value: "hidden" },
		], v.overrideOf("notes") as NoteDisplay | null, (value) => void v.setDocOverride("notes", value));

		// Layout was already per-document — it belongs here because that is
		// exactly what this popover is for, and it is the same switch as the
		// breadcrumb's, not a second one. It gained a Global option once a global
		// default existed, so all four rows now behave the same way.
		const layoutNames: Record<DocViewMode, string> = {
			outline: "List", flat: "Flat", article: "Article", mindmap: "Mind map",
		};
		this.row<DocViewMode>(el, "Layout", [
			{ label: `Global (${layoutNames[globals.defaultViewMode]})`, value: null },
			{ label: "List", value: "outline" },
			{ label: "Flat", value: "flat" },
			{ label: "Article", value: "article" },
			{ label: "Mind map", value: "mindmap" },
		], v.layoutOverride(), (value) => void v.setViewModeOverride(value));

		this.row<TextDirection>(el, "Text direction", [
			{ label: `Global (${globals.textDirection.toUpperCase()})`, value: null },
			{ label: "Left-to-right", value: "ltr" },
			{ label: "Right-to-left", value: "rtl" },
		], v.overrideOf("direction") as TextDirection | null,
		(value) => void v.setDocOverride("direction", value));
	}

	/** A labelled row of pills. Exactly one is on: the document's override, or
	 *  the Global pill when it has none. */
	private row<T>(
		host: HTMLElement,
		title: string,
		choices: Array<Choice<T>>,
		current: T | null,
		onPick: (value: T | null) => void,
	): void {
		const section = host.createDiv({ cls: "trynalist-visibility-section" });
		section.createDiv({ cls: "trynalist-visibility-title", text: title.toUpperCase() });
		const row = section.createDiv({ cls: "trynalist-visibility-row" });
		for (const choice of choices) {
			const on = choice.value === current;
			const pill = row.createEl("button", {
				cls: on ? "trynalist-visibility-pill is-on" : "trynalist-visibility-pill",
				text: choice.label,
			});
			pill.setAttribute("aria-pressed", on ? "true" : "false");
			pill.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				onPick(choice.value);
				this.render();
			});
		}
	}

	/** Add the eye to a header, wired to this popover. */
	static mountButton(host: HTMLElement, menu: VisibilityMenu): HTMLElement {
		const btn = host.createSpan({ cls: "trynalist-eye" });
		setIcon(btn, "eye");
		setTooltip(btn, "What this document shows", { placement: "bottom" });
		btn.setAttribute("aria-label", "What this document shows");
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			menu.toggle(btn);
		});
		return btn;
	}
}
