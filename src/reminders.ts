import { App, Notice, TFile, moment } from "obsidian";
import { listDocs } from "./store";
import { isOverdue, parseAllDates, withoutLinks } from "./dates";
import type { DocRef, TrynalistSettings } from "./types";

export interface DueItem {
	docPath: string;
	docTitle: string;
	itemId: string;
	filePath: string;
	text: string;
	due: string;
	/** False for a date written without a time (`!(2026-10-01)`): due that
	 *  day, not at midnight. Read from the item's text; true if not found. */
	hasTime: boolean;
	overdue: boolean;
}

export type ReminderState = Record<string, { notifiedFor?: string; snoozedUntil?: string }>;

/** Everything with a due date inside the given window, read from frontmatter
 *  rather than by re-parsing every line (see dev-docs/reminders.md). */
export async function collectDue(
	app: App,
	settings: TrynalistSettings,
	horizonDays = 7,
): Promise<DueItem[]> {
	const docs: DocRef[] = await listDocs(app, settings.rootFolder);
	const limit = moment().add(horizonDays, "days").endOf("day");
	// Overdue has a floor too: without one, every dated item ever left
	// unticked stayed on the agenda for good and its file was read on every
	// recompute (L79).
	const floor = moment().subtract(180, "days").startOf("day");
	const out: DueItem[] = [];
	for (const doc of docs) {
		for (const child of doc.folder.children) {
			if (!(child instanceof TFile) || child.extension !== "md") continue;
			const fm = app.metadataCache.getFileCache(child)?.frontmatter;
			// A hand-written `due: 2024` parses as a number; moment() on it then
			// threw and took every reminder and the whole agenda down (L32).
			if (!fm?.id || typeof fm.due !== "string" || !fm.due || fm.checked) continue;
			const due = moment(fm.due as string);
			if (!due.isValid() || due.isAfter(limit) || due.isBefore(floor)) continue;
			out.push({
				docPath: doc.file.path,
				docTitle: doc.manifest.title,
				itemId: fm.id as string,
				filePath: child.path,
				// Filled in below from the file body — the filename is a slug and
				// mangles punctuation, which made the agenda unreadable.
				text: "",
				due: fm.due as string,
				hasTime: true,
				overdue: due.isBefore(moment()),
			});
		}
	}
	out.sort((a, b) => a.due.localeCompare(b.due));
	// Read the real item text for what survived the filter (a handful of files,
	// not the whole vault).
	for (const item of out) {
		const file = app.vault.getAbstractFileByPath(item.filePath);
		if (!(file instanceof TFile)) continue;
		try {
			const raw = await app.vault.cachedRead(file);
			item.text = firstBodyLine(raw);
			// `due` is stored as an instant, so a date-only item looks like one
			// due at 00:00; the source says which it is.
			const src = parseAllDates(withoutLinks(raw)).find((d) => moment(d.iso).isSame(moment(item.due)));
			if (src) item.hasTime = src.hasTime;
			item.overdue = isOverdue(item.due, item.hasTime);
		} catch {
			item.text = file.basename.replace(/-\w{10}$/, "").replace(/-/g, " ");
		}
	}
	return out;
}

/** The outline line itself: first line after the frontmatter, with the inline
 *  date syntax stripped (the agenda already shows the date separately). */
function firstBodyLine(raw: string): string {
	let body = raw;
	if (raw.startsWith("---\n")) {
		const end = raw.indexOf("\n---", 4);
		if (end !== -1) {
			const after = raw.indexOf("\n", end + 4);
			body = after === -1 ? "" : raw.slice(after + 1);
		}
	}
	const line = body.split("\n").find((l) => l.trim().length) ?? "";
	return line.replace(/!\([^)]*\)/g, "").replace(/\s{2,}/g, " ").trim();
}

/** Items that should raise a toast right now: due (minus lead time), not
 *  snoozed, and not already announced for this occurrence. */
export function dueForNotice(
	items: DueItem[],
	state: ReminderState,
	settings: TrynalistSettings,
): DueItem[] {
	const now = moment();
	const lead = Math.max(0, settings.reminderLeadMinutes);
	return items.filter((item) => {
		const when = moment(item.due).subtract(lead, "minutes");
		if (when.isAfter(now)) return false;
		const s = state[item.itemId];
		if (s?.snoozedUntil && moment(s.snoozedUntil).isAfter(now)) return false;
		// Re-announce only if the date itself moved (a recurring item rolling
		// over is a new occurrence, and should speak again).
		if (s?.notifiedFor === item.due) return false;
		return true;
	});
}

export function inQuietHours(settings: TrynalistSettings): boolean {
	if (!settings.quietHoursEnabled) return false;
	const now = moment();
	// A quiet DAY silences the whole day, regardless of the hours window.
	// moment's isoWeekday() is 1 = Monday … 7 = Sunday, which is what is stored.
	if ((settings.quietDays ?? []).includes(now.isoWeekday())) return true;
	const [fromH, fromM] = settings.quietHoursFrom.split(":").map((n) => parseInt(n, 10));
	const [toH, toM] = settings.quietHoursTo.split(":").map((n) => parseInt(n, 10));
	const start = now.clone().hour(fromH || 0).minute(fromM || 0).second(0);
	const end = now.clone().hour(toH || 0).minute(toM || 0).second(0);
	// A window like 22:00–07:00 wraps past midnight.
	return start.isAfter(end)
		? now.isSameOrAfter(start) || now.isBefore(end)
		: now.isSameOrAfter(start) && now.isBefore(end);
}

export function describeDue(item: DueItem, settings: TrynalistSettings): string {
	const due = moment(item.due);
	const time = settings.timeFormat === "24" ? "HH:mm" : (settings.showAmPm ? "h:mm A" : "h:mm");
	if (!item.hasTime) {
		// A day, not a moment: no "at 12:00 AM".
		const day = due.calendar(null, {
			sameDay: "[today]", nextDay: "[tomorrow]", nextWeek: "dddd", lastDay: "[yesterday]",
			lastWeek: "[last] dddd", sameElse: settings.dateFormat || "MMM D, YYYY",
		});
		return item.overdue ? `overdue since ${day}` : `due ${day}`;
	}
	if (item.overdue) return `overdue since ${due.calendar()}`;
	return due.isSame(moment(), "day") ? `due at ${due.format(time)}` : `due ${due.calendar()}`;
}

/** One toast for everything that just came due, with a jump action. */
/** Announce due items as a structured toast.
 *
 *  Takes a `notify` rather than building its own Notice: this used to assemble
 *  a fragment and call `new Notice()` directly, which meant the reminder — the
 *  toast users actually see day to day — was the ONE notification that never
 *  got the accent bar, the message block or the action row. It looked nothing
 *  like the rest. */
export function announce(
	items: DueItem[],
	settings: TrynalistSettings,
	notify: (opts: {
		message: string;
		kind?: "info" | "success" | "warning" | "error";
		duration?: number;
		actions?: Array<{ label: string; onClick: () => void }>;
	}) => void,
	onOpen: (item: DueItem) => void,
): void {
	if (!items.length) return;
	const shown = items.slice(0, 5);
	const single = items.length === 1;
	const head = single
		? `Trynalist: ${items[0].text || "(empty item)"} — ${describeDue(items[0], settings)}`
		: `Trynalist: ${items.length} items due`;
	const lines = single
		? [`in ${items[0].docTitle}`]
		: shown.map((i) => `• ${i.text || "(empty item)"} — ${i.docTitle}`);
	if (items.length > shown.length) lines.push(`…and ${items.length - shown.length} more`);
	// An overdue item is a warning, not neutral information — the accent is the
	// only thing distinguishing it at a glance.
	const overdue = shown.some((i) => isOverdue(i.due, i.hasTime));
	notify({
		message: [head, ...lines].join("\n"),
		kind: overdue ? "warning" : "info",
		duration: 0,
		actions: shown.map((i) => ({
			label: single ? "Open item" : trimLabel(i.text || "(empty item)"),
			onClick: () => onOpen(i),
		})),
	});
}

/** Button labels have to stay short or the action row wraps into a wall. */
function trimLabel(text: string): string {
	return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}
