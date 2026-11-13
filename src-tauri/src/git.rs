//! Thin wrapper around the `git` CLI plus project / worktree / history discovery.
//!
//! We shell out to git instead of linking libgit2: it gives us worktrees, rename
//! detection and `-w` for free and always matches the user's git config.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Hash of git's empty tree, used as the "old" side for root commits.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

pub fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn git_cmd(dir: &Path, args: &[&str]) -> Command {
    let mut cmd = command("git");
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=never"])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    cmd
}

/// Run git and return stdout, or stderr as the error.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(dir, args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn rev_exists(dir: &Path, rev: &str) -> bool {
    git(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
    )
    .is_ok()
}

/// Normalise a path for comparisons (resolves symlinks like /tmp -> /private/tmp).
pub fn normalize(p: &Path) -> PathBuf {
    let c = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    #[cfg(windows)]
    {
        let s = c.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    c
}

pub fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------
// Projects & worktrees
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// Last activity, unix seconds: the newer of HEAD's commit time and the
    /// newest modification of an uncommitted file.
    pub updated: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Stable id: the main worktree's path. Opening any linked worktree of the
    /// same repository yields the same id, so they share one tab.
    pub id: String,
    pub name: String,
    pub main_root: String,
    /// The worktree that was opened (the one the user launched codewart in).
    pub opened_worktree: String,
    pub worktrees: Vec<Worktree>,
    pub default_branch: Option<String>,
}

pub fn open_project(path: &str) -> Result<Project, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("{path} does not exist"));
    }
    let dir = if p.is_file() {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    };
    let top = git(&dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("{} is not inside a git repository", dir.display()))?;
    let top = normalize(Path::new(top.trim()));
    let worktrees = list_worktrees(&top)?;
    let main = worktrees
        .iter()
        .find(|w| w.is_main)
        .cloned()
        .ok_or("could not determine the main worktree")?;
    let main_root = PathBuf::from(&main.path);
    let name = main_root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| main.path.clone());
    // A bare main repo has no working tree to run commands in; use the opened one.
    let default_branch = detect_default_branch(&top);
    Ok(Project {
        id: main.path.clone(),
        name: name.trim_end_matches(".git").to_string(),
        main_root: main.path.clone(),
        opened_worktree: path_str(&top),
        worktrees,
        default_branch,
    })
}

pub fn list_worktrees(dir: &Path) -> Result<Vec<Worktree>, String> {
    let out = git(dir, &["worktree", "list", "--porcelain"])?;
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            cur = Some(Worktree {
                path: path_str(&normalize(Path::new(path))),
                branch: None,
                head: String::new(),
                is_main: list.is_empty(),
                detached: false,
                bare: false,
                locked: false,
                updated: 0,
            });
        } else if let Some(w) = cur.as_mut() {
            if let Some(h) = line.strip_prefix("HEAD ") {
                w.head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                w.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "detached" {
                w.detached = true;
            } else if line == "bare" {
                w.bare = true;
            } else if line.starts_with("locked") {
                w.locked = true;
            } else if line.is_empty() {
                list.push(cur.take().unwrap());
            }
        }
    }
    for w in list.iter_mut().filter(|w| !w.bare) {
        w.updated = last_update(Path::new(&w.path));
    }
    Ok(list)
}

/// Newest of HEAD's commit time and the mtimes of uncommitted files.
fn last_update(dir: &Path) -> i64 {
    let mut t = git(dir, &["log", "-1", "--format=%ct", "HEAD"])
        .ok()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .unwrap_or(0);
    if let Ok(status) = git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    ) {
        for entry in status.split('\0').filter(|e| e.len() > 3) {
            let modified = std::fs::metadata(dir.join(&entry[3..]))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok());
            if let Some(d) = modified {
                t = t.max(d.as_secs() as i64);
            }
        }
    }
    t
}

pub fn detect_default_branch(dir: &Path) -> Option<String> {
    if let Ok(s) = git(
        dir,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    ) {
        let s = s.trim();
        let local = s.trim_start_matches("origin/");
        if rev_exists(dir, &format!("refs/heads/{local}")) {
            return Some(local.to_string());
        }
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    for c in ["main", "master", "trunk", "develop"] {
        if rev_exists(dir, &format!("refs/heads/{c}")) {
            return Some(c.to_string());
        }
    }
    for c in ["origin/main", "origin/master"] {
        if rev_exists(dir, &format!("refs/remotes/{c}")) {
            return Some(c.to_string());
        }
    }
    None
}

pub fn current_branch(dir: &Path) -> Option<String> {
    git(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// The commit the current branch forked from, if it is not the default branch.
pub fn branch_base(dir: &Path) -> Option<String> {
    let default = detect_default_branch(dir)?;
    let branch = current_branch(dir);
    if branch.as_deref() == Some(default.as_str()) {
        return None;
    }
    git(dir, &["merge-base", &default, "HEAD"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub subject: String,
    pub author: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub additions: u32,
    pub deletions: u32,
    pub files: u32,
    /// Came in through a merge from another branch (not on this branch's own line).
    pub foreign: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStats {
    pub files: u32,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    /// Commits newest first. On a feature branch: everything since the fork point.
    pub commits: Vec<Commit>,
    /// Fork point with the default branch (None when on the default branch).
    pub base: Option<Commit>,
    pub working: Option<WorkingStats>,
    pub head: Option<String>,
}

const LOG_FORMAT: &str = "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%P";

fn parse_log(out: &str) -> Vec<Commit> {
    let mut commits = Vec::new();
    for rec in out.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let mut lines = rec.lines();
        let Some(head) = lines.next() else { continue };
        let f: Vec<&str> = head.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let (mut adds, mut dels, mut files) = (0u32, 0u32, 0u32);
        for l in lines {
            let mut parts = l.split('\t');
            if let (Some(a), Some(d), Some(_)) = (parts.next(), parts.next(), parts.next()) {
                files += 1;
                adds += a.parse::<u32>().unwrap_or(0);
                dels += d.parse::<u32>().unwrap_or(0);
            }
        }
        commits.push(Commit {
            sha: f[0].to_string(),
            short: f[1].to_string(),
            subject: f[2].to_string(),
            author: f[3].to_string(),
            time: f[4].parse().unwrap_or(0),
            parents: f[5].split_whitespace().map(String::from).collect(),
            additions: adds,
            deletions: dels,
            files,
            foreign: false,
        });
    }
    commits
}

fn range_of(base: &Option<Commit>) -> String {
    match base {
        Some(b) => format!("{}..HEAD", b.sha),
        None => "HEAD".to_string(),
    }
}

pub fn history(dir: &Path) -> Result<History, String> {
    let head = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .ok()
        .map(|s| s.trim().to_string());
    let branch = current_branch(dir);
    let default_branch = detect_default_branch(dir);
    let mut commits = Vec::new();
    let mut base = None;
    if head.is_some() {
        if let Some(mb) = branch_base(dir) {
            let range = format!("{mb}..HEAD");
            commits = parse_log(&git(
                dir,
                &["log", "-M", "--numstat", LOG_FORMAT, "-n", "500", &range],
            )?);
            base = parse_log(&git(dir, &["log", LOG_FORMAT, "-n", "1", &mb])?)
                .into_iter()
                .next();
        } else {
            commits = parse_log(&git(
                dir,
                &["log", "-M", "--numstat", LOG_FORMAT, "-n", "60", "HEAD"],
            )?);
        }
    }
    // Commits that arrived through merges (another branch's work).
    if commits.iter().any(|c| c.parents.len() > 1) {
        let own: std::collections::HashSet<String> = git(
            dir,
            &["rev-list", "--first-parent", "-n", "1000", &range_of(&base)],
        )
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
        for c in &mut commits {
            c.foreign = !own.contains(&c.sha);
        }
    }
    let working = working_stats(dir, head.is_some());
    Ok(History {
        branch,
        default_branch,
        commits,
        base,
        working,
        head,
    })
}

fn working_stats(dir: &Path, has_head: bool) -> Option<WorkingStats> {
    let mut stats = WorkingStats::default();
    let numstat = if has_head {
        git(dir, &["diff", "HEAD", "--numstat", "-M"]).unwrap_or_default()
    } else {
        git(dir, &["diff", "--cached", "--numstat"]).unwrap_or_default()
    };
    for l in numstat.lines() {
        let mut p = l.split('\t');
        if let (Some(a), Some(d)) = (p.next(), p.next()) {
            stats.files += 1;
            stats.additions += a.parse::<u32>().unwrap_or(0);
            stats.deletions += d.parse::<u32>().unwrap_or(0);
        }
    }
    for path in untracked(dir) {
        stats.files += 1;
        if let Ok(text) = std::fs::read_to_string(dir.join(&path)) {
            stats.additions += text.lines().count() as u32;
        }
    }
    (stats.files > 0).then_some(stats)
}

pub fn untracked(dir: &Path) -> Vec<String> {
    git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])
        .map(|s| {
            s.split('\0')
                .filter(|p| !p.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Cheap fingerprint of the worktree state; changes whenever the agent commits
/// or touches a file. Used by the UI's "follow agent" polling.
pub fn fingerprint(dir: &Path) -> Result<String, String> {
    let mut h = DefaultHasher::new();
    git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .unwrap_or_default()
        .hash(&mut h);
    let status = git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    status.hash(&mut h);
    for entry in status.split('\0') {
        if entry.len() > 3 {
            let path = dir.join(&entry[3..]);
            if let Ok(meta) = std::fs::metadata(&path) {
                meta.len().hash(&mut h);
                if let Ok(m) = meta.modified() {
                    m.hash(&mut h);
                }
            }
        }
    }
    Ok(format!("{:016x}", h.finish()))
}

/// Read a file either from a revision or (rev = None) from the working tree.
pub fn read_at(dir: &Path, rev: Option<&str>, path: &str) -> Option<String> {
    match rev {
        None => std::fs::read_to_string(dir.join(path)).ok(),
        Some(EMPTY_TREE) => None,
        Some(r) => git(dir, &["show", &format!("{r}:{path}")]).ok(),
    }
}
