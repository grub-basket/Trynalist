import { App, Modal } from "obsidian";

/** Base for Trynalist's dialogs. On a phone Obsidian centres a modal on the
 *  whole screen and leaves it to the content to stay clear of the keyboard,
 *  which its own forms do through a class on their button row. Ours build
 *  their buttons with Setting, so this class marks them for styles.css. */
export class TrynalistModal extends Modal {
	constructor(app: App) {
		super(app);
		this.modalEl.addClass("trynalist-modal");
	}
}
