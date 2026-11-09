import type { DiffLine, Hunk } from "./types";
import type { Row } from "./components/CodeLines";

/** Lines revealed per click, like GitHub. */
export const EXPAND_STEP = 20;

/** Unchanged lines between hunks (new-side numbers), which can be unfolded. */
export interface Gap {
  /** First new-side line of the gap. */
  from: number;
  /** Last new-side line, or null = up to the end of the file (unknown until loaded). */
  to: number | null;
  /** old line = new line + offset (unchanged lines are identical on both sides). */
  offset: number;
}

/** How much of each gap is shown: `down` lines after the previous hunk, `up` before the next. */
export interface Unfold {
  down: number;
  up: number;
}

// A hunk with 0 lines on a side gives the line *before* the change as start.
const first = (start: number, count: number) => (count === 0 ? start + 1 : start);

/** Gap i lies before hunk i; gap hunks.length is the tail after the last hunk. */
export function gapsOf(hunks: Hunk[]): Gap[] {
  const gaps: Gap[] = [];
  let newNext = 1;
  let oldNext = 1;
  for (const h of hunks) {
    const nf = first(h.newStart, h.newLines);
    const of = first(h.oldStart, h.oldLines);
    gaps.push({ from: newNext, to: nf - 1, offset: of - nf });
    newNext = nf + h.newLines;
    oldNext = of + h.oldLines;
  }
  gaps.push({ from: newNext, to: null, offset: oldNext - newNext });
  return gaps;
}

export function gapSize(g: Gap, lineCount: number | null): number | null {
  const to = g.to ?? lineCount;
  return to == null ? null : Math.max(0, to - g.from + 1);
}

/**
 * Diff rows with unfolded context. Hunk headers carry the expand controls of
 * the gap above them; a fully unfolded gap merges its neighbours (no header).
 */
export function rowsWithContext(hunks: Hunk[], unfold: Map<number, Unfold>, lines: string[] | null): Row[] {
  const gaps = gapsOf(hunks);
  const rows: Row[] = [];
  const ctx = (g: Gap, n: number): DiffLine => ({ kind: "ctx", old: n + g.offset, new: n, text: lines?.[n - 1] ?? "" });
  const total = lines?.length ?? null;
  gaps.forEach((g, i) => {
    const size = gapSize(g, total);
    const u = unfold.get(i) ?? { down: 0, up: 0 };
    const down = size == null ? u.down : Math.min(u.down, size);
    const up = size == null ? 0 : Math.min(u.up, size - down);
    const hidden = size == null ? null : size - down - up;
    for (let n = g.from; n < g.from + down; n++) rows.push(ctx(g, n));
    const tail = i === hunks.length;
    // A header separates hunks while lines are hidden between them; the first
    // hunk keeps its header even when it starts at line 1.
    if (hidden !== 0 || (i === 0 && !tail)) {
      rows.push({
        kind: "hunk",
        text: tail ? "" : hunks[i].header,
        expand:
          hidden === 0
            ? undefined
            : {
                gap: i,
                hidden,
                // Nothing above the top of the file to expand down from; nothing below the tail.
                canDown: i > 0,
                canUp: !tail,
              },
      });
    }
    if (size != null) for (let n = g.from + size - up; n <= g.from + size - 1; n++) rows.push(ctx(g, n));
    if (!tail) rows.push(...hunks[i].lines);
  });
  return rows;
}

/** Apply one click: reveal EXPAND_STEP lines (or everything) in a gap. */
export function unfoldGap(prev: Unfold | undefined, dir: "up" | "down" | "all", size: number | null): Unfold {
  const u = prev ?? { down: 0, up: 0 };
  if (dir === "all") return size == null ? u : { down: size, up: 0 };
  return dir === "down" ? { ...u, down: u.down + EXPAND_STEP } : { ...u, up: u.up + EXPAND_STEP };
}
