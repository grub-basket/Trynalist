import { moment } from "obsidian";
import type { TrynalistSettings } from "./types";

/** Dynalist writes dates inline as `!(2026-07-25)` or `!(2026-07-25 14:30)`.
 *  We keep that as the source of truth in the line text and mirror the parsed
 *  value into frontmatter for querying/sorting. */
export const DATE_RE = /!\((\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:\s*\|\s*(~?\d+[dwmy][1-7]*))?\)/;
const DATE_RE_G = new RegExp(DATE_RE.source, "g");

/** Dynalist's recurrence suffix: `2d`, `3w135`, `~30d`. Weekday digits are
 *  1 = Monday … 7 = Sunday. A leading `~` counts from completion instead of
 *  from the due date. See dev-docs/recurrence.md for the full grammar and the
 *  deliberate limits we are matching. */
export interface Recurrence {
	n: number;
	unit: "d" | "w" | "m" | "y";
	weekdays: number[];
	fromCompletion: boolean;
	raw: string;
}

export interface ParsedDate {
	/** ISO timestamp (local time interpreted). */
	iso: string;
	hasTime: boolean;
	raw: string;
	recurrence: Recurrence | null;
}

export function parseRecurrence(spec: string | undefined): Recurrence | null {
	if (!spec) return null;
	const m = /^(~?)(\d+)([dwmy])([1-7]*)$/.exec(spec.trim());
	if (!m) return null;
	const n = parseInt(m[2], 10);
	if (!n) return null;
	return {
		n,
		unit: m[3] as Recurrence["unit"],
		weekdays: [...new Set(m[4].split("").map((d) => parseInt(d, 10)))].sort(),
		fromCompletion: m[1] === "~",
		raw: spec.trim(),
	};
}

const UNIT_WORDS: Record<Recurrence["unit"], string> = {
	d: "day", w: "week", m: "month", y: "year",
};
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "every 3 weeks on Mon, Wed, Fri" — shown on the chip and in the picker. */
export function describeRecurrence(r: Recurrence): string {
	const every = r.n === 1 ? `every ${UNIT_WORDS[r.unit]}` : `every ${r.n} ${UNIT_WORDS[r.unit]}s`;
	const days = r.weekdays.length ? ` on ${r.weekdays.map((d) => DAY_NAMES[d]).join(", ")}` : "";
	const from = r.fromCompletion ? ", from completion" : "";
	return `${every}${days}${from}`;
}

/** The occurrence that follows `dueIso`, given when the item was completed. */
export function nextOccurrence(dueIso: string, r: Recurrence, completedAtIso?: string): string {
	const due = moment(dueIso);
	// `~` counts from when the item was actually completed, so a task finished
	// late doesn't immediately come due again.
	if (r.fromCompletion) {
		const base = moment(completedAtIso ?? undefined);
		base.set({ hour: due.hour(), minute: due.minute(), second: 0, millisecond: 0 });
		const next = base.add(r.n, unitOf(r.unit));
		return r.weekdays.length ? snapToWeekday(next, r.weekdays).toISOString() : next.toISOString();
	}
	if (r.unit === "w" && r.weekdays.length) {
		// Remaining selected weekday in this cycle's week…
		const isoDay = due.isoWeekday();
		const later = r.weekdays.find((d) => d > isoDay);
		if (later !== undefined) return due.clone().isoWeekday(later).toISOString();
		// …otherwise jump N weeks and take the first selected weekday.
		return due.clone().add(r.n, "weeks").isoWeekday(r.weekdays[0]).toISOString();
	}
	const next = due.clone().add(r.n, unitOf(r.unit));
	// Monthly overflow: Jan 31 + 1 month lands on Feb 28 (moment clamps), which
	// keeps the series monthly rather than skipping a month. Dynalist left this
	// undefined; see dev-docs/recurrence.md.
	return next.toISOString();
}

function unitOf(u: Recurrence["unit"]): "days" | "weeks" | "months" | "years" {
	return u === "d" ? "days" : u === "w" ? "weeks" : u === "m" ? "months" : "years";
}

function snapToWeekday(m: ReturnType<typeof moment>, weekdays: number[]): ReturnType<typeof moment> {
	for (let i = 0; i < 7; i++) {
		const probe = m.clone().add(i, "days");
		if (weekdays.includes(probe.isoWeekday())) return probe;
	}
	return m;
}

export function parseDate(text: string): ParsedDate | null {
	const m = DATE_RE.exec(text);
	if (!m) return null;
	const hasTime = !!m[2];
	const stamp = hasTime ? `${m[1]} ${m[2]}` : m[1];
	// Both hour forms. Strict mode is deliberate — it stops "2026-13-45" being
	// silently coerced — but strict `H` REJECTS a zero-padded hour, so
	// !(2026-08-20 09:30) parsed as nothing and rendered as literal text while
	// 14:30 on the same line worked. Only single-digit-hour times were broken,
	// which is why the fixtures (14:30, 2:30 PM) never caught it.
	const parsed = hasTime
		? moment(stamp, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD H:mm"], true)
		: moment(stamp, "YYYY-MM-DD", true);
	if (!parsed.isValid()) return null;
	return { iso: parsed.toISOString(), hasTime, raw: m[0], recurrence: parseRecurrence(m[3]) };
}

/** All dates in a string (an item can carry more than one). */
export function parseAllDates(text: string): ParsedDate[] {
	const out: ParsedDate[] = [];
	for (const m of text.matchAll(DATE_RE_G)) {
		const p = parseDate(m[0]);
		if (p) out.push(p);
	}
	return out;
}

/** Text with its links blanked out. A link's label is another item's text,
 *  so a date inside `[[x|Kickoff !(2026-09-01)]]` belongs to THAT item and
 *  must not become this one's due date or recurrence (M44). */
export function withoutLinks(text: string): string {
	return text
		.replace(/!?\[\[[^[\]]*\]\]/g, " ")
		.replace(/\[[^[\]\n]*\]\([^)\n]*\)/g, " ");
}

/** The date written back into an item's `due` frontmatter: the earliest one,
 *  ignoring dates that are part of a link's label. */
export function primaryDate(text: string, note: string): string | null {
	const all = [...parseAllDates(withoutLinks(text)), ...parseAllDates(withoutLinks(note))];
	if (!all.length) return null;
	return all.map((d) => d.iso).sort()[0];
}

/** Time part, honouring the 12/24-hour and AM/PM settings. */
export function timeFormatOf(settings: TrynalistSettings): string {
	if (settings.timeFormat === "24") return "HH:mm";
	return settings.showAmPm ? "h:mm A" : "h:mm";
}

/** Human-facing rendering of a parsed date. */
export function formatDate(d: ParsedDate, settings: TrynalistSettings): string {
	const m = moment(d.iso);
	const date = m.format(settings.dateFormat || "MMM D, YYYY");
	return d.hasTime ? `${date} ${m.format(timeFormatOf(settings))}` : date;
}

/** Source text for a date, as it is stored in the line. */
export function toSource(iso: string, hasTime: boolean, recurrence?: Recurrence | null): string {
	const m = moment(iso);
	const stamp = hasTime ? m.format("YYYY-MM-DD HH:mm") : m.format("YYYY-MM-DD");
	return recurrence ? `!(${stamp} | ${recurrence.raw})` : `!(${stamp})`;
}

/** Past due. A date with no time means "some time that day", so it is
 *  overdue only once the day is over — from midnight it read as "overdue
 *  since Today at 12:00 AM" and never landed in the agenda's Today (M42). */
export function isOverdue(iso: string, hasTime = true): boolean {
	const due = moment(iso);
	return (hasTime ? due : due.clone().endOf("day")).isBefore(moment());
}

/** Relative bucket used by the `within:` / `since:` / `until:` operators. */
/** A relative date expression against now: `1w` is a week AHEAD, `-1w` a week
 *  BACK. The minus is Dynalist's past indicator, and without it their own
 *  documented queries — `edited:-1w` — parsed as nothing at all.
 *
 *  Returns null for anything that is not relative, so callers can fall back to
 *  an absolute date. */
export function relativeTo(expr: string): moment.Moment | null {
	const rel = /^(-?)(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/
		.exec(expr.trim());
	if (!rel) return null;
	const unit = rel[3].startsWith("d") ? "days"
		: rel[3].startsWith("w") ? "weeks"
		: rel[3].startsWith("m") ? "months" : "years";
	const n = parseInt(rel[2], 10);
	return rel[1] === "-" ? moment().subtract(n, unit) : moment().add(n, unit);
}

/** `within:` — is the date between now and the expression's own end?
 *
 *  Directional, following the sign: `within:1w` is the week ahead, `within:-1w`
 *  the week behind. It used to be a symmetric window either side of now, which
 *  made `within:1w` quietly include last week too. */
export function matchesDateWindow(iso: string, expr: string): boolean {
	const m = moment(iso);
	const now = moment();
	const rel = relativeTo(expr);
	if (rel) {
		return rel.isAfter(now)
			? m.isBetween(now, rel, undefined, "[]")
			: m.isBetween(rel, now, undefined, "[]");
	}
	if (expr === "today") return m.isSame(now, "day");
	if (expr === "tomorrow") return m.isSame(now.clone().add(1, "day"), "day");
	if (expr === "yesterday") return m.isSame(now.clone().subtract(1, "day"), "day");
	if (expr === "week") return m.isSame(now, "week");
	if (expr === "month") return m.isSame(now, "month");
	const abs = moment(expr, ["YYYY-MM-DD", "YYYY-MM", "YYYY"], true);
	return abs.isValid() && m.isSame(abs, expr.length === 4 ? "year" : expr.length === 7 ? "month" : "day");
}

export function compareToDate(iso: string, expr: string, dir: "since" | "until"): boolean {
	const m = moment(iso);
	let ref = relativeTo(expr) ?? moment(expr, ["YYYY-MM-DD", "YYYY-MM", "YYYY"], true);
	if (expr === "today") ref = moment().startOf("day");
	if (expr === "tomorrow") ref = moment().add(1, "day").startOf("day");
	if (expr === "yesterday") ref = moment().subtract(1, "day").startOf("day");
	if (!ref.isValid()) return false;
	return dir === "since" ? m.isSameOrAfter(ref) : m.isSameOrBefore(ref);
}
