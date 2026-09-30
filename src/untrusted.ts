/** Notes from documents shared WITH you are someone else's markdown, and
 *  Obsidian's renderer runs every registered code-block processor on it and
 *  loads whatever remote content it names. A collaborator's `dataviewjs` block
 *  could read `app.secretStorage`, and a remote image or iframe reports that
 *  the document was opened — the moment it is, since notes render on open
 *  (audit M52). Item text already has its own gated renderer; notes did not.
 *
 *  This rewrites untrusted note markdown before it reaches the renderer, so
 *  that it still reads the same but nothing in it runs or phones home:
 *  - fenced code keeps its text; a language outside a small set of plain
 *    highlight-only names is renamed, so no plugin processor claims it;
 *  - inline code starting `$=` or `=` (Dataview's inline JS and queries) gets
 *    a zero-width space after the backtick, so it shows but does not run;
 *  - remote images become ordinary links (nothing loads until clicked);
 *  - raw HTML that embeds or loads things (iframe, object, embed, video,
 *    audio, source, img, link, meta, base, form, style) is shown as text.
 *
 *  The source on disk is never changed; this only shapes what is rendered. */

const PLAIN_LANGUAGES = new Set([
	"", "text", "txt", "plain", "plaintext", "md", "markdown",
	"js", "javascript", "ts", "typescript", "jsx", "tsx", "json", "yaml", "yml", "toml", "ini",
	"python", "py", "sh", "bash", "zsh", "shell", "console", "powershell", "ps1",
	"css", "scss", "html", "xml", "sql", "java", "kotlin", "swift", "c", "cpp", "c++", "h", "cs", "csharp",
	"go", "rust", "rs", "ruby", "rb", "php", "perl", "lua", "r", "diff", "dockerfile", "makefile",
]);

const LOADING_TAGS = /<(\/?)(iframe|object|embed|video|audio|source|img|link|meta|base|form|style)\b/gi;

export function neutralizeMarkdown(md: string): string {
	const lines = md.split("\n");
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const open = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)(.*)$/.exec(line);
		if (fence === null && open) {
			fence = open[2];
			const lang = open[3].toLowerCase();
			if (!PLAIN_LANGUAGES.has(lang)) lines[i] = `${open[1]}${open[2]}text${open[3] ? ` (${open[3]})` : ""}`;
			continue;
		}
		if (fence !== null) {
			if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") fence = null;
			continue;   // inside a fence nothing renders as markup anyway
		}
		lines[i] = line
			// `$= js` / `= query` inline code
			.replace(/`(\$?=)/g, "`​$1")
			// ![alt](https://…) → [alt](https://…)
			.replace(/!\[([^\]]*)\]\((\s*<?https?:\/\/[^)]*)\)/gi, "[$1]($2)")
			.replace(LOADING_TAGS, "&lt;$1$2");
	}
	return lines.join("\n");
}
