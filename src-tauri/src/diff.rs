//! Diff loading and unified-diff parsing.

use crate::classify;
use crate::git::{self, git, EMPTY_TREE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

const MAX_LINES_PER_FILE: usize = 4000;
const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Selection {
    /// Uncommitted changes (HEAD -> working tree, untracked included).
    Working,
    /// A single commit against its first parent.
    Commit { sha: String },
    /// `from` (inclusive) up to `to`; `to = None` means the working tree.
    Range { from: String, to: Option<String> },
    /// Everything on this branch since it forked, including uncommitted work.
    Branch,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiffOptions {
    #[serde(default)]
    pub ignore_whitespace: bool,
    #[serde(default)]
    pub context: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// "ctx" | "add" | "del"
    pub kind: &'static str,
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub section: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    /// "added" | "deleted" | "modified" | "renamed" | "copied"
    pub status: String,
    pub binary: bool,
    pub similarity: Option<u32>,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<Hunk>,
    /// Why a file may be hidden: test, lockfile, asset, generated, docs,
    /// config, rename, whitespace, comments.
    pub tags: Vec<String>,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    /// Old side revision (a sha or the empty tree).
    pub old_rev: String,
    /// New side revision; None = working tree.
    pub new_rev: Option<String>,
}

/// Turn a UI selection into (old_rev, new_rev). new_rev None = working tree.
pub fn resolve(dir: &Path, sel: &Selection) -> Result<(String, Option<String>), String> {
    let has_head = git::rev_exists(dir, "HEAD");
    let parent_of = |rev: &str| -> String {
        let p = format!("{rev}^");
        if git::rev_exists(dir, &p) {
            git(dir, &["rev-parse", &p])
                .map(|s| s.trim().to_string())
                .unwrap_or(p)
        } else {
            EMPTY_TREE.to_string()
        }
    };
    Ok(match sel {
        Selection::Working => (
            if has_head {
                "HEAD".into()
            } else {
                EMPTY_TREE.into()
            },
            None,
        ),
        Selection::Commit { sha } => (parent_of(sha), Some(sha.clone())),
        Selection::Range { from, to } => (parent_of(from), to.clone()),
        Selection::Branch => match git::branch_base(dir) {
            Some(base) => (base, None),
            None => (
                if has_head {
                    "HEAD".into()
                } else {
                    EMPTY_TREE.into()
                },
                None,
            ),
        },
    })
}

pub fn load(dir: &Path, sel: &Selection, opts: &DiffOptions) -> Result<DiffResult, String> {
    let (old_rev, new_rev) = resolve(dir, sel)?;
    let context = format!("-U{}", opts.context.unwrap_or(3));
    let mut args: Vec<&str> = vec![
        "diff",
        "--no-ext-diff",
        "--no-color",
        "-M",
        &context,
        &old_rev,
    ];
    if let Some(n) = new_rev.as_deref() {
        args.push(n);
    }
    let mut ws_args = args.clone();
    if opts.ignore_whitespace {
        args.insert(1, "-w");
    }
    let mut files = parse_patch(&git(dir, &args)?);

    if new_rev.is_none() {
        let tracked: std::collections::HashSet<String> =
            files.iter().map(|f| f.path.clone()).collect();
        for path in git::untracked(dir) {
            if !tracked.contains(&path) {
                files.push(untracked_file(dir, &path));
            }
        }
    }

    // Whitespace-insensitive numstat tells us which files only changed whitespace.
    ws_args.retain(|a| *a != context.as_str() && *a != "--no-ext-diff" && *a != "--no-color");
    ws_args.splice(1..1, ["-w", "--numstat", "-z"]);
    let ws = whitespace_numstat(&git(dir, &ws_args).unwrap_or_default());

    for f in &mut files {
        let ws_changes = ws.get(&f.path).copied().unwrap_or((0, 0));
        let whitespace_only = !f.binary
            && f.status == "modified"
            && (f.additions + f.deletions) > 0
            && ws_changes == (0, 0);
        f.tags = classify::tags(f, whitespace_only);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(DiffResult {
        files,
        old_rev,
        new_rev,
    })
}

fn whitespace_numstat(out: &str) -> HashMap<String, (u32, u32)> {
    // -z format: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0".
    let mut map = HashMap::new();
    let mut parts = out.split('\0');
    while let Some(rec) = parts.next() {
        let mut f = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(p)) = (f.next(), f.next(), f.next()) else {
            continue;
        };
        let a = a.parse().unwrap_or(1);
        let d = d.parse().unwrap_or(1);
        let path = if p.is_empty() {
            let _old = parts.next();
            parts.next().unwrap_or("").to_string()
        } else {
            p.to_string()
        };
        map.insert(path, (a, d));
    }
    map
}

fn untracked_file(dir: &Path, path: &str) -> FileDiff {
    let full = dir.join(path);
    let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    let mut file = FileDiff {
        path: path.to_string(),
        old_path: None,
        status: "added".into(),
        binary: false,
        similarity: None,
        additions: 0,
        deletions: 0,
        hunks: vec![],
        tags: vec![],
        truncated: false,
    };
    if size > MAX_UNTRACKED_BYTES {
        file.truncated = true;
        return file;
    }
    let bytes = std::fs::read(&full).unwrap_or_default();
    if bytes.iter().take(8000).any(|b| *b == 0) {
        file.binary = true;
        return file;
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<Line> = text
        .lines()
        .enumerate()
        .map(|(i, l)| Line {
            kind: "add",
            old: None,
            new: Some(i as u32 + 1),
            text: l.to_string(),
        })
        .collect();
    let n = lines.len() as u32;
    file.additions = n;
    if lines.len() > MAX_LINES_PER_FILE {
        lines.truncate(MAX_LINES_PER_FILE);
        file.truncated = true;
    }
    if n > 0 {
        file.hunks.push(Hunk {
            header: format!("@@ -0,0 +1,{n} @@"),
            section: String::new(),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: n,
            lines,
        });
    }
    file
}

fn parse_range(s: &str) -> (u32, u32) {
    let mut it = s.splitn(2, ',');
    let start = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let len = it.next().map(|v| v.parse().unwrap_or(1)).unwrap_or(1);
    (start, len)
}

fn strip_prefix_path(p: &str) -> Option<String> {
    let p = p.trim_end_matches('\t');
    if p == "/dev/null" {
        return None;
    }
    let p = p
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(p);
    Some(
        p.strip_prefix("a/")
            .or_else(|| p.strip_prefix("b/"))
            .unwrap_or(p)
            .to_string(),
    )
}

/// Parse `git diff` unified output.
pub fn parse_patch(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut line_count = 0usize;
    let (mut old_no, mut new_no) = (0u32, 0u32);
    let mut in_header = false;

    for raw in text.lines() {
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            // Best-effort path from the header; refined by ---/+++/rename lines.
            let path = match rest.find(" b/") {
                Some(i) => rest[i + 3..].to_string(),
                None => rest.to_string(),
            };
            files.push(FileDiff {
                path,
                old_path: None,
                status: "modified".into(),
                binary: false,
                similarity: None,
                additions: 0,
                deletions: 0,
                hunks: vec![],
                tags: vec![],
                truncated: false,
            });
            line_count = 0;
            in_header = true;
            continue;
        }
        let Some(f) = files.last_mut() else { continue };

        if in_header && !raw.starts_with("@@") {
            if raw.starts_with("new file mode") {
                f.status = "added".into();
            } else if raw.starts_with("deleted file mode") {
                f.status = "deleted".into();
            } else if let Some(p) = raw.strip_prefix("rename from ") {
                f.old_path = Some(p.to_string());
                f.status = "renamed".into();
            } else if let Some(p) = raw.strip_prefix("rename to ") {
                f.path = p.to_string();
            } else if let Some(p) = raw.strip_prefix("copy from ") {
                f.old_path = Some(p.to_string());
                f.status = "copied".into();
            } else if let Some(p) = raw.strip_prefix("copy to ") {
                f.path = p.to_string();
            } else if let Some(s) = raw.strip_prefix("similarity index ") {
                f.similarity = s.trim_end_matches('%').parse().ok();
            } else if raw.starts_with("Binary files ") || raw.starts_with("GIT binary patch") {
                f.binary = true;
            } else if let Some(p) = raw.strip_prefix("--- ") {
                if let Some(p) = strip_prefix_path(p) {
                    if f.status != "renamed" && f.status != "copied" {
                        f.path = p;
                    }
                }
            } else if let Some(p) = raw.strip_prefix("+++ ") {
                if let Some(p) = strip_prefix_path(p) {
                    f.path = p;
                }
            }
            continue;
        }

        if let Some(rest) = raw.strip_prefix("@@ ") {
            // @@ -a,b +c,d @@ section
            let end = rest.find(" @@").unwrap_or(rest.len());
            let ranges = &rest[..end];
            let section = rest.get(end + 3..).unwrap_or("").trim().to_string();
            let mut parts = ranges.split_whitespace();
            let (os, ol) = parse_range(parts.next().unwrap_or("-0").trim_start_matches('-'));
            let (ns, nl) = parse_range(parts.next().unwrap_or("+0").trim_start_matches('+'));
            old_no = os;
            new_no = ns;
            in_header = false;
            f.hunks.push(Hunk {
                header: raw.to_string(),
                section,
                old_start: os,
                old_lines: ol,
                new_start: ns,
                new_lines: nl,
                lines: vec![],
            });
            continue;
        }
        let Some(h) = f.hunks.last_mut() else {
            continue;
        };
        let (kind, text) = match raw.as_bytes().first() {
            Some(b'+') => ("add", &raw[1..]),
            Some(b'-') => ("del", &raw[1..]),
            Some(b' ') => ("ctx", &raw[1..]),
            Some(b'\\') => continue, // "\ No newline at end of file"
            _ => ("ctx", raw),
        };
        let line = match kind {
            "add" => {
                f.additions += 1;
                new_no += 1;
                Line {
                    kind,
                    old: None,
                    new: Some(new_no - 1),
                    text: text.to_string(),
                }
            }
            "del" => {
                f.deletions += 1;
                old_no += 1;
                Line {
                    kind,
                    old: Some(old_no - 1),
                    new: None,
                    text: text.to_string(),
                }
            }
            _ => {
                old_no += 1;
                new_no += 1;
                Line {
                    kind,
                    old: Some(old_no - 1),
                    new: Some(new_no - 1),
                    text: text.to_string(),
                }
            }
        };
        line_count += 1;
        if line_count <= MAX_LINES_PER_FILE {
            h.lines.push(line);
        } else {
            f.truncated = true;
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATCH: &str = "diff --git a/src/a.rs b/src/a.rs
index 111..222 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,3 +1,4 @@ fn main() {
 fn main() {
-    old();
+    new();
+    more();
 }
diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc
Binary files /dev/null and b/img.png differ
";

    #[test]
    fn parses_files_hunks_and_numbers() {
        let files = parse_patch(PATCH);
        assert_eq!(files.len(), 3);
        let a = &files[0];
        assert_eq!(a.path, "src/a.rs");
        assert_eq!((a.additions, a.deletions), (2, 1));
        assert_eq!(a.hunks[0].section, "fn main() {");
        let l = &a.hunks[0].lines;
        assert_eq!(l[1].kind, "del");
        assert_eq!(l[1].old, Some(2));
        assert_eq!(l[2].new, Some(2));
        assert_eq!(l[3].new, Some(3));
        assert_eq!(l[4].old, Some(3));
        assert_eq!(l[4].new, Some(4));

        assert_eq!(files[1].status, "renamed");
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].similarity, Some(100));

        assert!(files[2].binary);
        assert_eq!(files[2].status, "added");
        assert_eq!(files[2].path, "img.png");
    }

    #[test]
    fn content_lines_starting_with_dashes_are_not_headers() {
        let p = "diff --git a/x.md b/x.md
--- a/x.md
+++ b/x.md
@@ -1,2 +1,2 @@
--- old rule
+++ new rule
 keep
";
        let f = &parse_patch(p)[0];
        assert_eq!(f.path, "x.md");
        assert_eq!((f.additions, f.deletions), (1, 1));
        assert_eq!(f.hunks[0].lines[0].text, "-- old rule");
    }

    #[test]
    fn numstat_z_handles_renames() {
        let m = whitespace_numstat("0\t0\ta.rs\x001\t2\t\x00old.rs\x00new.rs\x00");
        assert_eq!(m.get("a.rs"), Some(&(0, 0)));
        assert_eq!(m.get("new.rs"), Some(&(1, 2)));
    }
}
