import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { History, HistoryMode } from "../types";
import { toggleLeftPane } from "./Splitter";
import { SidebarIcon } from "./Icons";
import { relativeTime } from "../util";

export const WORKING = "working";

interface Props {
  history: History | null;
  mode: HistoryMode;
  onMode: (m: HistoryMode) => void;
  /** Selected keys (WORKING or commit shas), in list order. */
  selected: string[];
  onPick: (key: string, extend: boolean) => void;
  /** The commit moved with the keyboard (null in "all" mode). */
  cursor: string | null;
  /** ↑/↓ in the list: step to the next / previous commit (shift extends the range). */
  onStep: (delta: number, extend: boolean) => void;
  /** Commits whose changes are hidden from the diff. */
  excluded: Set<string>;
  onExclude: (key: string) => void;
  /** Merged-in commits are hidden from the diff. */
  hideForeign: boolean;
  follow: boolean;
  onFollow: (f: boolean) => void;
}

export function historyKeys(h: History | null): string[] {
  if (!h) return [];
  return [...(h.working ? [WORKING] : []), ...h.commits.map((c) => c.sha)];
}

export function HistoryPane({ history, mode, onMode, selected, onPick, cursor, onStep, excluded, onExclude, hideForeign, follow, onFollow }: Props) {
  const keys = historyKeys(history);
  const sel = new Set(selected);
  const list = useRef<HTMLDivElement>(null);
  // Keep the keyboard cursor in view (and focused when the list has focus).
  useEffect(() => {
    const root = list.current;
    if (!root || !cursor) return;
    const el = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(cursor)}"]`);
    if (!el) return;
    if (root.contains(document.activeElement)) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  /** Several commits are shown at once: each can be hidden from the diff. */
  const multi = selected.length > 1;
  const toggle = (key: string, label: string, merged = false) => {
    if (!multi || !sel.has(key)) return null;
    const off = excluded.has(key) || (hideForeign && merged);
    return (
      <span
        className={`xcl${off ? " off" : ""}`}
        role="checkbox"
        aria-checked={!off}
        aria-label={`${off ? "Show" : "Hide"} the changes of ${label}`}
        title={
          off && !excluded.has(key)
            ? "Hidden by “Hide merged-in”"
            : off
              ? "Changes hidden from the diff · click to show (⌘-click the row)"
              : "Hide these changes from the diff (⌘-click the row)"
        }
        onClick={(e) => {
          e.stopPropagation();
          if (!off || excluded.has(key)) onExclude(key);
        }}
      />
    );
  };
  const click = (key: string, e: ReactMouseEvent) => {
    if ((e.metaKey || e.ctrlKey) && multi && sel.has(key)) onExclude(key);
    else onPick(key, e.shiftKey);
  };
  const total = keys.length + (history?.base ? 1 : 0);
  let idx = 0;
  const pos = () => {
    const i = idx++;
    return `${i === 0 ? " first" : ""}${i === total - 1 ? " last" : ""}`;
  };

  return (
    <aside className="pane fl history" aria-label="Commit history">
      <button className="iconbtn left-expand" onClick={() => toggleLeftPane(false)} aria-label="Show history" data-tip="Show history (⌘B)" data-tip-left>
        <SidebarIcon />
      </button>
      <div className="panehead">
        <button className="iconbtn left-collapse" onClick={() => toggleLeftPane(true)} aria-label="Hide history" data-tip="Hide history (⌘B)" data-tip-left>
          <SidebarIcon />
        </button>
        <h2 className="h2">History</h2>
        <div className="seg" role="radiogroup" aria-label="Selection mode">
          {(["single", "range", "all"] as HistoryMode[]).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => onMode(m)} role="radio" aria-checked={mode === m}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <div
        className="commits"
        ref={list}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          onStep(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
        }}
      >
        {history?.working && (
          <button
            className={`cm${sel.has(WORKING) ? (mode === "range" && selected.length > 1 ? " inrange" : " on") : ""}${multi && excluded.has(WORKING) ? " excl" : ""}${pos()}`}
            data-key={WORKING}
            onClick={(e) => click(WORKING, e)}
          >
            <span className="rail" />
            <span className="dot live" />
            <span className="body">
              <span className="t">Uncommitted changes</span>
              <span className="m">
                {history.working.files} file{history.working.files === 1 ? "" : "s"} ·{" "}
                <span className="add-c">+{history.working.additions}</span>{" "}
                <span className="del-c">−{history.working.deletions}</span>
              </span>
            </span>
            {toggle(WORKING, "the uncommitted changes")}
          </button>
        )}
        {history?.commits.map((c) => {
          const on = sel.has(c.sha);
          const cls = on ? (mode === "range" && selected.length > 1 ? " inrange" : " on") : "";
          const merged = c.foreign || c.parents.length > 1;
          const off = multi && on && (excluded.has(c.sha) || (hideForeign && merged));
          return (
            <button
              key={c.sha}
              data-key={c.sha}
              className={`cm${cls}${c.foreign ? " foreign" : ""}${off ? " excl" : ""}${pos()}`}
              onClick={(e) => click(c.sha, e)}
              title={`${c.subject}\n${c.author} · ${c.short}${c.foreign ? "\nMerged in from another branch" : ""}`}
            >
              <span className="rail" />
              <span className={`dot${c.parents.length > 1 ? " merge" : ""}`} />
              <span className="body">
                <span className="t">
                  <span className="subj">{c.subject}</span>
                  {c.foreign && <span className="mtag">merged in</span>}
                </span>
                <span className="m">
                  {c.short} · {relativeTime(c.time)} · <span className="add-c">+{c.additions}</span>{" "}
                  <span className="del-c">−{c.deletions}</span>
                </span>
              </span>
              {toggle(c.sha, c.short, merged)}
            </button>
          );
        })}
        {history?.base && (
          <div className={`cm base${pos()}`}>
            <span className="rail" />
            <span className="dot" />
            <span className="body">
              <span className="t">Branched from {history.defaultBranch}</span>
              <span className="m">
                {history.base.short} · {relativeTime(history.base.time)}
              </span>
            </span>
          </div>
        )}
        {history && keys.length === 0 && <div className="empty">No changes on this branch yet.</div>}
      </div>
      <div className="follow">
        <span id="follow-lbl">Follow agent</span>
        <button
          className={`sw${follow ? " on" : ""}`}
          role="switch"
          aria-checked={follow}
          aria-labelledby="follow-lbl"
          onClick={() => onFollow(!follow)}
        >
          <span />
        </button>
      </div>
      <span className="m" style={{ padding: "4px 18px 0" }}>
        {mode === "range" ? "click two commits · " : ""}
        {multi ? "⌘-click hides a commit · " : ""}↑↓ / j k to step
      </span>
    </aside>
  );
}
