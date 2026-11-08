import { useState, type DragEvent } from "react";
import type { CliStatus, Project, RepoGroup } from "../types";
import { tildify } from "../util";
import { Close, Monitor, Moon, Sun, Plus, Terminal } from "./Icons";

export type ThemePref = "system" | "dark" | "light";

interface Props {
  tabs: { project: Project; group?: string }[];
  groups: Record<string, RepoGroup>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseGroup: (root: string) => void;
  /** New tab order (project ids). */
  onReorder: (ids: string[]) => void;
  onOpen: () => void;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  cli: CliStatus | null;
  onInstallCli: () => void;
}

const NEXT: Record<ThemePref, ThemePref> = { system: "dark", dark: "light", light: "system" };
const GROUP_HUES = ["var(--g1)", "var(--g2)", "var(--g3)", "var(--g4)"];

function hueFor(root: string) {
  let h = 0;
  for (const c of root) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GROUP_HUES[h % GROUP_HUES.length];
}

/** Consecutive tabs of one group form a unit; ungrouped tabs are units of one. */
type Unit = { key: string; group?: string; tabs: Props["tabs"] };

function toUnits(tabs: Props["tabs"]): Unit[] {
  const units: Unit[] = [];
  for (const t of tabs) {
    const last = units[units.length - 1];
    if (t.group && last?.group === t.group) last.tabs.push(t);
    else units.push({ key: t.group ? `g:${t.group}` : `t:${t.project.id}`, group: t.group, tabs: [t] });
  }
  return units;
}

export function ProjectTabs(p: Props) {
  const units = toUnits(p.tabs);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const drop = (targetKey: string) => {
    if (!dragging || dragging === targetKey) return;
    const order = units.filter((u) => u.key !== dragging);
    const moved = units.find((u) => u.key === dragging);
    const at = order.findIndex((u) => u.key === targetKey);
    const from = units.findIndex((u) => u.key === dragging);
    const to = units.findIndex((u) => u.key === targetKey);
    if (!moved || at < 0) return;
    order.splice(from < to ? at + 1 : at, 0, moved);
    p.onReorder(order.flatMap((u) => u.tabs.map((t) => t.project.id)));
  };

  const dragProps = (u: Unit) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", u.key);
      setDragging(u.key);
    },
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
    onDragOver: (e: DragEvent) => {
      if (!dragging || dragging === u.key) return;
      e.preventDefault();
      setOver(u.key);
    },
    onDragLeave: () => setOver((o) => (o === u.key ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      drop(u.key);
      setOver(null);
    },
  });

  const tab = (t: Props["tabs"][number], inGroup: boolean, unit?: Unit) => (
    <button
      key={t.project.id}
      className={`ptab${t.project.id === p.activeId ? " on" : ""}`}
      onClick={() => p.onSelect(t.project.id)}
      onAuxClick={(e) => e.button === 1 && p.onClose(t.project.id)}
      title={tildify(t.project.mainRoot)}
      {...(!inGroup && unit ? dragProps(unit) : {})}
    >
      <span className="dot" />
      {t.project.name}
      <span
        className="x"
        role="button"
        aria-label={`Close ${t.project.name}`}
        onClick={(e) => {
          e.stopPropagation();
          p.onClose(t.project.id);
        }}
      >
        <Close />
      </span>
    </button>
  );

  return (
    <header className="tabsbar fl" data-tauri-drag-region>
      <nav className="ptabs" aria-label="Open projects" data-tauri-drag-region>
        {units.map((u) =>
          u.group ? (
            <div
              key={u.key}
              className={`tabgroup${dragging === u.key ? " dragging" : ""}${over === u.key ? " over" : ""}${u.tabs.some((t) => t.project.id === p.activeId) ? " active" : ""}`}
              style={{ ["--gc" as string]: hueFor(u.group) }}
              role="group"
              aria-label={`Repositories in ${p.groups[u.group]?.name ?? "group"}`}
              {...dragProps(u)}
            >
              <span className="glabel" title={`${tildify(u.group)} · drag to move the group`}>
                {p.groups[u.group]?.name ?? "group"}
                <span
                  className="x"
                  role="button"
                  aria-label="Close all repositories in this group"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onCloseGroup(u.group!);
                  }}
                >
                  <Close />
                </span>
              </span>
              {u.tabs.map((t) => tab(t, true))}
            </div>
          ) : (
            <div key={u.key} className={`tabunit${dragging === u.key ? " dragging" : ""}${over === u.key ? " over" : ""}`}>
              {tab(u.tabs[0], false, u)}
            </div>
          ),
        )}
        <button className="iconbtn" onClick={p.onOpen} aria-label="Open project" data-tip="Open repo, worktree or folder…" data-tip-left>
          <Plus />
        </button>
      </nav>
      {p.cli && !p.cli.installed && (
        <button className="clibtn" onClick={p.onInstallCli} data-tip={`Install the "wart" command (${tildify(p.cli.path)})`}>
          <Terminal size={14} /> Install <code>wart</code>
        </button>
      )}
      <button className="iconbtn" onClick={() => p.onTheme(NEXT[p.theme])} aria-label={`Theme: ${p.theme}`} data-tip={`Theme: ${p.theme}`}>
        {p.theme === "system" ? <Monitor /> : p.theme === "dark" ? <Moon /> : <Sun />}
      </button>
    </header>
  );
}
