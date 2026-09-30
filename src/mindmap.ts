import { Notice, setIcon } from "obsidian";
import type { DocIndex } from "./store";
import type { TreeNode, TrynaId } from "./types";

/** A laid-out node: a box with its own position, plus the elbow that joins it
 *  to its parent. The tree is already clean, so layout is the easy part. */
interface Placed {
	node: TreeNode | null;   // null for the synthetic document root
	label: string;
	x: number;
	y: number;
	width: number;
	height: number;
	children: Placed[];
	/** Set during the measure pass; the layout reads its real height. */
	el: HTMLElement | null;
}

const H_GAP = 56;        // base horizontal distance between levels
const V_GAP = 10;        // base vertical distance between siblings
const NODE_W = 190;
/** Boxes drawn before branches fold into a "+N more" box (M67): every box is
 *  a positioned element plus a connector, and 5,000 of them froze a phone. */
const MAX_MAP_NODES = 1500;
const LINE_H = 20;
const PAD_Y = 8;

/** Read-only mind map, laid out like a one-sided bracket: the document's own
 *  title on the left, each level to its right, siblings stacked. Deliberately
 *  not editable — it sits over the outline and you go back to it to edit. */
export class MindMap {
	private scale = 1;
	private trail: TreeNode[] = [];
	private canvas: HTMLElement | null = null;
	private sizer: HTMLElement | null = null;
	private scroller: HTMLElement | null = null;
	private crumbEl: HTMLElement | null = null;
	private levelEl: HTMLElement | null = null;
	private contentW = 0;
	private contentH = 0;

	constructor(
		private index: DocIndex,
		private rootId: TrynaId | null,
		private onExit: () => void,
		private onZoomToItem: (id: TrynaId) => void,
		/** The document's title, drawn as the single root every branch hangs off. */
		private docTitle: string,
	) {}

	render(host: HTMLElement): void {
		host.empty();
		host.addClass("trynalist-mindmap");

		const bar = host.createDiv({ cls: "trynalist-mindmap-bar" });
		const back = bar.createEl("button", { cls: "trynalist-mindmap-btn" });
		setIcon(back, "arrow-left");
		back.createSpan({ text: " Back to document" });
		back.addEventListener("click", () => this.onExit());

		this.crumbEl = bar.createDiv({ cls: "trynalist-mindmap-crumbs" });
		this.paintCrumbs();

		const zoomWrap = bar.createDiv({ cls: "trynalist-mindmap-zoom" });
		const zoomOut = zoomWrap.createEl("button", { cls: "trynalist-mindmap-btn" });
		setIcon(zoomOut, "zoom-out");
		zoomOut.setAttribute("aria-label", "Zoom out");
		zoomOut.addEventListener("click", () => this.setScale(this.scale / 1.25));
		const level = zoomWrap.createSpan({ cls: "trynalist-mindmap-level", text: "100%" });
		const zoomIn = zoomWrap.createEl("button", { cls: "trynalist-mindmap-btn" });
		setIcon(zoomIn, "zoom-in");
		zoomIn.setAttribute("aria-label", "Zoom in");
		zoomIn.addEventListener("click", () => this.setScale(this.scale * 1.25));
		const reset = zoomWrap.createEl("button", { cls: "trynalist-mindmap-btn", text: "Fit" });
		reset.setAttribute("aria-label", "Fit the whole map in view");
		reset.addEventListener("click", () => this.fit());
		this.levelEl = level;

		const scroller = host.createDiv({ cls: "trynalist-mindmap-scroll" });
		this.scroller = scroller;
		// A sizer between the scroller and the canvas: `transform: scale` does not
		// change layout size, so without this the scrollbars would still describe
		// the unscaled map and half of a zoomed-in map would be unreachable.
		this.sizer = scroller.createDiv({ cls: "trynalist-mindmap-sizer" });
		this.canvas = this.sizer.createDiv({ cls: "trynalist-mindmap-canvas" });
		this.wirePan(scroller);
		this.paint();
		// Fit once the pane has a measurable width.
		window.setTimeout(() => this.fit(), 0);
	}

	/** Drag anywhere on the background to move the map, in any direction. The
	 *  nodes keep their own click handlers, so a drag that starts on a node is
	 *  ignored and a click that never moved is not swallowed. */
	private wirePan(scroller: HTMLElement): void {
		let panning = false;
		let startX = 0, startY = 0, fromLeft = 0, fromTop = 0;
		scroller.addEventListener("pointerdown", (e) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest(".trynalist-mindmap-node")) return;
			panning = true;
			startX = e.clientX; startY = e.clientY;
			fromLeft = scroller.scrollLeft; fromTop = scroller.scrollTop;
			scroller.addClass("is-panning");
			scroller.setPointerCapture(e.pointerId);
		});
		scroller.addEventListener("pointermove", (e) => {
			if (!panning) return;
			e.preventDefault();
			scroller.scrollLeft = fromLeft - (e.clientX - startX);
			scroller.scrollTop = fromTop - (e.clientY - startY);
		});
		const stop = (e: PointerEvent) => {
			if (!panning) return;
			panning = false;
			scroller.removeClass("is-panning");
			if (scroller.hasPointerCapture(e.pointerId)) scroller.releasePointerCapture(e.pointerId);
		};
		scroller.addEventListener("pointerup", stop);
		scroller.addEventListener("pointercancel", stop);
	}

	private setScale(next: number): void {
		this.scale = Math.max(0.1, Math.min(2.5, next));
		if (this.canvas) this.canvas.style.transform = `scale(${this.scale})`;
		if (this.sizer) {
			this.sizer.style.width = `${this.contentW * this.scale}px`;
			this.sizer.style.height = `${this.contentH * this.scale}px`;
		}
		if (this.levelEl) this.levelEl.setText(`${Math.round(this.scale * 100)}%`);
	}

	/** Fit the whole map inside the visible area — both axes, so nothing is
	 *  cut off, rather than snapping back to an arbitrary 100%. */
	private fit(): void {
		const scroller = this.scroller;
		if (!scroller || !this.contentW || !this.contentH) return;
		const availW = scroller.clientWidth - 24;
		const availH = scroller.clientHeight - 24;
		if (availW <= 0 || availH <= 0) return;
		this.setScale(Math.min(availW / this.contentW, availH / this.contentH, 1));
		scroller.scrollTo({ left: 0, top: 0 });
	}

	private paintCrumbs(): void {
		const el = this.crumbEl;
		if (!el) return;
		el.empty();
		if (!this.trail.length) {
			el.createSpan({ cls: "trynalist-suggest-trail", text: "Click a node to see where it sits." });
			return;
		}
		this.trail.forEach((n, i) => {
			if (i) el.createSpan({ cls: "trynalist-crumb-sep", text: " › " });
			const crumb = el.createSpan({ cls: "trynalist-crumb", text: n.text || "(empty)" });
			crumb.addEventListener("click", () => this.onZoomToItem(n.id));
		});
	}

	/** Descendants below a node, memoised — it drives both how far a branch
	 *  reaches and how much air its siblings get. */
	private sizeCache = new Map<TrynaId, number>();
	/** Boxes still allowed in this paint, and how many branches were folded. */
	private budget = 0;
	private folded = 0;
	private descendants(node: TreeNode): number {
		const hit = this.sizeCache.get(node.id);
		if (hit !== undefined) return hit;
		// Seed before recursing so a cycle in the data cannot spin forever.
		this.sizeCache.set(node.id, 0);
		let n = 0;
		for (const kid of this.index.children(node.id)) n += 1 + this.descendants(kid);
		this.sizeCache.set(node.id, n);
		return n;
	}

	/** Pass one: shape and horizontal position only. Heights are unknown here —
	 *  a box's height depends on how its text and note preview actually wrap,
	 *  which only the browser can answer. */
	private shape(node: TreeNode, x: number): Placed {
		this.budget--;
		const kids = node.collapsed ? [] : this.index.children(node.id);
		const placed: Placed = {
			node, label: node.text || "(empty)", x, y: 0, width: NODE_W, height: 0, children: [], el: null,
		};
		if (!kids.length) return placed;
		if (this.budget <= 0) {
			// Out of boxes: this branch folds into its own box. Double-clicking it
			// zooms into it, where it can be mapped on its own.
			placed.label = `${placed.label} (+${this.descendants(node)} more)`;
			this.folded++;
			return placed;
		}
		// Branch length grows with the weight hanging off it, so a heavy branch
		// is not crammed into the same column as a leaf.
		const reach = x + NODE_W + H_GAP + Math.min(160, Math.round(Math.sqrt(this.descendants(node)) * 12));
		placed.children = this.shapeList(kids, reach);
		return placed;
	}

	/** Shape a sibling list within the budget. Once it runs out, the rest of
	 *  the list becomes one "+N more" box — a long flat list is as costly as a
	 *  deep one (4,000 top-level items drew 4,000 boxes). */
	private shapeList(kids: TreeNode[], x: number): Placed[] {
		const out: Placed[] = [];
		for (let i = 0; i < kids.length; i++) {
			if (this.budget <= 0) {
				const rest = kids.length - i;
				out.push({ node: null, label: `+${rest} more item${rest === 1 ? "" : "s"}`, x, y: 0, width: NODE_W, height: 0, children: [], el: null });
				this.folded++;
				break;
			}
			out.push(this.shape(kids[i], x));
		}
		return out;
	}

	/** Pass three: stack siblings using the heights we just measured, then
	 *  centre each parent on the span of its own children. Doing this against
	 *  MEASURED heights is the whole fix — estimating from text length ignored
	 *  note previews and wrapped lines, so tall boxes overlapped their
	 *  neighbours and everything looked equidistant. */
	private place(p: Placed, top: number): number {
		if (!p.children.length) {
			p.y = top;
			return top + p.height;
		}
		let cursor = top;
		for (const kid of p.children) {
			const bottom = this.place(kid, cursor);
			const air = V_GAP + Math.min(40, Math.round(Math.sqrt(kid.node ? this.descendants(kid.node) : 0) * 6));
			cursor = bottom + air;
		}
		const first = p.children[0];
		const last = p.children[p.children.length - 1];
		const span = (first.y + last.y + last.height) / 2;
		p.y = span - p.height / 2;
		// A parent taller than its children's span would otherwise poke above
		// the block and collide with the previous sibling.
		const topMost = Math.min(p.y, first.y);
		const shift = topMost < top ? top - topMost : 0;
		if (shift) {
			const nudge = (q: Placed) => { q.y += shift; q.children.forEach(nudge); };
			nudge(p);
		}
		return Math.max(p.y + p.height, subtreeBottom(p));
	}

	private paint(): void {
		const canvas = this.canvas;
		if (!canvas) return;
		canvas.empty();
		this.sizeCache.clear();
		this.budget = MAX_MAP_NODES;
		this.folded = 0;
		const roots = this.index.children(this.rootId);
		if (!roots.length) {
			canvas.createDiv({ cls: "trynalist-panel-empty", text: "Nothing to map yet." });
			return;
		}

		// Everything hangs off one root: the document itself (or, when zoomed
		// in, the item you zoomed to), so the map reads as a single tree.
		const zoomed = this.rootId ? this.index.nodes.get(this.rootId) : null;
		const childX = NODE_W + H_GAP + 20;
		const docRoot: Placed = {
			node: zoomed ?? null,
			label: zoomed ? (zoomed.text || "(empty)") : this.docTitle,
			x: 0, y: 0, width: NODE_W, height: 0,
			children: this.shapeList(roots, childX),
			el: null,
		};

		// Pass two: build every box and let the browser measure it. The boxes
		// go in at their final x with a provisional y; only the y moves after.
		if (this.folded) {
			canvas.createDiv({
				cls: "trynalist-mindmap-banner",
				text: `Large outline: only the first ${MAX_MAP_NODES.toLocaleString()} items are mapped; the rest are folded into "+N more" boxes. Zoom into a branch to map it in full.`,
			});
		}
		const svg = createSvg("svg");
		svg.setAttribute("class", "trynalist-mindmap-lines");
		canvas.appendChild(svg);
		const all: Placed[] = [];
		const build = (p: Placed, isRoot: boolean) => {
			all.push(p);
			p.el = this.buildNode(canvas, p, isRoot);
			p.children.forEach((c) => build(c, false));
		};
		build(docRoot, true);
		for (const p of all) p.height = p.el ? p.el.offsetHeight : LINE_H + PAD_Y * 2;

		this.place(docRoot, 0);

		let maxX = 0, maxY = 0;
		for (const p of all) {
			if (p.el) p.el.style.top = `${p.y}px`;
			maxX = Math.max(maxX, p.x + p.width);
			maxY = Math.max(maxY, p.y + p.height);
		}
		this.contentW = maxX + 40;
		this.contentH = maxY + 40;
		canvas.style.width = `${this.contentW}px`;
		canvas.style.height = `${this.contentH}px`;
		svg.setAttribute("width", `${this.contentW}`);
		svg.setAttribute("height", `${this.contentH}`);
		for (const p of all) this.paintEdges(svg, p);
		this.setScale(this.scale);
	}

	/** The box itself, positioned horizontally; `top` is set after measuring. */
	private buildNode(canvas: HTMLElement, placed: Placed, isRoot: boolean): HTMLElement {
		const box = canvas.createDiv({ cls: "trynalist-mindmap-node" });
		const node = placed.node;
		if (isRoot) box.addClass("is-root");
		if (node?.checked) box.addClass("is-checked");
		if (node?.heading) box.addClass(`is-h${node.heading}`);
		if (node?.color) box.addClass(`tl-color-${node.color}`);
		box.setCssStyles({ left: `${placed.x}px`, top: "0px", width: `${placed.width}px` });
		// Labels showed raw markup — `**bold**`, `==highlight==` — because the
		// node text went in verbatim. The map is a map, so strip the markup
		// rather than rendering it: styled text inside a 190px box is noise.
		box.setText(plainOf(placed.label));
		if (node?.note) {
			box.createDiv({ cls: "trynalist-mindmap-note", text: previewOf(node.note) });
		}
		const hiddenKids = node?.collapsed ? this.index.children(node.id).length : 0;
		if (hiddenKids) box.createSpan({ cls: "trynalist-mindmap-more", text: `+${hiddenKids}` });
		box.addEventListener("click", () => {
			this.trail = node ? trailOf(this.index, node) : [];
			this.paintCrumbs();
			canvas.findAll(".trynalist-mindmap-node.is-selected")
				.forEach((n) => n.removeClass("is-selected"));
			box.addClass("is-selected");
		});
		if (node) box.addEventListener("dblclick", () => this.onZoomToItem(node.id));
		return box;
	}

	private paintEdges(svg: SVGElement, placed: Placed): void {
		for (const child of placed.children) {
			// One elbow per child: out from the parent, across, into the child.
			const path = createSvg("path");
			const x1 = placed.x + placed.width;
			const y1 = placed.y + placed.height / 2;
			const x2 = child.x;
			const y2 = child.y + child.height / 2;
			const mid = x1 + (x2 - x1) / 2;
			path.setAttribute("d", `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`);
			path.setAttribute("class", "trynalist-mindmap-edge");
			svg.appendChild(path);
		}
	}
}

/** Inline markup removed, leaving the words. Deliberately not a renderer:
 *  the map wants a legible label, not formatting. */
export function plainOf(text: string): string {
	return text
		.replace(/!?\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g, (_: string, p: string, l: string | undefined) => l || p.split("/").pop() || p)
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/==([^=]+)==/g, "$1")
		.replace(/\\([\\`*_~^=$[\]()])/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** A one-line, markup-free glimpse of a note. The map is a map, not a reader:
 *  raw fences and table pipes in a 190px box are just noise. */
function previewOf(note: string): string {
	const cleaned = note
		.replace(/```[\s\S]*?```/g, "code")
		.replace(/\|[^\n]*\|/g, "")
		.replace(/[#*_>`~-]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 90 ? `${cleaned.slice(0, 88)}…` : cleaned;
}

function subtreeBottom(p: Placed): number {
	if (!p.children.length) return p.y + p.height;
	return Math.max(p.y + p.height, subtreeBottom(p.children[p.children.length - 1]));
}

function trailOf(index: DocIndex, node: TreeNode): TreeNode[] {
	const out: TreeNode[] = [node];
	const seen = new Set<TrynaId>([node.id]);
	let p = node.parent ? index.nodes.get(node.parent) : null;
	while (p && !seen.has(p.id)) { out.unshift(p); seen.add(p.id); p = p.parent ? index.nodes.get(p.parent) : null; }
	return out;
}

export function mindMapUnavailable(): void {
	new Notice("Trynalist: open a document first.");
}
