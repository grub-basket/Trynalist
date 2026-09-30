import { App, Notice, normalizePath } from "obsidian";
import { zipSync, strToU8 } from "fflate";
import { DocIndex } from "./store";
import { safeName } from "./id-service";
import type { TreeNode } from "./types";
import { resolveAll } from "./mirrors";

// The installed fflate types declare their return values with the TS 5.7+
// generic `Uint8Array<TArrayBuffer>` syntax, which the store-lint tool's own
// bundled (older) TypeScript cannot parse — see the matching comment in
// backup.ts. These thin wrappers, round-tripped through `unknown`, keep both
// TS versions satisfied without changing what gets zipped.
function zipSyncTyped(data: Record<string, Uint8Array>): Uint8Array {
	const result: unknown = zipSync(data);
	return result as Uint8Array;
}
function strToU8Typed(str: string): Uint8Array {
	const result: unknown = strToU8(str);
	return result as Uint8Array;
}
import type { Resolved } from "./mirrors";

/** Render a doc as a plain Markdown outline (Dynalist-export style):
 *  nested `- ` bullets, notes as indented continuation lines. */
export function renderOutlineMarkdown(
	index: DocIndex,
	/** Resolved mirrors, from `resolveAll`. Without it a mirror exports as the
	 *  blank line it literally is, which silently drops content the document
	 *  visibly contains. */
	mirrors?: Map<string, Resolved>,
): string {
	const lines: string[] = [`# ${index.docRef.manifest.title}`, ""];
	/** Whether the outline draws a box on `n`: its own checkbox, ticked, or a
	 *  checklist ancestor — the row's own test. `checklist` on the item itself
	 *  means "my CHILDREN are a checklist", which is what this used to read,
	 *  boxing the parent and not the to-dos (M48). */
	const boxed = (src: DocIndex, n: TreeNode): boolean => {
		if (n.checkbox || n.checked) return true;
		const seen = new Set<string>();
		for (let p = n.parent ? src.nodes.get(n.parent) : undefined; p && !seen.has(p.id); p = p.parent ? src.nodes.get(p.parent) : undefined) {
			if (p.checklist) return true;
			seen.add(p.id);
		}
		return false;
	};
	const emit = (n: TreeNode, pad: string, src: DocIndex = index) => {
		const check = boxed(src, n) ? (n.checked ? "[x] " : "[ ] ") : "";
		lines.push(`${pad}- ${check}${n.text}`);
		if (n.note) for (const noteLine of n.note.split("\n")) lines.push(`${pad}  ${noteLine}`);
	};
	/** A mirrored subtree comes from another index, so it is walked separately
	 *  and marked — an export should say where content came from rather than
	 *  presenting a copy as if it were written here. */
	const walkMirrored = (src: DocIndex, id: string, depth: number, seen: Set<string>) => {
		if (seen.has(id) || depth > 40) return;
		seen.add(id);
		const node = src.nodes.get(id);
		if (!node) return;
		// A mirror INSIDE a mirrored subtree is not followed (that is what keeps
		// a mirror of an ancestor from recursing), but it must say so rather
		// than export as the blank bullet it literally is.
		if (node.mirrorOf) {
			lines.push(`${"    ".repeat(depth)}- *(nested mirror: ${node.mirrorOf})*`);
			return;
		}
		emit(node, "    ".repeat(depth), src);
		for (const kid of src.children(id)) walkMirrored(src, kid.id, depth + 1, seen);
	};
	const walk = (parent: string | null, depth: number) => {
		for (const n of index.children(parent)) {
			const pad = "    ".repeat(depth);
			const hit = n.mirrorOf ? mirrors?.get(n.id) : undefined;
			if (n.mirrorOf) {
				if (!hit?.ok) {
					lines.push(`${pad}- *(mirror — source unavailable: ${n.mirrorOf})*`);
					continue;
				}
				const label = n.mirrorMode === "children"
					? `*(portal into "${hit.node.text || "(empty)"}" in ${hit.docTitle})*`
					: `*(mirror of "${hit.node.text || "(empty)"}" in ${hit.docTitle})*`;
				lines.push(`${pad}- ${label}`);
				const roots = n.mirrorMode === "children"
					? hit.index.children(hit.node.id).map((k) => k.id)
					: [hit.node.id];
				for (const rootId of roots) walkMirrored(hit.index, rootId, depth + 1, new Set());
				continue;
			}
			emit(n, pad);
			walk(n.id, depth + 1);
		}
	};
	walk(null, 0);
	return lines.join("\n") + "\n";
}

function nodeJson(n: TreeNode) {
	return {
		id: n.id, parent: n.parent, order: n.order, indent: n.indent, depth: n.depth,
		created: n.created, modified: n.modified, checked: n.checked, checkbox: n.checkbox,
		checklist: n.checklist, numbered: n.numbered,
		collapsed: n.collapsed, heading: n.heading, color: n.color, due: n.due,
		mirrorOf: n.mirrorOf, mirrorMode: n.mirrorMode,
		// Dynalist provenance, so "lossless" holds for imported documents too.
		dlId: n.sourceId, source: n.source, dlPermission: n.dlPermission,
		dlPermissionLabel: n.dlPermissionLabel, dlExtra: n.dlExtra, dlRemoved: n.dlRemoved,
		text: n.text, note: n.note,
	};
}

/** The file name an export gets: the title, made safe. A manifest's title is
 *  whatever the file says — a shared folder or a restored backup can carry
 *  `../../../Documents/x`, and normalizePath neither resolves nor rejects
 *  `..`, so the export was written outside the vault (M54). The folder name
 *  (already a safe name) is the fallback. */
function exportName(index: DocIndex): string {
	return safeName(String(index.docRef.manifest.title ?? ""), safeName(index.docRef.folder.name, "Document"));
}

/** Export a doc as `<Title>.trynalist.zip` next to the doc folder:
 *  outline.md (human-readable) + meta.json (full node metadata, lossless). */
export async function exportDocZip(app: App, index: DocIndex): Promise<string> {
	const md = renderOutlineMarkdown(index, await resolveAll(app, index));
	const meta = {
		manifest: index.docRef.manifest,
		exported: new Date().toISOString(),
		nodes: [...index.nodes.values()].map(nodeJson),
	};
	const zipped = zipSyncTyped({
		"outline.md": strToU8Typed(md),
		"meta.json": strToU8Typed(JSON.stringify(meta, null, 2)),
	});
	const base = normalizePath(
		`${index.docRef.folder.parent?.path ?? ""}/${exportName(index)}.trynalist.zip`,
	);
	let path = base;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = base.replace(/\.trynalist\.zip$/, ` ${n++}.trynalist.zip`);
	}
	// `unknown` round-trip rather than a direct `as ArrayBuffer`: this TS
	// version and the store-lint tool's own (older) TS disagree on whether
	// `.buffer` here is already an `ArrayBuffer` or the broader
	// `ArrayBufferLike`, so a direct assertion is "necessary" on one and
	// "unnecessary" on the other. Going through `unknown` satisfies both.
	const rawBuf: unknown = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
	const buf = rawBuf as ArrayBuffer;
	await app.vault.createBinary(path, buf);
	new Notice(`Trynalist: exported ${path}`);
	return path;
}


/** Plain text: the outline with indentation and nothing else. Dynalist offered
 *  this alongside "formatted" and OPML, to clipboard or file. */
/** A mirror has no text of its own; flat exports name what it shows rather
 *  than writing an empty line (mirrors review finding 9). The Markdown export
 *  expands mirrored subtrees; these formats label the mirror instead. */
function mirrorLabel(n: TreeNode, mirrors?: Map<string, Resolved>): string {
	if (!n.mirrorOf) return n.text;
	const hit = mirrors?.get(n.id);
	if (!hit || !hit.ok) return n.text || "(broken mirror)";
	const what = n.mirrorMode === "children" ? `children of "${hit.node.text}"` : hit.node.text;
	return `${what} (mirror from ${hit.docTitle})`;
}

export function renderPlainText(index: DocIndex, mirrors?: Map<string, Resolved>): string {
	const lines: string[] = [];
	const walk = (parent: string | null, depth: number) => {
		for (const n of index.children(parent)) {
			lines.push(`${"    ".repeat(depth)}${mirrorLabel(n, mirrors)}`);
			if (n.note) for (const l of n.note.split("\n")) lines.push(`${"    ".repeat(depth + 1)}${l}`);
			walk(n.id, depth + 1);
		}
	};
	walk(null, 0);
	return lines.join("\n") + "\n";
}

function xmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** For attribute VALUES: XML attribute-value normalisation turns a literal
 *  newline into a space, so a multi-line note would flatten in any conforming
 *  reader (Dynalist included). A character reference survives. */
function attrEscape(s: string): string {
	return xmlEscape(s).replace(/\r?\n/g, "&#10;").replace(/\t/g, "&#9;");
}

/** OPML, in the shape Dynalist itself exports — so a round trip through our
 *  own importer keeps notes, completion, headings and colours. */
export function renderOpml(index: DocIndex, mirrors?: Map<string, Resolved>): string {
	const lines = [
		'<?xml version="1.0" encoding="utf-8"?>',
		'<opml version="2.0">',
		"<head>",
		`  <title>${xmlEscape(index.docRef.manifest.title)}</title>`,
		"</head>",
		"<body>",
	];
	const walk = (parent: string | null, depth: number) => {
		for (const n of index.children(parent)) {
			const pad = "  ".repeat(depth + 1);
			const attrs = [`text="${attrEscape(mirrorLabel(n, mirrors))}"`];
			if (n.note) attrs.push(`_note="${attrEscape(n.note)}"`);
			// Dynalist's own OPML marks "has a checkbox" separately from "ticked".
			if (n.checkbox || n.checked) attrs.push('checkbox="true"');
			if (n.checked) attrs.push('complete="true"');
			if (n.collapsed) attrs.push('collapsed="true"');
			if (n.heading) attrs.push(`heading="${n.heading}"`);
			if (n.color) attrs.push(`color="${n.color}"`);
			const kids = index.children(n.id);
			if (!kids.length) { lines.push(`${pad}<outline ${attrs.join(" ")}/>`); continue; }
			lines.push(`${pad}<outline ${attrs.join(" ")}>`);
			walk(n.id, depth + 1);
			lines.push(`${pad}</outline>`);
		}
	};
	walk(null, 0);
	lines.push("</body>", "</opml>", "");
	return lines.join("\n");
}

export type ExportFormat = "formatted" | "plain" | "opml";

export function renderExport(
	index: DocIndex,
	format: ExportFormat,
	mirrors?: Map<string, Resolved>,
): string {
	if (format === "plain") return renderPlainText(index, mirrors);
	if (format === "opml") return renderOpml(index, mirrors);
	return renderOutlineMarkdown(index, mirrors);
}

/** Write an export next to the document folder. */
export async function writeExportFile(
	app: App,
	index: DocIndex,
	format: ExportFormat,
): Promise<string> {
	const ext = format === "opml" ? "opml" : format === "plain" ? "txt" : "md";
	const base = normalizePath(
		`${index.docRef.folder.parent?.path ?? ""}/${exportName(index)}.${ext}`,
	);
	let path = base;
	let n = 2;
	while (app.vault.getAbstractFileByPath(path)) {
		path = base.replace(new RegExp(`\\.${ext}$`), ` ${n++}.${ext}`);
	}
	await app.vault.create(path, renderExport(index, format, await resolveAll(app, index)));
	return path;
}
