import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { FileDiff, ReviewComment } from "../types";
import { TAG_LABEL, isFileComment, splitPath } from "../util";
import { CodeLines, FileComments, type Row } from "./CodeLines";
import { ChevronDown, ChevronRight, Code, Comment } from "./Icons";

export interface ScrollTarget {
  path: string;
  line?: number;
  side?: "new" | "old";
  nonce: number;
}

interface Props {
  files: FileDiff[];
  comments: ReviewComment[];
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onUpdateComment: (id: string, body: string) => void;
  target: ScrollTarget | null;
  onActiveFile: (path: string) => void;
  onOpenInEditor: (path: string, line?: number) => void;
  sendLabel: string;
  /** Receives the scroll container (for back navigation). */
  scrollRef?: MutableRefObject<HTMLDivElement | null>;
}

const NO_COMMENTS: ReviewComment[] = [];

export function DiffView({ files, comments, onAddComment, onRemoveComment, onUpdateComment, target, onActiveFile, onOpenInEditor, sendLabel, scrollRef }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<string | null>(null);

  // Scroll to a requested file / line.
  useEffect(() => {
    if (!target || !scroller.current) return;
    setCollapsed((c) => {
      if (!c.has(target.path)) return c;
      const n = new Set(c);
      n.delete(target.path);
      return n;
    });
    requestAnimationFrame(() => {
      const root = scroller.current;
      if (!root) return;
      const fileEl = root.querySelector<HTMLElement>(`[data-file="${CSS.escape(target.path)}"]`);
      if (!fileEl) return;
      let el: HTMLElement | null = fileEl;
      if (target.line != null) {
        const side = target.side ?? "new";
        el =
          fileEl.querySelector<HTMLElement>(`[data-l="${side}:${target.line}"]`) ??
          // Nearest following line if the exact one is outside the hunks.
          Array.from(fileEl.querySelectorAll<HTMLElement>(`[data-l^="${side}:"]`)).find(
            (e) => Number(e.dataset.l!.split(":")[1]) >= target.line!,
          ) ??
          fileEl;
        setFlash(`${target.path}|${side}:${target.line}`);
      }
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      root.scrollTo({ top: Math.max(0, top - (el === fileEl ? 0 : 120)), behavior: "smooth" });
    });
  }, [target]);

  // Track which file is at the top of the viewport.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top + 60;
        let current: string | null = null;
        for (const el of root.querySelectorAll<HTMLElement>("[data-file]")) {
          if (el.getBoundingClientRect().top <= top) current = el.dataset.file!;
          else break;
        }
        if (current) onActiveFile(current);
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [onActiveFile]);

  const byFile = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const l = m.get(c.file) ?? [];
      l.push(c);
      m.set(c.file, l);
    }
    return m;
  }, [comments]);

  if (files.length === 0) {
    return (
      <div className="empty">
        <div className="big">Nothing to review</div>
        No changes in this selection, or every changed file is hidden by the active filters.
      </div>
    );
  }

  return (
    <div
      className="diffscroll"
      ref={(el) => {
        scroller.current = el;
        if (scrollRef) scrollRef.current = el;
      }}
    >
      {files.map((f) => (
        <FileBlock
          key={f.path}
          file={f}
          collapsed={collapsed.has(f.path)}
          onToggle={() =>
            setCollapsed((c) => {
              const n = new Set(c);
              n.has(f.path) ? n.delete(f.path) : n.add(f.path);
              return n;
            })
          }
          comments={byFile.get(f.path) ?? NO_COMMENTS}
          flash={flash?.startsWith(f.path + "|") ? flash.slice(f.path.length + 1) : null}
          onAddComment={onAddComment}
          onRemoveComment={onRemoveComment}
          onUpdateComment={onUpdateComment}
          onOpenInEditor={onOpenInEditor}
          sendLabel={sendLabel}
        />
      ))}
    </div>
  );
}

interface BlockProps {
  file: FileDiff;
  collapsed: boolean;
  onToggle: () => void;
  comments: ReviewComment[];
  flash: string | null;
  onAddComment: (c: ReviewComment) => void;
  onRemoveComment: (id: string) => void;
  onUpdateComment: (id: string, body: string) => void;
  onOpenInEditor: (path: string, line?: number) => void;
  sendLabel: string;
}

const FileBlock = memo(function FileBlock({
  file,
  collapsed,
  onToggle,
  comments,
  flash,
  onAddComment,
  onRemoveComment,
  onUpdateComment,
  onOpenInEditor,
  sendLabel,
}: BlockProps) {
  const { dir, name } = splitPath(file.path);
  const rows = useMemo<Row[]>(
    () => file.hunks.flatMap((h) => [{ kind: "hunk" as const, text: h.header }, ...h.lines]),
    [file.hunks],
  );
  const firstChange = file.hunks.flatMap((h) => h.lines).find((l) => l.kind !== "ctx");
  const [composing, setComposing] = useState(false);
  const [fileComments, lineComments] = useMemo(
    () => [comments.filter(isFileComment), comments.filter((c) => !isFileComment(c))],
    [comments],
  );

  return (
    <section className="dfile" data-file={file.path}>
      <div className="dfile-head">
        <button className="chev" onClick={onToggle} aria-label={collapsed ? "Expand file" : "Collapse file"}>
          {collapsed ? <ChevronRight /> : <ChevronDown />}
        </button>
        <h3 title={file.path}>
          {file.oldPath && file.oldPath !== file.path && <span className="dir">{file.oldPath} → </span>}
          <span className="dir">{dir}</span>
          {name}
        </h3>
        <button
          className={`iconbtn filecomment${fileComments.length ? " has" : ""}`}
          style={{ width: 26, height: 26 }}
          aria-label="Comment on this file"
          data-tip={fileComments.length ? `Comment on file (${fileComments.length} in batch)` : "Comment on file"}
          data-tip-left
          onClick={() => setComposing(true)}
        >
          <Comment size={14} />
        </button>
        <span className="m" style={{ flex: "none" }}>
          {file.additions > 0 && <span className="add-c">+{file.additions}</span>} {file.deletions > 0 && <span className="del-c">−{file.deletions}</span>}
        </span>
        {file.status !== "modified" && <span className={`badge ${file.status}`}>{file.status}</span>}
        {file.tags.map((t) => (
          <span key={t} className="badge">
            {TAG_LABEL[t]}
          </span>
        ))}
        <span className="grow" />
        {file.status !== "deleted" && (
          <button
            className="iconbtn"
            style={{ width: 28, height: 28 }}
            aria-label="Open file in editor"
            data-tip="Open in editor"
            onClick={() => onOpenInEditor(file.path, firstChange?.new ?? undefined)}
          >
            <Code size={14} />
          </button>
        )}
      </div>
      <FileComments
        path={file.path}
        side={file.status === "deleted" ? "old" : "new"}
        comments={fileComments}
        composing={composing}
        onCloseComposer={() => setComposing(false)}
        onAddComment={onAddComment}
        onRemoveComment={onRemoveComment}
        onUpdateComment={onUpdateComment}
        sendLabel={sendLabel}
      />
      {!collapsed && (
        <>
          {file.binary && <div className="dnote">Binary file not shown.</div>}
          {!file.binary && file.hunks.length === 0 && (
            <div className="dnote">
              {file.status === "renamed" ? "Renamed without content changes." : file.truncated ? "File too large to display." : "No content changes."}
            </div>
          )}
          {rows.length > 0 && (
            <CodeLines
              path={file.path}
              rows={rows}
              comments={lineComments}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
              onUpdateComment={onUpdateComment}
              flash={flash}
              sendLabel={sendLabel}
            />
          )}
          {file.truncated && file.hunks.length > 0 && <div className="dnote">Diff truncated — open the file to see the rest.</div>}
        </>
      )}
    </section>
  );
});
