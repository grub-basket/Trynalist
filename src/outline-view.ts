import { Component, FileView, MarkdownRenderer, Menu, Notice, Scope, TFile, TFolder, Platform, WorkspaceLeaf, getLinkpath, setIcon, setTooltip, normalizePath } from "obsidian";

/** An item id as it may safely appear inside an attribute selector. Ids are
 *  base36 from our own generator, but a hand-written or foreign file can carry
 *  anything, and an unescaped quote or bracket throws inside querySelector. */
const cssId = (id: string): string => CSS.escape(String(id));
import type TrynalistPlugin from "./main";
import { safeName } from "./id-service";
import { DocIndex, carriedFields, copySubtree, movedFields, createDoc, patchManifest, renameDoc, setDocArchived, stripMatches } from "./store";
import type { SortMode } from "./store";
import type { NoteDisplay, SearchMode, SearchSort, TextDirection } from "./types";
import { MirrorResolver, anyMirrorsExist, findMirrorsOf, refTo, resolveAll } from "./mirrors";
import { searchAllDocs } from "./search";
import { openTrash } from "./trash";
import type { GlobalHit } from "./search";
import type { Resolved } from "./mirrors";
import { exportDocZip, renderExport, renderOutlineMarkdown, writeExportFile } from "./export";
import type { ExportFormat } from "./export";
import { ConfirmModal, DatePickerModal, ImageViewerModal, OperatorHelpModal, PromptModal, ReplaceModal } from "./modals";
import { DocSuggestModal, ItemSuggestModal, describeQuery, matchesQuery, parseQuery, trailFor } from "./search";
import { LinkSuggest } from "./link-suggest";
import { neutralizeMarkdown } from "./untrusted";
import { CustomiseMenuModal, MobileToolbar } from "./mobile-toolbar";
import { CommandBar } from "./command-bar";
import { VisibilityMenu } from "./visibility-menu";
import { MindMap, plainOf } from "./mindmap";
import { BOOKMARKS_VIEW_TYPE } from "./panels";
import { ensureMathJax, renderInline, toggleWrap } from "./render";
import { DATE_RE, formatDate, nextOccurrence, parseDate, primaryDate, toSource, withoutLinks } from "./dates";
import type { Bookmark, ClipNode, DocManifest, DocRef, NodeSnapshot, TreeNode, TrynaId } from "./types";
import { DOC_EXTENSION, ATTACHMENTS_SUBFOLDER, DOC_VIEW_TYPE, MAX_HEADING, formatMirrorRef, parseMirrorRef } from "./types";

import type { DocViewMode } from "./types";
import { ItemHistoryModal } from "./history-modal";
import type { ItemVersion } from "./item-history";

/** A trailing "\n" in a pre-wrap contenteditable renders NO line box — the
 *  break exists in the text but the empty last line is invisible, which is why
 *  Alt+Enter at the end of an item looked like it did nothing. The DOM keeps
 *  ONE extra "\n" whenever the raw text ends with a break so the empty line
 *  shows; reads strip that sentinel back off. The pair is a bijection: raw
 *  "a\n" ⇄ DOM "a\n\n", raw "a\n\n" ⇄ DOM "a\n\n\n", raw "a" ⇄ DOM "a". */
function rowRawToDom(text: string): string {
	return text.endsWith("\n") ? text + "\n" : text;
}
function rowDomToRaw(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** A keydown that belongs to an in-progress IME composition. keyCode 229 is
 *  what Safari/WebKit report for the confirming Enter, where isComposing can
 *  already be false. */
function isImeKey(e: KeyboardEvent): boolean {
	return e.isComposing || e.keyCode === 229;
}

/** MIME used for internal row drags. Deliberately NOT text/plain: a plain-text
 *  payload gets natively inserted into whatever contenteditable it lands on
 *  (which pasted the raw node id into the row being dropped on). */
const DRAG_MIME = "application/x-trynalist-node";

const UNDO_LIMIT = 60;
/** A snapshot clones every node, so the undo history's memory is depth × size.
 *  Sixty deep on a 44,000-item import is millions of retained objects; the
 *  depth shrinks as the document grows, aiming at roughly this many nodes held
 *  across the whole stack, with a floor so small stacks stay useful. */
const UNDO_NODE_BUDGET = 600_000;
/** Phones have a fraction of the memory: each snapshot clones every node, and
 *  600k cloned nodes held 55–110 MB per open document (L74). */
const UNDO_NODE_BUDGET_MOBILE = 60_000;
const UNDO_MIN = 5;
/** How long a pause ends a typing burst, so it becomes its own undo step. */
const BURST_MS = 900;
/** Pixels of horizontal travel per indent level while dragging, and the
 *  visual indent of one level in the outline (kept in sync with styles.css). */
const INDENT_PX = 28;

function fmtStamp(iso: string): string {
	const d = new Date(iso);
	return isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}

/** The outline editor. Registered for the `.trynalist` extension, so clicking
 *  a doc manifest anywhere (panel or file explorer) lands here. */
/** How long the pointer must rest on a bullet before its timestamps appear. */
const TOOLTIP_DELAY_MS = 600;
/** In-document search draws at most this many matches until asked for all. */
const SEARCH_ROW_CAP = 300;
/** Flat and Article draw this many items, then offer the next page (L80). */
const FLAT_PAGE = 500;
/** Progressive rendering (audit H10 part c): at or above this many visible
 *  rows, a full render draws LAZY_CHUNK rows and leaves the rest of each long
 *  list to a placeholder that fills in, a chunk at a time, as it scrolls near. */
const LAZY_MIN_ROWS = 1200;
const LAZY_CHUNK = 400;
const ARTICLE_PAGE = 300;
/** See OutlineView.noteCache. */
const NOTE_CACHE_MAX = 2000;
const LIVE_NOTE_CONTENT = "pre, .internal-embed, img, video, audio, iframe, canvas, svg, math, .math, mjx-container, "
	+ ".callout, button, input, select, textarea, [class*='block-language-'], .mermaid";

/** One place you have been inside a document. */
interface NavState {
	zoom: TrynaId | null;
	mode: DocViewMode;
	/** The active query, or null when not searching. */
	search: string | null;
	/** Which shape that search took. Restoring a search without its mode drops
	 *  you into the in-doc view even if you left from a flat one. */
	searchMode: SearchMode;
}

export class TrynalistDocView extends FileView {
	allowNoFile = false;
	private index: DocIndex | null = null;
	private zoomRoot: TrynaId | null = null;
	private focusId: TrynaId | null = null;
	/** Caret offset to restore in the focused row after a re-render (-1 = end). */
	private focusCaret = -1;
	private clipboardWired = false;
	private mobileToolbar: MobileToolbar | null = null;
	/** Which shape the open search takes. "doc" filters the outline in place and
	 *  keeps the hierarchy; "flat" is a plain list of matches, which is the only
	 *  one a sort makes sense for — sorting a tree by title would reorder
	 *  branches, not results. */
	private searchMode: SearchMode = "doc";
	/** Index into the current match list, for Mod+G. */
	private matchCursor = -1;
	private globalTimer = 0;
	private docSearchTimer = 0;
	private globalRun = 0;
	private lastMatches: TrynaId[] = [];
	readonly visibility = new VisibilityMenu(this);
	/** Where you have BEEN inside this document: zoom root and view mode.
	 *  Obsidian's own back/forward only tracks which file a leaf shows, so
	 *  zooming three levels in and pressing Back either did nothing or jumped
	 *  out of the document entirely. This is the missing half. */
	private navBack: NavState[] = [];
	private navForward: NavState[] = [];
	/** Set while replaying a history entry, so restoring a state does not
	 *  record itself as a new one. */
	private navReplaying = false;
	private mirrorResolver: MirrorResolver | null = null;
	private mirrorHits = new Map<TrynaId, Resolved>();
	/** Mirrors found INSIDE mirrored subtrees, resolved too, keyed
	 *  "<doc path>#<item id>" of the nested mirror node. */
	private nestedHits = new Map<string, Resolved>();
	private nestedSig = "";
	private saveTimers = new Map<TrynaId, number>();
	private undoStack: NodeSnapshot[][] = [];
	private redoStack: NodeSnapshot[][] = [];
	private tooltipEl: HTMLElement | null = null;
	private dragId: TrynaId | null = null;
	/** Pointer X where the drag began — horizontal travel from here sets depth. */
	private dragStartX = 0;
	private dragCache: { id: TrynaId; vis: TreeNode[]; rowEls: Map<string, HTMLElement> } | null = null;
	/** Rows buildItem may still draw in this pass before lists turn lazy.
	 *  Infinity except inside a budgeted render / materialize. */
	private renderBudget = Infinity;
	private lazyObserver: IntersectionObserver | null = null;
	/** Estimated height of one row, for sizing placeholders. */
	private lazyRowPx = 30;
	/** LAZY_MIN_ROWS, per view — a field so a live probe can switch progressive
	 *  rendering off to compare a patched outline with a complete one. */
	private lazyMinRows = LAZY_MIN_ROWS;
	private dragCopy = false;
	/** Top-level ids being dragged when the drag began on a selected row. */
	private dragGroup: TrynaId[] | null = null;
	private dropGuideEl: HTMLElement | null = null;
	/** Multi-selected rows. Empty = act on the focused row instead. */
	private selection = new Set<TrynaId>();
	/** Anchor for Shift+click / Shift+arrow range selection. */
	private selectionAnchor: TrynaId | null = null;
	private linkSuggest: LinkSuggest | null = null;
	/** Row element the link popover should insert into (kept current). */
	private linkTargetEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: TrynalistPlugin) {
		super(leaf);
		this.navigation = true;
		// Obsidian's own `editor:open-link-in-new-leaf` owns Mod+Enter globally
		// and eats it in the capture phase, so a plain keydown listener never
		// sees it. A view scope claims the chord while this view has focus.
		this.scope = new Scope(this.app.scope);
		const wrap = (marker: string) => (evt: KeyboardEvent) => {
			const el = this.contentEl.doc.activeElement;
			if (!el?.instanceOf(HTMLElement) || !el.classList.contains("trynalist-text")) return true;
			evt.preventDefault();
			const next = toggleWrap(el, marker);
			const id = el.closest<HTMLElement>(".trynalist-row")?.dataset.id;
			if (next !== null && id) void this.saveRowNow(id, el);
			return false;
		};
		this.scope.register(["Mod"], "b", wrap("**"));
		this.scope.register(["Mod"], "i", wrap("__"));
		this.scope.register(["Mod"], "`", wrap("`"));
		this.scope.register(["Mod", "Shift"], "x", wrap("~~"));
		// Outliner's fold chords. Handed back unless the keyboard is in a row, for
		// the same reason as every other chord here.
		for (const [key, collapsed] of [["ArrowUp", true], ["ArrowDown", false]] as const) {
			this.scope.register(["Mod"], key, (evt) => {
				if (!this.hasKeyboard() || !this.focusId) return true;
				const idx = this.index;
				const n = idx?.nodes.get(this.focusId);
				// Nothing to fold: hand the chord back rather than eating it, so
				// Mod+Arrow keeps whatever Obsidian binds it to on a leaf row.
				if (!idx || !n || !idx.children(n.id).length) return true;
				if (n.collapsed === collapsed) return true;
				evt.preventDefault();
				void this.cmdToggleCollapse();
				return false;
			});
		}
		// Mod+A in the search box. It HAS to live here: something upstream stops
		// the event in the capture phase, so a listener on the input never runs
		// at all — measured, a probe added last on the input saw zero events.
		// Outside the box the chord is handed back, leaving the row ladder alone.
		this.scope.register(["Mod"], "a", (evt) => {
			if (!this.hasKeyboard()) return true;
			const active = this.containerEl.ownerDocument.activeElement;
			if (this.inSearchInput()) {
				if (!active?.instanceOf(HTMLInputElement)) return true;
				evt.preventDefault();
				active.select();
				return false;
			}
			// The ladder runs from HERE, not from its command's hotkey. Registering
			// Meta+A in this scope at all was enough to stop the command firing:
			// the first press selected the line's text (step 1) and every press
			// after did nothing, because nothing was reaching step 2. Claiming it
			// outright also keeps the browser's own select-all out of the way.
			evt.preventDefault();
			this.selectOneLevelUp();
			return false;
		});
		this.scope.register(["Mod"], "f", (evt) => {
			if (!this.ownsViewChord()) return true;
			evt.preventDefault();
			// Reopening an open search focuses the box rather than closing it —
			// Mod+F in every other editor means "let me search", not "toggle".
			if (this.searchActive) {
				this.contentEl.querySelector<HTMLInputElement>(".trynalist-search input")?.focus();
			} else {
				this.openSearch();
			}
			return false;
		});
		// Mod+G walks the matches, as a browser's find-next does. Obsidian binds
		// it to the graph, so this only claims it while a search is actually open
		// in a focused Trynalist row — outside that it goes back to the graph.
		this.scope.register(["Mod"], "g", (evt) => {
			if (!this.hasKeyboard() || !this.searchActive) return true;
			evt.preventDefault();
			this.stepMatch(1);
			return false;
		});
		this.scope.register(["Mod", "Shift"], "g", (evt) => {
			if (!this.hasKeyboard() || !this.searchActive) return true;
			evt.preventDefault();
			this.stepMatch(-1);
			return false;
		});
		// The document commands' default chords (zoom, move, checkbox, structural
		// undo…). Registered AFTER the handlers above so the fold chords on
		// Mod+Up/Down still get first refusal, exactly as when these were
		// `hotkeys` on the commands (a view scope runs before global hotkeys).
		// `fire(true)` is the command's own check, so an inapplicable chord is
		// handed back to Obsidian rather than eaten.
		for (const c of plugin.viewChords) {
			this.scope.register(c.modifiers, c.key, (evt) => {
				if (!plugin.settings.builtinShortcuts || !c.fire(true)) return true;
				evt.preventDefault();
				c.fire(false);
				return false;
			});
		}
		// Obsidian's quick switcher and global search. Claimed ONLY inside a
		// focused Trynalist view: a document here is a folder plus a manifest, so
		// the core switcher cannot open one, and core search cannot see items.
		this.scope.register(["Mod"], "o", (evt) => {
			if (!this.ownsViewChord()) return true;
			evt.preventDefault();
			void this.plugin.openDocJump();
			return false;
		});
		this.scope.register(["Mod", "Shift"], "f", (evt) => {
			if (!this.ownsViewChord()) return true;
			evt.preventDefault();
			this.plugin.searchEverywhere(this.searchQuery);
			return false;
		});
		this.scope.register(["Mod"], "k", (evt) => {
			// Handed straight back unless the keyboard is actually IN this view.
			// A view's scope is live whenever its leaf is active, which is not the
			// same thing — another plugin's sidebar input takes focus without
			// changing the active leaf, and swallowing Mod+K there would break
			// whatever that plugin binds it to.
			if (!this.hasKeyboard()) return true;
			evt.preventDefault();
			new CommandBar(this).open();
			return false;
		});
		this.scope.register([], "Escape", (evt) => {
			// The input's own Escape handler only fires when the caret is IN the
			// input. A search opened from the tags pane leaves focus over there,
			// so Escape did nothing and "Done" was the only way out.
			if (!this.searchActive) return true;
			evt.preventDefault();
			this.closeSearch();
			return false;
		});
		this.scope.register(["Mod"], "Enter", (evt) => {
			// The view's scope is live whenever this leaf is active, which is not
			// the same as the keyboard being in it: another plugin's sidebar input
			// takes focus without changing the active leaf. Returning true hands
			// the chord back rather than toggling a checkbox behind their back.
			if (!this.hasKeyboard()) return true;
			// hasKeyboard() is true for ANY element in the view, the search box
			// included — so this handler was firing there and toggling a checkbox
			// instead of letting the box's own Mod+Enter widen to global search.
			// The scope runs first, so the input's listener never saw the chord.
			if (this.inSearchInput()) {
				evt.preventDefault();
				this.setSearchMode("global");
				return false;
			}
			evt.preventDefault();
			if (this.selection.size > 1) void this.bulkToggleCheck();
			else if (this.focusId) void this.cycleCheckState(this.focusId);
			return false;
		});
		// The in-item line break has to come through the Scope, not a row
		// listener. Alt combinations are claimed in the capture phase before a
		// keydown handler on the row ever sees them — measured: a plain Enter
		// reaches the row listener, an Alt+Enter reaches it zero times.
		const lineBreak = (evt: KeyboardEvent) => {
			const el = this.contentEl.doc.activeElement;
			if (!el?.instanceOf(HTMLElement) || !el.classList.contains("trynalist-text")) return true;
			const id = el.closest<HTMLElement>(".trynalist-row")?.dataset.id;
			const node = id ? this.index?.nodes.get(id) : null;
			if (!node) return true;
			evt.preventDefault();
			void this.insertLineBreak(node, el);
			return false;
		};
		// Alt+Enter is NOT registered here: the row's own keydown handler
		// receives it, and a Scope binding on the same chord runs first (document
		// capture) and preventDefaults, which stopped it reaching the row.
		// Mod+Shift+Enter does need the Scope — Obsidian claims it upstream.
		this.scope.register(["Mod", "Shift"], "Enter", lineBreak);
	}

	/** Is the keyboard actually inside this view? Mirrors the plugin-level gate
	 *  used by the commands; see `activeFocusedDoc` in main.ts. */
	/** Is the caret in the search box rather than in the outline? Several
	 *  chords mean something different there, and the view's scope sees them
	 *  before the box does. */
	private inSearchInput(): boolean {
		const active = this.containerEl.ownerDocument.activeElement;
		return !!active?.instanceOf(HTMLElement) && !!active.closest(".trynalist-search");
	}

	/** For chords that belong to the VIEW rather than to the caret.
	 *
	 *  hasKeyboard() asks "is the caret inside this view", which is right for
	 *  editing keys and wrong for Mod+O: click the pane background and focus
	 *  falls to <body>, so the chord got handed back and Obsidian's quick
	 *  switcher swallowed it. It only worked with something selected.
	 *
	 *  This scope is only live while the leaf is active, so the only case worth
	 *  refusing is focus sitting in someone ELSE'S input — a sidebar field that
	 *  took focus without changing the active leaf. */
	ownsViewChord(): boolean {
		const active = this.containerEl.ownerDocument.activeElement;
		if (!active || active === this.containerEl.ownerDocument.body) return true;
		if (this.containerEl.contains(active)) return true;
		const el = active as HTMLElement;
		const claimed = el.isContentEditable
			|| el?.instanceOf(HTMLInputElement) || el?.instanceOf(HTMLTextAreaElement);
		return !claimed;
	}

	private hasKeyboard(): boolean {
		const active = this.containerEl.ownerDocument.activeElement;
		return !!active?.instanceOf(HTMLElement) && this.containerEl.contains(active);
	}

	/** Command entry point for the in-item line break, so it also gets a real
	 *  Obsidian hotkey registration — the Scope binding alone was reported dead
	 *  on macOS, and a command is both reliable and user-rebindable. */
	cmdLineBreak(): void {
		const el = this.contentEl.doc.activeElement;
		if (!el?.instanceOf(HTMLElement) || !el.classList.contains("trynalist-text")) {
			new Notice("Trynalist: put the caret in an item first.");
			return;
		}
		const id = el.closest<HTMLElement>(".trynalist-row")?.dataset.id;
		const node = id ? this.index?.nodes.get(id) : null;
		if (node) void this.insertLineBreak(node, el);
	}

	/** Dynalist's "start new line": a break INSIDE this item rather than a new
	 *  item. Stored escaped, so the file keeps one physical line per item and
	 *  the note stays the second half of the body. */
	private async insertLineBreak(n: TreeNode, el: HTMLElement): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const full = rowDomToRaw(el.innerText);
		const caret = Math.min(this.caretOffset(el), full.length);
		const next = `${full.slice(0, caret)}\n${full.slice(caret)}`;
		this.cancelSave(n.id);
		// We rewrite the row's text programmatically, so the browser's own undo
		// stack knows nothing about it — without this the break could not be
		// undone at all. Matches what the Enter split already does.
		this.pushUndo();
		// Put the break into the DOM before anything re-renders. The render
		// below detaches this row, which fires blur, which saves from the DOM —
		// and that read would otherwise still hold the pre-break text and write
		// it straight back over the line we just added.
		el.setText(rowRawToDom(next));
		await idx.setBody(n.id, next, idx.nodes.get(n.id)?.note ?? "");
		this.focusId = n.id;
		this.focusCaret = caret + 1;
		this.patch({ rows: [n.id] });
	}

	getViewType(): string { return DOC_VIEW_TYPE; }
	/** The fork: a branching outline, and distinct from Obsidian's own
	 *  list-shaped icons so a Trynalist document is recognisable in a crowded
	 *  tab bar. The panel keeps `list-tree` — that is the plugin's identity in
	 *  the sidebar, and a tab is a different thing from a pane. */
	getIcon(): string { return "git-fork"; }
	getDisplayText(): string {
		return this.index?.docRef.manifest.title ?? this.file?.basename ?? "Trynalist";
	}

	async onLoadFile(file: TFile): Promise<void> {
		// A tab that switches documents must not keep the previous document's
		// resolver: it holds that document as "own", so portals into the new
		// one read a stale disk copy and mirrors back into the old one showed
		// its detached in-memory index (mirrors review finding 5).
		this.mirrorResolver = null;
		this.mirrorHits.clear();
		this.nestedHits.clear();
		this.nestedSig = "";
		this.mirrorsDirty = true;
		// registerDomEvent is idempotent per view lifetime; the guard keeps a
		// re-opened file from stacking a second pair of handlers.
		if (!this.clipboardWired) {
			this.wireClipboard(this.contentEl);
			// The view's own window: a popout's mouseups never reach the main
			// document, so a drag-select there never ended.
			this.registerDomEvent(this.contentEl.doc, "mouseup", () => {
				if (this.dragSelectAnchor) {
					this.dragSelectAnchor = null;
					this.dragSelectCache = null;
					this.repaintSelection();
					return;
				}
				this.promoteTextSelection();
			});
			// Mirror sources live in OTHER documents, and the resolver caches
			// their indexes. Any write outside this document's own folder may be
			// one of those sources changing; only then is the cache dropped —
			// rather than on every render, which re-read every source document
			// on every collapse, selection and drop.
			const outside = (path: string): boolean => {
				const own = this.file?.parent?.path;
				return !own || !(path === own || path.startsWith(`${own}/`));
			};
			// Item files directly in THIS document's folder (not its trash
			// subfolders): a change there that this view did not make — Obsidian
			// Sync, a second tab on the same document, an external editor — has
			// to reach the model, or the next save writes the stale copy back.
			const ownItem = (path: string): boolean => {
				const own = this.file?.parent?.path;
				return !!own && path.endsWith(".md") && path.slice(0, path.lastIndexOf("/")) === own;
			};
			this.registerEvent(this.app.vault.on("modify", (f) => {
				// Only a change inside a document this view mirrors matters to its
				// mirrors; any other write elsewhere used to drop every cached
				// source and reload them all on the next paint (finding 13).
				if (outside(f.path)) this.queueMirrorRefresh([f.path], false);
				else if (ownItem(f.path)) this.queueForeignCheck(f.path);
			}));
			this.wireNoteLinks(this.contentEl);
			this.registerEvent(this.app.vault.on("create", (f) => {
				// A new file can resolve a link a cached note drew as unresolved.
				this.noteCache.clear();
				if (outside(f.path)) { this.queueMirrorRefresh([f.path], true); this.linkSuggest?.invalidate(); }
				else if (ownItem(f.path)) this.queueForeignCheck(f.path);
			}));
			this.registerEvent(this.app.vault.on("delete", (f) => {
				this.noteCache.clear();
				if (outside(f.path)) { this.queueMirrorRefresh([f.path], true); this.linkSuggest?.invalidate(); }
				else if (ownItem(f.path)) this.queueForeignCheck(f.path);
			}));
			this.registerEvent(this.app.vault.on("rename", (f, old) => {
				this.noteCache.clear();
				if (outside(f.path) || outside(old)) { this.queueMirrorRefresh([f.path, old], true); this.linkSuggest?.invalidate(); }
				if (ownItem(f.path)) this.queueForeignCheck(f.path);
				if (ownItem(old)) this.queueForeignCheck(old);
			}));
			this.clipboardWired = true;
		}
		if (!this.mobileToolbar && MobileToolbar.shouldShow()) {
			this.mobileToolbar = new MobileToolbar(this, this.plugin);
			this.mobileToolbar.mount(this.containerEl);
		}
		const folder = file.parent;
		if (!(folder instanceof TFolder)) return;
		let manifest: DocManifest;
		try {
			manifest = JSON.parse(await this.app.vault.read(file)) as DocManifest;
		} catch {
			this.contentEl.setText("Not a readable document.");
			return;
		}
		this.index = new DocIndex(this.app, { manifest, folder, file });
		// Loading or the first render can throw on a document caught mid-write by a
		// running import, or on an item whose content trips a render path. Without
		// this guard the exception escapes onLoadFile and the view is left blank —
		// no editor, no error, a generic tab. Surface the failure with a Retry so
		// the document is diagnosable and recoverable rather than a silent void.
		try {
			await this.index.load();
			// Recorded HERE rather than in the open helpers: the file explorer, a
			// reused tab, a link and a bookmark all land here, and only here.
			void this.plugin.noteRecentDoc(file.path);
			this.zoomRoot = null;
			this.undoStack = [];
			this.redoStack = [];
			this.navBack = [];
			this.navForward = [];
			// Land where this document was left. Only when the item is still there —
			// a remembered id that has since been deleted must not blank the caret.
			const remembered = this.plugin.settings.lastFocus[file.path];
			this.focusId = remembered && this.index.nodes.get(remembered) ? remembered : null;
			this.render();
		} catch (e) {
			console.error(`[Trynalist] failed to open "${file.path}"`, e);
			this.renderLoadError(file, e);
		}
	}

	/** A visible, recoverable failure state instead of a blank view. */
	private renderLoadError(file: TFile, err: unknown): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("trynalist-doc");
		const box = el.createDiv({ cls: "trynalist-load-error" });
		box.createEl("h3", { text: this.index?.docRef.manifest.title ?? file.basename });
		box.createEl("p", { text: "This document couldn't be opened." });
		box.createEl("p", { cls: "trynalist-load-error-detail", text: err instanceof Error ? err.message : String(err) });
		const actions = box.createDiv({ cls: "trynalist-load-error-actions" });
		const retry = actions.createEl("button", { text: "Retry", cls: "mod-cta" });
		retry.addEventListener("click", () => void this.onLoadFile(file));
		const reveal = actions.createEl("button", { text: "Reveal folder" });
		reveal.addEventListener("click", () => {
			// Show where the files live so a bad item can be found.
			const leaf = (this.app as unknown as { internalPlugins?: { getPluginById(id: string): { instance?: { revealInFolder(f: unknown): void } } | null } }).internalPlugins?.getPluginById("file-explorer");
			leaf?.instance?.revealInFolder?.(file);
		});
		box.createEl("p", {
			cls: "trynalist-load-error-hint",
			text: "If an import is still running, this document may not be fully written yet — try again in a moment.",
		});
	}

	async onUnloadFile(): Promise<void> {
		if (this.foreignTimer !== null) { window.clearTimeout(this.foreignTimer); this.foreignTimer = null; }
		this.foreignPaths.clear();
		await this.flushPendingSaves();
		await this.index?.persistPhantoms();
		this.hideTooltip();
		this.lazyObserver?.disconnect();
		this.lazyObserver = null;
		// The snapshots describe the document being closed; holding them kept
		// every cloned node alive until the tab showed another file (L74).
		this.undoStack = [];
		this.redoStack = [];
		this.index = null;
	}

	onunload(): void {
		this.visibility.close();
		this.mobileToolbar?.unmount();
		this.mobileToolbar = null;
		this.hideTooltip();
		this.hideDropGuide();
		// The popover lives on document.body, so it outlives the view otherwise.
		this.linkSuggest?.close();
		this.linkSuggest = null;
		if (this.noteHost) { this.removeChild(this.noteHost); this.noteHost = null; }
	}

	/** Re-read the document from disk and repaint. For writers OUTSIDE this
	 *  view — the inbox capture, a Dynalist update, the orphan fix, a trash
	 *  restore — whose files this view's index knows nothing about. Pending
	 *  typing is flushed first so nothing typed is lost; then the index is the
	 *  disk's, not the view's memory of it. */
	async reload(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		await this.flushPendingSaves();
		// Blank rows live only in RAM until something gives them a reason to be
		// written; a re-read from disk would silently drop them. Write them
		// first, exactly as closing the view does.
		await idx.persistPhantoms();
		await idx.load();
		// Every snapshot taken before this re-read describes a document that is
		// no longer the one on disk: restoring one trashes whatever the outside
		// writer added (a Dynalist update's new items, an inbox capture, a
		// restore from the trash) and reverts what it changed (M17/M18).
		this.undoStack = [];
		this.redoStack = [];
		this.endTypingBurst();
		if (this.zoomRoot && !idx.nodes.has(this.zoomRoot)) this.zoomRoot = null;
		if (this.focusId && !idx.nodes.has(this.focusId)) this.focusId = null;
		this.selection.clear();
		this.selectionAnchor = null;
		this.mirrorsDirty = true;
		this.render();
	}

	// ── changes made elsewhere ───────────────────────────────────────────

	private foreignPaths = new Set<string>();
	private foreignTimer: number | null = null;
	private foreignRetries = 0;

	private foreignFirstAt = 0;

	/** Trailing debounce: a burst of changes (sync delivering many files, an
	 *  "Update from Dynalist" writing into this document) is checked once it
	 *  pauses for 700 ms, and at least every 5 s while it keeps going — not
	 *  once per file. */
	private queueForeignCheck(path: string): void {
		this.foreignPaths.add(path);
		const now = Date.now();
		if (this.foreignTimer === null) this.foreignFirstAt = now;
		else if (now - this.foreignFirstAt < 5000) window.clearTimeout(this.foreignTimer);
		else return;   // a check is due soon anyway
		this.foreignTimer = window.setTimeout(() => void this.checkForeignChanges(), 700);
	}

	/** Compare the changed item files with the model and reload when any of
	 *  them says something the model does not. Our own writes land on disk
	 *  exactly as memory has them, so they compare equal — once the index is
	 *  quiet (frontmatter and body are separate writes). The check also waits
	 *  while a row save is pending or a note is being edited, so a reload never
	 *  pulls the text out from under the user; after ~40 s it reloads anyway,
	 *  flushing their edits first. */
	private async checkForeignChanges(): Promise<void> {
		this.foreignTimer = null;
		const idx = this.index;
		if (!idx || !this.foreignPaths.size) return;
		const active = this.contentEl.doc.activeElement as HTMLElement | null;
		const editingNote = !!active?.classList?.contains("trynalist-note") && this.contentEl.contains(active);
		const busy = !idx.isQuiet() || this.saveTimers.size > 0 || this.rendering
			|| (this.dirtyNotes.size > 0 || editingNote);
		if (busy && this.foreignRetries < 60) {
			this.foreignRetries++;
			this.foreignTimer = window.setTimeout(() => void this.checkForeignChanges(), 700);
			return;
		}
		this.foreignRetries = 0;
		const paths = [...this.foreignPaths];
		this.foreignPaths.clear();
		let foreign = false;
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) {
				// Gone from disk but still in the model: deleted or moved elsewhere.
				if ([...idx.nodes.values()].some((n) => n.file?.path === path)) { foreign = true; break; }
				continue;
			}
			try {
				if (!idx.matchesDisk(await this.app.vault.read(file))) { foreign = true; break; }
			} catch { /* unreadable mid-sync: the next event re-queues it */ }
		}
		if (!foreign || this.index !== idx) return;
		// Keep the caret where it was across the reload.
		const row = active?.closest?.<HTMLElement>(".trynalist-row");
		if (row?.dataset.id && active?.classList.contains("trynalist-text") && this.contentEl.contains(active)) {
			this.focusId = row.dataset.id;
			this.focusCaret = this.caretOffset(active);
		}
		await this.reload();
	}

	/** Set by vault events that touch files outside this document; makes the
	 *  next mirror resolution re-read its sources. Starts dirty. */
	private mirrorsDirty = true;
	/** Owns the Obsidian components created by rendering notes. Replaced on
	 *  every full render, so the previous paint's embeds and code-block
	 *  processors are unloaded instead of accumulating for the view's life. */
	private noteHost: Component | null = null;
	/** The component each rendered note's embeds and processors belong to —
	 *  see renderNoteInto and releaseNotes. */
	private noteOwners = new WeakMap<HTMLElement, Component>();
	/** True while render() is tearing the DOM down — see the blur handler. */
	private rendering = false;

	/** Capture to inbox into this open document (see plugin.captureToInbox).
	 *  Returns false when the view has no index yet. */
	async appendCaptured(text: string, underId: TrynaId | null, note = ""): Promise<boolean> {
		const idx = this.index;
		if (!idx) return false;
		const under = underId && idx.nodes.has(underId) ? underId : null;
		const last = idx.children(under).at(-1)?.id ?? null;
		this.pushUndo();
		const n = await idx.createNode(text, under, last);
		if (note) await idx.setBody(n.id, text, note);
		this.patch({ lists: [under] });
		return true;
	}

	/** Item history for `n` (item menu, command). Versions come from this
	 *  device's history log; the daily snapshots are searched on request. */
	showHistory(n: TreeNode): void {
		const h = this.plugin.itemHistory;
		const net = this.plugin.safetyNet;
		if (!h || !net || !this.plugin.settings.safetyNet || !this.plugin.settings.itemHistory) {
			new Notice("Trynalist: item history is off. Turn on automatic snapshots and item history in the backup settings.");
			return;
		}
		const id = n.id;
		new ItemHistoryModal(this.app, {
			label: n.text,
			current: () => {
				const idx = this.index;
				const live = idx?.nodes.get(id);
				if (!idx || !live) return null;
				const sibs = idx.children(live.parent);
				const at = sibs.findIndex((c) => c.id === id);
				return {
					text: live.text, note: live.note, parent: live.parent,
					prev: at > 0 ? sibs[at - 1].id : null, collapsed: !!live.collapsed,
					label: (other) => {
						const o = other ? idx.nodes.get(other) : null;
						const t = o?.text ?? "(an item no longer here)";
						return t.length > 40 ? `${t.slice(0, 40)}…` : t || "(empty)";
					},
				};
			},
			load: async () => {
				await this.flushPendingSaves();
				return h.versionsOf(id);
			},
			loadSnapshots: async () => h.snapshotVersionsOf(id, await net.listOutlines(), 31),
			onRestore: (v, part) => part === "text" ? this.restoreVersion(id, v)
				: part === "position" ? this.restorePosition(id, v) : this.restoreFold(id, v),
		}).open();
	}

	/** Put an item back where a version had it: under the same parent, after
	 *  the same sibling — or, when that sibling is gone or unknown (a daily
	 *  snapshot), by the version's order value. One undoable move. */
	async restorePosition(id: TrynaId, v: ItemVersion): Promise<boolean> {
		const idx = this.index;
		const n = idx?.nodes.get(id);
		if (!idx || !n || v.parent === undefined) return false;
		const parent = v.parent ?? null;
		if (parent && !idx.nodes.has(parent)) {
			new Notice("Trynalist: the item it used to sit under is no longer in this document.");
			return false;
		}
		if (parent && (parent === id || idx.descendants(id).some((d) => d.id === parent))) {
			new Notice("Trynalist: that position is inside this item now, so it can't go back there.");
			return false;
		}
		const sibs = idx.children(parent).filter((c) => c.id !== id);
		let afterId: TrynaId | null;
		if (v.prev === null) afterId = null;
		else if (v.prev && sibs.some((c) => c.id === v.prev)) afterId = v.prev;
		else if (typeof v.order === "number") afterId = sibs.filter((c) => c.order < (v.order as number)).at(-1)?.id ?? null;
		else afterId = sibs.at(-1)?.id ?? null;
		await this.flushPendingSaves();
		const oldParent = n.parent;
		this.pushUndo();
		if (!(await idx.move(id, parent, afterId))) {
			this.undoStack.pop();
			new Notice("Trynalist: could not move it back.");
			return false;
		}
		this.patch({ lists: [oldParent, parent], rebuild: [id] });
		new Notice(`Trynalist: moved back to where it was at ${new Date(v.when).toLocaleString()}. Undo reverses it.`);
		return true;
	}

	/** Fold or unfold an item as a version had it — one undoable change. */
	async restoreFold(id: TrynaId, v: ItemVersion): Promise<boolean> {
		const idx = this.index;
		const n = idx?.nodes.get(id);
		if (!idx || !n) return false;
		this.pushUndo();
		await idx.setFlag(id, "collapsed", !!v.collapsed);
		this.patch({ lists: [id] });
		return true;
	}

	/** The history command's entry point: the focused item, if any. */
	showHistoryForFocused(): boolean {
		const n = this.focusId ? this.index?.nodes.get(this.focusId) : undefined;
		if (!n || n.mirrorOf) return false;
		this.showHistory(n);
		return true;
	}

	/** Put an older text + note back on an item, as one undoable edit. */
	async restoreVersion(id: TrynaId, v: ItemVersion): Promise<boolean> {
		const idx = this.index;
		if (!idx?.nodes.get(id)) {
			new Notice("Trynalist: that item is no longer in this document.");
			return false;
		}
		await this.flushPendingSaves();
		this.pushUndo();
		await idx.setBody(id, v.text, v.note);
		this.patch({ rows: [id] });
		new Notice(`Trynalist: restored the version from ${new Date(v.when).toLocaleString()}. Undo brings the newer one back.`);
		return true;
	}

	/** Public door for the plugin's quit / background flush (M37). */
	async flushEdits(): Promise<void> { await this.flushPendingSaves(); }
	/** Write this document's memory-only blank rows (see flushOpenDocs). */
	async persistBlankRows(): Promise<void> { await this.index?.persistPhantoms(); }

	private async flushPendingSaves(): Promise<void> {
		for (const [id, timer] of this.saveTimers) {
			window.clearTimeout(timer);
			this.saveTimers.delete(id);
			await this.saveRowNow(id);
		}
		// A note typed into and not yet saved is flushed here too, so an undo,
		// a reload or quitting the app never loses it.
		for (const timer of this.noteTimers.values()) window.clearTimeout(timer);
		this.noteTimers.clear();
		for (const [id, el] of [...this.dirtyNotes]) {
			this.dirtyNotes.delete(id);
			if (el.isConnected && el.dataset.rendered !== "1") await this.saveNoteNow(el, id);
		}
	}

	// ── undo / redo ──────────────────────────────────────────────────────

	/** The row currently being typed into, and the timer that ends the burst.
	 *  Undo used to cover structural changes only, so typing was undoable just
	 *  by the browser's own per-element history — which loses everything the
	 *  moment a row re-renders, and cannot cross rows at all. */
	private typingBurstId: TrynaId | null = null;
	private typingBurstTimer: number | null = null;

	/** Called on every keystroke in a row or note. Snapshots ONCE at the start
	 *  of a burst, so a paragraph of typing is one undo step rather than one
	 *  per character — the behaviour every editor has. A pause longer than
	 *  BURST_MS, or moving to a different row, ends the burst. */
	private noteTypingBurst(id: TrynaId): void {
		if (this.typingBurstId !== id) {
			// The model has not been written yet (saves are debounced), so the
			// snapshot taken here is genuinely the state BEFORE this burst.
			this.pushUndo();
			this.typingBurstId = id;
		}
		if (this.typingBurstTimer) window.clearTimeout(this.typingBurstTimer);
		this.typingBurstTimer = window.setTimeout(() => {
			this.typingBurstId = null;
			this.typingBurstTimer = null;
		}, BURST_MS);
	}

	/** End the current burst, so the next keystroke starts a new undo step.
	 *  Called by anything that changes structure or moves the caret elsewhere. */
	private endTypingBurst(): void {
		if (this.typingBurstTimer) window.clearTimeout(this.typingBurstTimer);
		this.typingBurstTimer = null;
		this.typingBurstId = null;
	}

	/** Call BEFORE any structural mutation. */
	private pushUndo(): void {
		if (!this.index) return;
		// No link-popover invalidation here: this runs at the start of every
		// typing burst, and resetting the cache made each pause over 900 ms cost
		// a whole-vault rescan on the next `[[`. The popover reads this
		// document's items live instead (see LinkSuggest's `live`).
		this.undoStack.push(this.index.snapshot());
		const budget = Platform.isMobile ? UNDO_NODE_BUDGET_MOBILE : UNDO_NODE_BUDGET;
		const limit = Math.max(UNDO_MIN, Math.min(UNDO_LIMIT, Math.floor(budget / Math.max(1, this.index.nodes.size))));
		while (this.undoStack.length > limit) this.undoStack.shift();
		this.redoStack = [];
	}

	/** Whether there is a structural change to undo / redo. The hotkey is only
	 *  claimed when there is: otherwise Mod+Z must reach the row's own native
	 *  text undo, which is what handles typing. */
	canUndo(): boolean { return this.undoStack.length > 0; }
	canRedo(): boolean { return this.redoStack.length > 0; }

	async undo(): Promise<void> {
		const idx = this.index;
		const snap = this.undoStack.pop();
		if (!idx || !snap) { new Notice("Trynalist: nothing to undo."); return; }
		// An empty snapshot of a document that has items can only be a
		// snapshot taken mid-load; applying it trashes everything (M19).
		if (!snap.length && idx.nodes.size) { new Notice("Trynalist: nothing to undo."); return; }
		await this.flushPendingSaves();
		const before = idx.snapshot();
		this.redoStack.push(before);
		const failed = await this.applySnapshot(snap, before);
		if (!failed) new Notice("Trynalist: undid last structural change.");
	}

	async redo(): Promise<void> {
		const idx = this.index;
		const snap = this.redoStack.pop();
		if (!idx || !snap) { new Notice("Trynalist: nothing to redo."); return; }
		await this.flushPendingSaves();
		const before = idx.snapshot();
		this.undoStack.push(before);
		const failed = await this.applySnapshot(snap, before);
		if (!failed) new Notice("Trynalist: redid change.");
	}

	/** Restore a snapshot and repaint, whatever happens. A failed write used
	 *  to escape undo()/redo() with the model half-restored and nothing
	 *  repainted (L6). The model is the snapshot's state either way; what
	 *  failed on disk is reported, and the opposite stack keeps its step, so
	 *  the change can still be taken back. Returns whether anything failed. */
	private async applySnapshot(snap: NodeSnapshot[], before: NodeSnapshot[]): Promise<boolean> {
		const idx = this.index;
		if (!idx) return true;
		let failed = false;
		try {
			await idx.restore(snap);
		} catch (e) {
			failed = true;
			console.error("Trynalist: undo/redo could not write everything", e);
			new Notice(`Trynalist: ${e instanceof Error ? e.message : String(e)}. The outline shows the restored state; those files may still hold the old one.`, 10000);
		} finally {
			// Put the caret back somewhere real. Restoring can remove the row that
			// had focus, which left the cursor nowhere and no row selected.
			if (!this.focusId || !idx.nodes.get(this.focusId)) {
				this.focusId = idx.visible(this.zoomRoot, this.effectiveHideCompleted())[0]?.id ?? null;
			}
			this.selection.clear();
			this.selectionAnchor = null;
			this.paintSelection();
			this.patchDiff(before, snap);
		}
		return failed;
	}

	// ── rendering ────────────────────────────────────────────────────────

	render(): void {
		this.visCache = null;
		this.dragCache = null;        // row elements may be replaced below
		this.dragSelectCache = null;
		const idx = this.index;
		const el = this.contentEl;
		// The tooltip lives on document.body, so a re-render under the cursor
		// would otherwise orphan it.
		this.hideTooltip();
		this.hideDropGuide();
		// Scroll position survives the rebuild. `empty()` drops every child, and
		// the scroller snaps to 0 — so any render that did not end by focusing a
		// row threw you to the top of the document. Undo after editing deep in a
		// long note was the visible case: the state was restored correctly and
		// the view was simply somewhere else.
		const scroller = this.scrollHost();
		const keepScroll = scroller?.scrollTop ?? 0;
		// The row at the top of the viewport, so a render that draws lazily can
		// put the same row back in the same place — a pixel offset would land
		// inside an estimated placeholder instead (Stashpad's virt lesson).
		const anchor = scroller && keepScroll ? this.topRowAnchor(scroller) : null;
		this.lazyObserver?.disconnect();
		this.lazyObserver = null;
		// Detaching the focused row fires its blur handler synchronously; the
		// flag tells that handler this is a rebuild, not the user leaving the
		// row — see wireTextEvents for why that matters.
		this.rendering = true;
		try {
			el.empty();
		} finally {
			this.rendering = false;
		}
		// Everything the previous paint's notes registered (embeds, code-block
		// processors) goes with the DOM it belonged to.
		if (this.noteHost) this.removeChild(this.noteHost);
		this.noteHost = this.addChild(new Component());
		el.addClass("trynalist-doc");
		const s = this.plugin.settings;
		el.removeClasses(["tl-density-compact", "tl-density-cozy", "tl-density-comfortable"]);
		el.addClass(`tl-density-${s.density}`);
		el.toggleClass("tl-highlight-current", s.highlightCurrentItem);
		// Trynalist's own scale, independent of Obsidian's zoom. A CSS variable
		// rather than a font-size on the container, so nested rem/em sizing in
		// rendered notes scales with it instead of fighting it.
		el.style.setProperty("--trynalist-scale", String(this.effectiveScale() / 100));
		el.toggleClass("tl-center", s.centerAlign);
		el.toggleClass("tl-bordered", s.documentBorder);
		el.toggleClass("tl-tag-bg", s.tagBackground);
		if (!idx) return;

		const crumb = el.createDiv({ cls: "trynalist-crumbs" });
		this.renderNavButtons(crumb);
		const trail: TreeNode[] = [];
		let p = this.zoomRoot ? idx.nodes.get(this.zoomRoot) : undefined;
		while (p) { trail.unshift(p); p = p.parent ? idx.nodes.get(p.parent) : undefined; }
		// The document title doubles as the rename affordance (click, or
		// right-click for the menu) — it's the "topmost point" of the outline.
		const rootCrumb = crumb.createSpan({
			cls: "trynalist-crumb trynalist-doc-title",
			text: idx.docRef.manifest.title,
		});
		rootCrumb.setAttribute("aria-label", "Click to rename · right-click for more");
		rootCrumb.addEventListener("click", () => {
			if (this.zoomRoot) { this.pushNav(); this.zoomRoot = null; this.render(); return; }
			this.promptRenameDoc();
		});
		if (idx.docRef.manifest.archived) {
			crumb.createSpan({ cls: "trynalist-archived-badge", text: "archived" });
		}
		rootCrumb.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Rename document").setIcon("pencil")
				.onClick(() => this.promptRenameDoc()));
			menu.addItem((i) => i
				.setTitle(idx.docRef.manifest.archived ? "Unarchive document" : "Archive document")
				.setIcon("archive")
				.onClick(() => void this.toggleArchived()));
			menu.addItem((i) => i.setTitle("Export as .trynalist.zip").setIcon("download")
				.onClick(() => void this.exportZip()));
			// Only offered where it applies: a document shared with you.
			const m = idx.docRef.manifest;
			if (typeof m.dlPermission === "number" && m.dlPermission < 4) {
				menu.addItem((i) => i
					.setTitle(m.trusted ? "Restrict notes again (shared document)" : "Trust this shared document's notes")
					.setIcon(m.trusted ? "shield" : "shield-off")
					.onClick(async () => {
						await patchManifest(this.app, idx.docRef, (mm) => { if (mm.trusted) delete mm.trusted; else mm.trusted = true; });
						new Notice(m.trusted
							? "Trynalist: notes in this document now render in full — code blocks run and remote images load."
							: "Trynalist: notes in this document render restricted again.", 7000);
						this.render();
					}));
			}
			menu.showAtMouseEvent(e);
		});
		for (const t of trail) {
			crumb.createSpan({ cls: "trynalist-crumb-sep", text: " › " });
			const c = crumb.createSpan({ cls: "trynalist-crumb" });
			// Dynalist renders markdown in breadcrumbs rather than showing the
			// raw source; the trail is a label, not an editing surface.
			if (t.text) this.renderRowText(c, t.text, t.id); else c.setText("(empty)");
			c.addEventListener("click", () => { this.pushNav(); this.zoomRoot = t.id; this.render(); });
			c.addEventListener("contextmenu", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const menu = new Menu();
				menu.addItem((i) => i.setTitle("Zoom to here").setIcon("zoom-in").onClick(() => {
					this.pushNav(); this.zoomRoot = t.id; this.render();
				}));
				menu.addItem((i) => i.setTitle("Open in a new tab").setIcon("file-plus").onClick(() => {
					void this.openZoomInNewLeaf(t.id, "tab");
				}));
				menu.addItem((i) => i.setTitle("Open to the side").setIcon("separator-vertical").onClick(() => {
					void this.openZoomInNewLeaf(t.id, "split");
				}));
				menu.addSeparator();
				menu.addItem((i) => i.setTitle("Copy deep link").setIcon("external-link").onClick(() => {
					const docPath = this.file?.path;
					if (docPath) void this.plugin.copyDeepLink(docPath, t.id, true);
				}));
				menu.addItem((i) => i.setTitle("Copy this item's text").setIcon("clipboard-copy")
					.onClick(() => void navigator.clipboard.writeText(t.text)));
				menu.showAtMouseEvent(ev);
			});
		}

		// One flex cluster for the header controls. They were four different box
		// sizes sitting in the crumb trail's INLINE text flow, so they aligned on
		// the text baseline rather than to each other — which is what made them
		// look scattered. Grouping them is also what lets them share a size.
		const actions = crumb.createDiv({ cls: "trynalist-crumb-actions" });
		// A visible way in to Mod+K. A chord nobody is told about is a chord
		// nobody uses, and on a phone there is no chord at all.
		const zap = actions.createSpan({ cls: "trynalist-zap" });
		setIcon(zap, "zap");
		setTooltip(zap, "Actions on this item (Mod+K)", { placement: "bottom" });
		zap.setAttribute("aria-label", "Actions on this item");
		zap.addEventListener("mousedown", (ev) => ev.preventDefault());
		zap.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			new CommandBar(this).open();
		});
		const search = actions.createSpan({ cls: "trynalist-headbtn" });
		setIcon(search, "search");
		setTooltip(search, "Search this document", { placement: "bottom" });
		search.setAttribute("aria-label", "Search this document");
		search.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			// Toggle: a second press on the same button should put it away, or the
			// only way out of a search you opened by accident is the Done button.
			if (this.searchActive) this.closeSearch(); else this.openSearch();
		});
		VisibilityMenu.mountButton(actions, this.visibility);
		this.renderStar(actions);
		this.renderViewSwitcher(actions);

		if (this.searchActive) this.renderSearchBar(el);

		const mode = this.viewMode();
		if (mode === "mindmap" && !this.searchActive) {
			// A read-only layer over the document: no rows, no editing, and a
			// button back to the outline.
			new MindMap(
				idx,
				this.zoomRoot,
				() => void this.setViewMode("outline"),
				(id) => {
					this.pushNav();
					this.zoomRoot = id;
					void this.setViewMode("outline");
				},
				idx.docRef.manifest.title ?? this.file?.basename ?? "Document",
			).render(el.createDiv({ cls: "trynalist-mindmap-host" }));
			// The map owns the scrolling while it is up; without this the view
			// scrolls instead and carries the breadcrumb and view switcher off
			// the top of the pane.
			el.addClass("is-mindmap");
			this.restoreFocus();
			return;
		}
		el.removeClass("is-mindmap");
		// Put it back after the rows exist. A focused row scrolling itself into
		// view still wins — this only matters when nothing does.
		if (scroller && keepScroll) {
			const host = scroller;
			window.setTimeout(() => {
				if (host.scrollTop !== 0) return;
				if (anchor && this.contentEl.querySelector(".trynalist-lazy")) {
					this.materializeTo(anchor.id);
					const row = this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(anchor.id)}"]`);
					if (row) {
						host.scrollTop += row.getBoundingClientRect().top - host.getBoundingClientRect().top - anchor.offset;
						return;
					}
				}
				host.scrollTop = keepScroll;
			}, 0);
		}
		void this.resolveMirrors();
		const listEl = el.createDiv({ cls: `trynalist-list is-${mode}` });
		// The `dir` ATTRIBUTE, not a CSS direction rule: it is what the browser
		// uses for caret movement, Home/End and selection inside a contenteditable,
		// so styling alone would flip the text and leave editing behaving LTR.
		listEl.setAttribute("dir", this.effectiveTextDirection());
		// Dynalist keeps the item you zoomed into as a real, editable row at the
		// top of the document rather than only as a breadcrumb label. Its
		// children render beneath it exactly as they would anywhere else.
		if (this.zoomRoot && mode === "outline" && !this.searchActive) {
			const zoomed = idx.nodes.get(this.zoomRoot);
			if (zoomed) {
				listEl.addClass("has-zoom-root");
				const head = listEl.createDiv({ cls: "trynalist-item trynalist-zoom-root" });
				this.renderRow(head, zoomed, null);
			}
		}
		this.wireListDragTargets(listEl);
		if (this.searchActive && this.searchQuery.trim()) this.renderResults();
		else if (mode === "flat") this.renderFlat(listEl);
		else if (mode === "article") this.renderArticle(listEl);
		else {
			this.renderBudget = this.lazyWanted(idx) ? LAZY_CHUNK : Infinity;
			try {
				this.renderChildren(listEl, this.zoomRoot);
			} finally {
				this.renderBudget = Infinity;
			}
		}

		if (!this.searchActive && !idx.children(this.zoomRoot).length) {
			const hint = el.createDiv({ cls: "trynalist-empty-hint", text: "Press the button or Enter to add the first item." });
			const btn = hint.createEl("button", { text: "Add item" });
			btn.addEventListener("click", () => void this.addFirstItem());
			// The hint says Enter works, so Enter has to work. Focusing the
			// button both makes that true natively and shows where the keyboard
			// is — there is no row to put a caret in yet.
			btn.addEventListener("keydown", (e) => {
				if (e.key !== "Enter") return;
				e.preventDefault();
				void this.addFirstItem();
			});
			// Deferred past the modal's own teardown: a dialog restores focus to
			// whatever had it when it closed, and a 0ms timeout lost that race —
			// which is why a document created from the command or the + button
			// opened with nothing focused.
			window.setTimeout(() => {
				if (!btn.isConnected) return;
				const active = this.contentEl.doc.activeElement;
				if (active?.instanceOf(HTMLElement) && this.contentEl.contains(active)) return;
				btn.focus();
			}, 80);
		}
		this.restoreFocus();
	}

	/** Record the state we are LEAVING, before it changes. */
	pushNav(): void {
		if (this.navReplaying) return;
		const last = this.navBack[this.navBack.length - 1];
		const here: NavState = {
			zoom: this.zoomRoot,
			mode: this.viewMode(),
			search: this.searchActive ? this.searchQuery : null,
			searchMode: this.searchMode,
		};
		if (last && last.zoom === here.zoom && last.mode === here.mode && last.search === here.search) return;
		this.navBack.push(here);
		if (this.navBack.length > 50) this.navBack.shift();
		this.navForward = [];
	}

	canNavBack(): boolean { return this.navBack.length > 0; }
	canNavForward(): boolean { return this.navForward.length > 0; }

	private here(): NavState {
		return {
			zoom: this.zoomRoot, mode: this.viewMode(),
			search: this.searchActive ? this.searchQuery : null, searchMode: this.searchMode,
		};
	}

	async navGoBack(steps = 1): Promise<void> {
		let target: NavState | undefined;
		for (let i = 0; i < steps; i++) {
			const prev = this.navBack.pop();
			if (!prev) break;
			this.navForward.push(target ?? this.here());
			target = prev;
		}
		if (target) await this.applyNav(target);
	}

	async navGoForward(steps = 1): Promise<void> {
		let target: NavState | undefined;
		for (let i = 0; i < steps; i++) {
			const next = this.navForward.pop();
			if (!next) break;
			this.navBack.push(target ?? this.here());
			target = next;
		}
		if (target) await this.applyNav(target);
	}

	/** Human-readable labels for the long-press history list, newest first. */
	navLabels(dir: "back" | "forward"): string[] {
		const idx = this.index;
		const stack = dir === "back" ? this.navBack : this.navForward;
		return [...stack].reverse().map((s) => {
			const where = s.zoom ? (idx?.nodes.get(s.zoom)?.text || "(empty item)") : "Whole document";
			const bits = [where];
			if (s.mode !== "outline") bits.push(s.mode);
			if (s.search) bits.push(`search "${s.search}"`);
			return bits.join(" · ");
		});
	}

	private async applyNav(state: NavState): Promise<void> {
		this.navReplaying = true;
		try {
			// A zoom root that has since been deleted must not strand the view.
			this.zoomRoot = state.zoom && this.index?.nodes.get(state.zoom) ? state.zoom : null;
			this.searchActive = state.search !== null;
			this.searchQuery = state.search ?? "";
			this.searchMode = state.searchMode ?? "doc";
			await this.setViewMode(state.mode);
		} finally {
			this.navReplaying = false;
		}
	}

	/** The open document, for callers that need to act on the document itself
	 *  (duplicate, export) without reaching into the index. */
	docRef(): DocRef | null { return this.index?.docRef ?? null; }

	/** The scale actually in force: the document's override if it has one, else
	 *  the global setting. */
	effectiveScale(): number {
		const key = this.file?.path ?? "";
		return this.plugin.settings.docScale[key] ?? this.plugin.settings.textScale;
	}

	/** The visibility settings actually in force here: this document's override
	 *  if it has one, otherwise the global setting.
	 *
	 *  Read through these rather than reaching for `settings.hideCompleted`
	 *  directly — a per-document override that only some code paths honour is
	 *  worse than no override at all. */
	effectiveHideCompleted(): boolean {
		const key = this.file?.path ?? "";
		return this.plugin.settings.docHideCompleted[key] ?? this.plugin.settings.hideCompleted;
	}

	effectiveNoteDisplay(): NoteDisplay {
		const key = this.file?.path ?? "";
		return this.plugin.settings.docNoteDisplay[key] ?? this.plugin.settings.noteDisplay;
	}

	effectiveTextDirection(): TextDirection {
		const key = this.file?.path ?? "";
		return this.plugin.settings.docTextDirection[key] ?? this.plugin.settings.textDirection;
	}

	/** Set one of this document's overrides, or clear it back to Global with
	 *  null. Deleting the key IS the "follow global" state, so a document that
	 *  has never been touched and one reset to Global behave identically. */
	async setDocOverride(
		which: "checked" | "notes" | "direction",
		value: boolean | NoteDisplay | TextDirection | null,
	): Promise<void> {
		const key = this.file?.path ?? "";
		const store = which === "checked" ? this.plugin.settings.docHideCompleted
			: which === "notes" ? this.plugin.settings.docNoteDisplay
				: this.plugin.settings.docTextDirection;
		if (value === null) delete (store as Record<string, unknown>)[key];
		else (store as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
		this.render();
	}

	/** The GLOBAL values, for the visibility menu's "Global (…)" labels. Without
	 *  showing what Global resolves to, choosing it is a guess. */
	globalVisibility(): {
		hideCompleted: boolean; noteDisplay: NoteDisplay;
		textDirection: TextDirection; defaultViewMode: DocViewMode;
	} {
		return {
			hideCompleted: this.plugin.settings.hideCompleted,
			noteDisplay: this.plugin.settings.noteDisplay,
			textDirection: this.plugin.settings.textDirection,
			defaultViewMode: this.plugin.settings.defaultViewMode,
		};
	}

	/** This document's layout override, or null when it follows the default. */
	layoutOverride(): DocViewMode | null {
		return this.plugin.settings.viewModes[this.file?.path ?? ""] ?? null;
	}

	/** Set the layout, or clear it back to the global default with null. */
	async setViewModeOverride(mode: DocViewMode | null): Promise<void> {
		const key = this.file?.path ?? "";
		if (mode === null) {
			delete this.plugin.settings.viewModes[key];
			await this.plugin.saveSettings();
			this.render();
			return;
		}
		await this.setViewMode(mode);
	}

	/** This document's override, or null when it follows the global setting. */
	overrideOf(which: "checked" | "notes" | "direction"): boolean | NoteDisplay | TextDirection | null {
		const key = this.file?.path ?? "";
		const store = which === "checked" ? this.plugin.settings.docHideCompleted
			: which === "notes" ? this.plugin.settings.docNoteDisplay
				: this.plugin.settings.docTextDirection;
		const value = (store as Record<string, boolean | NoteDisplay | TextDirection>)[key];
		return value ?? null;
	}

	/** Set (or clear, with null) this document's own scale. */
	async setDocScale(next: number | null): Promise<void> {
		const key = this.file?.path ?? "";
		if (next === null) delete this.plugin.settings.docScale[key];
		else this.plugin.settings.docScale[key] = Math.max(50, Math.min(250, Math.round(next)));
		await this.plugin.saveSettings();
		this.render();
	}

	/** Presentation for the open document (persisted per document). */
	viewMode(): DocViewMode {
		const key = this.file?.path ?? "";
		// Absent means "follow the global default", the same rule the other three
		// visibility rows use — so layout behaves like its neighbours instead of
		// being the one that silently pins itself.
		return this.plugin.settings.viewModes[key] ?? this.plugin.settings.defaultViewMode;
	}

	async setViewMode(mode: DocViewMode): Promise<void> {
		// Switching outline → mind map → outline is movement you should be able
		// to reverse, so it joins the zoom history.
		if (mode !== this.viewMode()) this.pushNav();
		// The mind map is drawn only when no search is open — it has no way to
		// show results — so switching to it WITH a search open stored the mode
		// and went on rendering the outline. That read as "mind map does not
		// work" rather than "close the search first", so close it for them.
		if (mode === "mindmap" && this.searchActive) {
			this.searchActive = false;
			this.searchQuery = "";
		}
		const key = this.file?.path ?? "";
		// ALWAYS store it, including "outline". Deleting the key on outline was
		// right while outline was the hardcoded default — absence meant outline.
		// Now absence means "follow the global default", so deleting here made
		// choosing List indistinguishable from choosing Global, and a document
		// could not be pinned to List at all. Only setViewModeOverride(null)
		// clears it now.
		this.plugin.settings.viewModes[key] = mode;
		await this.plugin.saveSettings();
		this.render();
	}

	/** Open this document in another tab (or beside this one), zoomed to an
	 *  item. The zoom is view state rather than part of the path, so it has to
	 *  be applied after the new leaf has loaded the file. */
	private async openZoomInNewLeaf(id: TrynaId, how: "tab" | "split"): Promise<void> {
		const file = this.file;
		if (!file) return;
		const leaf = this.app.workspace.getLeaf(how === "split" ? "split" : "tab");
		await leaf.openFile(file);
		window.setTimeout(() => {
			const view = leaf.view;
			if (view instanceof TrynalistDocView) {
				view.zoomRoot = id;
				view.render();
			}
		}, 320);
	}

	/** Back / forward for movement WITHIN the document — zoom and view mode.
	 *  Obsidian's own arrows only know which file a leaf shows. */
	private renderNavButtons(host: HTMLElement): void {
		const wrap = host.createDiv({ cls: "trynalist-nav" });
		const back = wrap.createSpan({
			cls: this.canNavBack() ? "trynalist-nav-btn" : "trynalist-nav-btn is-disabled",
		});
		setIcon(back, "arrow-left");
		back.setAttribute("aria-label", "Back — hold or right-click for history");
		back.addEventListener("click", () => void this.navGoBack());
		this.wireHistoryMenu(back, "back");
		const fwd = wrap.createSpan({
			cls: this.canNavForward() ? "trynalist-nav-btn" : "trynalist-nav-btn is-disabled",
		});
		setIcon(fwd, "arrow-right");
		fwd.setAttribute("aria-label", "Forward — hold or right-click for history");
		fwd.addEventListener("click", () => void this.navGoForward());
		this.wireHistoryMenu(fwd, "forward");
	}

	/** Hold (or right-click) a nav arrow to see where it would take you, the way
	 *  a browser's back button does. Choosing an entry jumps that many steps. */
	private wireHistoryMenu(el: HTMLElement, dir: "back" | "forward"): void {
		const open = (e: MouseEvent) => {
			const labels = this.navLabels(dir);
			if (!labels.length) return;
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			labels.forEach((label, i) => {
				menu.addItem((item) => item.setTitle(label).onClick(() => {
					void (dir === "back" ? this.navGoBack(i + 1) : this.navGoForward(i + 1));
				}));
			});
			menu.showAtMouseEvent(e);
		};
		el.addEventListener("contextmenu", open);
		let timer: number | null = null;
		el.addEventListener("pointerdown", (e) => {
			timer = window.setTimeout(() => { timer = null; open(e); }, 450);
		});
		const cancel = () => { if (timer) { window.clearTimeout(timer); timer = null; } };
		el.addEventListener("pointerup", cancel);
		el.addEventListener("pointerleave", cancel);
	}

	/** The bookmark that matches EXACTLY what is on screen — document, zoom and
	 *  query. Dynalist's own star gets this wrong: bookmark a document, zoom
	 *  into a child, and it still offers to un-bookmark, because it only
	 *  compares the document. Comparing the whole view is the fix. */
	private matchingBookmark(): Bookmark | undefined {
		const path = this.file?.path;
		if (!path) return undefined;
		const query = this.searchActive && this.searchQuery.trim() ? this.searchQuery.trim() : undefined;
		return this.plugin.settings.bookmarks.find((b) =>
			b.docPath === path
			&& (b.itemId ?? null) === (this.zoomRoot ?? null)
			&& (b.query ?? undefined) === query);
	}

	/** Always visible, filled only when this exact view is bookmarked. Hiding it
	 *  until hover means you cannot tell at a glance. */
	private renderStar(host: HTMLElement): void {
		const existing = this.matchingBookmark();
		const star = host.createSpan({
			cls: existing ? "trynalist-star is-on" : "trynalist-star",
		});
		setIcon(star, existing ? "star" : "star-off");
		star.setAttribute("aria-label", existing
			? `Remove the bookmark "${existing.label}"`
			: "Bookmark this view");
		star.addEventListener("click", () => {
			void (async () => {
				const match = this.matchingBookmark();
				if (match) {
					this.plugin.settings.bookmarks = this.plugin.settings.bookmarks.filter((b) => b.id !== match.id);
					await this.plugin.saveSettings();
					this.plugin.refreshPanels();
					new Notice(`Trynalist: removed the bookmark "${match.label}".`);
					this.render();
					return;
				}
				this.bookmarkCurrentView();
			})();
		});
		star.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const match = this.matchingBookmark();
			const menu = new Menu();
			menu.addItem((i) => i.setTitle(match ? "Rename this bookmark" : "Bookmark this view…")
				.setIcon(match ? "pencil" : "bookmark-plus")
				.onClick(() => {
					if (!match) { this.bookmarkCurrentView(); return; }
					new PromptModal(this.app, {
						title: "Rename bookmark",
						label: "Name",
						initial: match.label,
						cta: "Rename",
						onSubmit: async (value) => {
							// The bookmark's name lives in settings, NOT in the
							// document — renaming what you call a view must never
							// rewrite the file it points at.
							match.label = value.trim() || match.label;
							await this.plugin.saveSettings();
							this.plugin.refreshPanels();
							this.render();
						},
					}).open();
				}));
			menu.addItem((i) => i.setTitle("Show in the bookmarks pane").setIcon("panel-left")
				.onClick(() => void this.plugin.revealPane(BOOKMARKS_VIEW_TYPE)));
			menu.showAtMouseEvent(e);
		});
	}

	private renderViewSwitcher(host: HTMLElement): void {
		const current = this.viewMode();
		const wrap = host.createDiv({ cls: "trynalist-view-switch" });
		const modes: Array<[DocViewMode, string, string]> = [
			["outline", "list-tree", "Outline"],
			["flat", "list", "Flat"],
			["article", "book-open", "Article"],
			["mindmap", "git-fork", "Mind map"],
		];
		for (const [mode, icon, label] of modes) {
			const btn = wrap.createSpan({
				cls: mode === current ? "trynalist-view-btn is-active" : "trynalist-view-btn",
			});
			setIcon(btn, icon);
			btn.setAttribute("aria-label", `${label} view`);
			btn.addEventListener("click", () => void this.setViewMode(mode));
		}
	}

	/** Flat view: every descendant of the zoom root in one list, each with the
	 *  trail that locates it. Editable, like the outline. */
	private renderFlat(host: HTMLElement): void {
		const idx = this.index;
		if (!idx) return;
		// visible() honours collapse; a flat view deliberately ignores it.
		const all: TreeNode[] = [];
		const walk = (parent: TrynaId | null) => {
			for (const c of idx.children(parent)) {
				if (this.effectiveHideCompleted() && c.checked) continue;
				// A mirror has no text of its own: here it drew as a blank,
				// editable row whose typing the outline then hid (finding 11).
				if (c.mirrorOf) continue;
				all.push(c);
				walk(c.id);
			}
		};
		walk(this.zoomRoot);
		if (!all.length) return;
		host.createDiv({ cls: "trynalist-search-count", text: `${all.length} items` });
		// The trail is one plain-text string per item, memoised by parent, so
		// an item costs one text node rather than one inline render per
		// ancestor — O(N) instead of O(N × depth) (L80). Its depth comes along.
		const trails = new Map<TrynaId, { text: string; depth: number }>();
		const trailOf = (parentId: TrynaId | null): { text: string; depth: number } => {
			if (!parentId || parentId === this.zoomRoot) return { text: "", depth: 0 };
			const hit = trails.get(parentId);
			if (hit) return hit;
			trails.set(parentId, { text: "", depth: 0 });   // cycle guard
			const p = idx.nodes.get(parentId);
			if (!p) return { text: "", depth: 0 };
			const up = trailOf(p.parent);
			const label = plainOf(p.text) || "(empty)";
			const out = { text: up.text ? `${up.text} › ${label}` : label, depth: up.depth + 1 };
			trails.set(parentId, out);
			return out;
		};
		this.renderPaged(host, all, FLAT_PAGE, (n) => {
			const item = host.createDiv({ cls: "trynalist-item trynalist-flat-item" });
			// Flattening throws away the one thing the outline made obvious —
			// how deep an item sits. The badge puts that back. Depth is counted
			// from the current zoom root, so it matches what you would see.
			const trail = trailOf(n.parent);
			this.depthBadge(item, trail.depth + 1);
			if (trail.text) item.createDiv({ cls: "trynalist-suggest-trail", text: trail.text });
			this.renderRow(item, n, null);
		});
	}

	/** Draw the first `page` items, then a button that draws the next page
	 *  in place (L80): Flat and Article render every item, and a 5,000-item
	 *  document built 5,000 editable rows or markdown renders up front. */
	private renderPaged<T>(host: HTMLElement, items: T[], page: number, draw: (item: T) => void): void {
		let shown = 0;
		const more = (): void => {
			const end = Math.min(items.length, shown + page);
			for (; shown < end; shown++) draw(items[shown]);
			if (shown >= items.length) return;
			const wrap = host.createDiv({ cls: "trynalist-search-more" });
			const left = items.length - shown;
			const btn = wrap.createEl("button", { text: `Show ${Math.min(page, left)} more (${left} left)` });
			btn.addEventListener("click", () => { wrap.remove(); more(); });
		};
		more();
	}

	/** The `L3` badge that stands in for the indentation a flat list threw away.
	 *
	 *  Colour is the only thing separating one level's run of rows from the next
	 *  here, so it varies by HUE rather than by lightness: rotating the hue keeps
	 *  every badge at the same contrast against its own text, where a light-to-
	 *  dark ramp would have left the pale end unreadable and the dark end
	 *  indistinguishable from its neighbour. Lightness is fixed in CSS, per
	 *  theme, so the guarantee holds at every depth. 47deg steps are far enough
	 *  apart that no two adjacent levels land on a similar colour before the
	 *  cycle comes back around at level 9. */
	private depthBadge(host: HTMLElement, level: number): HTMLElement {
		const badge = host.createSpan({
			cls: "trynalist-flat-depth",
			text: `L${level}`,
			attr: { "aria-label": `Indentation level ${level}` },
		});
		badge.style.setProperty("--tryna-depth-hue", String((210 + (level - 1) * 47) % 360));
		return badge;
	}

	/** Where user-deleted subtrees are moved, under the root. */
	private trashDir(): string {
		return `${this.plugin.settings.rootFolder.replace(/\/+$/, "")}/_trash`;
	}

	/** Open the Trynalist trash — reachable from the mobile toolbar too. */
	openTrashPanel(): void {
		openTrash(this.app, this.plugin.settings.rootFolder, (into) => {
			this.plugin.refreshPanels();
			if (into) void this.plugin.reloadDocViews(into);
		});
	}

	/** Ancestors of an item, outermost first. */
	private trailNodes(n: TreeNode): TreeNode[] {
		const idx = this.index;
		if (!idx) return [];
		const out: TreeNode[] = [];
		const seen = new Set<TrynaId>();
		let p = n.parent ? idx.nodes.get(n.parent) : null;
		while (p && !seen.has(p.id)) { out.unshift(p); seen.add(p.id); p = p.parent ? idx.nodes.get(p.parent) : null; }
		return out;
	}

	/** Article view: read-only prose. Headings become real headings, plain
	 *  items become paragraphs, and leaf lists stay as bullets. */
	private renderArticle(host: HTMLElement): void {
		const idx = this.index;
		if (!idx) return;
		host.addClass("trynalist-article");
		// Collected first, then drawn a page at a time (L80): every note goes
		// through the markdown renderer, which is the expensive part.
		const flat: Array<{ n: TreeNode; level: number }> = [];
		const hide = this.effectiveHideCompleted();
		const walk = (parent: TrynaId | null, depth: number) => {
			for (const n of idx.children(parent)) {
				if (hide && n.checked) continue;
				if (n.mirrorOf) continue;   // no text of its own (finding 11)
				const kids = idx.children(n.id);
				flat.push({ n, level: n.heading || (kids.length ? Math.min(6, depth + 2) : 0) });
				walk(n.id, depth + 1);
			}
		};
		walk(this.zoomRoot, 0);
		this.renderPaged(host, flat, ARTICLE_PAGE, ({ n, level }) => {
			if (level) {
				const h = host.createEl(`h${Math.min(6, Math.max(1, level))}` as keyof HTMLElementTagNameMap);
				this.renderRowText(h as HTMLElement, n.text, n.id);
			} else {
				const p = host.createEl("p", { cls: n.checked ? "is-checked" : "" });
				this.renderRowText(p, n.text, n.id);
			}
			if (n.note) {
				// The INLINE renderer collapsed a whole note onto one line
				// with its fences showing. Notes are blocks — outline and
				// flat both use the markdown renderer, and article was the
				// one surface still doing this by hand.
				this.renderNoteInto(
					host.createDiv({ cls: "trynalist-note trynalist-article-note" }),
					n.note,
				);
			}
		});
	}

	/** A flag set on an ancestor applies to the whole subtree (Dynalist's
	 *  "make children a checklist" keeps checkboxes on deeper levels too). */
	private inheritsFlag(n: TreeNode, key: "checklist" | "numbered"): boolean {
		return this.index ? TrynalistDocView.inheritsFlagIn(this.index, n, key) : false;
	}

	/** inheritsFlag against any index — a mirror body inherits from its
	 *  SOURCE document's ancestors, not from this one's. */
	private static inheritsFlagIn(idx: DocIndex, n: TreeNode, key: "checklist" | "numbered"): boolean {
		let p = n.parent ? idx.nodes.get(n.parent) : null;
		const seen = new Set<TrynaId>();
		while (p && !seen.has(p.id)) {
			if (p[key]) return true;
			seen.add(p.id);
			p = p.parent ? idx.nodes.get(p.parent) : null;
		}
		return false;
	}

	private renderChildren(host: HTMLElement, parent: TrynaId | null): void {
		const idx = this.index;
		if (!idx) return;
		const hide = this.effectiveHideCompleted();
		const kids = idx.children(parent).filter((n) => !(hide && n.checked));
		for (let i = 0; i < kids.length; i++) {
			if (this.renderBudget <= 0) { this.addLazy(host, parent, kids, i); break; }
			this.buildItem(host, kids[i], i + 1);
		}
	}

	// ── progressive rendering (H10 part c) ─────────────────────────────
	//
	// The outline is nested DOM, so rather than a flat window this draws a
	// row budget per pass: once it runs out, the rest of each list is one
	// `.trynalist-lazy` placeholder (always its list's LAST child, sized from
	// an estimate). A placeholder fills in a chunk at a time when it nears the
	// viewport, and at once, up to the row needed, when focus or a scroll
	// anchor points into it. Filled-in rows stay. Everything else — patch,
	// reconcile, selection — works on whatever is drawn, and treats a row
	// inside a placeholder as "not drawn yet", never as a reason to rebuild.

	private lazyWanted(idx: DocIndex): boolean {
		return this.visibleOrder(idx).vis.length >= this.lazyMinRows;
	}

	/** Rows a subtree would draw: the node plus its open, shown descendants. */
	private visibleCount(n: TreeNode, hide: boolean): number {
		const idx = this.index;
		if (!idx) return 1;
		let count = 1;
		if (n.collapsed || n.mirrorOf) return count;
		for (const k of idx.children(n.id)) if (!(hide && k.checked)) count += this.visibleCount(k, hide);
		return count;
	}

	/** Put the placeholder for `kids[from..]` at the end of `container`. */
	private addLazy(container: HTMLElement, parent: TrynaId | null, kids: TreeNode[], from: number): void {
		const hide = this.effectiveHideCompleted();
		let rows = 0;
		for (let i = from; i < kids.length; i++) rows += this.visibleCount(kids[i], hide);
		const ph = container.createDiv({ cls: "trynalist-lazy" });
		ph.dataset.parent = parent ?? "";
		ph.style.height = `${Math.max(1, rows) * this.lazyRowPx}px`;
		ph.setAttribute("aria-hidden", "true");
		this.observeLazy(ph);
	}

	private observeLazy(ph: HTMLElement): void {
		if (!this.lazyObserver) {
			// The view's own window: an observer from the main window does not
			// see a popout's layout.
			const IO = (this.contentEl.win as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
			this.lazyObserver = new IO((entries) => {
				for (const e of entries) {
					const target = e.target;
					if (e.isIntersecting && target.isConnected && target.instanceOf(HTMLElement)) this.materialize(target);
				}
			}, { root: this.scrollHost(), rootMargin: "0px 0px 1500px 0px" });
		}
		this.lazyObserver.observe(ph);
	}

	/** Replace a placeholder with its next chunk of items — or, given
	 *  `untilId`, with every item up to that one plus a chunk after it. */
	private materialize(ph: HTMLElement, untilId?: TrynaId): void {
		const idx = this.index;
		const container = ph.parentElement;
		if (!idx || !container) return;
		const parentId = ph.dataset.parent ? ph.dataset.parent : null;
		const hide = this.effectiveHideCompleted();
		const want = idx.children(parentId).filter((c) => !(hide && c.checked));
		// Continue after the last item this list has drawn (by the model's
		// order, so inserts and deletes since the placeholder was made count).
		const drawn = new Set(this.itemChildren(container).map((e) => e.dataset.node));
		let start = 0;
		want.forEach((c, i) => { if (drawn.has(c.id)) start = i + 1; });
		this.lazyObserver?.unobserve(ph);
		ph.remove();
		this.dragCache = null;
		let reached = untilId === undefined;
		let mirror = false;
		this.renderBudget = LAZY_CHUNK;
		try {
			for (let i = start; i < want.length; i++) {
				if (reached && this.renderBudget <= 0) { this.addLazy(container, parentId, want, i); break; }
				this.buildItem(container, want[i], i + 1);
				if (want[i].mirrorOf) mirror = true;
				if (want[i].id === untilId) reached = true;
			}
		} finally {
			this.renderBudget = Infinity;
		}
		if (mirror) void this.resolveMirrors();
	}

	/** Whether `id` should be on screen but sits inside a placeholder. */
	private inLazyRegion(id: TrynaId): boolean {
		const idx = this.index;
		const listEl = this.contentEl.querySelector<HTMLElement>(":scope > .trynalist-list.is-outline");
		if (!idx || !listEl || !this.contentEl.querySelector(".trynalist-lazy")) return false;
		if (this.itemEl(id)) return false;
		const seen = new Set<TrynaId>();
		let cur = idx.nodes.get(id);
		while (cur && !seen.has(cur.id) && cur.id !== this.zoomRoot) {
			seen.add(cur.id);
			const parentId = cur.parent;
			const container = parentId === this.zoomRoot
				? listEl
				: (parentId ? this.itemEl(parentId)?.querySelector<HTMLElement>(":scope > .trynalist-children") : null);
			if (container) return !!container.querySelector(":scope > .trynalist-lazy") && !this.itemEl(cur.id);
			if (!parentId) return false;
			cur = idx.nodes.get(parentId);
		}
		return false;
	}

	/** Draw every placeholder standing between the outline and `id`. */
	private materializeTo(id: TrynaId): boolean {
		const idx = this.index;
		const listEl = this.contentEl.querySelector<HTMLElement>(":scope > .trynalist-list.is-outline");
		if (!idx || !listEl) return false;
		const chain: TreeNode[] = [];
		const seen = new Set<TrynaId>();
		let cur = idx.nodes.get(id);
		while (cur && !seen.has(cur.id) && cur.id !== this.zoomRoot) {
			seen.add(cur.id);
			chain.unshift(cur);
			cur = cur.parent ? idx.nodes.get(cur.parent) : undefined;
		}
		if (this.zoomRoot && cur?.id !== this.zoomRoot) return false;   // outside the zoom
		for (const x of chain) {
			if (this.itemEl(x.id)) continue;
			const container = x.parent === this.zoomRoot
				? listEl
				: (x.parent ? this.itemEl(x.parent)?.querySelector<HTMLElement>(":scope > .trynalist-children") : null);
			const ph = container?.querySelector<HTMLElement>(":scope > .trynalist-lazy");
			if (!ph) return false;
			this.materialize(ph, x.id);
			if (!this.itemEl(x.id)) return false;
		}
		return true;
	}

	/** The first row at or below the top of `scroller`, and its offset. */
	private topRowAnchor(scroller: HTMLElement): { id: TrynaId; offset: number } | null {
		const rows = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".trynalist-list.is-outline .trynalist-row[data-id]"));
		if (!rows.length) return null;
		const top = scroller.getBoundingClientRect().top;
		let lo = 0;
		let hi = rows.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (rows[mid].getBoundingClientRect().bottom <= top) lo = mid + 1; else hi = mid;
		}
		const row = rows[lo];
		const id = row.dataset.id;
		return id ? { id, offset: row.getBoundingClientRect().top - top } : null;
	}

	/** One item — its row, note and (unless folded) its whole subtree — appended
	 *  to `host`. The item carries its node id and sibling ordinal so a partial
	 *  repaint can find it again and reuse it rather than rebuilding it. */
	private buildItem(host: HTMLElement, n: TreeNode, ordinal: number): HTMLElement {
		this.renderBudget--;
		const item = host.createDiv({ cls: "trynalist-item" });
		item.dataset.node = n.id;
		item.dataset.ord = String(ordinal);
		if (n.mirrorOf) { this.renderMirror(item, n); return item; }
		this.renderRow(item, n, ordinal);
		if (!n.collapsed && this.index && this.index.children(n.id).length > 0) {
			const kids = item.createDiv({ cls: "trynalist-children" });
			this.wireIndentGuide(kids, n.id);
			this.renderChildren(kids, n.id);
		}
		return item;
	}

	// ── partial repaint ──────────────────────────────────────────────────

	/** Repaint only what an edit touched, instead of rebuilding the document.
	 *  A full render() empties the view and redraws every visible row — about a
	 *  second at 5,000 rows — and nearly every keystroke that changes structure
	 *  used to call it. Most edits change one row or one sibling list.
	 *
	 *  - `rows`: repaint these rows (and their notes) in place; their children
	 *    are left alone. For flags that only change the row itself: tick,
	 *    colour, heading, a selection change on the focused row.
	 *  - `lists`: reconcile these parents' child lists against the model —
	 *    new children are built, removed ones dropped, moved ones moved, and
	 *    every unchanged child's DOM is kept as it is. The parent's own row is
	 *    repainted too, since its fold control depends on having children.
	 *    `null` is the top level of the document.
	 *  - `rebuild`: build these items (row + subtree) from scratch wherever they
	 *    land — for a subtree whose rendering depends on its ancestors (a move
	 *    under or out of a numbered or checklist parent).
	 *
	 *  Anything it cannot do exactly falls back to render(): another view mode,
	 *  search results, the empty-document hint, a list it cannot find. So a
	 *  wrong guess costs a full render, never a wrong screen. */
	private patch(what: { rows?: Iterable<TrynaId>; lists?: Iterable<TrynaId | null>; rebuild?: Iterable<TrynaId> }): void {
		this.visCache = null;
		this.dragCache = null;        // row elements may be replaced below
		this.dragSelectCache = null;
		const idx = this.index;
		const listEl = this.contentEl.querySelector<HTMLElement>(":scope > .trynalist-list.is-outline");
		if (!idx || !listEl || this.searchActive || this.viewMode() !== "outline"
			|| this.contentEl.querySelector(":scope > .trynalist-empty-hint")
			|| (this.zoomRoot && !idx.nodes.has(this.zoomRoot))
			|| !idx.children(this.zoomRoot).length) {
			this.render();
			return;
		}
		this.hideTooltip();
		this.hideDropGuide();
		// Where the caret was, in case the row holding it gets repainted.
		const before = this.contentEl.doc.activeElement;
		let caretBefore = -1;
		if (before?.instanceOf(HTMLElement) && before.hasClass("trynalist-text") && this.contentEl.contains(before)) {
			const sel = this.contentEl.doc.getSelection();
			if (sel?.rangeCount && before.contains(sel.getRangeAt(0).endContainer)) caretBefore = this.caretOffset(before);
		}
		const staleRaw = this.rawRowId;
		const rebuild = new Set(what.rebuild ?? []);
		const done = new Set<TrynaId>();       // items built fresh, subtree and all
		const painted = new Set<TrynaId>();    // rows already repainted
		// Items taken out of one list that another list in this same patch may
		// want (a Tab moves an item from its old parent's list into a new one).
		const pool = new Map<TrynaId, HTMLElement>();
		let fallback = false;
		let builtMirror = false;
		// Same contract as render(): detaching the focused row fires its blur
		// handler, which must not read a stale DOM back over the model.
		this.rendering = true;
		try {
			for (const parent of new Set(what.lists ?? [])) {
				const r = this.reconcileList(listEl, parent, rebuild, pool, done, painted);
				if (r === "fallback") { fallback = true; break; }
				if (r === "mirror") builtMirror = true;
			}
			if (!fallback) {
				for (const id of rebuild) {
					if (done.has(id)) continue;
					const old = this.itemEl(id);
					const n = idx.nodes.get(id);
					if (!old || !n) continue;
					const scratch = createDiv();
					const fresh = this.buildItem(scratch, n, Number(old.dataset.ord) || 1);
					if (n.mirrorOf) builtMirror = true;
					this.releaseNotes(old);
					old.replaceWith(fresh);
					done.add(id);
				}
				for (const id of new Set(what.rows ?? [])) {
					if (!done.has(id) && !painted.has(id)) this.repaintRow(id);
				}
				// A row left raw by an earlier paint for a focus it never got.
				// (Read before this patch built anything: building the newly
				// focused row updates rawRowId.)
				const stale = staleRaw;
				if (stale && stale !== this.focusId && !done.has(stale) && !painted.has(stale)) {
					const el = this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(stale)}"] .trynalist-text`);
					if (el && el.dataset.rendered !== "1" && this.contentEl.doc.activeElement !== el && !this.saveTimers.has(stale)) {
						this.repaintRow(stale);
					}
				}
			}
			for (const el of pool.values()) this.releaseNotes(el);
		} finally {
			this.rendering = false;
		}
		if (fallback || !idx.children(this.zoomRoot).length) { this.render(); return; }
		// A mirror elsewhere in this document may show what just changed.
		if (builtMirror || this.hasMirrors()) void this.resolveMirrors();
		// Put the caret back only if the patch took it away, or the caller asked
		// for a specific spot. Re-focusing a row the patch never touched would
		// throw its caret to the end of the line for no reason.
		const active = this.contentEl.doc.activeElement;
		const activeId = active?.instanceOf(HTMLElement) && this.contentEl.contains(active) ? this.ownerIdOf(active) : null;
		if (this.focusCaret >= 0 || activeId !== this.focusId) {
			if (this.focusCaret < 0 && caretBefore >= 0 && before?.instanceOf(HTMLElement)
				&& !before.isConnected && this.ownerIdOf(before) === this.focusId) {
				this.focusCaret = caretBefore;
			}
			this.restoreFocus();
		}
	}

	/** The item element drawn for a node, or null when it is not on screen
	 *  (inside a fold, filtered out, or the zoom root's own head row). */
	private itemEl(id: TrynaId): HTMLElement | null {
		return this.contentEl.querySelector<HTMLElement>(`.trynalist-item[data-node="${cssId(id)}"]`);
	}

	/** The node a focused editable (row text or note) belongs to. */
	private ownerIdOf(el: HTMLElement): TrynaId | null {
		const row = el.closest<HTMLElement>(".trynalist-row");
		if (row?.dataset.id) return row.dataset.id;
		const item = el.closest<HTMLElement>(".trynalist-item");
		return item?.querySelector<HTMLElement>(":scope > .trynalist-row")?.dataset.id ?? null;
	}

	/** The row renderRow last drew as raw source because it was focusId.
	 *  Normally its blur handler renders it again when focus leaves — but
	 *  if it never actually got DOM focus (after a reload, or while the
	 *  window was in the background) no blur comes, and a patch that moves
	 *  focusId elsewhere left it showing raw markup. See patch(). */
	private rawRowId: TrynaId | null = null;

	/** Bring one parent's child list in line with the model. */
	private reconcileList(
		listEl: HTMLElement,
		parentId: TrynaId | null,
		rebuild: Set<TrynaId>,
		pool: Map<TrynaId, HTMLElement>,
		done: Set<TrynaId>,
		painted: Set<TrynaId>,
	): "ok" | "mirror" | "fallback" {
		const idx = this.index;
		if (!idx) return "fallback";
		let container: HTMLElement;
		if (parentId === this.zoomRoot) {
			container = listEl;
		} else {
			const parent = parentId ? idx.nodes.get(parentId) : undefined;
			// A parent that is gone, or not drawn (inside a fold, filtered by
			// "hide completed", outside the zoom) has no list on screen to fix.
			if (!parent) return "ok";
			const item = this.itemEl(parent.id);
			// Not on screen and not meant to be: nothing to do. Meant to be but
			// missing (an ancestor's item was set aside by this same patch) is a
			// state this cannot reason about — rebuild everything instead.
			if (!item) return this.shouldBeDrawn(parent.id) && !this.inLazyRegion(parent.id) ? "fallback" : "ok";
			if (parent.mirrorOf) return "fallback";
			this.repaintRow(parent.id);
			painted.add(parent.id);
			let kids = item.querySelector<HTMLElement>(":scope > .trynalist-children");
			const open = !parent.collapsed && idx.children(parent.id).length > 0;
			if (!open) {
				if (kids) this.detachItems(kids, pool);
				kids?.remove();
				return "ok";
			}
			if (!kids) {
				kids = item.createDiv({ cls: "trynalist-children" });
				this.wireIndentGuide(kids, parent.id);
			}
			container = kids;
		}
		const hide = this.effectiveHideCompleted();
		let want = idx.children(parentId).filter((c) => !(hide && c.checked));
		const lazy = container.querySelector<HTMLElement>(":scope > .trynalist-lazy");
		const drawnBefore = this.itemChildren(container);
		// A list that was never drawn (a parent just expanded) is drawn the
		// ordinary way, under the same row budget as a full render.
		if (!lazy && !drawnBefore.length && want.length && this.lazyWanted(idx)) {
			this.renderBudget = LAZY_CHUNK;
			try {
				this.renderChildren(container, parentId);
			} finally {
				this.renderBudget = Infinity;
			}
			for (const c of want) done.add(c.id);
			return want.some((c) => c.mirrorOf) ? "mirror" : "ok";
		}
		// Only the drawn prefix of a lazy list is reconciled: up to the last
		// item it has drawn. Anything after that is the placeholder's to draw.
		if (lazy) {
			const drawn = new Set(drawnBefore.map((e) => e.dataset.node));
			let end = -1;
			want.forEach((c, i) => { if (drawn.has(c.id)) end = i; });
			want = want.slice(0, end + 1);
		}
		const wantIds = new Set(want.map((c) => c.id));
		// Drop what no longer belongs here first, so the ordering pass below only
		// ever inserts — moving an unchanged item through the DOM would blur it
		// if it held the caret.
		for (const el of this.itemChildren(container)) {
			const id = el.dataset.node;
			if (!id || !wantIds.has(id) || rebuild.has(id)) {
				if (id) pool.set(id, el);
				el.remove();
			}
		}
		let mirror = false;
		let cursor: Element | null = this.itemChildren(container)[0] ?? null;
		let ordinal = 0;
		for (const n of want) {
			ordinal++;
			let el: HTMLElement | null = null;
			if (!rebuild.has(n.id)) {
				el = pool.get(n.id) ?? null;
				if (el) pool.delete(n.id);
				else if (cursor?.instanceOf(HTMLElement) && cursor.dataset.node === n.id) el = cursor;
				else el = this.itemEl(n.id);
			}
			if (el) {
				if (el.dataset.ord !== String(ordinal)) {
					el.dataset.ord = String(ordinal);
					const dot = el.querySelector<HTMLElement>(":scope > .trynalist-row .trynalist-bullet.is-numbered .trynalist-bullet-dot");
					dot?.setText(`${ordinal}.`);
				}
			} else {
				const scratch = createDiv();
				el = this.buildItem(scratch, n, ordinal);
				if (n.mirrorOf) mirror = true;
				done.add(n.id);
			}
			if (el === cursor) {
				cursor = this.nextItem(cursor);
				continue;
			}
			container.insertBefore(el, cursor);
		}
		// Anything still after the cursor is left over from the old list.
		while (cursor) {
			const next = this.nextItem(cursor);
			const id = (cursor as HTMLElement).dataset.node;
			if (id) pool.set(id, cursor as HTMLElement);
			cursor.remove();
			cursor = next;
		}
		// Inserts land at the end with insertBefore(…, null); the placeholder
		// stays the list's last child.
		if (lazy) container.appendChild(lazy);
		return mirror ? "mirror" : "ok";
	}

	/** A list's item elements, in order (skipping the fold guide and the zoom
	 *  root's head row). */
	private itemChildren(container: HTMLElement): HTMLElement[] {
		const out: HTMLElement[] = [];
		for (const el of Array.from(container.children)) {
			if (el?.instanceOf(HTMLElement) && el.dataset.node) out.push(el);
		}
		return out;
	}

	private nextItem(el: Element): Element | null {
		let next = el.nextElementSibling;
		while (next && !(next?.instanceOf(HTMLElement) && next.dataset.node)) next = next.nextElementSibling;
		return next;
	}

	private detachItems(container: HTMLElement, pool: Map<TrynaId, HTMLElement>): void {
		for (const el of this.itemChildren(container)) {
			const id = el.dataset.node;
			if (id) pool.set(id, el);
			el.remove();
		}
	}

	/** Redraw one row and its note in place, leaving its children alone. */
	private repaintRow(id: TrynaId): void {
		const idx = this.index;
		const n = idx?.nodes.get(id);
		if (!idx || !n) return;
		const row = this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"]`);
		const item = row?.parentElement;
		if (!row || !item || !item.hasClass("trynalist-item") || item.hasClass("trynalist-mirror")) return;
		// The zoom root's head row is drawn without sibling context (no fold, no
		// number); every other row keeps the ordinal it was built with.
		const ordinal = item.hasClass("trynalist-zoom-root") ? null : Number(item.dataset.ord) || 1;
		const scratch = createDiv();
		this.renderRow(scratch, n, ordinal);
		const note = item.querySelector<HTMLElement>(":scope > .trynalist-note");
		if (note) { this.releaseNotes(note); note.remove(); }
		row.remove();
		item.prepend(...Array.from(scratch.childNodes));
	}

	/** Repaint after moving `ids` (with their subtrees) out of the `from`
	 *  parents' lists into wherever they are now. */
	private patchMoved(ids: TrynaId[], from: (TrynaId | null)[]): void {
		const idx = this.index;
		if (!idx) return;
		const lists = new Set<TrynaId | null>(from);
		for (const id of ids) {
			const n = idx.nodes.get(id);
			if (n) lists.add(n.parent);
		}
		// A moved subtree's rows depend on their ancestors only through
		// inherited numbering and checklists. Keep its DOM unless one of those
		// is involved on either side of the move.
		const inherited = [...lists].some((p) => this.chainHasListFlag(p));
		this.patch({ lists, rebuild: inherited ? ids : [] });
	}

	/** Repaint the difference between two snapshots of this document — what
	 *  undo and redo change. A large difference (a bulk operation undone) is a
	 *  full render; it would be most of the document anyway. */
	private patchDiff(before: NodeSnapshot[], after: NodeSnapshot[]): void {
		const was = new Map(before.map((x) => [x.id, x]));
		const now = new Map(after.map((x) => [x.id, x]));
		const hide = this.effectiveHideCompleted();
		const lists = new Set<TrynaId | null>();
		const rows = new Set<TrynaId>();
		const rebuild = new Set<TrynaId>();
		const moved: TrynaId[] = [];
		// Everything a row draws from its own node, beyond where it sits.
		const shown = (x: NodeSnapshot): string => JSON.stringify([
			x.text, x.note, x.checked, x.checkbox, x.heading, x.color,
			x.sourceId, x.source, x.dlPermission, x.dlPermissionLabel, x.dlRemoved,
		]);
		for (const [id, a] of was) {
			const b = now.get(id);
			if (!b) { lists.add(a.parent); continue; }
			if (a.parent !== b.parent || a.order !== b.order) {
				lists.add(a.parent);
				lists.add(b.parent);
				moved.push(id);
			}
			if (a.collapsed !== b.collapsed) lists.add(id);
			if (hide && a.checked !== b.checked) lists.add(b.parent);
			if (a.checklist !== b.checklist || a.numbered !== b.numbered
				|| a.mirrorOf !== b.mirrorOf || a.mirrorMode !== b.mirrorMode) rebuild.add(id);
			else if (shown(a) !== shown(b)) rows.add(id);
		}
		for (const [id, b] of now) if (!was.has(id)) lists.add(b.parent);
		if (lists.size + rows.size + rebuild.size > 200) { this.render(); return; }
		if ([...lists].some((p) => this.chainHasListFlag(p))) moved.forEach((id) => rebuild.add(id));
		this.patch({ lists, rows, rebuild });
	}

	/** Whether `id` or any ancestor numbers or checklists its subtree. */
	private chainHasListFlag(id: TrynaId | null): boolean {
		const idx = this.index;
		const seen = new Set<TrynaId>();
		let p = id ? idx?.nodes.get(id) : undefined;
		while (p && !seen.has(p.id)) {
			if (p.numbered || p.checklist) return true;
			seen.add(p.id);
			p = p.parent ? idx?.nodes.get(p.parent) : undefined;
		}
		return false;
	}

	/** After ticking or unticking: the rows change, unless completed items are
	 *  hidden, in which case they appear in or leave their lists. */
	private patchChecked(ids: TrynaId[]): void {
		const idx = this.index;
		if (!idx) return;
		if (this.effectiveHideCompleted()) {
			this.patch({ lists: ids.map((id) => idx.nodes.get(id)?.parent ?? null) });
		} else {
			this.patch({ rows: ids });
		}
	}

	/** A selection change: the selection classes, plus the focused row, which
	 *  shows raw source only while fewer than two rows are selected. */
	private repaintSelection(): void {
		this.paintSelection();
		this.patch({ rows: this.focusId ? [this.focusId] : [] });
	}

	/** Whether the model says `id`'s row should be on screen right now. */
	private shouldBeDrawn(id: TrynaId): boolean {
		const idx = this.index;
		if (!idx) return false;
		const hide = this.effectiveHideCompleted();
		const seen = new Set<TrynaId>();
		let n = idx.nodes.get(id);
		let first = true;
		while (n && !seen.has(n.id)) {
			if (n.id === this.zoomRoot) return true;
			if (hide && n.checked) return false;
			if (!first && n.collapsed) return false;
			seen.add(n.id);
			first = false;
			if (!n.parent) return this.zoomRoot === null;
			n = idx.nodes.get(n.parent);
		}
		return false;
	}

	/** Unload the Obsidian components a removed subtree's notes registered
	 *  (embeds, code-block processors). A full render drops them all with the
	 *  per-render host; a patch has to hand them back one note at a time. */
	private releaseNotes(root: HTMLElement): void {
		const host = this.noteHost ?? this;
		const notes = root.hasClass("trynalist-note") ? [root] : Array.from(root.querySelectorAll<HTMLElement>(".trynalist-note"));
		for (const el of notes) {
			const owner = this.noteOwners.get(el);
			if (owner) { host.removeChild(owner); this.noteOwners.delete(el); }
		}
	}

	/** Place the held mirror source (Copy as mirror) as the next sibling of
	 *  the focused item: a mirror ("item") or a portal showing only its
	 *  children ("children"). */
	async pasteMirror(mode: "item" | "children"): Promise<void> {
		const idx = this.index;
		const held = this.plugin.mirrorClipboard;
		if (!idx || !held) { new Notice("Trynalist: nothing held. Copy an item as a mirror first."); return; }
		const at = this.focusId ? idx.nodes.get(this.focusId) : undefined;
		await this.flushPendingSaves();
		this.pushUndo();
		const parent = at ? at.parent : this.zoomRoot;
		const made = await idx.createMirror(held.ref, mode, parent, at?.id ?? idx.children(parent).at(-1)?.id ?? null);
		this.mirrorsDirty = true;
		this.focusId = at?.id ?? null;
		this.patch({ lists: [made.parent] });
	}

	/** A mirror row. The node owns no text: everything shown comes from the
	 *  source, and nothing here is editable — writing through to another
	 *  document needs undo that spans documents, which does not exist yet, so
	 *  a read-only window is the honest version. */
	private renderMirror(item: HTMLElement, n: TreeNode): void {
		item.addClass("trynalist-mirror");
		const hit = this.mirrorHits.get(n.id);
		if (!hit) {
			// Resolution is async; this is the frame before it lands.
			item.createDiv({ cls: "trynalist-row trynalist-mirror-pending", text: "Resolving mirror…" });
			return;
		}
		if (!hit.ok) {
			const row = item.createDiv({ cls: "trynalist-row trynalist-mirror-missing" });
			const icon = row.createSpan({ cls: "trynalist-row-icon" });
			setIcon(icon, "unlink");
			row.createSpan({ cls: "trynalist-text", text: MirrorResolver.describe(hit) });
			// A broken mirror looks alarming and is not. Say so where the eye
			// already is, rather than only in the documentation.
			row.setAttribute("aria-label", MirrorResolver.explain(hit, n.mirrorOf ?? ""));
			row.addClass("trynalist-has-tooltip");
			this.wireMirrorMenu(row, n);
			return;
		}
		const head = item.createDiv({ cls: "trynalist-row trynalist-mirror-head" });
		head.dataset.id = n.id;
		const icon = head.createSpan({ cls: "trynalist-row-icon" });
		setIcon(icon, n.mirrorMode === "children" ? "panel-top" : "copy");
		head.setAttribute("aria-label",
			`${n.mirrorMode === "children" ? "Portal" : "Mirror"} of "${hit.node.text || "(empty)"}" in ${hit.docTitle}`);
		const label = head.createDiv({ cls: "trynalist-text trynalist-mirror-label" });
		if (n.mirrorMode === "children") {
			label.setText(n.text || `Children of "${hit.node.text || "(empty)"}"`);
		} else {
			this.renderRowText(label, hit.node.text, hit.node.id, true);
		}
		head.createSpan({ cls: "trynalist-mirror-source", text: hit.docTitle });
		this.wireMirrorMenu(head, n);
		if (n.collapsed) return;
		const kids = item.createDiv({ cls: "trynalist-children trynalist-mirror-body" });
		kids.createDiv({ cls: "trynalist-guide is-inert" });
		// Hide-completed and inherited numbering apply here as they would in the
		// source: the rows shown are filtered, and numbering counts what is shown.
		const hide = this.effectiveHideCompleted();
		const rows = (this.mirrorResolver?.rowsFor(hit, n.mirrorMode) ?? []).filter((r) => !(hide && r.checked));
		// A single mirrored item keeps the number it has in its own list.
		const firstOrdinal = n.mirrorMode === "children" || !rows.length ? 1
			: hit.index.children(rows[0].parent).filter((c) => !(hide && c.checked)).findIndex((c) => c.id === rows[0].id) + 1;
		const path = new Set<string>([`${hit.index.docRef.file.path}#${hit.node.id}`]);
		rows.forEach((src, i) => this.renderMirrored(kids, hit.index, src, 0, Math.max(1, firstOrdinal) + i, path));
	}

	/** Paint a source subtree. Deliberately NOT renderRow: these rows belong
	 *  to another index, so the full editing machinery (structure keys, dates,
	 *  chips) must not reach them. Only the text can be edited here, and the
	 *  edit is written to the item's own document (editMirrored).
	 *
	 *  `path` holds the mirror targets already open above this row, so a
	 *  mirror nested in a mirrored subtree expands unless it leads back into
	 *  one of them. */
	private renderMirrored(host: HTMLElement, index: DocIndex, n: TreeNode, depth = 0, ordinal = 1, path: Set<string> = new Set()): void {
		if (depth > 40) return;   // belt and braces against a malformed source
		if (n.mirrorOf) { this.renderNestedMirror(host, index, n, depth, path); return; }
		const item = host.createDiv({ cls: "trynalist-item" });
		const row = item.createDiv({ cls: "trynalist-row trynalist-mirror-row" });
		const numbered = TrynalistDocView.inheritsFlagIn(index, n, "numbered");
		const bullet = row.createSpan({ cls: numbered ? "trynalist-bullet is-numbered" : "trynalist-bullet" });
		const dot = bullet.createSpan({ cls: "trynalist-bullet-dot" });
		if (numbered) dot.setText(`${ordinal}.`);
		if (n.checkbox || n.checked || TrynalistDocView.inheritsFlagIn(index, n, "checklist")) {
			const box = row.createEl("input", { type: "checkbox", cls: "trynalist-check" });
			box.checked = n.checked;
			box.disabled = true;
		}
		const text = row.createDiv({ cls: "trynalist-text" });
		if (n.heading) row.addClass(`is-h${n.heading}`);
		if (n.color) row.addClass(`tl-color-${n.color}`);
		if (n.checked) row.addClass("is-checked");
		this.renderRowText(text, n.text, n.id, true);
		this.wireMirroredEditing(text, index, n);
		if (n.note && this.effectiveNoteDisplay() !== "hidden") {
			this.renderNoteInto(item.createDiv({ cls: "trynalist-note" }), n.note, this.notesTrusted(index.docRef));
		}
		if (n.collapsed) return;
		const hide = this.effectiveHideCompleted();
		const kids = index.children(n.id).filter((k) => !(hide && k.checked));
		if (!kids.length) return;
		const wrap = item.createDiv({ cls: "trynalist-children" });
		// A mirror's children live in another document, so folding them here has
		// nowhere to be saved — the line is drawn but inert.
		wrap.createDiv({ cls: "trynalist-guide is-inert" });
		kids.forEach((kid, i) => this.renderMirrored(wrap, index, kid, depth + 1, i + 1, path));
	}

	/** A mirror inside a mirrored subtree: a small head naming its source, and
	 *  the source's rows under it — resolved by resolveMirrors (nestedHits). */
	private renderNestedMirror(host: HTMLElement, index: DocIndex, n: TreeNode, depth: number, path: Set<string>): void {
		const item = host.createDiv({ cls: "trynalist-item trynalist-mirror trynalist-mirror-nested" });
		const head = item.createDiv({ cls: "trynalist-row trynalist-mirror-row trynalist-mirror-nested-head" });
		const icon = head.createSpan({ cls: "trynalist-row-icon" });
		setIcon(icon, n.mirrorMode === "children" ? "panel-top" : "copy");
		const hit = this.nestedHits.get(`${index.docRef.file.path}#${n.id}`);
		if (!hit) { head.createSpan({ cls: "trynalist-text", text: "Resolving mirror…" }); return; }
		if (!hit.ok) { head.createSpan({ cls: "trynalist-text", text: MirrorResolver.describe(hit) }); return; }
		const key = `${hit.index.docRef.file.path}#${hit.node.id}`;
		if (path.has(key)) { head.createSpan({ cls: "trynalist-text", text: "Mirror leads back into itself" }); return; }
		head.createSpan({
			cls: "trynalist-text trynalist-mirror-label",
			text: n.mirrorMode === "children" ? `Children of "${hit.node.text || "(empty)"}"` : `Mirror of "${hit.node.text || "(empty)"}"`,
		});
		head.createSpan({ cls: "trynalist-mirror-source", text: hit.docTitle });
		if (n.collapsed || depth > 40) return;
		const hide = this.effectiveHideCompleted();
		const rows = (this.mirrorResolver?.rowsFor(hit, n.mirrorMode) ?? []).filter((x) => !(hide && x.checked));
		if (!rows.length) return;
		const wrap = item.createDiv({ cls: "trynalist-children trynalist-mirror-body" });
		wrap.createDiv({ cls: "trynalist-guide is-inert" });
		const inner = new Set(path).add(key);
		rows.forEach((x, i) => this.renderMirrored(wrap, hit.index, x, depth + 1, i + 1, inner));
	}

	/** Click a mirrored row's text to edit it. The raw text is shown while
	 *  editing; Enter or leaving the row saves, Escape cancels. Nothing
	 *  structural (Tab, Enter-to-split, Backspace-merge) happens here. */
	private wireMirroredEditing(el: HTMLElement, index: DocIndex, n: TreeNode): void {
		el.addClass("is-mirror-editable");
		el.setAttribute("aria-label", "Click to edit — saved to its own document");
		let original: string | null = null;
		const finish = (save: boolean): void => {
			if (original === null) return;
			const before = original;
			original = null;
			const next = rowDomToRaw(el.innerText).replace(/\s+$/, "");
			el.contentEditable = "false";
			el.empty();
			this.renderRowText(el, save ? next : before, n.id, true);
			if (save && next !== before) void this.editMirrored(index, n.id, next);
		};
		el.addEventListener("mousedown", (e) => {
			if (original !== null || e.button !== 0) return;
			// A link or chip inside the text keeps its own click.
			if ((e.target as HTMLElement).closest("a, .trynalist-chip, img")) return;
			e.preventDefault();
			original = index.nodes.get(n.id)?.text ?? n.text;
			el.contentEditable = "true";
			el.setText(original);
			el.focus();
			const range = el.doc.createRange();
			range.selectNodeContents(el);
			range.collapse(false);
			const sel = el.doc.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
		});
		el.addEventListener("keydown", (e) => {
			if (original === null) return;
			// Keep every key inside the row: the view's own shortcuts act on its
			// focused item, not on this one.
			e.stopPropagation();
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.blur(); return; }
			if (e.key === "Escape") { e.preventDefault(); finish(false); return; }
			if (e.key === "Tab") e.preventDefault();
		});
		el.addEventListener("blur", () => finish(true));
	}

	/** Write an edit made through a mirror to the item's own document. When
	 *  that document is open in a tab (or IS this document), the edit goes
	 *  through that tab — one undo step there. Otherwise it is written through
	 *  the mirror's copy of the document; undo cannot reach it, item history
	 *  can. */
	private async editMirrored(index: DocIndex, id: TrynaId, text: string): Promise<void> {
		const docPath = index.docRef.file.path;
		try {
			if (this.index && docPath === this.index.docRef.file.path) {
				if (!this.index.nodes.has(id)) return;
				await this.flushPendingSaves();
				this.pushUndo();
				await this.index.setBody(id, text, this.index.nodes.get(id)?.note ?? "");
				this.patch({ rows: [id] });
			} else {
				const open = this.app.workspace.getLeavesOfType(DOC_VIEW_TYPE)
					.map((l) => l.view)
					.find((v): v is TrynalistDocView => v instanceof TrynalistDocView && v !== this && v.file?.path === docPath);
				if (open && await open.applyOutsideEdit(id, text)) {
					new Notice(`Trynalist: saved to "${index.docRef.manifest.title}" — undo it in that tab.`);
				} else {
					const live = index.nodes.get(id);
					if (!live) { new Notice("Trynalist: that item is no longer in its document."); return; }
					await index.setBody(id, text, live.note);
					new Notice(`Trynalist: saved to "${index.docRef.manifest.title}". Item history there can put the old text back.`);
				}
			}
		} catch (e) {
			console.error("Trynalist: could not save an edit made through a mirror", e);
			new Notice("Trynalist: could not save that edit. See the console.");
		}
		this.mirrorsDirty = true;
		void this.resolveMirrors();
	}

	/** Point an existing mirror at a different source item — in this document
	 *  or any other (the picker widens to every document when nothing here
	 *  matches). Mode and fold state stay; one undo step. */
	private repointMirror(n: TreeNode): void {
		const idx = this.index;
		if (!idx) return;
		new ItemSuggestModal(this.app, idx, {
			placeholder: "Point this mirror at…",
			exclude: new Set([n.id]),
			widenRoot: this.plugin.settings.rootFolder,
			onChoose: (item, from) => { void (async () => {
				const live = this.index?.nodes.get(n.id);
				if (!item || !live || live !== idx.nodes.get(n.id)) return;
				// The document stand-in ("the top level of X") is not an item.
				if (from?.isRoot || item.id.startsWith("__doc__")) {
					new Notice("Trynalist: pick an item — a mirror shows one item and what is under it.");
					return;
				}
				const docPath = from ? from.index.docRef.file.path : idx.docRef.file.path;
				this.pushUndo();
				live.mirrorOf = formatMirrorRef(docPath, item.id);
				await idx.writeNode(live);
				this.mirrorHits.delete(n.id);
				this.patch({ rebuild: [n.id] });
				await this.resolveMirrors();
				const hit = this.mirrorHits.get(n.id);
				if (hit && !hit.ok) new Notice(`Trynalist: ${MirrorResolver.describe(hit)}.`);
			})(); },
		}).open();
	}

	/** An edit to one of this document's items made from somewhere else (a
	 *  mirror in another tab): one undo step here, repainted in place. */
	async applyOutsideEdit(id: TrynaId, text: string): Promise<boolean> {
		const idx = this.index;
		const n = idx?.nodes.get(id);
		if (!idx || !n) return false;
		await this.flushPendingSaves();
		this.pushUndo();
		await idx.setBody(id, text, n.note);
		this.patch({ rows: [id] });
		return true;
	}

	/** Make the vertical indentation line fold its parent, as the Outliner
	 *  plugin does. The line already draws the relationship; clicking the thing
	 *  that draws it is the obvious way to collapse it, and it gives a big
	 *  full-height target for an action that otherwise needs a 20px arrow.
	 *
	 *  A separate strip rather than a hit test on the container: the children
	 *  fill that container, so testing offsetX would swallow clicks meant for a
	 *  row whenever one started near the left edge. */
	private wireIndentGuide(kids: HTMLElement, parentId: TrynaId): void {
		const guide = kids.createDiv({ cls: "trynalist-guide" });
		guide.setAttribute("aria-hidden", "true");
		guide.addEventListener("mousedown", (e) => e.preventDefault());
		guide.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.focusId = parentId;
			void this.cmdToggleCollapse();
		});
	}

	private wireMirrorMenu(row: HTMLElement, n: TreeNode): void {
		const open = (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			const hit = this.mirrorHits.get(n.id);
			if (hit?.ok) {
				menu.addItem((i) => i.setTitle("Go to the source item").setIcon("arrow-right").onClick(() => {
					void this.plugin.openDocFile(hit.index.docRef.file, hit.node.id);
				}));
			}
			menu.addItem((i) => i
				.setTitle(n.mirrorMode === "children" ? "Show the source item too" : "Show only the children")
				.setIcon("list-tree")
				.onClick(async () => {
					const live = this.index?.nodes.get(n.id);
					if (!live) return;
					this.pushUndo();
					live.mirrorMode = live.mirrorMode === "children" ? "item" : "children";
					await this.index?.touch(n.id);
					this.render();
				}));
			menu.addItem((i) => i.setTitle(n.collapsed ? "Expand mirror" : "Collapse mirror")
				.setIcon("chevrons-up-down").onClick(async () => {
					this.pushUndo();
					await this.index?.setFlag(n.id, "collapsed", !n.collapsed);
					this.render();
				}));
			menu.addItem((i) => i.setTitle("Point at another item…").setIcon("crosshair")
				.onClick(() => this.repointMirror(n)));
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Remove this mirror").setIcon("trash").onClick(async () => {
				// Only the window goes; the source subtree is untouched. Through
				// Trynalist's trash like every other delete, so it is restorable.
				this.pushUndo();
				await this.index?.deleteNode(n.id, { trashDir: this.trashDir() });
				this.render();
			}));
			menu.showAtMouseEvent(e);
		};
		row.addEventListener("contextmenu", open);
		row.addEventListener("click", open);
	}

	/** Whether `path` lies in a document one of this view's mirrors shows. */
	private touchesMirrorSource(path: string): boolean {
		for (const hit of this.mirrorHits.values()) {
			if (hit.ok && path.startsWith(`${hit.index.docRef.folder.path}/`)) return true;
		}
		return false;
	}

	/** Re-resolve this document's mirrors a moment after a change that may
	 *  affect them, so a mirror of another document follows its source
	 *  instead of showing it as it was when first painted (finding 6).
	 *  Only changes inside a mirrored document count — any write anywhere used
	 *  to drop every cached source and reload them all (finding 13) — plus,
	 *  while a mirror is broken, any create/delete/rename (`structural`),
	 *  since that may be its source coming back. */
	private mirrorRefreshTimer: number | null = null;
	private queueMirrorRefresh(paths: string[], structural: boolean): void {
		if (!this.hasMirrors()) return;
		const relevant = paths.some((p) => this.touchesMirrorSource(p))
			|| (structural && [...this.mirrorHits.values()].some((h) => !h.ok));
		if (!relevant) return;
		// This document's own index is live in the resolver; only a change
		// elsewhere needs the cached source documents dropped.
		const own = this.file?.parent?.path;
		if (paths.some((p) => !own || !p.startsWith(`${own}/`))) this.mirrorsDirty = true;
		if (this.mirrorRefreshTimer !== null) window.clearTimeout(this.mirrorRefreshTimer);
		this.mirrorRefreshTimer = window.setTimeout(() => {
			this.mirrorRefreshTimer = null;
			void this.resolveMirrors();
		}, 800);
	}

	private hasMirrors(): boolean {
		for (const n of this.index?.nodes.values() ?? []) if (n.mirrorOf) return true;
		return false;
	}

	/** Resolve every mirror in the document, then repaint once. Kept out of
	 *  render() itself because render is synchronous and following a mirror
	 *  can mean opening another document. */
	private async resolveMirrors(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		if (!this.mirrorResolver) this.mirrorResolver = new MirrorResolver(this.app, idx);
		// Drop the cached source documents only when something outside this
		// document has changed since they were read (vault events set the flag).
		// Dropping them on EVERY pass re-read every source document on every
		// collapse, selection and drop; never dropping them showed a source as
		// it was when first read. The flag is the middle: exact, and cheap.
		if (this.mirrorsDirty) { this.mirrorResolver.invalidate(); this.mirrorsDirty = false; }
		const nodes = [...idx.nodes.values()].filter((n) => n.mirrorOf);
		if (!nodes.length) { this.mirrorHits.clear(); this.nestedHits.clear(); this.nestedSig = ""; return; }
		const next = new Map<TrynaId, Resolved>();
		for (const n of nodes) {
			const hit = await this.mirrorResolver.resolve(n, idx.docRef.file.path);
			if (!hit) continue;
			next.set(n.id, hit);
			// The source document was renamed or moved and found again by the
			// item's id: point the reference at where it is now, so it stays
			// fixed without the lookup (finding 2). Our own node, so ours to write.
			const ref = n.mirrorOf ? parseMirrorRef(n.mirrorOf) : null;
			if (hit.ok && hit.movedTo && ref && this.index === idx) {
				n.mirrorOf = formatMirrorRef(hit.movedTo, ref.itemId);
				await idx.writeNode(n);
			}
		}
		// Mirrors inside mirrored subtrees: walk what each mirror shows (the
		// same rows renderMirrored draws), resolve any mirror found there, and
		// follow those in turn — capped in depth and count, since each can open
		// another document.
		const nested = new Map<string, Resolved>();
		const queue: Array<{ hit: Extract<Resolved, { ok: true }>; mode: TreeNode["mirrorMode"]; depth: number }> = [];
		for (const n of nodes) {
			const h = next.get(n.id);
			if (h?.ok) queue.push({ hit: h, mode: n.mirrorMode, depth: 1 });
		}
		const hideDone = this.effectiveHideCompleted();
		while (queue.length && nested.size < 200) {
			const { hit, mode, depth } = queue.shift() as { hit: Extract<Resolved, { ok: true }>; mode: TreeNode["mirrorMode"]; depth: number };
			if (depth > 5) continue;
			const docPath = hit.index.docRef.file.path;
			const found: TreeNode[] = [];
			const walk = (x: TreeNode, d: number): void => {
				if (d > 40 || (hideDone && x.checked)) return;
				if (x.mirrorOf) { found.push(x); return; }
				if (!x.collapsed || d === 0) for (const k of hit.index.children(x.id)) walk(k, d + 1);
			};
			for (const row of this.mirrorResolver.rowsFor(hit, mode)) walk(row, 0);
			for (const x of found) {
				const key = `${docPath}#${x.id}`;
				if (nested.has(key)) continue;
				const h = await this.mirrorResolver.resolve(x, docPath);
				if (!h) continue;
				nested.set(key, h);
				if (h.ok) queue.push({ hit: h, mode: x.mirrorMode, depth: depth + 1 });
			}
		}
		// Only repaint when something actually changed, or every resolution
		// would schedule another render and the view would never settle.
		// Compare on CONTENT, not object identity: the resolver now rebuilds the
		// source index each pass, so identity always differs and comparing it
		// would schedule a render forever.
		// The whole shown subtree, not just the source row and its children:
		// a changed grandchild, a tick or a child's note never triggered a
		// repaint before (finding 6). Capped, like the painting itself.
		const describe = (hit: Resolved): string => {
			if (!hit.ok) return `miss:${hit.reason}:${hit.ref.docPath}#${hit.ref.itemId}`;
			const parts: string[] = [];
			const walk = (n: TreeNode, depth: number): void => {
				if (depth > 40 || parts.length > 5000) return;
				parts.push(`${n.id}\u0001${n.text}\u0001${n.note}\u0001${+n.checked}${+n.checkbox}${+n.collapsed}${n.heading}${n.color}`);
				if (!n.collapsed || depth === 0) for (const k of hit.index.children(n.id)) walk(k, depth + 1);
			};
			walk(hit.node, 0);
			return `ok:${hit.index.docRef.file.path}:${parts.join("\u0002")}`;
		};
		const same = next.size === this.mirrorHits.size
			&& [...next].every(([id, v]) => {
				const prev = this.mirrorHits.get(id);
				return !!prev && describe(prev) === describe(v);
			});
		this.mirrorHits = next;
		const sig = [...nested].map(([k, h]) => `${k}\u0003${describe(h)}`).sort().join("\u0004");
		const nestedSame = sig === this.nestedSig;
		this.nestedHits = nested;
		this.nestedSig = sig;
		if (!same || !nestedSame) this.render();
	}

	/** One row (handle, collapse, bullet, checkbox, text, note) into `item`.
	 *  Shared by the outline and the flat view; `ordinal` is null where
	 *  numbering makes no sense (the flat view has no sibling context). */
	private renderRow(item: HTMLElement, n: TreeNode, ordinal: number | null): void {
		const idx = this.index;
		if (!idx) return;
		const flat = ordinal === null;
		const row = item.createDiv({ cls: "trynalist-row" });
		row.dataset.id = n.id;
		if (this.selection.has(n.id)) row.addClass("is-selected");
		if (n.checked) row.addClass("is-checked");
		if (n.heading) row.addClass(`is-h${n.heading}`);
		if (n.color) row.addClass(`tl-color-${n.color}`);

		// Menu handle — sits to the LEFT of the bullet (Dynalist placement).
		const handle = row.createSpan({ cls: "trynalist-menu-handle" });
		setIcon(handle, "menu");
		handle.setAttribute("aria-label", "Item menu");
		handle.addEventListener("click", (e) => {
			e.stopPropagation();
			this.openItemMenu(e, n);
		});

		const hasKids = idx.children(n.id).length > 0;
		// Collapsing is meaningless in the flat view — everything is shown.
		const collapsible = !flat && hasKids;
		const bulletZooms = this.plugin.settings.bulletClick === "zoom";
		// Dynalist shows TWO icons left of the bullet on hover: the menu, and a
		// magnifier that zooms. If you set the bullet to zoom instead, that
		// second icon becomes the +/- collapse control. (Dynalist Basics.)
		const action = row.createSpan({
			cls: (bulletZooms ? collapsible : true) ? "trynalist-rowaction" : "trynalist-rowaction is-empty",
		});
		if (bulletZooms) {
			if (collapsible) {
				setIcon(action, n.collapsed ? "plus" : "minus");
				action.setAttribute("aria-label", n.collapsed ? "Expand" : "Collapse");
				action.addEventListener("click", (e) => {
					e.stopPropagation();
					void idx.setFlag(n.id, "collapsed", !n.collapsed).then(() => this.patch({ lists: [n.id] }));
				});
			}
		} else {
			// Dynalist's zoom icon is a magnifier with a plus in it — and a minus
			// when you are already standing on this item, so getting back out is
			// the same button rather than a trip to the breadcrumb or a chord.
			const zoomedHere = this.zoomRoot === n.id;
			setIcon(action, zoomedHere ? "zoom-out" : "zoom-in");
			action.setAttribute("aria-label", zoomedHere ? "Zoom out" : "Zoom in");
			action.addEventListener("click", (e) => {
				e.stopPropagation();
				this.pushNav();
				if (zoomedHere) {
					// Out to the PARENT, not to the document root: one level out is
					// what the button that took you in was one level into.
					this.zoomRoot = idx.nodes.get(n.id)?.parent ?? null;
				} else {
					this.zoomRoot = n.id;
				}
				this.render();
			});
		}

		const numbered = !flat && this.inheritsFlag(n, "numbered");
		const bullet = row.createSpan({
			cls: numbered ? "trynalist-bullet is-numbered" : "trynalist-bullet",
		});
		// The dot is drawn, not typed. A "•" glyph sits above the middle of its
		// line box, so a ring centred on the 22px hit target was visibly off —
		// two circles sharing a bottom edge. Its own element fixes that.
		const dot = bullet.createSpan({ cls: "trynalist-bullet-dot" });
		if (numbered) dot.setText(`${ordinal}.`);
		// What the bullet turns into under the cursor, so hovering always says
		// what a click will do rather than going blank.
		const hoverIcon = bullet.createSpan({ cls: "trynalist-bullet-hover" });
		if (bulletZooms) {
			setIcon(hoverIcon, "zoom-in");
			bullet.setAttribute("aria-label", "Zoom in");
		} else if (collapsible) {
			setIcon(hoverIcon, n.collapsed ? "plus" : "minus");
			bullet.setAttribute("aria-label", n.collapsed ? "Expand" : "Collapse");
		} else {
			// Nothing under it to expand or collapse — say so, rather than
			// showing an empty square.
			setIcon(hoverIcon, "dot");
			hoverIcon.addClass("is-inert");
			bullet.setAttribute("aria-label", flat ? "Item" : "No sub-items");
		}
		if (!flat && n.collapsed && hasKids) bullet.addClass("has-hidden-children");
		if (collapsible) bullet.addClass("is-collapsible");
		bullet.addEventListener("click", (e) => {
			e.stopPropagation();
			// Default (Dynalist's): the bullet collapses. The preference swaps
			// it so the bullet zooms and the magnifier becomes +/-.
			if (!bulletZooms) {
				// A leaf has nothing to collapse, and in collapse mode the
				// bullet is NOT the zoom control — falling through to zoom made
				// the last bullet in a branch behave unlike every other one.
				if (!collapsible) return;
				void idx.setFlag(n.id, "collapsed", !n.collapsed).then(() => this.patch({ lists: [n.id] }));
				return;
			}
			this.pushNav();
			this.zoomRoot = n.id;
			this.render();
		});
		bullet.addEventListener("mouseenter", () => this.showTooltip(bullet, n));
		bullet.addEventListener("mouseleave", () => this.hideTooltip());
		bullet.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openItemMenu(e, n); });
		if (!flat) this.wireDrag(bullet, row, n);

		// Per-item checkbox, plus the legacy inherited flag so documents written
		// before the model changed keep their checkboxes.
		if (n.checkbox || n.checked || this.inheritsFlag(n, "checklist")) {
			const box = row.createEl("input", { type: "checkbox", cls: "trynalist-check" });
			box.checked = n.checked;
			box.addEventListener("change", () => void this.toggleCheck(n.id));
		}

		const text = row.createDiv({ cls: "trynalist-text" });
		text.contentEditable = "true";
		// A multi-row selection is a BLOCK selection, not a text edit, so no row
		// stays in raw-source mode — that mismatch is why the first Mod+A left
		// the focused row showing its markup.
		if (this.focusId === n.id && this.selection.size < 2) {
			text.setText(rowRawToDom(n.text));
			this.rawRowId = n.id;
		} else {
			this.renderRowText(text, n.text, n.id);
			text.dataset.rendered = "1";
		}
		this.wireTextEvents(text, n);

		this.wireRowDragSelect(row, n);
		// Shift+click extends a selection; Mod+click toggles one row.
		row.addEventListener("mousedown", (e) => {
			if (e.shiftKey) {
				// Shift+click INSIDE the row the caret is already in extends the
				// TEXT selection, which is what it does in every editor. Block-
				// selecting the whole item there made it impossible to select a
				// range across the lines of a multi-line item.
				const inSameRowText = this.focusId === n.id
					&& !this.selection.size
					&& (e.target as HTMLElement).closest(".trynalist-text");
				if (inSameRowText) return;   // let the browser do it
				e.preventDefault();
				this.selectRangeTo(n.id);
				this.repaintSelection();
			} else if (e.metaKey || e.ctrlKey) {
				e.preventDefault();
				if (this.selection.has(n.id)) this.selection.delete(n.id);
				else { this.selection.add(n.id); this.selectionAnchor = n.id; }
				this.repaintSelection();
			} else if (this.selection.size) {
				// Clear without re-rendering: tearing down the DOM inside
				// mousedown would swallow the click's caret placement.
				this.selection.clear();
				this.selectionAnchor = null;
				this.contentEl.findAll(".trynalist-row.is-selected")
					.forEach((r) => r.removeClass("is-selected"));
			}
		});

		const noteMode = this.effectiveNoteDisplay();
		if (n.note && noteMode !== "hidden") {
			const note = item.createDiv({
				cls: noteMode === "one-line" ? "trynalist-note is-one-line" : "trynalist-note",
			});
			if (this.focusId === n.id) {
				note.contentEditable = "true";
				note.setText(n.note);
			} else {
				// Notes are a block, not a line, so they get Obsidian's own
				// markdown renderer: fenced code with highlighting and its copy
				// button, tables, callouts, embeds — all of it, for free.
				this.renderNoteInto(note, n.note);
			}
			// Wired in BOTH branches: a note that started editable and was then
			// rendered read-only by its blur handler had no way back into editing
			// until something else re-rendered the document. The guard makes it a
			// no-op while the note is already raw.
			note.addEventListener("click", (e) => {
				if (note.dataset.rendered !== "1") return;
				// A click on a link, checkbox or copy button belongs to the
				// rendered content, not to "start editing".
				const target = e.target as HTMLElement;
				if (target.closest("a, button, input, .copy-code-button")) return;
				this.beginNoteEdit(note, n, e);
			});
			this.wireNoteEvents(note, n);
		}
	}

	// ── bullet tooltip (created / modified) ──────────────────────────────

	/** Timestamps on bullet hover, after a pause. Appearing instantly made the
	 *  tooltip flash across the screen while moving the mouse down a list, and
	 *  it sat BELOW the bullet, covering the very children you were reaching
	 *  for — so it opens above unless there is genuinely no room. */
	private tooltipTimer: number | null = null;

	private showTooltip(anchor: HTMLElement, n: TreeNode): void {
		this.hideTooltip();
		this.tooltipTimer = window.setTimeout(() => {
			this.tooltipTimer = null;
			if (!anchor.isConnected || !anchor.matches(":hover")) return;
			// In the anchor's own window: a view in a popout has its own body.
			const tip = anchor.doc.body.createDiv({ cls: "trynalist-tooltip" });
			// A two-column grid with the values right-aligned and monospaced, so
			// the two timestamps line up instead of drifting with label width.
			const grid = tip.createDiv({ cls: "trynalist-stamp-grid" });
			grid.createSpan({ cls: "trynalist-stamp-label", text: "Created" });
			grid.createSpan({ cls: "trynalist-stamp-value", text: fmtStamp(n.created) });
			grid.createSpan({ cls: "trynalist-stamp-label", text: "Modified" });
			grid.createSpan({ cls: "trynalist-stamp-value", text: fmtStamp(n.modified) });
			const r = anchor.getBoundingClientRect();
			const t = tip.getBoundingClientRect();
			tip.style.left = `${r.left}px`;
			// Above by default: below covers the item's own children.
			const above = r.top - t.height - 6;
			tip.style.top = above >= 8 ? `${above}px` : `${r.bottom + 6}px`;
			if (t.right > anchor.win.innerWidth - 8) {
				tip.style.left = `${Math.max(8, anchor.win.innerWidth - t.width - 8)}px`;
			}
			this.tooltipEl = tip;
		}, TOOLTIP_DELAY_MS);
	}

	private hideTooltip(): void {
		if (this.tooltipTimer) { window.clearTimeout(this.tooltipTimer); this.tooltipTimer = null; }
		this.tooltipEl?.remove();
		this.tooltipEl = null;
	}

	// ── per-item menu ────────────────────────────────────────────────────

	/** A row of choices inside a menu, so picking a heading or a colour is one
	 *  short movement rather than a submenu and a scan down a list. Obsidian's
	 *  Menu has no grid item, so the row is built into a disabled item's own
	 *  element — guarded, because that element is not part of the public API. */
	private addChoiceGrid(
		menu: Menu,
		label: string,
		choices: Array<{ key: string; title: string; cls?: string; label?: string }>,
		current: string,
		onPick: (key: string) => void,
	): boolean {
		let built = false;
		menu.addItem((item) => {
			const dom = (item as unknown as { dom?: HTMLElement }).dom;
			if (!dom) { item.setTitle(label); return; }
			dom.empty();
			dom.addClass("trynalist-menu-grid");
			dom.createSpan({ cls: "trynalist-menu-grid-label", text: label });
			const row = dom.createDiv({ cls: "trynalist-menu-grid-row" });
			for (const c of choices) {
				const btn = row.createSpan({
					cls: c.key === current
						? `trynalist-menu-choice is-current ${c.cls ?? ""}`
						: `trynalist-menu-choice ${c.cls ?? ""}`,
					text: c.title,
				});
				// The letter on a swatch is decorative — it previews the glyph, it
				// does not name the colour. Screen readers get the name instead,
				// which also fixes the swatches announcing nothing at all: their
				// title was an empty string before the letters existed.
				btn.setAttribute("aria-label", c.label ?? c.title);
				btn.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					onPick(c.key);
					menu.hide();
				});
			}
			built = true;
		});
		return built;
	}

	/** Add the collected entries to the menu in the user's order.
	 *
	 *  Ids the user has never seen — added by a later version — are appended
	 *  rather than dropped, so a saved order does not silently freeze the menu at
	 *  the shape it had when it was saved. */
	/** Whether this view has a document loaded — asked by the settings tab,
	 *  which needs a live document to read the menu's entries from. */
	hasIndex(): boolean { return !!this.index; }

	emitMenu(menu: Menu, parts: Array<{ id: string; add: () => void }>): void {
		const hidden = new Set(this.plugin.settings.itemMenuHidden ?? []);
		const saved = this.plugin.settings.itemMenuOrder ?? [];
		const byId = new Map<string, { id: string; add: () => void }>();
		for (const part of parts) byId.set(part.id, part);
		const ordered: Array<{ id: string; add: () => void }> = [];
		for (const id of saved) {
			const part = byId.get(id);
			if (part) { ordered.push(part); byId.delete(id); }
		}
		for (const part of parts) if (byId.has(part.id)) ordered.push(part);
		// Hiding an entry can strand the separator beside it. Drop separators that
		// would lead, trail, or double up — otherwise a customised menu grows gaps
		// where its removed entries used to be.
		const visible = ordered.filter((part) => !hidden.has(part.id));
		let lastWasSep = true;
		const final: Array<{ id: string; add: () => void }> = [];
		for (const part of visible) {
			const isSep = part.id.startsWith("sep");
			if (isSep && lastWasSep) continue;
			final.push(part);
			lastWasSep = isSep;
		}
		while (final.length && final[final.length - 1].id.startsWith("sep")) final.pop();
		for (const part of final) part.add();
	}

	/** Every entry the item menu can show, for the customiser. Built by running
	 *  the menu against a throwaway Menu so the list can never drift from what
	 *  the menu actually offers — a hand-kept copy would. */
	itemMenuCatalogue(): string[] {
		const idx = this.index;
		// Probe with an item that HAS children. Several entries — collapse, the
		// checkbox-children pair — only register for a parent, so probing the
		// first node in the document silently left them out of the customiser
		// and therefore un-hideable.
		const sample = idx
			? ([...idx.nodes.values()].find((n) => idx.children(n.id).length)
				?? [...idx.nodes.values()][0])
			: null;
		if (!sample) return [];
		const ids: string[] = [];
		const realEmit = this.emitMenu.bind(this);
		try {
			this.emitMenu = (_m, parts) => { for (const p of parts) ids.push(p.id); };
			// The choice grids attach to the real Menu object, and openItemMenu
			// shows it at the (synthetic, 0,0) event — a stray menu popped behind
			// the customiser. The flag suppresses the show while probing.
			this.probingMenu = true;
			this.openItemMenu(new MouseEvent("contextmenu"), sample);
		} finally {
			this.probingMenu = false;
			this.emitMenu = realEmit;
		}
		return ids;
	}

	private probingMenu = false;

	openItemMenu(e: MouseEvent, n: TreeNode): void {
		const idx = this.index;
		if (!idx) return;
		this.hideTooltip();
		const menu = new Menu();
		// Entries are COLLECTED here and added to the menu afterwards, in the
		// user's order. A menu built straight into `menu` is fixed in source order
		// by definition; collecting first is what makes it reorderable and
		// hideable from settings without touching any of the callbacks below.
		const parts: Array<{ id: string; add: () => void }> = [];
		const at = (id: string, cb: Parameters<Menu["addItem"]>[0]): void => {
			parts.push({ id, add: () => menu.addItem(cb) });
		};
		const atRaw = (id: string, add: () => void): void => { parts.push({ id, add }); };
		// Dynalist's grouping, in its order: the collapse family first, because
		// those are the ones you reach for while reading rather than editing.
		const collapsible = !!idx?.children(n.id).length;
		// One "Folding" submenu instead of five top-level entries. Thirty items
		// in a flat menu is a list you scan rather than read, and these five are
		// the ones you reach for least often per session — collapse all, expand
		// all, expand to level, collapse siblings. The one you DO use constantly
		// (collapse this item) stays at the top level.
		if (collapsible) {
			at("collapse", (i) => i.setTitle(n.collapsed ? "Expand" : "Collapse").setIcon("chevrons-down-up")
				.onClick(() => { this.focusId = n.id; void this.cmdToggleCollapse(); }));
		}
		at("folding", (i) => {
			i.setTitle("Folding").setIcon("fold-vertical");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			if (!sub) { i.onClick(() => void this.cmdCollapseAll(true)); return; }
			sub.addItem((s2) => s2.setTitle("Collapse all").setIcon("chevrons-down-up")
				.onClick(() => void this.cmdCollapseAll(true)));
			sub.addItem((s2) => s2.setTitle("Expand all").setIcon("chevrons-up-down")
				.onClick(() => void this.cmdCollapseAll(false)));
			sub.addItem((s2) => s2.setTitle("Collapse all siblings").setIcon("fold-vertical")
				.onClick(() => { this.focusId = n.id; void this.cmdCollapseSiblings(true); }));
			const deepest = this.deepestLevel();
			if (deepest > 1) {
				sub.addSeparator();
				for (let lvl = 1; lvl <= Math.min(deepest, 9); lvl++) {
					sub.addItem((s2) => s2.setTitle(`Expand to level ${lvl}`)
						.onClick(() => void this.cmdExpandToLevel(lvl)));
				}
			}
		});
		at("zoom-in", (i) => i.setTitle("Zoom in").setIcon("zoom-in").onClick(() => {
			this.pushNav(); this.zoomRoot = n.id; this.render();
		}));
		at("add-note", (i) => i.setTitle(n.note ? "Edit note" : "Add note").setIcon("notepad-text")
			.onClick(() => { this.focusId = n.id; this.focusNoteOfFocused(); }));
		at("indent", (i) => i.setTitle("Indent").setIcon("indent-increase")
			.onClick(() => { this.focusId = n.id; void this.cmdIndent(false); }));
		at("unindent", (i) => i.setTitle("Unindent").setIcon("indent-decrease")
			.onClick(() => { this.focusId = n.id; void this.cmdIndent(true); }));
		at("move-to", (i) => i.setTitle("Move to…").setIcon("arrow-right")
			.onClick(() => { this.focusId = n.id; this.openMoveTo(); }));
		at("bookmark", (i) => i.setTitle("Bookmark this item").setIcon("bookmark-plus").onClick(() => {
			this.pushNav();
			this.zoomRoot = n.id;
			this.render();
			this.bookmarkCurrentView();
		}));
		// Beside "Copy as mirror" because they answer the same question — how do
		// I point at this item from somewhere else — and differ only in where
		// that somewhere is: another document, or outside Obsidian entirely.
		at("deep-link", (i) => {
			i.setTitle("Copy a link").setIcon("link");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			const docPath = this.file?.path;
			if (!sub) { i.onClick(() => { if (docPath) void this.plugin.copyDeepLink(docPath, n.id); }); return; }
			sub.addItem((s2) => s2.setTitle("Deep link").setIcon("external-link")
				.onClick(() => { if (docPath) void this.plugin.copyDeepLink(docPath, n.id); }));
			sub.addItem((s2) => s2.setTitle("Deep link (zoomed in)").setIcon("zoom-in")
				.onClick(() => { if (docPath) void this.plugin.copyDeepLink(docPath, n.id, true); }));
			sub.addItem((s2) => s2.setTitle("Copy as mirror").setIcon("copy-plus")
				.onClick(() => {
					const ref = idx ? refTo(idx, n.id) : null;
					if (!ref) return;
					this.plugin.mirrorClipboard = { ref, label: n.text };
					new Notice(`Trynalist: "${n.text || "(empty)"}" held as a mirror source. Use "Paste mirror" (Copy a link menu or the command palette) where you want the window.`, 6000);
				}));
			// The other half of "Copy as mirror". Dropped when the item menu was
			// cut to 25 entries (0.63.0), which left no way to create a mirror.
			const held = this.plugin.mirrorClipboard;
			if (held) {
				sub.addItem((s2) => s2.setTitle(`Paste mirror of "${trim(held.label || "(empty)")}"`).setIcon("copy-plus")
					.onClick(() => { this.focusId = n.id; void this.pasteMirror("item"); }));
				sub.addItem((s2) => s2.setTitle(`Paste portal into "${trim(held.label || "(empty)")}"`).setIcon("panel-top")
					.onClick(() => { this.focusId = n.id; void this.pasteMirror("children"); }));
			}
		});
		at("copy", (i) => {
			i.setTitle("Copy").setIcon("clipboard-copy");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			const withSel = async (fn: () => Promise<void>) => {
				if (!this.selection.size) { this.setSelection(this.withDescendants([n.id])); this.render(); }
				await fn();
			};
			if (!sub) { i.onClick(() => void withSel(() => this.cmdCopyItems(false))); return; }
			sub.addItem((s2) => s2.setTitle("Copy (with children)").setIcon("clipboard-copy")
				.onClick(() => void withSel(() => this.cmdCopyItems(false))));
			sub.addItem((s2) => s2.setTitle("Cut (with children)").setIcon("scissors")
				.onClick(() => void withSel(() => this.cmdCopyItems(true))));
			sub.addItem((s2) => s2.setTitle("Copy with creation timestamps").setIcon("clock")
				.onClick(() => void withSel(() => this.cmdCopyItems(false, true))));
			sub.addSeparator();
			sub.addItem((s2) => s2.setTitle("Duplicate (with children)").setIcon("copy")
				.onClick(async () => {
					this.pushUndo();
					const newId = await idx.duplicateSubtree(n.id);
					this.focusId = newId;
					this.render();
				}));
		});
		at("date", (i) => i.setTitle(n.due ? "Edit date" : "Add date").setIcon("calendar")
			.onClick(() => {
				// Edit the exact `!(…)` occurrence in the line, if there is one.
				const existing = DATE_RE.exec(`${n.text} ${n.note}`)?.[0];
				this.focusId = n.id;
				this.openDatePicker(existing);
			}));
		at("check", (i) => i.setTitle(n.checked ? "Uncheck" : "Check off").setIcon("check").onClick(
			() => void this.toggleCheck(n.id),
		));
		at("checkbox", (i) => i
			.setTitle(n.checkbox ? "Remove checkbox" : "Add checkbox")
			.setIcon("square-check")
			.onClick(() => void this.cmdToggleCheckbox()));
		if (idx.children(n.id).length) {
			at("checkbox-children", (i) => i
				.setTitle("Add checkbox to children (all levels)")
				.setIcon("list-checks")
				.onClick(async () => {
					this.pushUndo();
					await idx.setCheckboxDeep(n.id, true);
					this.render();
					new Notice("Trynalist: added checkboxes to every item below this one.");
				}));
			at("uncheckbox-children", (i) => i
				.setTitle("Remove checkboxes from children")
				.setIcon("square")
				.onClick(async () => {
					this.pushUndo();
					await idx.setCheckboxDeep(n.id, false);
					if (n.checklist) await idx.setFlag(n.id, "checklist", false);
					this.render();
				}));
		}
		at("set-inbox", (i) => i.setTitle("Set as inbox").setIcon("inbox").onClick(async () => {
			// Dynalist kept this on the item menu for people who move their
			// inbox around; the setting alone was not enough.
			this.plugin.settings.inboxDocPath = this.file?.path ?? "";
			this.plugin.settings.inboxItemId = n.id;
			await this.plugin.saveSettings();
			new Notice(`Trynalist: captures will now land under "${n.text || "this item"}".`);
		}));
		at("numbered", (i) => i
			.setTitle(n.numbered ? "Remove numbering from children" : "Make children a numbered list")
			.setIcon("list-ordered")
			.onClick(async () => {
				this.pushUndo();
				await idx.setFlag(n.id, "numbered", !n.numbered);
				this.render();
			}));

		atRaw("sep27", () => menu.addSeparator());
		// Headings and colours as ROWS rather than submenus: both are pick-one
		// from a short fixed set, and a grid is one short movement instead of
		// opening a submenu and scanning down it.
		const headingChoices = [{ key: "0", title: "—" }];
		for (let h = 1; h <= MAX_HEADING; h++) headingChoices.push({ key: String(h), title: `H${h}` });
		const gridOk = this.addChoiceGrid(menu, "Heading", headingChoices, String(n.heading), (key) => {
			const lvl = parseInt(key, 10);
			this.pushUndo();
			void idx.setHeading(n.id, n.heading === lvl ? 0 : lvl).then(() => this.patch({ rows: [n.id] }));
		});
		const colourNames = ["None", "Red", "Orange", "Yellow", "Green", "Blue", "Purple"];
		this.addChoiceGrid(
			menu,
			"Colour",
			// A letter per swatch, Dynalist's idea: it shows what a glyph looks
			// like against the colour before you commit to it. Dynalist put the
			// same "A" on all six; A–F distinguishes them as well as previewing.
			colourNames.map((name, c) => ({
				key: String(c),
				title: c === 0 ? "—" : "ABCDEF"[c - 1],
				cls: `tl-swatch-${c}`,
				label: name,
			})),
			String(n.color),
			(key) => {
				const c = parseInt(key, 10);
				this.pushUndo();
				void idx.setColor(n.id, n.color === c ? 0 : c).then(() => this.patch({ rows: [n.id] }));
			},
		);
		if (!gridOk) {
			// The grid needs an internal element. Without it, fall back to the
			// plain cycling items rather than losing the actions entirely.
			at("cycle-heading", (i) => i.setTitle("Cycle heading").setIcon("heading").onClick(async () => {
				this.pushUndo();
				await idx.setHeading(n.id, (n.heading + 1) % (MAX_HEADING + 1));
				this.render();
			}));
			at("cycle-colour", (i) => i.setTitle("Cycle colour").setIcon("palette").onClick(async () => {
				this.pushUndo();
				await idx.setColor(n.id, (n.color + 1) % 7);
				this.render();
			}));
		}

		atRaw("sep30", () => menu.addSeparator());
		at("sort", (i) => {
			i.setTitle("Sort children").setIcon("arrow-up-down");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			// Dynalist's full set. Each direction is named for what you GET
			// ("oldest first"), not for the field it sorts on — "Created
			// (old to new)" makes you work out which end you land at.
			// Dynalist's wording, verbatim. Ours said the same things differently
			// ("Due soonest first"), which is fine in isolation but means someone
			// coming from Dynalist has to re-read every option to find the one
			// they already know.
			const modes: Array<[string, SortMode]> = [
				["Title (A to Z)", "alpha"], ["Title (Z to A)", "alpha-desc"],
				["Date (new to old)", "due-desc"], ["Date (old to new)", "due"],
				["Unchecked first", "checked-last"], ["Checked first", "checked-first"],
				["Edited (new to old)", "modified"], ["Edited (old to new)", "modified-asc"],
				["Created (new to old)", "created-desc"], ["Created (old to new)", "created"],
				["Reverse current", "reverse"],
			];
			const run = async (mode: typeof modes[number][1]) => {
				this.pushUndo();
				await idx.sortChildren(n.id, mode);
				this.render();
			};
			if (sub) {
				for (const [label, mode] of modes) sub.addItem((s) => s.setTitle(label).onClick(() => void run(mode)));
			} else {
				i.onClick(() => void run("alpha"));
			}
		});

		atRaw("sep32", () => menu.addSeparator());
		at("references", (i) => i.setTitle("Show all references").setIcon("git-fork")
			.onClick(() => void this.showReferences(n)));
		at("history", (i) => i.setTitle("Item history…").setIcon("history")
			.onClick(() => this.showHistory(n)));
		at("export", (i) => i.setTitle("Export…").setIcon("share")
			.onClick(() => { this.focusId = n.id; void this.exportFocused(); }));
		// Named but not built. An entry that silently does nothing is worse than
		// no entry, so each says so plainly rather than failing quietly.
		// Already built, and it scopes to the focused subtree — it just had no
		// menu entry, so it was reachable only from the command palette.
		at("replace", (i) => i.setTitle("Search and replace…").setIcon("replace")
			.onClick(() => { this.focusId = n.id; this.openReplace(); }));
		at("template", (i) => {
			const templates = this.plugin.settings.templates ?? [];
			i.setTitle("Insert template…").setIcon("file-plus-2");
			const sub = (i as unknown as { setSubmenu?: () => Menu }).setSubmenu?.();
			if (!sub) { i.onClick(() => void this.saveAsTemplate(n)); return; }
			for (const t of templates) {
				sub.addItem((s2) => s2.setTitle(t.name).setIcon("file-text")
					.onClick(() => void this.insertTemplate(t.outline, n)));
			}
			if (templates.length) sub.addSeparator();
			sub.addItem((s2) => s2.setTitle("Save this item as a template…").setIcon("save")
				.onClick(() => void this.saveAsTemplate(n)));
			if (templates.length) {
				sub.addItem((s2) => s2.setTitle("Manage templates…").setIcon("settings")
					.onClick(() => this.plugin.openTemplateManager()));
			}
		});

		atRaw("sep37", () => menu.addSeparator());
		// A way into the customiser from the thing being customised. Finding it
		// otherwise means knowing it exists and going to look in Settings.
		at("customise", (i) => i.setTitle("Customise this menu…").setIcon("settings")
			.onClick(() => {
				const catalogue = this.itemMenuCatalogue();
				new CustomiseMenuModal(this.app, this.plugin, catalogue, () => { /* rebuilt on next open */ }).open();
			}));
		at("delete-checked", (i) => i.setTitle("Delete checked items").setIcon("clipboard-x")
			.onClick(() => { this.focusId = n.id; void this.cmdDeleteChecked(n.id); }));
		at("delete", (i) => i.setTitle("Delete (with children)").setIcon("trash").onClick(async () => {
			// Every path that removes a mirror's source warns, not just bulk
			// delete (mirrors review finding 8).
			if (!await this.confirmMirrorImpact([n])) return;
			this.pushUndo();
			const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
			const at = vis.findIndex((v) => v.id === n.id);
			this.focusId = at > 0 ? vis[at - 1].id : null;
			const from = n.parent;
			const zoomMoved = this.leaveZoomIfDeleting([n.id]);
			await idx.deleteNode(n.id, { trashDir: this.trashDir() });
			if (zoomMoved) this.render(); else this.patch({ lists: [from] });
		}));
		this.emitMenu(menu, parts);
		if (!this.probingMenu) menu.showAtMouseEvent(e);
	}

	// ── drag and drop (mod+drag copies) ──────────────────────────────────

	/** Where a drop would land, resolved from the pointer position. */
	/** The landing candidates and their row elements, taken once per drag
	 *  (L84): the outline cannot change under a drag, so dragover no longer
	 *  rebuilds the visible list and re-scans every row on each mouse move. */
	private dragSnapshot(): { vis: TreeNode[]; rowEls: Map<string, HTMLElement> } | null {
		const idx = this.index;
		if (!idx || !this.dragId) return null;
		if (this.dragCache?.id === this.dragId) return this.dragCache;
		// The dragged subtree can't be a landing site for itself.
		const excluded = new Set<TrynaId>([this.dragId, ...idx.descendants(this.dragId).map((d) => d.id)]);
		const vis = idx
			.visible(this.zoomRoot, this.effectiveHideCompleted())
			.filter((n) => !excluded.has(n.id));
		const rowEls = new Map<string, HTMLElement>();
		for (const r of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".trynalist-row[data-id]"))) {
			const id = r.dataset.id;
			if (id && !rowEls.has(id)) rowEls.set(id, r);
		}
		// Only drawn rows can be landed on: a lazily drawn outline has rows the
		// model shows that have no element yet.
		this.dragCache = { id: this.dragId, vis: vis.filter((n) => rowEls.has(n.id)), rowEls };
		return this.dragCache;
	}

	private computeDrop(e: DragEvent): {
		parent: TrynaId | null;
		afterId: TrynaId | null;
		depth: number;
		y: number;
	} | null {
		const idx = this.index;
		if (!idx || !this.dragId) return null;
		const dragged = idx.nodes.get(this.dragId);
		if (!dragged) return null;
		const snap = this.dragSnapshot();
		if (!snap) return null;
		const { vis, rowEls } = snap;
		const rowRect = (id: TrynaId): DOMRect | null => {
			const el = rowEls.get(id);
			return el?.isConnected ? el.getBoundingClientRect() : null;
		};

		// Vertical position picks the gap between two visible rows: the first
		// row whose midline is below the pointer. Rows are in document order,
		// so a binary search reads ~log n rects instead of up to n. Rects are
		// read live, so scrolling during the drag is still honoured. A row with
		// no element (not rendered) falls back to the linear scan.
		const below = (i: number): boolean | null => {
			const r = rowRect(vis[i].id);
			return r ? e.clientY < r.top + r.height / 2 : null;
		};
		let insertIndex = vis.length;
		let lo = 0;
		let hi = vis.length;
		let linear = false;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const b = below(mid);
			if (b === null) { linear = true; break; }
			if (b) hi = mid; else lo = mid + 1;
		}
		if (!linear) insertIndex = lo;
		else {
			for (let i = 0; i < vis.length; i++) {
				if (below(i)) { insertIndex = i; break; }
			}
		}
		const prev = vis[insertIndex - 1] ?? null;
		const next = vis[insertIndex] ?? null;

		// Horizontal travel picks the depth, within what's structurally legal:
		// at most one level deeper than the row above, at least as deep as the
		// row below (otherwise that row would be orphaned).
		const baseDepth = this.zoomRoot ? (idx.nodes.get(this.zoomRoot)?.depth ?? -1) + 1 : 0;
		const maxDepth = prev ? prev.depth + 1 : baseDepth;
		const minDepth = Math.max(baseDepth, next ? next.depth : baseDepth);
		const shift = Math.round((e.clientX - this.dragStartX) / INDENT_PX);
		const depth = Math.min(maxDepth, Math.max(minDepth, dragged.depth + shift));

		let parent: TrynaId | null;
		let afterId: TrynaId | null;
		if (!prev) {
			parent = this.zoomRoot;
			afterId = null;
		} else if (depth > prev.depth) {
			parent = prev.id;      // first child of the row above
			afterId = null;
		} else {
			// Climb from the row above to the ancestor sitting at this depth;
			// the drop goes immediately after it.
			let anc: TreeNode = prev;
			const seen = new Set<TrynaId>();
			while (anc.depth > depth && anc.parent && !seen.has(anc.id)) {
				seen.add(anc.id);
				const p = idx.nodes.get(anc.parent);
				if (!p) break;
				anc = p;
			}
			parent = anc.parent;
			afterId = anc.id;
		}

		const nextRect = next ? rowRect(next.id) : null;
		const prevRect = prev ? rowRect(prev.id) : null;
		const y = nextRect ? nextRect.top : (prevRect ? prevRect.bottom : 0);
		return { parent, afterId, depth, y };
	}

	/** Horizontal line showing exactly where and at what depth it will land. */
	private showDropGuide(drop: { depth: number; y: number }): void {
		const host = this.contentEl;
		if (!this.dropGuideEl) {
			this.dropGuideEl = host.createDiv({ cls: "trynalist-drop-guide" });
			this.dropGuideEl.createDiv({ cls: "trynalist-drop-guide-knob" });
		}
		const hostRect = host.getBoundingClientRect();
		const baseDepth = this.zoomRoot
			? (this.index?.nodes.get(this.zoomRoot)?.depth ?? -1) + 1
			: 0;
		const listLeft = host.querySelector(".trynalist-list")?.getBoundingClientRect().left
			?? hostRect.left;
		this.dropGuideEl.style.top = `${drop.y - hostRect.top + host.scrollTop}px`;
		this.dropGuideEl.style.left =
			`${listLeft - hostRect.left + Math.max(0, drop.depth - baseDepth) * INDENT_PX}px`;
		this.dropGuideEl.toggleClass("is-copy", this.dragCopy);
	}

	private hideDropGuide(): void {
		this.dropGuideEl?.remove();
		this.dropGuideEl = null;
	}

	/** One delegated set of drag listeners for the whole outline, so the guide
	 *  can sit between rows rather than only over one of them. */
	private wireListDragTargets(host: HTMLElement): void {
		host.addEventListener("dragover", (e) => {
			if (!this.dragId) return;
			e.preventDefault();
			if (e.altKey || e.metaKey || e.ctrlKey) this.dragCopy = true;
			if (e.dataTransfer) e.dataTransfer.dropEffect = this.dragCopy ? "copy" : "move";
			const drop = this.computeDrop(e);
			if (drop) this.showDropGuide(drop);
		});
		host.addEventListener("drop", (e) => {
			if (!this.dragId) return;
			e.preventDefault();
			this.dragCache = null;   // the drop itself resolves against the live outline
			const drop = this.computeDrop(e);
			const copy = this.dragCopy;
			const sourceId = this.dragId;
			this.hideDropGuide();
			if (drop) void this.performDrop(sourceId, drop.parent, drop.afterId, copy);
		});
	}

	private wireDrag(handle: HTMLElement, row: HTMLElement, n: TreeNode): void {
		handle.draggable = true;
		handle.addEventListener("dragstart", (e) => {
			this.dragId = n.id;
			// Dragging a row that is part of a selection drags the whole
			// selection. Anything else silently discards the selection the user
			// just made and moves one row.
			this.dragGroup = this.selection.has(n.id) ? this.topLevelTargets().map((x) => x.id) : null;
			this.dragStartX = e.clientX;
			this.dragCache = null;
			// Decided at drag START: macOS does not reliably report Cmd during
			// the drag itself, so reading it only at drop lost the modifier.
			// A modifier pressed mid-drag still upgrades it (see dragover).
			this.dragCopy = e.altKey || e.metaKey || e.ctrlKey;
			this.hideTooltip();
			// Custom MIME only — a text/plain payload would be inserted verbatim
			// into whatever contenteditable row the drop lands on.
			e.dataTransfer?.setData(DRAG_MIME, n.id);
			if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
			row.addClass("is-dragging");
		});
		handle.addEventListener("dragend", () => {
			this.dragId = null;
			this.dragCache = null;
			this.dragGroup = null;
			this.dragCopy = false;
			this.hideDropGuide();
			this.contentEl.findAll(".trynalist-row").forEach((r) => r.removeClass("is-dragging"));
		});
	}

	private async performDrop(
		sourceId: TrynaId,
		parent: TrynaId | null,
		afterId: TrynaId | null,
		copy: boolean,
	): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// Everything that makes a drop impossible is checked BEFORE the undo
		// snapshot: a refused drop still pushed one and cleared the redo stack,
		// so Mod+Z then undid nothing and the redo history was gone (L12).
		const group = this.dragGroup;
		const moving = group && group.length > 1 ? group : [sourceId];
		if (parent && !idx.nodes.has(parent)) return;
		if (parent && idx.nodes.get(parent)?.mirrorOf) {
			new Notice("Trynalist: a mirror can't hold items of its own — add them to its source instead.");
			return;
		}
		if (!copy && parent) {
			const inside = new Set<TrynaId>();
			for (const id of moving) {
				inside.add(id);
				for (const d of idx.descendants(id)) inside.add(d.id);
			}
			if (inside.has(parent)) {
				new Notice(moving.length > 1 ? "Trynalist: those items cannot be moved inside themselves." : "Trynalist: can't move an item into itself.");
				return;
			}
		}
		await this.flushPendingSaves();
		this.pushUndo();

		// A multi-row drag: move each top-level target in order, threading the
		// insertion point so they land in the order they were in rather than
		// reversed.
		if (group && group.length > 1) {
			let after = afterId;
			let moved = 0;
			for (const id of group) {
				let movingOne = id;
				if (copy) {
					const dup = await idx.duplicateSubtree(id);
					if (!dup) continue;
					movingOne = dup;
				}
				if (await idx.move(movingOne, parent, after)) { after = movingOne; moved++; }
				else if (copy) await idx.deleteNode(movingOne);
			}
			if (parent) {
				const p = idx.nodes.get(parent);
				if (p?.collapsed) await idx.setFlag(parent, "collapsed", false);
			}
			this.render();
			new Notice(`Trynalist: ${copy ? "copied" : "moved"} ${moved} items.`);
			return;
		}

		let movingId = sourceId;
		if (copy) {
			const dup = await idx.duplicateSubtree(sourceId);
			if (!dup) return;
			movingId = dup;
		}
		const ok = await idx.move(movingId, parent, afterId);
		if (!ok && copy) await idx.deleteNode(movingId); // failed copy leaves no litter
		if (ok && parent) {
			const p = idx.nodes.get(parent);
			if (p?.collapsed) await idx.setFlag(parent, "collapsed", false);
		}
		this.focusId = movingId;
		this.render();
	}

	// ── focus / caret ────────────────────────────────────────────────────

	/** The element that actually scrolls. Obsidian gives a view a scroller
	 *  wrapper; contentEl itself is usually not the one with the overflow. */
	private scrollHost(): HTMLElement | null {
		const own = this.contentEl;
		if (own.scrollHeight > own.clientHeight + 1) return own;
		const parent = own.parentElement;
		if (parent && parent.scrollHeight > parent.clientHeight + 1) return parent;
		return own.closest<HTMLElement>(".view-content") ?? parent ?? own;
	}

	private restoreFocus(): void {
		if (!this.focusId) return;
		const find = (id: TrynaId) => this.contentEl.querySelector<HTMLElement>(
			`.trynalist-row[data-id="${cssId(id)}"] .trynalist-text`,
		);
		let row = find(this.focusId);
		// Not drawn yet: fill in the placeholders up to it.
		if (!row && this.inLazyRegion(this.focusId) && this.materializeTo(this.focusId)) row = find(this.focusId);
		if (!row) return;
		row.focus();
		const sel = this.contentEl.doc.getSelection();
		if (!sel) return;
		const range = this.contentEl.doc.createRange();
		// Walk the text nodes rather than assuming one. A row showing rendered
		// markdown (it is not raw while two or more rows are selected) is many
		// nodes, and an offset into the whole text is past the end of the first
		// one — setStart threw there.
		let placed = false;
		if (this.focusCaret >= 0) {
			let left = this.focusCaret;
			const walker = this.contentEl.doc.createTreeWalker(row, NodeFilter.SHOW_TEXT);
			for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
				if (left <= t.length) { range.setStart(t, left); range.collapse(true); placed = true; break; }
				left -= t.length;
			}
		}
		if (!placed) {
			range.selectNodeContents(row);
			range.collapse(false);
		}
		sel.removeAllRanges();
		sel.addRange(range);
		this.focusCaret = -1;
	}

	/** The visible order with an id→position map, reused between renders so
	 *  each arrow press is a map lookup rather than visible() plus findIndex
	 *  (L81). Every change to what is shown goes through render() or patch(),
	 *  which drop it; a lookup that finds a missing or replaced node rebuilds. */
	private visCache: { key: string; vis: TreeNode[]; pos: Map<TrynaId, number> } | null = null;

	private visibleOrder(idx: DocIndex): { vis: TreeNode[]; pos: Map<TrynaId, number> } {
		const hide = this.effectiveHideCompleted();
		const key = `${this.zoomRoot ?? ""}|${hide ? 1 : 0}`;
		if (this.visCache?.key === key) return this.visCache;
		const vis = idx.visible(this.zoomRoot, hide);
		const pos = new Map<TrynaId, number>();
		vis.forEach((v, i) => pos.set(v.id, i));
		this.visCache = { key, vis, pos };
		return this.visCache;
	}

	/** Caret offset within the row's text (0 when the row is empty). */
	private caretOffset(el: HTMLElement): number {
		const sel = this.contentEl.doc.getSelection();
		if (!sel || sel.rangeCount === 0) return 0;
		const range = sel.getRangeAt(0).cloneRange();
		range.selectNodeContents(el);
		range.setEnd(sel.getRangeAt(0).endContainer, sel.getRangeAt(0).endOffset);
		return range.toString().length;
	}

	/** Put the caret at a character offset in an editable. */
	private setCaret(el: HTMLElement, at: number): void {
		const sel = this.contentEl.doc.getSelection();
		if (!sel) return;
		const range = this.contentEl.doc.createRange();
		const node = el.firstChild;
		if (node?.instanceOf(Text)) {
			range.setStart(node, Math.max(0, Math.min(at, node.length)));
			range.collapse(true);
		} else {
			range.selectNodeContents(el);
			range.collapse(false);
		}
		sel.removeAllRanges();
		sel.addRange(range);
	}

	/** Character offset of a DOM position within an editable. */
	private offsetOf(el: HTMLElement, node: Node, offset: number): number {
		const range = this.contentEl.doc.createRange();
		range.selectNodeContents(el);
		range.setEnd(node, offset);
		return range.toString().length;
	}

	// ── editing ──────────────────────────────────────────────────────────

	/** Rows are contenteditable, so a native paste drops real DOM into them —
	 *  an <img> for a pasted image, styled markup for rich text. Neither
	 *  survives `innerText`, so the row saved as EMPTY and the image vanished
	 *  on the next keystroke. Everything is normalised to text here: files are
	 *  written into the vault and linked, rich text is flattened, and multi-line
	 *  text becomes sibling rows (Dynalist behaviour). */
	private wirePaste(el: HTMLElement, n: TreeNode, isNote: boolean): void {
		el.addEventListener("paste", (e) => {
			const idx = this.index;
			if (!idx) return;
			const dt = e.clipboardData;
			if (!dt) return;
			e.preventDefault();

			const files = Array.from(dt.files ?? []);
			if (files.length) { void this.pasteFiles(files, n, el, isNote); return; }

			const text = dt.getData("text/plain");
			if (!text) return;
			// Our own copy, still on the clipboard: paste it in full.
			const rich = isNote ? null : this.richPasteFor(text);
			if (rich) { void this.pasteRich(rich, n, el); return; }
			const lines = text.replace(/\r\n?/g, "\n").split("\n");
			if (isNote || lines.length === 1) {
				// A note keeps whatever was copied. An ITEM strips a leading list
				// marker: the row already draws its own bullet, so pasting "- foo"
				// put a second one in the text.
				const one = isNote
					? text
					: lines.join(" ").replace(/^[\t ]*(?:[-*+]\s+|\d+[.)]\s+)/, "");
				// Snapshot BEFORE the insert, then save straight after. A paste is
				// an edit worth undoing, but it went in through execCommand with
				// no snapshot at all — so Mod+Z skipped it and popped whatever
				// structural change came before, which is how a cut got undone
				// instead of the paste that followed it.
				this.pushUndo();
				this.contentEl.doc.execCommand("insertText", false, one);
				// Written through immediately so the snapshot and the model sit
				// either side of this edit; a queued save would land after undo
				// had already restored, and put the pasted text straight back.
				if (isNote) void this.saveNoteNow(el, n.id);
				else void this.saveRowNow(n.id, el);
				return;
			}
			void this.pasteMultiline(lines, n, el);
		});
	}

	/** Write pasted/dropped files into the vault and link them in the row. */
	private async pasteFiles(
		files: File[],
		n: TreeNode,
		el: HTMLElement,
		isNote: boolean,
	): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const links: string[] = [];
		for (const file of files) {
			try {
				const data = await file.arrayBuffer();
				// Beside the document rather than in the vault-wide attachment
				// folder, so attachments travel with it when it is moved,
				// exported or converted.
				const path = await this.attachmentPath(file.name || "pasted-image.png");
				const created = await this.app.vault.createBinary(path, data);
				// Built by Obsidian, in the user's link format, like every other
				// link Trynalist writes. The hand-written full path broke every
				// image as soon as the document was renamed or moved, and it is
				// not what Obsidian's rename-updater looks for (M32).
				const link = this.app.fileManager.generateMarkdownLink(created, n.file?.path ?? this.file?.path ?? "");
				links.push(link.startsWith("!") ? link : `!${link}`);
			} catch (err) {
				console.error("Trynalist: attachment paste failed", err);
				new Notice(`Trynalist: could not save "${file.name}".`);
			}
		}
		if (!links.length) return;
		// Not a live caret to insert at — the mobile toolbar's file picker took
		// focus away, or the row re-rendered meanwhile: execCommand then
		// inserted nowhere and the notice still said "added" (L17). Append the
		// links through the model instead.
		const live = el.isConnected && this.contentEl.doc.activeElement === el && el.dataset.rendered !== "1";
		if (!live) {
			const node = idx.nodes.get(n.id);
			if (!node) return;
			const join = (body: string): string => `${body}${body && !/\s$/.test(body) ? " " : ""}${links.join(" ")}`;
			if (isNote) await idx.setBody(n.id, node.text, join(node.note));
			else await idx.setBody(n.id, join(node.text), node.note);
			this.patch({ rows: [n.id] });
			new Notice(`Trynalist: added ${links.length} attachment${links.length === 1 ? "" : "s"}.`);
			return;
		}
		// Insert as text so it round-trips through the file body untouched —
		// with a space either side where the caret touches a word, or the
		// embed ran into the text ("target![[photo.png]]").
		const at = this.caretOffset(el);
		const around = el.innerText;
		const before = at > 0 && !/\s/.test(around[at - 1] ?? " ") ? " " : "";
		const after = at < around.length && !/\s/.test(around[at] ?? " ") ? " " : "";
		this.contentEl.doc.execCommand("insertText", false, `${before}${links.join(" ")}${after}`);
		if (isNote) {
			await idx.setBody(n.id, idx.nodes.get(n.id)?.text ?? "", el.innerText.replace(/\s+$/, ""));
		} else {
			await this.saveRowNow(n.id, el);
		}
		new Notice(`Trynalist: added ${links.length} attachment${links.length === 1 ? "" : "s"}.`);
	}

	/** A free path inside this document's own `_attachments` folder. */
	private async attachmentPath(name: string): Promise<string> {
		const idx = this.index;
		const base = idx ? `${idx.docRef.folder.path}/${ATTACHMENTS_SUBFOLDER}` : ATTACHMENTS_SUBFOLDER;
		if (!this.app.vault.getFolderByPath(base)) {
			await this.app.vault.createFolder(base).catch(() => { /* raced */ });
		}
		// The incoming name is whatever the pasting app or the OS chose: made
		// safe (no path separators or reserved characters, capped), with a
		// lower-case extension, before it becomes a vault path (L47).
		const dot = name.lastIndexOf(".");
		const rawExt = dot > 0 ? name.slice(dot + 1) : "";
		const extClean = /^[A-Za-z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : "";
		const stem = safeName(extClean ? name.slice(0, dot) : name, "pasted");
		const ext = extClean ? `.${extClean}` : "";
		let candidate = normalizePath(`${base}/${stem}${ext}`);
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${base}/${stem}-${n++}${ext}`);
		}
		return candidate;
	}

	/** Multi-line paste becomes one row per line, indentation preserved. */
	private async pasteMultiline(lines: string[], n: TreeNode, el: HTMLElement): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// In-item line breaks survive (same reason as the Enter split).
		const full = rowDomToRaw(el.innerText);
		const caret = Math.min(this.caretOffset(el), full.length);
		const head = full.slice(0, caret);
		const tail = full.slice(caret);
		// How wide one level is has to be decided ONCE for the whole paste, not
		// per line. Judging each line alone, "    " reads as level 1 under a
		// four-space convention while "  " reads as level 1 under a two-space
		// one — so a single two-space outline had its four-space line demoted to
		// match its two-space line, and everything below one level collapsed.
		const prefixOf = (line: string): string => /^[\t ]*/.exec(line)?.[0] ?? "";
		const usesTabs = lines.some((l) => prefixOf(l).includes("\t"));
		const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
		// The greatest common divisor of the indents present, so 2/4/6 gives a
		// unit of 2 and 4/8 gives 4 — each outline read on its own terms rather
		// than against a guess. A lone indent is its own unit; no indents at all
		// never divides.
		// Judged from ITEM lines only when the paste has list markers: note
		// lines under an item carry the note's own indentation on top, and an
		// odd one would drag the divisor down to 1.
		const itemLines = lines.some((l) => /^[\t ]*(?:[-*+]|\d+[.)])(?:\s|$)/.test(l))
			? lines.filter((l) => /^[\t ]*(?:[-*+]|\d+[.)])(?:\s|$)/.test(l))
			: lines;
		const unit = usesTabs
			? 1
			: itemLines.map((l) => prefixOf(l).length).filter((w) => w > 0).reduce(gcd, 0) || 1;
		const indentOf = (line: string): number => {
			const m = prefixOf(line);
			if (usesTabs) return m.split("\t").length - 1;
			return Math.floor(m.length / unit);
		};
		// A line that carries a list marker is an ITEM, even when its text is
		// empty — an empty row is a real row. Dropping those silently is what
		// made a four-row copy paste back as two.
		const MARKER = /^[\t ]*(?:[-*+]\s*|\d+[.)]\s*)/;
		// "[ ] " / "[x] " after a marker is a checkbox, which is how our own
		// copy (outlineForSelection) and markdown task lists write one. Left in
		// the text it pasted back as a literal "[x] " with no box.
		const TASK = /^\[([ xX])\]\s+/;
		const parsed = lines.map((l) => {
			const marked = MARKER.test(l);
			let text = l.replace(MARKER, "").replace(/^[\t ]+/, "").trim();
			const task = marked ? TASK.exec(text) : null;
			if (task) text = text.slice(task[0].length);
			return {
				indent: indentOf(l),
				lead: prefixOf(l).length,
				marked,
				text,
				checkbox: !!task,
				checked: !!task && task[1].toLowerCase() === "x",
				noteLines: [] as Array<{ line: string; lead: number }>,
				// The line as pasted, markers and all — the intermediate state
				// the first undo returns to.
				raw: l.replace(/^[\t ]+/, ""),
				line: l,
			};
		});
		// Notes: our copy writes an item's note as UNMARKED lines one level
		// deeper than the item. In an outline that has markers, such a line
		// (and a blank line between two of them) belongs to the item above as
		// note text, not as a child item. Plain unmarked text keeps the old
		// one-row-per-line behaviour.
		const anyMarked = parsed.some((p) => p.marked);
		const cleaned: typeof parsed = [];
		for (const p of parsed) {
			const owner = cleaned[cleaned.length - 1];
			if (anyMarked && owner?.marked && !p.marked && (p.text ? p.indent > owner.indent : owner.noteLines.length > 0 && p.lead > owner.lead)) {
				owner.noteLines.push({ line: p.line, lead: p.lead });
				continue;
			}
			if (!p.text.length && !p.marked) continue;
			cleaned.push(p);
		}
		// Strip the note's indent relative to its item: the smallest indent
		// among its non-blank lines, so a note's own deeper lines keep theirs.
		const noteOf = (p: typeof parsed[number]): string => {
			const leads = p.noteLines.filter((x) => x.line.trim()).map((x) => x.lead);
			const cut = leads.length ? Math.min(...leads) : 0;
			return p.noteLines.map((x) => (x.line.trim() ? x.line.slice(cut) : "")).join("\n").replace(/\s+$/, "");
		};
		if (!cleaned.length) return;

		this.cancelSave(n.id);
		// TWO undo steps, as asked: the first undo takes the markers back (the
		// integration), the second takes the paste itself back. pushUndo is
		// called once here for the paste, and again below once the rows exist
		// but before their markers are stripped.
		this.pushUndo();
		// First line merges into the row being pasted into.
		// Stage one writes the lines AS PASTED. Stage two strips the markers.
		const made: TrynaId[] = [];
		await idx.setBody(n.id, (head + cleaned[0].raw).trim(), idx.nodes.get(n.id)?.note ?? "");

		const baseIndent = cleaned[0].indent;
		// One "cursor" per depth so siblings chain correctly.
		const parentAt = new Map<number, { parent: TrynaId | null; after: TrynaId | null }>();
		parentAt.set(0, { parent: n.parent, after: n.id });
		let lastId = n.id;
		for (const line of cleaned.slice(1)) {
			const level = Math.max(0, line.indent - baseIndent);
			let slot = parentAt.get(level);
			if (!slot) {
				// Deeper than anything seen yet — nest under the previous row.
				slot = { parent: lastId, after: null };
				parentAt.set(level, slot);
			}
			const created = await idx.createNode(line.raw, slot.parent, slot.after);
			made.push(created.id);
			slot.after = created.id;
			lastId = created.id;
			// Anything deeper than this line is no longer a valid insertion point.
			for (const key of [...parentAt.keys()]) if (key > level) parentAt.delete(key);
			parentAt.set(level + 1, { parent: created.id, after: null });
		}
		if (tail.trim()) await idx.createNode(tail.trim(), idx.nodes.get(lastId)?.parent ?? n.parent, lastId);

		// Stage two, its own undo step: take the list markers off now that the
		// rows carry the structure. Undo once and the markers come back; undo
		// again and the paste is gone.
		this.pushUndo();
		const firstNote = noteOf(cleaned[0]);
		const ownNote = idx.nodes.get(n.id)?.note ?? "";
		await idx.setBody(n.id, (head + cleaned[0].text).trim(), firstNote ? (ownNote ? `${ownNote}\n${firstNote}` : firstNote) : ownNote);
		// The first line merges into the row being pasted into; its checkbox
		// only carries over when that row had no text of its own.
		const target = idx.nodes.get(n.id);
		if (target && cleaned[0].checkbox && !head.trim()) {
			target.checkbox = true;
			target.checked = cleaned[0].checked;
			await idx.writeNode(target);
		}
		made.forEach((id, i) => {
			const node = idx.nodes.get(id);
			const line = cleaned[i + 1];
			if (!node || !line) return;
			node.text = line.text;
			node.note = noteOf(line);
			if (line.checkbox) { node.checkbox = true; node.checked = line.checked; }
		});
		for (const id of made) await idx.writeNode(idx.nodes.get(id)!);

		this.focusId = lastId;
		this.render();
		new Notice(`Trynalist: pasted ${cleaned.length} lines. Undo once to keep the original markers.`, 6000);
	}

	/** Guarantee an element shows RAW source rather than rendered markup.
	 *  Called on focus AND on any interaction: relying on the focus event alone
	 *  left the "rendered" flag set in cases where focus never fired, and the
	 *  save guard then silently discarded every edit to that row. */
	private ensureRaw(el: HTMLElement, id: TrynaId, isNote: boolean): void {
		if (el.dataset.rendered !== "1") return;
		const live = this.index?.nodes.get(id);
		el.setText(isNote ? (live?.note ?? "") : rowRawToDom(live?.text ?? ""));
		delete el.dataset.rendered;
	}

	private wireTextEvents(el: HTMLElement, n: TreeNode): void {
		this.wirePaste(el, n, false);
		// Belt and braces: never let an internal row drag be handled as a
		// native text drop into the editable line.
		el.addEventListener("dragover", (e) => { if (this.dragId) e.preventDefault(); });
		el.addEventListener("drop", (e) => { if (this.dragId) e.preventDefault(); });
		el.addEventListener("input", () => {
			this.noteTypingBurst(n.id);
			this.scheduleSave(n.id);
			void this.maybeShowLinkSuggest(el);
		});
		el.addEventListener("focus", () => {
			this.focusId = n.id;
			this.rememberFocus();
			// Rendered links show their label, not the raw wikilink; swap to raw
			// before any editing so a save can never lose the target.
			this.ensureRaw(el, n.id, false);
		});
		el.addEventListener("beforeinput", () => this.ensureRaw(el, n.id, false));
		el.addEventListener("keydown", (e) => {
			// An IME (Japanese, Chinese, Korean…) is mid-conversion: Enter
			// confirms the conversion, Backspace edits it. None of it is ours —
			// handling it split the row on every kanji confirmation.
			if (isImeKey(e)) return;
			this.ensureRaw(el, n.id, false);
			// Clipboard chords are handled HERE, not as commands with default
			// hotkeys. A command that declines still leaves Obsidian's keymap in
			// the loop, and Mod+D is already claimed by core's
			// editor:delete-paragraph — so the reliable way to both act when we
			// should and leave the native copy alone when we should not is to
			// decide in a listener that simply does not preventDefault.
			if (this.handleClipboardChord(e)) return;
			// Pairing runs first, but only claims keys the outliner never binds.
			if (this.autoPair(e, el)) return;
			void this.onRowKey(e, n, el);
		});
		el.addEventListener("blur", () => {
			this.linkSuggest?.close();
			// Chromium fires blur synchronously as render() detaches the focused
			// row. Reading the row's text back at that moment is only right when
			// the text is the user's unsaved typing (a debounced save is pending);
			// otherwise the DOM is STALE — undo, search-and-replace, the date
			// picker and chip removal all change the model first and then render,
			// and the read-back wrote the old text straight over the new.
			if (this.rendering && !this.saveTimers.has(n.id)) return;
			void this.saveRowNow(n.id).then(() => {
				if (!el.isConnected || this.contentEl.doc.activeElement === el) return;
				const live = this.index?.nodes.get(n.id);
				if (!live) return;
				el.empty();
				this.renderRowText(el, live.text, n.id);
				el.dataset.rendered = "1";
			});
		});
	}

	/** Render note markdown through Obsidian, and mark it non-editable so a
	 *  save can never read the rendered DOM back as source. */
	/** Whether notes in `doc` render in full. A document shared with you
	 *  (imported with less than owner access) is someone else's markdown and
	 *  renders restricted unless you have marked it trusted (M52). */
	private notesTrusted(doc: DocRef | undefined = this.index?.docRef): boolean {
		const m = doc?.manifest;
		if (!m || m.trusted) return true;
		return !(typeof m.dlPermission === "number" && m.dlPermission < 4);
	}

	private renderNoteInto(el: HTMLElement, source: string, trusted = this.notesTrusted()): void {
		const markdown = trusted ? source : neutralizeMarkdown(source);
		el.toggleClass("is-restricted", !trusted);
		el.empty();
		el.contentEditable = "false";
		el.dataset.rendered = "1";
		// Owned by a child of the per-render host (see render()), not the view:
		// the view lives for hours, and everything a note render registers on
		// its owner is only released when that owner unloads. One child per
		// note element, so a partial repaint that drops this note (or a blur
		// that re-renders it) releases exactly what it registered.
		const host = this.noteHost ?? this;
		const prev = this.noteOwners.get(el);
		if (prev) { host.removeChild(prev); this.noteOwners.delete(el); }
		const sourcePath = this.file?.path ?? "";
		const key = `${sourcePath}\u0000${markdown}`;
		const cached = this.noteCache.get(key);
		if (cached) {
			// Most recently used goes to the back of the eviction order.
			this.noteCache.delete(key);
			this.noteCache.set(key, cached);
			for (const child of Array.from(cached.childNodes)) el.appendChild(child.cloneNode(true));
			return;
		}
		const owner = host.addChild(new Component());
		this.noteOwners.set(el, owner);
		void MarkdownRenderer.render(this.app, markdown, el, sourcePath, owner)
			.then(() => {
				this.tidyLists(el);
				this.dressCodeBlocks(el);
				// Still this render's output (not re-rendered or swapped to raw
				// for editing in the meantime)? Then keep a copy if it is plain.
				if (this.noteOwners.get(el) === owner && el.dataset.rendered === "1") this.cacheNote(key, el);
			});
	}

	/** Rendered notes, by source path and markdown, for notes that are plain
	 *  markup: re-parsing 600 notes through Obsidian's renderer was about a
	 *  quarter of a full render. Only output with nothing live in it is kept —
	 *  no code blocks (their copy buttons carry listeners), embeds, media,
	 *  math, callouts, form controls or other plugins' code-block output — so a
	 *  deep clone is exactly equivalent. Links inside work through the
	 *  delegated handler (wireNoteLinks), not per-element listeners. Cleared
	 *  whenever a file is created, deleted or renamed, since that can change
	 *  whether a link resolves. */
	private noteCache = new Map<string, HTMLElement>();

	private cacheNote(key: string, el: HTMLElement): void {
		if (el.querySelector(LIVE_NOTE_CONTENT)) return;
		const copy = createDiv();
		for (const child of Array.from(el.childNodes)) copy.appendChild(child.cloneNode(true));
		this.noteCache.set(key, copy);
		while (this.noteCache.size > NOTE_CACHE_MAX) {
			// `.next().value` on a Map iterator types as `any` under this lib
			// target even though it's a `string | undefined` at runtime (the key
			// type); the assertion just tells the checker what's already true.
			const oldest = this.noteCache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.noteCache.delete(oldest);
		}
	}

	/** Links in rendered notes. Obsidian's renderer draws `a.internal-link`,
	 *  `a.tag` and `a.external-link` but wires none of them outside its own
	 *  views, so a click on a link in a note did nothing at all. One delegated
	 *  listener routes them to the same actions as the links in item text. */
	private wireNoteLinks(root: HTMLElement): void {
		this.registerDomEvent(root, "click", (e: MouseEvent) => {
			const a = (e.target as HTMLElement | null)?.closest<HTMLAnchorElement>(".trynalist-note a");
			if (!a || !root.contains(a)) return;
			if (a.hasClass("internal-link")) {
				e.preventDefault();
				e.stopPropagation();
				const href = a.dataset.href ?? a.getAttribute("href") ?? "";
				const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(href), this.file?.path ?? "");
				if (dest) void this.followLink(dest.path);
				else new Notice(`Trynalist: "${href}" does not exist yet.`);
			} else if (a.hasClass("tag")) {
				e.preventDefault();
				e.stopPropagation();
				// With its `#`, as the tag chips in item text search for it.
				this.searchForTag(a.textContent ?? "");
			} else if (a.hasClass("external-link")) {
				e.preventDefault();
				e.stopPropagation();
				this.openExternal(a.getAttribute("href") ?? "");
			}
		});
	}

	/** Obsidian's renderer leaves the source's newlines as whitespace text
	 *  nodes BETWEEN <li> elements. Inside a block-level list each one gets its
	 *  own line box, so a two-item list measured 84px tall against 17px items —
	 *  the blank lines that no margin rule could remove, because they were not
	 *  margins. Drop them. */
	private tidyLists(host: HTMLElement): void {
		for (const list of Array.from(host.querySelectorAll("ul, ol"))) {
			for (const node of Array.from(list.childNodes)) {
				if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) node.remove();
			}
		}
	}

	/** Give each fenced block a header strip: language on the left, Obsidian's
	 *  own copy button on the right, both on one line. Obsidian floats the copy
	 *  button over the code and never names the language, so a block opened
	 *  with ```python said nothing about being Python. */
	private dressCodeBlocks(host: HTMLElement): void {
		for (const pre of Array.from(host.querySelectorAll("pre"))) {
			if (pre.hasClass("trynalist-dressed")) continue;
			const code = pre.querySelector("code");
			if (!code) continue;
			pre.addClass("trynalist-dressed");
			const lang = Array.from(code.classList)
				.find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
			const bar = createDiv({ cls: "trynalist-code-bar" });
			// Obsidian injects its copy button into the <pre>; move it into the
			// strip rather than drawing a second one that would not work.
			const existing = pre.querySelector<HTMLElement>(".copy-code-button");
			if (existing) {
				bar.appendChild(existing);
			} else {
				// A bare MarkdownRenderer.render() does not get Obsidian's copy
				// button — that is added by the reading view — so draw one.
				const copy = bar.createEl("button", { cls: "copy-code-button" });
				setIcon(copy, "copy");
				copy.setAttribute("aria-label", "Copy code");
				copy.addEventListener("click", (e) => {
					e.stopPropagation();
					void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
						setIcon(copy, "check");
						window.setTimeout(() => setIcon(copy, "copy"), 1200);
					});
				});
			}
			bar.createSpan({ cls: "trynalist-code-lang", text: lang || "text" });
			// Wrap the strip and the block together in a shrink-to-fit box, so
			// the header is as wide as the widest line of code rather than the
			// whole note — a copy button at the far edge of a wide pane is a
			// long way from the code it copies.
			const wrap = createDiv({ cls: "trynalist-code-wrap" });
			pre.parentElement?.insertBefore(wrap, pre);
			wrap.appendChild(bar);
			wrap.appendChild(pre);
			bar.addClass("is-attached");
		}
	}

	/** Swap a rendered note back to its raw source for editing. */
	private beginNoteEdit(el: HTMLElement, n: TreeNode, from?: MouseEvent): void {
		const live = this.index?.nodes.get(n.id);
		el.empty();
		el.contentEditable = "true";
		delete el.dataset.rendered;
		el.setText(live?.note ?? n.note);
		el.focus();
		const sel = this.contentEl.doc.getSelection();
		if (!sel) return;
		// Put the caret where the click landed. Swapping rendered markdown for
		// raw source rebuilds the element, and focus() on fresh content lands
		// at the very end — which is why clicking mid-note jumped to the
		// bottom. The click point is still geometrically valid against the raw
		// text, so hit-test it; only fall back to the end if that fails.
		if (from) {
			const at = caretRangeAt(from.clientX, from.clientY);
			if (at && el.contains(at.startContainer)) {
				sel.removeAllRanges();
				sel.addRange(at);
				return;
			}
		}
		if (!el.firstChild) return;
		const range = this.contentEl.doc.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	private wireNoteEvents(el: HTMLElement, n: TreeNode): void {
		this.wirePaste(el, n, true);
		// Notes save on blur rather than on a debounce, but the undo burst still
		// has to start at the first keystroke — otherwise a note's typing is not
		// undoable at all.
		el.addEventListener("input", () => {
			this.noteTypingBurst(n.id);
			this.dirtyNotes.set(n.id, el);
			this.scheduleNoteSave(n.id);
		});
		el.addEventListener("focus", () => this.ensureRaw(el, n.id, true));
		el.addEventListener("beforeinput", () => this.ensureRaw(el, n.id, true));
		el.addEventListener("keydown", (e) => {
			if (isImeKey(e)) return;   // see the row listener
			this.ensureRaw(el, n.id, true);
			if (this.autoPair(e, el)) return;
			// Shift+Enter got here from the item, so it goes back — the pair is
			// one toggle. Without this it fell through to the browser and
			// inserted a break, which is what made "switch back" add a line.
			if (e.key === "Enter" && e.shiftKey) {
				e.preventDefault();
				void this.saveNoteNow(el, n.id).then(() => {
					this.focusId = n.id;
					this.patch({ rows: [n.id] });
				});
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				void this.saveNoteNow(el, n.id).then(() => {
					this.focusId = n.id;
					this.patch({ rows: [n.id] });
				});
				return;
			}
			// Insert a real newline. Left to itself the browser wraps each line
			// in a <div>, and innerText reads those back as extra blank lines —
			// the phantom lines that appeared and then vanished on save.
			if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
				e.preventDefault();
				this.continueListOrNewline(el);
				return;
			}
			// A note is not a sealed box: Up from its FIRST line goes to the item
			// the note belongs to, and Down from its LAST line goes to the next
			// item. Without this the only way out is the mouse or Escape, which
			// is not how the rest of the outline moves. Dynalist parity.
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				const caret = this.caretOffset(el);
				const text = el.innerText;
				const onFirst = text.lastIndexOf("\n", caret - 1) === -1;
				const onLast = text.indexOf("\n", caret) === -1;
				if (e.key === "ArrowUp" && onFirst) {
					e.preventDefault();
					void this.saveNoteNow(el, n.id).then(() => {
						this.focusId = n.id;
						this.focusCaret = -1;          // end of the item's own text
						this.restoreFocus();
					});
					return;
				}
				if (e.key === "ArrowDown" && onLast) {
					e.preventDefault();
					void this.saveNoteNow(el, n.id).then(() => void this.focusItemAfter(n.id));
					return;
				}
			}
		});
		el.addEventListener("blur", () => {
			const idx = this.index;
			if (!idx) return;
			const live = idx.nodes.get(n.id);
			// A rendered note shows link labels and formatted text, not source.
			if (el.dataset.rendered === "1" || !live) return;
			// Same rule as the item row: while render() is detaching this note the
			// DOM is only worth reading if it holds unsaved typing. Otherwise it is
			// stale — undo and search-and-replace change the model first — and
			// writing it back would overwrite the change that just happened.
			if (this.rendering && !this.dirtyNotes.has(n.id)) return;
			// End-only trim: the note's first line may be indented (see load).
			const next = el.innerText.replace(/\s+$/, "");
			this.dirtyNotes.delete(n.id);
			// Paint first, save alongside. Waiting for setBody to resolve before
			// rendering is what made a note sit as raw text for seconds after
			// it lost focus.
			if (el.isConnected && this.contentEl.doc.activeElement !== el) this.renderNoteInto(el, next);
			if (next !== live.note) void idx.setBody(n.id, live.text, next);
		});
	}

	/** Notes typed into since their last save, with the element holding the
	 *  text. Notes save on blur, not on a timer, so this is how a render (or an
	 *  undo's flush) knows whether a note's DOM is newer than the model. */
	private dirtyNotes = new Map<TrynaId, HTMLElement>();

	/** Enter inside a note continues whatever list line the caret is on, the way
	 *  Obsidian's own editor does under `smartIndentList`: a bullet continues, an
	 *  empty item exits the list, ordered lists renumber, a task item continues
	 *  unchecked, and a blockquote continues. Anything else is a plain newline. */
	private continueListOrNewline(el: HTMLElement): void {
		const cfg = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
		const smart = cfg.getConfig?.("smartIndentList");
		if (smart === false) { this.insertPlainText(el, "\n"); return; }

		const caret = this.caretOffset(el);
		const text = el.innerText;
		const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
		const line = text.slice(lineStart, caret);
		const parsed = parseListLine(line);
		if (!parsed) { this.insertPlainText(el, "\n"); return; }

		if (!parsed.content) {
			// An empty item ends the list rather than adding another empty one.
			this.spliceText(el, lineStart, caret - lineStart, "");
			el.dispatchEvent(new Event("input", { bubbles: true }));
			return;
		}
		this.insertPlainText(el, `\n${parsed.next}`);
	}

	/** Characters that close what they open. */
	private static readonly PAIRS: Record<string, string> = {
		"(": ")", "[": "]", "{": "}", "<": ">",
		'"': '"', "'": "'", "`": "`",
		// Markdown emphasis wraps with the same character on both sides.
		"*": "*", "_": "_", "~": "~", "=": "=", "$": "$",
	};

	/** Auto-pairing, the way Obsidian's editor and VS Code do it:
	 *   - type an opener with text selected  → the selection is wrapped
	 *   - type an opener with nothing selected → the pair is inserted, caret inside
	 *   - type a closer that is already there → step over it instead of doubling
	 *   - backspace between an empty pair    → both characters go
	 *  Returns true when it handled the key. */
	private autoPair(e: KeyboardEvent, el: HTMLElement): boolean {
		if (!this.plugin.settings.autoPair) return false;
		if (e.metaKey || e.ctrlKey || e.altKey) return false;
		// Obsidian's own granular toggles are honoured on top of ours, so a user
		// configures pairing once for the whole app rather than twice. A missing
		// or unreadable key counts as ON — a plugin should never be less capable
		// than the editor one pane over. (Convention borrowed from Stashpad's
		// markdown-input-parity doc.)
		const cfg = this.app.vault as unknown as { getConfig?: (k: string) => unknown };
		const allowed = (key: string): boolean => {
			const value = cfg.getConfig?.(key);
			return value === undefined || value === null || value === true;
		};
		const MARKDOWN_MARKS = new Set(["*", "_", "~", "=", "`"]);
		if (MARKDOWN_MARKS.has(e.key) && !allowed("autoPairMarkdown")) return false;
		if (!MARKDOWN_MARKS.has(e.key) && e.key !== "Backspace" && !allowed("autoPairBrackets")) return false;
		// Only openers, closers and Backspace can do anything below. Checking
		// that BEFORE reading innerText keeps ordinary letters from forcing a
		// layout flush on every keystroke (L83).
		const open = TrynalistDocView.PAIRS[e.key];
		const closers = new Set(Object.values(TrynalistDocView.PAIRS));
		if (!open && !closers.has(e.key) && e.key !== "Backspace") return false;
		const sel = this.contentEl.doc.getSelection();
		if (!sel || !sel.rangeCount) return false;
		const range = sel.getRangeAt(0);
		if (!el.contains(range.commonAncestorContainer)) return false;

		const text = el.innerText;
		const caret = this.caretOffset(el);

		if (!range.collapsed) {
			// Wrapping is the whole point of pairing over a selection: it turns
			// "select a phrase, press *" into *the phrase* rather than replacing it.
			if (!open) return false;
			e.preventDefault();
			const chosen = sel.toString();
			const start = this.offsetOf(el, range.startContainer, range.startOffset);
			this.spliceText(el, start, chosen.length, `${e.key}${chosen}${open}`);
			// Leave the wrapped text selected so wrapping again nests cleanly.
			this.selectRangeIn(el, start + 1, chosen.length);
			el.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		}

		if (e.key === "Backspace") {
			const before = text[caret - 1];
			const after = text[caret];
			if (before && after && TrynalistDocView.PAIRS[before] === after) {
				e.preventDefault();
				this.spliceText(el, caret - 1, 2, "");
				el.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
			return false;
		}

		// Stepping over a closer we inserted ourselves — and eating a redundant
		// one. Typing `)` where a `)` already sits moves past it rather than
		// adding a second, which is what "eating redundant syntax" means: the
		// closer you typed and the one already there are the same closer.
		if (closers.has(e.key) && text[caret] === e.key && !open) {
			e.preventDefault();
			this.setCaret(el, caret + 1);
			return true;
		}
		if (!open) return false;
		// Symmetric marks meeting their own closer, BEFORE the boundary guard
		// below. That guard wants the next character to be whitespace or
		// punctuation, which `*` is not — so putting these after it made them
		// unreachable, and every emphasis mark typed against its own closer fell
		// through to a literal insert. That is the doubling this is here to stop.
		if (open === e.key && text[caret] === e.key) {
			let left = 0;
			while (text[caret - 1 - left] === e.key) left++;
			let right = 0;
			while (text[caret + right] === e.key) right++;
			// Equal runs alone are NOT enough to mean "opening". Walking out of
			// `**bold*|*` also sees 1 and 1 — but those two are the same CLOSING
			// pair, and growing there gave `**bold****`. What distinguishes them is
			// whether the left run starts a word: preceded by text, it is a closer.
			const beforeRun = text[caret - left - 1] ?? "";
			const opens = !beforeRun || /[\s([{<"'`]/.test(beforeRun);
			// Growing is only right for marks that MEAN something doubled: ** is
			// bold, ~~ strike, == highlight. A second quote or backtick is not a
			// different quote — typing " twice should leave you with "" and the
			// caret between them, not """" — so those step over instead.
			const GROWS = new Set(["*", "_", "~", "="]);
			if (left > 0 && left === right && opens && GROWS.has(e.key)) {
				// The caret sits inside a balanced run of its own mark, so this
				// keystroke is building emphasis rather than closing it: `*|*`
				// becomes `**|**`, and again `***|***`. Growing BOTH sides is what
				// keeps bold and bold-italic from needing the closer typed by hand.
				e.preventDefault();
				const grown = text.slice(0, caret) + e.key
					+ text.slice(caret, caret + right) + e.key + text.slice(caret + right);
				el.setText(grown);
				this.setCaret(el, caret + 1);
				el.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
			// Otherwise we are walking out of finished emphasis — `**bold|**` —
			// so step over the one that is already there instead of adding a second.
			e.preventDefault();
			this.setCaret(el, caret + 1);
			return true;
		}
		// A THIRD identical opener stays literal. Typing `[[[` should give you
		// three brackets, not `[[[]]]` — and `[[` is already a wikilink, so the
		// run is deliberate. (Convention borrowed from Stashpad's input parity
		// notes, where the same case came up.)
		const beforeCaret = text.slice(0, caret);
		if (beforeCaret.endsWith(e.key + e.key)) return false;
		// A quote or emphasis mark that is closing something rather than opening
		// it: `it's`, `2*3`. Only pair when the next character is a boundary.
		const next = text[caret] ?? "";
		if (next && !/[\s)\]}>.,;:!?]/.test(next)) return false;
		// Symmetric marks need the LEFT side checked as well, or an apostrophe
		// typed at the end of "its" pairs into "its''".
		if (open === e.key) {
			const prev = text[caret - 1] ?? "";
			if (prev && !/[\s([{<"'`*_~=$]/.test(prev)) return false;
		}
		e.preventDefault();
		this.spliceText(el, caret, 0, `${e.key}${open}`);
		this.setCaret(el, caret + 1);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}

	/** Replace the whole editable's text and put the caret back. Simple and
	 *  total, which is what keeps contenteditable from growing <div> soup. */
	private spliceText(el: HTMLElement, at: number, remove: number, insert: string): void {
		const text = el.innerText;
		const next = text.slice(0, at) + insert + text.slice(at + remove);
		el.setText(next);
		this.setCaret(el, at + insert.length);
	}

	/** Insert literal text at the caret without letting the browser build any
	 *  element structure around it. */
	private insertPlainText(el: HTMLElement, value: string): void {
		const caret = this.caretOffset(el);
		this.spliceText(el, caret, 0, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	}

	/** Select `length` characters starting at `start` (character offsets). */
	private selectRangeIn(el: HTMLElement, start: number, length: number): void {
		const node = el.firstChild;
		if (!node?.instanceOf(Text)) { this.setCaret(el, start + length); return; }
		const range = this.contentEl.doc.createRange();
		range.setStart(node, Math.min(start, node.length));
		range.setEnd(node, Math.min(start + length, node.length));
		const sel = this.contentEl.doc.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	/** Write a note's current text through, before a re-render throws the DOM away. */
	private async saveNoteNow(el: HTMLElement, id: TrynaId): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const live = idx.nodes.get(id);
		if (!live || el.dataset.rendered === "1") return;
		this.dirtyNotes.delete(id);
		const next = el.innerText.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
		if (next !== live.note) {
			await idx.setBody(id, live.text, next);
			if (live.file) this.queueMirrorRefresh([live.file.path], false);
		}
	}

	/** Notes used to save only on blur, so a note typed into and never left —
	 *  then Cmd+Q, or a phone that killed the backgrounded app — lived only in
	 *  the DOM (M37). Now they also save after a pause, like rows. The element
	 *  is looked up in dirtyNotes when the timer fires, not captured. */
	private noteTimers = new Map<TrynaId, number>();
	private scheduleNoteSave(id: TrynaId): void {
		const prev = this.noteTimers.get(id);
		if (prev) window.clearTimeout(prev);
		this.noteTimers.set(id, window.setTimeout(() => {
			this.noteTimers.delete(id);
			const el = this.dirtyNotes.get(id);
			if (el?.isConnected && el.dataset.rendered !== "1") void this.saveNoteNow(el, id);
		}, 1500));
	}

	/** Debounced save. Deliberately does NOT capture the element: after a
	 *  re-render the captured node is detached and still holds pre-edit text,
	 *  so firing against it would clobber a split/merge that just happened. */
	private scheduleSave(id: TrynaId): void {
		const prev = this.saveTimers.get(id);
		if (prev) window.clearTimeout(prev);
		this.saveTimers.set(id, window.setTimeout(() => {
			this.saveTimers.delete(id);
			void this.saveRowNow(id);
		}, 600));
	}

	/** Drop a pending save without running it — used when the caller has
	 *  already taken the row's text and is about to rewrite it. */
	private cancelSave(id: TrynaId): void {
		const timer = this.saveTimers.get(id);
		if (timer) window.clearTimeout(timer);
		this.saveTimers.delete(id);
	}

	/** Remember the focused item per document, so reopening lands where you
	 *  left rather than at the top. Navigating back and forth already restored
	 *  it; a fresh open did not. */
	private rememberFocus(): void {
		const key = this.file?.path;
		if (!key || !this.focusId) return;
		if (this.plugin.settings.lastFocus[key] === this.focusId) return;
		this.plugin.settings.lastFocus[key] = this.focusId;
		// Coalesced: this fires on every focus change, so holding Arrow Down
		// rewrote data.json once per row.
		this.plugin.saveSettingsSoon();
	}

	private async saveRowNow(id: TrynaId, el?: HTMLElement): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const timer = this.saveTimers.get(id);
		if (timer) { window.clearTimeout(timer); this.saveTimers.delete(id); }
		const node = idx.nodes.get(id);
		if (!node) return;
		// A detached element is stale (the row was re-rendered) — always prefer
		// the live DOM, and skip entirely if the row is gone.
		const dom = (el?.isConnected ? el : null) ?? this.contentEl.querySelector<HTMLElement>(
			`.trynalist-row[data-id="${cssId(id)}"] .trynalist-text`,
		);
		if (!dom) return;
		// A rendered row shows link LABELS; saving from it would replace the
		// wikilink with its label and lose the target.
		if (dom.dataset.rendered === "1") return;
		// Line breaks inside an item are deliberate (Alt+Enter), so they
		// survive the save — INCLUDING a trailing one, which is exactly the
		// state right after Alt+Enter at the end of an item. The old .trim()
		// here stripped it, which made that chord silently self-revert: the
		// blur save fired mid-insert and wrote the trimmed text back over the
		// break. Only spaces/tabs are trimmed from the ends now.
		const text = rowDomToRaw(dom.innerText)
			.replace(/\n{3,}/g, "\n\n")
			.replace(/^[ \t]+|[ \t]+$/g, "");
		if (text !== node.text) {
			await idx.setBody(id, text, node.note);
			if (node.file) this.queueMirrorRefresh([node.file.path], false);
		}
	}

	private async onRowKey(e: KeyboardEvent, n: TreeNode, el: HTMLElement): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// The [[ link popover owns arrows/Enter/Escape while it is open.
		if (this.linkSuggest?.isOpen && this.linkSuggest.handleKey(e)) {
			e.preventDefault();
			return;
		}
		const mod = e.metaKey || e.ctrlKey;

		// The zoomed-into item is drawn as an editable head row, but it is not in
		// visible() and its siblings are OUTSIDE the zoom. Structural keys that
		// reach for those siblings — a new sibling on Enter, outdent on Tab or
		// Backspace, reorder on Alt+Arrow — would act somewhere the user cannot
		// see. Enter makes the first child instead; the rest do nothing here.
		if (this.zoomRoot && n.id === this.zoomRoot) {
			if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
				e.preventDefault();
				await this.saveRowNow(n.id, el);
				this.pushUndo();
				const created = await idx.createNode("", n.id, null);
				if (n.collapsed) await idx.setFlag(n.id, "collapsed", false);
				this.focusId = created.id;
				this.focusCaret = 0;
				this.patch({ lists: [n.id] });
				return;
			}
			if (e.key === "Tab" || ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey)) {
				e.preventDefault();
				return;
			}
			if (e.key === "Backspace" && this.caretOffset(el) === 0) return;   // the browser handles it
		}

		// ── multi-select bindings take precedence ──
		if (e.key === "Escape" && this.selection.size) {
			e.preventDefault();
			this.clearSelection();
			return;
		}
		if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && !e.altKey) {
			const up = e.key === "ArrowUp";
			// Three widening phases, so a multi-line item is selected line by
			// line before node selection starts:
			//   1. text phase — inside the item, the browser's own Shift+Arrow
			//      grows the text selection a line at a time;
			//   2. the item as a block, once the text selection has hit the
			//      item's edge in the travel direction;
			//   3. node mode — each further press adds the next item.
			// Jumping straight to phase 3 is what made Shift+Up leap to the row
			// above with the current row's lines never individually selectable.
			if (!this.selection.size) {
				const sel = this.contentEl.doc.getSelection();
				const text = rowDomToRaw(el.innerText);
				let focusAt: number | null = null;
				if (sel && sel.rangeCount && sel.focusNode && el.contains(sel.focusNode)) {
					focusAt = Math.min(this.offsetOf(el, sel.focusNode, sel.focusOffset), text.length);
				}
				// Room left to travel inside the item? Let the browser extend
				// the native selection — no preventDefault, no render.
				if (focusAt !== null && (up ? focusAt > 0 : focusAt < text.length)) return;
				// Edge reached: the item becomes a block selection.
				e.preventDefault();
				await this.saveRowNow(n.id, el);
				this.selectionAnchor = n.id;
				this.setSelection(this.withDescendants([n.id]));
				this.contentEl.doc.getSelection()?.removeAllRanges();
				this.focusId = n.id;
				this.repaintSelection();
				return;
			}
			// Node mode: extend the block selection one item per press.
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
			const i = vis.findIndex((v) => v.id === n.id);
			const next = vis[up ? i - 1 : i + 1];
			if (!next) {
				// Already at the edge. Make sure the edge row is itself selected
				// rather than silently doing nothing — reported as "can't select
				// the topmost/bottommost node".
				if (!this.selection.has(n.id)) {
					this.selectRangeTo(n.id);
					this.repaintSelection();
				}
				return;
			}
			this.selectRangeTo(next.id);
			this.focusId = next.id;
			this.repaintSelection();
			return;
		}
		// An arrow WITHOUT shift collapses the selection and moves the caret,
		// which is what makes Shift+Arrow feel like a selection rather than a
		// mode you have to press Escape to leave.
		if (this.selection.size && !e.shiftKey && !mod && !e.altKey
			&& (e.key === "ArrowUp" || e.key === "ArrowDown"
				|| e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			this.clearSelection();
			// Fall through: the caret move itself is the browser's job.
		}
		if (this.selection.size > 1) {
			// Bulk equivalents of the single-row bindings.
			if (e.key === "Tab") {
				e.preventDefault();
				await this.bulkIndent(e.shiftKey);
				return;
			}
			if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
				e.preventDefault();
				await this.bulkMove(e.key === "ArrowUp");
				return;
			}
			if (mod && e.key === "Enter") {
				e.preventDefault();
				await this.bulkToggleCheck();
				return;
			}
			if (e.key === "Backspace" || e.key === "Delete") {
				e.preventDefault();
				await this.bulkDelete();
				return;
			}
		}

		if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey
			&& this.plugin.settings.enterOnEmptyOutdents
			// A direct child of the zoomed item is at the zoom's top level:
			// outdenting it would move it beside the zoom root, out of view.
			&& n.parent && n.parent !== this.zoomRoot && !rowDomToRaw(el.innerText).trim()) {
			// Enter on an EMPTY indented item walks it out a level rather than
			// making another empty sibling — how you climb back out of a list.
			e.preventDefault();
			const parent = idx.nodes.get(n.parent);
			if (!parent) return;
			this.pushUndo();
			if (await idx.move(n.id, parent.parent, parent.id)) {
				this.focusId = n.id;
				this.focusCaret = 0;
				this.patchMoved([n.id], [parent.id]);
			}
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
			// Dynalist parity: splits the line at the caret. Alt is excluded
			// because Alt+Enter is the in-item line break, and this branch was
			// swallowing it before it could get there.
			e.preventDefault();
			// Keep in-item line breaks (Alt+Enter, imported ones): the old
			// .replace(/\n/g, " ") flattened every one of them into a space on
			// BOTH halves. trim() only touches the ends, so a break right at
			// the split point is consumed by the split, as it should be.
			const full = rowDomToRaw(el.innerText);
			const caret = Math.min(this.caretOffset(el), full.length);
			const before = full.slice(0, caret).trim();
			const after = full.slice(caret).trim();
			// Caret at the very start of a row with text: Dynalist opens an
			// empty item ABOVE and leaves this one alone. Splitting here instead
			// moved the text to a new plain row and left the note, checkbox,
			// colour, heading, children and dlId on an emptied row.
			if (caret === 0 && after) {
				await this.saveRowNow(n.id, el);
				this.pushUndo();
				const sibs = idx.children(n.parent);
				const i = sibs.findIndex((s) => s.id === n.id);
				await idx.createNode("", n.parent, i > 0 ? sibs[i - 1].id : null);
				this.focusId = n.id;
				this.focusCaret = 0;
				this.patch({ lists: [n.parent] });
				return;
			}
			// We have the live text in hand; a queued save would only race us.
			this.cancelSave(n.id);
			this.pushUndo();
			// Put the truncated text into the DOM BEFORE anything re-renders.
			// render() detaches this row, which fires blur, which saves from the
			// DOM — and that read would otherwise still hold the full pre-split
			// text and write it straight back, leaving the split half duplicated
			// on both rows. Identical to the Alt+Enter clobber.
			el.setText(before);
			await idx.setBody(n.id, before, idx.nodes.get(n.id)?.note ?? "");
			// Outliner convention: with visible children, the new row lands as
			// the FIRST child (a sibling would jump below the whole subtree).
			// Otherwise it's the next sibling. [verify against screenshots]
			const hasOpenKids = !n.collapsed && idx.children(n.id).length > 0;
			const created = hasOpenKids
				? await idx.createNode(after, n.id, null)
				: await idx.createNode(after, n.parent, n.id);
			this.focusId = created.id;
			this.focusCaret = 0;
			this.patch({ rows: [n.id], lists: [created.parent] });
		} else if (e.key === "Enter" && (e.altKey || (mod && e.shiftKey))) {
			// Normally handled by the Scope registration above; kept as a
			// fallback for any path that does reach the row listener.
			e.preventDefault();
			await this.insertLineBreak(n, el);
		} else if (e.key === "Enter" && mod) {
			e.preventDefault();
			await this.toggleCheck(n.id);
		} else if (e.key === "Tab") {
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			const caret = this.caretOffset(el);
			const sibs = idx.children(n.parent);
			const i = sibs.findIndex((s) => s.id === n.id);
			// Check preconditions BEFORE snapshotting — pushUndo clears the redo
			// stack, so a no-op Tab must not touch the history.
			if (e.shiftKey) {
				const parent = n.parent ? idx.nodes.get(n.parent) : null;
				// Top level of the document or of a zoom: nowhere to outdent to
				// that the user can see.
				if (!parent || parent.id === this.zoomRoot) return;
				this.pushUndo();
				if (await idx.move(n.id, parent.parent, parent.id)) {
					this.focusId = n.id; this.focusCaret = caret; this.patchMoved([n.id], [parent.id]);
				}
			} else {
				if (i <= 0) return;
				this.pushUndo();
				const newParent = sibs[i - 1];
				const lastChild = idx.children(newParent.id).at(-1)?.id ?? null;
				const from = n.parent;
				if (await idx.move(n.id, newParent.id, lastChild)) {
					if (newParent.collapsed) await idx.setFlag(newParent.id, "collapsed", false);
					this.focusId = n.id; this.focusCaret = caret; this.patchMoved([n.id], [from]);
				}
			}
		} else if (e.key === "Backspace" && this.caretOffset(el) === 0) {
			// Merge into the previous visible row (Dynalist parity). Only when
			// the caret sits at the very start and nothing is selected.
			const sel = this.contentEl.doc.getSelection();
			if (sel && !sel.isCollapsed) return;
			// An INDENTED item outdents first, as in Dynalist — losing a level is
			// what people expect from Backspace-at-start, and it takes a
			// destructive merge off the fast path. Empty rows included: hitting
			// Enter then Backspace should walk the new row back out a level, not
			// delete it. Once it reaches the top level, the next Backspace
			// merges/deletes as before. A direct child of the zoomed item counts
			// as top level here — outdenting it would move it out of view.
			if (n.parent && n.parent !== this.zoomRoot) {
				e.preventDefault();
				await this.saveRowNow(n.id, el);
				const parent = idx.nodes.get(n.parent);
				if (parent) {
					this.pushUndo();
					if (await idx.move(n.id, parent.parent, parent.id)) {
						this.focusId = n.id;
						this.focusCaret = 0;
						this.patchMoved([n.id], [parent.id]);
					}
				}
				return;
			}
			const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
			const i = vis.findIndex((v) => v.id === n.id);
			if (i <= 0) return; // first row — let the browser handle it
			const prev = vis[i - 1];
			// Don't swallow a row into a collapsed parent's hidden subtree, or
			// into a mirror, which never draws text or children of its own.
			if (prev.collapsed && idx.children(prev.id).length) return;
			if (prev.mirrorOf || n.mirrorOf) return;
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			// The merged row's id goes (its children keep theirs), so a mirror of
			// it would break — say so first (finding 8).
			if (!await this.confirmMirrorImpact([n], { subtree: false })) return;
			this.pushUndo();
			const from = n.parent;
			const caret = await idx.mergeIntoPrevious(n.id, prev.id);
			this.focusId = prev.id;
			this.focusCaret = caret;
			// The merged row's children now belong to `prev`, which is drawn with
			// a new note and text; its own list gains them.
			this.patch({ rows: [prev.id], lists: [from, prev.id] });
		} else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey) {
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			const caret = this.caretOffset(el);
			const sibs = idx.children(n.parent);
			const i = sibs.findIndex((s) => s.id === n.id);
			const target = e.key === "ArrowUp" ? i - 1 : i + 1;
			if (target < 0 || target >= sibs.length) return;
			const after = e.key === "ArrowUp"
				? (target - 1 >= 0 ? sibs[target - 1].id : null)
				: sibs[target].id;
			this.pushUndo();
			if (await idx.move(n.id, n.parent, after)) {
				this.focusId = n.id; this.focusCaret = caret; this.patch({ lists: [n.parent] });
			}
		} else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			let order = this.visibleOrder(idx);
			let i = order.pos.get(n.id) ?? -1;
			if (i === -1 || order.vis[i] !== idx.nodes.get(n.id)) {
				this.visCache = null;
				order = this.visibleOrder(idx);
				i = order.pos.get(n.id) ?? -1;
			}
			const vis = order.vis;
			// A mirror's row has no editable text to put the caret in: stepping
			// onto it left focus where it was while focusId moved, so the arrows
			// stuck and line commands hit the mirror (finding 4). Step over it.
			const step = e.key === "ArrowUp" ? -1 : 1;
			let j = i + step;
			while (vis[j]?.mirrorOf) j += step;
			let next = vis[j];
			if (next && idx.nodes.get(next.id) !== next) {
				// Cache outlived a change that bypassed render/patch: rebuild once.
				this.visCache = null;
				const fresh = this.visibleOrder(idx);
				let k = (fresh.pos.get(n.id) ?? -1) + step;
				while (fresh.vis[k]?.mirrorOf) k += step;
				next = fresh.vis[k];
			}
			if (next) { this.focusId = next.id; this.restoreFocus(); }
		} else if (e.key === "Enter" && e.shiftKey) {
			e.preventDefault();
			await this.saveRowNow(n.id, el);
			this.renderAndFocusNote(n.id);
		}
	}

	/** Shift+Enter: ensure a note field exists under the row and focus it. */
	private renderAndFocusNote(id: TrynaId): void {
		const idx = this.index;
		if (!idx) return;
		const live = idx.nodes.get(id);
		if (live && !live.note) live.note = "";
		this.patch({ rows: [id] });
		const row = this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"]`);
		// The item's OWN note only: a plain descendant query also finds the
		// notes inside `.trynalist-children`, so Shift+Enter on a note-less
		// parent put the caret in its first child's note (M38).
		let note = row?.parentElement?.querySelector<HTMLElement>(":scope > .trynalist-note") ?? null;
		if (!note && row?.parentElement) {
			note = row.parentElement.createDiv({ cls: "trynalist-note" });
			note.contentEditable = "true";
			// Notes set to Hide render no note element, so this fresh editor is
			// what the user edits. Seed it with the real note: left empty, its
			// blur handler wrote "" over the note on disk.
			note.setText(live?.note ?? "");
			if (live) this.wireNoteEvents(note, live);
			row.insertAdjacentElement("afterend", note);
		}
		note?.focus();
	}

	/** Mod+Enter cycles three states rather than two:
	 *
	 *    no checkbox → completed → unchecked → no checkbox
	 *
	 *  The first press still checks the item off, so the common case is
	 *  unchanged; the new rung is the one that was missing — an item that HAS a
	 *  checkbox and is not ticked. Reaching that previously meant adding a
	 *  checkbox from the menu and then not using it. */
	async cycleCheckState(id: TrynaId): Promise<void> {
		const idx = this.index;
		const n = idx?.nodes.get(id);
		if (!idx || !n) return;
		if (!n.checkbox && !n.checked) {
			// Straight to completed, via toggleCheck so a recurring item still rolls
			// forward instead of merely being ticked. The snapshot is taken HERE,
			// before the checkbox is added — toggleCheck's own snapshot would land
			// after it, and Undo then left a checkbox behind.
			this.pushUndo();
			await idx.setCheckbox(id, true);
			await this.toggleCheck(id, { snapshot: false });
			return;
		}
		this.pushUndo();
		if (n.checked) {
			await idx.toggleChecked(id);              // completed → unchecked
			if (!n.checkbox) await idx.setCheckbox(id, true);
		} else {
			await idx.setCheckbox(id, false);          // unchecked → no checkbox
		}
		this.patchChecked([id]);
	}

	/** Move to the item below `id`, creating one if this is the last. Used by
	 *  Down from a note's last line, where stopping dead is the wrong answer —
	 *  the same key one row up would have carried on. */
	private async focusItemAfter(id: TrynaId): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
		const at = vis.findIndex((x) => x.id === id);
		let k = at + 1;
		while (at >= 0 && vis[k]?.mirrorOf) k++;   // no caret on a mirror row
		const next = at >= 0 ? vis[k] ?? null : null;
		if (next) {
			this.focusId = next.id;
			this.focusCaret = 0;
			this.restoreFocus();
			return;
		}
		const n = idx.nodes.get(id);
		if (!n) return;
		this.pushUndo();
		const created = await idx.createNode("", n.parent, n.id);
		this.focusId = created.id;
		this.focusCaret = 0;
		this.patch({ lists: [n.parent] });
	}

	/** Open the image viewer, with every image in THIS document as its rail.
	 *  Images in an outline are usually a set, so the useful context is the
	 *  document rather than the whole vault. */
	openImageViewer(file: TFile): void {
		const idx = this.index;
		const seen = new Set<string>();
		const images: TFile[] = [];
		const EMBED = /!\[\[([^[\]|]+)(?:\|[^[\]]+)?\]\]/g;
		const IMG = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
		for (const n of idx?.nodes.values() ?? []) {
			for (const m of `${n.text} ${n.note}`.matchAll(EMBED)) {
				const target = m[1];
				const hit = this.app.metadataCache.getFirstLinkpathDest(target, this.file?.path ?? "")
					?? this.app.vault.getAbstractFileByPath(target);
				if (!(hit instanceof TFile)) continue;
				if (!IMG.includes(hit.extension.toLowerCase())) continue;
				if (seen.has(hit.path)) continue;
				seen.add(hit.path);
				images.push(hit);
			}
		}
		// The clicked image must be in the rail even if the scan missed it — a
		// remote or oddly-linked embed should still open rather than doing nothing.
		if (!seen.has(file.path)) images.unshift(file);
		new ImageViewerModal(this.app, images, file.path).open();
	}

	private async toggleCheck(id: TrynaId, opts: { snapshot?: boolean } = {}): Promise<void> {
		if (opts.snapshot !== false) this.pushUndo();
		const idx = this.index;
		const node = idx?.nodes.get(id);
		// Completing a recurring item rolls it forward instead of just ticking
		// it (Dynalist's behaviour); unchecking is left alone.
		if (idx && node && !node.checked) {
			const rolled = await this.rollRecurrence(idx, node);
			// The roll edits the text in place, or ticks this item and adds the
			// next occurrence beside it carrying the children across.
			if (rolled) { this.patch({ rows: [id], lists: [node.parent, id] }); return; }
		}
		await idx?.toggleChecked(id);
		this.patchChecked([id]);
	}

	/** Advance a recurring item on completion. Returns true if it handled the
	 *  check-off itself. */
	private async rollRecurrence(idx: DocIndex, node: TreeNode): Promise<boolean> {
		const found = DATE_RE.exec(withoutLinks(node.text));
		if (!found) return false;
		const parsed = parseDate(found[0]);
		if (!parsed?.recurrence) return false;

		const nextIso = nextOccurrence(parsed.iso, parsed.recurrence, new Date().toISOString());
		const nextSrc = toSource(nextIso, parsed.hasTime, parsed.recurrence);

		if (this.plugin.settings.recurrenceMode === "advance-in-place") {
			// Keep one item and move its date forward; it stays unchecked.
			await idx.setBody(node.id, node.text.replace(found[0], nextSrc), node.note);
			new Notice(`Trynalist: next occurrence ${formatDate({ ...parsed, iso: nextIso }, this.plugin.settings)}.`);
			return true;
		}

		// Default: the completed item stays as a record, and the next occurrence
		// is created directly beneath it — carrying the children across, as
		// Dynalist does.
		await idx.toggleChecked(node.id);
		const clone = await idx.createNode(node.text.replace(found[0], nextSrc), node.parent, node.id);
		// The next occurrence keeps the item's own checkbox (it had none, so
		// there was nothing to tick next time — M39/M40) and its fold state.
		Object.assign(clone, carriedFields(node));
		await idx.writeNode(clone);
		for (const child of [...idx.children(node.id)]) {
			await idx.move(child.id, clone.id, idx.children(clone.id).at(-1)?.id ?? null);
		}
		this.focusId = clone.id;
		new Notice(`Trynalist: next occurrence ${formatDate({ ...parsed, iso: nextIso }, this.plugin.settings)}.`);
		return true;
	}

	private async addFirstItem(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		this.pushUndo();
		const created = await idx.createNode("", this.zoomRoot, null);
		this.focusId = created.id;
		this.render();
	}

	/** Duplicate whatever row currently has focus (command palette entry). */
	async duplicateFocused(): Promise<void> {
		const idx = this.index;
		if (!idx || !this.focusId) { new Notice("Trynalist: no item focused."); return; }
		await this.flushPendingSaves();
		this.pushUndo();
		const from = idx.nodes.get(this.focusId)?.parent ?? null;
		const newId = await idx.duplicateSubtree(this.focusId);
		this.focusId = newId;
		this.patch({ lists: [from] });
	}

	// ── multi-select ─────────────────────────────────────────────────────

	/** About to delete `ids` (with their subtrees): if the item you are zoomed
	 *  into is among them or inside one, zoom out to where it lived first.
	 *  Deleting it from the menu left a ghost zoom on an item that no longer
	 *  existed (L10). Returns whether the zoom changed. */
	private leaveZoomIfDeleting(ids: TrynaId[]): boolean {
		const idx = this.index;
		if (!idx || !this.zoomRoot) return false;
		const doomed = new Set(ids);
		const seen = new Set<TrynaId>();
		let p = idx.nodes.get(this.zoomRoot);
		while (p && !seen.has(p.id)) {
			if (doomed.has(p.id)) {
				this.pushNav();
				this.zoomRoot = p.parent;
				return true;
			}
			seen.add(p.id);
			p = p.parent ? idx.nodes.get(p.parent) : undefined;
		}
		return false;
	}

	/** Rows a command should act on: the selection if there is one, else the
	 *  focused row. Always returned in visible (document) order. */
	private actionTargets(): TreeNode[] {
		const idx = this.index;
		if (!idx) return [];
		const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
		if (this.selection.size) return vis.filter((n) => this.selection.has(n.id));
		const focused = this.focusId ? idx.nodes.get(this.focusId) : null;
		return focused ? [focused] : [];
	}

	/** Drop any target that has an ancestor in the same set, so a bulk op
	 *  never applies twice to a node (once directly, once via its parent). */
	private topLevelTargets(): TreeNode[] {
		const idx = this.index;
		if (!idx) return [];
		const targets = this.actionTargets();
		const ids = new Set(targets.map((t) => t.id));
		return targets.filter((t) => {
			let p = t.parent ? idx.nodes.get(t.parent) : null;
			const seen = new Set<TrynaId>();
			while (p && !seen.has(p.id)) {
				if (ids.has(p.id)) return false;
				seen.add(p.id);
				p = p.parent ? idx.nodes.get(p.parent) : null;
			}
			return true;
		});
	}

	private setSelection(ids: TrynaId[]): void {
		this.selection = new Set(ids);
	}

	/** The selected subtrees as an indented outline, or null if nothing is
	 *  block-selected. One serializer, shared by the copy EVENT path and the
	 *  copy COMMAND path.
	 *
	 *  Indentation follows the copyIndent setting (tabs, 2 or 4 spaces). The
	 *  paste handler infers the unit from the text itself rather than assuming
	 *  one, so a copy round-trips at whatever depth it lands whichever setting
	 *  produced it. Without this, Mod+C copied only the caret's own row. */
	/** Keep the copied items in full beside the plain text just written (see
	 *  plugin.itemClipboard). Same selection and the same "skip empty items"
	 *  rule as outlineForSelection, so the two describe the same items. */
	private rememberCopy(text: string): void {
		const idx = this.index;
		if (!idx) return;
		const tops = this.selection.size ? this.topLevelTargets() : this.currentLineTargets();
		const skipEmpty = this.plugin.settings.copySkipEmpty;
		const build = (id: TrynaId): ClipNode[] => {
			const node = idx.nodes.get(id);
			if (!node) return [];
			const kids = idx.children(id).flatMap((k) => build(k.id));
			// A mirror owns no text but is not empty: skipping it made Cut then
			// Paste destroy the mirror (finding 9).
			if (skipEmpty && !node.mirrorOf && !node.text.trim() && !node.note.trim()) return kids;
			return [{
				text: node.text, note: node.note, checkbox: node.checkbox, checked: node.checked,
				checklist: node.checklist, numbered: node.numbered, collapsed: node.collapsed,
				heading: node.heading, color: node.color, mirrorOf: node.mirrorOf, mirrorMode: node.mirrorMode,
				children: kids,
			}];
		};
		this.plugin.itemClipboard = { text, nodes: tops.flatMap((t) => build(t.id)) };
	}

	/** The remembered copy, if the clipboard still holds exactly its text and
	 *  plain text would lose something: more than one item, a note, an
	 *  in-item line break, or any of the flags. */
	private richPasteFor(text: string): ClipNode[] | null {
		const clip = this.plugin.itemClipboard;
		if (!clip) return null;
		const norm = (s: string): string => s.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
		if (norm(text) !== norm(clip.text) || !clip.nodes.length) return null;
		const one = clip.nodes.length === 1 && !clip.nodes[0].children.length ? clip.nodes[0] : null;
		if (one && !one.note && !one.text.includes("\n") && !one.heading && !one.color
			&& !one.checkbox && !one.checked && !one.mirrorOf) return null;   // plain text says it all
		return clip.nodes;
	}

	/** Paste remembered items. Same shape as a multi-line paste: the first item
	 *  merges into the row being pasted into (its flags too, when that row was
	 *  empty), its children go under that row, the other items follow as
	 *  siblings, and text after the caret becomes one more sibling. One undo
	 *  step. */
	private async pasteRich(nodes: ClipNode[], n: TreeNode, el: HTMLElement): Promise<void> {
		const idx = this.index;
		if (!idx || !nodes.length) return;
		const full = rowDomToRaw(el.innerText);
		const caret = Math.min(this.caretOffset(el), full.length);
		const head = full.slice(0, caret);
		const tail = full.slice(caret);
		this.cancelSave(n.id);
		this.pushUndo();
		const apply = async (target: TreeNode, c: ClipNode): Promise<void> => {
			Object.assign(target, {
				note: c.note, checkbox: c.checkbox, checked: c.checked, checklist: c.checklist,
				numbered: c.numbered, collapsed: c.collapsed, heading: c.heading, color: c.color,
				mirrorOf: c.mirrorOf, mirrorMode: c.mirrorMode,
				due: primaryDate(target.text, c.note),
			});
			await idx.writeNode(target);
		};
		const addKids = async (parent: TrynaId, kids: ClipNode[]): Promise<void> => {
			let after: TrynaId | null = idx.children(parent).at(-1)?.id ?? null;
			for (const k of kids) {
				const made = await idx.createNode(k.text, parent, after);
				await apply(made, k);
				after = made.id;
				await addKids(made.id, k.children);
			}
		};
		const [first, ...rest] = nodes;
		const own = idx.nodes.get(n.id);
		if (!own) return;
		// First item: its text joins what is before the caret. Its flags and
		// note take over only when the row had nothing of its own; otherwise
		// the note is appended and the row keeps its flags.
		if (!head.trim() && !own.note) {
			await idx.setBody(n.id, first.text, own.note);
			await apply(own, first);
		} else {
			await idx.setBody(n.id, `${head}${first.text}`, first.note ? (own.note ? `${own.note}\n${first.note}` : first.note) : own.note);
		}
		await addKids(n.id, first.children);
		let lastId = n.id;
		for (const c of rest) {
			const made = await idx.createNode(c.text, own.parent, lastId);
			await apply(made, c);
			await addKids(made.id, c.children);
			lastId = made.id;
		}
		if (tail.trim()) {
			const made = await idx.createNode(tail.trim(), own.parent, lastId);
			lastId = made.id;
		}
		const count = (list: ClipNode[]): number => list.reduce((k, c) => k + 1 + count(c.children), 0);
		this.focusId = lastId;
		this.render();
		new Notice(`Trynalist: pasted ${count(nodes)} item${count(nodes) === 1 ? "" : "s"}.`);
	}

	outlineForSelection(withStamps = false): string | null {
		const idx = this.index;
		if (!idx) return null;
		// No block selection? Fall back to the row the caret is in, WITH its
		// children — CodeMirror's "acts on the current line when nothing is
		// selected" rule, which is what makes Mod+C/Mod+X useful without
		// selecting first.
		const tops = this.selection.size ? this.topLevelTargets() : this.currentLineTargets();
		if (!tops.length) return null;
		const lines: string[] = [];
		// Tabs get eaten by a lot of destinations (chat boxes, some editors), so
		// the default is spaces. Our own paste reads both back.
		const spaces = this.plugin.settings.copyIndentSpaces;
		const unit = spaces > 0 ? " ".repeat(spaces) : "\t";
		const skipEmpty = this.plugin.settings.copySkipEmpty;
		const walk = (id: TrynaId, depth: number) => {
			const node = idx.nodes.get(id);
			if (!node) return;
			// An empty item carries nothing to the destination; its children
			// still do, so they keep their own depth rather than shifting up.
			if (skipEmpty && !node.mirrorOf && !node.text.trim() && !node.note.trim()) {
				for (const kid of idx.children(id)) walk(kid.id, depth);
				return;
			}
			const pad = unit.repeat(depth);
			const box = node.checkbox || node.checked ? (node.checked ? "[x] " : "[ ] ") : "";
			// The stamp goes after the bullet, before the text, so the result is
			// still a valid outline that pastes back cleanly.
			const stamp = withStamps ? `${fmtStamp(node.created)} — ` : "";
			// A mirror has no text of its own; say what it is rather than
			// leaving a bare bullet in the copied text.
			const own = node.mirrorOf && !node.text ? `(mirror: ${node.mirrorOf})` : node.text;
			lines.push(own || box
				? `${pad}- ${box}${stamp}${own}`
				: (stamp ? `${pad}- ${stamp}` : `${pad}-`));
			if (node.note) for (const l of node.note.split("\n")) lines.push(`${pad}${unit}${l}`);
			for (const kid of idx.children(id)) walk(kid.id, depth + 1);
		};
		for (const top of tops) walk(top.id, 0);
		return lines.join("\n");
	}

	/** Mod+C / Mod+X / Mod+D inside a row. Returns true when we acted.
	 *
	 *  Declining here is the whole point: with text highlighted we do nothing
	 *  at all, so the browser's own copy runs untouched. Registering these as
	 *  commands could not express that — a declining command still leaves the
	 *  keymap holding the chord. */
	private handleClipboardChord(e: KeyboardEvent): boolean {
		if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
		const key = e.key.toLowerCase();
		if (key !== "c" && key !== "x" && key !== "d") return false;
		const sel = this.contentEl.doc.getSelection();
		const textHighlighted = !!sel && !sel.isCollapsed && !!sel.toString();

		if (key === "d") {
			// Delete does not care about a highlight — nothing native to protect.
			if (e.shiftKey) return false;
			if (!this.hasDeleteTarget()) return false;
			e.preventDefault();
			e.stopPropagation();
			void this.cmdDeleteLine();
			return true;
		}
		// Copy / cut: hand highlighted text straight to the browser.
		if (textHighlighted && !this.selection.size) return false;
		if (!this.hasDeleteTarget()) return false;
		e.preventDefault();
		e.stopPropagation();
		void this.cmdCopyItems(key === "x");
		return true;
	}

	/** The focused row as a one-item target list, for the no-selection case. */
	private currentLineTargets(): TreeNode[] {
		const idx = this.index;
		const node = idx && this.focusId ? idx.nodes.get(this.focusId) : null;
		return node ? [node] : [];
	}

	/** True when a line command can act: either a block selection, or a caret
	 *  in a row with no text highlighted (highlighted text belongs to the
	 *  browser's own copy). */
	hasLineTarget(): boolean {
		// Copy and cut yield while text is highlighted, because those chords
		// have a native meaning there.
		const sel = this.contentEl.doc.getSelection();
		if (!this.selection.size && sel && !sel.isCollapsed && sel.toString()) return false;
		return this.hasDeleteTarget();
	}

	/** Delete-line's gate. Deliberately ignores a text highlight: Mod+Shift+K
	 *  and Mod+D delete the line whatever is selected inside it, which is what
	 *  every editor does — requiring a collapsed caret is why they appeared to
	 *  do nothing. */
	hasDeleteTarget(): boolean {
		if (this.selection.size) return true;
		if (!this.focusId || !this.index?.nodes.get(this.focusId)) return false;
		const active = this.containerEl.ownerDocument.activeElement;
		return !!active?.instanceOf(HTMLElement) && !!active.closest(".trynalist-text");
	}

	/** Remove every item with no text and no note — but only the ones with no
	 *  children, and repeatedly, so a branch of empties collapses from the
	 *  leaves up without ever orphaning anything. Asks first: this deletes
	 *  across the whole document, which is not something to do silently. */
	async cmdCleanupEmpty(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const isEmpty = (n: TreeNode) => !n.text.trim() && !n.note.trim() && !n.mirrorOf;
		// Simulate the leaves-up passes to count what will ACTUALLY go. Counting
		// every empty item over-promises: one holding a non-empty child is kept,
		// so the dialog would offer to remove things it then leaves behind.
		const doomed = new Set<TrynaId>();
		for (let pass = 0; pass < 20; pass++) {
			const next = [...idx.nodes.values()].filter((n) =>
				isEmpty(n) && !doomed.has(n.id)
				&& idx.children(n.id).every((k) => doomed.has(k.id)));
			if (!next.length) break;
			next.forEach((n) => doomed.add(n.id));
		}
		if (!doomed.size) {
			new Notice("Trynalist: no empty items to clean up. Empty items that still have children are kept.");
			return;
		}
		const countable = [...doomed];
		const ok = await new Promise<boolean>((resolve) => {
			new ConfirmModal(this.app, {
				title: `Remove ${countable.length} empty item${countable.length === 1 ? "" : "s"}?`,
				body: "Items with no text and no note. Any that still have a child with content "
					+ "is kept, so nothing is orphaned — that is why this number can be lower "
					+ "than the number of blank rows you can see. This is undoable.",
				cta: "Clean up",
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
			}).open();
		});
		if (!ok) return;
		await this.flushPendingSaves();
		this.pushUndo();
		let removed = 0;
		// Leaves-up, repeatedly: deleting a leaf can make its parent a leaf.
		for (let pass = 0; pass < 20; pass++) {
			const leaves = [...idx.nodes.values()]
				.filter((n) => isEmpty(n) && idx.children(n.id).length === 0);
			if (!leaves.length) break;
			for (const leaf of leaves) { await idx.deleteNode(leaf.id); removed++; }
		}
		this.render();
		new Notice(`Trynalist: removed ${removed} empty item${removed === 1 ? "" : "s"}.`);
	}

	/** Delete the current line (or the selection), children included. */
	async cmdDeleteLine(): Promise<void> {
		if (!this.selection.size) {
			const targets = this.currentLineTargets();
			if (!targets.length) return;
			this.setSelection(this.withDescendants([targets[0].id]));
		}
		await this.bulkDelete();
	}

	/** Copy the block selection. A COMMAND, not just a copy-event handler:
	 *  selecting rows clears the native text selection, and a browser fires no
	 *  `copy` event when nothing is natively selected — so Mod+C reached
	 *  nothing at all. Gated on there being a selection, so with ordinary text
	 *  selected the chord still does the browser's own copy. */
	async cmdCopyItems(cut = false, withStamps = false): Promise<void> {
		const text = this.outlineForSelection(withStamps);
		if (text === null) return;
		await navigator.clipboard.writeText(text);
		this.rememberCopy(text);
		// Count what was actually acted on, not the (possibly empty) selection.
		const n = this.selection.size || 1;
		if (cut && !this.selection.size) {
			const targets = this.currentLineTargets();
			if (targets.length) this.setSelection(this.withDescendants([targets[0].id]));
		}
		if (cut) {
			await this.bulkDelete();
			new Notice(`Trynalist: cut ${n} item${n === 1 ? "" : "s"} (with children).`);
		} else {
			new Notice(`Trynalist: copied ${n} item${n === 1 ? "" : "s"} (with children).`);
		}
	}

	/** True when a block selection exists — gates the copy/cut commands. */
	hasBlockSelection(): boolean {
		return this.selection.size > 0;
	}

	private wireClipboard(el: HTMLElement): void {
		// The copy/cut EVENTS are a bonus path — they only fire when something is
		// natively selected, which a block selection is not. They delegate to the
		// one serializer rather than carrying a second copy of it, which is how
		// the two drifted apart (one gained a spaces setting, one kept tabs).
		const write = (e: ClipboardEvent): boolean => {
			if (!this.selection.size || !e.clipboardData) return false;
			const text = this.outlineForSelection();
			if (text === null) return false;
			e.clipboardData.setData("text/plain", text);
			this.rememberCopy(text);
			e.preventDefault();
			return true;
		};
		this.registerDomEvent(el, "copy", (e) => { write(e); });
		this.registerDomEvent(el, "cut", (e) => {
			if (write(e)) void this.bulkDelete();
		});
	}

	clearSelection(): void {
		if (!this.selection.size) return;
		this.selection.clear();
		this.selectionAnchor = null;
		this.repaintSelection();
	}

	/** Selecting a parent selects everything under it. Dynalist does this, and
	 *  without it a range that reaches a collapsed-open parent highlights the
	 *  parent while quietly acting on its subtree anyway. */
	private withDescendants(ids: TrynaId[]): TrynaId[] {
		const idx = this.index;
		if (!idx) return ids;
		const out = new Set<TrynaId>();
		const walk = (id: TrynaId) => {
			if (out.has(id)) return;
			out.add(id);
			for (const kid of idx.children(id)) walk(kid.id);
		};
		ids.forEach(walk);
		return [...out];
	}

	/** Click and drag across rows to select them, up or down. Two ways in,
	 *  because both feel natural and people reach for whichever is nearer:
	 *  dragging from a row's gutter, and dragging text past the end of its own
	 *  line (at which point a text selection becomes a row selection). */
	private dragSelectAnchor: TrynaId | null = null;
	/** Per-gesture cache for drag-select (L82): the visible order with an
	 *  id→index map and the row elements by id, built on the first crossing
	 *  and dropped on mouseup, so each row crossed costs a diff, not a scan. */
	private dragSelectCache: { vis: TreeNode[]; pos: Map<TrynaId, number>; rows: Map<string, HTMLElement[]> } | null = null;

	private wireRowDragSelect(row: HTMLElement, n: TreeNode): void {
		row.addEventListener("mousedown", (e) => {
			if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
			const target = e.target as HTMLElement;
			// Starting on the text is a text selection until it leaves the row;
			// starting on a control is that control's business.
			if (target.closest(".trynalist-text, .trynalist-note, input, button, a")) return;
			if (target.closest(".trynalist-menu-handle, .trynalist-rowaction, .trynalist-bullet")) return;
			this.dragSelectAnchor = n.id;
			this.selectionAnchor = n.id;
			this.dragSelectCache = null;
		});
		row.addEventListener("mouseenter", () => {
			if (!this.dragSelectAnchor) return;
			const idx = this.index;
			if (!idx) return;
			if (!this.dragSelectCache) {
				const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
				const pos = new Map<TrynaId, number>();
				vis.forEach((v, i) => pos.set(v.id, i));
				const rows = new Map<string, HTMLElement[]>();
				for (const r of this.contentEl.findAll(".trynalist-row")) {
					const id = r.dataset.id;
					if (!id) continue;
					const list = rows.get(id);
					if (list) list.push(r); else rows.set(id, [r]);
				}
				this.dragSelectCache = { vis, pos, rows };
			}
			const cache = this.dragSelectCache;
			const before = this.selection;
			this.selectRangeTo(n.id, cache);
			// Toggle only the rows whose state changed. mouseup still runs a
			// full repaintSelection, which corrects anything missed.
			const paint = (id: string, on: boolean): void => {
				for (const el of cache.rows.get(id) ?? []) el.toggleClass("is-selected", on);
			};
			for (const id of before) if (!this.selection.has(id)) paint(id, false);
			for (const id of this.selection) if (!before.has(id)) paint(id, true);
		});
	}

	/** Repaint just the selection classes. A full render mid-drag would tear
	 *  down the rows the pointer is travelling over. */
	private paintSelection(): void {
		for (const row of this.contentEl.findAll(".trynalist-row")) {
			const id = row.dataset.id;
			row.toggleClass("is-selected", !!id && this.selection.has(id));
		}
	}

	/** A native text selection that has left its starting row is really a row
	 *  selection — which is what makes "click, hold, drag" work from the text. */
	private promoteTextSelection(): void {
		const sel = this.contentEl.doc.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const rowOf = (node: Node | null): string | null => {
			const el = node?.instanceOf(HTMLElement) ? node : node?.parentElement ?? null;
			return el?.closest<HTMLElement>(".trynalist-row")?.dataset.id ?? null;
		};
		const from = rowOf(sel.anchorNode);
		const to = rowOf(sel.focusNode);
		if (!from || !to || from === to) return;
		if (!this.contentEl.contains(sel.anchorNode)) return;
		sel.removeAllRanges();
		this.selectionAnchor = from;
		this.selectRangeTo(to);
		this.paintSelection();
	}

	/** Select the visible range between the anchor and `id`. */
	private selectRangeTo(id: TrynaId, cache?: { vis: TreeNode[]; pos: Map<TrynaId, number> }): void {
		const idx = this.index;
		if (!idx) return;
		const vis = cache?.vis ?? idx.visible(this.zoomRoot, this.effectiveHideCompleted());
		const anchor = this.selectionAnchor ?? this.focusId ?? id;
		const a = cache ? (cache.pos.get(anchor) ?? -1) : vis.findIndex((v) => v.id === anchor);
		const b = cache ? (cache.pos.get(id) ?? -1) : vis.findIndex((v) => v.id === id);
		if (a === -1 || b === -1) return;
		const [lo, hi] = a <= b ? [a, b] : [b, a];
		this.selectionAnchor = anchor;
		this.setSelection(this.withDescendants(vis.slice(lo, hi + 1).map((v) => v.id)));
	}

	/** Bulk indent / outdent, preserving relative structure. */
	/** The item you are zoomed into is the frame of the view, not a row you
	 *  can move: indenting or moving it files it somewhere outside what is
	 *  shown. The keys already refuse it; the commands, item menu, palette and
	 *  mobile toolbar reach it through these bulk paths (M51). */
	private movableTargets(): TreeNode[] {
		return this.topLevelTargets().filter((t) => t.id !== this.zoomRoot);
	}

	private async bulkIndent(outdent: boolean): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const targets = this.movableTargets();
		if (!targets.length) return;
		await this.flushPendingSaves();
		this.pushUndo();
		const from = targets.map((t) => t.parent);
		if (outdent) {
			// Outermost first, so a parent's move doesn't invalidate the rest.
			// Each former parent keeps a cursor so a block of siblings lands
			// after it in the SAME order (inserting each one directly after the
			// parent would reverse the block).
			const cursor = new Map<TrynaId, TrynaId>();
			for (const t of [...targets].sort((x, y) => x.depth - y.depth)) {
				const parent = t.parent ? idx.nodes.get(t.parent) : null;
				// Direct children of the zoomed item stay put (they would leave
				// the view); same rule as Shift+Tab.
				if (!parent || parent.id === this.zoomRoot) continue;
				const after = cursor.get(parent.id) ?? parent.id;
				if (await idx.move(t.id, parent.parent, after)) cursor.set(parent.id, t.id);
			}
		} else {
			for (const t of targets) {
				const sibs = idx.children(t.parent);
				const i = sibs.findIndex((s) => s.id === t.id);
				// The new parent must not itself be part of the moving set.
				if (i <= 0 || this.selection.has(sibs[i - 1].id)) continue;
				const newParent = sibs[i - 1];
				const last = idx.children(newParent.id).at(-1)?.id ?? null;
				if (await idx.move(t.id, newParent.id, last) && newParent.collapsed) {
					await idx.setFlag(newParent.id, "collapsed", false);
				}
			}
		}
		this.patchMoved(targets.map((t) => t.id), from);
	}

	private async bulkMove(up: boolean): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const targets = this.movableTargets();
		if (!targets.length) return;
		// All or nothing: with a selection pinned at the top of its list, moving
		// the movable ones and skipping the pinned one reversed their order.
		const blocked = targets.some((t) => {
			const sibs = idx.children(t.parent);
			const i = sibs.findIndex((s) => s.id === t.id);
			const to = up ? i - 1 : i + 1;
			return to < 0 || to >= sibs.length;
		});
		if (blocked) return;
		await this.flushPendingSaves();
		this.pushUndo();
		const ordered = up ? targets : [...targets].reverse();
		for (const t of ordered) {
			const sibs = idx.children(t.parent);
			const i = sibs.findIndex((s) => s.id === t.id);
			const to = up ? i - 1 : i + 1;
			if (to < 0 || to >= sibs.length) continue;
			const after = up
				? (to - 1 >= 0 ? sibs[to - 1].id : null)
				: sibs[to].id;
			await idx.move(t.id, t.parent, after);
		}
		this.patch({ lists: targets.map((t) => t.parent) });
	}

	async bulkToggleCheck(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const targets = this.actionTargets();
		if (!targets.length) return;
		await this.flushPendingSaves();
		this.pushUndo();
		// Mixed selection → check everything; all checked → uncheck.
		const allChecked = targets.every((t) => t.checked);
		let rolled = false;
		for (const t of targets) {
			if (t.checked === !allChecked) continue;
			// Checking off a recurring item rolls it forward, exactly as a single
			// Mod+Enter does; the bulk path just ticked it, ending the series (L13).
			if (!t.checked && await this.rollRecurrence(idx, t)) { rolled = true; continue; }
			await idx.toggleChecked(t.id);
		}
		// A roll can add the next occurrence and move children: repaint fully.
		if (rolled) this.render(); else this.patchChecked(targets.map((t) => t.id));
	}

	async bulkDelete(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// The zoomed-in item is not among the visible rows, so deleting it with
		// Mod+D or Cut from its head row deleted only its children (L10). When
		// it is part of the selection, it is the target.
		const zoomed = this.zoomRoot && this.selection.has(this.zoomRoot) ? idx.nodes.get(this.zoomRoot) : undefined;
		const targets = zoomed ? [zoomed] : this.topLevelTargets();
		if (!targets.length) return;
		// A mirror is the one way deleting here can blank a row somewhere else,
		// and that other document gives no warning of its own. Say so first.
		if (!await this.confirmMirrorImpact(targets)) return;
		await this.flushPendingSaves();
		this.pushUndo();
		const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
		const firstAt = vis.findIndex((v) => v.id === targets[0].id);
		this.focusId = firstAt > 0 ? vis[firstAt - 1].id : null;
		const from = targets.map((t) => t.parent);
		this.leaveZoomIfDeleting(targets.map((t) => t.id));
		// One trash group for the whole selection, restorable as one (M65).
		await idx.deleteNodes(targets.map((t) => t.id), { trashDir: this.trashDir() });
		const count = targets.length;
		this.selection.clear();
		this.selectionAnchor = null;
		this.paintSelection();
		this.patch({ lists: from });
		new Notice(
			`Trynalist: deleted ${count} item${count === 1 ? "" : "s"} (with children) — undo with the Trynalist undo command.`,
		);
	}

	/** If anything about to be deleted is mirrored elsewhere, name the documents
	 *  and ask. Resolves true when it is safe (or the user said go ahead). */
	private async confirmMirrorImpact(targets: TreeNode[], opts: { subtree?: boolean } = {}): Promise<boolean> {
		const idx = this.index;
		if (!idx) return true;
		// Every id in the subtrees, since a mirror can point at any depth —
		// unless only the targets themselves go (a merge keeps the children).
		const ids = new Set<TrynaId>();
		const walk = (id: TrynaId) => {
			if (ids.has(id)) return;
			ids.add(id);
			if (opts.subtree !== false) for (const kid of idx.children(id)) walk(kid.id);
		};
		targets.forEach((t) => walk(t.id));

		// Skip the whole scan when the vault has no mirrors at all — the common
		// case, and the difference between an instant delete and a multi-second
		// one in a vault with many documents.
		if (!await anyMirrorsExist(this.app, this.plugin.settings.rootFolder)) return true;

		let holders: Array<{ docTitle: string; count: number }> = [];
		try {
			holders = await findMirrorsOf(
				this.app, this.plugin.settings.rootFolder, idx.docRef.file.path, ids,
			);
		} catch (e) {
			// A failed lookup must not block a delete; it just means no warning.
			console.error("Trynalist: mirror lookup failed", e);
			return true;
		}
		if (!holders.length) return true;

		const total = holders.reduce((n, h) => n + h.count, 0);
		const where = holders.map((h) => `· ${h.docTitle} (${h.count})`).join("\n");
		return new Promise<boolean>((resolve) => {
			new ConfirmModal(this.app, {
				title: `${total} mirror${total === 1 ? "" : "s"} point${total === 1 ? "s" : ""} at this`,
				body: `Deleting this would leave ${total === 1 ? "that window" : "those windows"} with nothing to show:\n\n${where}\n\n`
					+ "The mirrors themselves are not deleted — they will say their source is gone, "
					+ "and can be removed from their own menus. This delete is undoable.",
				cta: "Delete anyway",
				warning: true,
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
			}).open();
		});
	}

	/** Select every visible row under the current zoom. */
	selectAll(): void {
		const idx = this.index;
		if (!idx) return;
		const vis = idx.visible(this.zoomRoot, this.effectiveHideCompleted());
		this.setSelection(vis.map((v) => v.id));
		this.selectionAnchor = vis[0]?.id ?? null;
		this.render();
	}

	// ── Phase B: search & navigation ─────────────────────────────────────

	/** In-doc filter. When set, the outline renders flat matches only. */
	private searchQuery = "";
	private searchActive = false;

	openSearch(seed?: string): void {
		// Opening a search is a visual change worth going back from.
		if (!this.searchActive) this.pushNav();
		// A search you were part way through should still be there when you come
		// back. Only used when nothing is seeded and nothing is already typed.
		if (!seed && !this.searchQuery) this.searchQuery = this.plugin.settings.lastSearchQuery ?? "";
		this.matchCursor = -1;
		this.searchActive = true;
		if (seed !== undefined) this.searchQuery = seed;
		this.render();
		const input = this.contentEl.querySelector<HTMLInputElement>(".trynalist-search input");
		if (!input) return;
		input.focus();
		if (seed === undefined) return;
		// Seed AND fire input, or the box shows the term while the results
		// below it still belong to the previous query.
		input.value = seed;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	closeSearch(): void {
		if (!this.searchActive) return;
		this.searchActive = false;
		this.searchQuery = "";
		this.globalIndexes = null;   // release the other documents' indexes
		this.render();
	}

	private renderSearchBar(host: HTMLElement): void {
		const bar = host.createDiv({ cls: "trynalist-search" });
		const box = bar.createDiv({ cls: "trynalist-search-box" });
		const input = box.createEl("input", {
			type: "text",
			placeholder: this.searchMode === "global" ? "Search every document…"
				: this.searchMode === "flat" ? "Flat search…" : "Search this document…",
		});
		input.value = this.searchQuery;
		// A plain text input, not type="search": the browser's own clear button
		// is unstyleable and fires no event we can hang the mode reset on, so
		// the X below is ours.
		input.addEventListener("input", () => {
			this.searchQuery = input.value;
			this.plugin.settings.lastSearchQuery = input.value;
			this.plugin.saveSettingsSoon();
			this.matchCursor = -1;
			// Filtering re-walks and re-renders the whole outline, so like global
			// mode it waits for the typing to pause rather than running per key.
			window.clearTimeout(this.docSearchTimer);
			this.docSearchTimer = window.setTimeout(() => {
				if (this.searchActive && this.searchQuery === input.value) this.renderResults();
			}, 120);
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Escape") { e.preventDefault(); this.closeSearch(); return; }
			if (e.key === "Enter" && e.shiftKey) {
				e.preventDefault();
				this.setSearchMode("flat");
				return;
			}
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.setSearchMode("global");
				return;
			}
			if (e.key === "Enter") { e.preventDefault(); this.stepMatch(1); }
		});
		// Belt and braces for Mod+A. The scope handler covers it, but a scope can
		// be bypassed by a CHILD scope pushed by something else, and the earlier
		// finding stands: a plain bubbling listener on this input sees zero
		// events, so something upstream stops it. A capture listener on the input
		// runs before anything bubbling and does not depend on scope ordering.
		// On the input itself, not registerDomEvent: this input is rebuilt by
		// every render while search is open, and each registration was held by
		// the view until it closed — one more per render (L90).
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key !== "a" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
			e.preventDefault();
			e.stopPropagation();
			input.select();
		}, true);

		const clear = box.createEl("button", { cls: "trynalist-search-clear" });
		setIcon(clear, "x");
		clear.setAttribute("aria-label", "Clear the search");
		clear.addEventListener("click", () => {
			this.searchQuery = "";
			this.plugin.settings.lastSearchQuery = "";
			void this.plugin.saveSettings();
			input.value = "";
			input.focus();
			this.renderResults();
		});

		// Switching BETWEEN modes, not just back out of one. Every view had a way
		// out and no way across, so going from in-doc to flat meant leaving and
		// starting again.
		// Leaving a search, first thing in the row — every mode has one now, not
		// just the ones that happened to get a "Go back".
		const done = bar.createEl("button", { cls: "trynalist-search-back" });
		setIcon(done.createSpan({ cls: "trynalist-search-back-icon" }), "arrow-left");
		done.createSpan({ text: "Back" });
		done.createSpan({ cls: "trynalist-search-key", text: "Esc" });
		done.addEventListener("click", (e) => { e.preventDefault(); this.closeSearch(); });

		const modes = bar.createDiv({ cls: "trynalist-search-modes" });
		const modeBtn = (
			label: string, icon: string, key: string, hint: string, on: boolean, go: () => void,
		): void => {
			const b = modes.createEl("button", {
				cls: on ? "trynalist-search-mode is-on" : "trynalist-search-mode",
			});
			// Icon, name, then the chord — Dynalist puts the shortcut on the chip
			// rather than hiding it in a tooltip, which is the only place a
			// keyboard user would find it.
			setIcon(b.createSpan({ cls: "trynalist-search-mode-icon" }), icon);
			b.createSpan({ text: label });
			b.createSpan({ cls: "trynalist-search-key", text: key });
			setTooltip(b, hint, { placement: "bottom" });
			b.setAttribute("aria-pressed", on ? "true" : "false");
			b.setAttribute("aria-label", `${hint} (${key})`);
			b.addEventListener("click", (e) => { e.preventDefault(); go(); });
		};
		const mod = Platform.isMacOS ? "\u2318" : "Ctrl";
		modeBtn("In doc", "file-search", `${mod}F`, "Filter this document, keeping its structure",
			this.searchMode === "doc", () => this.setSearchMode("doc"));
		modeBtn("Flat", "list", "\u21e7\u21b5", "A plain list of matches",
			this.searchMode === "flat", () => this.setSearchMode("flat"));
		modeBtn("All docs", "library", `${mod}\u21b5`, "Search every document",
			this.searchMode === "global", () => this.setSearchMode("global"));

		if (this.searchMode === "flat") this.renderSortPicker(bar);

		const panelBtn = bar.createEl("button", { cls: "trynalist-search-action" });
		setIcon(panelBtn, "panel-left");
		panelBtn.setAttribute("aria-label", "Show this document in the panel");
		panelBtn.addEventListener("click", () => void this.plugin.revealInPanel(this.file));
		const markBtn = bar.createEl("button", { cls: "trynalist-search-action" });
		setIcon(markBtn, "bookmark-plus");
		markBtn.setAttribute("aria-label", "Bookmark this search");
		markBtn.addEventListener("click", () => this.bookmarkCurrentSearch());

		const hint = host.createDiv({ cls: "trynalist-search-hint" });
		hint.createSpan({
			text: 'Refine with operators like "is:completed" and "has:note". ',
		});
		// A dialog rather than a paragraph: the full list is fifteen operators,
		// which is a wall of text under a search box and unreadable at a glance.
		const help = hint.createEl("a", { text: "Operator reference" });
		help.addEventListener("click", (e) => {
			e.preventDefault();
			new OperatorHelpModal(this.app).open();
		});
	}

	/** Dynalist's "Sort by" list. Flat results only. */
	private renderSortPicker(bar: HTMLElement): void {
		const wrap = bar.createDiv({ cls: "trynalist-search-sort" });
		wrap.createSpan({ text: "Sort by" });
		const select = wrap.createEl("select");
		const options: Array<[SearchSort, string]> = [
			["none", "None"],
			["alpha", "Title (A to Z)"], ["alpha-desc", "Title (Z to A)"],
			["due-desc", "Date (new to old)"], ["due", "Date (old to new)"],
			["unchecked-first", "Unchecked first"], ["checked-first", "Checked first"],
			["edited-new", "Edited (new to old)"], ["edited-old", "Edited (old to new)"],
			["created-new", "Created (new to old)"], ["created-old", "Created (old to new)"],
		];
		for (const [value, label] of options) {
			const opt = select.createEl("option", { value, text: label });
			if (this.plugin.settings.searchSort === value) opt.selected = true;
		}
		select.addEventListener("change", () => {
			this.plugin.settings.searchSort = select.value as SearchSort;
			void this.plugin.saveSettings();
			this.renderResults();
		});
	}

	/** Open this view's search straight into global mode, for callers outside
	 *  the view (panels, the command palette, Mod+Shift+F). */
	openGlobalSearch(query: string): void {
		if (!this.searchActive) this.openSearch(query);
		else if (query) this.searchQuery = query;
		this.searchMode = "global";
		this.matchCursor = -1;
		this.render();
		window.setTimeout(() => {
			this.contentEl.querySelector<HTMLInputElement>(".trynalist-search input")?.focus();
		}, 0);
	}

	/** Switch mode without losing the query — the whole point of a switcher. */
	private setSearchMode(mode: SearchMode): void {
		if (this.searchMode === mode) return;
		// A search is a page you visited, and so is the shape it took — Back
		// should return you to the flat list you were reading, not merely to the
		// same query in whatever mode you happen to be in now.
		this.pushNav();
		this.searchMode = mode;
		this.matchCursor = -1;
		this.render();
		window.setTimeout(() => {
			this.contentEl.querySelector<HTMLInputElement>(".trynalist-search input")?.focus();
		}, 0);
	}

	/** Mod+G: walk the matches, as a browser's find-next does. Wraps, because
	 *  stopping dead at the last match is the one behaviour nobody expects. */
	stepMatch(by: number): void {
		if (!this.lastMatches.length) return;
		this.matchCursor = (this.matchCursor + by + this.lastMatches.length) % this.lastMatches.length;
		const id = this.lastMatches[this.matchCursor];
		const row = this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"]`)
			?? this.contentEl.querySelector<HTMLElement>(`.trynalist-result[data-id="${cssId(id)}"]`);
		row?.scrollIntoView({ block: "center", behavior: "smooth" });
		this.contentEl.querySelectorAll(".is-current-match").forEach((e) => e.removeClass("is-current-match"));
		row?.addClass("is-current-match");
		this.contentEl.querySelector<HTMLElement>(".trynalist-search-count")
			?.setText(`${this.matchCursor + 1} of ${this.lastMatches.length}`);
	}

	/** Save the current query as a bookmark, so a search you keep re-running
	 *  becomes one click. Bookmarks already carry a `query`; this is the
	 *  missing way to create one from inside a search. */
	private bookmarkCurrentSearch(): void {
		const q = this.searchQuery.trim();
		if (!q) { new Notice("Trynalist: type something to bookmark first."); return; }
		const label = `Search: ${q.length > 40 ? `${q.slice(0, 38)}…` : q}`;
		this.plugin.settings.bookmarks.push({
			id: `bm-${Date.now().toString(36)}`,
			label,
			docPath: this.file?.path ?? "",
			docId: this.index?.docRef.manifest.id ?? "",
			query: q,
		});
		void this.plugin.saveSettings();
		this.plugin.refreshPanels();
		new Notice(`Trynalist: bookmarked "${label}".`);
	}

	/** The query whose matches the user asked to see in full (M61). */
	private searchShowAllFor: string | null = null;

	/** Re-render only the result list, so typing doesn't lose input focus. */
	private renderResults(): void {
		const idx = this.index;
		const listEl = this.contentEl.querySelector<HTMLElement>(".trynalist-list");
		if (!idx || !listEl) return;
		listEl.empty();
		// Result lists are rebuilt per keystroke; the notes they rendered were
		// owned by the render's host and stayed loaded until search closed
		// (L89). A fresh host per result list releases the previous ones.
		if (this.noteHost) this.removeChild(this.noteHost);
		this.noteHost = this.addChild(new Component());
		const q = this.searchQuery.trim();
		if (!q) {
			this.lastMatches = [];
			this.renderChildren(listEl, this.zoomRoot);
			return;
		}
		if (this.searchMode === "global") { this.renderGlobalResults(listEl, q); return; }
		const parsed = parseQuery(q);
		// A mirror matches when something it shows does, so a search finds
		// text that lives in another document but is visible here.
		const mirrorMatches = (n: TreeNode): boolean => {
			const hit = this.mirrorHits.get(n.id);
			if (!hit?.ok) return false;
			let seen = 0;
			const walk = (x: TreeNode): boolean => {
				if (++seen > 5000) return false;
				if (!x.mirrorOf && matchesQuery(hit.index, x, parsed)) return true;
				return hit.index.children(x.id).some(walk);
			};
			return (this.mirrorResolver?.rowsFor(hit, n.mirrorMode) ?? []).some(walk);
		};
		const matches = [...idx.nodes.values()].filter((n) => n.mirrorOf ? mirrorMatches(n) : matchesQuery(idx, n, parsed));
		if (!matches.length) {
			this.lastMatches = [];
			listEl.createDiv({ cls: "trynalist-panel-empty", text: `No items match "${q}".` });
			return;
		}
		const summary = describeQuery(parsed);
		const count = listEl.createDiv({
			cls: "trynalist-search-count",
			text: `${matches.length} match${matches.length === 1 ? "" : "es"}` + (summary ? ` — ${summary}` : ""),
		});
		count.dataset.total = String(matches.length);

		if (this.searchMode === "doc") {
			// Keep the hierarchy: show every match WITH its ancestors, so a result
			// still reads as part of the outline it came from. A flat list answers
			// "what matched"; this answers "where".
			// Capped: every match and every ancestor becomes a full editable row,
			// on every debounced keystroke — a one-letter query in a 10,000-item
			// document built thousands (M61). The first SEARCH_ROW_CAP matches in
			// document order are drawn; a button draws the rest on request.
			const matchSet = new Set(matches.map((n) => n.id));
			const inOrder: TreeNode[] = [];
			const walkOrder = (parent: TrynaId | null): void => {
				for (const c of idx.children(parent)) {
					if (matchSet.has(c.id)) inOrder.push(c);
					walkOrder(c.id);
				}
			};
			walkOrder(this.zoomRoot);
			const showAll = this.searchShowAllFor === q;
			const shown = showAll ? inOrder : inOrder.slice(0, SEARCH_ROW_CAP);
			const keep = new Set<TrynaId>();
			for (const n of shown) {
				keep.add(n.id);
				let up = n.parent ? idx.nodes.get(n.parent) : null;
				const seen = new Set<TrynaId>();
				while (up && !seen.has(up.id)) { seen.add(up.id); keep.add(up.id); up = up.parent ? idx.nodes.get(up.parent) : null; }
			}
			const hits = new Set(shown.map((n) => n.id));
			this.lastMatches = shown.map((n) => n.id);
			this.renderFiltered(listEl, this.zoomRoot, keep, hits);
			if (shown.length < inOrder.length) {
				const more = listEl.createDiv({ cls: "trynalist-search-more" });
				const btn = more.createEl("button", { text: `Show all ${inOrder.length} matches` });
				btn.addEventListener("click", () => { this.searchShowAllFor = q; this.renderResults(); });
			}
			return;
		}

		const sorted = this.sortMatches(matches);
		this.lastMatches = sorted.map((n) => n.id);
		for (const n of sorted) {
			const row = listEl.createDiv({ cls: "trynalist-result" });
			row.dataset.id = n.id;
			// Flat search discards indentation exactly like flat view does, so it
			// gets the same depth cue — without it, a run of results reads as one
			// undifferentiated list no matter which level each row came from.
			this.depthBadge(row, this.trailNodes(n).length + 1);
			const trail = trailFor(idx, n);
			if (trail) row.createDiv({ cls: "trynalist-suggest-trail", text: trail });
			const hit = n.mirrorOf ? this.mirrorHits.get(n.id) : undefined;
			const label = hit?.ok ? `Mirror of "${hit.node.text || "(empty)"}" in ${hit.docTitle}` : n.text || "(empty item)";
			row.createDiv({ cls: "trynalist-result-text", text: label });
			if (n.note) row.createDiv({ cls: "trynalist-note", text: n.note });
			row.addEventListener("click", () => void this.revealItem(n.id));
		}
	}

	/** Every document's matches, grouped, drawn INSIDE this view.
	 *
	 *  A separate tab was the wrong shape: it left the breadcrumb, the nav
	 *  buttons and Escape behind, because those belong to the document view. As a
	 *  mode it inherits all of them and Back already works.
	 *
	 *  Debounced rather than run per keystroke: this reads every document in the
	 *  vault. A generation counter guards against an earlier, slower search
	 *  landing after a later one and painting stale results. */
	/** Documents read by the "All docs" search, reused across its keystrokes. */
	private globalIndexes: { at: number; map: Map<string, DocIndex> } | null = null;

	private renderGlobalResults(host: HTMLElement, q: string): void {
		const run = ++this.globalRun;
		host.createDiv({ cls: "trynalist-panel-empty", text: "Searching every document…" });
		window.clearTimeout(this.globalTimer);
		this.globalTimer = window.setTimeout(() => {
			void (async () => {
				// One set of loaded documents per search session (a minute at
				// most, so edits made meanwhile are picked up), and this view's
				// own document straight from its live index. A superseded run
				// stops between documents instead of reading on to the end.
				const now = Date.now();
				if (!this.globalIndexes || now - this.globalIndexes.at > 60_000) {
					this.globalIndexes = { at: now, map: new Map() };
				}
				if (this.index && this.file) this.globalIndexes.map.set(this.file.path, this.index);
				const hits = await searchAllDocs(
					this.app, this.plugin.settings.rootFolder, q, 300,
					this.plugin.settings.searchArchived,
					{ cache: this.globalIndexes.map, stop: () => run !== this.globalRun },
				);
				if (run !== this.globalRun) return;             // a newer search won
				const live = this.contentEl.querySelector<HTMLElement>(".trynalist-list");
				if (!live || !this.searchActive) return;
				live.empty();
				this.lastMatches = [];
				if (!hits.length) {
					live.createDiv({ cls: "trynalist-panel-empty", text: `No items match "${q}".` });
					return;
				}
				live.createDiv({
					cls: "trynalist-search-count",
					text: `Found ${hits.length} match${hits.length === 1 ? "" : "es"} in `
						+ `${new Set(hits.map((h) => h.doc.file.path)).size} document`
						+ `${new Set(hits.map((h) => h.doc.file.path)).size === 1 ? "" : "s"}:`,
				});
				const groups = new Map<string, GlobalHit[]>();
				for (const hit of hits) {
					const list = groups.get(hit.doc.file.path);
					if (list) list.push(hit); else groups.set(hit.doc.file.path, [hit]);
				}
				for (const [path, group] of groups) this.paintGlobalGroup(live, path, group, q);
			})();
		}, 250);
	}

	private paintGlobalGroup(host: HTMLElement, path: string, hits: GlobalHit[], q: string): void {
		const idx = hits[0].index;
		const group = host.createDiv({ cls: "trynalist-gs-group" });
		const title = group.createDiv({ cls: "trynalist-gs-doc" });
		setIcon(title.createSpan({ cls: "trynalist-gs-doc-icon" }), "file-text");
		title.createSpan({ text: hits[0].doc.manifest.title });
		title.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) void this.plugin.openDocFile(file);
		});
		const keep = new Set<TrynaId>();
		const matched = new Set<TrynaId>();
		for (const hit of hits) {
			matched.add(hit.node.id);
			keep.add(hit.node.id);
			let up = hit.node.parent ? idx.nodes.get(hit.node.parent) ?? null : null;
			const seen = new Set<TrynaId>();
			while (up && !seen.has(up.id)) {
				seen.add(up.id); keep.add(up.id);
				up = up.parent ? idx.nodes.get(up.parent) ?? null : null;
			}
		}
		this.paintGlobalBranch(group.createDiv({ cls: "trynalist-gs-body" }), idx, null, keep, matched, path, q);
	}

	private paintGlobalBranch(
		host: HTMLElement, idx: DocIndex, parent: TrynaId | null,
		keep: Set<TrynaId>, matched: Set<TrynaId>, docPath: string, q: string,
	): void {
		for (const n of idx.children(parent)) {
			if (!keep.has(n.id)) continue;
			const item = host.createDiv({ cls: "trynalist-gs-item" });
			// Only the INNERMOST hovered item lights its row. mouseover bubbles
			// through every ancestor item, so the first item to see it claims the
			// hover and stops the event; a plain :hover rule would light them all.
			item.addEventListener("mouseover", (e) => { e.stopPropagation(); item.addClass("is-hovered"); });
			item.addEventListener("mouseout", (e) => { e.stopPropagation(); item.removeClass("is-hovered"); });
			const row = item.createDiv({
				cls: matched.has(n.id) ? "trynalist-gs-row is-match" : "trynalist-gs-row",
			});
			row.createSpan({ cls: "trynalist-gs-bullet", text: "•" });
			this.paintHighlighted(row.createSpan({ cls: "trynalist-gs-text" }), n.text || "(empty item)", q);
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.plugin.openDeepLink({ doc: docPath, item: n.id, zoom: "1" });
			});
			const kids = idx.children(n.id).filter((c) => keep.has(c.id));
			if (kids.length) {
				this.paintGlobalBranch(item.createDiv({ cls: "trynalist-gs-children" }),
					idx, n.id, keep, matched, docPath, q);
			}
		}
	}

	/** Mark the query's words, so you can see WHY a row matched. Operators are
	 *  stripped first: `is:completed` matched without appearing in the text. */
	private paintHighlighted(host: HTMLElement, text: string, q: string): void {
		const words = q.replace(/\b\w+:[^\s]+/g, " ").replace(/[-"]/g, " ")
			.split(/\s+/).map((w) => w.trim()).filter((w) => w && w.toUpperCase() !== "OR");
		if (!words.length) { host.setText(text); return; }
		const pattern = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
		let last = 0;
		for (const m of text.matchAll(pattern)) {
			const at = m.index ?? 0;
			if (at > last) host.createSpan({ text: text.slice(last, at) });
			host.createSpan({ cls: "trynalist-gs-hit", text: m[0] });
			last = at + m[0].length;
		}
		if (last < text.length) host.createSpan({ text: text.slice(last) });
	}

	/** Flat results in the chosen order. "none" is document order, which is what
	 *  the index already yields, so it is a pass-through rather than a sort. */
	private sortMatches(matches: TreeNode[]): TreeNode[] {
		const mode = this.plugin.settings.searchSort ?? "none";
		if (mode === "none") return matches;
		const out = [...matches];
		const cmp: Record<string, (a: TreeNode, b: TreeNode) => number> = {
			"alpha": (a, b) => a.text.localeCompare(b.text),
			"alpha-desc": (a, b) => b.text.localeCompare(a.text),
			// Undated items sink rather than sorting as "oldest".
			"due": (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"),
			"due-desc": (a, b) => (b.due ?? "0000").localeCompare(a.due ?? "0000"),
			"unchecked-first": (a, b) => Number(a.checked) - Number(b.checked),
			"checked-first": (a, b) => Number(b.checked) - Number(a.checked),
			"edited-new": (a, b) => b.modified.localeCompare(a.modified),
			"edited-old": (a, b) => a.modified.localeCompare(b.modified),
			"created-new": (a, b) => b.created.localeCompare(a.created),
			"created-old": (a, b) => a.created.localeCompare(b.created),
		};
		const fn = cmp[mode];
		return fn ? out.sort(fn) : out;
	}

	/** The outline, pruned to `keep`, with matches marked. */
	private renderFiltered(
		host: HTMLElement, parent: TrynaId | null, keep: Set<TrynaId>, hits: Set<TrynaId>,
	): void {
		const idx = this.index;
		if (!idx) return;
		// A real ordinal among the KEPT siblings: 0 painted "0." on every
		// numbered row of a filtered outline.
		let ordinal = 0;
		for (const n of idx.children(parent)) {
			if (!keep.has(n.id)) continue;
			ordinal++;
			const item = host.createDiv({ cls: "trynalist-item" });
			// A mirror is a match through what it shows: draw it as a mirror.
			if (n.mirrorOf) {
				this.renderMirror(item, n);
				if (hits.has(n.id)) item.querySelector(".trynalist-row")?.addClass("is-match");
				continue;
			}
			this.renderRow(item, n, ordinal);
			if (hits.has(n.id)) {
				item.querySelector(".trynalist-row")?.addClass("is-match");
			}
			const kids = idx.children(n.id).filter((c) => keep.has(c.id));
			if (kids.length) {
				const wrap = item.createDiv({ cls: "trynalist-children" });
				this.wireIndentGuide(wrap, n.id);
				this.renderFiltered(wrap, n.id, keep, hits);
			}
		}
	}

	/** Expand everything above an item, leave search, and focus it. */
	/** Zoom the view onto an item — what a deep link with `zoom=1` asks for.
	 *  Records a nav step, so Back leaves the zoom rather than the document. */
	zoomToItem(id: TrynaId): void {
		if (!this.index?.nodes.get(id)) {
			new Notice("Trynalist: that item is no longer in this document.");
			return;
		}
		this.pushNav();
		this.zoomRoot = id;
		this.focusId = id;
		this.render();
	}

	async revealItem(id: TrynaId): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const node = idx.nodes.get(id);
		if (!node) return;
		let p = node.parent ? idx.nodes.get(node.parent) : null;
		const seen = new Set<TrynaId>();
		while (p && !seen.has(p.id)) {
			seen.add(p.id);
			if (p.collapsed) await idx.setFlag(p.id, "collapsed", false);
			p = p.parent ? idx.nodes.get(p.parent) : null;
		}
		this.searchActive = false;
		this.searchQuery = "";
		this.zoomRoot = null;
		this.focusId = id;
		this.render();
		this.contentEl
			.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"]`)
			?.scrollIntoView({ block: "center" });
	}

	/** Fuzzy "jump to item" within this document. */
	openItemJump(): void {
		const idx = this.index;
		if (!idx) return;
		new ItemSuggestModal(this.app, idx, {
			placeholder: "Jump to item…",
			onChoose: (item) => { if (item) void this.revealItem(item.id); },
		}).open();
	}

	/** Fuzzy "move to…" — reparent the selection (or focused row). */
	/** Move a subtree into a DIFFERENT document: copy it there, then remove it
	 *  here. Deliberately copy-then-delete and confirmed first — this is the one
	 *  move that crosses a document boundary, and undo is per-document, so the
	 *  source side is undoable but the destination side is not. Saying so beats
	 *  discovering it. */
	private async moveAcrossDocuments(
		targets: TreeNode[],
		into: TreeNode,
		from: { index: DocIndex; title: string; isRoot?: boolean },
	): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const label = targets.length === 1
			? `"${targets[0].text || "(empty)"}"`
			: `${targets.length} items`;
		// Moved items get new ids in the other document (finding 8).
		if (!await this.confirmMirrorImpact(targets)) return;
		const ok = await new Promise<boolean>((resolve) => {
			new ConfirmModal(this.app, {
				title: `Move ${label} to "${from.title}"?`,
				body: `They will be added ${from.isRoot ? `at the top level of ${from.title}` : `under "${into.text || "(empty)"}" in ${from.title}`}, `
					+ "and removed from this document.\n\nUndo only covers this document, so "
					+ "the copy in the other document would have to be removed by hand.",
				cta: "Move",
				onConfirm: () => resolve(true),
				onCancel: () => resolve(false),
			}).open();
		});
		if (!ok) return;
		await this.flushPendingSaves();
		this.pushUndo();
		try {
			// A document stand-in means "the top level of that document".
			const destParent = from.isRoot ? null : into.id;
			for (const t of targets) {
				// The node itself, then everything under it. Appended at the END
				// of the destination, which is where a move should land.
				const clone = await from.index.createNode(
					t.text, destParent, from.index.children(destParent).at(-1)?.id ?? null,
				);
				// A move keeps the item's own checkbox and its creation time;
				// both were dropped here (M39, M12).
				// Its Dynalist provenance too, or the next Update re-creates it (M12).
				Object.assign(clone, carriedFields(t), movedFields(t), { checked: t.checked, due: t.due });
				await from.index.writeNode(clone);
				await copySubtree(idx, t.id, from.index, clone.id, { move: true });
			}
			if (!from.isRoot && into.collapsed) await from.index.setFlag(into.id, "collapsed", false);
			for (const t of targets) await idx.deleteNode(t.id);
			this.selection.clear();
			this.selectionAnchor = null;
			this.render();
			// The destination was written through its own fresh index; a tab
			// already open on it holds the old tree until it reloads (M24).
			void this.plugin.reloadDocViews(from.index.docRef.folder.path);
			new Notice(`Trynalist: moved ${label} to "${from.title}".`, 7000);
		} catch (e) {
			console.error("Trynalist: cross-document move failed", e);
			new Notice("Trynalist: that move failed part-way — check both documents. See console.", 10000);
		}
	}

	openMoveTo(): void {
		const idx = this.index;
		if (!idx) return;
		const targets = this.topLevelTargets();
		if (!targets.length) { new Notice("Trynalist: no item focused."); return; }
		// Can't move something into itself or its own subtree.
		const exclude = new Set<TrynaId>();
		for (const t of targets) {
			exclude.add(t.id);
			for (const d of idx.descendants(t.id)) exclude.add(d.id);
		}
		new ItemSuggestModal(this.app, idx, {
			placeholder: `Move ${targets.length} item${targets.length === 1 ? "" : "s"} to…`,
			exclude,
			rootLabel: "⌂ Top level of this document",
			// No match here? Look in every other document rather than dead-ending.
			widenRoot: this.plugin.settings.rootFolder,
			onChoose: (item, from) => { void (async () => {
				if (from && item) { await this.moveAcrossDocuments(targets, item, from); return; }
				await this.flushPendingSaves();
				this.pushUndo();
				let after = item ? (idx.children(item.id).at(-1)?.id ?? null) : (idx.children(null).at(-1)?.id ?? null);
				for (const t of targets) {
					if (await idx.move(t.id, item?.id ?? null, after)) after = t.id;
				}
				if (item?.collapsed) await idx.setFlag(item.id, "collapsed", false);
				this.render();
				new Notice(`Trynalist: moved ${targets.length} item${targets.length === 1 ? "" : "s"}.`);
			})(); },
		}).open();
	}

	// ── item links ([[ …) ────────────────────────────────────────────────

	/** Show the link popover when the caret sits just after an unclosed `[[`. */
	private async maybeShowLinkSuggest(el: HTMLElement): Promise<void> {
		// No `[[` anywhere in the row: nothing to suggest. textContent does not
		// force layout, so ordinary typing skips the innerText read (L83).
		if (!(el.textContent ?? "").includes("[[")) {
			this.linkSuggest?.close();
			return;
		}
		const caret = this.caretOffset(el);
		const before = el.innerText.slice(0, caret);
		const open = before.lastIndexOf("[[");
		if (open === -1 || before.indexOf("]]", open) !== -1) {
			this.linkSuggest?.close();
			return;
		}
		const query = before.slice(open + 2);
		if (query.includes("\n")) { this.linkSuggest?.close(); return; }
		// The popover is created once per view but must always write into the
		// row that is CURRENTLY being edited — capturing `el` in the callback
		// left later insertions writing into a detached element from an earlier
		// render, which silently did nothing.
		this.linkTargetEl = el;
		if (!this.linkSuggest) {
			this.linkSuggest = new LinkSuggest(this.app, this.plugin.settings.rootFolder, (target) => {
				const host = this.linkTargetEl;
				if (!host?.isConnected) {
					new Notice("Trynalist: that row is no longer being edited.");
					return;
				}
				this.insertLink(host, target.path, target.label);
			}, () => {
				const idx = this.index;
				return idx ? { folder: idx.docRef.folder.path, title: idx.docRef.manifest.title, nodes: idx.nodes.values() } : null;
			});
		}
		await this.linkSuggest.open(el, query);
	}

	/** Replace the in-progress `[[query` with a finished wikilink. */
	private insertLink(el: HTMLElement, path: string, label: string): void {
		const caret = this.caretOffset(el);
		const text = el.innerText;
		const before = text.slice(0, caret);
		const open = before.lastIndexOf("[[");
		if (open === -1) return;
		// Built by Obsidian rather than by hand. A hand-written `[[full/path|label]]`
		// ignores the user's "New link format" preference (shortest path / relative
		// / absolute) AND their Wikilinks toggle — so links came out as absolute
		// paths that broke the moment a document was renamed. generateMarkdownLink
		// emits exactly what Obsidian itself would write, which is also what its
		// rename-updater knows how to rewrite.
		const target = this.app.vault.getAbstractFileByPath(path);
		// The alias is the target's text, cleaned: its dates would become THIS
		// item's due date, its tags this item's tags, and a `]` or `|` would
		// end the link early (M44).
		const alias = label
			.replace(new RegExp(DATE_RE.source, "g"), " ")
			.replace(/[[\]|]/g, "")
			.replace(/(^|\s)[#@](?=[\w/-])/g, "$1")
			.replace(/\s+/g, " ")
			.trim() || (target instanceof TFile ? target.basename : path);
		const link = target instanceof TFile
			? this.app.fileManager.generateMarkdownLink(target, this.file?.path ?? "", undefined, alias)
			: `[[${path}|${alias}]]`;
		// Auto-pairing already put a `]]` after the caret when `[[` was typed.
		// Writing a complete link in front of it produced `[[a|b]]]]`, so eat
		// the closers that are sitting there waiting.
		let after = text.slice(caret);
		const trailing = /^\]{1,2}/.exec(after);
		if (trailing) after = after.slice(trailing[0].length);
		// `![[…]]` embeds a file. A Trynalist document is not a file you embed —
		// there is nothing to inline — so the link opens it instead, and the
		// bang would only render as an unresolved embed.
		let head = text.slice(0, open);
		if (path.endsWith(`.${DOC_EXTENSION}`) && head.endsWith("!")) head = head.slice(0, -1);
		const next = head + link + after;
		const open2 = head.length;
		el.setText(next);
		delete el.dataset.rendered;   // this IS raw source now
		// Put the caret after the inserted link.
		const sel = this.contentEl.doc.getSelection();
		const node = el.firstChild;
		if (sel && node && node.nodeType === Node.TEXT_NODE) {
			const range = this.contentEl.doc.createRange();
			range.setStart(node, Math.min(open2 + link.length, node.textContent?.length ?? 0));
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		}
		const id = el.closest<HTMLElement>(".trynalist-row")?.dataset.id;
		if (id) void this.saveRowNow(id, el);
	}

	/** Render one row's text as formatted DOM. Only ever used while the row is
	 *  NOT focused — a focused row shows raw source so editing (and therefore
	 *  saving) never sees rendered markup. */
	/** `readOnly`: text shown inside a mirror belongs to another item; its
	 *  date and chip handlers would edit that source (or, across documents,
	 *  silently nothing), so they are inert there (mirrors review finding 12). */
	private renderRowText(host: HTMLElement, text: string, nodeId?: TrynaId, readOnly = false): void {
		renderInline(host, text, {
			app: this.app,
			sourcePath: this.file?.path ?? "",
			inlineImages: this.plugin.settings.inlineImages,
			onLinkClick: (path) => void this.followLink(path),
			onUrlClick: (url) => this.openUrlOrVaultLink(url),
			onTagClick: (tag) => this.searchForTag(tag),
			onMathReady: () => ensureMathJax(() => this.scheduleMathRerender()),
			settings: this.plugin.settings,
			onDateClick: (raw) => { if (!readOnly) this.openDatePicker(raw, nodeId); },
			onImageClick: (file) => this.openImageViewer(file),
			onChipDelete: (raw) => { if (!readOnly) void this.removeChip(raw, nodeId); },
		});
	}

	/** One re-render after MathJax finishes loading, not one per math row. */
	private mathRerenderQueued = false;
	private scheduleMathRerender(): void {
		if (this.mathRerenderQueued) return;
		this.mathRerenderQueued = true;
		window.setTimeout(() => {
			this.mathRerenderQueued = false;
			if (this.index) this.render();
		}, 50);
	}

	/** Insert or edit a date on the focused row (`!(YYYY-MM-DD HH:mm)`).
	 *  `existing` is the raw source of a date chip that was clicked. */
	openDatePicker(existing?: string, nodeId?: TrynaId): void {
		const idx = this.index;
		if (!idx) return;
		// A chip click names its own row; otherwise fall back to the selection
		// or the focused row. (Using the focused row for a chip click edited
		// the wrong item entirely.)
		const node = nodeId ? idx.nodes.get(nodeId) ?? null : (this.actionTargets()[0] ?? null);
		if (!node) { new Notice("Trynalist: no item focused."); return; }
		// Edit the date the item already has, wherever it is written — not only
		// when a chip was clicked. The command palette and the mobile toolbar
		// pass nothing, and appending a second date there left the first one
		// as the due date (the earliest wins) while looking like an edit (M43).
		const inText = existing ?? DATE_RE.exec(withoutLinks(node.text))?.[0];
		const inNote = inText ? undefined : DATE_RE.exec(withoutLinks(node.note))?.[0];
		const raw = inText ?? inNote;
		const current = raw ? parseDate(raw) : null;
		new DatePickerModal(this.app, {
			initial: current?.iso ?? null,
			initialHasTime: current?.hasTime ?? false,
			initialRecurrence: current?.recurrence ?? null,
			settings: this.plugin.settings,
			onSubmit: async (iso, hasTime, recurrence) => {
				const target = idx.nodes.get(node.id);
				if (!target) return;
				await this.flushPendingSaves();
				this.pushUndo();
				const src = iso ? toSource(iso, hasTime, recurrence) : "";
				// Sentinel built from its char code, not written as a literal control
				// character in source or regex, so no-control-regex has nothing to flag;
				// behaviour (a one-off marker swapped out by stripMatches) is unchanged.
				const NUL = String.fromCharCode(0);
				const NUL_RE = new RegExp(NUL, "g");
				const swap = (body: string, old: string): string => src
					? body.replace(old, src)
					: stripMatches(body.replace(old, NUL), NUL_RE).trim();
				let next = target.text;
				let note = target.note;
				if (inText && target.text.includes(inText)) next = swap(target.text, inText);
				// In a note, touch only the date itself: trimming the whole note
				// would take its first-line indent with it.
				else if (inNote && target.note.includes(inNote)) {
					note = src ? target.note.replace(inNote, src) : target.note.replace(` ${inNote}`, "").replace(inNote, "");
				}
				else if (src) next = `${target.text} ${src}`.trim();
				await idx.setBody(target.id, next, note);
				this.patch({ rows: [target.id] });
			},
		}).open();
	}

	/** Alt+click on a date or tag removes it from the item, which is what
	 *  Dynalist binds Alt+Left click to. */
	private async removeChip(raw: string, nodeId?: TrynaId): Promise<void> {
		const idx = this.index;
		const node = nodeId ? idx?.nodes.get(nodeId) : null;
		if (!idx || !node) return;
		await this.flushPendingSaves();
		this.pushUndo();
		// The chip was clicked in the item's TEXT (notes render through
		// Obsidian's markdown renderer and have no chips), so only the text is
		// rewritten. A tag must match as a whole token, the way the renderer
		// found it — a raw substring cut "#work" out of "#workshop" and URLs.
		const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const re = /^[#@]/.test(raw)
			? new RegExp(`(?:^|(?<=\\s))${esc}(?![\\w/-])`, "g")
			: new RegExp(esc, "g");
		await idx.setBody(node.id, stripMatches(node.text, re).trim(), node.note);
		this.render();
		new Notice(`Trynalist: removed ${raw.startsWith("!") ? "the date" : raw}.`);
	}

	/** Clicking a tag searches this document for it (Dynalist behaviour). */
	private searchForTag(tag: string): void {
		this.searchActive = true;
		this.searchQuery = tag;
		this.render();
		const input = this.contentEl.querySelector<HTMLInputElement>(".trynalist-search input");
		if (input) input.value = tag;
	}

	/** A `[label](target)` link in item text. With Obsidian's "Use
	 *  [[Wikilinks]]" off, every link Trynalist writes to an item or note has
	 *  this shape, and sending it to openExternal refused it as "not http(s)"
	 *  — so none of them opened (M50). A vault target follows like a wikilink. */
	private openUrlOrVaultLink(url: string): void {
		if (/^https?:\/\//i.test(url)) { this.openExternal(url); return; }
		let target = url;
		try { target = decodeURIComponent(url); } catch { /* keep it as written */ }
		const dest = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(target), this.file?.path ?? "");
		if (dest) { void this.followLink(dest.path); return; }
		this.openExternal(url);   // explains why it cannot be opened
	}

	private openExternal(url: string): void {
		if (!/^https?:\/\//i.test(url)) {
			new Notice("Trynalist: only HTTP or HTTPS links can be opened.");
			return;
		}
		window.open(url, "_blank");
	}

	/** Open a linked target: a Trynalist item reveals inside its document. */
	async followLink(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Trynalist: "${path}" no longer exists.`);
			return;
		}
		if (file.extension === "md") {
			// An item file: find its document manifest and reveal the item.
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const itemId = fm?.id as string | undefined;
			const manifest = file.parent?.children.find(
				(c): c is TFile => c instanceof TFile && c.extension === "trynalist",
			);
			if (itemId && manifest) {
				if (manifest.path === this.file?.path) { await this.revealItem(itemId); return; }
				await this.plugin.openDocFile(manifest, itemId);
				return;
			}
		}
		// A link to an ordinary note follows the same rule — "anything else"
		// includes leaving Trynalist, and replacing the outline you were reading
		// with a note is the same loss.
		await this.plugin.openFileFromDoc(file, this.leaf);
	}

	// ── convert between items and documents ──────────────────────────────

	/** Promote the focused item (with its subtree) into its own document,
	 *  leaving a link behind so the outline still reaches it. */
	async convertItemToDoc(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const targets = this.topLevelTargets();
		if (!targets.length) { new Notice("Trynalist: no item focused."); return; }
		const node = targets[0];
		const title = node.text.trim() || "Untitled";
		// The items are recreated in the new document with new ids.
		if (!await this.confirmMirrorImpact([node])) return;
		await this.flushPendingSaves();
		this.pushUndo();
		try {
			const parentFolder = idx.docRef.folder.parent?.path ?? this.plugin.settings.rootFolder;
			const doc = await createDoc(this.app, parentFolder, title);
			const targetIndex = new DocIndex(this.app, doc);
			// The children MOVE (they are deleted here next), so they keep their
			// creation time and Dynalist provenance (M12).
			await copySubtree(idx, node.id, targetIndex, null, { move: true });
			// Replace the item with a link to the new document; its children
			// now live there, so remove them here.
			for (const child of [...idx.children(node.id)]) await idx.deleteNode(child.id);
			await idx.setBody(node.id, `[[${doc.file.path}|${title}]]`, node.note);
			this.render();
			new Notice(`Trynalist: created document "${title}".`);
		} catch (e) {
			console.error(e);
			new Notice("Trynalist: could not convert that item — see console.");
		}
	}

	/** Pull another document in as a child item of the focused row. */
	openConvertDocToItem(): void {
		const parentId = this.focusId;
		void this.openConvertDocToItemModal(parentId);
	}

	/** Load and open the "pull document in as item" picker. Split out from
	 *  {@link openConvertDocToItem} so the load-then-open chain has somewhere
	 *  to be awaited/voided instead of floating. */
	private async openConvertDocToItemModal(parentId: TrynaId | null): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const modal = new DocSuggestModal(this.app, this.plugin.settings.rootFolder, (doc) => {
			if (doc.file.path === this.file?.path) {
				new Notice("Trynalist: a document cannot be inserted into itself.");
				return;
			}
			new ConfirmModal(this.app, {
				title: `Insert "${doc.manifest.title}" as an item?`,
				// Archived, not trashed. Trashing followed Obsidian's trash setting
				// (which can be "permanent"), took the original's _attachments with
				// it — breaking every image the copies embed (M31) — and an undo of
				// this insert then removed the copies too, leaving neither (M30).
				// Archived, the original stays whole and out of the lists; undo only
				// ever removes the copies.
				body: "Its items are copied in here. The original document is then archived — hidden from your lists, with its attachments kept — so nothing is lost if this was a mistake. Unarchive it from the Archive pane.",
				cta: "Insert",
				onConfirm: async () => {
					await this.flushPendingSaves();
					this.pushUndo();
					try {
						const source = new DocIndex(this.app, doc);
						await source.load();
						const host = await idx.createNode(doc.manifest.title, parentId ?? null, null);
						await copySubtree(source, null, idx, host.id);
						await setDocArchived(this.app, doc, true);
						this.plugin.refreshPanels();
						this.focusId = host.id;
						this.render();
						new Notice(`Trynalist: inserted "${doc.manifest.title}" (original archived).`);
					} catch (e) {
						console.error(e);
						new Notice("Trynalist: could not insert that document — see console.");
					}
				},
			}).open();
		});
		const m = await modal.load();
		m.open();
	}

	/** Item / word / character counts for the document or the selection. */
	showWordCount(): void {
		const idx = this.index;
		if (!idx) return;
		const scope = this.selection.size ? this.actionTargets() : [...idx.nodes.values()];
		let words = 0;
		let chars = 0;
		let items = 0;
		const count = (n: TreeNode): number => {
			const text = `${n.text} ${n.note}`.trim();
			chars += text.length;
			return text.split(/\s+/).filter(Boolean).length;
		};
		// A mirror holds no text of its own; what it shows is counted apart,
		// so the document's own total stays what the document holds.
		let mirroredWords = 0;
		for (const n of scope) {
			if (!n.mirrorOf) { items++; words += count(n); continue; }
			const hit = this.mirrorHits.get(n.id);
			if (!hit?.ok) continue;
			const before = chars;
			const walk = (x: TreeNode): void => {
				if (!x.mirrorOf) mirroredWords += count(x);
				for (const k of hit.index.children(x.id)) walk(k);
			};
			for (const row of this.mirrorResolver?.rowsFor(hit, n.mirrorMode) ?? []) walk(row);
			chars = before;   // characters stay the document's own
		}
		const label = this.selection.size ? "selection" : "document";
		const extra = mirroredWords ? ` (+${mirroredWords} words shown through mirrors)` : "";
		new Notice(`Trynalist (${label}): ${items} items · ${words} words${extra} · ${chars} characters`, 8000);
	}

	// ── bookmarks ────────────────────────────────────────────────────────

	/** Save the current place: document, zoom root, and any active search. */
	bookmarkCurrentView(): void {
		const idx = this.index;
		if (!idx) return;
		const zoomed = this.zoomRoot ? idx.nodes.get(this.zoomRoot) : null;
		const suggested = [
			idx.docRef.manifest.title,
			zoomed?.text,
			this.searchQuery.trim() ? `“${this.searchQuery.trim()}”` : "",
		].filter(Boolean).join(" › ");
		new PromptModal(this.app, {
			title: "Bookmark this view",
			label: "Bookmark name",
			initial: suggested,
			cta: "Save",
			onSubmit: async (label) => {
				this.plugin.settings.bookmarks.push({
					id: `bm-${Date.now().toString(36)}`,
					label,
					docPath: idx.docRef.file.path,
					docId: idx.docRef.manifest.id,
					itemId: this.zoomRoot ?? undefined,
					query: this.searchQuery.trim() || undefined,
				});
				await this.plugin.saveSettings();
				this.plugin.refreshPanels();
				new Notice(`Trynalist: bookmarked "${label}".`);
			},
		}).open();
	}

	/** Apply a bookmark that points at the document already open here. */
	async applyBookmark(itemId: string | undefined, query: string | undefined): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		this.zoomRoot = itemId && idx.nodes.has(itemId) ? itemId : null;
		if (itemId && !idx.nodes.has(itemId)) {
			new Notice("Trynalist: that bookmarked item no longer exists — showing the whole document.");
		}
		this.searchActive = !!query;
		this.searchQuery = query ?? "";
		this.render();
	}

	// ── command entry points (all keybindable; no default chords) ────────

	/** Apply an operation to the selection, or to the focused row. */
	/** `repaint` says how much of the view the change can touch: just the
	 *  targets' rows (heading, colour, own checkbox), the targets' child lists
	 *  (fold state), or — the default, for anything inherited down a subtree
	 *  or reordering one — the whole document. */
	private async applyToTargets(
		fn: (idx: DocIndex, n: TreeNode) => Promise<void>,
		opts: { topLevelOnly?: boolean; repaint?: "rows" | "lists" | "full" } = {},
	): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const targets = opts.topLevelOnly ? this.topLevelTargets() : this.actionTargets();
		if (!targets.length) { new Notice("Trynalist: no item focused."); return; }
		await this.flushPendingSaves();
		this.pushUndo();
		for (const t of targets) await fn(idx, t);
		const ids = targets.map((t) => t.id);
		if (opts.repaint === "rows") this.patch({ rows: ids });
		else if (opts.repaint === "lists") this.patch({ lists: ids });
		else this.render();
	}

	/** Applying the level an item already has clears it — Dynalist marks the
	 *  current heading in its menu and clicking it again removes it. */
	async cmdSetHeading(level: number): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setHeading(n.id, n.heading === level ? 0 : level), { repaint: "rows" });
	}

	/** Dynalist's Ctrl+Shift+H walks through the heading levels it offers
	 *  (H1–H3) and back to none. */
	async cmdCycleHeading(): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setHeading(n.id, n.heading >= 3 ? 0 : n.heading + 1), { repaint: "rows" });
	}

	/** Ctrl+Shift+L walks the six colour labels and back to none. */
	async cmdCycleColor(): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setColor(n.id, n.color >= 6 ? 0 : n.color + 1), { repaint: "rows" });
	}

	async cmdSetColor(color: number): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setColor(n.id, n.color === color ? 0 : color), { repaint: "rows" });
	}

	/** Toggle this item's own checkbox. */
	async cmdToggleCheckbox(): Promise<void> {
		await this.applyToTargets(async (idx, n) => idx.setCheckbox(n.id, !n.checkbox), { repaint: this.effectiveHideCompleted() ? "full" : "rows" });
	}

	/** Add or remove checkboxes on every descendant, all levels. */
	async cmdCheckboxDeep(value: boolean): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setCheckboxDeep(n.id, value), { topLevelOnly: true });
	}

	/** Delete every checked item in the focused subtree, or the whole document. */
	async cmdDeleteChecked(scopeId?: TrynaId): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// A subtree only when asked for one: the item menu passes its row, a
		// block selection names its top item. From the palette or the toolbar
		// it is the whole document — using the focused row there quietly
		// limited "Delete checked items" to whatever the caret was in (L14).
		const scope = (scopeId ? idx.nodes.get(scopeId) : undefined)
			?? (this.selection.size ? this.topLevelTargets()[0] : undefined) ?? null;
		const doomedCount = (scope ? idx.descendants(scope.id) : [...idx.nodes.values()])
			.filter((n) => n.checked).length;
		if (!doomedCount) { new Notice("Trynalist: nothing is checked here."); return; }
		new ConfirmModal(this.app, {
			title: `Delete ${doomedCount} checked item${doomedCount === 1 ? "" : "s"}?`,
			body: scope
				? `Everything checked under "${scope.text || "this item"}" goes to the vault trash, children included.`
				: "Everything checked in this document goes to the vault trash, children included.",
			cta: "Delete",
			warning: true,
			onConfirm: async () => {
				const doomed = (scope ? idx.descendants(scope.id) : [...idx.nodes.values()]).filter((n) => n.checked);
				if (!await this.confirmMirrorImpact(doomed)) return;
				await this.flushPendingSaves();
				this.pushUndo();
				const removed = await idx.deleteChecked(scope?.id ?? null, { trashDir: this.trashDir() });
				this.render();
				new Notice(`Trynalist: deleted ${removed} item${removed === 1 ? "" : "s"}. Undo with the Trynalist undo command.`);
			},
		}).open();
	}

	async cmdToggleChecklist(): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setFlag(n.id, "checklist", !n.checklist));
	}

	async cmdToggleNumbered(): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setFlag(n.id, "numbered", !n.numbered));
	}

	/** Write a batch of fold changes (see DocIndex.setCollapsedMany), with a
	 *  progress notice when it is big enough to take a moment, then repaint. */
	private async applyFoldChanges(changes: Array<{ id: TrynaId; collapsed: boolean }>): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const notice = changes.length > 200 ? new Notice(`Trynalist: folding ${changes.length} items…`, 0) : null;
		try {
			await idx.setCollapsedMany(changes, (done, total) => notice?.setMessage(`Trynalist: folding ${done} of ${total} items…`));
		} finally {
			notice?.hide();
		}
		this.render();
	}

	/** Expand or collapse every item under the current zoom, as Dynalist's
	 *  Ctrl+Shift+Period does. */
	async cmdCollapseAll(collapsed: boolean): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		await this.flushPendingSaves();
		this.pushUndo();
		const changes: Array<{ id: TrynaId; collapsed: boolean }> = [];
		const walk = (parent: TrynaId | null): void => {
			for (const c of idx.children(parent)) {
				if (idx.children(c.id).length && c.collapsed !== collapsed) changes.push({ id: c.id, collapsed });
				walk(c.id);
			}
		};
		walk(this.zoomRoot);
		await this.applyFoldChanges(changes);
	}

	/** Grow the selection one level outward: the focused item, then its
	 *  parent's children, then the grandparent's, and so on. Dynalist binds
	 *  this to Ctrl+A, which Obsidian owns, so it is a command here. */
	/** Dynalist's Mod+A ladder. Each press widens by exactly one step:
	 *
	 *    1. the text of the line you are in (or of the note, if that is where
	 *       the caret sits) — a plain select-all, which is what every editor
	 *       does and what "once selects nothing" was missing;
	 *    2. that item as a block;
	 *    3. its siblings;
	 *    4. up a level, and so on to the whole document.
	 *
	 *  Step 1 was absent, so the first press appeared to do nothing and the
	 *  second jumped straight to a multi-item selection. */
	selectOneLevelUp(): void {
		const idx = this.index;
		if (!idx) return;

		const active = this.contentEl.doc.activeElement;
		const editable = active?.instanceOf(HTMLElement)
			&& (active.classList.contains("trynalist-text") || active.classList.contains("trynalist-note"))
			? active : null;

		// Step 1: select this line's text, unless it is already all selected.
		if (editable && !this.selection.size) {
			const sel = this.contentEl.doc.getSelection();
			const whole = editable.innerText;
			const chosen = sel?.toString() ?? "";
			if (whole.trim() && chosen !== whole) {
				const range = this.contentEl.doc.createRange();
				range.selectNodeContents(editable);
				sel?.removeAllRanges();
				sel?.addRange(range);
				return;
			}
			// A note used to STOP here — "a text field, not an outline row". That
			// left the ladder dead from the note: its text selected, and every
			// further press doing nothing. Dynalist widens out of the note into
			// the item that owns it, so the note is a rung rather than a
			// dead end. Hand the ladder its row and fall through to step 2.
			if (editable.classList.contains("trynalist-note")) {
				const owner = editable.parentElement
					?.querySelector<HTMLElement>(".trynalist-row")?.dataset.id;
				if (!owner) return;
				this.focusId = owner;
				this.contentEl.doc.getSelection()?.removeAllRanges();
			}
		}

		const seed = this.selection.size
			? [...this.selection].map((id) => idx.nodes.get(id)).filter((n): n is TreeNode => !!n)
			: (this.focusId ? [idx.nodes.get(this.focusId)].filter((n): n is TreeNode => !!n) : []);
		if (!seed.length) return;
		if (!this.selection.size) {
			// Step 2: the item itself. Using "<= 1" here made every press
			// re-select the same single item.
			this.setSelection(this.withDescendants(seed.map((n) => n.id)));
			this.selectionAnchor = seed[0].id;
			// Drop the text selection, or the row keeps a highlighted range
			// inside an already-highlighted block.
			this.contentEl.doc.getSelection()?.removeAllRanges();
			this.render();
			return;
		}
		// Steps 3+: climb to the PARENT and take its whole subtree, rather than
		// jumping straight to every sibling. Selecting a top-level item used to
		// widen to the entire document in one press, which skipped the step you
		// actually wanted — that item and its children.
		const shallowest = seed.reduce((a, b) => (a.depth <= b.depth ? a : b));
		const parent = shallowest.parent ? idx.nodes.get(shallowest.parent) : null;
		const scope = parent ? [parent] : idx.children(this.zoomRoot);
		const next = scope.map((n) => n.id);
		// Each step must GROW the selection. Climbing to an ancestor without
		// taking its subtree meant that in a single-child chain every press
		// swapped one highlighted row for another — the "highlight shifts up
		// instead of expanding" behaviour, exactly.
		const widened = this.withDescendants(next);
		if (widened.length <= this.selection.size && widened.every((id) => this.selection.has(id))) {
			// Nothing new at this level — climb one more.
			if (parent) {
				const up = parent.parent ? idx.children(parent.parent) : idx.children(this.zoomRoot);
				this.setSelection(this.withDescendants(up.map((n) => n.id)));
			}
		} else {
			this.setSelection(widened);
		}
		this.render();
	}

	async cmdToggleCollapse(): Promise<void> {
		await this.applyToTargets((idx, n) => idx.setFlag(n.id, "collapsed", !n.collapsed), { repaint: "lists" });
	}

	/** Collapse or expand every sibling of the focused item, leaving the item
	 *  itself alone — Dynalist's "Collapse all siblings". */
	async cmdCollapseSiblings(collapsed: boolean): Promise<void> {
		const idx = this.index;
		const n = this.focusId ? idx?.nodes.get(this.focusId) : null;
		if (!idx || !n) return;
		await this.flushPendingSaves();
		this.pushUndo();
		let touched = 0;
		for (const sib of idx.children(n.parent)) {
			if (sib.id === n.id) continue;
			if (!idx.children(sib.id).length || sib.collapsed === collapsed) continue;
			await idx.setFlag(sib.id, "collapsed", collapsed);
			touched++;
		}
		this.render();
		if (!touched) new Notice("Trynalist: no siblings to collapse.");
	}

	/** Show the tree down to `level` and no further: everything at a shallower
	 *  depth is expanded, everything at or below it is collapsed.
	 *
	 *  Depth is measured from the ZOOM ROOT, not from the document, so "level 2"
	 *  means the same thing wherever you are standing. */
	async cmdExpandToLevel(level: number): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		await this.flushPendingSaves();
		this.pushUndo();
		const changes: Array<{ id: TrynaId; collapsed: boolean }> = [];
		const walk = (parent: TrynaId | null, depth: number): void => {
			for (const c of idx.children(parent)) {
				if (idx.children(c.id).length) {
					const want = depth + 1 >= level;
					if (c.collapsed !== want) changes.push({ id: c.id, collapsed: want });
				}
				walk(c.id, depth + 1);
			}
		};
		walk(this.zoomRoot, 0);
		await this.applyFoldChanges(changes);
	}

	/** How deep the tree goes below the zoom root, so the "expand to level"
	 *  submenu offers real levels rather than a fixed one-to-four. */
	deepestLevel(): number {
		const idx = this.index;
		if (!idx) return 0;
		let deepest = 0;
		const walk = (parent: TrynaId | null, depth: number): void => {
			for (const c of idx.children(parent)) {
				if (depth > deepest) deepest = depth;
				walk(c.id, depth + 1);
			}
		};
		walk(this.zoomRoot, 1);
		return deepest;
	}

	/** Everything pointing at this item: mirrors in other documents, and any
	 *  Obsidian link to the item's own file.
	 *
	 *  Both halves matter and neither knows about the other — a mirror is our
	 *  construct and invisible to Obsidian's link graph, while a wikilink to the
	 *  item file is invisible to the mirror index. */
	async showReferences(n: TreeNode): Promise<void> {
		const idx = this.index;
		if (!idx || !this.file) return;
		const mirrors = await findMirrorsOf(
			this.app, this.plugin.settings.rootFolder, this.file.path, new Set([n.id]),
		);
		const backlinks: string[] = [];
		if (n.file) {
			const resolved = this.app.metadataCache.resolvedLinks;
			for (const [from, targets] of Object.entries(resolved)) {
				if (from === n.file.path) continue;
				if (targets[n.file.path]) backlinks.push(from);
			}
		}
		const mirrorCount = mirrors.reduce((sum, m) => sum + m.count, 0);
		if (!mirrorCount && !backlinks.length) {
			// Name on its own line: an item's text can be long, and running it
			// into the sentence made the message hard to scan.
			new Notice(`Trynalist: nothing points at:\n${trim(n.text || "(empty)")}`);
			return;
		}
		const lines: string[] = [];
		if (mirrorCount) {
			lines.push(`${mirrorCount} mirror${mirrorCount === 1 ? "" : "s"}:`);
			for (const m of mirrors) lines.push(`  • ${m.docTitle} (${m.count})`);
		}
		if (backlinks.length) {
			lines.push(`${backlinks.length} link${backlinks.length === 1 ? "" : "s"}:`);
			for (const path of backlinks.slice(0, 8)) lines.push(`  • ${path}`);
			if (backlinks.length > 8) lines.push(`  …and ${backlinks.length - 8} more`);
		}
		this.plugin.showNotice({
			message: `References to "${trim(n.text || "(empty)")}"\n${lines.join("\n")}`,
			kind: "info",
			duration: 0,
		});
	}

	/** Bookmark the focused item — the menu entry zooms first so the bookmark
	 *  records the item's own view, and the command bar must do the same or the
	 *  two would save different things under one name. */
	bookmarkFocusedItem(): void {
		if (!this.focusId) { new Notice("Trynalist: select an item first."); return; }
		this.pushNav();
		this.zoomRoot = this.focusId;
		this.render();
		this.bookmarkCurrentView();
	}

	/** References for whatever is focused, for the command bar — the menu entry
	 *  already has the node in hand. */
	async showReferencesForFocused(): Promise<void> {
		const n = this.focusId ? this.index?.nodes.get(this.focusId) : null;
		if (!n) { new Notice("Trynalist: select an item first."); return; }
		await this.showReferences(n);
	}

	/** Insert a saved outline as children of `n`.
	 *
	 *  Reuses the paste path rather than a second parser: a template IS an
	 *  indented outline, and the paste code already infers indent width, strips
	 *  list markers and pushes undo. A separate implementation here would be the
	 *  duplicate-serializer bug again, in the other direction. */
	async insertTemplate(outline: string, n: TreeNode): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		// Blank lines are kept: inside a note they are paragraph breaks, and
		// pasteMultiline drops the ones that are not part of a note.
		const lines = outline.replace(/\r\n?/g, "\n").split("\n");
		if (!lines.some((l) => l.trim())) { new Notice("Trynalist: that template is empty."); return; }
		this.pushUndo();
		// Land as CHILDREN of the item you invoked it on — a template is a
		// structure you are filling in under something, not a sibling of it.
		const first = await idx.createNode("", n.id, null);
		const row = this.contentEl.querySelector<HTMLElement>(
			`.trynalist-row[data-id="${cssId(first.id)}"] .trynalist-text`,
		);
		if (!row) {
			// The row has not painted yet; render, then retry once.
			this.render();
			await new Promise((done) => window.setTimeout(done, 80));
		}
		const target = this.contentEl.querySelector<HTMLElement>(
			`.trynalist-row[data-id="${cssId(first.id)}"] .trynalist-text`,
		);
		if (!target) { new Notice("Trynalist: could not place the template."); return; }
		await this.pasteMultiline(lines, idx.nodes.get(first.id) ?? first, target);
		if (!n.collapsed) this.render();
		else { await idx.setFlag(n.id, "collapsed", false); this.render(); }
		new Notice(`Trynalist: inserted ${lines.length} line${lines.length === 1 ? "" : "s"}.`);
	}

	/** Capture an item and its subtree as a reusable template. */
	async saveAsTemplate(n: TreeNode): Promise<void> {
		const had = this.selection.size;
		if (!had) { this.setSelection(this.withDescendants([n.id])); }
		const outline = this.outlineForSelection();
		if (!had) this.setSelection([]);
		if (!outline) { new Notice("Trynalist: nothing to save."); return; }
		new PromptModal(this.app, {
			title: "Save as template",
			label: "Name",
			cta: "Save",
			initial: n.text.slice(0, 60),
			onSubmit: async (name) => {
				const list = this.plugin.settings.templates ?? [];
				// Same name replaces, rather than growing a second entry you cannot
				// tell apart in the submenu.
				const at = list.findIndex((t) => t.name === name);
				if (at >= 0) list[at] = { name, outline };
				else list.push({ name, outline });
				this.plugin.settings.templates = list;
				await this.plugin.saveSettings();
				new Notice(`Trynalist: saved "${name}".`);
			},
		}).open();
	}

	async cmdSortChildren(mode: SortMode): Promise<void> {
		await this.applyToTargets((idx, n) => idx.sortChildren(n.id, mode), { topLevelOnly: true });
	}

	/** Check or uncheck the focused item — the toolbar's tick button. */
	async cmdToggleChecked(): Promise<void> {
		if (this.focusId) await this.toggleCheck(this.focusId);
	}

	/** Put the caret in the focused item's NOTE — the toolbar's note button.
	 *  On a phone Shift+Enter does not exist, so without this the note is
	 *  unreachable, and the note is where all the block markdown lives.
	 *
	 *  Delegates to the Shift+Enter path rather than repeating it: the first
	 *  attempt hand-rolled the lookup against `.trynalist-item[data-id]`, which
	 *  matches NOTHING — item elements carry no id, only rows do — so the note
	 *  was created and then never focused. */
	focusNoteOfFocused(): void {
		if (this.focusId) this.renderAndFocusNote(this.focusId);
	}

	/** Copy an Obsidian link to the focused item's own file, in the user's link
	 *  format — the same generator the `[[` popover uses, so it survives renames. */
	async copyItemLink(): Promise<void> {
		const id = this.focusId;
		const node = id ? this.index?.nodes.get(id) : null;
		if (!node?.file) { new Notice("Trynalist: select an item first."); return; }
		const link = this.app.fileManager.generateMarkdownLink(
			node.file, this.file?.path ?? "", undefined, node.text || "(empty item)",
		);
		try {
			await navigator.clipboard.writeText(link);
			new Notice("Trynalist: item link copied.");
		} catch (e) {
			console.error("Trynalist: could not copy the item link", e);
			new Notice("Trynalist: could not reach the clipboard.");
		}
	}

	/** Export the focused item and everything under it.
	 *
	 *  Dynalist opens a format dialog and writes a file; this copies the subtree
	 *  as an indented Markdown outline to the clipboard instead. Same content,
	 *  one step, and on a phone the clipboard is where it is going anyway — the
	 *  document-wide export dialog is still on the command palette. */
	async exportFocused(): Promise<void> {
		const text = this.outlineForSelection();
		if (!text) { new Notice("Trynalist: select an item first."); return; }
		try {
			await navigator.clipboard.writeText(text);
			this.rememberCopy(text);
			const lines = text.split("\n").filter((l) => l.trim()).length;
			new Notice(`Trynalist: ${lines} line${lines === 1 ? "" : "s"} copied.`);
		} catch (e) {
			console.error("Trynalist: export to clipboard failed", e);
			new Notice("Trynalist: could not reach the clipboard.");
		}
	}

	/** Attach a file to the focused item — the toolbar's "Upload a file". */
	uploadFileToFocused(): void {
		const id = this.focusId;
		const row = id
			? this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"] .trynalist-text`)
			: null;
		if (!id || !row) { new Notice("Trynalist: select an item first."); return; }
		const input = createEl("input", { type: "file" });
		input.multiple = true;
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
			const node = this.index?.nodes.get(id);
			if (node) void this.pasteFiles(files, node, row, false);
		});
		input.click();
	}

	/** Type a character into the focused row, as the keyboard would. Tag buttons
	 *  are just this — the point is the popover that follows the character. */
	insertAtCaret(text: string): void {
		const id = this.focusId;
		const el = id
			? this.contentEl.querySelector<HTMLElement>(`.trynalist-row[data-id="${cssId(id)}"] .trynalist-text`)
			: null;
		if (!el) { new Notice("Trynalist: select an item first."); return; }
		if (this.contentEl.doc.activeElement !== el) el.focus();
		this.insertPlainText(el, text);
	}

	async cmdIndent(outdent: boolean): Promise<void> { await this.bulkIndent(outdent); }
	async cmdMove(up: boolean): Promise<void> { await this.bulkMove(up); }

	/** Zoom into the focused row; with no focus, zoom out one level. */
	cmdZoomIn(): void {
		if (!this.focusId) { this.cmdZoomOut(); return; }
		this.pushNav();
		this.zoomRoot = this.focusId;
		this.render();
	}

	cmdZoomOut(): void {
		const idx = this.index;
		if (!idx || !this.zoomRoot) return;
		this.pushNav();
		this.zoomRoot = idx.nodes.get(this.zoomRoot)?.parent ?? null;
		this.render();
	}

	/** Archive or unarchive the open document. */
	async toggleArchived(): Promise<void> {
		const idx = this.index;
		if (!idx) return;
		const next = !idx.docRef.manifest.archived;
		await setDocArchived(this.app, idx.docRef, next);
		this.render();
		this.plugin.refreshPanels();
		new Notice(next
			? `Trynalist: "${idx.docRef.manifest.title}" archived — it stays where it is on disk, but leaves search and pickers.`
			: `Trynalist: "${idx.docRef.manifest.title}" unarchived.`);
	}

	/** Rename the document (title, folder, and manifest file together). */
	promptRenameDoc(): void {
		const idx = this.index;
		if (!idx) return;
		new PromptModal(this.app, {
			title: "Rename document",
			label: "Document name",
			initial: idx.docRef.manifest.title,
			cta: "Rename",
			onSubmit: async (value) => {
				try {
					await renameDoc(this.app, idx.docRef, value);
					this.render();
					// Refresh the tab header to the new title (not in the public
					// typings, so guard rather than assume).
					(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
				} catch (e) {
					new Notice(`Trynalist: ${e instanceof Error ? e.message : "rename failed"}`);
				}
			},
		}).open();
	}

	/** Search and replace, over the document or one item's subtree. */
	openReplace(): void {
		const idx = this.index;
		if (!idx) return;
		const focused = this.actionTargets()[0] ?? null;
		const scopeNodes = (subtree: boolean) =>
			subtree && focused ? [focused, ...idx.descendants(focused.id)] : [...idx.nodes.values()];
		const countIn = (text: string, find: string, matchCase: boolean) => {
			const hay = matchCase ? text : text.toLowerCase();
			const needle = matchCase ? find : find.toLowerCase();
			if (!needle) return 0;
			let n = 0;
			let i = hay.indexOf(needle);
			while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
			return n;
		};
		new ReplaceModal(this.app, {
			scopeLabel: focused ? (focused.text || "this item") : null,
			count: (find, matchCase, subtree) =>
				scopeNodes(subtree).reduce((n, node) =>
					n + countIn(node.text, find, matchCase) + countIn(node.note, find, matchCase), 0),
			onRun: async (find, replace, matchCase, subtree) => {
				await this.flushPendingSaves();
				this.pushUndo();
				const pattern = new RegExp(
					find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
					matchCase ? "g" : "gi",
				);
				let count = 0;
				for (const node of scopeNodes(subtree)) {
					const text = node.text.replace(pattern, () => { count++; return replace; });
					const note = node.note.replace(pattern, () => { count++; return replace; });
					if (text !== node.text || note !== node.note) await idx.setBody(node.id, text, note);
				}
				this.render();
				return count;
			},
		}).open();
	}

	/** Export in a chosen format, to the clipboard or a file — Dynalist offered
	 *  formatted, plain text and OPML, either way. */
	openExport(): void {
		const idx = this.index;
		if (!idx) return;
		const menu = new Menu();
		const formats: Array<[ExportFormat, string]> = [
			["formatted", "Formatted (markdown outline)"],
			["plain", "Plain text"],
			["opml", "OPML"],
		];
		for (const [format, label] of formats) {
			menu.addItem((i) => i.setTitle(`Copy — ${label}`).setIcon("clipboard-copy").onClick(async () => {
				await this.flushPendingSaves();
				await navigator.clipboard.writeText(renderExport(idx, format, await resolveAll(this.app, idx)));
				new Notice(`Trynalist: copied as ${label.toLowerCase()}.`);
			}));
		}
		menu.addSeparator();
		for (const [format, label] of formats) {
			menu.addItem((i) => i.setTitle(`Save file — ${label}`).setIcon("download").onClick(async () => {
				await this.flushPendingSaves();
				const path = await writeExportFile(this.app, idx, format);
				new Notice(`Trynalist: wrote ${path}`, 0);
			}));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Save .trynalist.zip (outline + metadata)").setIcon("file-archive")
			.onClick(() => void this.exportZip()));
		const rect = this.contentEl.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left + 40, y: rect.top + 40 });
	}

	/** Copy the document as an indented markdown outline — the interchange
	 *  format every outliner (including Stashpad's text importer) can read.
	 *  A file-level bridge, deliberately, rather than live shared folders. */
	async copyAsOutline(): Promise<void> {
		const idx = this.index;
		if (!idx) { new Notice("Trynalist: no document open."); return; }
		await this.flushPendingSaves();
		const md = renderOutlineMarkdown(idx, await resolveAll(this.app, idx));
		await navigator.clipboard.writeText(md);
		const lines = md.split("\n").filter((l) => l.trim()).length;
		new Notice(`Trynalist: copied ${lines} lines as an indented outline.`);
	}

	async exportZip(): Promise<void> {
		if (!this.index) { new Notice("Trynalist: no document open."); return; }
		await this.flushPendingSaves();
		await exportDocZip(this.app, this.index);
	}
}


/** Menu labels get the source's first few words, not a whole paragraph. */
function trim(s: string): string {
	const clean = s.trim() || "(empty)";
	return clean.length > 32 ? `${clean.slice(0, 30)}…` : clean;
}


/** Hit-test a point for a caret position. `caretPositionFromPoint` is the
 *  standard API and tried first; `caretRangeFromPoint` is the older WebKit
 *  one, kept as a fallback for a runtime where only it exists. Obsidian ships
 *  a Chromium new enough to support the standard call, so in practice this
 *  always takes the first branch — the fallback exists only for safety, and
 *  neither is guaranteed by the typings. */
function caretRangeAt(x: number, y: number): Range | null {
	const doc = activeDocument as Document & {
		caretRangeFromPoint?: (x: number, y: number) => Range | null;
		caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	};
	const pos = doc.caretPositionFromPoint?.(x, y);
	if (pos) {
		const range = activeDocument.createRange();
		range.setStart(pos.offsetNode, pos.offset);
		range.collapse(true);
		return range;
	}
	if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
	return null;
}


/** One line of a note, seen as a possible list item. `next` is the marker the
 *  following line should start with. */
function parseListLine(line: string): { content: string; next: string } | null {
	// Blockquote, possibly wrapping a list.
	const quote = /^(\s*>\s?)(.*)$/.exec(line);
	if (quote) {
		const inner = parseListLine(quote[2]);
		return inner
			? { content: inner.content, next: `${quote[1]}${inner.next}` }
			: { content: quote[2].trim(), next: quote[1] };
	}
	// Task item — the next one starts unchecked, whatever this one is.
	const task = /^(\s*)([-*+])\s+\[[ xX]\]\s+(.*)$/.exec(line);
	if (task) return { content: task[3].trim(), next: `${task[1]}${task[2]} [ ] ` };
	// Ordered — renumber.
	const ordered = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
	if (ordered) {
		return { content: ordered[4].trim(), next: `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]} ` };
	}
	// Plain bullet.
	const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
	if (bullet) return { content: bullet[3].trim(), next: `${bullet[1]}${bullet[2]} ` };
	return null;
}
