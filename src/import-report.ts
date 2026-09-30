import { App, normalizePath, TFile } from "obsidian";
import type { DynalistImportSummary, UpdateImportSummary } from "./dynalist-api";

/** After an import or update, write a plain-Markdown report and open it in a new
 *  tab — the completion notice is a one-liner, but which documents failed, why,
 *  and what changed deserves something you can read, keep, and search. Reports
 *  live in a `_reports` folder (reserved, so they aren't treated as documents).*/

function stamp(): string {
	const d = new Date();
	const p = (n: number): string => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write the report and return its file. Opening is left to the caller (the
 *  completion notice's "Open report" button), so a report never steals focus
 *  mid-work — it's there when you want it. */
async function writeReport(app: App, rootFolder: string, name: string, body: string): Promise<TFile | null> {
	const dir = normalizePath(`${rootFolder}/_reports`);
	if (!app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
	let path = normalizePath(`${dir}/${name}.md`);
	let k = 2;
	while (app.vault.getAbstractFileByPath(path)) path = normalizePath(`${dir}/${name} ${k++}.md`);
	const file = await app.vault.create(path, body);
	return file instanceof TFile ? file : null;
}

/** A table, or a note that there was nothing. */
function table(headers: string[], rows: string[][]): string {
	if (!rows.length) return "_none_\n";
	const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
	const head = `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |`;
	const lines = rows.map((r) => `| ${r.map(esc).join(" | ")} |`);
	return [head, ...lines].join("\n") + "\n";
}

export async function writeImportReport(app: App, rootFolder: string, s: DynalistImportSummary): Promise<TFile | null> {
	const lines: string[] = [];
	lines.push(`# Dynalist import report — ${stamp()}`, "");
	lines.push(`Landed in \`${s.runFolder}\`.`, "");
	lines.push("## Summary", "");
	lines.push(`- Documents imported: **${s.documents}**`);
	lines.push(`- Items imported: **${s.items}**`);
	lines.push(`- Folders: ${s.folders}`);
	if (s.skippedShared) lines.push(`- Shared documents skipped (setting off): **${s.skippedShared}**`);
	lines.push(`- Failed: **${s.failures.length}**`);
	if (s.cancelled) lines.push(`- **Cancelled before finishing** — the documents above are what was imported.`);
	lines.push("", `## Failed documents (${s.failures.length})`, "");
	lines.push(table(["Document", "Reason"], s.failures.map((f) => [f.title, f.reason])));
	lines.push("", `## Warnings (${s.warnings.length})`, "");
	lines.push(s.warnings.length ? s.warnings.map((w) => `- ${w}`).join("\n") + "\n" : "_none_\n");
	return writeReport(app, rootFolder, `Import report ${stamp()}`, lines.join("\n"));
}

export async function writeUpdateReport(app: App, rootFolder: string, runFolder: string, s: UpdateImportSummary): Promise<TFile | null> {
	const lines: string[] = [];
	lines.push(`# Dynalist update report — ${stamp()}`, "");
	lines.push(`Folder \`${runFolder}\`.`, "");
	lines.push("## Summary", "");
	// docResults holds only documents that ACTUALLY changed, so it is the honest
	// "changed" count — docsUpdated counts every matched document, unchanged ones
	// included, which is what made "206 changed" appear over a table of zeros.
	lines.push(`- Documents changed: **${s.docResults.length}** of ${s.docsTotal}`);
	lines.push(`- Items updated (content): **${s.itemsUpdated}**`);
	lines.push(`- Items metadata-backfilled: **${s.itemsBackfilled}**`);
	lines.push(`- Items added: **${s.itemsAdded}**, marked removed: **${s.itemsRemovedMarked}**`);
	if (s.docsUnchanged) lines.push(`- Documents unchanged in Dynalist (not re-read): **${s.docsUnchanged}**`);
	if (s.itemsKeptDeleted) lines.push(`- Items you deleted, merged or moved here that Dynalist still has — **not** brought back: **${s.itemsKeptDeleted}**`);
	if (s.itemsConflicted) {
		lines.push(`- Items changed both here and in Dynalist — **your version kept**: **${s.itemsConflicted}**`);
		for (const t of s.conflictTexts) lines.push(`  - ${t}`);
	}
	if (s.docsAdded) lines.push(`- New documents added: **${s.docsAdded}**`);
	if (s.docsRemovedMarked) lines.push(`- Documents marked removed: **${s.docsRemovedMarked}**`);
	lines.push(`- Failed: **${s.failures.length}**`);
	if (s.cancelled) lines.push(`- **Cancelled before finishing.**`);
	if (s.newDocTitles.length) {
		lines.push("", `## New documents (${s.newDocTitles.length})`, "");
		lines.push(s.newDocTitles.map((t) => `- ${t}`).join("\n") + "\n");
	}
	if (s.selective) {
		// A targeted run over a chosen subset: show EVERY selected document and
		// what happened to it, unchanged ones included — the point of selecting is
		// to see each one's outcome, not just the ones that moved.
		const statusOf = (d: { updated: number; backfilled: number; added: number; removedMarked: number }): string =>
			d.added ? "Added (new doc)"
				: d.updated ? "Updated"
					: d.backfilled ? "Backfilled"
						: d.removedMarked ? "Items marked removed"
							: "Unchanged";
		const rows = s.docResults.map((d) => [d.title, statusOf(d), String(d.updated), String(d.backfilled), String(d.added), String(d.removedMarked)]);
		for (const f of s.failures) rows.push([f.title, `Failed: ${f.reason}`, "", "", "", ""]);
		lines.push("", `## Selected documents (${rows.length})`, "");
		lines.push(table(["Document", "Status", "Updated", "Backfilled", "Added", "Removed"], rows));
	} else {
		lines.push("", `## What changed (${s.docResults.length} of ${s.docsTotal})`, "");
		lines.push(table(
			["Document", "Updated", "Backfilled", "Added", "Removed"],
			s.docResults.map((d) => [d.title, String(d.updated), String(d.backfilled), String(d.added), String(d.removedMarked)]),
		));
		lines.push("", `## Failed documents (${s.failures.length})`, "");
		lines.push(table(["Document", "Reason"], s.failures.map((f) => [f.title, f.reason])));
	}
	return writeReport(app, rootFolder, `Update report ${stamp()}`, lines.join("\n"));
}
