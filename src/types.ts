export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  detached: boolean;
  bare: boolean;
  locked: boolean;
}

export interface Project {
  id: string;
  name: string;
  mainRoot: string;
  openedWorktree: string;
  worktrees: Worktree[];
  defaultBranch: string | null;
}

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  time: number;
  parents: string[];
  additions: number;
  deletions: number;
  files: number;
}

export interface WorkingStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface History {
  branch: string | null;
  defaultBranch: string | null;
  commits: Commit[];
  base: Commit | null;
  working: WorkingStats | null;
  head: string | null;
}

export type Selection =
  | { kind: "working" }
  | { kind: "commit"; sha: string }
  | { kind: "range"; from: string; to: string | null }
  | { kind: "branch" };

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
}

export interface Hunk {
  header: string;
  section: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileTag =
  | "test"
  | "lockfile"
  | "asset"
  | "generated"
  | "docs"
  | "config"
  | "rename"
  | "whitespace"
  | "comments";

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  binary: boolean;
  similarity: number | null;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  tags: FileTag[];
  truncated: boolean;
}

export interface DiffResult {
  files: FileDiff[];
  oldRev: string;
  newRev: string | null;
}

export interface SnippetLine {
  kind: "ctx" | "add" | "del";
  text: string;
  line: number | null;
}

export interface GraphNode {
  id: string;
  name: string;
  container: string | null;
  file: string;
  line: number;
  endLine: number;
  status: "added" | "modified" | "deleted" | "moved" | "context";
  movedFrom: string | null;
  additions: number;
  deletions: number;
  signature: string;
  snippet: SnippetLine[];
  /** Whole function: current code with this selection's changes interleaved. */
  body: DiffLine[];
  isTest: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  isNew: boolean;
}

export interface CallGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  skippedFiles: string[];
}

export type GraphScope = "changed" | "neighbours";

export interface Editor {
  id: string;
  label: string;
}

export interface AgentSession {
  id: string;
  label: string;
  cwd: string;
  command: string;
  isAgent: boolean;
}

export interface ReviewComment {
  id: string;
  file: string;
  /** Line number on the side the comment was made on. */
  line: number;
  endLine?: number;
  side: "new" | "old";
  /** The code being commented on. */
  code: string;
  body: string;
  /** Set when made from the call graph. */
  symbol?: string;
}

export interface Filters {
  hideTests: boolean;
  hideNonFunctional: boolean;
  ignoreWhitespace: boolean;
}

export type View = "diff" | "calls";
export type HistoryMode = "single" | "range" | "all";

export type Discovery =
  | { kind: "repo"; path: string }
  | { kind: "group"; name: string; root: string; repos: string[] };

export interface CliStatus {
  installed: boolean;
  path: string;
  onPath: boolean;
}

/** Several repositories opened together from one folder. */
export interface RepoGroup {
  root: string;
  name: string;
}

/** Another repo in the same group, for quick switching. */
export interface Peer {
  id: string;
  name: string;
  /** The repo after this one in the group (for cycling). */
  isNext: boolean;
  worktree: string;
  worktrees: Worktree[];
}
