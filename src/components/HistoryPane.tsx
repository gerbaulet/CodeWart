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
  follow: boolean;
  onFollow: (f: boolean) => void;
}

export function historyKeys(h: History | null): string[] {
  if (!h) return [];
  return [...(h.working ? [WORKING] : []), ...h.commits.map((c) => c.sha)];
}

export function HistoryPane({ history, mode, onMode, selected, onPick, follow, onFollow }: Props) {
  const keys = historyKeys(history);
  const sel = new Set(selected);
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
      <div className="commits">
        {history?.working && (
          <button
            className={`cm${sel.has(WORKING) ? (mode === "range" && selected.length > 1 ? " inrange" : " on") : ""}${pos()}`}
            onClick={(e) => onPick(WORKING, e.shiftKey)}
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
          </button>
        )}
        {history?.commits.map((c) => {
          const on = sel.has(c.sha);
          const cls = on ? (mode === "range" && selected.length > 1 ? " inrange" : " on") : "";
          return (
            <button key={c.sha} className={`cm${cls}${pos()}`} onClick={(e) => onPick(c.sha, e.shiftKey)} title={`${c.subject}\n${c.author} · ${c.short}`}>
              <span className="rail" />
              <span className={`dot${c.parents.length > 1 ? " merge" : ""}`} />
              <span className="body">
                <span className="t">{c.subject}</span>
                <span className="m">
                  {c.short} · {relativeTime(c.time)} · <span className="add-c">+{c.additions}</span>{" "}
                  <span className="del-c">−{c.deletions}</span>
                </span>
              </span>
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
        {mode === "range" ? "click two commits · " : ""}j / k to step
      </span>
    </aside>
  );
}
