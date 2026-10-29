import { moment } from "obsidian";
import type { TrynaId } from "./types";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Built via String.fromCharCode, not a regex/string literal, so eslint's
// no-control-regex rule doesn't flag this control-character sweep.
const CONTROL_CHARS_RE = new RegExp(`[${Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("")}]`, "g");

/** 10-char random base36 id. Collision odds are negligible per doc. */
export function newId(): TrynaId {
	let out = "";
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}

/** Filename-safe slug from the first words of a line. Ids stay canonical in
 *  frontmatter; the slug just keeps files human-scannable. Files are named at
 *  creation and not renamed on later edits (rename churn breaks sync/history). */
export function slugFor(text: string): string {
	const s = text
		.toLowerCase()
		// Dates are item syntax, not words, and `(`, `)` and `!` in a file name
		// end a Markdown-style link early — `[x](m44-kickoff-!(2026-09-01)-….md)`
		// could never be followed.
		.replace(/!\([^)]*\)/g, " ")
		.replace(/[#[\]|^:\\/*?"<>()!%`]/g, " ")
		.trim()
		.split(/\s+/)
		.slice(0, 6)
		.join("-")
		// A leading dot would make a dotfile, which Obsidian's vault never lists —
		// the item would be on disk and invisible on reload.
		.replace(/^\.+/, "");
	return s.slice(0, 48) || "item";
}

/** The item file name template (GitHub issue #1). The default reproduces the
 *  names every earlier version wrote, so nothing changes until it is edited. */
export const DEFAULT_FILE_NAME_TEMPLATE = "{{slug}}-{{id}}";

/** What a bare `{{date}}` / `{{time}}` gives when no other format applies:
 *  the setting to follow the Templates plugin is off, or that plugin is. */
export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HHmmss";

export interface FileNameFormat {
	template: string;
	/** Optional regex run on the item's text; its groups fill `$1`…`$9`. */
	pattern: string;
	/** Formats for a bare `{{date}}` / `{{time}}`, taken from the core
	 *  Templates plugin when the setting says so. A format written in the
	 *  template (`{{date:YY-MM-DD}}`) always wins. */
	dateFormat?: string;
	timeFormat?: string;
}

/** Set by the plugin from its settings (load, save, sync). Module state
 *  rather than a parameter because a DocIndex is built in a dozen places
 *  that know nothing about settings; there is one plugin instance. */
let fileNameFormat: FileNameFormat = { template: DEFAULT_FILE_NAME_TEMPLATE, pattern: "" };
export function setFileNameFormat(f: FileNameFormat): void { fileNameFormat = f; }
export function getFileNameFormat(): FileNameFormat { return fileNameFormat; }

/** The Templates formats live in another plugin's settings file, which can
 *  change while Obsidian runs. Rather than watch it, the store calls this
 *  before naming a file: it re-reads at most every 15 s, and only when the
 *  template has a bare `{{date}}` or `{{time}}` that would use them. */
let formatRefresher: (() => Promise<void>) | null = null;
let refreshedAt = 0;
/** The read in progress. Every caller that arrives meanwhile waits for it,
 *  so items named during a read don't get the formats from before it. */
let inFlight: Promise<void> | null = null;
export function setFileNameFormatRefresher(fn: (() => Promise<void>) | null): void {
	formatRefresher = fn;
	refreshedAt = 0;
}
function runRefresh(): Promise<void> {
	refreshedAt = Date.now();
	const run: Promise<void> = (formatRefresher ? formatRefresher() : Promise.resolve())
		.catch(() => { /* keep the formats already loaded */ })
		.finally(() => { if (inFlight === run) inFlight = null; });
	inFlight = run;
	return run;
}
/** Read now, ignoring the 15 s limit: on load, a settings change, the settings tab. */
export function reloadFileNameFormat(): Promise<void> { return runRefresh(); }
export async function refreshFileNameFormat(): Promise<void> {
	if (inFlight) return inFlight;
	if (!formatRefresher || Date.now() - refreshedAt < 15000) return;
	// Bare or empty-format `{{date}}` / `{{date:}}` (and time) are the ones that use them.
	if (!/\{\{\s*(date|time)\s*(:\s*)?\}\}/i.test(fileNameFormat.template)) return;
	return runRefresh();
}
export function fileNameTemplateUses(variable: string): boolean {
	return new RegExp(`\\{\\{\\s*${variable}\\b`, "i").test(fileNameFormat.template);
}

/** What a template can draw on. `created` is the item's creation time (ISO);
 *  missing means now. */
export interface FileNameContext {
	text: string;
	id: string;
	parentText?: string;
	docTitle?: string;
	created?: string;
}

/** Item text as a file-name part: case and spaces kept, link targets, dates
 *  and the characters the vault, the filesystem or a Markdown link reject
 *  removed (same set slugFor strips). */
function cleanForName(text: string): string {
	const s = (text ?? "")
		.split("\n")[0]
		.replace(/!\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[#[\]|^:\\/*?"<>()!%`]/g, " ")
		.replace(CONTROL_CHARS_RE, "")
		.replace(/\s+/g, " ")
		.trim();
	return Array.from(s).slice(0, 80).join("").trim();
}

/** Invalid patterns are ignored (the settings tab says so), never thrown. */
export function compilePattern(pattern: string): RegExp | null {
	if (!pattern) return null;
	try { return new RegExp(pattern, "u"); } catch { return null; }
}

/** The base name (no folder, no `.md`, no collision suffix) for a new item
 *  file. Files are named once, at creation, and never renamed after, so a
 *  template change only affects items created from then on.
 *
 *  - A blank item is always `item-<id>`: that placeholder is what the
 *    rename-on-first-save in store.ts looks for, and it gives the item its
 *    real name once it has text.
 *  - One pass over the template, so text that happens to contain `{{id}}` or
 *    `$1` is never expanded a second time.
 *  - A template that renders to nothing usable falls back to the default. */
export function itemFileName(ctx: FileNameContext, fmt: FileNameFormat = fileNameFormat): string {
	const placeholder = `item-${ctx.id}`;
	if (!(ctx.text ?? "").trim()) return placeholder;
	// The default is built exactly as every earlier version built it — no
	// tidying — so names (and materialize's adopt-by-name check) match files
	// those versions wrote, e.g. `_draft-plan-<id>` keeps its underscore.
	const legacy = `${slugFor(ctx.text)}-${ctx.id}`;
	const template = fmt.template.trim() || DEFAULT_FILE_NAME_TEMPLATE;
	if (template === DEFAULT_FILE_NAME_TEMPLATE) return legacy;
	const re = compilePattern(fmt.pattern);
	const source = (ctx.text ?? "").split("\n")[0].replace(/!\([^)]*\)/g, " ");
	const groups = re ? re.exec(source) : null;
	const when = ctx.created && moment(ctx.created).isValid() ? moment(ctx.created) : moment();
	const render = (tpl: string): string => tpl.replace(
		/\{\{\s*(\w+)\s*(?::([^}]*))?\}\}|\$(\d|&|\$)/g,
		(whole: string, name: string | undefined, arg: string | undefined, ref: string | undefined) => {
			if (ref !== undefined) {
				if (ref === "$") return "$";
				const g = groups ? groups[ref === "&" ? 0 : Number(ref)] : undefined;
				return g ? cleanForName(g) : "";
			}
			switch ((name ?? "").toLowerCase()) {
				case "slug": return slugFor(ctx.text);
				case "text": return cleanForName(ctx.text);
				case "id": return ctx.id;
				case "uuid": return crypto.randomUUID();
				case "date": return when.format(arg?.trim() || fmt.dateFormat || DEFAULT_DATE_FORMAT);
				case "time": return when.format(arg?.trim() || fmt.timeFormat || DEFAULT_TIME_FORMAT);
				case "parent": return cleanForName(ctx.parentText ?? "");
				case "doc": return cleanForName(ctx.docTitle ?? "");
				default: return whole;   // unknown: left as typed, so the preview shows it
			}
		},
	);
	const tidy = (s: string): string => capBytes(safeName(
		s.replace(/\s+/g, " ").replace(/^[\s\-_.]+|[\s\-_]+$/g, ""),
		"",
	));
	return tidy(render(template)) || legacy;
}

/** File names are limited to 255 BYTES on most filesystems; safeName's 120
 *  characters can be 360 bytes of CJK text. 200 leaves room for ` 99.md`. */
function capBytes(name: string, max = 200): string {
	const enc = new TextEncoder();
	if (enc.encode(name).length <= max) return name;
	let out = "";
	let bytes = 0;
	for (const ch of name) {
		const b = enc.encode(ch).length;
		if (bytes + b > max) break;
		out += ch;
		bytes += b;
	}
	return out.replace(/[\s\-_.]+$/, "");
}

/** A filesystem- and Obsidian-safe folder/file NAME from free text. One place
 *  for every title that becomes a path component (documents, Dynalist folders,
 *  trash groups, grouping folders): strips the characters the filesystem and
 *  Obsidian reject, and — the part the old per-site regexes all missed — leading
 *  dots (Obsidian hides dot-entries entirely), trailing dots/spaces (Windows
 *  drops them), and the two names that are not names at all: `.` and `..`,
 *  which would resolve to the parent folder. Falls back to `fallback` when
 *  nothing is left. */
export function safeName(title: string, fallback = "Untitled"): string {
	const cleaned = (title ?? "")
		.replace(/[\\/:*?"<>|#[\]^]/g, "-")
		.replace(CONTROL_CHARS_RE, "")
		.trim()
		.replace(/^\.+/, "")
		.replace(/[. ]+$/, "")
		.trim();
	if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
	// Bounded, and never a Windows device name (L29): a long Dynalist title
	// made a path the OS refused, and a folder called "CON" or "aux.txt"
	// cannot exist on Windows — the import of that document failed there,
	// and a vault synced to Windows broke. Applied on every platform, so the
	// name is the same everywhere. Cut by code point, not UTF-16 unit.
	const points = Array.from(cleaned);
	const bounded = points.length > 120 ? points.slice(0, 120).join("").replace(/[. ]+$/, "") : cleaned;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(bounded)) return `${bounded} (name)`;
	return bounded || fallback;
}
