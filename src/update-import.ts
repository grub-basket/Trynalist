import { App, TFile } from "obsidian";
import { DocIndex } from "./store";
import { dynalistNodeFields } from "./import";
import { primaryDate } from "./dates";
import type { DocRef, TreeNode } from "./types";

/** Update ONE already-imported document in place from a fresh doc/read response,
 *  matching items by their Dynalist id (dlId). Trynalist ids are preserved, so
 *  links and mirrors pointing at these items survive the update.
 *
 *   - An item present in both: its content fields are updated when they differ,
 *     and any earlier "removed" mark is cleared (it's back).
 *   - An item new in Dynalist: created under the item whose dlId is its parent.
 *   - An item gone from Dynalist: marked with `dlRemoved` (a timestamp) rather
 *     than deleted — non-destructive, reversible, and visible.
 *
 *  Structural MOVES (an item re-parented in Dynalist) are not re-parented here;
 *  the content updates in place. Noted so it isn't mistaken for a full sync. */

interface RawNode {
	id?: string;
	children?: Array<string | { id?: string }>;
	[k: string]: unknown;
}

export interface DocUpdateCounts {
	updated: number;       // a content field changed
	backfilled: number;    // only metadata (source/permission/dlExtra) newly written
	added: number;
	removedMarked: number;
	unchanged: number;
	/** Changed both here and in Dynalist since the last update: the local
	 *  version was kept. */
	conflicts: number;
	/** In Dynalist and in the last update, but deleted, merged away or moved
	 *  out here since: not brought back. */
	keptDeleted: number;
	/** Texts of conflicted items, for the report (first few). */
	conflictTexts: string[];
}

export interface DocUpdateContext {
	/** The raw nodes this document had at the previous update (the run's
	 *  `_source/<id>.json` from last time), when kept. The base of a three-way
	 *  comparison: without it a local edit and a Dynalist edit look alike. */
	base?: RawNode[];
	/** When the document was last imported/updated (manifest dlImportedAt);
	 *  the fallback when there is no base. */
	lastSync?: string;
	/** Whether a Dynalist id lives somewhere else under the root (another
	 *  document, Trynalist's trash): an item the user moved or deleted, not a
	 *  new one. */
	isElsewhere?: (dlId: string) => boolean;
}

const CONTENT_FIELDS: Array<keyof TreeNode> = ["text", "note", "checked", "checkbox", "collapsed", "heading", "color"];

export async function applyDocUpdate(
	app: App,
	docRef: DocRef,
	rawNodes: RawNode[],
	provenance: { source: string; dlPermission?: number; dlPermissionLabel?: string },
	stamp: string,
	ctx: DocUpdateContext = {},
): Promise<DocUpdateCounts> {
	const idx = new DocIndex(app, docRef);
	await idx.load();

	const bySrc = new Map<string, TreeNode>();
	for (const n of idx.nodes.values()) if (n.sourceId) bySrc.set(n.sourceId, n);
	// A document imported by a build that didn't write `dlId` has nothing to
	// match on: every raw node would look new and the whole outline would be
	// appended a second time. Refuse rather than double it.
	if (idx.nodes.size && !bySrc.size) {
		throw new Error("This document carries no Dynalist item ids (imported by an older build), so it can't be updated in place — import it again into a fresh run instead.");
	}

	// Raw maps: id → node, and childId → parent dlId (null for top level).
	const rawById = new Map<string, RawNode>();
	for (const rn of rawNodes) if (rn.id) rawById.set(rn.id, rn);
	const childIds = (rn: RawNode): string[] =>
		(rn.children ?? []).map((c) => (typeof c === "string" ? c : c.id)).filter((x): x is string => !!x);
	const parentDlOf = new Map<string, string | null>();
	for (const rn of rawNodes) {
		if (!rn.id) continue;
		const pid = rn.id === "root" ? null : rn.id;
		for (const cid of childIds(rn)) parentDlOf.set(cid, pid === null && rn.id === "root" ? null : rn.id);
	}
	// The document root's children are top level (parent null).
	const root = rawById.get("root") ?? rawNodes[0];
	for (const cid of root ? childIds(root) : []) parentDlOf.set(cid, null);

	const counts: DocUpdateCounts = { updated: 0, backfilled: 0, added: 0, removedMarked: 0, unchanged: 0, conflicts: 0, keptDeleted: 0, conflictTexts: [] };
	// The previous update's view of each item: base for the three-way compare.
	const baseById = new Map<string, RawNode>();
	for (const rn of ctx.base ?? []) if (rn.id) baseById.set(rn.id, rn);
	const hasBase = baseById.size > 0;
	const seen = new Set<string>();

	// Pre-order walk so a parent is processed (and created) before its children,
	// which lets a new child attach to a just-added parent.
	const order: string[] = [];
	const walk = (id: string, guard: Set<string>): void => {
		const rn = rawById.get(id);
		if (!rn) return;
		for (const cid of childIds(rn)) {
			if (guard.has(cid)) continue;
			guard.add(cid);
			order.push(cid);
			walk(cid, guard);
		}
	};
	walk(root?.id ?? "root", new Set());

	for (const dlId of order) {
		const rn = rawById.get(dlId);
		if (!rn) continue;
		seen.add(dlId);
		const fields = dynalistNodeFields(rn);
		const existing = bySrc.get(dlId);
		if (existing) {
			// Three-way, field by field (M9): the update used to set every field
			// to Dynalist's value, silently overwriting a week of local rewording.
			//   local == base  → only Dynalist may have changed it: take remote.
			//   remote == base → only we changed it: keep local.
			//   both differ    → conflict: keep local, report it.
			// Without a base (source snapshots off, first update after an older
			// build): an item modified here after the last sync counts as a local
			// edit and is kept; otherwise Dynalist's value is taken.
			const baseRaw = baseById.get(dlId);
			const baseFields = baseRaw ? dynalistNodeFields(baseRaw) as unknown as Record<string, unknown> : null;
			const localEditedSinceSync = !hasBase && !!ctx.lastSync && existing.modified > ctx.lastSync;
			const cur = existing as unknown as Record<string, unknown>;
			let contentChanged = false;
			let conflicted = false;
			let keptLocal = false;
			for (const f of CONTENT_FIELDS) {
				const next = (fields as unknown as Record<string, unknown>)[f];
				if (cur[f] === next) continue;
				const localChanged = baseFields ? cur[f] !== baseFields[f] : localEditedSinceSync;
				const remoteChanged = baseFields ? next !== baseFields[f] : true;
				if (!remoteChanged) { keptLocal = true; continue; }   // our edit; Dynalist's is the old value
				if (localChanged) { conflicted = true; keptLocal = true; continue; }
				cur[f] = next;
				contentChanged = true;
			}
			if (conflicted) {
				counts.conflicts++;
				if (counts.conflictTexts.length < 10) counts.conflictTexts.push(existing.text || "(empty item)");
			}
			// Text or note may have changed: the due date follows (M13).
			const due = primaryDate(existing.text, existing.note);
			if (due !== existing.due) { existing.due = due; contentChanged = true; }
			// Provenance backfill counts too: a re-run over notes imported by an
			// older build gains source/permission/dlExtra without any CONTENT
			// changing, and reporting that as "unchanged" is what made a real
			// backfill look like nothing happened ("4 updated" across 206 docs).
			const provChanged = existing.source !== provenance.source
				|| existing.dlPermission !== provenance.dlPermission
				|| existing.dlPermissionLabel !== provenance.dlPermissionLabel
				|| JSON.stringify(existing.dlExtra ?? null) !== JSON.stringify(fields.dlExtra ?? null);
			existing.source = provenance.source;
			existing.dlPermission = provenance.dlPermission;
			existing.dlPermissionLabel = provenance.dlPermissionLabel;
			existing.dlExtra = fields.dlExtra;
			// Backfill the source timestamps and KEEP them: an update carries
			// Dynalist's own created/modified, so a re-run over notes imported by an
			// older build gains the metadata without its `modified` being reset to
			// "now". Without preserveModified the write would clobber the real time.
			const stampsChanged = (!!fields.created && fields.created !== existing.created)
				|| (!!fields.modified && fields.modified !== existing.modified);
			if (fields.created) existing.created = fields.created;
			// A kept local edit keeps its own time; stamping Dynalist's over it
			// would make it look untouched to the next update.
			if (fields.modified && !keptLocal) existing.modified = fields.modified;
			// Only touch the disk when something is actually different. Every
			// matched item used to be rewritten twice (frontmatter+body, then a
			// second processFrontMatter to clear a mark it usually never had) —
			// a no-op update over 44,000 items was ~130,000 file operations.
			const wasRemoved = !!existing.dlRemoved;
			if (contentChanged || provChanged || stampsChanged || wasRemoved) {
				await idx.writeNode(existing, { preserveModified: !!fields.modified && !keptLocal });
			}
			if (wasRemoved && existing.file) {
				await clearRemovedMark(app, existing.file);
				existing.dlRemoved = undefined;
			}
			if (contentChanged) counts.updated++;
			else if (provChanged) counts.backfilled++;
			else counts.unchanged++;
		} else if ((hasBase && baseById.has(dlId)) || ctx.isElsewhere?.(dlId)) {
			// Here at the last update and gone locally since — deleted, merged
			// away or moved to another document by the user (or sitting in
			// Trynalist's trash). Re-adding it resurrected every local deletion
			// and duplicated every moved branch (M10).
			counts.keptDeleted++;
		} else {
			const parentDl = parentDlOf.get(dlId) ?? null;
			const parentNode = parentDl ? bySrc.get(parentDl) : null;
			const parentId = parentNode ? parentNode.id : null;
			// Where Dynalist has it: right after its nearest preceding sibling
			// that already exists here (under the same parent), or first if none.
			// Appending at the end put every item added in Dynalist out of order
			// (L23). Local-only items stay where the user put them.
			const rawParent = parentDl ? rawById.get(parentDl) : root;
			const rawSibs = rawParent ? childIds(rawParent) : [];
			let afterId: string | null = null;
			for (let k = rawSibs.indexOf(dlId) - 1; k >= 0; k--) {
				const prev = bySrc.get(rawSibs[k]);
				if (prev && prev.parent === parentId && idx.nodes.has(prev.id)) { afterId = prev.id; break; }
			}
			const created = await idx.createNode(fields.text, parentId, afterId);
			created.note = fields.note;
			created.checked = fields.checked;
			created.checkbox = fields.checkbox;
			created.collapsed = fields.collapsed;
			created.heading = fields.heading;
			created.color = fields.color;
			created.sourceId = dlId;
			if (fields.created) created.created = fields.created;
			if (fields.dlExtra) created.dlExtra = fields.dlExtra;
			created.source = provenance.source;
			created.dlPermission = provenance.dlPermission;
			created.dlPermissionLabel = provenance.dlPermissionLabel;
			// createNode computed `due` from the text alone; the note counts too (M13).
			created.due = primaryDate(created.text, created.note);
			await idx.writeNode(created, { preserveModified: false });
			bySrc.set(dlId, created);        // so its children can attach
			counts.added++;
		}
	}

	// Items that carried a dlId but are no longer in Dynalist → mark removed.
	for (const n of idx.nodes.values()) {
		if (!n.sourceId || seen.has(n.sourceId) || !n.file) continue;
		if (await markRemoved(app, n.file, stamp)) counts.removedMarked++;
	}
	return counts;
}

/** Set the `dlRemoved` frontmatter timestamp, unless already set. Returns whether
 *  it newly marked the file. */
async function markRemoved(app: App, file: TFile, stamp: string): Promise<boolean> {
	let newly = false;
	await app.fileManager.processFrontMatter(file, (fm) => {
		if (!fm.dlRemoved) { fm.dlRemoved = stamp; newly = true; }
	});
	return newly;
}

async function clearRemovedMark(app: App, file: TFile): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => { delete fm.dlRemoved; });
}
