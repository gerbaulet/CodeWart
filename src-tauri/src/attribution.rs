//! Which commit each changed line of a multi-commit diff came from.
//!
//! Added lines are blamed on the new side (restricted to the selection's
//! range); deleted lines are reverse-blamed on the old side, which names the
//! last commit that still had the line, so the commit after it deleted it
//! (followed along the branch's own line, so a merge owns what it removed).
//! Commits that reached the branch through a merge (not on its own
//! first-parent line) are reported as foreign.

use crate::diff::{self, DiffOptions, FileDiff, Selection};
use crate::git::{git, EMPTY_TREE};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Uncommitted changes.
pub const WORKING: &str = "working";
const ZERO: &str = "0000000000000000000000000000000000000000";
const MAX_FILES: usize = 200;
const THREADS: usize = 6;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileAttribution {
    /// (new line number, commit) for added lines.
    pub add: Vec<(u32, String)>,
    /// (old line number, commit) for deleted lines.
    pub del: Vec<(u32, String)>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    /// Commits in the range that came in through a merge from another branch.
    pub foreign: Vec<String>,
    /// Commits in the range, oldest first (`working` last when included).
    pub commits: Vec<String>,
    pub files: HashMap<String, FileAttribution>,
}

/// `git blame --porcelain` → (final line number, commit) for every line.
fn parse_porcelain(out: &str) -> Vec<(u32, String)> {
    let mut v = Vec::new();
    for l in out.lines() {
        let mut f = l.split(' ');
        let (Some(sha), Some(_orig), Some(fin)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        if let Ok(n) = fin.parse() {
            let c = if sha == ZERO { WORKING } else { sha };
            v.push((n, c.to_string()));
        }
    }
    v
}

/// Collapse sorted line numbers into `-L a,b` arguments.
fn line_ranges(lines: &[u32]) -> Vec<String> {
    let mut out = Vec::new();
    let mut it = lines.iter().copied();
    let Some(mut start) = it.next() else {
        return out;
    };
    let mut end = start;
    for n in it {
        if n == end + 1 {
            end = n;
        } else {
            out.push(format!("{start},{end}"));
            start = n;
            end = n;
        }
    }
    out.push(format!("{start},{end}"));
    out
}

struct Ctx<'a> {
    dir: &'a Path,
    /// `old..new` (or just `new` from a root commit).
    range: String,
    /// End of the range as a commit (HEAD when the new side is the working tree).
    end: String,
    working: bool,
    ignore_ws: bool,
    /// parent -> its child on the first-parent line of the range.
    children: HashMap<String, String>,
}

impl Ctx<'_> {
    fn blame(&self, path: &str, lines: &[u32], reverse: bool) -> Option<Vec<(u32, String)>> {
        let ranges = line_ranges(lines);
        let mut args: Vec<String> = vec!["blame".into(), "--porcelain".into()];
        if self.ignore_ws {
            args.push("-w".into());
        }
        if reverse {
            // Along the branch's own line: a merge "deletes" what it replaced.
            args.push("--reverse".into());
            args.push("--first-parent".into());
        } else if self.working {
            args.push("--contents".into());
            args.push(path.into());
        }
        for r in &ranges {
            args.push("-L".into());
            args.push(r.clone());
        }
        args.push(self.range.clone());
        args.push("--".into());
        args.push(path.into());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(self.dir, &refs).ok().map(|o| parse_porcelain(&o))
    }

    /// The commit that removed a line `last` still had.
    fn deleter(&self, last: &str) -> Option<String> {
        if last == self.end {
            return self.working.then(|| WORKING.to_string());
        }
        self.children.get(last).cloned()
    }

    fn file(&self, f: &FileDiff) -> FileAttribution {
        let mut adds = Vec::new();
        let mut dels = Vec::new();
        for h in &f.hunks {
            for l in &h.lines {
                match l.kind {
                    "add" => adds.extend(l.new),
                    "del" => dels.extend(l.old),
                    _ => {}
                }
            }
        }
        let mut out = FileAttribution::default();
        if !adds.is_empty() {
            match self.blame(&f.path, &adds, false) {
                Some(b) => out.add = b,
                // Untracked files can't be blamed: all of it is uncommitted.
                None if self.working => {
                    out.add = adds.iter().map(|&n| (n, WORKING.to_string())).collect()
                }
                None => {}
            }
        }
        if !dels.is_empty() {
            let old = f.old_path.as_deref().unwrap_or(&f.path);
            if let Some(b) = self.blame(old, &dels, true) {
                out.del = b
                    .into_iter()
                    .filter_map(|(n, last)| self.deleter(&last).map(|c| (n, c)))
                    .collect();
            }
        }
        out
    }
}

fn rev_list(dir: &Path, args: &[&str]) -> Vec<String> {
    git(dir, args)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

/// Commits in `range` that are not on its first-parent line (merged in).
pub fn foreign_commits(dir: &Path, range: &str) -> HashSet<String> {
    let own: HashSet<String> = rev_list(dir, &["rev-list", "--first-parent", range])
        .into_iter()
        .collect();
    rev_list(dir, &["rev-list", range])
        .into_iter()
        .filter(|c| !own.contains(c))
        .collect()
}

pub fn attribute(dir: &Path, sel: &Selection, opts: &DiffOptions) -> Result<Attribution, String> {
    let d = diff::load(dir, sel, opts)?;
    let working = d.new_rev.is_none();
    let end = match &d.new_rev {
        Some(r) => r.clone(),
        None => match git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"]) {
            Ok(h) => h.trim().to_string(),
            Err(_) => return Ok(Attribution::default()),
        },
    };
    let end = git(dir, &["rev-parse", &end])
        .map(|s| s.trim().to_string())
        .unwrap_or(end);
    // Root commit: blame the whole history. Only uncommitted work: an empty range.
    let root = d.old_rev == EMPTY_TREE;
    let old = if d.old_rev == "HEAD" {
        end.clone()
    } else {
        d.old_rev.clone()
    };
    let range = if root {
        end.clone()
    } else {
        format!("{old}..{end}")
    };

    let commits_args = ["rev-list", "--reverse", "--topo-order", range.as_str()];
    let mut commits = if old == end {
        Vec::new()
    } else {
        rev_list(dir, &commits_args)
    };
    // Deletions are traced along the branch's own line: parent -> first-parent child.
    let mut children: HashMap<String, String> = HashMap::new();
    for l in rev_list(dir, &["rev-list", "--first-parent", "--parents", &range]) {
        let mut it = l.split(' ');
        if let (Some(c), Some(p)) = (it.next(), it.next()) {
            children.insert(p.to_string(), c.to_string());
        }
    }
    let foreign = if root || old == end {
        HashSet::new()
    } else {
        foreign_commits(dir, &range)
    };
    if working {
        commits.push(WORKING.to_string());
    }

    let ctx = Ctx {
        dir,
        range,
        end,
        working,
        ignore_ws: opts.ignore_whitespace,
        children,
    };
    let todo: Vec<&FileDiff> = d
        .files
        .iter()
        .filter(|f| !f.binary && !f.hunks.is_empty())
        .take(MAX_FILES)
        .collect();
    let mut files = HashMap::new();
    let chunk = todo.len().div_ceil(THREADS).max(1);
    std::thread::scope(|s| {
        let handles: Vec<_> = todo
            .chunks(chunk)
            .map(|part| {
                let ctx = &ctx;
                s.spawn(move || {
                    part.iter()
                        .map(|f| (f.path.clone(), ctx.file(f)))
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            files.extend(h.join().unwrap_or_default());
        }
    });
    let mut foreign: Vec<String> = foreign.into_iter().collect();
    foreign.sort();
    Ok(Attribution {
        foreign,
        commits,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_lines() {
        let out = "\
0796480 1 1 1
07964803ebaad559c18596824de970269b69aedf 2 2 1
author t
summary c1
\tB1
0000000000000000000000000000000000000000 4 4 1
\tW
07964803ebaad559c18596824de970269b69aedf 3 5
\tx
";
        assert_eq!(
            parse_porcelain(out),
            vec![
                (2, "07964803ebaad559c18596824de970269b69aedf".to_string()),
                (4, WORKING.to_string()),
                (5, "07964803ebaad559c18596824de970269b69aedf".to_string()),
            ]
        );
    }

    #[test]
    fn ranges() {
        assert_eq!(
            line_ranges(&[1, 2, 3, 7, 9, 10]),
            vec!["1,3", "7,7", "9,10"]
        );
        assert!(line_ranges(&[]).is_empty());
    }
}
