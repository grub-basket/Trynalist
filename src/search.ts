import { App, FuzzySuggestModal, SuggestModal } from "obsidian";
import type { DocIndex } from "./store";
import { DocIndex as DocIndexCtor, listDocs, loadReadOnlyIndex } from "./store";
import type { Bookmark, DocRef, TreeNode, TrynaId } from "./types";
import { DATE_RE, compareToDate, matchesDateWindow, parseDate } from "./dates";

/** Sift: all tokens, any order, case-insensitive substring. Every whitespace-
 *  separated token in the query must appear somewhere in the haystack. Used by
 *  every search/filter input so they all behave the same way. */
export function sift(haystack: string, query: string): boolean {
	const hay = haystack.toLowerCase();
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return true;
	return tokens.every((t) => hay.includes(t));
}

// ── query language ──────────────────────────────────────────────────────
// Dynalist's search operators. Date operators (`within:`, `since:`, `until:`,
// `edited:`, `created:`) arrive with Phase D dates; `has:date` already works
// against the `!(…)` syntax so imported documents behave sensibly.

export interface QueryTerm {
	negated: boolean;
	kind: "text" | "field";
	/** field name for kind === "field" (is/has/in/color/heading/parent/ancestor) */
	field?: string;
	value: string;
}

/** OR-separated groups; every term within a group must match. */
export type ParsedQuery = QueryTerm[][];

const FIELDS = new Set([
	"is", "has", "in", "color", "heading", "parent", "ancestor",
	"within", "since", "until", "created", "edited",
]);

export function parseQuery(query: string): ParsedQuery {
	const groups: ParsedQuery = [[]];
	// Tokenise, keeping quoted phrases intact.
	const tokens = query.match(/-?"[^"]*"|\S+/g) ?? [];
	for (const raw of tokens) {
		if (raw === "OR" || raw === "|") { groups.push([]); continue; }
		let token = raw;
		let negated = false;
		if (token.startsWith("-")) { negated = true; token = token.slice(1); }
		const phrase = token.startsWith('"') && token.endsWith('"') && token.length > 1;
		if (phrase) {
			groups[groups.length - 1].push({ negated, kind: "text", value: token.slice(1, -1) });
			continue;
		}
		const colon = token.indexOf(":");
		if (colon > 0) {
			const field = token.slice(0, colon).toLowerCase();
			const value = token.slice(colon + 1).replace(/^"|"$/g, "");
			if (FIELDS.has(field)) {
				groups[groups.length - 1].push({ negated, kind: "field", field, value: value.toLowerCase() });
				continue;
			}
		}
		if (token) groups[groups.length - 1].push({ negated, kind: "text", value: token });
	}
	return groups.filter((g) => g.length);
}

const COLOR_NAMES = ["none", "red", "orange", "yellow", "green", "blue", "purple"];

/** Does an item satisfy a parsed query? */
export function matchesQuery(index: DocIndex, n: TreeNode, parsed: ParsedQuery): boolean {
	if (!parsed.length) return true;
	return parsed.some((group) => {
		// `in:title` / `in:note` narrows what the plain-text terms look at.
		const scopes = group.filter((t) => t.field === "in" && !t.negated).map((t) => t.value);
		const haystack = scopes.length
			? scopes.map((s) => (s === "note" ? n.note : n.text)).join(" ")
			: `${n.text} ${n.note}`;
		return group.every((term) => {
			const hit = termMatches(index, n, term, haystack);
			return term.negated ? !hit : hit;
		});
	});
}

function termMatches(index: DocIndex, n: TreeNode, term: QueryTerm, haystack: string): boolean {
	if (term.kind === "text") return haystack.toLowerCase().includes(term.value.toLowerCase());
	const v = term.value;
	switch (term.field) {
		case "in":
			return true; // handled by the scope above
		case "is":
			if (v === "completed" || v === "checked" || v === "done") return n.checked;
			if (v === "heading") return n.heading > 0;
			if (v === "checklist") return n.checklist || hasChecklistAncestor(index, n);
			if (v === "numbered") return n.numbered;
			if (v === "collapsed") return n.collapsed;
			if (v === "recurring") return !!parseDate(DATE_RE.exec(`${n.text} ${n.note}`)?.[0] ?? "")?.recurrence;
			return false;
		case "has":
			// The same test the row uses to draw a box: its own checkbox, a
			// ticked state, or a checklist ancestor. `checkbox` was missing, so
			// every unticked to-do was left out (M45/M46).
			if (v === "checkbox") return n.checkbox || n.checked || hasChecklistAncestor(index, n);
			if (v === "note") return n.note.trim().length > 0;
			if (v === "color") return n.color > 0;
			if (v === "children") return index.children(n.id).length > 0;
			if (v === "date") return !!n.due;
			if (v === "link") return /\[\[[^\]]+\]\]/.test(`${n.text} ${n.note}`);
			return false;
		case "color": {
			const wanted = /^\d+$/.test(v) ? parseInt(v, 10) : COLOR_NAMES.indexOf(v);
			return wanted >= 0 && n.color === wanted;
		}
		case "heading":
			return /^\d+$/.test(v) && n.heading === parseInt(v, 10);
		// Date operators work off the item's parsed due date, except
		// created:/edited:, which use the file's own timestamps.
		case "within":
			return !!n.due && matchesDateWindow(n.due, v);
		case "since":
			return !!n.due && compareToDate(n.due, v, "since");
		case "until":
			return !!n.due && compareToDate(n.due, v, "until");
		case "created":
			return compareToDate(n.created, v, "since");
		case "edited":
			return compareToDate(n.modified, v, "since");
		case "parent": {
			const p = n.parent ? index.nodes.get(n.parent) : null;
			return !!p && p.text.toLowerCase().includes(v);
		}
		case "ancestor": {
			let p = n.parent ? index.nodes.get(n.parent) : null;
			const seen = new Set<TrynaId>();
			while (p && !seen.has(p.id)) {
				if (p.text.toLowerCase().includes(v)) return true;
				seen.add(p.id);
				p = p.parent ? index.nodes.get(p.parent) : null;
			}
			return false;
		}
		default:
			return false;
	}
}

function hasChecklistAncestor(index: DocIndex, n: TreeNode): boolean {
	let p = n.parent ? index.nodes.get(n.parent) : null;
	const seen = new Set<TrynaId>();
	while (p && !seen.has(p.id)) {
		if (p.checklist) return true;
		seen.add(p.id);
		p = p.parent ? index.nodes.get(p.parent) : null;
	}
	return false;
}

/** Human-readable summary of what a query will do — shown under the input so
 *  a typo like `is:complete` is visible rather than silently matching nothing. */
export function describeQuery(parsed: ParsedQuery): string {
	if (!parsed.length) return "";
	return parsed
		.map((group) =>
			group
				.map((t) => {
					const body = t.kind === "field" ? `${t.field}:${t.value}` : `"${t.value}"`;
					return t.negated ? `not ${body}` : body;
				})
				.join(" and "),
		)
		.join("  OR  ");
}

/** Breadcrumb trail for an item, used as the suggestion's subtitle. */
export function trailFor(index: DocIndex, n: TreeNode): string {
	const parts: string[] = [];
	let p = n.parent ? index.nodes.get(n.parent) : null;
	const seen = new Set<TrynaId>();
	while (p && !seen.has(p.id)) {
		parts.unshift(p.text || "(empty)");
		seen.add(p.id);
		p = p.parent ? index.nodes.get(p.parent) : null;
	}
	return parts.join(" › ");
}

/** Pick an item inside the open document (jump, or choose a move target). */
export class ItemSuggestModal extends SuggestModal<TreeNode> {
	/** Items from OTHER documents, loaded only once the current document has
	 *  nothing to offer. Reading every index up front would make the picker
	 *  slow to open for the common case, which is a move within one document. */
	private wider: TreeNode[] | null = null;
	private widerIndexes = new Map<TrynaId, { index: DocIndex; title: string; isRoot?: boolean }>();
	private loadingWider = false;

	constructor(
		app: App,
		private index: DocIndex,
		private opts: {
			placeholder: string;
			/** Items that must not be offered (e.g. the subtree being moved). */
			exclude?: Set<TrynaId>;
			/** Offered as the first choice when set, for "move to top level". */
			rootLabel?: string;
			/** When set, a query with no local matches falls back to every other
			 *  document under this root. */
			widenRoot?: string;
			onChoose: (item: TreeNode | null, from?: { index: DocIndex; title: string; isRoot?: boolean }) => void;
		},
	) {
		super(app);
		this.setPlaceholder(opts.placeholder);
	}

	/** Load every other document's items, once. */
	private async loadWider(): Promise<void> {
		if (this.wider || this.loadingWider || !this.opts.widenRoot) return;
		this.loadingWider = true;
		const out: TreeNode[] = [];
		try {
			const docs = await listDocs(this.app, this.opts.widenRoot);
			for (const doc of docs) {
				if (doc.file.path === this.index.docRef.file.path) continue;
				const idx = new DocIndexCtor(this.app, doc);
				await idx.load();
				// A stand-in for the document itself, so an EMPTY document — or
				// one whose items you cannot recall — is still a destination
				// rather than a dead end.
				const rootStub = {
					id: `__doc__${doc.manifest.id}`,
					parent: null, order: 0, indent: 0, depth: 0,
					created: doc.manifest.created, modified: doc.manifest.modified,
					checked: false, checkbox: false, checklist: false, numbered: false,
					collapsed: false, heading: 0, color: 0, due: null,
					mirrorOf: null, mirrorMode: "item" as const,
					text: `${doc.manifest.title} — top level`,
					note: "", file: null,
				} as TreeNode;
				this.widerIndexes.set(rootStub.id, { index: idx, title: doc.manifest.title, isRoot: true });
				out.push(rootStub);
				for (const node of idx.nodes.values()) {
					this.widerIndexes.set(node.id, { index: idx, title: doc.manifest.title });
					out.push(node);
				}
			}
		} catch (e) {
			console.error("Trynalist: cross-document search failed", e);
		}
		this.wider = out;
		this.loadingWider = false;
	}

	async getSuggestions(query: string): Promise<TreeNode[]> {
		const local = this.localMatches(query);
		if (local.length || !query.trim() || !this.opts.widenRoot) return local;
		// Nothing here — widen, as the user asked for rather than dead-ending.
		await this.loadWider();
		return (this.wider ?? [])
			// The document's NAME counts as part of an item's searchable text
			// out here: people look for "move to <document>", not for an item
			// inside it whose wording they cannot remember.
			.filter((n) => {
				const from = this.widerIndexes.get(n.id);
				return sift(`${n.text} ${n.note} ${from?.title ?? ""}`, query);
			})
			.slice(0, 200);
	}

	private localMatches(query: string): TreeNode[] {
		const all = [...this.index.nodes.values()]
			.filter((n) => !this.opts.exclude?.has(n.id))
			.filter((n) => sift(`${n.text} ${n.note}`, query));
		// Document order keeps results predictable.
		const order = new Map<TrynaId, number>();
		let i = 0;
		const walk = (parent: TrynaId | null) => {
			for (const c of this.index.children(parent)) { order.set(c.id, i++); walk(c.id); }
		};
		walk(null);
		return all.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, 200);
	}

	renderSuggestion(item: TreeNode, el: HTMLElement): void {
		el.createDiv({ text: item.text || "(empty item)" });
		const from = this.widerIndexes.get(item.id);
		if (from) {
			// Say which document, or a cross-document move looks like a move
			// within this one.
			const trail = trailFor(from.index, item);
			el.createDiv({
				cls: "trynalist-suggest-trail",
				text: trail ? `${from.title} › ${trail}` : from.title,
			});
			return;
		}
		const trail = trailFor(this.index, item);
		if (trail) el.createDiv({ cls: "trynalist-suggest-trail", text: trail });
	}

	onChooseSuggestion(item: TreeNode): void {
		this.opts.onChoose(item, this.widerIndexes.get(item.id));
	}

	onOpen(): void {
		super.onOpen();
		if (!this.opts.rootLabel) return;
		// A fixed "top level" entry, since the doc root is not an item.
		const host = this.modalEl.querySelector(".prompt-results");
		if (!host) return;
		const row = host.createDiv({ cls: "suggestion-item mod-complex trynalist-root-choice" });
		row.createDiv({ text: this.opts.rootLabel });
		row.addEventListener("click", () => { this.opts.onChoose(null); this.close(); });
		host.prepend(row);
	}
}

export interface GlobalHit {
	doc: DocRef;
	index: DocIndex;
	node: TreeNode;
}

/** Search every document in the vault (results are capped).
 *
 *  - `cache`: loaded indexes by manifest path, reused and filled in. A search
 *    UI that keeps one for the length of a session reads each document once,
 *    not once per keystroke — reading every item file is the whole cost.
 *  - `stop`: checked between documents; a superseded search gives up there
 *    instead of reading the rest of the vault for results nobody will see. */
export async function searchAllDocs(
	app: App,
	rootFolder: string,
	query: string,
	limit = 300,
	includeArchived = false,
	opts: { cache?: Map<string, DocIndex>; stop?: () => boolean } = {},
): Promise<GlobalHit[]> {
	const parsed = parseQuery(query);
	if (!parsed.length) return [];
	const docs = await listDocs(app, rootFolder, { includeArchived });
	const hits: GlobalHit[] = [];
	for (const doc of docs) {
		if (opts.stop?.()) return hits;
		let index = opts.cache?.get(doc.file.path);
		if (!index) {
			index = await loadReadOnlyIndex(app, doc);
			opts.cache?.set(doc.file.path, index);
		}
		for (const node of index.nodes.values()) {
			if (matchesQuery(index, node, parsed)) hits.push({ doc, index, node });
			if (hits.length >= limit) return hits;
		}
	}
	return hits;
}

/** Cross-document search results. */
export class GlobalSearchModal extends SuggestModal<GlobalHit> {
	private hits: GlobalHit[] = [];
	private lastQuery = "";
	private searching = false;

	constructor(
		app: App,
		private rootFolder: string,
		private onPick: (hit: GlobalHit) => void,
		private includeArchived = false,
	) {
		super(app);
		this.setPlaceholder(
			includeArchived
				? "Search all documents, archived included"
				: "Search all documents — try is:completed, has:note, -word, OR",
		);
	}

	async getSuggestions(query: string): Promise<GlobalHit[]> {
		const q = query.trim();
		if (!q) return [];
		if (q === this.lastQuery) return this.hits;
		// A search reads every document, so keystrokes that land while one is in
		// flight are not each given a search of their own — but they must not be
		// LOST either. Remember that the query moved on, and re-run once.
		if (this.searching) { this.pending = q; return this.hits; }
		this.searching = true;
		try {
			this.hits = await searchAllDocs(this.app, this.rootFolder, q, 300, this.includeArchived, { cache: this.indexes });
			this.lastQuery = q;
		} finally {
			this.searching = false;
		}
		if (this.pending && this.pending !== this.lastQuery) {
			this.pending = "";
			// Nudge the modal to ask again; the answer is now for the latest text.
			window.setTimeout(() => this.inputEl.dispatchEvent(new Event("input")), 0);
		}
		return this.hits;
	}

	/** The newest query typed while a search was running. */
	private pending = "";
	/** Every document read so far in this modal, so only the first query reads
	 *  the vault; later keystrokes filter in memory. Dropped with the modal. */
	private indexes = new Map<string, DocIndex>();

	renderSuggestion(hit: GlobalHit, el: HTMLElement): void {
		el.createDiv({ text: hit.node.text || "(empty item)" });
		const trail = trailFor(hit.index, hit.node);
		const label = trail ? `${hit.doc.manifest.title} › ${trail}` : hit.doc.manifest.title;
		el.createDiv({
			cls: "trynalist-suggest-trail",
			text: hit.doc.manifest.archived ? `${label} (archived)` : label,
		});
	}

	onChooseSuggestion(hit: GlobalHit): void { this.onPick(hit); }
}

/** Pick a Trynalist document anywhere in the vault. */
export class DocSuggestModal extends FuzzySuggestModal<DocRef> {
	private docs: DocRef[] = [];

	constructor(
		app: App,
		private rootFolder: string,
		private onPick: (doc: DocRef) => void,
	) {
		super(app);
		this.setPlaceholder("Jump to document…");
	}

	async load(): Promise<this> {
		this.docs = await listDocs(this.app, this.rootFolder);
		return this;
	}

	getItems(): DocRef[] { return this.docs; }

	getItemText(doc: DocRef): string {
		// Include the folder path so "work roadmap" finds Work/Roadmap.
		return `${doc.folder.parent?.path ?? ""} ${doc.manifest.title}`;
	}

	renderSuggestion(match: { item: DocRef }, el: HTMLElement): void {
		// FuzzySuggestModal passes a match object; render title + location.
		const doc = match.item ?? (match as unknown as DocRef);
		el.createDiv({ text: doc.manifest.archived ? `${doc.manifest.title} (archived)` : doc.manifest.title });
		const parent = doc.folder.parent?.path ?? "";
		if (parent) el.createDiv({ cls: "trynalist-suggest-trail", text: parent });
	}

	onChooseItem(doc: DocRef): void { this.onPick(doc); }
}

/** Pick a saved bookmark. */
export class BookmarkSuggestModal extends FuzzySuggestModal<Bookmark> {
	constructor(
		app: App,
		private bookmarks: Bookmark[],
		private onPick: (bm: Bookmark) => void,
	) {
		super(app);
		this.setPlaceholder("Open bookmark…");
	}

	getItems(): Bookmark[] { return this.bookmarks; }
	getItemText(bm: Bookmark): string { return bm.label; }
	onChooseItem(bm: Bookmark): void { this.onPick(bm); }
}
