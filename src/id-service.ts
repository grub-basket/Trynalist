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
