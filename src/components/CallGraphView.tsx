import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallGraph, GraphEdge, GraphNode, GraphScope, ReviewComment } from "../types";
import { CodeLines, submitOnEnter } from "./CodeLines";
import { Splitter } from "./Splitter";
import { Close, Code, Comment, DiffIcon, Fit } from "./Icons";

interface Props {
  graph: CallGraph | null;
  title: string;
  scope: GraphScope;
  onScope: (s: GraphScope) => void;
  hideTests: boolean;
  onOpenDiff: (file: string, line: number, side: "new" | "old") => void;
  onOpenEditor: (file: string, line: number) => void;
  onComment: (node: GraphNode, body: string) => void;
  /** Selected function id (owned by the workspace so "back" can restore it). */
  selected: string | null;
  onSelect: (id: string | null) => void;
  comments: ReviewComment[];
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onUpdateComment: (id: string, body: string) => void;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const NW = 230;
const NH = 58;
const GX = 96;
const GY = 26;
const GHOST_W = 170;
const COMP_GAP = 70;
const LABEL_H = 34;
const PAIR_GAP_X = 56;
const PAIR_GAP_Y = 22;

/** A laid-out box: a function, or a "ghost" standing in for unknown callers. */
interface Box {
  id: string;
  node: GraphNode | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface LayoutEdge extends GraphEdge {
  ghost?: boolean;
}

interface Layout {
  boxes: Box[];
  byId: Map<string, Box>;
  edges: LayoutEdge[];
  labels: { text: string; x: number; y: number }[];
  width: number;
  height: number;
}

const ghostId = (id: string) => `ghost:${id}`;
const isGhost = (id: string) => id.startsWith("ghost:");

/** Changed functions whose callers we can't see get a ghost caller. */
function wantsGhost(n: GraphNode) {
  return n.status !== "context" && n.status !== "deleted" && !n.isTest;
}

function computeLayout(graph: CallGraph, hideTests: boolean): Layout {
  const nodes = graph.nodes.filter((n) => !(hideTests && n.isTest));
  const ids = new Set(nodes.map((n) => n.id));
  const realEdges: LayoutEdge[] = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const byIdNode = new Map(nodes.map((n) => [n.id, n]));

  // Ghost callers for changed functions nobody (visible) calls.
  const called = new Set(realEdges.map((e) => e.to));
  const ghostEdges: LayoutEdge[] = nodes
    .filter((n) => wantsGhost(n) && !called.has(n.id))
    .map((n) => ({ from: ghostId(n.id), to: n.id, isNew: false, ghost: true }));
  const edges = [...realEdges, ...ghostEdges];
  const vertices = [...nodes.map((n) => n.id), ...ghostEdges.map((e) => e.from)];
  const sortKey = (id: string) => {
    const n = byIdNode.get(isGhost(id) ? id.slice(6) : id)!;
    return `${n.file}\u0000${String(n.line).padStart(8, "0")}`;
  };

  // Connected components (union-find), ghosts included.
  const parent = new Map<string, string>(vertices.map((v) => [v, v]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) parent.set(find(e.from), find(e.to));
  const comps = new Map<string, string[]>();
  for (const v of vertices) comps.set(find(v), [...(comps.get(find(v)) ?? []), v]);
  const all = [...comps.values()];
  const realEdgeCount = (c: string[]) => realEdges.filter((e) => c.includes(e.from)).length;
  // Chains: components with at least one real call. Pairs: ghost → function.
  const chains = all.filter((c) => realEdgeCount(c) > 0).sort((a, b) => b.length - a.length);
  const pairs = all.filter((c) => c.length === 2 && realEdgeCount(c) === 0).sort((a, b) => sortKey(a[0]).localeCompare(sortKey(b[0])));
  const singles = all.filter((c) => c.length === 1).map((c) => c[0]).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);

  const boxes: Box[] = [];
  const labels: Layout["labels"] = [];
  const widthOf = (id: string) => (isGhost(id) ? GHOST_W : NW);
  const push = (id: string, x: number, y: number) =>
    boxes.push({ id, node: isGhost(id) ? null : byIdNode.get(id)!, x, y, w: widthOf(id), h: NH });
  let y = 0;
  let width = 0;

  /** Layered (left → right) layout of one component at (ox, oy). */
  const layoutComponent = (comp: string[], ox: number, oy: number) => {
    const inComp = new Set(comp);
    const indeg = new Map(comp.map((v) => [v, 0]));
    for (const e of edges) if (inComp.has(e.from)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    // DFS to drop back edges (cycles), sources first.
    const order = [...comp].sort((a, b) => indeg.get(a)! - indeg.get(b)! || sortKey(a).localeCompare(sortKey(b)));
    const state = new Map<string, number>(); // 1 = on stack, 2 = done
    const forward: [string, string][] = [];
    const topo: string[] = [];
    const visit = (v: string) => {
      state.set(v, 1);
      for (const w of out.get(v) ?? []) {
        if (!inComp.has(w)) continue;
        const st = state.get(w);
        if (st === 1) continue; // back edge
        forward.push([v, w]);
        if (!st) visit(w);
      }
      state.set(v, 2);
      topo.push(v);
    };
    for (const v of order) if (!state.get(v)) visit(v);
    topo.reverse();
    const rank = new Map<string, number>(comp.map((v) => [v, 0]));
    for (const v of topo) for (const [a, b] of forward) if (a === v) rank.set(b, Math.max(rank.get(b)!, rank.get(v)! + 1));
    // Ghosts sit directly left of the function they stand in for.
    for (const v of comp) if (isGhost(v)) rank.set(v, Math.max(0, rank.get(v.slice(6))! - 1));

    const cols: string[][] = [];
    for (const v of topo) (cols[rank.get(v)!] ??= []).push(v);
    // One barycenter pass to reduce crossings.
    const pos = new Map<string, number>();
    cols.forEach((c, ci) => {
      if (!c) return;
      if (ci > 0) {
        const preds = (v: string) => forward.filter(([, b]) => b === v).map(([a]) => pos.get(a)).filter((p): p is number => p != null);
        const bary = (v: string) => {
          const ps = preds(v);
          return ps.length ? ps.reduce((acc, x) => acc + x, 0) / ps.length : Infinity;
        };
        c.sort((a, b) => bary(a) - bary(b));
      }
      c.forEach((v, i) => pos.set(v, i));
    });
    const dense = cols.filter(Boolean);
    const tallest = Math.max(...dense.map((c) => c.length));
    const h = tallest * (NH + GY) - GY;
    // Column x: ghost-only columns are narrower; keep function columns aligned.
    let x = ox;
    cols.forEach((c) => {
      if (!c) return;
      const colW = Math.max(...c.map(widthOf));
      const colH = c.length * (NH + GY) - GY;
      const off = (h - colH) / 2;
      c.forEach((v, i) => push(v, x + (colW - widthOf(v)), oy + off + i * (NH + GY)));
      x += colW + GX;
    });
    return { w: x - GX - ox, h };
  };

  if (chains.length) {
    labels.push({ text: "Call chains", x: 0, y });
    y += LABEL_H;
    for (const comp of chains) {
      const r = layoutComponent(comp, 0, y);
      width = Math.max(width, r.w);
      y += r.h + COMP_GAP;
    }
  }

  if (pairs.length) {
    labels.push({ text: chains.length ? "Changed, no connection" : "Changed functions", x: 0, y });
    y += LABEL_H;
    const pairW = GHOST_W + GX + NW;
    const cols = Math.min(pairs.length, Math.max(1, Math.min(3, Math.ceil(Math.sqrt(pairs.length)))));
    pairs.forEach((comp, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      layoutComponent(comp, col * (pairW + PAIR_GAP_X), y + row * (NH + PAIR_GAP_Y));
    });
    const rows = Math.ceil(pairs.length / cols);
    width = Math.max(width, cols * (pairW + PAIR_GAP_X) - PAIR_GAP_X);
    y += rows * (NH + PAIR_GAP_Y) - PAIR_GAP_Y + COMP_GAP;
  }

  if (singles.length) {
    labels.push({ text: "Other changes", x: 0, y });
    y += LABEL_H;
    const cols = Math.min(singles.length, 4);
    singles.forEach((id, i) => push(id, (i % cols) * (NW + 40), y + Math.floor(i / cols) * (NH + PAIR_GAP_Y)));
    width = Math.max(width, cols * (NW + 40) - 40);
    y += Math.ceil(singles.length / cols) * (NH + PAIR_GAP_Y) - PAIR_GAP_Y + COMP_GAP;
  }

  return { boxes, byId: new Map(boxes.map((b) => [b.id, b])), edges, labels, width, height: y };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function cssVars() {
  const s = getComputedStyle(document.documentElement);
  const v = (n: string) => s.getPropertyValue(n).trim();
  return {
    code: v("--code"), pane: v("--pane"), pane2: v("--pane2"), sel: v("--sel"), text: v("--text"),
    muted: v("--muted"), faint: v("--faint"), edge: v("--edge"), acc: v("--acc"),
    add: v("--add"), addbg: v("--addbg"), addnode: v("--addnode"),
    del: v("--del"), delbg: v("--delbg"), delnode: v("--delnode"),
    mod: v("--mod"), modbg: v("--modbg"),
  };
}
type Colors = ReturnType<typeof cssVars>;

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
const SANS = '"Rubik", system-ui, sans-serif';

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function statusStyle(n: GraphNode, c: Colors) {
  switch (n.status) {
    case "added": return { fill: c.addnode, tag: "new", tagColor: c.add };
    case "modified": return { fill: c.modbg, tag: n.movedFrom ? "moved+changed" : "changed", tagColor: c.mod };
    case "deleted": return { fill: c.delnode, tag: "deleted", tagColor: c.del };
    case "moved": return { fill: c.pane2, tag: "moved", tagColor: c.muted };
    default: return { fill: c.pane2, tag: "", tagColor: c.muted };
  }
}

function label(n: GraphNode) {
  return n.container ? `${n.container}.${n.name}` : n.name;
}

function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 7, y - 4);
  ctx.lineTo(x - 7, y + 4);
  ctx.closePath();
  ctx.fill();
}

function draw(
  ctx: CanvasRenderingContext2D,
  L: Layout,
  view: { x: number; y: number; z: number },
  size: { w: number; h: number },
  dpr: number,
  selected: string | null,
  hover: string | null,
  ghostNote: string,
) {
  const c = cssVars();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c.code;
  ctx.fillRect(0, 0, size.w, size.h);
  ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, dpr * view.x, dpr * view.y);

  const focus = selected ?? hover;
  const related = new Set<string>();
  if (focus) for (const e of L.edges) if (e.from === focus || e.to === focus) related.add(e.from).add(e.to);

  // Section labels.
  ctx.font = `400 13px ${SANS}`;
  ctx.fillStyle = c.muted;
  ctx.textBaseline = "alphabetic";
  for (const l of L.labels) ctx.fillText(l.text, l.x, l.y + 16);

  // Edges.
  for (const e of L.edges) {
    const a = L.byId.get(e.from), b = L.byId.get(e.to);
    if (!a || !b) continue;
    const hot = !e.ghost && focus && (e.from === focus || e.to === focus);
    const color = e.ghost ? c.faint : hot ? c.text : e.isNew ? c.acc : c.edge;
    ctx.strokeStyle = color;
    ctx.lineWidth = hot || e.isNew ? 2 : 1.5;
    ctx.setLineDash(e.ghost ? [4, 4] : []);
    ctx.globalAlpha = focus && !related.has(e.to) ? 0.35 : e.ghost ? 0.8 : 1;
    const sx = a.x + a.w, sy = a.y + a.h / 2;
    const tx = b.x, ty = b.y + b.h / 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    if (tx > sx) {
      const mx = (sx + tx) / 2;
      ctx.bezierCurveTo(mx, sy, mx, ty, tx - 2, ty);
    } else {
      // Back edge / same column: loop around below.
      const loop = Math.max(a.y + a.h, b.y + b.h) + 22;
      ctx.bezierCurveTo(sx + 50, sy, sx + 50, loop, (sx + tx) / 2, loop);
      ctx.bezierCurveTo(tx - 50, loop, tx - 50, ty, tx - 2, ty);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    drawArrow(ctx, tx, ty, color);
    ctx.globalAlpha = 1;
  }

  // Boxes.
  for (const b of L.boxes) {
    const n = b.node;
    const dim = focus && !related.has(b.id) && b.id !== focus;
    ctx.globalAlpha = dim ? 0.45 : 1;

    if (!n) {
      // Ghost: unknown callers.
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = c.faint;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.roundRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 12);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textBaseline = "middle";
      ctx.font = `500 12px ${MONO}`;
      ctx.fillStyle = c.faint;
      ctx.fillText(fit(ctx, "? callers unknown", b.w - 24), b.x + 12, b.y + 21);
      ctx.font = `400 11px ${SANS}`;
      ctx.fillText(fit(ctx, ghostNote, b.w - 24), b.x + 12, b.y + 40);
      ctx.globalAlpha = 1;
      continue;
    }

    const st = statusStyle(n, c);
    if (n.id === selected) {
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8, 15);
      ctx.stroke();
    }
    ctx.fillStyle = st.fill;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 12);
    ctx.fill();
    if (n.id === hover && n.id !== selected) {
      ctx.strokeStyle = c.faint;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const pad = 12;
    const tx = b.x + pad;
    ctx.textBaseline = "middle";
    ctx.font = `500 10px ${MONO}`;
    const tagW = st.tag ? ctx.measureText(st.tag).width + 8 : 0;
    ctx.font = `500 13px ${MONO}`;
    ctx.fillStyle = n.status === "context" ? c.muted : c.text;
    const name = fit(ctx, label(n), b.w - pad * 2 - tagW);
    ctx.fillText(name, tx, b.y + 20);
    const nameW = ctx.measureText(name).width;
    if (st.tag) {
      ctx.font = `500 10px ${MONO}`;
      ctx.fillStyle = st.tagColor;
      ctx.fillText(st.tag, tx + nameW + 8, b.y + 21);
    }
    ctx.font = `400 11px ${MONO}`;
    ctx.fillStyle = c.muted;
    const loc = `${n.file}:${n.line}${n.movedFrom ? ` · from ${n.movedFrom}` : ""}`;
    ctx.fillText(fit(ctx, loc, b.w - pad * 2), tx, b.y + 40);
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CallGraphView({
  graph,
  title,
  scope,
  onScope,
  hideTests,
  onOpenDiff,
  onOpenEditor,
  onComment,
  selected,
  onSelect: setSelected,
  comments,
  onAddComment,
  onRemoveComment,
  onUpdateComment,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 40, y: 80, z: 1 });
  const [hover, setHover] = useState<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; hit: string | null } | null>(null);

  const layout = useMemo(() => (graph ? computeLayout(graph, hideTests) : null), [graph, hideTests]);

  // Resize.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Redraw on theme switches and once web fonts are ready.
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMq = () => setThemeTick((t) => t + 1);
    mq.addEventListener("change", onMq);
    document.fonts?.ready.then(() => setThemeTick((t) => t + 1));
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", onMq);
    };
  }, []);

  const fitView = useCallback(() => {
    if (!layout || !size.w) return;
    const top = 76, pad = 40;
    const aw = size.w - pad * 2, ah = size.h - top - pad - 30;
    const z = Math.min(1.15, Math.max(0.25, Math.min(aw / Math.max(layout.width, 1), ah / Math.max(layout.height, 1))));
    setView({ x: pad + Math.max(0, (aw - layout.width * z) / 2), y: top + 10, z });
  }, [layout, size.w, size.h]);

  // Fit when a new graph arrives, and keep fitting on resize (panel open /
  // close, window resize) until the user pans or zooms by hand.
  const autoFit = useRef(true);
  const lastGraph = useRef<CallGraph | null>(null);
  useEffect(() => {
    if (graph && size.w && autoFit.current && graph === lastGraph.current) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);
  useEffect(() => {
    if (graph && size.w && graph !== lastGraph.current) {
      lastGraph.current = graph;
      autoFit.current = true;
      fitView();
      if (selected && !graph.nodes.some((n) => n.id === selected)) setSelected(null);
    }
  }, [graph, size.w, fitView, selected]);

  // Keep the selected function on screen (e.g. when the side panel opens).
  useEffect(() => {
    if (!selected || !layout || !size.w) return;
    const b = layout.byId.get(selected);
    if (!b) return;
    setView((v) => {
      const x0 = v.x + b.x * v.z, x1 = v.x + (b.x + b.w) * v.z;
      const y0 = v.y + b.y * v.z, y1 = v.y + (b.y + b.h) * v.z;
      const pad = 24, top = 90;
      let { x, y } = v;
      if (x0 < pad || x1 > size.w - pad) x = size.w / 2 - (b.x + b.w / 2) * v.z;
      if (y0 < top || y1 > size.h - 60) y = size.h / 2 - (b.y + b.h / 2) * v.z;
      return x === v.x && y === v.y ? v : { ...v, x, y };
    });
  }, [selected, layout, size.w, size.h]);

  // Paint.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    if (!layout) {
      const c = cssVars();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = c.code;
      ctx.fillRect(0, 0, size.w, size.h);
      return;
    }
    draw(ctx, layout, view, size, dpr, selected, hover, scope === "neighbours" ? "none found in repo search" : "not part of this diff");
  }, [layout, view, size, selected, hover, themeTick, scope]);

  const hitTest = (clientX: number, clientY: number): string | null => {
    if (!layout || !canvas.current) return null;
    const r = canvas.current.getBoundingClientRect();
    const x = (clientX - r.left - view.x) / view.z;
    const y = (clientY - r.top - view.y) / view.z;
    for (let i = layout.boxes.length - 1; i >= 0; i--) {
      const b = layout.boxes[i];
      // Ghosts (unknown callers) aren't selectable.
      if (b.node && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.node.id;
    }
    return null;
  };

  // Native wheel listener so we can preventDefault (React's is passive).
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    // The wheel zooms around the pointer (drag pans). Pinch gestures arrive as
    // ctrl+wheel with small deltas, so they get a stronger factor.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      autoFit.current = false;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018));
      setView((v) => {
        const z = Math.min(2.5, Math.max(0.2, v.z * factor));
        return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
      });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, []);

  const sel = selected && graph ? graph.nodes.find((n) => n.id === selected) ?? null : null;
  const nodesById = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n]) ?? []), [graph]);
  const visible = layout?.boxes.filter((b) => b.node).length ?? 0;
  const changed = layout?.boxes.filter((b) => b.node && b.node.status !== "context").length ?? 0;
  const calls = layout?.edges.filter((e) => !e.ghost).length ?? 0;

  return (
    <div className="graphwrap">
      <div className="gcanvas" ref={wrap}>
      <canvas
        ref={canvas}
        className={drag.current?.moved ? "drag" : hover ? "hover" : ""}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, hit: hitTest(e.clientX, e.clientY) };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x, dy = e.clientY - d.y;
            if (d.moved || Math.abs(dx) + Math.abs(dy) > 4) {
              d.moved = true;
              autoFit.current = false;
              setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
            }
          } else {
            const h = hitTest(e.clientX, e.clientY);
            if (h !== hover) setHover(h);
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) setSelected(d.hit);
        }}
        onPointerLeave={() => !drag.current && setHover(null)}
        onDoubleClick={(e) => {
          const id = hitTest(e.clientX, e.clientY);
          const n = id ? nodesById.get(id) : null;
          if (n) onOpenDiff(n.file, n.line, n.status === "deleted" ? "old" : "new");
        }}
      />
      <div className="gtool">
        <div className="gtitle">
          <h2>{title}</h2>
          <span className="m">
            {graph
              ? `${visible} function${visible === 1 ? "" : "s"}, ${changed} changed · ${calls} call${calls === 1 ? "" : "s"}`
              : "Analysing…"}
            {graph && graph.skippedFiles.length > 0 && ` · ${graph.skippedFiles.length} file(s) in unsupported languages`}
          </span>
        </div>
        <div className="seg">
          <button className={scope === "changed" ? "on" : ""} onClick={() => onScope("changed")}>
            changed only
          </button>
          <button className={scope === "neighbours" ? "on" : ""} onClick={() => onScope("neighbours")}>
            + callers & callees
          </button>
        </div>
        <button className="iconbtn" style={{ background: "var(--pane)" }} onClick={fitView} aria-label="Fit to view" data-tip="Fit to view">
          <Fit />
        </button>
      </div>
      {graph && visible === 0 && (
        <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <div>
            <div className="big">No changed functions</div>
            This selection doesn't add or change any functions in a supported language.
          </div>
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: "var(--addnode)" }} />added</span>
        <span><i style={{ background: "var(--modbg)" }} />body changed</span>
        <span><i style={{ background: "var(--delnode)" }} />deleted</span>
        <span><i style={{ background: "var(--pane2)" }} />unchanged</span>
        <span><i style={{ height: 2, background: "var(--acc)" }} />new call</span>
        <span className="faint">scroll to zoom · drag to pan · double-click opens diff</span>
      </div>
      </div>
      {sel && <Splitter size="--gpanel-w" axis="x" sign={-1} label="Resize function panel" />}
      {sel && (
        <FunctionPanel
          key={sel.id}
          scope={scope}
          node={sel}
          graph={graph!}
          nodesById={nodesById}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
          onOpenDiff={onOpenDiff}
          onOpenEditor={onOpenEditor}
          onComment={onComment}
          comments={comments}
          onAddComment={onAddComment}
          onRemoveComment={onRemoveComment}
          onUpdateComment={onUpdateComment}
        />
      )}
    </div>
  );
}

const STATUS_TEXT: Record<GraphNode["status"], string> = {
  added: "new",
  modified: "body changed",
  deleted: "deleted",
  moved: "moved",
  context: "unchanged",
};

/** Side panel for the selected function: relations + the shared code/diff editor. */
function FunctionPanel({
  scope,
  node,
  graph,
  nodesById,
  onSelect,
  onClose,
  onOpenDiff,
  onOpenEditor,
  onComment,
  comments,
  onAddComment,
  onRemoveComment,
  onUpdateComment,
}: {
  scope: GraphScope;
  node: GraphNode;
  graph: CallGraph;
  nodesById: Map<string, GraphNode>;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpenDiff: Props["onOpenDiff"];
  onOpenEditor: Props["onOpenEditor"];
  onComment: Props["onComment"];
  comments: ReviewComment[];
  onAddComment: Props["onAddComment"];
  onRemoveComment: Props["onRemoveComment"];
  onUpdateComment: Props["onUpdateComment"];
}) {
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState("");
  const callers = graph.edges.filter((e) => e.to === node.id).map((e) => ({ e, n: nodesById.get(e.from) })).filter((x) => x.n);
  const callees = graph.edges.filter((e) => e.from === node.id).map((e) => ({ e, n: nodesById.get(e.to) })).filter((x) => x.n);
  const fileComments = useMemo(() => comments.filter((c) => c.file === node.file), [comments, node.file]);
  const unchanged = node.body.length > 0 && node.body.every((l) => l.kind === "ctx");
  const submit = () => {
    if (!body.trim()) return;
    onComment(node, body.trim());
    setWriting(false);
    setBody("");
  };

  return (
    <aside className="gpanel" aria-label={`Function ${label(node)}`}>
      <div className="gpanel-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>
            {label(node)} <span className={`badge ${node.status === "added" ? "added" : node.status === "deleted" ? "deleted" : node.status === "context" ? "" : "renamed"}`}>{STATUS_TEXT[node.status]}</span>
          </h3>
          <p className="m" style={{ margin: "4px 0 0" }}>
            {node.file}:{node.line}–{node.endLine}
            {node.movedFrom ? ` · moved from ${node.movedFrom}` : ""}
            {node.status !== "context" && (
              <>
                {" · "}
                <span className="add-c">+{node.additions}</span> <span className="del-c">−{node.deletions}</span>
              </>
            )}
          </p>
        </div>
        <button className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => onOpenDiff(node.file, node.line, node.status === "deleted" ? "old" : "new")} aria-label="Open in diff" data-tip="Open in diff">
          <DiffIcon size={14} />
        </button>
        {node.status !== "deleted" && (
          <button className="iconbtn" style={{ width: 28, height: 28 }} onClick={() => onOpenEditor(node.file, node.line)} aria-label="Open in editor" data-tip="Open in editor">
            <Code size={14} />
          </button>
        )}
        <button className="iconbtn" style={{ width: 28, height: 28 }} onClick={onClose} aria-label="Close panel" data-tip="Close">
          <Close />
        </button>
      </div>

      {(callers.length > 0 || callees.length > 0 || wantsGhost(node)) && (
        <div className="gpanel-rel">
          {callers.length === 0 && wantsGhost(node) && (
            <div>
              <span className="muted">Called by</span>
              <span className="chip ghost">
                ? unknown · {scope === "neighbours" ? "none found in repo search" : "not part of this diff"}
              </span>
            </div>
          )}
          {callers.length > 0 && (
            <div>
              <span className="muted">Called by</span>
              {callers.map(({ n, e }) => (
                <button key={n!.id} className={`chip${e.isNew ? " new" : ""}`} onClick={() => onSelect(n!.id)} title={e.isNew ? "new call" : undefined}>
                  {label(n!)}
                </button>
              ))}
            </div>
          )}
          {callees.length > 0 && (
            <div>
              <span className="muted">Calls</span>
              {callees.map(({ n, e }) => (
                <button key={n!.id} className={`chip${e.isNew ? " new" : ""}`} onClick={() => onSelect(n!.id)} title={e.isNew ? "new call" : undefined}>
                  {label(n!)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="gpanel-code">
        {unchanged && <div className="gpanel-note">No changes in this function — current code:</div>}
        {node.body.length > 0 ? (
          <CodeLines
            path={node.file}
            rows={node.body}
            comments={fileComments}
            onAddComment={onAddComment}
            onRemoveComment={onRemoveComment}
            onUpdateComment={onUpdateComment}
          />
        ) : (
          <div className="gpanel-note">Source not available for this revision.</div>
        )}
      </div>

      <div className="gpanel-foot">
        {writing ? (
          <div className="ccard note editing" style={{ maxWidth: "none" }}>
            <textarea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`Feedback on ${node.name} as a whole… (or click a line number above)`}
              onKeyDown={(e) => submitOnEnter(e, submit, () => setWriting(false))}
            />
            <div className="row">
              <span className="m">⏎ add · ⇧⏎ new line · esc cancel</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => setWriting(false)}>Cancel</button>
              <button className="btn sm pri" disabled={!body.trim()} onClick={submit}>Add to review</button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="m grow">click a line number to comment on a line</span>
            <button className="btn sm pri" onClick={() => setWriting(true)}>
              <Comment size={13} /> Comment on function
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
