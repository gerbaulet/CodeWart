import { useRef } from "react";

/**
 * Pane sizes live in CSS variables on <html>, so dragging a splitter only
 * touches style (no React re-render of the — possibly many — workspaces).
 */
export const PANE_SIZES = {
  "--left-w": { def: 264, min: 180, max: 520 },
  "--right-w": { def: 300, min: 220, max: 640 },
  "--files-h": { def: 300, min: 90, max: 900 },
  "--gpanel-w": { def: 560, min: 340, max: 1100 },
} as const;
export type PaneVar = keyof typeof PANE_SIZES;

const STORE = "codewart.panes";

function loadSizes(): Partial<Record<PaneVar, number>> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
}

function saveSize(v: PaneVar, px: number) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...loadSizes(), [v]: px }));
  } catch {
    /* storage unavailable */
  }
}

function setVar(v: PaneVar, px: number) {
  document.documentElement.style.setProperty(v, `${Math.round(px)}px`);
}

/** Apply saved (or default) pane sizes. Call once at startup. */
export function initPaneSizes() {
  const saved = loadSizes();
  for (const [v, cfg] of Object.entries(PANE_SIZES) as [PaneVar, (typeof PANE_SIZES)[PaneVar]][]) {
    const px = saved[v];
    setVar(v, typeof px === "number" ? Math.min(cfg.max, Math.max(cfg.min, px)) : cfg.def);
  }
}

function current(v: PaneVar): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || PANE_SIZES[v].def;
}

interface Props {
  /** Which CSS variable this handle drives. */
  size: PaneVar;
  /** "x" = vertical bar resizing widths, "y" = horizontal bar resizing heights. */
  axis: "x" | "y";
  /** +1 if dragging right/down grows the pane, -1 if it shrinks it. */
  sign: 1 | -1;
  label: string;
}

/**
 * Dragging only moves a guide line (a transform: no layout). The pane size is
 * applied once on release — resizing live would re-lay out the whole diff and
 * resize the call-graph canvas on every pointer event.
 */
export function Splitter({ size, axis, sign, label }: Props) {
  const drag = useRef<{ start: number; from: number; next: number; ghost: HTMLDivElement; onKey: (e: KeyboardEvent) => void } | null>(null);
  const cfg = PANE_SIZES[size];
  const finish = (apply: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.ghost.remove();
    window.removeEventListener("keydown", d.onKey, true);
    document.body.classList.remove("resizing-x", "resizing-y");
    if (apply && d.next !== d.from) {
      setVar(size, d.next);
      saveSize(size, d.next);
    }
  };
  return (
    <div
      className={`splitter ${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        e.preventDefault();
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone; the drag still works while over the handle */
        }
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const ghost = document.createElement("div");
        ghost.className = `split-ghost ${axis}`;
        // The guide spans the splitter's track; its centre starts on the handle.
        const base = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
        if (axis === "x") Object.assign(ghost.style, { left: `${base}px`, top: `${r.top}px`, height: `${r.height}px` });
        else Object.assign(ghost.style, { top: `${base}px`, left: `${r.left}px`, width: `${r.width}px` });
        document.body.appendChild(ghost);
        const from = current(size);
        ghost.dataset.size = `${Math.round(from)}px`;
        // Escape cancels the drag.
        const onKey = (ev: KeyboardEvent) => {
          if (ev.key === "Escape") {
            ev.preventDefault();
            ev.stopPropagation();
            finish(false);
          }
        };
        window.addEventListener("keydown", onKey, true);
        drag.current = { start: axis === "x" ? e.clientX : e.clientY, from, next: from, ghost, onKey };
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = (axis === "x" ? e.clientX : e.clientY) - d.start;
        d.next = Math.round(Math.min(cfg.max, Math.max(cfg.min, d.from + sign * delta)));
        // Where the edge will land, honouring min/max.
        const offset = sign * (d.next - d.from);
        d.ghost.style.transform = axis === "x" ? `translateX(${offset}px)` : `translateY(${offset}px)`;
        d.ghost.dataset.size = `${d.next}px`;
      }}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onDoubleClick={() => {
        setVar(size, cfg.def);
        saveSize(size, cfg.def);
      }}
    />
  );
}
