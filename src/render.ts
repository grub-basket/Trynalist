import { App, TFile, finishRenderMath, loadMathJax, renderMath, setIcon } from "obsidian";
import { DATE_RE, describeRecurrence, formatDate, isOverdue, parseDate } from "./dates";
import { DOC_EXTENSION } from "./types";
import type { TrynalistSettings } from "./types";

/** Obsidian loads MathJax lazily; renderMath() fails until it has. Tracked
 *  here so a row can fall back to source and re-render once it is ready. */
let mathLoaded = false;
let mathLoading: Promise<void> | null = null;

export function isMathReady(): boolean { return mathLoaded; }

/** Kick off (or await) the MathJax load. `onReady` fires once, after which
 *  rendering math is synchronous. */
export function ensureMathJax(onReady?: () => void): void {
	if (mathLoaded) return;
	if (!mathLoading) {
		mathLoading = Promise.resolve(loadMathJax()).then(() => { mathLoaded = true; });
	}
	void mathLoading.then(() => onReady?.()).catch((e) => {
		console.error("Trynalist: MathJax failed to load", e);
	});
}

export interface InlineContext {
	app: App;
	/** Vault path of the document, used to resolve relative embeds. */
	sourcePath: string;
	inlineImages: boolean;
	onLinkClick: (path: string) => void;
	onUrlClick: (url: string) => void;
	onTagClick: (tag: string) => void;
	/** Alt+click removes the chip, as Dynalist does for dates and tags. */
	onChipDelete?: (raw: string) => void;
	settings: TrynalistSettings;
	/** Clicking an inline image opens the viewer. */
	onImageClick?: (file: TFile) => void;
	/** Clicking a date chip opens the picker on that date. */
	onDateClick: (raw: string) => void;
	/** Called when math was found but MathJax was not ready yet. */
	onMathReady?: () => void;
}

/** Dynalist's flavour of inline markup, in match priority order.
 *  Note italics are `__like this__`, NOT `*like this*` — Dynalist deliberately
 *  differs from CommonMark here, and imported documents rely on it. */
const RULES: Array<{ name: string; re: RegExp }> = [
	{ name: "embed", re: /!\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/ },
	{ name: "image", re: /!\[([^\]]*)\]\(([^)\s]+)\)/ },
	{ name: "wikilink", re: /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/ },
	// The label class excludes `[` as well as `]`: otherwise a run of "["
	// made every start position scan to the end — quadratic (L72).
	{ name: "link", re: /\[([^\[\]]+)\]\(([^)\s]+)\)/ },
	{ name: "date", re: DATE_RE },
	{ name: "code", re: /`([^`]+)`/ },
	{ name: "math", re: /\$\$([^$]+)\$\$/ },
	// Obsidian renders `$x$` inline as well as `$$x$$`; only the block form was
	// here, so inline maths showed as source. Must follow the block rule: at the
	// same index the earlier rule in this list wins.
	// Pandoc's rule: no space just inside either `$`, and no digit right after
	// the closing one — otherwise "Paid $20 for food and $30 for gas" is maths
	// (M49). No lookbehind: those stop the plugin loading on iOS < 16.4.
	{ name: "mathInline", re: /\$([^$\s](?:[^$\n]*[^$\s])?)\$(?!\d)/ },
	{ name: "highlight", re: /==([^=\n]+)==/ },
	// `***both***` before `**bold**` before `*italic*`, or the shorter marker
	// eats the longer one's delimiters.
	{ name: "boldItalic", re: /\*\*\*([^*\n]+)\*\*\*/ },
	{ name: "bold", re: /\*\*([^*\n]+)\*\*/ },
	// Dynalist used `__italic__`; Obsidian users type `*italic*`. Support both
	// rather than making people learn which app they are in.
	{ name: "italic", re: /__([^_\n]+)__/ },
	// Flanking: no space just inside the markers, so "a * b * c" stays text.
	{ name: "italicStar", re: /\*([^*\s](?:[^*\n]*[^*\s])?)\*/ },
	{ name: "strike", re: /~~([^~\n]+)~~/ },
	// Single `~`/`^` after the doubled forms, same reason as the asterisks.
	{ name: "sub", re: /~([^~\s](?:[^~\n]*[^~\s])?)~/ },
	{ name: "sup", re: /\^([^\s^\n]+)\^/ },
	// No lookbehind: `(?<=\s)` stopped the whole plugin loading on iOS before
	// 16.4 (L71). The leading space is matched instead and handed back as
	// text by the "tag" case.
	{ name: "tag", re: /(?:^|\s)([#@][\w/-]+)/ },
	{ name: "url", re: /https?:\/\/[^\s<>()]+/ },
];

/** Render one line of Trynalist text into `host` as formatted DOM.
 *  Used only for rows that are NOT being edited — a focused row always shows
 *  its raw source so an edit can never lose markup. */
/** A backslash-escaped character is protected with a private-use sentinel
 *  BEFORE matching, so `\*not italic\*` cannot start a rule, and revealed
 *  again wherever text is finally written. Without this the backslashes showed
 *  up literally and the markup fired anyway. */
const ESC = "\uE000";
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!~^=$<>|])/g;

function protectEscapes(s: string): string {
	// The escaped character is SHIFTED into a private-use codepoint, not merely
	// prefixed. Leaving the literal `*` in place meant the italic rule still
	// matched it and ate the asterisks, so `\*not italic\*` rendered as plain
	// "not italic" instead of showing the asterisks.
	return s.replace(ESCAPABLE, (_, c: string) => ESC + String.fromCharCode(0xE100 + c.charCodeAt(0)));
}

/** Shift the protected characters back and drop the sentinels. */
const REVEAL_RE = new RegExp(`${ESC}([\\uE100-\\uE1FF])`, "g");

export function revealEscapes(s: string): string {
	// Fast path: the sentinel is a private-use codepoint no one types, so most
	// strings skip the regex entirely.
	if (!s.includes(ESC)) return s;
	return s.replace(REVEAL_RE, (_, c: string) => String.fromCharCode(c.charCodeAt(0) - 0xE100));
}

/** Every literal-text write goes through here so escapes are always resolved. */
function addText(host: HTMLElement, s: string): void {
	if (s) host.appendText(revealEscapes(s));
}

/** Past this length a line is shown as plain text: rendering recurses once
 *  per marked-up span, and one very long marked-up line blew the stack and
 *  blanked the whole outline view (L73). */
const RENDER_MAX_CHARS = 20_000;

export function renderInline(host: HTMLElement, text: string, ctx: InlineContext): void {
	if (text.length > RENDER_MAX_CHARS) { addText(host, text); return; }
	let needsMath = false;
	try {
		renderSegment(host, protectEscapes(text), ctx, () => { needsMath = true; });
	} catch (e) {
		// One bad line must never take the whole view down with it.
		console.error("Trynalist: could not render a line; showing it as text", e);
		host.empty();
		addText(host, text);
		return;
	}
	if (needsMath) void finishRenderMath();
}

function renderSegment(
	host: HTMLElement,
	text: string,
	ctx: InlineContext,
	markMath: () => void,
): void {
	if (!text) return;
	// Find whichever rule matches earliest in the remaining text.
	let best: { name: string; m: RegExpExecArray } | null = null;
	for (const rule of RULES) {
		const m = rule.re.exec(text);
		if (!m) continue;
		if (!best || m.index < best.m.index) best = { name: rule.name, m };
	}
	if (!best) { addText(host, text); return; }

	const { name, m } = best;
	if (m.index > 0) addText(host, text.slice(0, m.index));
	const rest = text.slice(m.index + m[0].length);

	switch (name) {
		case "embed": {
			// `![[path|label]]` — the label has to be split off, or the target
			// carries it and resolves to nothing, which is what made a link to
			// a document render as struck-through "missing" text.
			renderEmbed(host, m[1], ctx, m[2]);
			break;
		}
		case "image": {
			renderRemoteImage(host, m[1], m[2], ctx);
			break;
		}
		case "wikilink": {
			const path = m[1];
			const label = m[2] ?? m[1];
			// A link to a Canvas, a Base, or a Trynalist document reads better as a
			// typed chip (its own icon + name) than as bare underlined text — it
			// signals what you're about to open. Ordinary notes stay plain links.
			const dest = ctx.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath)
				?? ctx.app.vault.getAbstractFileByPath(path);
			if (dest instanceof TFile && CHIP_EXTENSIONS.has(dest.extension.toLowerCase())) {
				renderFileChip(host, dest, m[2], ctx);
				break;
			}
			const link = host.createSpan({ cls: "trynalist-link", text: revealEscapes(label) });
			link.setAttribute("aria-label", path);
			link.addEventListener("mousedown", (e) => {
				// Primary button only: a right or middle click must not open (or hand
				// to the OS) whatever the chip points at (L66).
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				ctx.onLinkClick(path);
			});
			break;
		}
		case "link": {
			const link = host.createSpan({ cls: "trynalist-link", text: revealEscapes(m[1]) });
			link.setAttribute("aria-label", m[2]);
			link.addEventListener("mousedown", (e) => {
				// Primary button only: a right or middle click must not open (or hand
				// to the OS) whatever the chip points at (L66).
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				ctx.onUrlClick(m[2]);
			});
			break;
		}
		case "date": {
			const parsed = parseDate(m[0]);
			if (!parsed) { addText(host, m[0]); break; }
			const chip = host.createSpan({
				cls: ctx.settings.highlightOverdue && isOverdue(parsed.iso, parsed.hasTime)
					? "trynalist-date is-overdue"
					: "trynalist-date",
			});
			// Leading icon, where Dynalist puts it. Decorative: the chip already
			// carries the date as its accessible name, so announcing "calendar"
			// on top of that would only add noise.
			setIcon(chip.createSpan({ cls: "trynalist-chip-icon" }), "calendar");
			chip.createSpan({ text: formatDate(parsed, ctx.settings) });
			if (parsed.recurrence) {
				chip.addClass("is-recurring");
				chip.createSpan({ cls: "trynalist-repeat-mark", text: "↻" });
				chip.setAttribute("aria-label", `${m[0]} — repeats ${describeRecurrence(parsed.recurrence)}`);
			} else {
				chip.setAttribute("aria-label", m[0]);
			}
			chip.addEventListener("mousedown", (e) => {
				// Primary button only: a right or middle click must not open (or hand
				// to the OS) whatever the chip points at (L66).
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				if (e.altKey) { ctx.onChipDelete?.(m[0]); return; }
				ctx.onDateClick(m[0]);
			});
			break;
		}
		case "code": {
			host.createEl("code", { cls: "trynalist-code", text: revealEscapes(m[1]) });
			break;
		}
		case "math": {
			if (!mathLoaded) {
				// Not loaded yet: show the source and ask the caller to re-render.
				addText(host, m[0]);
				ctx.onMathReady?.();
				break;
			}
			try {
				host.appendChild(renderMath(m[1], false));
				markMath();
			} catch (e) {
				console.error("Trynalist: LaTeX render failed", e);
				addText(host, m[0]);   // malformed LaTeX stays as source
			}
			break;
		}
		case "bold": {
			renderSegment(host.createEl("strong"), m[1], ctx, markMath);
			break;
		}
		case "boldItalic": {
			renderSegment(host.createEl("strong").createEl("em"), m[1], ctx, markMath);
			break;
		}
		case "italicStar": {
			renderSegment(host.createEl("em"), m[1], ctx, markMath);
			break;
		}
		case "highlight": {
			renderSegment(host.createEl("mark"), m[1], ctx, markMath);
			break;
		}
		case "sub": {
			renderSegment(host.createEl("sub"), m[1], ctx, markMath);
			break;
		}
		case "sup": {
			renderSegment(host.createEl("sup"), m[1], ctx, markMath);
			break;
		}
		case "mathInline": {
			if (!mathLoaded) {
				addText(host, m[0]);
				ctx.onMathReady?.();
				break;
			}
			try {
				host.appendChild(renderMath(m[1], false));
				markMath();
			} catch (e) {
				console.error("Trynalist: inline LaTeX render failed", e);
				addText(host, m[0]);
			}
			break;
		}
		case "italic": {
			renderSegment(host.createEl("em"), m[1], ctx, markMath);
			break;
		}
		case "strike": {
			renderSegment(host.createEl("del"), m[1], ctx, markMath);
			break;
		}
		case "tag": {
			const tag = m[1];
			const lead = m[0].slice(0, m[0].length - tag.length);
			if (lead) addText(host, lead);
			const el = host.createSpan({ cls: "trynalist-tag", text: tag });
			el.addEventListener("mousedown", (e) => {
				// Primary button only: a right or middle click must not open (or hand
				// to the OS) whatever the chip points at (L66).
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				if (e.altKey) { ctx.onChipDelete?.(tag); return; }
				ctx.onTagClick(tag);
			});
			break;
		}
		case "url": {
			const link = host.createSpan({ cls: "trynalist-link", text: m[0] });
			link.setAttribute("aria-label", m[0]);
			link.addEventListener("mousedown", (e) => {
				// Primary button only: a right or middle click must not open (or hand
				// to the OS) whatever the chip points at (L66).
				if (e.button !== 0) return;
				e.preventDefault();
				e.stopPropagation();
				ctx.onUrlClick(m[0]);
			});
			break;
		}
	}
	renderSegment(host, rest, ctx, markMath);
}

/** `![[file]]` — a vault attachment. */
/** Link/embed targets that render as a typed chip rather than plain text. */
const CHIP_EXTENSIONS = new Set([DOC_EXTENSION, "canvas", "base"]);

/** The lucide icon for a chip, by file extension. */
function chipIconFor(ext: string): string {
	switch (ext.toLowerCase()) {
		case DOC_EXTENSION: return "list-tree";     // a Trynalist document
		case "canvas": return "layout-dashboard";
		case "base": return "table";
		case "png": case "jpg": case "jpeg": case "gif": case "webp":
		case "svg": case "bmp": case "avif": return "image";
		default: return "paperclip";
	}
}

/** A compact, clickable chip for a linked file — icon + name, opens on click.
 *  Shared by canvas/base wikilinks and the embed path. */
function renderFileChip(host: HTMLElement, file: TFile, label: string | undefined, ctx: InlineContext): void {
	const chip = host.createSpan({ cls: "trynalist-link trynalist-file-chip" });
	setIcon(chip.createSpan({ cls: "trynalist-chip-icon" }), chipIconFor(file.extension));
	chip.createSpan({ text: label ?? file.basename });
	chip.setAttribute("aria-label", `Open "${file.basename}"`);
	chip.addEventListener("mousedown", (e) => {
		// Primary button only: a right or middle click must not open (or hand
		// to the OS) whatever the chip points at (L66).
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		ctx.onLinkClick(file.path);
	});
}

function renderEmbed(host: HTMLElement, target: string, ctx: InlineContext, label?: string): void {
	// getFirstLinkpathDest resolves by NAME, which fails for a full path with a
	// non-markdown extension — a `.trynalist` manifest among them. That miss is
	// why a link to a document rendered as struck-through "missing" text.
	const file = ctx.app.metadataCache.getFirstLinkpathDest(target, ctx.sourcePath)
		?? ctx.app.vault.getAbstractFileByPath(target);
	if (file instanceof TFile && file.extension === DOC_EXTENSION) {
		const chip = host.createSpan({ cls: "trynalist-link trynalist-doc-chip" });
		setIcon(chip.createSpan({ cls: "trynalist-doc-chip-icon" }), "list-tree");
		chip.createSpan({ text: label ?? file.basename });
		chip.setAttribute("aria-label", `Open "${file.basename}"`);
		chip.addEventListener("mousedown", (e) => {
			// Primary button only: a right or middle click must not open (or hand
			// to the OS) whatever the chip points at (L66).
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			ctx.onLinkClick(file.path);
		});
		return;
	}
	const isImage = file instanceof TFile
		&& ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(file.extension.toLowerCase());
	if (!file) {
		const missing = host.createSpan({ cls: "trynalist-embed-missing", text: `![[${target}]]` });
		missing.setAttribute("aria-label", "File not found");
		return;
	}
	if (!isImage || !ctx.inlineImages) {
		const chip = host.createSpan({ cls: "trynalist-link trynalist-file-chip" });
		// An image gets the image icon; other attachments get a paperclip, so the
		// same chip is not sometimes iconed and sometimes bare — that reads as a
		// bug rather than a distinction.
		setIcon(chip.createSpan({ cls: "trynalist-chip-icon" }), chipIconFor(file instanceof TFile ? file.extension : ""));
		chip.createSpan({ text: label ?? file.name });
		chip.setAttribute("aria-label", file.path);
		chip.addEventListener("mousedown", (e) => {
			// Primary button only: a right or middle click must not open (or hand
			// to the OS) whatever the chip points at (L66).
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			ctx.onLinkClick(file.path);
		});
		return;
	}
	const img = host.createEl("img", { cls: "trynalist-inline-image" });
	img.loading = "lazy";   // only what scrolls into view loads (L91)
	img.decoding = "async";
	img.src = ctx.app.vault.getResourcePath(file);
	img.alt = file.name;
	img.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
	// Click to see it properly. An inline image sits in a row, so it is always
	// small; the viewer is where you actually look at one.
	img.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		ctx.onImageClick?.(file);
	});
}

/** `![alt](url)` — a remote image. */
function renderRemoteImage(host: HTMLElement, alt: string, url: string, ctx: InlineContext): void {
	// Clicks are already gated to http(s) in openExternal; loading has to be
	// too, or a synced document could pull `file:///…` into the outline or fire
	// an arbitrary-scheme request on every render. Anything else is a chip.
	if (!ctx.inlineImages || !/^https?:\/\//i.test(url)) {
		const chip = host.createSpan({ cls: "trynalist-link trynalist-file-chip" });
		setIcon(chip.createSpan({ cls: "trynalist-chip-icon" }), "image");
		chip.createSpan({ text: alt || url });
		chip.setAttribute("aria-label", url);
		chip.addEventListener("mousedown", (e) => {
			// Primary button only: a right or middle click must not open (or hand
			// to the OS) whatever the chip points at (L66).
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			ctx.onUrlClick(url);
		});
		return;
	}
	const img = host.createEl("img", { cls: "trynalist-inline-image" });
	img.loading = "lazy";   // only what scrolls into view loads (L91)
	img.decoding = "async";
	img.src = url;
	img.alt = alt;
	img.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); });
}

/** Wrap (or unwrap) the current selection with a formatting marker. */
export function toggleWrap(el: HTMLElement, marker: string): string | null {
	const sel = el.doc.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!el.contains(range.commonAncestorContainer)) return null;

	const full = el.innerText;
	const pre = el.doc.createRange();
	pre.selectNodeContents(el);
	pre.setEnd(range.startContainer, range.startOffset);
	const start = pre.toString().length;
	const end = start + range.toString().length;

	const selected = full.slice(start, end);
	const before = full.slice(0, start);
	const after = full.slice(end);
	const wrapped = before.endsWith(marker) && after.startsWith(marker);

	let next: string;
	let caret: number;
	if (wrapped) {
		// Already wrapped — strip the markers.
		next = before.slice(0, -marker.length) + selected + after.slice(marker.length);
		caret = start - marker.length + selected.length;
	} else {
		next = `${before}${marker}${selected}${marker}${after}`;
		caret = start + marker.length + selected.length;
	}
	el.setText(next);
	delete el.dataset.rendered;   // raw source, safe to save from
	const node = el.firstChild;
	if (node && node.nodeType === Node.TEXT_NODE) {
		const r = el.doc.createRange();
		r.setStart(node, Math.min(caret, node.textContent?.length ?? 0));
		r.collapse(true);
		sel.removeAllRanges();
		sel.addRange(r);
	}
	return next;
}
