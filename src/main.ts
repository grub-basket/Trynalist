import { Menu, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath, TAbstractFile, Platform, AbstractInputSuggest, App } from "obsidian";
import type { TextComponent } from "obsidian";
import type { Modifier } from "obsidian";
import { TrynalistPanelView } from "./panel-view";
import { TrynalistDocView } from "./outline-view";
import { CustomiseMenuModal } from "./mobile-toolbar";
import { GLOBAL_SEARCH_VIEW, GlobalSearchView } from "./global-search-view";
import { DocIndex, appendItemFile, checkIntegrity, createDoc, duplicateDoc, invalidateDocItems, invalidateDocScan, listDocs, reattachOrphans } from "./store";
import { BookmarkSuggestModal, DocSuggestModal, GlobalSearchModal } from "./search";
import { ImportTextModal, IntegrityModal, PromptModal, DynalistTokenModal } from "./modals";
import { exportDocZip } from "./export";
import { announce, collectDue, dueForNotice, inQuietHours } from "./reminders";
import { isOverdue } from "./dates";
import { importVaultFile, parseImport, writeImport } from "./import";
import { importEntireAccount, resumeImport, findResumable, updateExistingImport, readFailures, listAccountDocuments, testToken } from "./dynalist-api";
import type { ImportOptions } from "./dynalist-api";
import { openImportDiff } from "./import-diff";
import { openLinkAudit } from "./link-audit";
import { DocSelectModal } from "./doc-select";
import { writeImportReport, writeUpdateReport } from "./import-report";
import { openTrash, listTrash, emptyTrash } from "./trash";
import { keychainAvailable, getToken, setToken, findDynalistSecretIds, importFromKeychain, legacyDecrypt, TOKEN_SECRET_ID } from "./secret-store";
import { exportCollection, restoreCollection } from "./backup";
import { convertFolder, detectFolderKind } from "./convert";
import { AttachmentsModal } from "./attachments";
import { invalidateMirrorPresenceIfTrue, noteFileMirrorState } from "./mirrors";
import {
	AgendaPane, ArchivePane, BookmarksPane, FilesPane, RecentPane, TagsPane,
	AGENDA_VIEW_TYPE, ARCHIVE_VIEW_TYPE, BOOKMARKS_VIEW_TYPE, FILES_VIEW_TYPE,
	PANE_TYPES, RECENT_VIEW_TYPE, TAGS_VIEW_TYPE,
} from "./panels";
import { ConfirmModal } from "./modals";
import { SafetyNet, SAFETY_DIR } from "./safety-net";
import { ItemHistory } from "./item-history";
import { RecentlyDeletedModal } from "./history-modal";
import { mergeSettings, stableStringify } from "./settings-merge";
import type { OutlineSnapshot, SettingsSnapshot } from "./safety-net";
import { TFolder } from "obsidian";
import { FuzzySuggestModal } from "obsidian";
import type { DueItem, ReminderState } from "./reminders";
import type { ClipNode } from "./types";
import type { Bookmark, Density, DocManifest, DocRef, DocViewMode, NoteDisplay, TextDirection, TrynalistSettings } from "./types";
import { DEFAULT_SETTINGS, DOC_EXTENSION, DOC_VIEW_TYPE, MAX_HEADING, PANEL_VIEW_TYPE, isReservedFolderName } from "./types";

/** File types Obsidian displays itself; anything else leaves the app. */
const OPENS_IN_OBSIDIAN = new Set([
	"md", "canvas", "base", "pdf", DOC_EXTENSION,
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif",
	"mp3", "wav", "m4a", "ogg", "3gp", "flac", "webm", "mp4", "ogv", "mov", "mkv",
]);

export default class TrynalistPlugin extends Plugin {
	settings: TrynalistSettings = { ...DEFAULT_SETTINGS };
	/** Default chords for document commands. The store forbids `hotkeys` on
	 *  addCommand, so instead each open document view registers these in its
	 *  own keymap scope (see TrynalistDocView's constructor): live only while
	 *  the keyboard is inside a document, and off entirely when the
	 *  `builtinShortcuts` setting is. `fire(true)` asks whether the command
	 *  applies right now, exactly like a checkCallback. */
	viewChords: Array<{ modifiers: Modifier[]; key: string; fire: (checking: boolean) => boolean }> = [];
	safetyNet: SafetyNet | null = null;
	itemHistory: ItemHistory | null = null;
	/** True while a Dynalist import runs, so a second can't start on top of it.
	 *  Session-only: an import doesn't survive a reload anyway. */
	private dynalistImportActive = false;
	/** Flipped by the progress notice's Cancel button; polled by the importer. */
	private dynalistCancel = { cancelled: false };

	/** True while a Dynalist import/update runs — panels use it to pause their
	 *  per-file-event re-renders, which would otherwise re-scan the vault hundreds
	 *  of times during a bulk write. */
	isImporting(): boolean { return this.dynalistImportActive; }
	/** The item currently held as a mirror source, set from an item's menu.
	 *  Session-only on purpose: a stale reference surviving a restart would be
	 *  a worse experience than picking the source again. */
	mirrorClipboard: { ref: string; label: string } | null = null;
	/** The items last copied or cut in Trynalist, in full, with the exact
	 *  plain text that went to the system clipboard. A paste whose text is
	 *  still that text rebuilds the items from here — colour, heading,
	 *  checkbox, notes, in-item line breaks and all — instead of re-parsing
	 *  the outline text, which cannot carry them (M7/M8). Anything else on the
	 *  clipboard (copied elsewhere since) pastes as text, as before.
	 *  Session-only, like mirrorClipboard. */
	itemClipboard: { text: string; nodes: ClipNode[] } | null = null;

	/** The main window's document plus every popout's. */
	private openDocuments(): Set<Document> {
		const docs = new Set<Document>([document]);
		this.app.workspace.iterateAllLeaves((leaf) => { docs.add(leaf.view.containerEl.doc); });
		return docs;
	}

	/** Body-level classes driven by settings, on every window — or only on
	 *  `only`, a window that has just opened. */
	applyBodyClasses(only?: Document): void {
		for (const doc of only ? [only] : this.openDocuments()) {
			doc.body.toggleClass("trynalist-no-strike", !this.settings.strikeCompleted);
		}
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new TrynalistSettingTab(this));
		this.applyBodyClasses();
		// Popout windows have their own <body>; a new one gets the classes too.
		this.registerEvent(this.app.workspace.on("window-open", (_w, win) => this.applyBodyClasses(win.document)));
		// Typing that has not been saved yet must reach disk before the app goes
		// away: Obsidian waits for tasks added to "quit", and a phone may kill a
		// backgrounded app without another event (M37).
		// Item history's pending minute goes after them, so it records the save.
		this.registerEvent(this.app.workspace.on("quit", (tasks) => tasks.add(async () => {
			await this.flushOpenDocs(true);
			await this.itemHistory?.flush(true);
		})));
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				// On a phone the app may be killed next: write unsettled moves too.
				void this.flushOpenDocs(Platform.isMobile).then(() => this.itemHistory?.flush(Platform.isMobile));
			}
		});
		this.register(() => { for (const doc of this.openDocuments()) doc.body.removeClass("trynalist-no-strike"); });

		this.registerView(PANEL_VIEW_TYPE, (leaf) => new TrynalistPanelView(leaf, this));
		this.registerView(DOC_VIEW_TYPE, (leaf) => new TrynalistDocView(leaf, this));
		this.registerExtensions([DOC_EXTENSION], DOC_VIEW_TYPE);
		this.patchOpenFileForNewTab();
		// Dynalist keeps files, bookmarks and tags in separate panes. The
		// combined Documents panel stays; these are the individual ones.
		this.registerView(FILES_VIEW_TYPE, (leaf) => new FilesPane(leaf, this));
		this.registerView(BOOKMARKS_VIEW_TYPE, (leaf) => new BookmarksPane(leaf, this));
		this.registerView(TAGS_VIEW_TYPE, (leaf) => new TagsPane(leaf, this));
		this.registerView(RECENT_VIEW_TYPE, (leaf) => new RecentPane(leaf, this));
		this.registerView(AGENDA_VIEW_TYPE, (leaf) => new AgendaPane(leaf, this));
		this.registerView(ARCHIVE_VIEW_TYPE, (leaf) => new ArchivePane(leaf, this));

		this.addRibbonIcon("list-tree", "Trynalist panel", () => void this.openPanel());
		// No MathJax warm-up here: loading it at every startup cost time for
		// vaults with no maths, and its ready callback then re-rendered every
		// open document a second time (L88). Rows that contain maths load it
		// on demand (render.ts onMathReady) and repaint once it is ready.
		// One place that turns vault events into cache invalidations. Three
		// caches hang off these: the document scan (every manifest read), the
		// due-item list (every item's frontmatter), and "does any mirror exist".
		// Each is invalidated by exactly the events that can change its answer —
		// the old rule of "any event anywhere, drop everything" meant the plugin's
		// own per-keystroke saves defeated every cache it had.
		// The overloads are per-event, so register them one at a time.
		const underRoot = (path: string): boolean => path === this.settings.rootFolder || path.startsWith(`${this.settings.rootFolder}/`);
		// The document scan lists folders and `.trynalist` manifests; an item
		// file appearing or going cannot change it. Rescanning on every one —
		// the first save of every new bullet creates a file — re-read every
		// manifest behind the panel on ordinary typing (M60).
		const structural = (path: string, isItemFile: boolean, removal: boolean): void => {
			if (!underRoot(path)) return;
			invalidateDocItems(path);
			if (!isItemFile) invalidateDocScan();
			// A new item's due date arrives through the metadata cache's
			// "changed" event below; only a removal or rename can take one away.
			if (!isItemFile || removal) this.dueGen++;
			// Removing a file is the only way a cached "yes, mirrors exist" can
			// become wrong; a cached "no" cannot become wrong by a removal.
			if (removal) invalidateMirrorPresenceIfTrue();
		};
		const isItem = (f: TAbstractFile): boolean => f instanceof TFile && f.extension === "md";
		this.registerEvent(this.app.vault.on("create", (f) => structural(f.path, isItem(f), false)));
		this.registerEvent(this.app.vault.on("delete", (f) => structural(f.path, isItem(f), true)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => { structural(f.path, isItem(f), true); structural(old, isItem(f), true); }));
		// Per-item edit history (safety net): every item change, local or synced.
		this.registerEvent(this.app.vault.on("create", (f) => { if (f instanceof TFile) this.itemHistory?.note("create", f.path, f); }));
		this.registerEvent(this.app.vault.on("modify", (f) => { if (f instanceof TFile) this.itemHistory?.note("edit", f.path, f); }));
		this.registerEvent(this.app.vault.on("delete", (f) => { if (f instanceof TFile) this.itemHistory?.note("delete", f.path, f); }));
		this.registerEvent(this.app.vault.on("rename", (f, old) => { if (f instanceof TFile) this.itemHistory?.noteRename(f, old); }));
		// Per-document settings, Recents and bookmarks are keyed by the manifest's
		// path; renaming or moving a document used to orphan them all (L35).
		this.registerEvent(this.app.vault.on("rename", (f, old) => {
			if (underRoot(f.path) || underRoot(old)) this.movePathKeys(old, f.path, f instanceof TFolder);
		}));
		this.registerEvent(this.app.vault.on("modify", (f) => {
			// A manifest edit changes titles/archived flags: rescan. An item edit
			// changes nothing structural — the caches below key off the metadata
			// cache's own "changed" event, which fires once the file is indexed.
			if (f instanceof TFile && f.extension === DOC_EXTENSION && underRoot(f.path)) invalidateDocScan();
			// The shared read-only document cache (L75) does care about items.
			if (underRoot(f.path)) invalidateDocItems(f.path);
		}));
		this.registerEvent(this.app.metadataCache.on("changed", (f, _data, cache) => {
			if (!underRoot(f.path)) return;
			// Frontmatter is read from this cache, so a load that raced the
			// indexer must not stay cached.
			invalidateDocItems(f.path);
			// Only an item that has a due date, or had one on the agenda, can
			// change the agenda; bumping on every save recomputed it per keystroke
			// save (M60).
			const had = this.dueCache?.items.some((i) => i.filePath === f.path) ?? true;
			if (had || !!cache?.frontmatter?.due) this.dueGen++;
			noteFileMirrorState(!!cache?.frontmatter?.mirrorOf);
		}));
		this.registerReminderWatch();
		this.registerBuildWatch();
		this.registerView(GLOBAL_SEARCH_VIEW, (leaf) => new GlobalSearchView(leaf, this));
		this.registerTabReturn();
		this.registerDeepLinks();
		this.addCommand({
			id: "open-panel",
			name: "Open documents panel",
			callback: () => void this.openPanel(),
		});
		for (const [type, label] of PANE_TYPES) {
			this.addCommand({
				id: `open-${type}`,
				name: `Open the ${label.toLowerCase()} pane`,
				callback: () => void this.openPane(type),
			});
		}
		this.addCommand({
			id: "search-all",
			name: "Search all documents…",
			callback: () => {
				new GlobalSearchModal(this.app, this.settings.rootFolder, (hit) => {
					void this.openDocFile(hit.doc.file, hit.node.id);
				}, this.settings.searchArchived).open();
			},
		});
		this.addCommand({
			id: "search-all-including-archived",
			name: "Search all documents, archived included…",
			callback: () => {
				new GlobalSearchModal(this.app, this.settings.rootFolder, (hit) => {
					void this.openDocFile(hit.doc.file, hit.node.id);
				}, true).open();
			},
		});
		this.addCommand({
			id: "open-bookmark",
			name: "Open bookmark…",
			callback: () => {
				const bms = this.settings.bookmarks;
				if (!bms.length) { new Notice("Trynalist: no bookmarks saved yet."); return; }
				new BookmarkSuggestModal(this.app, bms, (bm) => void this.openBookmark(bm)).open();
			},
		});
		this.addCommand({
			id: "jump-to-document",
			name: "Jump to document…",
			callback: () => void this.openDocJump(),
		});
		this.addCommand({
			id: "new-document",
			name: "New document…",
			callback: () => {
				new PromptModal(this.app, {
					title: "New Trynalist document",
					label: "Title",
					cta: "Create",
					onSubmit: async (title) => {
						const ref = await createDoc(this.app, this.settings.rootFolder, title);
						await this.openDoc(ref);
					},
				}).open();
			},
		});
		// Structural undo/redo DO take Mod+Z / Mod+Shift+Z — but only while there
		// is a structural change on the stack. With an empty stack the check
		// returns false, the chord falls through, and the row's own native text
		// undo handles typing as before. Leaving them unbound (the original
		// choice, to protect that native undo) meant Mod+Z did nothing at all
		// for structure, which read as "there is no undo".
		// The store forbids default `hotkeys` on a command, so the chords live
		// in the document view's scope instead (`viewChords`): same gating, same
		// fall-through when the check fails, and Obsidian's hotkey settings can
		// still bind anything on top.
		const chorded = (
			id: string, name: string,
			checkCallback: (checking: boolean) => boolean,
			hotkeys: Array<{ modifiers: Modifier[]; key: string }>,
		) => {
			this.addCommand({ id, name, checkCallback });
			for (const h of hotkeys) this.viewChords.push({ ...h, fire: checkCallback });
		};
		chorded("undo-structural", "Undo last structural change", (checking) => {
			const view = this.activeFocusedDoc();
			if (!view || !view.canUndo()) return false;
			if (!checking) void view.undo();
			return true;
		}, [{ modifiers: ["Mod"], key: "z" }]);
		// Mod+Y as well: the Windows/Linux redo convention, and one the user
		// asked for explicitly.
		chorded("redo-structural", "Redo structural change", (checking) => {
			const view = this.activeFocusedDoc();
			if (!view || !view.canRedo()) return false;
			if (!checking) void view.redo();
			return true;
		}, [{ modifiers: ["Mod", "Shift"], key: "z" }, { modifiers: ["Mod"], key: "y" }]);
		// Copy/cut of a BLOCK selection have to be commands. Selecting rows
		// clears the native text selection, and a browser fires no `copy` event
		// when nothing is natively selected — so the event handler alone was
		// unreachable and Mod+C did nothing. Gated on a block selection existing,
		// so with ordinary text selected the chord still does the native copy.
		this.addCommand({
			id: "copy-items",
			name: "Copy selection, or the current item (with children)",
			checkCallback: (checking) => {
				const view = this.activeFocusedDoc();
				if (!view || !view.hasLineTarget()) return false;
				if (!checking) void view.cmdCopyItems(false);
				return true;
			},
		});
		this.addCommand({
			id: "cut-items",
			name: "Cut selection, or the current item (with children)",
			checkCallback: (checking) => {
				const view = this.activeFocusedDoc();
				if (!view || !view.hasLineTarget()) return false;
				if (!checking) void view.cmdCopyItems(true);
				return true;
			},
		});
		// A Trynalist document is a FOLDER plus a manifest, so Obsidian's own
		// "duplicate this file" copies the manifest alone and produces a broken
		// second document. This does the real thing.
		this.addCommand({
			id: "duplicate-document",
			name: "Duplicate this document",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
				const doc = view?.docRef();
				if (!doc) return false;
				if (!checking) void this.duplicateCurrentDoc(doc);
				return true;
			},
		});
		{
			this.addCommand({
				id: "doc-scale-up",
				name: "Text size: bigger (this document)",
				checkCallback: (checking) => {
					const view = this.activeFocusedDoc();
					if (!view) return false;
					if (!checking) void view.setDocScale(view.effectiveScale() + 10);
					return true;
				},
			});
			this.addCommand({
				id: "doc-scale-down",
				name: "Text size: smaller (this document)",
				checkCallback: (checking) => {
					const view = this.activeFocusedDoc();
					if (!view) return false;
					if (!checking) void view.setDocScale(view.effectiveScale() - 10);
					return true;
				},
			});
			this.addCommand({
				id: "doc-scale-reset",
				name: "Text size: use the global setting (this document)",
				checkCallback: (checking) => {
					const view = this.activeFocusedDoc();
					if (!view) return false;
					if (!checking) void view.setDocScale(null);
					return true;
				},
			});
		}
		// Mod+D is NOT registered here: core already binds it to
		// editor:delete-paragraph, and a contested chord resolves
		// unpredictably. The row's own keydown handles Mod+D instead.
		chorded("delete-line", "Delete the current item (with children)", (checking) => {
			const view = this.activeFocusedDoc();
			if (!view || !view.hasDeleteTarget()) return false;
			if (!checking) void view.cmdDeleteLine();
			return true;
		}, [{ modifiers: ["Mod", "Shift"], key: "k" }]);
		this.addCommand({
			id: "copy-with-timestamps",
			name: "Copy with creation timestamps",
			checkCallback: (checking) => {
				const view = this.activeFocusedDoc();
				if (!view || !view.hasLineTarget()) return false;
				if (!checking) void view.cmdCopyItems(false, true);
				return true;
			},
		});
		this.addCommand({
			id: "duplicate-item",
			name: "Duplicate item (with children)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
				if (!view) return false;
				if (!checking) void view.duplicateFocused();
				return true;
			},
		});
		/** A command that only fires while the keyboard is actually inside a
		 *  Trynalist document — see `activeFocusedDoc`. That gate is what makes
		 *  default hotkeys safe: with anything else focused, including another
		 *  plugin's sidebar input or a popout window, the check returns false and
		 *  the chord falls through to whoever should get it. */
		const viewCommand = (
			id: string,
			name: string,
			run: (v: TrynalistDocView) => void,
			hotkeys?: Array<{ modifiers: Modifier[]; key: string }>,
		) => {
			chorded(id, name, (checking) => {
				const view = this.activeFocusedDoc();
				if (!view) return false;
				if (!checking) run(view);
				return true;
			}, hotkeys ?? []);
		};
		// Dynalist's own chords, including the ones that overlap universal
		// editing — Mod+A, Mod+F, Mod+Up/Down, Mod+[ / Mod+].
		//
		// These were unbound in 0.28.2 while a Mod+A conflict with another
		// plugin's composer was being chased. That turned out NOT to be ours,
		// and the parity is worth having, so they are back. What makes them
		// safe is `activeFocusedDoc`: every one of these fires only while the
		// keyboard is genuinely inside a Trynalist document, so a sidebar
		// input, a search box or another plugin's pane keeps its own binding.
		// Anyone who wants them gone turns off "Built-in shortcuts" in settings
		// and binds their own in Obsidian's hotkey settings.
		const key = (k: string, ...modifiers: Modifier[]) => [{ modifiers, key: k }];
		// Every item-menu action is also a command, so any of them can be given
		// a hotkey. No defaults — Obsidian's own bindings own most chords.
		viewCommand("cleanup-empty", "Clean up empty items", (v) => void v.cmdCleanupEmpty());
		viewCommand("insert-line-break", "Line break inside the item",
			(v) => v.cmdLineBreak(), key("Enter", "Alt"));
		viewCommand("zoom-in", "Zoom in to item", (v) => v.cmdZoomIn(), key("]", "Mod"));
		viewCommand("zoom-out", "Zoom out one level", (v) => v.cmdZoomOut(), key("[", "Mod"));
		viewCommand("toggle-collapse", "Collapse / expand item", (v) => void v.cmdToggleCollapse(), key(".", "Mod"));
		viewCommand("collapse-all", "Collapse all", (v) => void v.cmdCollapseAll(true), key(".", "Mod", "Shift"));
		viewCommand("expand-all", "Expand all", (v) => void v.cmdCollapseAll(false));
		// 0.63.2: NO default chord. Mod+A was claimed here, and an Obsidian
		// command hotkey is GLOBAL — it fires wherever focus happens to be, so
		// this took select-all away from every text field in every other plugin
		// (found via Stashpad's composer, where Mod+A stopped selecting text).
		//
		// Nothing is lost by dropping it. The scope handler in outline-view.ts
		// already claims Mod+A whenever this view has the keyboard, and its own
		// comment says the ladder runs from there rather than from this hotkey.
		// So the chord still works inside Trynalist and no longer reaches beyond
		// it — which is what the "no defaults" policy above already asked for.
		viewCommand("select-level-up", "Select one more level upward", (v) => v.selectOneLevelUp());
		viewCommand("toggle-checkbox", "Add / remove checkbox", (v) => void v.cmdToggleCheckbox(), key("c", "Mod", "Shift"));
		viewCommand("checkbox-children", "Add checkbox to children (all levels)", (v) => void v.cmdCheckboxDeep(true));
		viewCommand("uncheckbox-children", "Remove checkboxes from children", (v) => void v.cmdCheckboxDeep(false));
		viewCommand("delete-checked", "Delete checked items", (v) => void v.cmdDeleteChecked());
		viewCommand("toggle-checklist", "Make children a checklist (legacy inherited flag)", (v) => void v.cmdToggleChecklist());
		viewCommand("toggle-numbered", "Make children a numbered list (toggle)", (v) => void v.cmdToggleNumbered(), key("x", "Mod", "Shift"));
		viewCommand("indent", "Indent item(s)", (v) => void v.cmdIndent(false));
		viewCommand("outdent", "Outdent item(s)", (v) => void v.cmdIndent(true));
		viewCommand("move-up", "Move item(s) up", (v) => void v.cmdMove(true), key("ArrowUp", "Mod"));
		viewCommand("move-down", "Move item(s) down", (v) => void v.cmdMove(false), key("ArrowDown", "Mod"));
		viewCommand("heading-cycle", "Toggle heading (cycles H1-H3)", (v) => void v.cmdCycleHeading(), key("h", "Mod", "Shift"));
		viewCommand("color-cycle", "Toggle colour label (cycles)", (v) => void v.cmdCycleColor(), key("l", "Mod", "Shift"));
		viewCommand("heading-none", "Heading: none", (v) => void v.cmdSetHeading(0));
		for (let h = 1; h <= MAX_HEADING; h++) {
			viewCommand(`heading-${h}`, `Heading: H${h}`, (v) => void v.cmdSetHeading(h));
		}
		const COLORS = ["none", "red", "orange", "yellow", "green", "blue", "purple"];
		COLORS.forEach((label, c) => {
			viewCommand(`color-${label}`, `Colour: ${label}`, (v) => void v.cmdSetColor(c));
		});
		const SORTS: Array<[string, "alpha" | "alpha-desc" | "created" | "modified" | "checked-last"]> = [
			["a-z", "alpha"], ["z-a", "alpha-desc"], ["oldest", "created"],
			["recently-edited", "modified"], ["completed-last", "checked-last"],
		];
		for (const [slug, mode] of SORTS) {
			viewCommand(`sort-${slug}`, `Sort children: ${slug.replace(/-/g, " ")}`, (v) => void v.cmdSortChildren(mode));
		}
		viewCommand("insert-date", "Add / edit date on item", (v) => v.openDatePicker());
		viewCommand("item-to-doc", "Convert item to its own document", (v) => void v.convertItemToDoc());
		viewCommand("doc-to-item", "Insert another document as an item…", (v) => v.openConvertDocToItem());
		viewCommand("word-count", "Word count (document or selection)", (v) => v.showWordCount());
		viewCommand("sort-due", "Sort children: by date", (v) => void v.cmdSortChildren("due"));
		viewCommand("search-doc", "Search this document", (v) => v.openSearch(), key("f", "Mod"));
		viewCommand("bookmark-view", "Bookmark this view", (v) => v.bookmarkCurrentView());
		viewCommand("jump-to-item", "Jump to item…", (v) => v.openItemJump(), key("o", "Mod", "Shift"));
		viewCommand("move-to", "Move item(s) to…", (v) => v.openMoveTo(), key("m", "Mod", "Shift"));
		viewCommand("select-all-items", "Select all visible items", (v) => v.selectAll(), key("a", "Mod", "Shift"));
		viewCommand("clear-selection", "Clear selection", (v) => v.clearSelection());
		viewCommand("paste-mirror", "Paste mirror (of the item held by Copy as mirror)", (v) => void v.pasteMirror("item"));
		viewCommand("paste-portal", "Paste portal (children of the item held by Copy as mirror)", (v) => void v.pasteMirror("children"));
		viewCommand("toggle-check-selection", "Check / uncheck selection", (v) => void v.bulkToggleCheck());
		viewCommand("delete-selection", "Delete selection (with children)", (v) => void v.bulkDelete(), key("Backspace", "Mod", "Shift"));
		viewCommand("rename-doc", "Rename current document", (v) => v.promptRenameDoc());
		viewCommand("archive-doc", "Archive / unarchive current document", (v) => void v.toggleArchived());
		viewCommand("copy-as-outline", "Copy document as indented outline", (v) => void v.copyAsOutline());
		viewCommand("export-as", "Export document (formatted / plain text / OPML)…", (v) => v.openExport());
		viewCommand("search-replace", "Search and replace…", (v) => v.openReplace());
		viewCommand("view-outline", "View: outline", (v) => void v.setViewMode("outline"));
		viewCommand("view-flat", "View: flat list", (v) => void v.setViewMode("flat"));
		viewCommand("view-article", "View: article", (v) => void v.setViewMode("article"));
		viewCommand("view-mindmap", "View: mind map", (v) => void v.setViewMode("mindmap"));

		this.addCommand({
			id: "attachments",
			name: "Attachments…",
			callback: () => this.openAttachments(),
		});
		this.addCommand({
			id: "convert-folder",
			name: "Convert a folder between formats…",
			callback: () => this.pickFolderToConvert(),
		});
		this.addCommand({
			id: "import-file",
			name: "Import a document from a file…",
			callback: () => this.pickImportFile(),
		});
		this.addCommand({
			id: "import-paste",
			name: "Import by pasting an outline…",
			callback: () => {
				new ImportTextModal(this.app, async (title, text) => {
					const result = parseImport(title || "pasted.txt", text);
					if (!result.roots.length) {
						new Notice(`Trynalist: nothing importable. ${result.warnings[0] ?? ""}`);
						return;
					}
					const { doc, items } = await writeImport(this.app, this.settings.rootFolder, result, title);
					await this.openDoc(doc);
					this.reportImport(doc.manifest.title, items, result.warnings, result.format);
				}).open();
			},
		});
		this.addCommand({
			id: "import-dynalist-account",
			name: "Import everything from Dynalist (API)…",
			callback: () => void this.importFromDynalist(),
		});
		this.addCommand({
			id: "compare-dynalist-imports",
			name: "Compare two Dynalist imports…",
			callback: () => openImportDiff(this.app, this.settings.rootFolder),
		});
		this.addCommand({
			id: "update-dynalist-import",
			name: "Update an existing Dynalist import…",
			callback: () => this.pickImportToUpdate(),
		});
		this.addCommand({
			id: "retry-failed-dynalist",
			name: "Retry failed documents in an import…",
			callback: () => this.pickImportToRetry(),
		});
		this.addCommand({
			id: "update-selected-dynalist",
			name: "Update selected documents from Dynalist…",
			callback: () => this.pickSelectiveUpdate(),
		});
		this.addCommand({
			id: "audit-links",
			name: "Audit links (find broken links)…",
			callback: () => openLinkAudit(this.app, this.settings.rootFolder),
		});
		this.addCommand({
			id: "open-trash",
			name: "Open trash…",
			callback: () => openTrash(this.app, this.settings.rootFolder, (into) => {
				this.refreshPanels();
				if (into) void this.reloadDocViews(into);
			}),
		});
		this.addCommand({
			id: "empty-trash",
			name: "Empty trash…",
			callback: () => {
				void (async () => {
					const groups = await listTrash(this.app, this.settings.rootFolder);
					if (!groups.length) { new Notice("Trynalist: the trash is already empty."); return; }
					const total = groups.reduce((n, g) => n + g.itemCount, 0);
					new ConfirmModal(this.app, {
						title: "Empty trash?",
						body: `Permanently remove ${total} item${total === 1 ? "" : "s"}? They go to your Obsidian trash (per your Obsidian settings).`,
						cta: "Empty trash",
						warning: true,
						onConfirm: async () => {
							await emptyTrash(this.app, this.settings.rootFolder);
							new Notice("Trynalist: trash emptied.");
						},
					}).open();
				})();
			},
		});
		this.addCommand({
			id: "cancel-dynalist-import",
			name: "Cancel Dynalist import",
			checkCallback: (checking) => {
				if (!this.dynalistImportActive) return false;   // only offered while running
				if (!checking) { this.dynalistCancel.cancelled = true; new Notice("Trynalist: cancelling import…"); }
				return true;
			},
		});
		this.addCommand({
			id: "backup-collection",
			name: "Back up entire collection…",
			callback: () => void this.backupCollection(),
		});
		this.addCommand({
			id: "restore-collection",
			name: "Restore a backup…",
			callback: () => this.pickBackupToRestore(),
		});
		this.addCommand({
			id: "restore-settings-snapshot",
			name: "Restore settings from a snapshot…",
			callback: () => void this.pickSettingsSnapshot(),
		});
		this.addCommand({
			id: "restore-outline-snapshot",
			name: "Restore an outline snapshot…",
			callback: () => void this.pickOutlineSnapshot(),
		});
		this.addCommand({
			id: "check-reminders",
			name: "Check what is due now",
			callback: () => void this.checkReminders(),
		});
		this.addCommand({
			id: "capture-to-inbox",
			name: "Capture to inbox",
			callback: () => void this.captureToInbox(),
		});
		this.addCommand({
			id: "integrity-check",
			name: "Run integrity check",
			callback: async () => {
				const report = await checkIntegrity(this.app, this.settings.rootFolder);
				new IntegrityModal(this.app, report, (paths) => this.fixOrphans(paths)).open();
			},
		});
		this.addCommand({
			id: "item-history",
			name: "Show history of the focused item…",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
				if (!view) return false;
				if (checking) return true;
				if (!view.showHistoryForFocused()) new Notice("Trynalist: click into an item first.");
				return true;
			},
		});
		this.addCommand({
			id: "recently-deleted",
			name: "Recently deleted items…",
			callback: () => this.openRecentlyDeleted(),
		});
		this.addCommand({
			id: "export-doc",
			name: "Export current document as zip",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
				if (!view) return false;
				if (!checking) void view.exportZip();
				return true;
			},
		});

		// Once the vault is ready, offer to finish any import a crash left partway.
		this.app.workspace.onLayoutReady(() => void this.checkForResumableImport());

		// Sync safety net: a settings snapshot at startup (captures whatever a
		// sync just delivered, next to the earlier ones), and the daily outline
		// snapshot, checked hourly so a long-running session still gets one.
		this.safetyNet = new SafetyNet(this.app);
		const net = this.safetyNet;
		this.itemHistory = new ItemHistory(
			this.app,
			() => net.deviceDir(),
			() => this.settings.rootFolder,
			() => this.settings.safetyNet && this.settings.itemHistory,
		);
		// The outline zip reads every item file, so it waits two minutes rather
		// than competing with startup (a big collection on a phone).
		this.app.workspace.onLayoutReady(() => {
			this.itemHistory?.markReady();
			void this.runSafetyNet(true);
			const t = window.setTimeout(() => void this.runSafetyNet(false), 2 * 60_000);
			this.register(() => window.clearTimeout(t));
		});
		this.registerInterval(window.setInterval(() => void this.runSafetyNet(false), 60 * 60_000));
	}

	private async runSafetyNet(startup: boolean): Promise<void> {
		if (!this.settings.safetyNet || !this.safetyNet) return;
		if (startup) { await this.safetyNet.flushSettings({ ...this.settings }); return; }
		await this.safetyNet.dailyOutline(this.settings.rootFolder, this.settings.safetyNetAttachments);
		await this.safetyNet.prune();
		await this.itemHistory?.prune();
	}

	/** Items deleted (here or by a synced device) in the last 30 days that are
	 *  nowhere under the root now — not even in Trynalist's trash. */
	openRecentlyDeleted(): void {
		const h = this.itemHistory;
		if (!h || !this.settings.safetyNet || !this.settings.itemHistory) {
			new Notice("Trynalist: item history is off. Turn on automatic snapshots and item history in the backup settings.");
			return;
		}
		const root = `${this.settings.rootFolder.replace(/\/+$/, "")}/`;
		new RecentlyDeletedModal(this.app, {
			load: async () => {
				// Ids that still exist, from the metadata cache — trash included,
				// so items Trynalist's own trash can restore are not offered twice.
				const existing = new Set<string>();
				for (const f of this.app.vault.getMarkdownFiles()) {
					if (!f.path.startsWith(root)) continue;
					const id: unknown = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
					if ((typeof id === "string" || typeof id === "number") && id !== "") existing.add(String(id));
				}
				const all = await h.recentlyDeleted(existing);
				if (this.safetyNet) await h.fillFromSnapshots(all, await this.safetyNet.listOutlines(), 7);
				const entries = all.filter((e) => e.text || e.note);
				const titles = new Map<string, string | null>();
				for (const e of entries) {
					if (!titles.has(e.doc)) titles.set(e.doc, (await this.docRefAt(e.doc))?.manifest.title ?? null);
				}
				return entries.map((e) => ({ ...e, docTitle: titles.get(e.doc) ?? null }));
			},
			onRestore: async (e) => {
				const ref = await this.docRefAt(e.doc);
				if (!ref) { new Notice("Trynalist: that item's document is gone. Copy its text instead."); return false; }
				try {
					const open = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
						.map((l) => l.view)
						.find((v): v is TrynalistDocView => v instanceof TrynalistDocView && v.file?.path === ref.file.path);
					if (!open || !(await open.appendCaptured(e.text, null, e.note))) {
						await appendItemFile(this.app, ref, null, e.text, e.note);
					}
					new Notice(`Trynalist: restored to the end of "${ref.manifest.title}".`);
					return true;
				} catch (err) {
					console.error(err);
					new Notice("Trynalist: could not restore that item. See the console.");
					return false;
				}
			},
		}).open();
	}

	/** The document whose folder is `folderPath`, from its manifest; null
	 *  when the folder or manifest is gone or unreadable. */
	private async docRefAt(folderPath: string): Promise<DocRef | null> {
		const folder = this.app.vault.getFolderByPath(folderPath);
		const file = folder?.children.find((c): c is TFile => c instanceof TFile && c.extension === DOC_EXTENSION);
		if (!folder || !file) return null;
		try {
			const manifest = JSON.parse(await this.app.vault.cachedRead(file)) as DocManifest;
			return { manifest, folder, file };
		} catch {
			return null;
		}
	}

	/** Pick a settings snapshot from this device's safety net and restore it. */
	async pickSettingsSnapshot(): Promise<void> {
		const net = this.safetyNet;
		if (!net) return;
		await net.flushSettings();
		const snaps = await net.listSettings();
		if (!snaps.length) {
			new Notice(`Trynalist: no settings snapshots on this device yet (they live in ${SAFETY_DIR}).`);
			return;
		}
		const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
		const confirmSettingsRestore = (s: SettingsSnapshot): void => this.confirmSettingsRestore(s);
		class SnapPicker extends FuzzySuggestModal<SettingsSnapshot> {
			getItems(): SettingsSnapshot[] { return snaps; }
			getItemText(s: SettingsSnapshot): string {
				return `${s.when} · ${count(s.data.templates)} templates · ${count(s.data.bookmarks)} bookmarks`;
			}
			onChooseItem(s: SettingsSnapshot): void { confirmSettingsRestore(s); }
		}
		const picker = new SnapPicker(this.app);
		picker.setPlaceholder("Restore settings from which snapshot?");
		picker.open();
	}

	private confirmSettingsRestore(snap: SettingsSnapshot): void {
		new ConfirmModal(this.app, {
			title: `Restore settings from ${snap.when}?`,
			body: "Templates, bookmarks, per-document settings and every other Trynalist setting are replaced with that snapshot. Your current settings are snapshotted first, so this can be reversed the same way. Reminder state and the Dynalist token are not touched.",
			cta: "Restore",
			warning: true,
			onConfirm: async () => {
				try {
					await this.safetyNet?.flushSettings({ ...this.settings }, true);
					// Snapshots never hold the token; keep the current one (on a
					// device with no keychain it lives in these settings).
					await this.saveData({
						...snap.data,
						dynalistToken: this.settings.dynalistToken,
						dynalistTokenEnc: this.settings.dynalistTokenEnc,
						reminderState: this.reminderState,
					});
					await this.loadSettings();
					await this.saveSettings();
					invalidateDocScan();
					this.refreshPanels();
					await this.reloadDocViews();
					new Notice(`Trynalist: settings restored from ${snap.when}.`);
				} catch (e) {
					console.error("Trynalist: settings restore failed", e);
					new Notice(`Trynalist: settings restore failed — ${e instanceof Error ? e.message : String(e)}`, 8000);
				}
			},
		}).open();
	}

	/** Pick a daily outline snapshot and restore it into a fresh folder. */
	async pickOutlineSnapshot(): Promise<void> {
		const net = this.safetyNet;
		if (!net) return;
		const snaps = await net.listOutlines();
		if (!snaps.length) {
			new Notice(`Trynalist: no outline snapshots on this device yet (they live in ${SAFETY_DIR}).`);
			return;
		}
		const restoreOutlineSnapshot = (s: OutlineSnapshot): void => { void this.restoreOutlineSnapshot(s); };
		class OutlinePicker extends FuzzySuggestModal<OutlineSnapshot> {
			getItems(): OutlineSnapshot[] { return snaps; }
			getItemText(s: OutlineSnapshot): string { return `${s.when} · ${Math.max(1, Math.round(s.bytes / 1024))} KB`; }
			onChooseItem(s: OutlineSnapshot): void { restoreOutlineSnapshot(s); }
		}
		const picker = new OutlinePicker(this.app);
		picker.setPlaceholder("Restore which day's outline? It goes into a new folder, so nothing is overwritten");
		picker.open();
	}

	private async restoreOutlineSnapshot(snap: OutlineSnapshot): Promise<void> {
		const notice = new Notice("Trynalist: restoring…", 0);
		try {
			const data = await this.safetyNet!.readOutline(snap.path);
			const r = await restoreCollection(this.app, this.settings.rootFolder, data);
			notice.hide();
			invalidateDocScan();
			this.refreshPanels();
			new Notice(`Trynalist: restored the ${snap.when} snapshot (${r.docCount} document${r.docCount === 1 ? "" : "s"}) into "${r.folder}". It keeps the original ids, so compare, keep what you need, and remove the other copy.`, 12000);
		} catch (e) {
			notice.hide();
			console.error("Trynalist: snapshot restore failed", e);
			new Notice(`Trynalist: restore failed — ${e instanceof Error ? e.message : String(e)}`, 8000);
		}
	}

	// ── reminders ────────────────────────────────────────────────────────

	/** Per-device notification bookkeeping; deliberately NOT written into the
	 *  item files (see dev-docs/reminders.md). */
	reminderState: ReminderState = {};
	private lastAgendaCount = -1;

	private registerReminderWatch(): void {
		this.registerDomEvent(window, "focus", () => void this.checkReminders());
		const first = window.setTimeout(() => void this.checkReminders(), 4000);
		this.register(() => window.clearTimeout(first));
		this.registerInterval(window.setInterval(() => void this.checkReminders(), 60_000));
	}

	/** Bumped by every vault/metadata event under the root (see onload); the due
	 *  list below is exact while it hasn't moved. */
	dueGen = 0;
	private dueCache: { gen: number; horizon: number; root: string; at: number; items: DueItem[] } | null = null;

	/** The due list, cached. `collectDue` reads every manifest and every item's
	 *  frontmatter; it used to run every 60 s and on every window focus whether
	 *  or not anything had changed — a steady background cost that scaled with
	 *  the vault. Now it re-runs only after a relevant change, or every ten
	 *  minutes so items drifting into the horizon are still picked up. The
	 *  `overdue` flag is time-based and is refreshed on every read. */
	private dueLoading: Promise<void> | null = null;

	/** reminderState only ever grew (L92): an entry per item ever announced
	 *  or snoozed, forever, in data.json. Entries for items no longer due whose
	 *  last note (announced or snoozed until) is over 30 days old are dropped. */
	private pruneReminderState(items: DueItem[]): void {
		const live = new Set(items.map((i) => i.itemId));
		const cutoff = Date.now() - 30 * 86_400_000;
		let dropped = 0;
		for (const [id, st] of Object.entries(this.reminderState)) {
			if (live.has(id)) continue;
			const last = Math.max(Date.parse(st.notifiedFor ?? "") || 0, Date.parse(st.snoozedUntil ?? "") || 0);
			if (last < cutoff) { delete this.reminderState[id]; dropped++; }
		}
		if (dropped) this.saveSettingsSoon();
	}

	private async dueItems(): Promise<DueItem[]> {
		const horizon = this.settings.agendaHorizonDays;
		const root = this.settings.rootFolder;
		const c = this.dueCache;
		const fresh = c && c.gen === this.dueGen && c.horizon === horizon && c.root === root && Date.now() - c.at < 600_000;
		if (!fresh) {
			// Concurrent callers (the minute check, a panel refresh, the agenda
			// pane) share one recompute instead of each reading every overdue
			// item's file (L79).
			if (!this.dueLoading) {
				const gen = this.dueGen;
				this.dueLoading = collectDue(this.app, this.settings, horizon)
					.then((items) => {
						this.dueCache = { gen, horizon, root, at: Date.now(), items };
						this.pruneReminderState(items);
					})
					.finally(() => { this.dueLoading = null; });
			}
			await this.dueLoading;
		}
		const cache = this.dueCache;
		if (!cache) return [];
		for (const i of cache.items) i.overdue = isOverdue(i.due, i.hasTime);
		return cache.items;
	}

	async checkReminders(): Promise<void> {
		if (!this.settings.remindersEnabled) return;
		// An import writes many dated items at once; announcing each as it lands
		// would bury the screen in toasts. Stay quiet until the import is done —
		// the imported items are then marked seen (markDueAsSeen), so they don't
		// all fire in one burst the moment it finishes.
		if (this.dynalistImportActive) return;
		try {
			const items = await this.dueItems();
			// Keep the panel's agenda fresh even when nothing is announced.
			if (items.length !== this.lastAgendaCount) {
				this.lastAgendaCount = items.length;
				this.refreshPanels();
			}
			const ready = dueForNotice(items, this.reminderState, this.settings);
			if (!ready.length) return;
			// Quiet hours suppress the toast only; the agenda still shows them.
			for (const item of ready) {
				this.reminderState[item.itemId] = {
					...this.reminderState[item.itemId],
					notifiedFor: item.due,
				};
			}
			await this.saveSettings();
			if (inQuietHours(this.settings)) return;
			announce(ready, this.settings, (opts) => this.showNotice(opts), (item) => {
				// The document may have been renamed or deleted since the notice.
				const file = this.app.vault.getAbstractFileByPath(item.docPath);
				if (file instanceof TFile) void this.openDocFile(file, item.itemId);
				else new Notice("Trynalist: that document is no longer there.");
			});
		} catch (e) {
			console.error("[Trynalist] reminder check failed", e);
		}
	}

	async snooze(item: DueItem): Promise<void> {
		const until = new Date(Date.now() + this.settings.snoozeMinutes * 60_000).toISOString();
		// Forget that this due date was already announced, or the reminder is
		// still "done" once the snooze runs out and never fires again (M41).
		const next = { ...this.reminderState[item.itemId], snoozedUntil: until };
		delete next.notifiedFor;
		this.reminderState[item.itemId] = next;
		await this.saveSettings();
		this.refreshPanels();
		new Notice(`Trynalist: snoozed for ${this.settings.snoozeMinutes} minutes.`);
	}

	async agenda(): Promise<DueItem[]> {
		return this.dueItems();
	}

	// ── stale-build nudge ────────────────────────────────────────────────
	// Obsidian keeps running the main.js it loaded at launch, so a freshly
	// deployed or synced build sits on disk unused until a reload. Compare the
	// loaded manifest against the one on disk and offer a reload.

	/** Which leaf each tab we opened came FROM. */
	readonly openedFrom = new WeakMap<WorkspaceLeaf, WorkspaceLeaf>();
	/** Tabs this plugin opened, and where focus should go when each closes.
	 *
	 *  Kept at the plugin level rather than in the document view because a link
	 *  can open an ORDINARY note, whose view is Obsidian's and has no hook of
	 *  ours to run on close. Tracking the leaf instead of the view covers both. */
	private readonly trackedLeaves = new Set<WorkspaceLeaf>();
	private readonly returnFor = new Map<WorkspaceLeaf, WorkspaceLeaf | null>();

	/** Remember a tab we just opened, and where it came from. */
	trackOpenedLeaf(leaf: WorkspaceLeaf, from: WorkspaceLeaf | null): void {
		if (!from) return;
		this.openedFrom.set(leaf, from);
		this.trackedLeaves.add(leaf);
		this.returnFor.set(leaf, from);
	}

	/** Obsidian has no "leaf closed" event, so closure is detected by the leaf
	 *  going missing on the next layout change. The return target has to be kept
	 *  CURRENT rather than read at close time: by then the leaf is out of its
	 *  parent's children and its position is unrecoverable. */
	private registerTabReturn(): void {
		this.registerEvent(this.app.workspace.on("layout-change", () => {
			for (const leaf of [...this.trackedLeaves]) {
				if (this.leafIsOpen(leaf)) continue;
				const target = this.returnFor.get(leaf) ?? null;
				this.trackedLeaves.delete(leaf);
				this.returnFor.delete(leaf);
				if (this.leafIsOpen(target)) void this.app.workspace.revealLeaf(target as WorkspaceLeaf);
			}
			// Deferred by a tick. layout-change fires while the closing leaf is
			// STILL among its parent's children, so recomputing here recorded the
			// dying tab as its neighbour's return target — and closing that one
			// then went nowhere, because the target was already gone.
			window.setTimeout(() => {
				for (const leaf of this.trackedLeaves) {
					this.returnFor.set(leaf, this.returnTargetFor(leaf));
				}
			}, 0);
		}));
	}

	/** Obsidian's own "focus new tab" preference. Absent or unreadable counts as
	 *  ON, matching the editor one pane over. */
	focusNewTab(): boolean {
		const cfg = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
		const value = cfg.getConfig?.("focusNewTab");
		return value === undefined || value === null || value === true;
	}

	/** Where focus should land when `leaf` closes: the tab it was opened from if
	 *  that is still open, otherwise the tab to its LEFT.
	 *
	 *  Obsidian's default is the tab to the RIGHT, which after opening a link
	 *  and closing it leaves you somewhere you were never reading. The left
	 *  neighbour has to be read BEFORE the detach — once the leaf is gone it is
	 *  no longer in its parent's children and its index is unrecoverable. */
	returnTargetFor(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
		const source = this.openedFrom.get(leaf) ?? null;
		if (this.leafIsOpen(source)) return source;
		const parent = (leaf as unknown as { parent?: { children?: WorkspaceLeaf[] } }).parent;
		const siblings = parent?.children;
		if (!Array.isArray(siblings)) return null;
		const at = siblings.indexOf(leaf);
		return at > 0 ? siblings[at - 1] ?? null : null;
	}

	private notifiedBuildVersion: string | null = null;
	/** Version seen on the previous check — a build must hold still across two
	 *  checks before we announce it, so a mid-sync rewrite doesn't spam. */
	private pendingBuildVersion: string | null = null;

	private registerBuildWatch(): void {
		this.registerDomEvent(window, "focus", () => void this.checkForNewBuild());
		const first = window.setTimeout(() => void this.checkForNewBuild(), 5000);
		this.register(() => window.clearTimeout(first));
		this.registerInterval(window.setInterval(() => void this.checkForNewBuild(), 45_000));
	}

	private isNewer(a: string, b: string): boolean {
		const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
		const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const d = (pa[i] ?? 0) - (pb[i] ?? 0);
			if (d) return d > 0;
		}
		return false;
	}

	private async checkForNewBuild(): Promise<void> {
		try {
			const dir = (this.manifest as unknown as { dir?: string }).dir;
			if (!dir) return;
			const path = `${dir.replace(/\/+$/, "")}/manifest.json`;
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(path))) return;
			const onDisk = (JSON.parse(await adapter.read(path)) as { version?: string }).version;
			const loaded = this.manifest.version;
			if (typeof onDisk !== "string" || !onDisk || onDisk === loaded) return;
			// Only nudge for a strictly newer build: an older manifest on disk
			// (a stale sync push) can't be fixed by reloading.
			if (!this.isNewer(onDisk, loaded)) return;
			if (this.notifiedBuildVersion === onDisk) return;
			if (this.pendingBuildVersion !== onDisk) { this.pendingBuildVersion = onDisk; return; }
			this.notifiedBuildVersion = onDisk;

			this.showNotice({
				// Say what is actually known: this compares the version loaded at
				// launch against the one now on disk. A newer build lands there
				// from BRAT, a manual install, or a local deploy with Obsidian
				// open — naming any one of them would be a guess.
				message: `A newer Trynalist build is installed (${loaded} → ${onDisk}). Reload the app to apply it.`,
				kind: "info",
				duration: 0,
				actions: [{ label: "Reload app", onClick: () => this.reloadApp() }],
			});
		} catch (e) {
			console.debug("[Trynalist] build check failed", e);
		}
	}

	/** A structured toast: an accent for the kind, the message, and a row of
	 *  actions. Adopted from Stashpad, whose shape has already been through the
	 *  light/dark legibility problems — action buttons use the interactive-*
	 *  tokens rather than hover modifiers, which resolved to near-black on some
	 *  light themes. */
	showNotice(opts: {
		message: string;
		kind?: "info" | "success" | "warning" | "error";
		duration?: number;
		actions?: Array<{ label: string; onClick: () => void }>;
	}): Notice {
		const frag = createFragment();
		const wrap = frag.createDiv({ cls: `trynalist-notice trynalist-notice-${opts.kind ?? "info"}` });
		wrap.createDiv({ cls: "trynalist-notice-message", text: opts.message });
		const notice = new Notice(frag, opts.duration ?? 5000);
		if (opts.actions?.length) {
			const row = wrap.createDiv({ cls: "trynalist-notice-actions" });
			for (const action of opts.actions) {
				const btn = row.createEl("button", { cls: "trynalist-notice-action", text: action.label });
				btn.addEventListener("click", () => {
					action.onClick();
					notice.hide();
				});
			}
		}
		return notice;
	}

	private reloadApp(): void {
		try {
			const commands = (this.app as unknown as {
				commands?: { executeCommandById?: (id: string) => boolean };
			}).commands;
			if (commands?.executeCommandById?.("app:reload")) return;
		} catch (e) {
			console.warn("[Trynalist] app:reload failed", e);
		}
		window.location.reload();
	}

	/** The Trynalist document the KEYBOARD is in, or null.
	 *
	 *  `getActiveViewOfType` answers "what is the active leaf showing", which is
	 *  not the same question. A sidebar — another plugin's composer, a search
	 *  box, any pane that is not the active leaf — takes focus without changing
	 *  the active leaf, so with a document open in the main pane that check says
	 *  yes while the user is typing somewhere else entirely. Every default
	 *  hotkey we ship (Mod+A, Mod+F, Mod+[…]) would then be stolen from that
	 *  other input. Requiring focus to be INSIDE the view is the honest gate. */
	activeFocusedDoc(): TrynalistDocView | null {
		const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
		if (!view) return null;
		const active = view.containerEl.ownerDocument.activeElement;
		if (!active?.instanceOf(HTMLElement)) return null;
		// `body` is what the document reports when nothing in particular holds
		// focus; treat that as ours, so the chords still work right after a
		// click on the document that did not land in an editable.
		if (active === active.ownerDocument.body) return view;
		return view.containerEl.contains(active) ? view : null;
	}

	/** Open one of the individual panes. They go on the LEFT, beside the file
	 *  explorer, which is where an outliner's navigation belongs; the combined
	 *  panel keeps the right sidebar so both can be open at once. */
	async openPane(type: string): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(type)[0];
		if (existing) { void this.app.workspace.revealLeaf(existing); return; }
		const leaf = this.app.workspace.getLeftLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	/** Same thing, named for the panel's per-section shortcut buttons. */
	revealPane(type: string): Promise<void> {
		return this.openPane(type);
	}


	/** Duplicate a whole document — folder, manifest, every item file. */
	async duplicateCurrentDoc(doc: DocRef): Promise<void> {
		try {
			const copy = await duplicateDoc(this.app, doc, this.settings.rootFolder);
			this.refreshPanels();
			new Notice(`Trynalist: created "${copy.manifest.title}".`);
			await this.openDoc(copy);
		} catch (e) {
			console.error("Trynalist: duplicate failed", e);
			new Notice("Trynalist: could not duplicate that document — see console.");
		}
	}

	/** Reveal a document in the combined panel — open the panel, make sure the
	 *  documents section is expanded, and flash the row so the eye finds it. */
	async revealInPanel(file: TFile | null): Promise<void> {
		await this.openPanel();
		if (!file) return;
		this.settings.collapsedSections = this.settings.collapsedSections.filter((k) => k !== "docs");
		await this.saveSettings();
		this.refreshPanels();
		// The panel re-renders asynchronously; wait for the row to exist.
		window.setTimeout(() => {
			for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
				const row = leaf.view.containerEl
					.querySelector<HTMLElement>(`.trynalist-doc-row[data-path="${CSS.escape(file.path)}"]`);
				if (!row) continue;
				row.scrollIntoView({ block: "center" });
				row.addClass("is-flashing");
				window.setTimeout(() => row.removeClass("is-flashing"), 1400);
			}
		}, 320);
	}

	/** Search only the open document. The tags pane starts here and widens to
	 *  the vault on request, rather than always jumping straight to global. */
	searchOpenDoc(query: string): void {
		const view = this.app.workspace.getActiveViewOfType(TrynalistDocView);
		if (!view) { this.searchEverywhere(query); return; }
		void this.app.workspace.revealLeaf(view.leaf);
		view.openSearch(query);
	}

	/** Search every document for a term — used by the tags pane. */
	/** Global search opens a PAGE. A modal can only be a ranked list — it has
	 *  one row per hit and nowhere to put the outline each hit came from — and
	 *  it is not somewhere you can navigate back to. */
	/** Global search happens INSIDE the open document's view, as a mode.
	 *
	 *  It used to open its own tab, which left the breadcrumb, the nav buttons
	 *  and Escape behind — all of which belong to the document view. The tab
	 *  view stays only as the fallback for when no document is open, since a
	 *  mode needs a view to be a mode OF. */
	searchEverywhere(query: string): void {
		const view = this.activeFocusedDoc();
		if (view) { view.openGlobalSearch(query); return; }
		const existing = this.app.workspace.getLeavesOfType(GLOBAL_SEARCH_VIEW)[0];
		let leaf = existing ?? null;
		if (!leaf) {
			try {
				leaf = this.app.workspace.getLeaf("tab");
			} catch {
				// getLeaf("tab") throws "No tab group found" when the main area has
				// no tab group — the state right after a reload with nothing open.
				leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
					?? this.app.workspace.getLeaf(true);
			}
		}
		if (!leaf) { new Notice("Trynalist: could not open a tab for the search."); return; }
		void (async () => {
			if (!existing) await leaf.setViewState({ type: GLOBAL_SEARCH_VIEW, active: true });
			void this.app.workspace.revealLeaf(leaf);
			const v = leaf.view;
			if (v instanceof GlobalSearchView) await v.setQuery(query);
		})();
	}

	/** Open the panel, or put it away if it is already the visible one.
	 *
	 *  A second press on the same button should undo the first. It only closes
	 *  when the panel is the ACTIVE tab in its sidebar though — if it is open
	 *  behind another tab, pressing the button means "show me the panel", and
	 *  closing the whole sidebar would be the opposite of that. */
	async openPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0];
		if (existing) {
			const split = (existing as unknown as { parent?: { parent?: unknown } }).parent;
			const showing = (split as unknown as { children?: unknown[]; currentTab?: number }) ?? null;
			const isCurrent = showing?.children
				? showing.children[showing.currentTab ?? 0] === existing
				: true;
			const sidebarOpen = !(this.app.workspace.rightSplit as unknown as { collapsed?: boolean })?.collapsed;
			if (isCurrent && sidebarOpen) { this.app.workspace.rightSplit.collapse(); return; }
			void this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: PANEL_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	/** Fuzzy document picker (Phase B navigation). */
	async openDocJump(): Promise<void> {
		const modal = new DocSuggestModal(this.app, this.settings.rootFolder, (doc) => {
			void this.openDoc(doc);
		});
		await modal.load();
		modal.open();
	}

	/** A leaf to open a document in.
	 *
	 *  `getLeaf(false)` means "reuse the active leaf", which is how opening
	 *  anything from the panels, the file opener or a link came to REPLACE
	 *  whatever you were reading. With the setting on we take a new tab and
	 *  remember which leaf we came from, so closing the tab can return there
	 *  rather than dumping you on whatever happens to sit to the right.
	 *
	 *  `focusNewTab` is Obsidian's own preference and answers a different
	 *  question — whether a new tab takes focus — so it is honoured separately. */
	private leafForDoc(): { leaf: WorkspaceLeaf; from: WorkspaceLeaf | null } {
		if (!this.settings.openInNewTab) {
			return { leaf: this.app.workspace.getLeaf(false), from: null };
		}
		const from = this.app.workspace.getMostRecentLeaf() ?? null;
		return { leaf: this.app.workspace.getLeaf("tab"), from };
	}

	/** "Open documents in a new tab" for the routes this plugin does NOT own: the
	 *  file explorer, the quick switcher, a wikilink in an ordinary note. Those
	 *  all end in `leaf.openFile()` on whatever leaf Obsidian picked — usually
	 *  the active one — and replaced what you were reading. The patch redirects
	 *  a `.trynalist` open away from a leaf that is already showing something
	 *  else into a fresh tab, and records where it came from so closing it
	 *  returns there. An empty leaf (a new tab, or one this plugin just made for
	 *  the purpose) is left alone, so the plugin's own openers are unaffected. */
	private patchOpenFileForNewTab(): void {
		const { app, settings } = this;
		const leafInMainArea = this.leafInMainArea.bind(this);
		const trackOpenedLeaf = this.trackOpenedLeaf.bind(this);
		const focusNewTab = this.focusNewTab.bind(this);
		const proto = WorkspaceLeaf.prototype as unknown as {
			openFile: (this: WorkspaceLeaf, file: TFile, state?: Record<string, unknown>) => Promise<void>;
		};
		const original = proto.openFile;
		proto.openFile = async function (this: WorkspaceLeaf, file: TFile, state?: Record<string, unknown>): Promise<void> {
			if (
				settings.openInNewTab
				&& file instanceof TFile
				&& file.extension === DOC_EXTENSION
				&& this.view
				&& this.view.getViewType() !== "empty"
				&& !(this.view instanceof TrynalistDocView && this.view.file?.path === file.path)
				&& app.workspace.rootSplit && leafInMainArea(this)
			) {
				// Already open elsewhere? Reveal that tab instead of a third copy.
				for (const leaf of app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
					const v = leaf.view;
					if (v instanceof TrynalistDocView && v.file?.path === file.path) {
						void app.workspace.revealLeaf(leaf);
						return;
					}
				}
				const target = app.workspace.getLeaf("tab");
				trackOpenedLeaf(target, this);
				// Respect the caller's `active`; only default to our own setting.
				return original.call(target, file, { ...(state ?? {}), active: state?.active ?? focusNewTab() });
			}
			return original.call(this, file, state);
		};
		const patched = proto.openFile;
		// Only undo our own patch: if another plugin wrapped openFile after us,
		// assigning `original` back would silently drop theirs (L68/L69).
		this.register(() => { if (proto.openFile === patched) proto.openFile = original; });
	}

	/** Only main-area leaves are redirected; a sidebar or popout leaf that was
	 *  asked to show a document is doing something deliberate. */
	private leafInMainArea(leaf: WorkspaceLeaf): boolean {
		let node = (leaf as unknown as { parent?: unknown }).parent as { parent?: unknown } | undefined;
		while (node) {
			if (node === (this.app.workspace.rootSplit as unknown)) return true;
			node = node.parent as { parent?: unknown } | undefined;
		}
		return false;
	}

	/** Whether a leaf is still part of the workspace. A leaf object outlives its
	 *  detach, so "is it still open?" has to be asked of the workspace. */
	leafIsOpen(target: WorkspaceLeaf | null): boolean {
		if (!target) return false;
		let found = false;
		this.app.workspace.iterateAllLeaves((l) => { if (l === target) found = true; });
		return found;
	}

	/** Open an ordinary (non-Trynalist) file from inside a document view, in a
	 *  new tab when the setting asks for one, recording where it came from so
	 *  closing it returns there. */
	async openFileFromDoc(file: TFile, from: WorkspaceLeaf): Promise<void> {
		// A type Obsidian cannot show goes to the operating system's default
		// app. Chips showed only an alias, so a click could launch anything in
		// the vault; name the real file and ask first (L66).
		if (!OPENS_IN_OBSIDIAN.has(file.extension.toLowerCase())) {
			const ok = await new Promise<boolean>((resolve) => new ConfirmModal(this.app, {
				title: `Open "${file.name}" outside Obsidian?`,
				body: `Obsidian can't display .${file.extension} files, so this opens ${file.path} with your system's default app for that type.`,
				cta: "Open",
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
			}).open());
			if (!ok) return;
		}
		if (!this.settings.openInNewTab) {
			await this.app.workspace.getLeaf(false).openFile(file);
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		this.trackOpenedLeaf(leaf, from);
		await leaf.openFile(file, { active: this.focusNewTab() });
	}

	/** An `obsidian://trynalist?…` URL for a document, item or zoomed view.
	 *
	 *  Obsidian's own `obsidian://open?file=…` can address the manifest file, but
	 *  it carries nowhere to put an item id or a zoom root — so a link into a
	 *  specific row, which is the only kind worth sending anyone, needs our own
	 *  scheme and the handler below.
	 *
	 *  Every component is encoded: document titles are free text and routinely
	 *  contain spaces, ampersands and em-dashes. */
	deepLink(docPath: string, itemId?: string, zoom = false): string {
		// encodeURIComponent, NOT URLSearchParams: the latter encodes a space as
		// "+", which only decodes back to a space if the reader treats the query
		// as a form body. Obsidian's own links use %20, and a document titled
		// "my notes" would otherwise arrive as "my+notes" and match nothing.
		const parts = [
			`vault=${encodeURIComponent(this.app.vault.getName())}`,
			`doc=${encodeURIComponent(docPath)}`,
		];
		if (itemId) parts.push(`item=${encodeURIComponent(itemId)}`);
		if (zoom) parts.push("zoom=1");
		return `obsidian://trynalist?${parts.join("&")}`;
	}

	/** Copy a deep link, reporting what actually happened either way. */
	async copyDeepLink(docPath: string, itemId?: string, zoom = false): Promise<void> {
		const url = this.deepLink(docPath, itemId, zoom);
		try {
			await navigator.clipboard.writeText(url);
			new Notice(zoom ? "Trynalist: link to this zoomed view copied." : "Trynalist: deep link copied.");
		} catch (e) {
			console.error("Trynalist: could not copy the deep link", e);
			new Notice("Trynalist: could not reach the clipboard.");
		}
	}

	/** Act on a `trynalist:` deep link's parameters.
	 *
	 *  Separate from the protocol registration so the behaviour is reachable and
	 *  testable on its own: an incoming obsidian:// URL is routed by the OS to
	 *  whichever Obsidian is registered for the scheme, which makes the round
	 *  trip impossible to exercise from a second instance. */
	async openDeepLink(params: Record<string, string>): Promise<void> {
		const docPath = params.doc;
		if (!docPath) { new Notice("Trynalist: that link carries no document."); return; }
		// A deep link is a URL anyone can send: it may open a Trynalist document
		// under the root and nothing else in the vault (L67).
		const root = `${this.settings.rootFolder.replace(/\/+$/, "")}/`;
		if (!docPath.endsWith(`.${DOC_EXTENSION}`) || !docPath.startsWith(root)) {
			new Notice("Trynalist: that link does not point at an outline document.");
			return;
		}
		if (params.item && !/^[A-Za-z0-9_-]{1,64}$/.test(params.item)) delete params.item;
		const file = this.app.vault.getAbstractFileByPath(docPath);
		if (!(file instanceof TFile)) {
			// Name the document that is missing: these links travel between
			// machines and vaults, where a rename is the usual reason.
			new Notice(`Trynalist: no document at "${docPath}".`);
			return;
		}
		await this.openDocFile(file, params.item || undefined);
		if (params.zoom !== "1" || !params.item) return;
		// The view loads its index asynchronously, so zooming has to wait for the
		// item to exist — the same reason openDocFile defers its reveal.
		await new Promise((done) => window.setTimeout(done, 400));
		const view = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
			.map((l) => l.view)
			.find((v): v is TrynalistDocView =>
				v instanceof TrynalistDocView && v.file?.path === docPath);
		view?.zoomToItem(params.item);
	}

	/** Rename or delete saved templates. Deliberately a plain list: templates
	 *  are edited by re-saving over the name, so the only things missing here are
	 *  getting rid of one and seeing what you have. */
	openTemplateManager(): void {
		const list = this.settings.templates ?? [];
		if (!list.length) { new Notice("Trynalist: no templates saved yet."); return; }
		const menu = new Menu();
		for (const t of list) {
			menu.addItem((i) => i.setTitle(`Delete "${t.name}"`).setIcon("trash-2").onClick(async () => {
				this.settings.templates = (this.settings.templates ?? []).filter((x) => x.name !== t.name);
				await this.saveSettings();
				new Notice(`Trynalist: deleted "${t.name}".`);
			}));
		}
		menu.showAtPosition({ x: activeWindow.innerWidth / 2, y: activeWindow.innerHeight / 3 });
	}

	private registerDeepLinks(): void {
		this.registerObsidianProtocolHandler("trynalist", (params) => {
			void this.openDeepLink(params);
		});
	}

	/** Open a document by its manifest file, optionally revealing an item. */
	async openDocFile(manifest: TFile, itemId?: string): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof TrynalistDocView && v.file?.path === manifest.path) {
				void this.app.workspace.revealLeaf(leaf);
				if (itemId) await v.revealItem(itemId);
				return;
			}
		}
		const { leaf, from } = this.leafForDoc();
		await leaf.openFile(manifest, { active: this.focusNewTab() });
		this.trackOpenedLeaf(leaf, from);
		if (!itemId) return;
		// The view loads its index asynchronously; reveal once it is ready.
		window.setTimeout(() => {
			const v = leaf.view;
			if (v instanceof TrynalistDocView) void v.revealItem(itemId);
		}, 300);
	}

	/** Reattach orphaned items to the top level of their document. */
	async fixOrphans(paths: string[]): Promise<number> {
		const fixed = await reattachOrphans(this.app, paths);
		await this.reloadDocViews();
		return fixed;
	}

	/** Every attachment across every document, with the actions that make the
	 *  list useful: jump to the item, reveal on disk, preview, delete safely. */
	openAttachments(): void {
		new AttachmentsModal(this.app, this.settings.rootFolder, (use) => {
			const file = this.app.vault.getAbstractFileByPath(use.docPath);
			if (file instanceof TFile) void this.openDocFile(file, use.itemId);
		}, (folder) => this.reloadDocViews(folder)).open();
	}

	/** Folder converter: hand a folder from one plugin to the other, marking
	 *  ownership explicitly rather than leaving both to guess. */
	private pickFolderToConvert(): void {
		const folders: TFolder[] = [];
		const walk = (f: TFolder) => {
			for (const c of f.children) {
				if (!(c instanceof TFolder)) continue;
				if (c.path.includes("_conversion-backups")) continue;
				folders.push(c);
				walk(c);
			}
		};
		const root = this.app.vault.getRoot();
		walk(root);
		const candidates = folders.filter((f) => {
			const kind = detectFolderKind(this.app, f);
			return kind === "trynalist" || kind === "stashpad";
		});
		if (!candidates.length) {
			new Notice("Trynalist: no folders found to convert.");
			return;
		}
		const app = this.app;
		const confirmConversion = (f: TFolder): void => this.confirmConversion(f);
		class FolderPicker extends FuzzySuggestModal<TFolder> {
			getItems(): TFolder[] { return candidates; }
			getItemText(f: TFolder): string {
				return `${f.path}  (${detectFolderKind(app, f)})`;
			}
			onChooseItem(f: TFolder): void { confirmConversion(f); }
		}
		const picker = new FolderPicker(this.app);
		picker.setPlaceholder("Choose a folder to convert…");
		picker.open();
	}

	private confirmConversion(folder: TFolder): void {
		const kind = detectFolderKind(this.app, folder);
		const to = kind === "trynalist" ? "stashpad" : "trynalist";
		const body = to === "trynalist"
			? "Its notes become outline items: parents, order, ticks and colours are translated, attachments become links in the item, and a .trynalist file is added so Trynalist claims the folder. Stashpad's per-note marker is removed, so it stops claiming it."
			: "Its items become notes: a Home note is added, parents use Stashpad's root marker, and order, ticks and colours are translated. The .trynalist file is renamed rather than deleted, so Trynalist stops claiming the folder and you can undo by renaming it back.";
		new ConfirmModal(this.app, {
			title: `Convert "${folder.name}" to ${to === "trynalist" ? "Trynalist" : "Stashpad"}?`,
			body: `${body}\n\nEvery file is copied into a dated backup folder first, including Stashpad's hidden order file.\n\nClose any Stashpad views on this folder before converting — that plugin writes recovery links in the background, and conversion rewrites the same files.`,
			cta: "Convert",
			onConfirm: async () => {
				// An open tab on this folder keeps its own index: after the
				// conversion its next save wrote the Trynalist frontmatter back
				// (parent: null, doc, indent, depth) over the converted notes.
				// Close those tabs first; unloading them flushes pending edits.
				const closed = await this.closeDocViews(folder.path);
				const report = await convertFolder(this.app, folder, this.settings.rootFolder, to);
				if (!report) return;
				this.refreshPanels();
				const frag = createFragment();
				frag.createDiv({ text: `Trynalist: converted ${report.items} file(s) in "${folder.name}".` });
				if (closed) frag.createDiv({ cls: "trynalist-notice-line", text: `Closed ${closed} open tab${closed === 1 ? "" : "s"} on it first.` });
				frag.createDiv({ cls: "trynalist-notice-line", text: `Backup: ${report.backupPath}` });
                for (const n of report.notes.slice(0, 4)) {
					frag.createDiv({ cls: "trynalist-notice-line", text: `• ${n}` });
				}
				new Notice(frag, 0);
			},
		}).open();
	}

	/** Pick an importable file already sitting in the vault. */
	private pickImportFile(): void {
		const root = this.settings.rootFolder.replace(/\/+$/, "");
		const candidates = this.app.vault.getFiles().filter((f) => {
			if (f.path.startsWith(`${root}/`)) return false;   // our own documents
			return ["opml", "xml", "json", "txt", "md", "text"].includes(f.extension.toLowerCase());
		});
		if (!candidates.length) {
			new Notice("Trynalist: no importable files found in the vault.");
			return;
		}
		const chooseFile = (f: TFile): void => {
			void (async () => {
				const done = await importVaultFile(this.app, this.settings.rootFolder, f);
				if (!done) return;
				await this.openDoc(done.doc);
				this.reportImport(done.doc.manifest.title, done.items, done.warnings);
			})();
		};
		class FilePicker extends FuzzySuggestModal<TFile> {
			getItems(): TFile[] { return candidates; }
			getItemText(f: TFile): string { return f.path; }
			onChooseItem(f: TFile): void { chooseFile(f); }
		}
		const picker = new FilePicker(this.app);
		picker.setPlaceholder("Choose a file to import…");
		picker.open();
	}

	/** One notice covering what came in and anything the parser had to guess. */
	private reportImport(title: string, items: number, warnings: string[], format?: string): void {
		const head = `Trynalist: imported ${items} item${items === 1 ? "" : "s"} into "${title}"${format ? ` (${format})` : ""}.`;
		// Persistent, like the conversion report: these say what happened to
		// real files and are worth reading at your own pace.
		if (!warnings.length) { new Notice(head, 0); return; }
		const frag = createFragment();
		frag.createDiv({ text: head });
		frag.createDiv({ text: `${warnings.length} thing(s) worth checking:` });
		for (const w of warnings.slice(0, 4)) frag.createDiv({ cls: "trynalist-notice-line", text: `• ${w}` });
		if (warnings.length > 4) frag.createDiv({ text: `…and ${warnings.length - 4} more` });
		new Notice(frag, 0);
	}

	/** Append a captured line to the inbox document (Dynalist's quick capture,
	 *  local only — no API or email routes). */
	async captureToInbox(): Promise<void> {
		let path = this.settings.inboxDocPath;
		let file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!(file instanceof TFile)) {
			// No inbox set (or it moved): let the user pick one, and remember it.
			const modal = new DocSuggestModal(this.app, this.settings.rootFolder, (doc) => {
				void (async () => {
					this.settings.inboxDocPath = doc.file.path;
					await this.saveSettings();
					await this.captureToInbox();
				})();
			});
			await modal.load();
			modal.setPlaceholder("Choose a document to use as your inbox…");
			modal.open();
			return;
		}
		const manifestFile = file;
		new PromptModal(this.app, {
			title: "Capture to inbox",
			label: "New item",
			cta: "Add",
			onSubmit: async (text) => {
				try {
					// Under the chosen inbox item when one was set from the item
					// menu, otherwise at the end of the document.
					const underId = this.settings.inboxItemId ?? null;
					// Open in a tab: add through that view's live index — no load,
					// no reload from disk (which also cleared its undo history).
					const open = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
						.map((l) => l.view)
						.find((v): v is TrynalistDocView => v instanceof TrynalistDocView && v.file?.path === manifestFile.path);
					if (open && await open.appendCaptured(text, underId)) {
						new Notice(`Trynalist: captured to "${open.getDisplayText()}".`);
						return;
					}
					// Not open: one new file, positioned from the metadata cache —
					// loading the whole inbox to append one line was the cost (L86).
					const manifest = JSON.parse(await this.app.vault.read(manifestFile)) as DocManifest;
					const folder = manifestFile.parent;
					if (!folder) throw new Error("inbox folder missing");
					await appendItemFile(this.app, { manifest, folder, file: manifestFile }, underId, text);
					new Notice(`Trynalist: captured to "${manifest.title}".`);
				} catch (e) {
					console.error(e);
					new Notice("Trynalist: capture failed — see console.");
				}
			},
		}).open();
	}

	/** Import the whole Dynalist account over the API. Read-only against
	 *  Dynalist — only file/list and doc/read are ever called. */
	async importFromDynalist(tokenOverride?: string): Promise<void> {
		if (this.dynalistImportActive) { new Notice("Trynalist: an import is already running."); return; }
		const token = (tokenOverride ?? this.getDynalistToken()).trim();
		if (!token) {
			// No token yet — prompt for one right here rather than sending the
			// user off to Settings. Remembering is their choice (and the security
			// note in Settings suggests revoking it when done).
			new DynalistTokenModal(this.app, keychainAvailable(this.app), async (tok, remember) => {
				if (remember) await this.setDynalistToken(tok);
				await this.importFromDynalist(tok);
			}).open();
			return;
		}
		await this.runDynalistImport(token, (onProgress, opts) =>
			importEntireAccount(this.app, this.settings.rootFolder, token, onProgress, opts),
		);
	}

	/** Continue a crash-interrupted import from its on-disk progress. */
	async resumeDynalistImport(runFolder: string): Promise<void> {
		if (this.dynalistImportActive) { new Notice("Trynalist: an import is already running."); return; }
		const token = this.getDynalistToken().trim();
		if (!token) { new Notice("Trynalist: add your API token first to resume."); return; }
		await this.runDynalistImport(token, (onProgress, opts) =>
			resumeImport(this.app, this.settings.rootFolder, runFolder, token, onProgress, opts),
		);
	}

	/** Shared runner for fresh and resumed imports: one cancellable, updating
	 *  progress notice, then the summary. */
	private async runDynalistImport(
		_token: string,
		run: (onProgress: (p: { done: number; total: number; title: string }) => void, opts: ImportOptions) => Promise<Awaited<ReturnType<typeof importEntireAccount>>>,
	): Promise<void> {
		this.dynalistImportActive = true;
		this.dynalistCancel = { cancelled: false };
		// A persistent notice as the throttled run walks the account — minutes for
		// a large account, so silence would read as a hang. It carries a Cancel
		// button, re-rendered each tick (setMessage would wipe it).
		const progress = this.stickyNotice();
		const paint = (label: string, detail: string, fraction: number | null): void =>
			this.paintImportNotice(progress.messageEl, { label, detail, fraction, controller: this.dynalistCancel });
		paint("Contacting Dynalist…", "", null);
		try {
			const summary = await run(
				(p) => paint(
					p.total ? `Importing ${p.done} of ${p.total}` : "Importing…",
					p.title,
					p.total ? p.done / p.total : null,
				),
				{ importShared: this.settings.importShared, keepSource: this.settings.keepImportSource, isCancelled: () => this.dynalistCancel.cancelled },
			);
			progress.hide();
			invalidateDocScan();
			await this.reloadDocViews(`${this.settings.rootFolder}/${summary.runFolder}`);
			this.refreshPanels();   // one catch-up render after the paused per-file events
			// Silence the post-import reminder burst for what we just imported.
			const dueSeen = await this.markDueAsSeen(`${this.settings.rootFolder}/${summary.runFolder}`);
			const bits = [
				`${summary.documents} document${summary.documents === 1 ? "" : "s"}`,
				`${summary.items} item${summary.items === 1 ? "" : "s"}`,
			];
			if (summary.folders) bits.push(`${summary.folders} folder${summary.folders === 1 ? "" : "s"}`);
			const verb = summary.cancelled ? "Import cancelled — kept" : "imported";
			let msg = `Trynalist: ${verb} ${bits.join(", ")} in "${summary.runFolder}".`;
			if (summary.skippedShared) msg += ` Skipped ${summary.skippedShared} shared document${summary.skippedShared === 1 ? "" : "s"}.`;
			if (dueSeen) msg += ` ${dueSeen} imported item${dueSeen === 1 ? "" : "s"} ${dueSeen === 1 ? "has a due date" : "have due dates"} — reminder pop-ups were paused during import, so check the agenda for what's due.`;
			if (summary.failures.length) {
				msg += ` ${summary.failures.length} document${summary.failures.length === 1 ? "" : "s"} failed. First: ${summary.failures[0].reason}`;
				console.warn("Trynalist: Dynalist import failures", summary.failures);
			}
			if (summary.warnings.length) console.warn("Trynalist: Dynalist import warnings", summary.warnings);
			const reportFile = await writeImportReport(this.app, this.settings.rootFolder, summary);
			this.showCompletionNotice(msg, reportFile);
		} catch (e) {
			progress.hide();
			console.error("Trynalist: Dynalist import failed", e);
			this.showCompletionNotice(`Trynalist: import failed — ${e instanceof Error ? e.message : String(e)}`, null);
		} finally {
			this.dynalistImportActive = false;
		}
	}

	/** Folders under the root that hold a Dynalist import: an import's own
	 *  bookkeeping (`_source`, `_import-*.json`) or at least one document with
	 *  a Dynalist file id. The pickers listed EVERY folder — `_trash` included —
	 *  and choosing one that is not a run imported the whole account into it
	 *  (M14, L25). */
	private async importRuns(): Promise<TFolder[]> {
		const root = this.app.vault.getFolderByPath(this.settings.rootFolder.replace(/\/+$/, ""));
		const out: TFolder[] = [];
		for (const c of root?.children ?? []) {
			if (!(c instanceof TFolder) || isReservedFolderName(c.name)) continue;
			const marked = c.children.some((x) => x.name === "_source" || /^_import-.*\.json$/.test(x.name));
			if (marked || (await listDocs(this.app, c.path, { includeArchived: true })).some((d) => !!d.manifest.dlFileId)) out.push(c);
		}
		return out;
	}

	/** Pick an existing import run folder and re-run the import into it in place. */
	pickImportToUpdate(): void {
		void this.importRuns().then((runs) => this.pickImportToUpdateWith(runs));
	}

	private pickImportToUpdateWith(runs: TFolder[]): void {
		if (!runs.length) { new Notice("Trynalist: no existing import folders to update."); return; }
		const updateFromDynalist = (name: string): void => { void this.updateFromDynalist(name); };
		class RunPicker extends FuzzySuggestModal<TFolder> {
			getItems(): TFolder[] { return runs; }
			getItemText(f: TFolder): string { return f.name; }
			onChooseItem(f: TFolder): void { updateFromDynalist(f.name); }
		}
		new RunPicker(this.app).open();
	}

	/** Pick a run folder, then choose specific documents to re-fetch — for running
	 *  over just a few (e.g. after a rate limit) rather than the whole account. */
	pickSelectiveUpdate(): void {
		void this.importRuns().then((runs) => this.pickSelectiveUpdateWith(runs));
	}

	private pickSelectiveUpdateWith(runs: TFolder[]): void {
		if (!runs.length) { new Notice("Trynalist: no import folders found. Run an import first."); return; }
		const selectiveUpdate = (name: string): void => { void this.selectiveUpdate(name); };
		class RunPicker extends FuzzySuggestModal<TFolder> {
			getItems(): TFolder[] { return runs; }
			getItemText(f: TFolder): string { return f.name; }
			onChooseItem(f: TFolder): void { selectiveUpdate(f.name); }
		}
		new RunPicker(this.app).open();
	}

	private async selectiveUpdate(runFolder: string): Promise<void> {
		const token = this.getDynalistToken().trim();
		if (!token) { new Notice("Trynalist: add your API token first."); return; }
		const notice = new Notice("Trynalist: fetching your document list…", 0);
		try {
			const docs = await listAccountDocuments(token, this.settings.importShared);
			notice.hide();
			if (!docs.length) { new Notice("Trynalist: Dynalist returned no documents."); return; }
			new DocSelectModal(this.app, docs, "Update selected", (ids) => {
				void this.updateFromDynalist(runFolder, ids);
			}).open();
		} catch (e) {
			notice.hide();
			new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}`, 8000);
		}
	}

	/** Pick an import folder and re-fetch ONLY the documents that failed last time
	 *  (recorded in the run's _import-failures.json), not the whole account. */
	pickImportToRetry(): void {
		void this.importRuns().then((runs) => this.pickImportToRetryWith(runs));
	}

	private pickImportToRetryWith(runs: TFolder[]): void {
		if (!runs.length) { new Notice("Trynalist: no import folders found."); return; }
		const retryFailures = (f: TFolder): void => {
			void (async () => {
				const failed = await readFailures(this.app, this.settings.rootFolder, f.name);
				if (!failed.length) { new Notice(`Trynalist: no recorded failures in "${f.name}".`); return; }
				new Notice(`Trynalist: retrying ${failed.length} failed document${failed.length === 1 ? "" : "s"}…`);
				void this.updateFromDynalist(f.name, failed.map((x) => x.id));
			})();
		};
		class RunPicker extends FuzzySuggestModal<TFolder> {
			getItems(): TFolder[] { return runs; }
			getItemText(f: TFolder): string { return f.name; }
			onChooseItem(f: TFolder): void { retryFailures(f); }
		}
		new RunPicker(this.app).open();
	}

	/** Re-fetch the whole account and fold changes into an existing run folder. */
	async updateFromDynalist(runFolder: string, onlyDocIds?: string[]): Promise<void> {
		if (this.dynalistImportActive) { new Notice("Trynalist: an import is already running."); return; }
		const token = this.getDynalistToken().trim();
		if (!token) { new Notice("Trynalist: add your API token first."); return; }
		this.dynalistImportActive = true;
		this.dynalistCancel = { cancelled: false };
		const progress = this.stickyNotice();
		const paint = (label: string, detail: string, fraction: number | null): void =>
			this.paintImportNotice(progress.messageEl, { label, detail, fraction, controller: this.dynalistCancel });
		paint("Checking Dynalist for changes…", "", null);
		try {
			const s = await updateExistingImport(
				this.app, this.settings.rootFolder, runFolder, token,
				(p) => paint(
					p.total ? `Updating ${p.done} of ${p.total}` : "Updating…",
					p.title,
					p.total ? p.done / p.total : null,
				),
				{ importShared: this.settings.importShared, keepSource: this.settings.keepImportSource, isCancelled: () => this.dynalistCancel.cancelled, onlyDocIds },
			);
			progress.hide();
			invalidateDocScan();
			// Updated documents may be open: reload their indexes from disk so the
			// view shows the new text and its next save can't overwrite it. Exactly
			// the documents written — some may live outside the run folder now.
			const touched = [...new Set(s.touchedFolders)];
			for (const folder of touched) await this.reloadDocViews(folder);
			await this.markDueAsSeen(touched);
			this.refreshPanels();
			const parts = [
				`${s.itemsUpdated} updated`, `${s.itemsBackfilled} metadata-backfilled`, `${s.itemsAdded} added`, `${s.itemsRemovedMarked} marked removed`,
			];
			if (s.itemsConflicted) parts.push(`${s.itemsConflicted} changed on both sides — yours kept`);
			if (s.itemsKeptDeleted) parts.push(`${s.itemsKeptDeleted} you removed not brought back`);
			if (s.docsUnchanged) parts.push(`${s.docsUnchanged} docs unchanged`);
			const docParts: string[] = [];
			if (s.docsAdded) docParts.push(`${s.docsAdded} new doc${s.docsAdded === 1 ? "" : "s"}`);
			if (s.docsRemovedMarked) docParts.push(`${s.docsRemovedMarked} doc${s.docsRemovedMarked === 1 ? "" : "s"} marked removed`);
			let msg = `Trynalist: ${s.cancelled ? "update cancelled — " : ""}${s.docResults.length} of ${s.docsTotal} document${s.docsTotal === 1 ? "" : "s"} changed in "${runFolder}" (${parts.join(", ")}).`;
			if (docParts.length) msg += ` ${docParts.join(", ")}.`;
			if (s.failures.length) {
				msg += ` ${s.failures.length} failed. First: ${s.failures[0].reason}`;
				console.warn("Trynalist: update failures", s.failures);
			}
			const reportFile = await writeUpdateReport(this.app, this.settings.rootFolder, runFolder, s);
			this.showCompletionNotice(msg, reportFile);
		} catch (e) {
			progress.hide();
			console.error("Trynalist: update failed", e);
			this.showCompletionNotice(`Trynalist: update failed — ${e instanceof Error ? e.message : String(e)}`, null);
		} finally {
			this.dynalistImportActive = false;
		}
	}

	/** Paint the import/update progress notice: a heading, a muted (truncated)
	 *  current-item line, a slim progress bar, and a tidy Cancel. Clicking Cancel
	 *  flips the controller and repaints itself into a "Cancelling…" state. */
	private paintImportNotice(
		el: HTMLElement,
		o: { label: string; detail?: string; fraction: number | null; controller: { cancelled: boolean } },
	): void {
		el.empty();
		el.addClass("trynalist-import-notice");
		const cancelling = o.controller.cancelled;
		el.createDiv({ cls: "tin-label", text: cancelling ? "Cancelling…" : o.label });
		if (o.detail && !cancelling) el.createDiv({ cls: "tin-detail", text: o.detail });
		if (o.fraction != null) {
			const pct = Math.round(Math.max(0, Math.min(1, o.fraction)) * 100);
			const bar = el.createDiv({ cls: "tin-bar" });
			bar.createDiv({ cls: cancelling ? "tin-fill is-cancelling" : "tin-fill" }).style.width = `${pct}%`;
		}
		if (!cancelling) {
			const row = el.createDiv({ cls: "tin-actions" });
			const b = row.createEl("button", { text: "Cancel", cls: "trynalist-notice-cancel" });
			b.addEventListener("click", () => { o.controller.cancelled = true; this.paintImportNotice(el, o); });
		}
	}

	/** A persistent completion notice with an "Open report" button, so the report
	 *  is one click away without stealing focus when the run finishes. */
	private showCompletionNotice(message: string, report: TFile | null): void {
		const notice = this.stickyNotice();
		const el = notice.messageEl;
		el.addClass("trynalist-import-notice");
		el.createDiv({ text: message });
		const row = el.createDiv({ cls: "tin-actions" });
		if (report) {
			const b = row.createEl("button", { text: "Open report", cls: "trynalist-notice-cancel" });
			b.addEventListener("click", () => { void this.app.workspace.getLeaf("tab").openFile(report); notice.hide(); });
		}
		const dismiss = row.createEl("button", { text: "Dismiss", cls: "trynalist-notice-cancel" });
		dismiss.addEventListener("click", () => notice.hide());
	}

	/** A notice that stays until one of ITS OWN buttons closes it. Obsidian's
	 *  Notice hides on any click anywhere on it, so a stray click while reading
	 *  a multi-line import summary — or while the import was still running —
	 *  made the whole thing vanish. Clicks inside the body are swallowed here;
	 *  only the explicit buttons (Cancel, Open report, Dismiss) call hide(). */
	private stickyNotice(): Notice {
		const notice = new Notice("", 0);
		for (const type of ["click", "mousedown", "pointerdown"] as const) {
			notice.messageEl.addEventListener(type, (e) => e.stopPropagation());
		}
		return notice;
	}

	/** Mark every due item under a folder as already-notified, WITHOUT announcing —
	 *  so a freshly imported calendar of dated nodes doesn't fire a burst of toasts
	 *  the moment the import ends. Returns how many were marked, for the summary.
	 *  Only items that would fire RIGHT NOW (already due, or inside the lead
	 *  time) are marked — the same filter the reminder tick uses. Marking
	 *  everything dueItems() returns also silenced every item due later within
	 *  the agenda horizon (7 days by default), so tomorrow's appointment
	 *  never spoke. */
	private async markDueAsSeen(underFolder: string | string[]): Promise<number> {
		const folders = (Array.isArray(underFolder) ? underFolder : [underFolder]).map((f) => `${f}/`);
		if (!folders.length) return 0;
		try {
			this.dueGen++;   // the import just wrote dated items the cache can't know about
			const items = (await this.dueItems()).filter((item) => folders.some((f) => item.docPath.startsWith(f)));
			let count = 0;
			for (const item of dueForNotice(items, this.reminderState, this.settings)) {
				this.reminderState[item.itemId] = { ...this.reminderState[item.itemId], notifiedFor: item.due };
				count++;
			}
			if (count) await this.saveSettings();
			return count;
		} catch (e) {
			console.error("[Trynalist] marking imported due items as seen failed", e);
			return 0;
		}
	}

	/** On startup, offer to continue any import a crash left unfinished. */
	async checkForResumableImport(): Promise<void> {
		const root = this.app.vault.getFolderByPath(this.settings.rootFolder.replace(/\/+$/, ""));
		if (!root) return;
		for (const child of root.children) {
			if (!(child instanceof TFolder)) continue;
			const info = await findResumable(this.app, this.settings.rootFolder, child.name);
			if (!info) continue;
			new ConfirmModal(this.app, {
				title: "Resume Dynalist import?",
				body: `An import of "${info.runFolder}" was interrupted at ${info.done}/${info.total} documents. Continue where it left off?`,
				cta: "Resume",
				onConfirm: () => void this.resumeDynalistImport(info.runFolder),
			}).open();
			return;                                    // one at a time
		}
	}

	/** Back up every Trynalist document into one archive beside the root. */
	async backupCollection(): Promise<void> {
		const notice = new Notice("Trynalist: backing up…", 0);
		try {
			const r = await exportCollection(this.app, this.settings.rootFolder);
			notice.hide();
			new Notice(`Trynalist: backed up ${r.docCount} document${r.docCount === 1 ? "" : "s"} (${r.fileCount} files) → "${r.path}".`, 8000);
		} catch (e) {
			notice.hide();
			console.error("Trynalist: backup failed", e);
			new Notice(`Trynalist: backup failed — ${e instanceof Error ? e.message : String(e)}`, 8000);
		}
	}

	/** Pick a backup zip from the vault and restore it into a fresh folder. */
	pickBackupToRestore(): void {
		const zips = this.app.vault.getFiles().filter((f) => f.extension === "zip");
		if (!zips.length) {
			new Notice("Trynalist: no .zip backups found in the vault. Run a backup first, or add the zip to your vault.");
			return;
		}
		const restoreBackup = (f: TFile): void => { void this.restoreBackup(f); };
		class ZipPicker extends FuzzySuggestModal<TFile> {
			getItems(): TFile[] { return zips; }
			getItemText(f: TFile): string { return f.path; }
			onChooseItem(f: TFile): void { restoreBackup(f); }
		}
		new ZipPicker(this.app).open();
	}

	async restoreBackup(file: TFile): Promise<void> {
		const notice = new Notice("Trynalist: restoring…", 0);
		try {
			const data = await this.app.vault.readBinary(file);
			const r = await restoreCollection(this.app, this.settings.rootFolder, data);
			notice.hide();
			invalidateDocScan();
			this.refreshPanels();
			new Notice(`Trynalist: restored ${r.docCount} document${r.docCount === 1 ? "" : "s"} into "${r.folder}". The restored copies keep their original ids, so if the originals are still here, mirrors and reminders may resolve to either — delete one set when you're done comparing.`, 12000);
		} catch (e) {
			notice.hide();
			console.error("Trynalist: restore failed", e);
			new Notice(`Trynalist: restore failed — ${e instanceof Error ? e.message : String(e)}`, 8000);
		}
	}

	/** Open a bookmark: its document, zoom root, and saved search. */
	async openBookmark(bm: Bookmark): Promise<void> {
		let file = this.app.vault.getAbstractFileByPath(bm.docPath);
		if (!(file instanceof TFile)) {
			// The folder may have been renamed since — fall back to the doc id.
			const docs = await listDocs(this.app, this.settings.rootFolder);
			const match = docs.find((d) => d.manifest.id === bm.docId);
			if (!match) {
				new Notice(`Trynalist: the document for "${bm.label}" no longer exists.`);
				return;
			}
			file = match.file;
			bm.docPath = match.file.path;   // heal the stored path
			await this.saveSettings();
		}
		if (!(file instanceof TFile)) return;
		const docPath = file.path;
		await this.openDocFile(file);
		window.setTimeout(() => {
			// The view that holds THIS document — not whichever leaf is active,
			// which with "focus new tab" off (or the doc already open behind
			// another tab) is a different document entirely.
			const view = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
				.map((l) => l.view)
				.find((v): v is TrynalistDocView => v instanceof TrynalistDocView && v.file?.path === docPath);
			void view?.applyBookmark(bm.itemId, bm.query);
		}, 300);
	}

	/** Re-render every open outline (appearance settings changed). */
	refreshDocViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof TrynalistDocView) v.render();
		}
	}

	/** Re-READ every open outline whose document lives under `underPath` (or
	 *  all of them). A view keeps its own in-memory index from open time;
	 *  anything that writes to a document's files from outside that view — the
	 *  inbox capture, the orphan fix, a Dynalist update, a trash restore — has to
	 *  ask the view to reload, or the view keeps painting (and then saving over)
	 *  a tree that no longer matches the disk. */
	/** Close every open document tab under a folder, waiting for each to
	 *  flush its pending saves (the view's onUnloadFile does that). Returns how
	 *  many were closed. For operations that change what the folder IS, where
	 *  a reload is not possible. */
	async closeDocViews(underPath: string): Promise<number> {
		const prefix = `${underPath.replace(/\/+$/, "")}/`;
		let closed = 0;
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			// A tab not shown since startup is a deferred stub with no index
			// (nothing to flush); match it by the file in its saved state.
			const statePath = leaf.getViewState().state?.file;
			const path = v instanceof TrynalistDocView ? v.file?.path : typeof statePath === "string" ? statePath : undefined;
			if (!path?.startsWith(prefix)) continue;
			try {
				if (v instanceof TrynalistDocView) await leaf.setViewState({ type: "empty" });
				leaf.detach();
				closed++;
			} catch (e) {
				console.error("Trynalist: could not close an open document", e);
			}
		}
		return closed;
	}

	async reloadDocViews(underPath?: string): Promise<void> {
		const prefix = underPath ? `${underPath.replace(/\/+$/, "")}/` : null;
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			if (!(v instanceof TrynalistDocView)) continue;
			if (prefix && !v.file?.path.startsWith(prefix)) continue;
			try {
				await v.reload();
			} catch (e) {
				console.error("Trynalist: could not reload an open document", e);
			}
		}
	}

	/** Re-render every open documents panel (bookmarks/recents changed). */
	refreshPanels(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof TrynalistPanelView) void v.render();
		}
		for (const [type] of PANE_TYPES) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const v = leaf.view as { render?: () => Promise<void> };
				void v.render?.();
			}
		}
	}

	/** Remember a document in the recents list. */
	async noteRecentDoc(path: string): Promise<void> {
		const recents = this.settings.recentDocs.filter((p) => p !== path);
		recents.unshift(path);
		this.settings.recentDocs = recents.slice(0, this.settings.recentLimit);
		await this.saveSettings();
		this.refreshPanels();
	}

	async openDoc(doc: DocRef): Promise<void> {
		// Reuse an existing tab already showing this doc.
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			if (v instanceof TrynalistDocView && v.file?.path === doc.file.path) {
				void this.app.workspace.revealLeaf(leaf);
				return;
			}
		}
		const { leaf, from } = this.leafForDoc();
		this.trackOpenedLeaf(leaf, from);
		await leaf.openFile(doc.file);
	}

	async exportDoc(doc: DocRef): Promise<void> {
		const index = new DocIndex(this.app, doc);
		await index.load();
		await exportDocZip(this.app, index);
	}

	/** What this device last read from / wrote to data.json — the base of the
	 *  three-way merge in mergeFromDisk. Null while loadSettings runs. */
	private settingsBase: Record<string, unknown> | null = null;

	/** Bring in what another device wrote to data.json since this one last
	 *  read or wrote it, keeping this device's own changes (settings-merge.ts).
	 *  Before, every save wrote the whole in-memory object, so a device that
	 *  had been open since the morning wrote its old templates, bookmarks and
	 *  per-document settings over the ones just synced in from the phone. */
	private async mergeFromDisk(): Promise<{ changed: boolean; keptLocal: boolean }> {
		const base = this.settingsBase;
		if (!base) return { changed: false, keptLocal: false };
		let disk: Record<string, unknown> | null;
		try {
			disk = (await this.loadData()) as Record<string, unknown> | null;
		} catch (e) {
			// Half-written by a sync, say. Save as before rather than fail.
			console.error("Trynalist: could not read data.json to merge", e);
			return { changed: false, keptLocal: false };
		}
		if (!disk) return { changed: false, keptLocal: false };
		const { reminderState: diskReminders, ...remote } = disk;
		if (stableStringify(remote) === stableStringify(base)) return { changed: false, keptLocal: false };
		const merged = mergeSettings(base, this.settings as unknown as Record<string, unknown>, remote);
		this.settings = { ...DEFAULT_SETTINGS, ...(merged as Partial<TrynalistSettings>) };
		this.settings.rootFolder = sanitizeRoot(this.settings.rootFolder);
		this.reminderState = { ...((diskReminders as ReminderState | undefined) ?? {}), ...this.reminderState };
		this.settingsBase = JSON.parse(JSON.stringify(remote)) as Record<string, unknown>;
		return { changed: true, keptLocal: stableStringify(merged) !== stableStringify(remote) };
	}

	/** Obsidian calls this when data.json changes on disk from outside (a sync). */
	async onExternalSettingsChange(): Promise<void> {
		const { changed, keptLocal } = await this.mergeFromDisk();
		if (!changed) return;
		// Write back only when this device had changes of its own to keep;
		// otherwise adopting the synced copy is enough (no sync churn).
		if (keptLocal) await this.saveSettings();
		else this.settingsBase = JSON.parse(JSON.stringify(this.settings)) as Record<string, unknown>;
		this.refreshPanels();
		this.applyBodyClasses();   // a synced "strike through completed" change
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			if (leaf.view instanceof TrynalistDocView) leaf.view.render();
		}
	}

	async loadSettings(): Promise<void> {
		this.settingsBase = null;
		// loadData() is typed `any`; route it through `unknown` so the merge
		// below is a checked assertion rather than an any carried forward.
		const raw: unknown = await this.loadData();
		const data: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		const { reminderState, ...settings } = data;
		this.settings = { ...DEFAULT_SETTINGS, ...(settings as Partial<TrynalistSettings>) };
		this.reminderState = (reminderState as ReminderState) ?? {};
		// The root is a path component everywhere; keep it in the same shape the
		// settings tab now enforces, so an old value with a trailing slash can't
		// break every prefix check.
		this.settings.rootFolder = sanitizeRoot(this.settings.rootFolder);
		// One-time migration into Obsidian's keychain from either earlier storage:
		// an Electron-safeStorage blob (dynalistTokenEnc) or a plaintext field.
		// After a successful move the settings copy is wiped so the token lives
		// only in the keychain.
		if (keychainAvailable(this.app)) {
			if (!getToken(this.app)) {
				const legacy = this.settings.dynalistTokenEnc
					? legacyDecrypt(this.settings.dynalistTokenEnc)
					: (this.settings.dynalistToken || null);
				if (legacy && await setToken(this.app, legacy)) {
					this.settings.dynalistTokenEnc = "";
					this.settings.dynalistToken = "";
					await this.saveSettings();
				}
			} else if (this.settings.dynalistToken || this.settings.dynalistTokenEnc) {
				// The keychain already holds a token, so a plaintext copy in
				// data.json (say, synced in from a device without a keychain) has
				// no job — and would be re-saved forever. The keychain wins.
				this.settings.dynalistToken = "";
				this.settings.dynalistTokenEnc = "";
				await this.saveSettings();
			}
		}
		this.settingsBase = JSON.parse(JSON.stringify(this.settings)) as Record<string, unknown>;
	}

	/** Coalesced settings write for the callers that fire per keystroke or per
	 *  focus change (last-focused item, the search box). `saveSettings` is a
	 *  full `data.json` rewrite; arrowing down a list wrote it once per row. */
	private saveSoonTimer: number | null = null;
	saveSettingsSoon(): void {
		if (this.saveSoonTimer) window.clearTimeout(this.saveSoonTimer);
		this.saveSoonTimer = window.setTimeout(() => {
			this.saveSoonTimer = null;
			void this.saveSettings();
		}, 1000);
	}

	/** The Dynalist token: from Obsidian's keychain when available, else the
	 *  plaintext settings fallback (platforms with no keychain). "" when unset. */
	getDynalistToken(): string {
		if (keychainAvailable(this.app)) {
			const t = getToken(this.app);
			if (t) return t;
		}
		return this.settings.dynalistToken;
	}

	/** Store the token in the keychain when available, else in plaintext settings
	 *  (with the UI warning the user). Returns whether the keychain was used. */
	async setDynalistToken(token: string): Promise<boolean> {
		const t = token.trim();
		if (keychainAvailable(this.app)) {
			await setToken(this.app, t);
			this.settings.dynalistToken = "";
			this.settings.dynalistTokenEnc = "";
			await this.saveSettings();
			return true;
		}
		this.settings.dynalistToken = t;
		this.settings.dynalistTokenEnc = "";
		await this.saveSettings();
		return false;
	}

	/** Adopt a token already sitting in the keychain under a "dynalist" id (our
	 *  own, or one another tool wrote). When it lives under a different id, copy
	 *  the VALUE into our canonical id so lookups find it — a write to our own
	 *  secret only, never a change to the other id. Returns the source id, or
	 *  null when nothing matched. */
	async adoptKeychainToken(): Promise<string | null> {
		const found = importFromKeychain(this.app);
		if (!found) return null;
		if (found.id !== TOKEN_SECRET_ID) await setToken(this.app, found.token);
		// The keychain is now the home; a plaintext copy must not linger beside it.
		if (this.settings.dynalistToken || this.settings.dynalistTokenEnc) {
			this.settings.dynalistToken = "";
			this.settings.dynalistTokenEnc = "";
			await this.saveSettings();
		}
		return found.id;
	}

	async saveSettings(): Promise<void> {
		if (this.saveSoonTimer) { window.clearTimeout(this.saveSoonTimer); this.saveSoonTimer = null; }
		// Another device may have written since we last read: merge first.
		const { changed } = await this.mergeFromDisk();
		await this.saveData({ ...this.settings, reminderState: this.reminderState });
		this.settingsBase = JSON.parse(JSON.stringify(this.settings)) as Record<string, unknown>;
		if (changed) this.refreshPanels();
		if (this.settings.safetyNet) this.safetyNet?.noteSettingsSaved({ ...this.settings });
	}

	/** Carry path-keyed settings across a rename: a `.trynalist` file moving,
	 *  or a folder moving (every manifest under it moves with it). */
	private movePathKeys(oldPath: string, newPath: string, isFolder: boolean): void {
		const map = (p: string): string | null => {
			if (isFolder) return p.startsWith(`${oldPath}/`) ? newPath + p.slice(oldPath.length) : null;
			return p === oldPath ? newPath : null;
		};
		if (!isFolder && !oldPath.endsWith(`.${DOC_EXTENSION}`)) return;
		let changed = false;
		const s = this.settings;
		const records = [s.docHideCompleted, s.docNoteDisplay, s.docTextDirection, s.lastFocus, s.docScale, s.viewModes] as Array<Record<string, unknown> | undefined>;
		for (const rec of records) {
			if (!rec) continue;
			for (const key of Object.keys(rec)) {
				const to = map(key);
				if (to === null || to === key) continue;
				rec[to] = rec[key];
				delete rec[key];
				changed = true;
			}
		}
		s.recentDocs = (s.recentDocs ?? []).map((p) => { const to = map(p); if (to !== null && to !== p) changed = true; return to ?? p; });
		for (const b of s.bookmarks ?? []) {
			const to = map(b.docPath);
			if (to !== null && to !== b.docPath) { b.docPath = to; changed = true; }
		}
		if (changed) this.saveSettingsSoon();
	}

	/** Save every open document's unsaved typing (row debounces and notes). */
	/** `andBlankRows`: also write the blank rows that live only in memory until
	 *  the view closes — right when the app itself is going away, since a
	 *  closing view is exactly what may never happen on a killed phone app
	 *  (L2). Not on every desktop window switch: that would give each blank
	 *  row a file the moment you looked away. */
	async flushOpenDocs(andBlankRows = false): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)) {
			const v = leaf.view;
			if (!(v instanceof TrynalistDocView)) continue;
			try {
				await v.flushEdits();
				if (andBlankRows) await v.persistBlankRows();
			} catch (e) { console.error("Trynalist: could not save pending edits", e); }
		}
	}

	onunload(): void {
		void this.flushOpenDocs();
		// A coalesced write still pending must land, or the last focus/search
		// state is lost on disable.
		if (this.saveSoonTimer) {
			window.clearTimeout(this.saveSoonTimer);
			this.saveSoonTimer = null;
			void this.saveData({ ...this.settings, reminderState: this.reminderState });
		}
		// A settings snapshot still waiting for its interval is written now.
		if (this.settings.safetyNet) void this.safetyNet?.flushSettings({ ...this.settings });
		this.safetyNet?.dispose();
		void this.itemHistory?.flush(true);
		this.itemHistory?.dispose();
	}
}

/** The root folder as a clean vault path: normalised, no trailing slash, no
 *  `..` segments. A trailing slash — easy to type — silently broke every
 *  `startsWith(root + "/")` check in the panels and the reminder code. */
/** Folder autocomplete for a settings text field (house rule: every field
 *  naming a vault folder suggests existing ones). */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement) { super(app, input); }
	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault.getAllFolders(false)
			.filter((f) => f.path.toLowerCase().includes(q))
			.slice(0, 50);
	}
	renderSuggestion(folder: TFolder, el: HTMLElement): void { el.setText(folder.path); }
	selectSuggestion(folder: TFolder): void {
		this.input.value = folder.path;
		this.input.dispatchEvent(new Event("input"));
		this.close();
		this.input.blur();
	}
}

function sanitizeRoot(raw: string): string {
	const trimmed = normalizePath((raw ?? "").trim()).replace(/\/+$/, "");
	if (!trimmed || trimmed === "/" || trimmed.split("/").some((s) => s === "..")) return DEFAULT_SETTINGS.rootFolder;
	return trimmed;
}

class TrynalistSettingTab extends PluginSettingTab {
	constructor(private plugin: TrynalistPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Root folder")
			.setDesc("Vault folder that holds your documents (one subfolder per document).")
			.addText((t) => {
				t.setValue(this.plugin.settings.rootFolder);
				// Applied when you leave the field or press Enter, not per
				// keystroke: typing "../x" passed through "." and ".." on the way,
				// and one of those stuck (L40). A rejected value puts the last good
				// one back in the field.
				const apply = async (): Promise<void> => {
					const v = t.getValue();
					if (v.split("/").some((seg) => seg === ".." || seg === ".")) {
						new Notice("Trynalist: the root folder can't contain \".\" or \"..\".");
						t.setValue(this.plugin.settings.rootFolder);
						return;
					}
					const next = sanitizeRoot(v);
					t.setValue(next);
					if (next === this.plugin.settings.rootFolder) return;
					this.plugin.settings.rootFolder = next;
					invalidateDocScan();
					this.plugin.dueGen++;
					await this.plugin.saveSettings();
					this.plugin.refreshPanels();
				};
				t.inputEl.addEventListener("blur", () => void apply());
				t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); t.inputEl.blur(); } });
				new FolderSuggest(this.app, t.inputEl);
			});

		new Setting(containerEl)
			.setName("Dynalist import")
			.setHeading();
		const hasToken = !!this.plugin.getDynalistToken();
		const encrypted = keychainAvailable(this.plugin.app);
		const storageNote = encrypted
			? "Stored in your OS keychain via Obsidian — never in plain text in the vault."
			: "⚠️ Obsidian's keychain isn't available here, so the token would be stored in plain text in this vault's plugin data.";
		let tokenField: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Dynalist API token")
			.setDesc(
				`Paste your secret token from dynalist.io → Settings → Developer. Used only to READ your Dynalist — nothing is ever written back. ${storageNote}`
				+ (hasToken ? " A token is saved; type to replace it." : ""),
			)
			.addText((t) => {
				tokenField = t;
				// Never render the stored secret back into the field. Show a masked
				// placeholder when one exists; an empty submit leaves it unchanged.
				t.setPlaceholder(hasToken ? "•••••••• (saved)" : "secret token")
					.onChange(() => { /* saved via the Save button, not per keystroke */ });
				t.inputEl.type = "password";
			})
			.addExtraButton((b) =>
				b.setIcon("check").setTooltip("Test the saved token").onClick(async () => {
					const typed = (tokenField?.getValue() ?? "").trim();
					const token = typed || this.plugin.getDynalistToken();
					if (!token) { new Notice("Trynalist: enter a token first."); return; }
					try {
						const n = await testToken(token);
						new Notice(`Trynalist: token works — Dynalist has ${n} file${n === 1 ? "" : "s"}.`);
					} catch (e) {
						new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}`, 8000);
					}
				}),
			)
			.addButton((b) =>
				b.setButtonText("Save").onClick(async () => {
					const typed = (tokenField?.getValue() ?? "").trim();
					if (!typed) { new Notice("Trynalist: enter a token to save."); return; }
					const enc = await this.plugin.setDynalistToken(typed);
					if (tokenField) tokenField.setValue("");
					new Notice(enc ? "Trynalist: token saved to your keychain." : "Trynalist: token saved (plain text — no keychain available).");
					this.display();
				}),
			)
			.addExtraButton((b) =>
				b.setIcon("trash").setTooltip("Forget the saved token").onClick(async () => {
					await this.plugin.setDynalistToken("");
					new Notice("Trynalist: token forgotten.");
					this.display();
				}),
			);
		// Security guidance: a token is a standing key to the whole account.
		// Encourage revoking it once the migration is done.
		const sec = new Setting(containerEl).setName("When you're done").setClass("trynalist-setting-note");
		const secDesc = createFragment((f) => {
			f.appendText("A token is a standing read-key to your whole Dynalist. Once you've finished importing, revoke it on the ");
			f.createEl("a", { text: "Dynalist developer page", href: "https://dynalist.io/developer" });
			f.appendText(" (Generate replaces the old one, so you can always make a fresh token later). API reference: ");
			f.createEl("a", { text: "apidocs.dynalist.io", href: "https://apidocs.dynalist.io" });
			f.appendText(".");
		});
		sec.setDesc(secDesc);

		if (encrypted) {
			const matches = findDynalistSecretIds(this.plugin.app);
			new Setting(containerEl)
				.setName("Use a token from your keychain")
				.setDesc(
					matches.length
						? `Found in your keychain: ${matches.join(", ")}. Adopt it instead of pasting.`
						: "Scans Obsidian's keychain for a secret whose id contains \"dynalist\" and uses it — for a token another tool stored, or one you saved under a different id.",
				)
				.addButton((b) =>
					b.setButtonText("Import from keychain").onClick(async () => {
						// Say exactly which secret would be used, masked, before it is
						// adopted: any id merely containing "dynalist" matched, and the
						// value is sent to dynalist.io on the next import (L70).
						const found = importFromKeychain(this.plugin.app);
						if (!found) { new Notice("Trynalist: no \"dynalist\" secret found in the keychain."); return; }
						const masked = `${found.token.slice(0, 4)}… (${found.token.length} characters)`;
						const ok = await new Promise<boolean>((resolve) => new ConfirmModal(this.plugin.app, {
							title: "Use this keychain secret as your Dynalist token?",
							body: `Secret "${found.id}": ${masked}. It will be sent to dynalist.io when you import. Only continue if it is your Dynalist API token.`,
							cta: "Use it",
							onConfirm: () => resolve(true),
							onCancel: () => resolve(false),
						}).open());
						if (!ok) return;
						const id = await this.plugin.adoptKeychainToken();
						if (!id) { new Notice("Trynalist: no \"dynalist\" secret found in the keychain."); return; }
						new Notice(`Trynalist: using keychain secret "${id}".`);
						this.display();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Built-in shortcuts")
			.setDesc("Dynalist-style chords inside a document: Mod+] / Mod+[ zoom, Mod+Up / Mod+Down move, Mod+Shift+C checkbox, Mod+Z structural undo, and the rest. Turn off to set your own in Obsidian's hotkey settings.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.builtinShortcuts).onChange(async (v) => {
					this.plugin.settings.builtinShortcuts = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Import documents shared with me")
			.setDesc("Also import documents others shared with you (not just ones you own).")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.importShared).onChange(async (v) => {
					this.plugin.settings.importShared = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Keep raw source with each import")
			.setDesc("Saves the exact API responses in a _source folder per run — an immutable snapshot to rebuild from later. Never touched by normal use.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.keepImportSource).onChange(async (v) => {
					this.plugin.settings.keepImportSource = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Import everything")
			.setDesc("Recreates your folders and documents under the root folder. Read-only: nothing is changed at the source.")
			.addButton((b) =>
				b.setButtonText("Import now").setCta().onClick(() => void this.plugin.importFromDynalist()),
			);

		new Setting(containerEl).setName("Backup").setHeading();
		new Setting(containerEl)
			.setName("Back up the whole collection")
			.setDesc("Archives every Trynalist document into one .zip beside the root folder — lossless, so restoring is exact.")
			.addButton((b) => b.setButtonText("Back up now").onClick(() => void this.plugin.backupCollection()));
		new Setting(containerEl)
			.setName("Restore from a backup")
			.setDesc("Unpacks a backup .zip into a fresh dated folder under the root — never overwrites what's already there.")
			.addButton((b) => b.setButtonText("Restore…").onClick(() => this.plugin.pickBackupToRestore()));
		new Setting(containerEl)
			.setName("Automatic snapshots")
			.setDesc(`Keeps local copies of these settings (templates, bookmarks, per-document settings) whenever they change, and of the whole outline once a day, in the hidden ${SAFETY_DIR} folder, for 30 days. Obsidian Sync does not sync that folder, so if another device overwrites your data, this device still has its own history.`)
			.addToggle((t) => t.setValue(this.plugin.settings.safetyNet).onChange(async (v) => {
				this.plugin.settings.safetyNet = v;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Item history")
			.setDesc("Also keeps every version of every item for 30 days — your edits and changes that arrive from other devices — so one item can be put back without restoring a whole day. Open it from an item's menu, or use the command for recently deleted items.")
			.addToggle((t) => t.setValue(this.plugin.settings.itemHistory).onChange(async (v) => {
				this.plugin.settings.itemHistory = v;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Include attachments in the daily snapshot")
			.setDesc("Off keeps the daily snapshot to the outline itself, which is small. On also copies images and files stored in document folders.")
			.addToggle((t) => t.setValue(this.plugin.settings.safetyNetAttachments).onChange(async (v) => {
				this.plugin.settings.safetyNetAttachments = v;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Restore settings from a snapshot")
			.setDesc("Pick an earlier copy of these settings. Your current settings are snapshotted first.")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => void this.plugin.pickSettingsSnapshot()));
		new Setting(containerEl)
			.setName("Restore an outline snapshot")
			.setDesc("Unpacks one day's outline into a fresh dated folder under the root. Never overwrites anything.")
			.addButton((b) => b.setButtonText("Choose…").onClick(() => void this.plugin.pickOutlineSnapshot()));

		new Setting(containerEl)
			.setName("Strike through completed items")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.strikeCompleted).onChange(async (v) => {
					this.plugin.settings.strikeCompleted = v;
					await this.plugin.saveSettings();
					this.plugin.applyBodyClasses();
				}),
			);

		new Setting(containerEl)
			.setName("Hide completed items")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideCompleted).onChange(async (v) => {
					this.plugin.settings.hideCompleted = v;
					await this.plugin.saveSettings();
					this.plugin.refreshDocViews();
				}),
			);

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("List density")
			.setDesc("Vertical spacing between items.")
			.addDropdown((d) =>
				d.addOptions({ compact: "Compact", cozy: "Cozy", comfortable: "Comfortable" })
					.setValue(this.plugin.settings.density)
					.onChange(async (v) => {
						this.plugin.settings.density = v as Density;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		new Setting(containerEl)
			.setName("Notes")
			.setDesc("How the note under an item is shown.")
			.addDropdown((d) =>
				d.addOptions({ full: "Show in full", "one-line": "Collapse to one line", hidden: "Hide" })
					.setValue(this.plugin.settings.noteDisplay)
					.onChange(async (v) => {
						this.plugin.settings.noteDisplay = v as NoteDisplay;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		const toggle = (
			name: string,
			desc: string,
			get: () => boolean,
			set: (v: boolean) => void,
		) => {
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
				t.setValue(get()).onChange(async (v) => {
					set(v);
					await this.plugin.saveSettings();
					this.plugin.refreshDocViews();
				}),
			);
		};

		toggle("Display images inline", "Show embedded images in the outline instead of a file chip.",
			() => this.plugin.settings.inlineImages, (v) => (this.plugin.settings.inlineImages = v));
		toggle("Highlight current item", "Tint the row being edited.",
			() => this.plugin.settings.highlightCurrentItem, (v) => (this.plugin.settings.highlightCurrentItem = v));
		toggle("Center align document", "Add margins either side of the outline.",
			() => this.plugin.settings.centerAlign, (v) => (this.plugin.settings.centerAlign = v));
		toggle("Document border", "Draw a light border around the outline.",
			() => this.plugin.settings.documentBorder, (v) => (this.plugin.settings.documentBorder = v));
		new Setting(containerEl)
			.setName("Clicking a bullet")
			.setDesc("Dynalist's default is that the bullet collapses and the magnifier beside it zooms. Swapping makes the bullet zoom and turns that icon into a +/- collapse control.")
			.addDropdown((d) =>
				d.addOptions({ collapse: "Collapses / expands (Dynalist default)", zoom: "Zooms in" })
					.setValue(this.plugin.settings.bulletClick)
					.onChange(async (v) => {
						this.plugin.settings.bulletClick = v as "zoom" | "collapse";
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		toggle("Tag background colour", "Give #tags and @tags a tinted background.",
			() => this.plugin.settings.tagBackground, (v) => (this.plugin.settings.tagBackground = v));

		new Setting(containerEl).setName("Dates").setHeading();

		new Setting(containerEl)
			.setName("Date format")
			.setDesc('How dates are displayed. Uses moment.js tokens, e.g. "MMM D, YYYY" or "DD/MM/YYYY".')
			.addText((t) =>
				t.setPlaceholder("MMM D, YYYY")
					.setValue(this.plugin.settings.dateFormat)
					.onChange(async (v) => {
						this.plugin.settings.dateFormat = v.trim() || DEFAULT_SETTINGS.dateFormat;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		// Declared before use: the dropdown's onChange (below) needs to toggle
		// the AM/PM row that the block after it creates.
		let setAmPmVisible: (on: boolean) => void = () => {};

		new Setting(containerEl)
			.setName("Time format")
			.addDropdown((d) =>
				d.addOptions({ "12": "12-hour", "24": "24-hour" })
					.setValue(this.plugin.settings.timeFormat)
					.onChange(async (v) => {
						this.plugin.settings.timeFormat = v as "12" | "24";
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
						// The AM/PM row only applies to a 12-hour clock; show it
						// in place rather than rebuilding the whole tab.
						setAmPmVisible(v === "12");
					}),
			);

		{
			const amPm = new Setting(containerEl)
				.setName("Show the time suffix")
				.setDesc("Shows AM or PM after 12-hour times. Turn off to display them without it.")
				.addToggle((t) =>
					t.setValue(this.plugin.settings.showAmPm).onChange(async (v) => {
						this.plugin.settings.showAmPm = v;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
				);
			setAmPmVisible = (on: boolean) => {
				amPm.settingEl.toggle(on);
			};
			setAmPmVisible(this.plugin.settings.timeFormat === "12");
		}

		new Setting(containerEl)
			.setName("Text size")
			.setDesc("Scales outline documents only, independently of Obsidian's own zoom. Individual documents can override this from the document menu.")
			.addSlider((sl) =>
				sl.setLimits(50, 250, 5)
					.setValue(this.plugin.settings.textScale)
					.onChange(async (v) => {
						this.plugin.settings.textScale = v;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		new Setting(containerEl)
			.setName("Default layout")
			.setDesc("Layout a document opens in. Individual documents can override this from the eye menu in their header.")
			.addDropdown((d) =>
				d.addOptions({ outline: "List", flat: "Flat", article: "Article", mindmap: "Mind map" })
					.setValue(this.plugin.settings.defaultViewMode)
					.onChange(async (value) => {
						this.plugin.settings.defaultViewMode = value as DocViewMode;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		new Setting(containerEl)
			.setName("Text direction")
			.setDesc("Reading direction for outlines. Individual documents can override this from the eye menu in their header.")
			.addDropdown((d) =>
				d.addOptions({ ltr: "Left-to-right", rtl: "Right-to-left" })
					.setValue(this.plugin.settings.textDirection)
					.onChange(async (value) => {
						this.plugin.settings.textDirection = value as TextDirection;
						await this.plugin.saveSettings();
						this.plugin.refreshDocViews();
					}),
			);

		new Setting(containerEl).setName("Behaviour").setHeading();

		new Setting(containerEl)
			.setName("Customise the item menu")
			.setDesc("Reorder or hide entries in the right-click menu. Hidden entries stay reachable from the action bar.")
			.addButton((b) => b.setButtonText("Customise").onClick(() => {
				const view = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
					.map((l) => l.view)
					.find((v): v is TrynalistDocView => v instanceof TrynalistDocView && v.hasIndex());
				// The catalogue is read from a live document, because it is produced by
				// running the menu itself — a hand-kept list would drift.
				if (!view) {
					new Notice("Trynalist: open a document first, so the menu's entries can be read.");
					return;
				}
				new CustomiseMenuModal(this.app, this.plugin, view.itemMenuCatalogue(), () => {
					// Nothing to repaint: the menu is rebuilt on every right-click.
				}).open();
			}));

		new Setting(containerEl)
			.setName("Open documents in a new tab")
			.setDesc("Opening a document — from the panels, the file explorer, the quick switcher, a link or the document opener — adds a tab instead of replacing what you are reading. A document already open is revealed rather than opened twice. Closing that tab returns you to the one it was opened from, or the tab to its left.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.openInNewTab).onChange(async (v) => {
					this.plugin.settings.openInNewTab = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Enter on an empty item outdents it")
			.setDesc("Rather than adding another empty sibling — the usual way out of a nested list. At the top level it makes a new item as normal.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enterOnEmptyOutdents).onChange(async (v) => {
					this.plugin.settings.enterOnEmptyOutdents = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Leave empty items out of copies")
			.setDesc("Their children are still copied, at their own depth. A copy usually goes somewhere else, where a bare bullet is noise.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.copySkipEmpty).onChange(async (v) => {
					this.plugin.settings.copySkipEmpty = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Indent copied outlines with")
			.setDesc("Tabs are dropped by many editors and chat boxes, so an outline copied with tabs can arrive flat. Spaces survive everywhere. Pasting an outline back in understands both.")
			.addDropdown((d) =>
				d.addOptions({ "0": "Tabs", "2": "2 spaces", "4": "4 spaces" })
					.setValue(String(this.plugin.settings.copyIndentSpaces))
					.onChange(async (v) => {
						this.plugin.settings.copyIndentSpaces = parseInt(v, 10) || 0;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Pair brackets and formatting marks")
			.setDesc("Typing ( [ { \" ' ` * _ ~ inserts its partner, and typing one with text selected wraps the selection — as in Obsidian's editor. Typing over a closing character steps past it instead of doubling it.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoPair).onChange(async (v) => {
					this.plugin.settings.autoPair = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("First day of the week")
			.addDropdown((d) =>
				d.addOptions({ sunday: "Sunday", monday: "Monday", saturday: "Saturday" })
					.setValue(this.plugin.settings.firstDayOfWeek)
					.onChange(async (v) => {
						this.plugin.settings.firstDayOfWeek = v as TrynalistSettings["firstDayOfWeek"];
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Highlight overdue dates")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.highlightOverdue).onChange(async (v) => {
					this.plugin.settings.highlightOverdue = v;
					await this.plugin.saveSettings();
					this.plugin.refreshDocViews();
				}),
			);

		new Setting(containerEl)
			.setName("When a recurring item is completed")
			.setDesc("Dynalist offered both behaviours.")
			.addDropdown((d) =>
				d.addOptions({
					"new-item": "Create the next occurrence below it",
					"advance-in-place": "Move this item's date forward",
				})
					.setValue(this.plugin.settings.recurrenceMode)
					.onChange(async (v) => {
						this.plugin.settings.recurrenceMode = v as "new-item" | "advance-in-place";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Search archived documents")
			.setDesc("Off by default: archived documents stay out of search, pickers and link suggestions. A separate command searches them when you need to.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.searchArchived).onChange(async (v) => {
					this.plugin.settings.searchArchived = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Reminders").setHeading();

		new Setting(containerEl)
			.setName("Remind me about due items")
			.setDesc("Obsidian has no system notifications, so this is an in-app notice plus the agenda in the documents panel.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.remindersEnabled).onChange(async (v) => {
					this.plugin.settings.remindersEnabled = v;
					await this.plugin.saveSettings();
					// Everything below depends on this being on. Hiding the
					// container beats rebuilding the tab and losing the scroll.
					remindersBody.toggle(v);
				}),
			);

		const remindersBody = containerEl.createDiv();
		remindersBody.toggle(this.plugin.settings.remindersEnabled);
		{
			new Setting(remindersBody)
				.setName("Lead time")
				.setDesc("Minutes before a timed item is due to raise the notice. Set to 0 to notify at the due moment.")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "0";
					t.setValue(String(this.plugin.settings.reminderLeadMinutes)).onChange(async (v) => {
						this.plugin.settings.reminderLeadMinutes = Math.max(0, parseInt(v, 10) || 0);
						await this.plugin.saveSettings();
					});
				});

			new Setting(remindersBody)
				.setName("Snooze length")
				.setDesc("Minutes to postpone an item for when you snooze it from the agenda.")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "1";
					t.setValue(String(this.plugin.settings.snoozeMinutes)).onChange(async (v) => {
						this.plugin.settings.snoozeMinutes = Math.max(1, parseInt(v, 10) || 60);
						await this.plugin.saveSettings();
					});
				});

			new Setting(remindersBody)
				.setName("Quiet hours")
				.setDesc("Suppress the notice during these hours. Items still appear in the agenda — nothing is dropped silently.")
				.addToggle((t) =>
					t.setValue(this.plugin.settings.quietHoursEnabled).onChange(async (v) => {
						this.plugin.settings.quietHoursEnabled = v;
						await this.plugin.saveSettings();
						// Show/hide the two rows in place. Calling display() here
						// rebuilt the whole tab, which threw the scroll position.
						setQuietVisible(v);
					}),
				);

			const quietFrom = new Setting(remindersBody).setName("Quiet from").addText((t) => {
				t.inputEl.type = "time";
				t.setValue(this.plugin.settings.quietHoursFrom).onChange(async (v) => {
					this.plugin.settings.quietHoursFrom = v || "22:00";
					await this.plugin.saveSettings();
				});
			});
			const quietTo = new Setting(remindersBody).setName("Quiet until").addText((t) => {
				t.inputEl.type = "time";
				t.setValue(this.plugin.settings.quietHoursTo).onChange(async (v) => {
					this.plugin.settings.quietHoursTo = v || "07:00";
					await this.plugin.saveSettings();
				});
			});
			// Whole quiet days, as chips. Monday first: the week starts on Monday
			// in ISO-8601, which is also what moment's isoWeekday() counts from,
			// so the row and the stored numbers agree without a lookup table.
			const quietDays = new Setting(remindersBody)
				.setName("Quiet days")
				.setDesc(createFragment((frag) => {
					frag.appendText("Whole days with no reminder toasts. The agenda still lists them.");
					frag.createEl("br");
					frag.appendText("Monday-first, seven-day week only — sorry. If your calendar does not work that way, ");
					frag.createEl("a", {
						text: "Your calendrical fallacy is listed here",
						href: "https://yourcalendricalfallacyis.com/",
					});
					frag.appendText(".");
				}));
			const dayRow = quietDays.controlEl.createDiv({ cls: "trynalist-day-chips" });
			const DAYS: Array<[number, string]> = [
				[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"],
			];
			const paintDays = (): void => {
				dayRow.empty();
				for (const [iso, label] of DAYS) {
					const on = (this.plugin.settings.quietDays ?? []).includes(iso);
					const chip = dayRow.createEl("button", {
						cls: on ? "trynalist-day-chip is-on" : "trynalist-day-chip",
						text: label,
					});
					chip.setAttribute("aria-pressed", on ? "true" : "false");
					chip.setAttribute("aria-label", `${label} — ${on ? "quiet" : "not quiet"}`);
					chip.addEventListener("click", (e) => {
						void (async () => {
							e.preventDefault();
							const list = new Set(this.plugin.settings.quietDays ?? []);
							if (list.has(iso)) list.delete(iso); else list.add(iso);
							// Sorted, so the stored order does not depend on click order.
							this.plugin.settings.quietDays = [...list].sort((a, b) => a - b);
							await this.plugin.saveSettings();
							paintDays();
						})();
					});
				}
			};
			paintDays();

			const setQuietVisible = (on: boolean) => {
				quietFrom.settingEl.toggle(on);
				quietTo.settingEl.toggle(on);
				quietDays.settingEl.toggle(on);
			};
			setQuietVisible(this.plugin.settings.quietHoursEnabled);

			new Setting(remindersBody)
				.setName("Show the agenda in the panel")
				.addToggle((t) =>
					t.setValue(this.plugin.settings.showAgenda).onChange(async (v) => {
						this.plugin.settings.showAgenda = v;
						await this.plugin.saveSettings();
						this.plugin.refreshPanels();
					}),
				);

			new Setting(remindersBody)
				.setName("Agenda horizon")
				.setDesc("How many days ahead the agenda looks.")
				.addText((t) => {
					t.inputEl.type = "number";
					t.inputEl.min = "1";
					t.setValue(String(this.plugin.settings.agendaHorizonDays)).onChange(async (v) => {
						this.plugin.settings.agendaHorizonDays = Math.max(1, parseInt(v, 10) || 7);
						await this.plugin.saveSettings();
						this.plugin.refreshPanels();
					});
				});
		}

		new Setting(containerEl).setName("Capture").setHeading();

		let inboxField: TextComponent | null = null;
		new Setting(containerEl)
			.setName("Inbox document")
			.setDesc("Where the capture command appends new items.")
			.addText((t) => {
				const current = this.plugin.settings.inboxDocPath;
				inboxField = t;
				t.setPlaceholder("None chosen yet")
					.setValue(current ? current.split("/").pop() ?? current : "")
					.setDisabled(true);
			})
			.addButton((b) =>
				b.setButtonText("Choose…").onClick(() => {
					void (async () => {
						const modal = new DocSuggestModal(this.app, this.plugin.settings.rootFolder, (doc) => {
							void (async () => {
								this.plugin.settings.inboxDocPath = doc.file.path;
								await this.plugin.saveSettings();
								// One field changed; setting its value is the whole job.
								inboxField?.setValue(doc.file.path.split("/").pop() ?? doc.file.path);
							})();
						});
						await modal.load();
						modal.open();
					})();
				}),
			);

		new Setting(containerEl).setName("Maintenance").setHeading();

		new Setting(containerEl)
			.setName("Integrity check")
			.setDesc("Look for duplicate manifests, documents nested inside documents, orphaned items and clashing identifiers.")
			.addButton((b) =>
				b.setButtonText("Run check").onClick(async () => {
					const report = await checkIntegrity(this.app, this.plugin.settings.rootFolder);
					new IntegrityModal(this.app, report, (paths) => this.plugin.fixOrphans(paths)).open();
				}),
			);

		new Setting(containerEl)
			.setName("Documents")
			.setDesc("Quick check that the plugin can see your documents.")
			.addButton((b) =>
				b.setButtonText("Check").onClick(async () => {
					const docs = await listDocs(this.app, this.plugin.settings.rootFolder);
					// Shown, not logged: store guidelines ask for no console output.
					const names = docs.slice(0, 8).map((d) => d.manifest.title).join(", ");
					new Notice(`Trynalist: ${docs.length} document(s) found${names ? `: ${names}${docs.length > 8 ? ", …" : ""}` : ""}.`, 8000);
				}),
			);
	}
}
