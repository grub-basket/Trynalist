import { SuggestModal, setIcon } from "obsidian";
import { ITEM_ACTIONS } from "./mobile-toolbar";
import type { ToolbarAction } from "./mobile-toolbar";
import type { TrynalistDocView } from "./outline-view";

/** Mod+K: every item action, searchable, acting on the focused row.
 *
 *  Deliberately NOT Obsidian's command palette and not a file switcher. It
 *  answers one question — "what can I do to this item" — and the answer is the
 *  same list the mobile toolbar and the item menu draw from, so an action
 *  cannot exist in one surface and be missing from another. */
export class CommandBar extends SuggestModal<ToolbarAction> {
	constructor(private view: TrynalistDocView) {
		super(view.app);
		this.setPlaceholder("Action on this item…");
		this.limit = 50;
	}

	getSuggestions(query: string): ToolbarAction[] {
		const q = query.trim().toLowerCase();
		if (!q) return ITEM_ACTIONS;
		// Prefix matches first: typing "co" should reach Collapse before
		// "Duplicate current item", which merely contains the letters.
		const starts: ToolbarAction[] = [];
		const contains: ToolbarAction[] = [];
		for (const action of ITEM_ACTIONS) {
			const label = action.label.toLowerCase();
			if (label.startsWith(q)) starts.push(action);
			else if (label.includes(q)) contains.push(action);
		}
		return [...starts, ...contains];
	}

	renderSuggestion(action: ToolbarAction, el: HTMLElement): void {
		el.addClass("trynalist-command-row");
		setIcon(el.createSpan({ cls: "trynalist-command-icon" }), action.icon);
		el.createSpan({ cls: "trynalist-command-label", text: action.label });
	}

	onChooseSuggestion(action: ToolbarAction): void {
		// After the modal closes, so the action runs against the restored caret
		// rather than against the modal's own input.
		window.setTimeout(() => {
			void Promise.resolve(action.run(this.view)).catch((err) => {
				console.error(`Trynalist: command "${action.id}" failed`, err);
			});
		}, 0);
	}
}
