# Trynalist

A Dynalist-style outliner for Obsidian. Every line of an outline is a real
Markdown note in your vault, so nothing is locked inside the plugin.

> **Beta.** This is distributed for testing through BRAT and is not in the
> Obsidian community plugin store. Expect rough edges, and keep backups of any
> vault you try it in.

## Installing with BRAT

1. Install the **BRAT** plugin from Obsidian's community plugins.
2. In BRAT's settings, choose **Add beta plugin**.
3. Paste `grub-basket/Trynalist`.
4. Enable **Trynalist** in Community plugins.

BRAT will pick up new releases as they are published.

## What it does

- **Documents** live under a root folder (`Trynalist/` by default), one
  subfolder per document, identified by a `<Doc>.trynalist` manifest.
- **Every outline line is one Markdown file.** Its frontmatter carries the
  structure: a unique `id`, a `parent` link, a fractional `order` among
  siblings, the authored `indent`, a normalised `depth`, timestamps, and item
  state (checkbox, collapsed, heading level, colour, due date).
- **The file body is the line and its note** — first line is the item, the rest
  is the note underneath it.
- **Four views**: outline, flat, article, and a read-only mind map.
- **Notes render as real Markdown** through Obsidian's own renderer, so fenced
  code gets syntax highlighting and a copy button, and tables, callouts, math
  and embeds all work.
- **Mirrors and portals**: show a subtree from elsewhere — including another
  document — as a read-only window.
- **Import** from Dynalist OPML, Dynalist JSON, or indented text. **Export** to
  a `.trynalist.zip` holding a readable Markdown outline plus lossless metadata.

Deleted items go to the vault trash. They are never hard-deleted.

## Keyboard

**Enter** new item · **Tab / Shift+Tab** indent and outdent · **Alt+↑/↓** move
an item · **Cmd/Ctrl+Enter** toggle complete · **Shift+Enter** edit the item's
note, and again to come back · **Alt+Enter** line break inside an item ·
**Backspace** on an empty item deletes it.

Click a **bullet** to collapse, the **magnifier** beside it to zoom in, and the
breadcrumbs to zoom back out. Every command is rebindable in Obsidian's hotkey
settings, and every one is scoped to a Trynalist document — with an ordinary
note focused, the same chord does whatever Obsidian normally does.

## Where this differs from Dynalist

Trynalist aims at parity, and most of it is parity. The deliberate departures:

- **Six heading levels instead of three.** Items are Markdown rendered by
  Obsidian, which already has H1–H6; capping at three would have removed levels
  that work. Documents imported from Dynalist are unaffected.
- **The bullet collapses and a magnifier zooms**, as in Dynalist, and the
  preference that swaps them is here too. When the bullet is set to zoom, it
  turns into a magnifier on hover so the two controls never look identical.
- **No sharing, publishing, or accounts.** Documents are files in your vault,
  so Obsidian Sync, Git, or any folder-sharing tool already covers it.
- **Attachments live beside their document**, so moving, exporting or converting
  one takes its files along.
- **Nothing is paywalled.** Several of these were Dynalist Pro features.
- **Dynalist's themes are not included.** Trynalist inherits your Obsidian
  theme. The per-item colour swatches are here; the whole-app themes are not.

## Didn't make it across

Honest list of Dynalist behaviour that is not here, beyond the deliberate
departures above.

- **`Alt+Enter` — a line break inside an item — does not work on macOS.** The
  command is registered and the action itself is correct, but the key press
  appears never to reach the plugin; the likely cause is that macOS treats
  Option as a text-input modifier and consumes the chord first. **Use the note
  instead:** `Shift+Enter` moves into an item's note, `Enter` there makes
  ordinary new lines, and `Shift+Enter` brings you back. `Mod+Shift+Enter` is
  bound to the same action and does work.
- **Dynalist's themes.** Trynalist uses your Obsidian theme; see above.
- **Sharing, publishing, and accounts.** Out of scope by design.

## Status

Mirrors are read-only for now: editing through one means writing into another
document, and undo would have to span both. The read-only window works today.

## Licence

MIT.
