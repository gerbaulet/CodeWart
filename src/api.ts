import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSession,
  CallGraph,
  CliStatus,
  Discovery,
  DiffResult,
  Editor,
  GraphScope,
  History,
  Project,
  PullRequest,
  Selection,
} from "./types";

export const api = {
  launchPaths: () => invoke<string[]>("launch_paths"),
  discover: (path: string) => invoke<Discovery>("discover", { path }),
  openProject: (path: string) => invoke<Project>("open_project", { path }),
  cliStatus: () => invoke<CliStatus>("cli_status"),
  installCli: () => invoke<CliStatus>("install_cli"),
  history: (worktree: string) => invoke<History>("history", { worktree }),
  diff: (worktree: string, selection: Selection, ignoreWhitespace: boolean) =>
    invoke<DiffResult>("diff", { worktree, selection, options: { ignoreWhitespace } }),
  callGraph: (worktree: string, selection: Selection, scope: GraphScope) =>
    invoke<CallGraph>("call_graph", { worktree, selection, scope }),
  fingerprint: (worktree: string) => invoke<string>("fingerprint", { worktree }),
  prStatus: (worktree: string, branch: string) => invoke<PullRequest | null>("pr_status", { worktree, branch }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  editorInfo: () => invoke<Editor | null>("editor_info"),
  openInEditor: (root: string, file?: string, line?: number) =>
    invoke<void>("open_in_editor", { root, file: file ?? null, line: line ?? null }),
  openInTerminal: (path: string) => invoke<void>("open_in_terminal", { path }),
  revealInFileManager: (path: string) => invoke<void>("reveal_in_file_manager", { path }),
  listSessions: (worktree: string) => invoke<AgentSession[]>("list_sessions", { worktree }),
  injectText: (session: string, text: string, submit: boolean) =>
    invoke<void>("inject_text", { session, text, submit }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
