import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "./api";
import { Logo } from "./components/Icons";
import { ProjectTabs, type ThemePref } from "./components/ProjectTabs";
import { Workspace } from "./components/Workspace";
import type { CliStatus, Editor, Filters, GraphScope, Peer, Project, RepoGroup, View } from "./types";
import { isMac, tildify } from "./util";

interface Tab {
  project: Project;
  worktree: string;
  /** Root folder of the repo group this tab belongs to. */
  group?: string;
}

interface Toast {
  id: number;
  msg: string;
  err: boolean;
}

interface SavedTab {
  path: string;
  worktree: string;
  group?: string;
}

const STORE = {
  tabs: "codewart.tabs",
  groups: "codewart.groups",
  active: "codewart.active",
  theme: "codewart.theme",
  filters: "codewart.filters",
  view: "codewart.view",
  scope: "codewart.scope",
};

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const NO_PEERS: Peer[] = [];

/** macOS: the strip the window buttons sit in, with the logo, name and version centred. */
function TitleStrip() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);
  return (
    <div className="titlestrip" data-tauri-drag-region>
      <div className="apptitle" data-tauri-drag-region>
        <Logo size={15} />
        codewart
        {version && <span>{version}</span>}
      </div>
    </div>
  );
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [groups, setGroups] = useState<Record<string, RepoGroup>>(() => load(STORE.groups, {}));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(() => load(STORE.theme, "system"));
  const [filters, setFilters] = useState<Filters>(() =>
    load(STORE.filters, { hideTests: false, hideNonFunctional: true, ignoreWhitespace: false }),
  );
  // Diff / call chain and graph scope are shared by all repos (kept when switching).
  const [view, setView] = useState<View>(() => load(STORE.view, "diff"));
  const [scope, setScope] = useState<GraphScope>(() => load(STORE.scope, "neighbours"));
  const [editor, setEditor] = useState<Editor | null>(null);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [booted, setBooted] = useState(false);

  const toast = useCallback((msg: string, err = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), err ? 6000 : 2600);
  }, []);

  // ---- theme ---------------------------------------------------------------
  useEffect(() => {
    save(STORE.theme, theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const t = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => save(STORE.filters, filters), [filters]);
  useEffect(() => save(STORE.view, view), [view]);
  useEffect(() => save(STORE.scope, scope), [scope]);

  // ---- persistence ---------------------------------------------------------
  useEffect(() => {
    if (!booted) return;
    save(
      STORE.tabs,
      tabs.map<SavedTab>((t) => ({ path: t.project.mainRoot, worktree: t.worktree, group: t.group })),
    );
    // Only keep groups that still have tabs.
    const used = new Set(tabs.map((t) => t.group).filter(Boolean));
    save(STORE.groups, Object.fromEntries(Object.entries(groups).filter(([k]) => used.has(k))));
    save(STORE.active, activeId);
  }, [tabs, groups, activeId, booted]);

  // ---- opening projects ------------------------------------------------------
  /** Open (or refresh) one repository as a tab. Grouped tabs stay adjacent. */
  const openRepo = useCallback(
    async (path: string, opts: { activate?: boolean; worktree?: string; quiet?: boolean; group?: string } = {}) => {
      try {
        const project = await api.openProject(path);
        const wt = opts.worktree && project.worktrees.some((w) => w.path === opts.worktree) ? opts.worktree : project.openedWorktree;
        setTabs((ts) => {
          const i = ts.findIndex((t) => t.project.id === project.id);
          if (i >= 0) {
            const copy = ts.slice();
            copy[i] = { project, worktree: opts.worktree ? wt : project.openedWorktree, group: opts.group ?? ts[i].group };
            return copy;
          }
          const tab: Tab = { project, worktree: wt, group: opts.group };
          if (opts.group) {
            let last = -1;
            ts.forEach((t, j) => t.group === opts.group && (last = j));
            if (last >= 0) return [...ts.slice(0, last + 1), tab, ...ts.slice(last + 1)];
          }
          return [...ts, tab];
        });
        if (opts.activate !== false) setActiveId(project.id);
        return project;
      } catch (e) {
        if (!opts.quiet) toast(errorMessage(e), true);
        return null;
      }
    },
    [toast],
  );

  /** Open whatever is at `path`: a repo, or every repo in a folder (as a group). */
  const openPath = useCallback(
    async (path: string, opts: { activate?: boolean } = {}) => {
      try {
        const d = await api.discover(path);
        if (d.kind === "repo") return void (await openRepo(d.path, opts));
        setGroups((g) => ({ ...g, [d.root]: { root: d.root, name: d.name } }));
        let first: Project | null = null;
        for (const repo of d.repos) {
          const p = await openRepo(repo, { group: d.root, activate: false, worktree: repo });
          first ??= p;
        }
        if (first && opts.activate !== false) setActiveId(first.id);
        toast(`Opened ${d.repos.length} repositories from ${d.name}`);
      } catch (e) {
        toast(errorMessage(e), true);
      }
    },
    [openRepo, toast],
  );

  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    (async () => {
      api.editorInfo().then(setEditor).catch(() => {});
      api.cliStatus().then(setCli).catch(() => {});
      const saved = load<SavedTab[]>(STORE.tabs, []);
      const savedActive = load<string | null>(STORE.active, null);
      for (const s of saved) await openRepo(s.path, { activate: false, worktree: s.worktree, quiet: true, group: s.group });
      if (savedActive) setActiveId((a) => a ?? savedActive);
      const launch = await api.launchPaths().catch(() => [] as string[]);
      for (const p of launch) await openPath(p);
      setTabs((ts) => {
        setActiveId((a) => (a && ts.some((t) => t.project.id === a) ? a : ts[0]?.project.id ?? null));
        return ts;
      });
      setBooted(true);
    })();
  }, [openRepo, openPath]);

  useEffect(() => {
    const un = listen<string>("open-path", (e) => void openPath(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, [openPath]);

  // Stable callbacks: Workspace is memoised, so inline lambdas would make every
  // open (hidden) project re-render on each tab switch.
  const setWorktree = useCallback(
    (projectId: string, wt: string) => setTabs((ts) => ts.map((x) => (x.project.id === projectId ? { ...x, worktree: wt } : x))),
    [],
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const rescan = useCallback(
    (projectId: string) => {
      const t = tabsRef.current.find((x) => x.project.id === projectId);
      if (t) void openRepo(t.project.mainRoot, { worktree: t.worktree, group: t.group });
    },
    [openRepo],
  );
  /** Switch to a related repo, optionally onto a specific worktree. */
  const jumpToPeer = useCallback((projectId: string, worktree?: string) => {
    if (worktree) setTabs((ts) => ts.map((x) => (x.project.id === projectId ? { ...x, worktree } : x)));
    setActiveId(projectId);
  }, []);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Open a repository, worktree or folder of repos" });
    if (typeof dir === "string") await openPath(dir);
  };

  const closeTabs = (ids: string[]) => {
    setTabs((ts) => {
      const first = ts.findIndex((t) => ids.includes(t.project.id));
      const next = ts.filter((t) => !ids.includes(t.project.id));
      if (activeId && ids.includes(activeId)) setActiveId(next[Math.max(0, first - 1)]?.project.id ?? null);
      return next;
    });
  };

  const reorder = (ids: string[]) =>
    setTabs((ts) => ids.map((id) => ts.find((t) => t.project.id === id)).filter((t): t is Tab => !!t));

  const installCli = async () => {
    try {
      const st = await api.installCli();
      setCli(st);
      toast(
        st.onPath
          ? `Installed: run "wart ." in any repo (${tildify(st.path)})`
          : `Installed ${tildify(st.path)}. Add its folder to your PATH to use "wart".`,
        !st.onPath,
      );
    } catch (e) {
      toast(errorMessage(e), true);
    }
  };

  // Other repos in the same group, per tab (stable arrays for memoised workspaces).
  const peers = useMemo(() => {
    const m = new Map<string, Peer[]>();
    for (const t of tabs) {
      if (!t.group) continue;
      const members = tabs.filter((o) => o.group === t.group);
      const me = members.findIndex((o) => o.project.id === t.project.id);
      const next = members[(me + 1) % members.length]?.project.id;
      m.set(
        t.project.id,
        members
          .filter((o) => o.project.id !== t.project.id)
          .map((o) => ({
            id: o.project.id,
            name: o.project.name,
            worktree: o.worktree,
            worktrees: o.project.worktrees,
            isNext: o.project.id === next,
          })),
      );
    }
    return m;
  }, [tabs]);

  const active = tabs.find((t) => t.project.id === activeId) ?? null;
  useEffect(() => {
    document.title = active ? `${active.project.name} — Codewart` : "Codewart";
  }, [active]);

  return (
    <div className={`app${isMac ? " mac" : ""}`}>
      {isMac && <TitleStrip />}
      <ProjectTabs
        tabs={tabs.map((t) => ({ project: t.project, group: t.group }))}
        groups={groups}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={(id) => closeTabs([id])}
        onCloseGroup={(root) => closeTabs(tabs.filter((t) => t.group === root).map((t) => t.project.id))}
        onReorder={reorder}
        onOpen={pickFolder}
        theme={theme}
        onTheme={setTheme}
        cli={cli}
        onInstallCli={installCli}
      />
      {tabs.map((t) => (
        <Workspace
          key={`${t.project.id}::${t.worktree}`}
          project={t.project}
          worktree={t.worktree}
          active={t.project.id === activeId}
          filters={filters}
          onFilters={setFilters}
          editor={editor}
          onWorktree={setWorktree}
          onRescan={rescan}
          view={view}
          onView={setView}
          scope={scope}
          onScope={setScope}
          peers={peers.get(t.project.id) ?? NO_PEERS}
          groupName={t.group ? groups[t.group]?.name : undefined}
          onJumpToPeer={jumpToPeer}
          toast={toast}
        />
      ))}
      {booted && tabs.length === 0 && (
        <div className="fl" style={{ flex: 1, display: "grid", placeItems: "center", background: "var(--pane)" }}>
          <div className="empty">
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
              <Logo size={48} />
            </div>
            <div className="big">Review what your agents wrote</div>
            <p style={{ margin: "0 0 20px" }}>
              Open a git repository, any of its worktrees, or a folder holding several repos. Codewart finds the main
              checkout and all sibling worktrees automatically.
            </p>
            <button className="btn pri" onClick={pickFolder}>
              Open project…
            </button>
            <p className="m" style={{ marginTop: 18 }}>
              or run <code>wart .</code> inside a repo
              {cli && !cli.installed && (
                <>
                  {" · "}
                  <button className="linkbtn" onClick={installCli}>
                    install the wart command
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.err ? " err" : ""}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
