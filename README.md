# Trynalist

A Dynalist-style outliner for Obsidian — database-first: every outline line is a real Markdown note in your vault, so nothing is locked inside the plugin.

## How it works

- Documents live under a root folder (default `Trynalist/`), one subfolder per document.
- Each line of an outline is one Markdown file. Its frontmatter carries the structure: unique `id`, `parent` link, fractional `order` among siblings, authored `indent`, normalized `depth` (distance from the doc root), `created`/`modified` timestamps, plus item state (`checked`, `checklist`, `collapsed`, `heading`, `color`).
- The file body is the line itself (first line) and the item's note (everything after).
- A `<Doc>.trynalist` manifest file identifies each document; clicking it (in the Trynalist panel or the file explorer) opens the outline editor.
- Export produces `<Doc>.trynalist.zip` containing `outline.md` (a readable nested-bullet Markdown outline) and `meta.json` (lossless node metadata).

## Using it

- Open the **Trynalist panel** (ribbon icon or command) to list and create documents.
- In the editor: **Enter** new item · **Tab / Shift+Tab** indent/outdent · **Alt+↑/↓** move item · **Cmd/Ctrl+Enter** toggle complete · **Shift+Enter** edit the item's note (and again to come back) · **Alt+Enter** line break inside an item · **Backspace** on an empty item deletes it · click a **bullet** to collapse, the **magnifier** beside it to zoom in, breadcrumbs to zoom out.
- Views: outline, flat, article and **mind map**. The mind map is read-only — drag the background to pan, and click a node for its breadcrumb trail.

Deleted items go to the vault trash, never hard-deleted.

## Where this differs from Dynalist

Trynalist aims at parity, and most of it is parity. These are the deliberate
departures — each one is a place where Dynalist's limit came from its own
storage or its pricing, not from anything that would make the outliner better.

**Six heading levels instead of three.** Dynalist offered H1–H3. Our items are
Markdown files rendered by Obsidian, which has H1–H6 already, so capping at
three would have meant *removing* levels that work. Cycling wraps around at
six. A document written in Dynalist still imports exactly as it was — H1–H3
are simply the first three stops.

**The two hover controls can swap, and the swap is visible.** Dynalist's
default is that the **bullet collapses** and a **magnifier beside it zooms**;
Preferences → Control swaps them. We match that default and that preference,
with one addition: when the bullet is set to zoom, the bullet itself turns into
a magnifier on hover, so the two icons never both claim to do the same thing.
Hovering a bullet with nothing under it shows a muted dot rather than going
blank.

**No sharing, no publishing, no accounts.** Everything network-shaped is out of
scope — your documents are files in your vault, so Obsidian Sync, Git, or any
folder-sharing tool already does that job.

**Attachments live beside their document**, in the document's own
`_attachments` folder, rather than in one central store. Moving, exporting or
converting a document takes its files with it.

**Tags, search and the item finder are not paywalled.** Several of these were
Dynalist Pro features. There is no Pro here.

**Markdown is real Markdown.** Notes are rendered by Obsidian itself, so fenced
code gets syntax highlighting and a copy button, and tables, callouts, math and
embeds all work. Dynalist supported a fixed subset of inline formatting.

**Dynalist's themes are not included.** Trynalist inherits whatever Obsidian
theme you already use, so it matches the rest of your vault rather than bringing
its own colour schemes. The per-item colour swatches from Dynalist ARE here;
it is the whole-app themes that are not.

**Auto-pairing while typing** (brackets and formatting marks, wrapping a
selection) is an Obsidian/VS Code convention Dynalist did not have. It can be
turned off in settings.
