import { useState } from "react";
import type { History, Project, View } from "../types";
import { relativeTime, tildify } from "../util";
import { Branch, ChevronDown, DiffIcon, GraphIcon, Refresh, WorktreeIcon } from "./Icons";
import { Popover } from "./Popover";

interface Props {
  project: Project;
  worktree: string;
  history: History | null;
  view: View;
  onView: (v: View) => void;
  onWorktree: (path: string) => void;
  onRefresh: () => void;
}

export function WorktreeBar({ project, worktree, history, view, onView, onWorktree, onRefresh }: Props) {
  const [open, setOpen] = useState(false);
  const current = project.worktrees.find((w) => w.path === worktree);
  const label = current?.branch ?? (current?.detached ? `detached @ ${current.head.slice(0, 7)}` : "unknown");
  const ahead = history?.commits.length ?? 0;
  const onDefault = history && history.branch && history.branch === history.defaultBranch;

  return (
    <div className="wtbar">
      <div style={{ position: "relative" }}>
        <button className="wtbtn" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
          <Branch />
          <span className="lbl">{label}</span>
          <ChevronDown />
        </button>
        <Popover open={open} onClose={() => setOpen(false)}>
          <div className="cap">Worktrees · {project.name} · newest first</div>
          {project.worktrees
            .filter((w) => !w.bare)
            .sort((a, b) => b.updated - a.updated)
            .map((w) => (
              <button
                key={w.path}
                className={`opt${w.path === worktree ? " on" : ""}`}
                onClick={() => {
                  onWorktree(w.path);
                  setOpen(false);
                }}
              >
                <span className="r1">
                  <span style={{ display: "inline-grid", color: w.path === worktree ? "var(--acc)" : "var(--faint)" }}>
                    {w.isMain ? <Branch size={13} /> : <WorktreeIcon size={13} />}
                  </span>
                  {w.branch ?? `detached @ ${w.head.slice(0, 7)}`}
                  <span className="badge">{w.isMain ? "main checkout" : "worktree"}</span>
                  {w.locked && <span className="badge">locked</span>}
                </span>
                <span className="m" style={{ paddingLeft: 21 }}>
                  {tildify(w.path)}
                  {w.updated > 0 && ` · ${relativeTime(w.updated)}`}
                </span>
              </button>
            ))}
          <div className="sep" />
          <button
            className="opt"
            onClick={() => {
              onRefresh();
              setOpen(false);
            }}
          >
            <span className="r1" style={{ fontFamily: "var(--sans)", fontWeight: 400 }}>
              <Refresh size={14} /> Rescan worktrees
            </span>
          </button>
        </Popover>
      </div>
      <div className="wtmeta m">
        <span title={worktree}>{tildify(worktree)}</span>
        {history && !onDefault && history.defaultBranch && (
          <span>
            {ahead} commit{ahead === 1 ? "" : "s"} ahead of {history.defaultBranch}
          </span>
        )}
        {history?.working && (
          <span>
            {history.working.files} uncommitted · <span className="add-c">+{history.working.additions}</span>{" "}
            <span className="del-c">−{history.working.deletions}</span>
          </span>
        )}
      </div>
      <span className="grow" />
      <div className="seg lg" role="tablist" aria-label="View">
        <button role="tab" aria-selected={view === "diff"} className={view === "diff" ? "on" : ""} onClick={() => onView("diff")}>
          <DiffIcon size={14} /> Diff
        </button>
        <button role="tab" aria-selected={view === "calls"} className={view === "calls" ? "on" : ""} onClick={() => onView("calls")}>
          <GraphIcon size={14} /> Call chain
        </button>
      </div>
    </div>
  );
}
