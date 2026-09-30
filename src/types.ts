import type { TFile, TFolder } from "obsidian";

export type TrynaId = string;

export const DOC_VIEW_TYPE = "trynalist-doc";
export const PANEL_VIEW_TYPE = "trynalist-panel";
export const DOC_EXTENSION = "trynalist";

/** Frontmatter Trynalist owns on every node file. Anything that clones or
 *  templates node files must never supply these — the plugin always wins. */
export const RESERVED_FRONTMATTER: readonly string[] = [
	"id", "doc", "parent", "order", "indent", "depth",
	"created", "modified", "checked", "checkbox", "checklist", "numbered", "collapsed",
	"heading", "color", "due",
	// Mirrors / portals — see dev-docs/mirrors-and-portals.md.
	"mirrorOf", "mirrorMode",
	// Set only by the folder converter, to restore the other plugin's home
	// note and attachment list on the return trip.
	"wasStashpadHome", "wasStashpadAttachments",
];

/** Folder names that are machinery, not documents. Ours plus Stashpad's, so a
 *  folder converted from that plugin doesn't sprout fake documents. A folder
 *  with one of these names is skipped by discovery entirely, and cannot be
 *  created or renamed to by the document commands. */
export const RESERVED_FOLDER_NAMES: ReadonlySet<string> = new Set([
	"_attachments", "_conversion-backups",
	"_archive", ".archive", "_authors", "_exports", "_imports",
	"_processed", "_deleted", "_trash", "_reports", ".stashpad", ".trynalist",
	// The raw-JSON archive an import run keeps beside its documents.
	"_source",
]);

/** The Trynalist trash folder, under the root. Deleted subtrees land here in
 *  dated groups until the trash is emptied. */
export const TRASH_FOLDER = "_trash";

export function isReservedFolderName(name: string): boolean {
	return RESERVED_FOLDER_NAMES.has(name);
}

/** Where a document keeps its own attachments — beside it, so they travel
 *  with the folder and match the convention Stashpad already uses. */
export const ATTACHMENTS_SUBFOLDER = "_attachments";

/** Dynalist offers 3 heading levels; we allow the full Markdown range. */
export const MAX_HEADING = 6;

export interface NodeFrontmatter {
	id: TrynaId;
	/** Doc id from the .trynalist manifest this node belongs to. */
	doc: TrynaId;
	/** Parent node id, or null when the node sits at the doc root. */
	parent: TrynaId | null;
	/** Fractional sort key among siblings (midpoint insertion; siblings are
	 *  renumbered 10, 20, 30… when the gap gets too small). */
	order: number;
	/** Indentation level as authored/imported. May be non-sequential when an
	 *  import used weird indent jumps — preserved verbatim. */
	indent: number;
	/** Normalized distance from the doc root (root children = 0), recomputed
	 *  from the parent chain on every write. This is the trustworthy one. */
	depth: number;
	created: string;
	modified: string;
	checked?: boolean;
	/** Per-item checkbox. Dynalist moved to this model in Feb 2020: a checkbox
	 *  belongs to the item you put it on, not to every descendant of a parent.
	 *  `checklist` below is the older inherited flag, still read so documents
	 *  written before this keep their checkboxes. */
	checkbox?: boolean;
	/** LEGACY "make children a checklist" — inherited by descendants. */
	checklist?: boolean;
	/** "Make children a numbered list" — descendants render 1. 2. 3. */
	numbered?: boolean;
	collapsed?: boolean;
	/** Heading level 0–6 (0 = plain item). */
	heading?: number;
	/** Due date parsed out of the item's `!(…)` syntax, ISO. Mirrored into
	 *  frontmatter so dates are queryable by Bases/Dataview and sortable
	 *  without re-parsing every line. The text remains the source of truth. */
	due?: string;
	/** Dynalist item color label 0–6 (0 = none). */
	color?: number;
}

export type MirrorMode = "item" | "children";

/** A parsed `mirrorOf` reference. */
export interface MirrorRef {
	/** Vault path of the source document's `.trynalist` manifest. */
	docPath: string;
	itemId: TrynaId;
}

export function parseMirrorRef(raw: string): MirrorRef | null {
	const hash = raw.lastIndexOf("#");
	if (hash <= 0 || hash === raw.length - 1) return null;
	return { docPath: raw.slice(0, hash), itemId: raw.slice(hash + 1) };
}

export function formatMirrorRef(docPath: string, itemId: TrynaId): string {
	return `${docPath}#${itemId}`;
}

export interface TreeNode {
	id: TrynaId;
	parent: TrynaId | null;
	order: number;
	indent: number;
	depth: number;
	created: string;
	modified: string;
	checked: boolean;
	checkbox: boolean;
	checklist: boolean;
	numbered: boolean;
	collapsed: boolean;
	heading: number;
	color: number;
	/** ISO due date parsed from the line's `!(…)`, or null. */
	due: string | null;
	/** First line of the file body — the outline line itself. */
	text: string;
	/** Rest of the body — the Dynalist-style "note" under the line. */
	note: string;
	/** Where this node's content actually lives, as `<manifest path>#<item id>`,
	 *  or null for an ordinary node. A mirror owns no text of its own: it is a
	 *  window onto a subtree that lives somewhere else, possibly in another
	 *  document. */
	mirrorOf: string | null;
	/** What the window shows. `item` mirrors the source item AND its subtree;
	 *  `children` is WorkFlowy's portal — the source's children only, without
	 *  the source line itself. One node type, two modes: the resolver, the
	 *  recursion guard, the missing-source state and the export rule are all
	 *  shared rather than written twice. */
	mirrorMode: MirrorMode;
	/** null = phantom: a freshly created blank row that lives only in RAM (no
	 *  SSD write). The file is created on the first save with real content —
	 *  which also names it from the text — or force-materialized the moment
	 *  the node takes part in structure (child, move, check…) so files on
	 *  disk never reference a nonexistent parent. */
	file: TFile | null;
	/** The id this item had in the system it was imported from (currently the
	 *  Dynalist node id). Persisted as frontmatter `dlId`. It is the stable key
	 *  that lets two separate import runs be diffed against each other — a
	 *  Trynalist id is freshly minted per import, so it cannot join runs. Absent
	 *  for anything not imported. */
	sourceId?: string;
	/** Where this item came from, e.g. "dynalist". Frontmatter `source`. */
	source?: string;
	/** The source document's permission level, mirrored onto each item so it's
	 *  queryable in Obsidian (Bases/Dataview read frontmatter, not the manifest
	 *  JSON). 0 none · 1 read-only · 2 edit · 3 manage · 4 owner. Frontmatter
	 *  `dlPermission` / `dlPermissionLabel`. */
	dlPermission?: number;
	dlPermissionLabel?: string;
	/** Source fields with no first-class column, preserved verbatim as
	 *  frontmatter `dlExtra` for data parity. Undefined when there are none. */
	dlExtra?: Record<string, unknown>;
	/** Set by an update when the item is gone from Dynalist (ISO time). Read so
	 *  an update can clear it without rewriting every file to find out. */
	dlRemoved?: string;
}

/** A node's full state at a point in time, for undo/redo. `path` records the
 *  file the node lived at (null = it was still a RAM-only phantom). */
export interface NodeSnapshot {
	id: TrynaId;
	mirrorOf: string | null;
	mirrorMode: MirrorMode;
	parent: TrynaId | null;
	order: number;
	indent: number;
	depth: number;
	created: string;
	modified: string;
	checked: boolean;
	checkbox: boolean;
	checklist: boolean;
	numbered: boolean;
	collapsed: boolean;
	heading: number;
	color: number;
	due: string | null;
	text: string;
	note: string;
	path: string | null;
	/** Import provenance, so undo of a delete/merge/cut brings an imported
	 *  item back WITH its dlId — without it, the next "Update from Dynalist"
	 *  (matched by dlId) added the whole branch again. Same meaning as on
	 *  TreeNode. */
	sourceId?: string;
	source?: string;
	dlPermission?: number;
	dlPermissionLabel?: string;
	dlExtra?: Record<string, unknown>;
	dlRemoved?: string;
}

/** One copied item with everything it carries, for pasting back inside
 *  Trynalist without losing what plain text cannot say (see
 *  TrynalistPlugin.itemClipboard). */
export interface ClipNode {
	text: string;
	note: string;
	checkbox: boolean;
	checked: boolean;
	checklist: boolean;
	numbered: boolean;
	collapsed: boolean;
	heading: number;
	color: number;
	mirrorOf: string | null;
	mirrorMode: MirrorMode;
	children: ClipNode[];
}

/** JSON stored in the per-doc `<Doc>.trynalist` file. Doubles as the
 *  click-target in the panel/file explorer and the manifest inside exports. */
export interface DocManifest {
	format: "trynalist-doc";
	version: 1;
	id: TrynaId;
	title: string;
	created: string;
	modified: string;
	/** Archived documents stay exactly where they are on disk (moving them
	 *  would break every stored path); the panel just files them away. */
	archived?: boolean;
	/** The Dynalist file id this document was imported from, when it was. Lets
	 *  the import-diff join the same document across two separate runs even if
	 *  it was renamed in between. Absent for documents created here. */
	dlFileId?: string;
	/** Import provenance on the document itself. `source` e.g. "dynalist";
	 *  permission is the account's access to the original (0–4, see TreeNode);
	 *  importedAt is the ISO time of the run. Absent for documents created here. */
	source?: string;
	dlPermission?: number;
	dlPermissionLabel?: string;
	dlImportedAt?: string;
	/** The user chose to render this shared document's notes in full
	 *  (code-block processors, remote images). See untrusted.ts. */
	trusted?: boolean;
	/** The Dynalist document version number at import time (from doc/read). */
	dlVersion?: number;
	/** Set (to an ISO time) by an update when this document is gone from Dynalist
	 *  — marked, not deleted. */
	dlRemoved?: string;
}

export interface DocRef {
	manifest: DocManifest;
	folder: TFolder;
	file: TFile;
}

/** A saved place: a document, optionally zoomed to an item and/or carrying a
 *  saved search. Stored by manifest path + item id, so renames of the item's
 *  text don't break it (a moved/renamed FOLDER does — resolved on open). */
export interface Bookmark {
	id: string;
	label: string;
	docPath: string;
	docId: TrynaId;
	itemId?: TrynaId;
	query?: string;
}

export type Density = "compact" | "cozy" | "comfortable";
/** How a document is presented.
 *  - outline: the nested editor (default)
 *  - flat: every descendant in one list with its breadcrumb (Stashpad-style)
 *  - article: read-only prose, headings become headings and items paragraphs */
export type DocViewMode = "outline" | "flat" | "article" | "mindmap";
/** How the note under an item is displayed (Dynalist's "hide notes"). */
export type NoteDisplay = "full" | "one-line" | "hidden";
export type TextDirection = "ltr" | "rtl";
/** Which shape a search takes. Global opens its own view, so it is a
 *  destination rather than a mode, but it belongs in the same switcher. */
export type SearchMode = "doc" | "flat" | "global";
/** Dynalist's sort-by list for flat results. */
export type SearchSort =
	| "none"
	| "alpha" | "alpha-desc"
	| "due" | "due-desc"
	| "unchecked-first" | "checked-first"
	| "edited-new" | "edited-old"
	| "created-new" | "created-old";

export interface TrynalistSettings {
	rootFolder: string;
	/** Dynalist API secret, ENCRYPTED at rest via the OS keychain (Electron
	 *  safeStorage). Base64 ciphertext, decrypted only in memory when a request
	 *  is made. Empty when unset or when the token is being held in the
	 *  plaintext fallback below. */
	dynalistTokenEnc: string;
	/** Plaintext fallback used ONLY when the keychain is unavailable (e.g. a
	 *  Linux box with no keyring). Empty whenever encryption succeeded — the two
	 *  are never both populated. */
	dynalistToken: string;
	/** Import documents that were shared WITH the user (permission < owner), not
	 *  just ones they own. Default on. */
	importShared: boolean;
	/** Keep an immutable snapshot of the raw Dynalist responses (file/list + each
	 *  doc/read) in a `_source` folder per import run — rebuild insurance.
	 *  Default on. */
	keepImportSource: boolean;
	strikeCompleted: boolean;
	/** Open documents in a NEW tab rather than replacing the current one.
	 *  Obsidian exposes no readable 'always open in new tab' preference —
	 *  only `focusNewTab`, which is a different question — so this is ours. */
	openInNewTab: boolean;
	/** Mobile toolbar contents, in order. Ids from TOOLBAR_ACTIONS; an empty
	 *  array means "use the default set", so a fresh install and a deliberate
	 *  reset behave the same. */
	mobileToolbar: string[];
	/** Item-menu entry ids, in the user's order. Empty means source order.
	 *  Ids added by a later version are appended, never dropped. */
	itemMenuOrder: string[];
	/** Entry ids the user has hidden. */
	itemMenuHidden: string[];
	/** Saved subtrees, insertable under any item. Stored as the same indented
	 *  outline the clipboard uses, so a template can be written by hand, pasted
	 *  in from anywhere, or captured from an existing item. */
	templates: Array<{ name: string; outline: string }>;
	/** Reading direction for outlines. Per document overrides this. */
	textDirection: TextDirection;
	/** Layout a document opens in when it has no override of its own. */
	defaultViewMode: DocViewMode;
	/** Per-document overrides of the visibility settings. A document ABSENT from
	 *  one of these follows the global setting — which is what "Global" means in
	 *  the visibility menu, and why these are sparse records rather than a value
	 *  stamped onto every document. */
	docHideCompleted: Record<string, boolean>;
	docNoteDisplay: Record<string, NoteDisplay>;
	docTextDirection: Record<string, TextDirection>;
	hideCompleted: boolean;
	bookmarks: Bookmark[];
	/** Automatic local snapshots of settings (on change) and the outline (daily)
	 *  in the hidden .trynalist-backups folder — see safety-net.ts. */
	safetyNet: boolean;
	/** Include attachments in the daily outline snapshot (bigger archives). */
	safetyNetAttachments: boolean;
	/** Log every item version (local or synced) for 30 days — part of the
	 *  safety net, so it also needs `safetyNet`. */
	itemHistory: boolean;
	/** Manifest paths, most recent first. */
	recentDocs: string[];
	recentLimit: number;
	// Appearance (Dynalist preferences reference)
	density: Density;
	noteDisplay: NoteDisplay;
	inlineImages: boolean;
	highlightCurrentItem: boolean;
	centerAlign: boolean;
	documentBorder: boolean;
	tagBackground: boolean;
	/** Dynalist's default is that the BULLET collapses and a magnifier icon
	 *  zooms; Preferences → Control swaps them, which is what this mirrors. */
	bulletClick: "zoom" | "collapse";
	/** Pair brackets and markdown marks as you type, and wrap a selection when
	 *  you type one over it — the way Obsidian's editor and VS Code behave. */
	autoPair: boolean;
	/** Spaces per level when copying an outline to the clipboard. 0 = a real
	 *  tab. Spaces by default: tabs are dropped by many editors and chat boxes,
	 *  so a tab-indented copy arrives flat. */
	copyIndentSpaces: number;
	/** Skip empty items when copying an outline. On by default: a copy is
	 *  usually going somewhere else, and stray bare bullets are noise there. */
	copySkipEmpty: boolean;
	/** Enter on an empty item outdents it instead of making another sibling. */
	enterOnEmptyOutdents: boolean;
	/** Last focused item per document, so reopening lands where you left. */
	lastFocus: Record<string, string>;
	/** Percentage scale for Trynalist views only, independent of Obsidian's own
	 *  zoom. 100 = the theme's own size. */
	textScale: number;
	/** Per-document overrides, keyed by manifest path. Absent = use the global. */
	docScale: Record<string, number>;
	// Dates
	/** moment.js format for the date part, e.g. "MMM D, YYYY". */
	dateFormat: string;
	timeFormat: "12" | "24";
	/** 12-hour clock only: show the AM/PM suffix. */
	showAmPm: boolean;
	firstDayOfWeek: "sunday" | "monday" | "saturday";
	highlightOverdue: boolean;
	/** What checking off a recurring item does (Dynalist offered both). */
	recurrenceMode: "new-item" | "advance-in-place";
	// Reminders (see dev-docs/reminders.md)
	remindersEnabled: boolean;
	/** Minutes before a timed item's due moment to raise the toast. */
	reminderLeadMinutes: number;
	quietHoursEnabled: boolean;
	quietHoursFrom: string;
	quietHoursTo: string;
	/** Whole days that are quiet, as ISO weekday numbers (1 = Monday … 7 =
	 *  Sunday). ISO rather than JavaScript's 0 = Sunday, because the week starts
	 *  on Monday here and a list that starts at its own index 1 is easier to
	 *  reason about than one that starts at 1 and wraps to 0. */
	quietDays: number[];
	/** The last thing searched for, kept across sessions. A search you were part
	 *  way through should still be there when you come back — and it was already
	 *  surviving within a session, just unpredictably. */
	lastSearchQuery: string;
	/** Sort applied to FLAT search results. "none" is document order. */
	searchSort: SearchSort;
	snoozeMinutes: number;
	/** Show the agenda (overdue / today / this week) in the documents panel. */
	showAgenda: boolean;
	agendaHorizonDays: number;
	/** Per-document presentation, keyed by manifest path. */
	viewModes: Record<string, DocViewMode>;
	// Capture
	/** Manifest path of the document new captures are appended to. */
	inboxDocPath: string;
	/** Optional item the inbox appends under, set from an item's menu. */
	inboxItemId?: string;
	/** Panel sections the user collapsed, by key. Every section in the combined
	 *  panel is collapsible, and the state survives a reload. */
	collapsedSections: string[];
	showArchived: boolean;
	/** Include archived documents in cross-document search and pickers. */
	searchArchived: boolean;
}

export const DEFAULT_SETTINGS: TrynalistSettings = {
	openInNewTab: true,
	mobileToolbar: [],
	itemMenuOrder: [],
	itemMenuHidden: [],
	templates: [],
	textDirection: "ltr",
	defaultViewMode: "outline",
	docHideCompleted: {},
	docNoteDisplay: {},
	docTextDirection: {},
	rootFolder: "Trynalist",
	dynalistTokenEnc: "",
	dynalistToken: "",
	importShared: true,
	keepImportSource: true,
	strikeCompleted: true,
	hideCompleted: false,
	bookmarks: [],
	safetyNet: true,
	safetyNetAttachments: false,
	itemHistory: true,
	recentDocs: [],
	recentLimit: 8,
	density: "cozy",
	noteDisplay: "full",
	inlineImages: true,
	highlightCurrentItem: true,
	centerAlign: false,
	documentBorder: false,
	tagBackground: true,
	bulletClick: "collapse",
	dateFormat: "MMM D, YYYY",
	timeFormat: "12",
	showAmPm: true,
	firstDayOfWeek: "sunday",
	highlightOverdue: true,
	recurrenceMode: "new-item",
	remindersEnabled: true,
	reminderLeadMinutes: 0,
	quietHoursEnabled: false,
	quietHoursFrom: "22:00",
	quietHoursTo: "07:00",
	quietDays: [],
	lastSearchQuery: "",
	searchSort: "none",
	snoozeMinutes: 60,
	showAgenda: true,
	agendaHorizonDays: 7,
	viewModes: {},
	inboxDocPath: "",
	autoPair: true,
	copyIndentSpaces: 2,
	copySkipEmpty: true,
	enterOnEmptyOutdents: true,
	lastFocus: {},
	textScale: 100,
	docScale: {},
	collapsedSections: [],
	showArchived: false,
	searchArchived: false,
};
