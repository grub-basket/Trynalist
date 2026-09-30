import { App, Notice, TFile } from "obsidian";
import { parse } from "node-html-parser";
import { createDoc, writeImportedTree } from "./store";
import type { DocRef } from "./types";

/** A node in whatever was imported, normalised before it touches the store. */
export interface ImportNode {
	/** Stable id from the source system (Dynalist node id), carried so two
	 *  import runs can be diffed. Undefined for formats without ids. */
	sourceId?: string;
	/** Any source fields we don't map to a first-class column, preserved verbatim
	 *  so nothing Dynalist sends is silently dropped — data parity for whoever
	 *  builds on the vault later. Undefined when there are none. */
	dlExtra?: Record<string, unknown>;
	text: string;
	note: string;
	checked: boolean;
	/** Whether the item HAS a checkbox, independent of whether it is ticked.
	 *  Dynalist tracks the three states (none / unchecked / checked); an
	 *  unchecked-but-boxed item would import as plain text if we only kept
	 *  `checked`. */
	checkbox: boolean;
	collapsed: boolean;
	heading: number;
	color: number;
	/** ISO strings when the source carried real timestamps (the Dynalist API
	 *  does); left undefined for formats that don't, so the writer stamps now. */
	created?: string;
	modified?: string;
	children: ImportNode[];
}

export interface ImportResult {
	title: string;
	roots: ImportNode[];
	format: "opml" | "json" | "text";
	/** Anything dropped or guessed at — surfaced rather than swallowed. */
	warnings: string[];
}

function blank(text = ""): ImportNode {
	return { text, note: "", checked: false, checkbox: false, collapsed: false, heading: 0, color: 0, children: [] };
}

function countNodes(nodes: ImportNode[]): number {
	return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

// ── OPML (Dynalist's "Export as OPML") ──────────────────────────────────

export function parseOpml(xml: string): ImportResult {
	const warnings: string[] = [];
	const doc = parse(xml, { lowerCaseTagName: true });
	const title = doc.querySelector("head title")?.text?.trim() || "Imported outline";
	const body = doc.querySelector("body");
	if (!body) return { title, roots: [], format: "opml", warnings: ["No <body> in the OPML."] };

	// `:scope >` is unsupported by the parser, so walk children directly.
	const topLevel = body.childNodes.filter(
		(c) => (c.rawTagName || "").toLowerCase() === "outline",
	) as unknown as Array<ReturnType<typeof parse>>;
	const roots = topLevel.map((el) => convertOutline(el, warnings));
	if (!roots.length) warnings.push("No <outline> elements found under <body>.");
	return { title, roots, format: "opml", warnings };
}

/** Recursive OPML conversion using direct child walking (no :scope). */
function convertOutline(el: ReturnType<typeof parse>, warnings: string[]): ImportNode {
	// getAttribute already decodes entities (once). Decoding a second time
	// turned a literal "&lt;" in an item into "<" on every round trip (L19/20),
	// and a numeric reference out of Unicode's range threw RangeError in
	// String.fromCodePoint and aborted the whole import (L30).
	const node = blank(el.getAttribute("text") ?? "");
	node.note = el.getAttribute("_note") ?? el.getAttribute("note") ?? "";
	const done = el.getAttribute("complete") ?? el.getAttribute("_complete") ?? el.getAttribute("checked");
	node.checked = done === "true" || done === "yes" || done === "1";
	// Dynalist (and Trynalist's own export) write `checkbox="true"` for an item
	// that has a box, ticked or not; unticked boxes were dropped (L21).
	const box = el.getAttribute("checkbox") ?? el.getAttribute("_checkbox");
	node.checkbox = node.checked || box === "true" || box === "yes" || box === "1";
	const collapsed = el.getAttribute("collapsed") ?? el.getAttribute("_collapsed");
	node.collapsed = collapsed === "true" || collapsed === "yes" || collapsed === "1";
	const heading = parseInt(el.getAttribute("heading") ?? el.getAttribute("_heading") ?? "", 10);
	if (!isNaN(heading)) node.heading = Math.max(0, Math.min(6, heading));
	const color = parseInt(el.getAttribute("color") ?? el.getAttribute("_color") ?? el.getAttribute("colorLabel") ?? "", 10);
	if (!isNaN(color)) node.color = Math.max(0, Math.min(6, color));
	if (!node.text && !node.note && !el.childNodes.length) {
		warnings.push("An <outline> had no text — imported as an empty item.");
	}
	for (const child of el.childNodes) {
		if ((child.rawTagName || "").toLowerCase() === "outline") {
			node.children.push(convertOutline(child as unknown as ReturnType<typeof parse>, warnings));
		}
	}
	return node;
}

// ── Dynalist JSON ───────────────────────────────────────────────────────

interface RawJsonNode {
	id?: string;
	content?: string;
	note?: string;
	checked?: boolean;
	checkbox?: boolean;
	collapsed?: boolean;
	heading?: number;
	color?: number;
	/** Dynalist API: epoch milliseconds. */
	created?: number;
	modified?: number;
	children?: Array<RawJsonNode | string>;
}

/** Epoch-ms (Dynalist API) → ISO, or undefined for anything unparseable, so a
 *  bad stamp falls back to "now" at write time rather than poisoning the field. */
function isoFromEpoch(ms: number | undefined): string | undefined {
	if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return undefined;
	const d = new Date(ms);
	return isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** One Dynalist-shaped node → ImportNode, resolving id-referenced children
 *  against `byId`. Shared by the file importer (parseDynalistJson) and the API
 *  importer, so both carry checkbox state and timestamps identically. */
/** Field-by-field mapping of one raw Dynalist node onto an ImportNode, WITHOUT
 *  touching children. Shared by the tree converter and the in-place updater so
 *  both interpret every field identically. */
export function dynalistNodeFields(raw: RawJsonNode): ImportNode {
	const node = blank((raw.content ?? "").trim());
	if (raw.id) node.sourceId = raw.id;
	// Preserve any field we don't lift into a named column. `children` is
	// structural (handled by the caller) and never data, so it's excluded.
	const KNOWN = new Set(["id", "content", "note", "checked", "checkbox", "color", "heading", "created", "modified", "collapsed", "children"]);
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (KNOWN.has(k) || v === undefined || v === null) continue;
		// Never let a key from the wire become a prototype hook on the object we
		// build — `__proto__` would rewire `extra` itself and vanish on serialise.
		if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
		extra[k] = v;
	}
	if (Object.keys(extra).length) node.dlExtra = extra;
	node.note = (raw.note ?? "").trim();
	node.checked = !!raw.checked;
	// A ticked item always has a box; Dynalist also flags a boxed-but-unticked
	// item via `checkbox`, which we must keep or it imports as plain text.
	node.checkbox = !!raw.checkbox || !!raw.checked;
	node.collapsed = !!raw.collapsed;
	node.heading = Math.max(0, Math.min(6, raw.heading ?? 0));
	node.color = Math.max(0, Math.min(6, raw.color ?? 0));
	node.created = isoFromEpoch(raw.created);
	node.modified = isoFromEpoch(raw.modified);
	return node;
}

function convertRawNode(raw: RawJsonNode, byId: Map<string, RawJsonNode>, seen: Set<string>, warnings: string[]): ImportNode {
	const node = dynalistNodeFields(raw);
	for (const child of raw.children ?? []) {
		if (typeof child === "string") {
			if (seen.has(child)) { warnings.push(`Cycle detected at node ${child}; that branch was cut.`); continue; }
			const target = byId.get(child);
			if (!target) { warnings.push(`Child id ${child} was referenced but not present.`); continue; }
			seen.add(child);
			node.children.push(convertRawNode(target, byId, seen, warnings));
		} else {
			node.children.push(convertRawNode(child, byId, seen, warnings));
		}
	}
	return node;
}

/** Build an ImportResult from a Dynalist `doc/read` response (nodes[] with a
 *  "root" node whose children are the document's top level). Kept here so the
 *  API client stays a thin transport and all node semantics live in one place. */
export function convertDynalistNodes(nodes: RawJsonNode[], title: string): ImportResult {
	const warnings: string[] = [];
	const byId = new Map<string, RawJsonNode>();
	for (const n of nodes) if (n.id) byId.set(n.id, n);
	const root = byId.get("root") ?? nodes[0];
	if (!root) return { title, roots: [], format: "json", warnings: ["Document has no nodes."] };
	const converted = convertRawNode(root, byId, new Set([root.id ?? "root"]), warnings);
	return { title: title || converted.text || "Imported document", roots: converted.children, format: "json", warnings };
}

/** Handles both shapes seen in the wild: children nested inline, and a flat
 *  node list where `children` holds ids. */
export function parseDynalistJson(text: string): ImportResult {
	const warnings: string[] = [];
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (e) {
		return { title: "Imported document", roots: [], format: "json", warnings: [`Not valid JSON: ${String(e)}`] };
	}
	const obj = data as { title?: string; nodes?: RawJsonNode[]; rootId?: string; id?: string; content?: string; children?: unknown };
	const title = obj.title || "Imported document";

	if (Array.isArray(obj.nodes)) {
		const byId = new Map<string, RawJsonNode>();
		for (const n of obj.nodes) if (n.id) byId.set(n.id, n);
		const rootId = obj.rootId ?? "root";
		const root = byId.get(rootId) ?? obj.nodes[0];
		if (!root) return { title, roots: [], format: "json", warnings: ["No nodes in the file."] };
		const converted = convertRawNode(root, byId, new Set([root.id ?? rootId]), warnings);
		// The export's root node IS the document, so its children become ours.
		// An explicit `title` beats the root's content, which is often a
		// placeholder like "root".
		const rootText = root.content?.trim();
		const docTitle = obj.title?.trim()
			|| (rootText && rootText.toLowerCase() !== "root" ? rootText : "")
			|| title;
		return { title: docTitle, roots: converted.children, format: "json", warnings };
	}
	if (obj.children || obj.content) {
		const converted = convertRawNode(obj as RawJsonNode, new Map(), new Set(), warnings);
		return { title: converted.text || title, roots: converted.children, format: "json", warnings };
	}
	return { title, roots: [], format: "json", warnings: ["Unrecognised JSON shape — expected nodes[] or a root object."] };
}

// ── Plain text with indentation ─────────────────────────────────────────

export function parseIndentedText(text: string, title = "Imported list"): ImportResult {
	const warnings: string[] = [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const roots: ImportNode[] = [];
	// Stack of [indentWidth, node] so any indent style nests consistently.
	const stack: Array<{ indent: number; node: ImportNode }> = [];

	for (const rawLine of lines) {
		if (!rawLine.trim()) continue;
		const lead = /^[\t ]*/.exec(rawLine)?.[0] ?? "";
		// Raw indent width (a tab counts as four spaces), compared on the stack.
		// Learning "the step" from the first indented line and dividing by it
		// mis-nested everything after an early two-level jump (L22); the stack
		// only needs "deeper than the line above or not".
		const width = lead.replace(/\t/g, "    ").length;

		let body = rawLine.trim();
		let checked = false;
		// Markdown task and bullet markers.
		const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(body);
		if (task) { checked = task[1].toLowerCase() === "x"; body = task[2]; }
		else body = body.replace(/^([-*+]|\d+[.)])\s+/, "");

		const node = blank(body);
		node.checked = checked;
		// A task marker means the item HAS a box, ticked or not; setting only
		// `checked` dropped the box from every "- [ ] todo".
		if (task) node.checkbox = true;
		while (stack.length && stack[stack.length - 1].indent >= width) stack.pop();
		if (!stack.length) roots.push(node);
		else stack[stack.length - 1].node.children.push(node);
		stack.push({ indent: width, node });
	}
	if (!roots.length) warnings.push("Nothing importable — every line was blank.");
	return { title, roots, format: "text", warnings };
}

// ── writing the result into a document ──────────────────────────────────

export function detectFormat(name: string, content: string): "opml" | "json" | "text" {
	const lower = name.toLowerCase();
	if (lower.endsWith(".opml") || lower.endsWith(".xml")) return "opml";
	if (lower.endsWith(".json")) return "json";
	const head = content.slice(0, 400).trim();
	if (head.startsWith("<?xml") || head.includes("<opml")) return "opml";
	if (head.startsWith("{") || head.startsWith("[")) return "json";
	return "text";
}

export function parseImport(name: string, content: string): ImportResult {
	switch (detectFormat(name, content)) {
		case "opml": return parseOpml(content);
		case "json": return parseDynalistJson(content);
		default: return parseIndentedText(content, name.replace(/\.[^.]+$/, "") || "Imported list");
	}
}

/** Create a document and write the parsed tree into it. */
/** Import provenance stamped onto every written node (and mirrored to the doc
 *  manifest by the caller), so an imported item carries where it came from. */
export interface ImportProvenance {
	source: string;
	dlPermission?: number;
	dlPermissionLabel?: string;
}

export async function writeImport(
	app: App,
	rootFolder: string,
	result: ImportResult,
	titleOverride?: string,
	provenance?: ImportProvenance,
	/** Runs after the document (folder + manifest) exists and BEFORE any item is
	 *  written. The Dynalist importer uses it to stamp the manifest with its
	 *  file id first, so a crash mid-write leaves a document a resume can
	 *  recognise rather than one it duplicates. */
	beforeItems?: (doc: DocRef) => Promise<void>,
): Promise<{ doc: DocRef; items: number }> {
	const doc = await createDoc(app, rootFolder, titleOverride?.trim() || result.title);
	if (beforeItems) await beforeItems(doc);
	// One vault.create per item with complete frontmatter+body — see
	// writeImportedTree. ImportNode already carries everything it needs (text,
	// note, flags, timestamps, sourceId, dlExtra), so it passes straight through.
	const items = await writeImportedTree(app, doc, result.roots, provenance);
	return { doc, items };
}

/** Convenience for importing a file already sitting in the vault. */
export async function importVaultFile(
	app: App,
	rootFolder: string,
	file: TFile,
	titleOverride?: string,
): Promise<{ doc: DocRef; items: number; warnings: string[] } | null> {
	try {
		const content = await app.vault.read(file);
		const result = parseImport(file.name, content);
		if (!result.roots.length) {
			new Notice(`Trynalist: nothing to import from "${file.name}". ${result.warnings[0] ?? ""}`);
			return null;
		}
		const { doc, items } = await writeImport(app, rootFolder, result, titleOverride);
		return { doc, items, warnings: result.warnings };
	} catch (e) {
		console.error("Trynalist: import failed", e);
		new Notice("Trynalist: import failed — see console.");
		return null;
	}
}
