import type { Editor, Filters } from "../types";
import { fileManagerName } from "../util";
import { Back, Check, Code, Cycle, Folder, Terminal } from "./Icons";

interface Props {
  filters: Filters;
  onFilters: (f: Filters) => void;
  hiddenCount: number;
  editor: Editor | null;
  onEditor: () => void;
  onTerminal: () => void;
  onReveal: () => void;
  canBack: boolean;
  onBack: () => void;
  related: { id: string; name: string; worktree?: string; branch: string | null; sameBranch: boolean; isNext: boolean }[];
  groupName?: string;
  /** Name of the repo this workspace shows (label of the rotate pill). */
  currentName: string;
  onJumpToPeer: (projectId: string, worktree?: string) => void;
}

function Pill({ on, label, onClick, tip }: { on: boolean; label: string; onClick: () => void; tip: string }) {
  return (
    <button className={`tg${on ? " on" : ""}`} onClick={onClick} aria-pressed={on} title={tip}>
      <span className="bx">{on && <Check stroke="var(--onacc)" />}</span>
      {label}
    </button>
  );
}

export function FilterBar({ filters, onFilters, hiddenCount, editor, onEditor, onTerminal, onReveal, canBack, onBack, related, groupName, currentName, onJumpToPeer }: Props) {
  const toggle = (k: keyof Filters) => onFilters({ ...filters, [k]: !filters[k] });
  return (
    <div className="filterbar">
      <button className="backbtn" onClick={onBack} disabled={!canBack} aria-label="Back" data-tip="Back (⌥←)" data-tip-left>
        <Back size={14} /> Back
      </button>
      {related.length > 0 && (
        <nav className="related" aria-label={`Related repositories${groupName ? ` in ${groupName}` : ""}`}>
          {/* Rotate pill: shows the repo you're on; hovering swipes to the one it
              switches to (what ` does). */}
          {(() => {
            const next = related.find((r) => r.isNext) ?? related[0];
            return (
              <button
                className={`rel cycle${next.sameBranch ? " same" : ""}`}
                onClick={() => onJumpToPeer(next.id, next.worktree)}
                aria-label={`Current repository ${currentName}; switch to ${next.name}`}
                title={`Next repo (\`): ${next.name}${next.sameBranch ? ` on the same branch (${next.branch})` : next.branch ? ` (${next.branch}, no worktree on this branch)` : ""}`}
              >
                <Cycle size={14} />
                <span className="swap">
                  <span className="cur">{currentName}</span>
                  <span className="nxt">
                    {next.name}
                    {!next.sameBranch && next.branch && <span className="br">{next.branch}</span>}
                  </span>
                </span>
              </button>
            );
          })()}
          {/* Bigger groups: the other repos as direct jumps. */}
          {related
            .filter((r) => !r.isNext)
            .map((r) => (
              <button
                key={r.id}
                className={`rel${r.sameBranch ? " same" : ""}`}
                onClick={() => onJumpToPeer(r.id, r.worktree)}
                title={r.sameBranch ? `${r.name} on the same branch (${r.branch})` : `${r.name}${r.branch ? ` (${r.branch})` : ""}: no worktree on this branch`}
              >
                {r.name}
                {!r.sameBranch && r.branch && <span className="br">{r.branch}</span>}
              </button>
            ))}
        </nav>
      )}
      <span className="grow" />
      {hiddenCount > 0 && (
        <span className="m" style={{ marginRight: 6 }}>
          {hiddenCount} file{hiddenCount === 1 ? "" : "s"} hidden
        </span>
      )}
      <Pill
        on={filters.hideTests}
        label="Hide tests"
        onClick={() => toggle("hideTests")}
        tip="Hide test sources, fixtures and snapshots"
      />
      <Pill
        on={filters.hideNonFunctional}
        label="Hide non-functional"
        onClick={() => toggle("hideNonFunctional")}
        tip="Hide lockfiles, assets, generated code, docs, config, pure renames and whitespace- or comment-only changes"
      />
      <Pill
        on={filters.ignoreWhitespace}
        label="Ignore whitespace"
        onClick={() => toggle("ignoreWhitespace")}
        tip="Hide indentation and whitespace changes inside files"
      />
      <div className="actions" style={{ marginLeft: 6 }}>
        <button className="iconbtn" onClick={onEditor} aria-label="Open in editor" data-tip={`Open in ${editor?.label ?? "editor"}`}>
          <Code />
        </button>
        <button className="iconbtn" onClick={onTerminal} aria-label="Open in terminal" data-tip="Open in terminal">
          <Terminal />
        </button>
        <button className="iconbtn" onClick={onReveal} aria-label={`Show in ${fileManagerName}`} data-tip={`Show in ${fileManagerName}`}>
          <Folder />
        </button>
      </div>
    </div>
  );
}
