import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { highlightLine } from "../highlight";
import type { CommitBadge, DiffLine, ReviewComment } from "../types";
import { languageOf, newId } from "../util";

/** Expand controls on a hunk header: unchanged lines hidden above it. */
export interface ExpandInfo {
  gap: number;
  /** Hidden lines, or null when unknown (end of file before it's loaded). */
  hidden: number | null;
  /** Reveal lines downward, right after the previous hunk. */
  canDown: boolean;
  /** Reveal lines upward, right before the next hunk. */
  canUp: boolean;
}

/** A diff line, or a hunk header separating non-contiguous parts. */
export type Row = DiffLine | { kind: "hunk"; text: string; expand?: ExpandInfo };

interface Draft {
  side: "new" | "old";
  line: number;
  endLine: number;
  code: string;
  /** Row indices covered (may span removed and added lines). */
  rowFrom: number;
  rowTo: number;
}

interface Props {
  path: string;
  rows: Row[];
  /** Review comments for this file. */
  comments: ReviewComment[];
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onUpdateComment: (id: string, body: string) => void;
  /** "side:line" to highlight after a jump. */
  flash?: string | null;
  sendLabel?: string;
  /** Unfold hidden unchanged lines (diff view); without it hunk headers are plain. */
  onExpand?: (gap: number, dir: "up" | "down" | "all") => void;
  /** Name the commit of each run of changed lines (multi-commit diffs). */
  commits?: Map<string, CommitBadge> | null;
  onCommit?: (sha: string, action: "only" | "hide" | "show") => void;
}

function sideOf(l: DiffLine): { side: "new" | "old"; n: number } {
  return l.kind === "del" ? { side: "old", n: l.old! } : { side: "new", n: l.new! };
}
const key = (side: "new" | "old", n: number) => `${side}:${n}`;

/**
 * The code/diff editor: highlighted lines with old/new numbers, +/− gutter,
 * click a line number to comment (shift-click for a range), inline comment
 * cards and the comment composer. Used by the diff view and the call chain.
 */
/** Enter submits, Shift+Enter inserts a newline, Escape cancels. */
export function submitOnEnter(e: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void, cancel: () => void) {
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    submit();
  }
}

export const CodeLines = memo(function CodeLines({ path, rows, comments, onAddComment, onRemoveComment, onUpdateComment, flash, sendLabel, onExpand, commits, onCommit }: Props) {
  const lang = languageOf(path);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Id of a saved comment being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Row where the last selection started (shift-click extends from here). */
  const [anchor, setAnchor] = useState<number | null>(null);
  /** Live drag-selection over line numbers. */
  const [dragSel, setDragSel] = useState<{ from: number; to: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number } | null>(null);

  const rowIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r.kind !== "hunk") {
        const { side, n } = sideOf(r);
        m.set(key(side, n), i);
      }
    });
    return m;
  }, [rows]);

  const commentsAt = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const k = key(c.side, c.endLine ?? c.line);
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [comments]);
  /** Rows covered by a saved comment: every row from its first to its last line. */
  const commentedRows = useMemo(() => {
    const s = new Set<number>();
    for (const c of comments) {
      const a = rowIndexOf.get(key(c.side, c.line));
      const b = rowIndexOf.get(key(c.side, c.endLine ?? c.line));
      if (a == null || b == null) continue;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(i);
    }
    return s;
  }, [comments, rowIndexOf]);

  /** Open the composer for rows i..j; line numbers come from the anchor's side. */
  const openRows = (i: number, j: number, anchorRow: number) => {
    const lo = Math.min(i, j), hi = Math.max(i, j);
    const picked = rows.slice(lo, hi + 1).filter((r): r is DiffLine => r.kind !== "hunk");
    const anchorLine = rows[anchorRow];
    if (!picked.length || anchorLine.kind === "hunk") return;
    const side = sideOf(anchorLine).side;
    const onSide = picked.filter((r) => sideOf(r).side === side);
    const numbered = onSide.length ? onSide : picked;
    const first = sideOf(numbered[0]), last = sideOf(numbered[numbered.length - 1]);
    // Single line that already has a comment: reopen it instead.
    if (lo === hi) {
      const existing = commentsAt.get(key(first.side, first.n))?.[0];
      if (existing) {
        setDraft(null);
        setEditing(existing.id);
        return;
      }
    }
    setEditing(null);
    setDraft({
      side: first.side,
      line: first.n,
      endLine: last.n,
      code: picked.map((r) => r.text).join("\n"),
      rowFrom: lo,
      rowTo: hi,
    });
  };

  const start = (rowIdx: number, extend: boolean) => {
    if (extend && anchor != null) {
      openRows(anchor, rowIdx, anchor);
    } else {
      setAnchor(rowIdx);
      openRows(rowIdx, rowIdx, rowIdx);
    }
  };

  // Clicking anywhere on a line comments on it. Wait a beat so a double-click
  // (word select) or a drag-selection to copy code doesn't open the composer.
  const clickTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  const onLineClick = (rowIdx: number, e: ReactMouseEvent) => {
    window.clearTimeout(clickTimer.current);
    if (e.detail > 1 || dragRef.current) return;
    const extend = e.shiftKey;
    clickTimer.current = window.setTimeout(() => {
      if (window.getSelection()?.toString()) return;
      start(rowIdx, extend);
    }, 220);
  };

  // Drag over line numbers to select several lines.
  const onGutterDown = (rowIdx: number, e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    window.clearTimeout(clickTimer.current);
    window.getSelection()?.removeAllRanges();
    if (e.shiftKey && anchor != null) {
      openRows(anchor, rowIdx, anchor);
      return;
    }
    const sel = { from: rowIdx, to: rowIdx };
    dragRef.current = sel;
    setDragSel(sel);
    const up = () => {
      window.removeEventListener("mouseup", up);
      const d = dragRef.current;
      dragRef.current = null;
      setDragSel(null);
      if (!d) return;
      setAnchor(d.from);
      openRows(d.from, d.to, d.from);
    };
    window.addEventListener("mouseup", up);
  };
  const onRowEnter = (rowIdx: number) => {
    const d = dragRef.current;
    if (!d || d.to === rowIdx) return;
    const next = { from: d.from, to: rowIdx };
    dragRef.current = next;
    setDragSel(next);
  };
  const selLo = dragSel ? Math.min(dragSel.from, dragSel.to) : draft ? draft.rowFrom : -1;
  const selHi = dragSel ? Math.max(dragSel.from, dragSel.to) : draft ? draft.rowTo : -2;

  let runCommit: string | undefined;
  return (
    <div className="lines">
      {rows.map((r, i) => {
        if (r.kind === "hunk") runCommit = undefined;
        if (r.kind === "hunk") {
          const x = onExpand ? r.expand : undefined;
          if (x) return <ExpandRow key={i} text={r.text} x={x} onExpand={onExpand!} />;
          return (
            <div className="ln hunk" key={i}>
              <span className="n" />
              <span className="n" />
              <span className="s" />
              <code>{r.text}</code>
            </div>
          );
        }
        const { side, n } = sideOf(r);
        const k = key(side, n);
        const here = commentsAt.get(k);
        const drafting = !dragSel && draft && draft.rowTo === i;
        const inSel = i >= selLo && i <= selHi;
        const cls = `ln ${r.kind === "ctx" ? "" : r.kind}${commentedRows.has(i) ? " commented" : ""}${flash === k ? " target" : ""}${inSel ? " sel" : ""}`;
        const badge = r.commit ? commits?.get(r.commit) : undefined;
        const chip = badge && r.commit !== runCommit && onCommit ? <CommitChip b={badge} onCommit={onCommit} /> : null;
        if (badge) runCommit = r.commit;
        return (
          <Fragment key={i}>
            {chip}
            <div
              className={cls}
              data-l={k}
              data-tone={badge?.tone}
              onClick={(e) => onLineClick(i, e)}
              onMouseEnter={() => onRowEnter(i)}
              title="Click to comment · drag line numbers or shift-click for several lines"
            >
              <span className="n" onMouseDown={(e) => onGutterDown(i, e)} onClick={(e) => e.stopPropagation()}>
                {r.old ?? ""}
              </span>
              <span className="n" onMouseDown={(e) => onGutterDown(i, e)} onClick={(e) => e.stopPropagation()}>
                {r.new ?? ""}
              </span>
              <span className="s">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              <code dangerouslySetInnerHTML={{ __html: highlightLine(r.text, lang) || " " }} />
            </div>
            {here?.map((c) =>
              editing === c.id ? (
                <Composer
                  key={c.id}
                  side={c.side}
                  draft={c}
                  initial={c.body}
                  editing
                  onCancel={() => setEditing(null)}
                  onRemove={() => {
                    onRemoveComment(c.id);
                    setEditing(null);
                  }}
                  onSave={(body) => {
                    onUpdateComment(c.id, body);
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="inline" key={c.id}>
                  <div
                    className={`ccard note arrow-${c.side}`}
                    role="button"
                    tabIndex={0}
                    title="Click to edit"
                    onClick={() => {
                      setDraft(null);
                      setEditing(c.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditing(c.id);
                      }
                    }}
                  >
                    <div className="who">
                      <b>You</b>
                      <span className="m">
                        {c.endLine && c.endLine !== c.line ? `lines ${c.line}–${c.endLine}` : `line ${c.line}`} · in batch · click to edit
                      </span>
                      <span className="grow" />
                      <button
                        className="linkbtn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveComment(c.id);
                        }}
                      >
                        remove
                      </button>
                    </div>
                    <p>{c.body}</p>
                  </div>
                </div>
              ),
            )}
            {drafting && (
              <Composer
                side={draft!.side}
                draft={draft!}
                sendLabel={sendLabel}
                onCancel={() => setDraft(null)}
                onSave={(body) => {
                  const { side: dSide, line, endLine, code } = draft!;
                  onAddComment({ id: newId(), file: path, side: dSide, line, endLine, code, body });
                  setDraft(null);
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
});

/** Names the commit a run of changed lines came from, with quick filters. */
function CommitChip({ b, onCommit }: { b: CommitBadge; onCommit: NonNullable<Props["onCommit"]> }) {
  return (
    <div className="ln cchip" data-tone={b.tone}>
      <span className="cchip-in">
        <span className="cdot" />
        <b>{b.short}</b>
        {b.subject && <span className="subj">{b.subject}</span>}
        {b.foreign && <span className="mtag">merged in</span>}
        <span className="acts">
          <button className="linkbtn" onClick={() => onCommit(b.sha, "only")} title="Show only this commit's changes">
            only this
          </button>
          <button className="linkbtn" onClick={() => onCommit(b.sha, "hide")} title="Hide this commit's changes (toggle it in the history to bring them back)">
            hide
          </button>
        </span>
      </span>
    </div>
  );
}

/** A hunk header with GitHub-style buttons to unfold the unchanged lines above it. */
function ExpandRow({ text, x, onExpand }: { text: string; x: ExpandInfo; onExpand: NonNullable<Props["onExpand"]> }) {
  const STEP = 20;
  const small = x.hidden != null && x.hidden <= STEP;
  const btn = (dir: "up" | "down" | "all", label: string, glyph: string) => (
    <button className="xbtn" onClick={() => onExpand(x.gap, dir)} title={label} aria-label={label}>
      {glyph}
    </button>
  );
  const lines = x.hidden == null ? "" : ` ${x.hidden} line${x.hidden === 1 ? "" : "s"}`;
  return (
    <div className="ln hunk expand">
      <span className="xbtns">
        {small
          ? btn("all", `Show${lines}`, "↕")
          : (
            <>
              {x.canDown && btn("down", `Show ${STEP} more lines below the previous change`, "↓")}
              {x.canUp && btn("up", `Show ${STEP} more lines above this change`, "↑")}
            </>
          )}
      </span>
      <code>
        {text}
        {x.hidden != null && <span className="xhid">{text ? " · " : ""}{x.hidden} unchanged line{x.hidden === 1 ? "" : "s"} hidden</span>}
      </code>
    </div>
  );
}

/**
 * Comments on a file as a whole, shown under its header in the diff, plus the
 * composer opened from the header's comment button.
 */
export function FileComments({
  path,
  side,
  comments,
  composing,
  onCloseComposer,
  onAddComment,
  onRemoveComment,
  onUpdateComment,
  sendLabel,
}: {
  path: string;
  side: "new" | "old";
  comments: ReviewComment[];
  composing: boolean;
  onCloseComposer: () => void;
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onUpdateComment: (id: string, body: string) => void;
  sendLabel?: string;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (!comments.length && !composing) return null;
  return (
    <div className="filecomments">
      {comments.map((c) =>
        editing === c.id ? (
          <Composer
            key={c.id}
            side={c.side}
            draft={c}
            label="whole file"
            initial={c.body}
            editing
            sendLabel={sendLabel}
            onCancel={() => setEditing(null)}
            onRemove={() => {
              onRemoveComment(c.id);
              setEditing(null);
            }}
            onSave={(body) => {
              onUpdateComment(c.id, body);
              setEditing(null);
            }}
          />
        ) : (
          <div className="inline" key={c.id}>
            <div
              className="ccard note no-arrow"
              role="button"
              tabIndex={0}
              title="Click to edit"
              onClick={() => setEditing(c.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setEditing(c.id);
                }
              }}
            >
              <div className="who">
                <b>You</b>
                <span className="m">whole file · in batch · click to edit</span>
                <span className="grow" />
                <button
                  className="linkbtn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveComment(c.id);
                  }}
                >
                  remove
                </button>
              </div>
              <p>{c.body}</p>
            </div>
          </div>
        ),
      )}
      {composing && (
        <Composer
          side={side}
          draft={{ line: 0 }}
          label="whole file"
          sendLabel={sendLabel}
          onCancel={onCloseComposer}
          onSave={(body) => {
            onAddComment({ id: newId(), file: path, side, line: 0, code: "", body });
            onCloseComposer();
          }}
        />
      )}
    </div>
  );
}

function Composer({
  side,
  draft,
  label,
  initial = "",
  editing = false,
  onCancel,
  onSave,
  onRemove,
  sendLabel,
}: {
  side: "new" | "old";
  draft: { line: number; endLine?: number };
  /** Replaces the "line N" caption (e.g. "whole file"). */
  label?: string;
  initial?: string;
  editing?: boolean;
  onCancel: () => void;
  onSave: (b: string) => void;
  onRemove?: () => void;
  sendLabel?: string;
}) {
  const [body, setBody] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => body.trim() && onSave(body.trim());
  const end = draft.endLine ?? draft.line;
  return (
    <div className="inline">
      <div className={`ccard note editing ${label ? "no-arrow" : `arrow-${side}`}`}>
        <div className="who">
          <b>You</b>
          <span className="m">
            {label ?? (end !== draft.line ? `lines ${draft.line}–${end}` : `line ${draft.line}`)} · {editing ? "editing" : "draft"}
          </span>
        </div>
        <textarea
          ref={ref}
          value={body}
          rows={Math.min(8, Math.max(2, body.split("\n").length))}
          onChange={(e) => setBody(e.target.value)}
          placeholder={label ? "Feedback on this file as a whole… Markdown works." : "What should the agent change here? Markdown works."}
          onKeyDown={(e) => submitOnEnter(e, save, onCancel)}
        />
        <div className="row">
          <span className="m">⏎ {editing ? "save" : "add"} · ⇧⏎ new line · esc cancel{sendLabel ? ` · ${sendLabel}` : ""}</span>
          <span className="grow" />
          {onRemove && (
            <button className="btn sm danger" onClick={onRemove}>
              Delete
            </button>
          )}
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn sm pri" onClick={save} disabled={!body.trim()}>
            {editing ? "Save" : "Add to review"}
          </button>
        </div>
      </div>
    </div>
  );
}
