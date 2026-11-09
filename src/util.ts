import type { FileDiff, FileTag, Filters, ReviewComment } from "./types";

export const NON_FUNCTIONAL: FileTag[] = [
  "lockfile",
  "asset",
  "generated",
  "docs",
  "config",
  "rename",
  "whitespace",
  "comments",
];

export const TAG_LABEL: Record<FileTag, string> = {
  test: "test",
  lockfile: "lockfile",
  asset: "asset",
  generated: "generated",
  docs: "docs",
  config: "config",
  rename: "rename only",
  whitespace: "whitespace only",
  comments: "comments only",
};

/** Why a file is hidden under the current filters, or null if visible. */
export function hiddenReason(f: FileDiff, filters: Filters): FileTag | null {
  if (filters.hideTests && f.tags.includes("test")) return "test";
  if (filters.hideNonFunctional) {
    const t = f.tags.find((t) => NON_FUNCTIONAL.includes(t));
    if (t) return t;
  }
  return null;
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

export function relativeTime(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export function tildify(path: string): string {
  const m = path.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  return m ? `~${m[2] ?? ""}` : path;
}

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
export const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent);
export const fileManagerName = isMac ? "Finder" : isWindows ? "Explorer" : "file manager";

const EXT_LANG: Record<string, string> = {
  rs: "rust", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", rb: "ruby", php: "php", scala: "scala", dart: "dart", lua: "lua",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", md: "markdown",
  css: "css", scss: "scss", less: "less", html: "xml", xml: "xml", vue: "xml", svelte: "xml",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", graphql: "graphql", ex: "elixir", exs: "elixir",
  dockerfile: "dockerfile", makefile: "makefile", mk: "makefile", proto: "protobuf",
};

export function languageOf(path: string): string | undefined {
  const name = splitPath(path).name.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT_LANG[ext];
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A comment on a file as a whole (made from the file header), not on lines. */
export const isFileComment = (c: ReviewComment) => c.line === 0;

/** Compile the review batch into markdown an agent can act on. */
export function reviewMarkdown(opts: {
  comments: ReviewComment[];
  note: string;
  target: string;
  includeCode: boolean;
}): string {
  const out: string[] = [];
  out.push(`Review feedback on ${opts.target}:`);
  if (opts.note.trim()) out.push("", opts.note.trim());
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of opts.comments) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }
  let n = 1;
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.line - b.line);
    for (const c of list) {
      const range = c.endLine && c.endLine !== c.line ? `${c.line}-${c.endLine}` : `${c.line}`;
      const where = c.side === "old" ? `${file}:${range} (removed line)` : `${file}:${range}`;
      const title = isFileComment(c)
        ? `\`${file}\` (whole file${c.side === "old" ? ", deleted" : ""})`
        : c.symbol
          ? `\`${c.symbol}\` in \`${where}\``
          : `\`${where}\``;
      out.push("", `${n}. ${title}`);
      if (opts.includeCode && c.code.trim()) {
        const lang = languageOf(file) ?? "";
        out.push("   ```" + lang, ...c.code.split("\n").map((l) => "   " + l), "   ```");
      }
      out.push(...c.body.trim().split("\n").map((l) => "   " + l));
      n++;
    }
  }
  return out.join("\n") + "\n";
}
