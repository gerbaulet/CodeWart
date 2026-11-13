import type { Attribution, FileDiff, FileTag, Hunk } from "./types";

export const TONES = 6;

/**
 * Tag every changed line with the commit it came from and drop the changes of
 * hidden commits. Files left without changes are returned separately, with
 * why they disappeared ("merged" when only merged-in code was hidden).
 */
export function attributeFiles(
  files: FileDiff[],
  attr: Attribution | null,
  isHidden: (sha: string) => boolean,
  isForeign: (sha: string) => boolean,
): { files: FileDiff[]; dropped: { file: FileDiff; reason: FileTag }[] } {
  if (!attr) return { files, dropped: [] };
  const out: FileDiff[] = [];
  const dropped: { file: FileDiff; reason: FileTag }[] = [];
  for (const f of files) {
    const a = attr.files[f.path];
    if (!a) {
      out.push(f);
      continue;
    }
    const add = new Map(a.add);
    const del = new Map(a.del);
    let additions = 0, deletions = 0, removed = 0, ownRemoved = 0;
    const hunks: Hunk[] = [];
    for (const h of f.hunks) {
      const lines = [];
      let changes = 0;
      for (const l of h.lines) {
        const commit = l.kind === "add" ? add.get(l.new!) : l.kind === "del" ? del.get(l.old!) : undefined;
        if (commit && isHidden(commit)) {
          removed++;
          if (!isForeign(commit)) ownRemoved++;
          continue;
        }
        if (l.kind === "add") additions++, changes++;
        if (l.kind === "del") deletions++, changes++;
        lines.push(commit ? { ...l, commit } : l);
      }
      if (changes) hunks.push({ ...h, lines });
    }
    if (removed && !hunks.length) dropped.push({ file: f, reason: ownRemoved ? "commit" : "merged" });
    else out.push(removed ? { ...f, hunks, additions, deletions } : { ...f, hunks });
  }
  return { files: out, dropped };
}
