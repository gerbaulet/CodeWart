//! What does a path the user opened contain: one repository, or a folder with
//! several (e.g. a feature folder holding worktrees of `api/` and `web/`)?

use crate::git::{git, normalize, path_str};
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 2;
const MAX_REPOS: usize = 24;
const SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    ".venv",
    "venv",
    "__pycache__",
    "Pods",
    "DerivedData",
    ".next",
    ".cache",
];

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Discovery {
    /// The path is inside a single repository (or worktree).
    Repo { path: String },
    /// A plain folder containing several repositories / worktrees.
    Group {
        name: String,
        root: String,
        repos: Vec<String>,
    },
}

fn is_checkout(dir: &Path) -> bool {
    // `.git` is a directory in a main checkout and a file in a linked worktree.
    dir.join(".git").exists()
}

fn scan(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if out.len() >= MAX_REPOS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            !name.starts_with('.') && !SKIP.contains(&name.as_str())
        })
        .collect();
    dirs.sort();
    for d in dirs {
        if out.len() >= MAX_REPOS {
            return;
        }
        if is_checkout(&d) {
            out.push(d);
        } else if depth < MAX_DEPTH {
            scan(&d, depth + 1, out);
        }
    }
}

pub fn discover(path: &str) -> Result<Discovery, String> {
    let p = PathBuf::from(path);
    if !p.exists() {
        return Err(format!("{path} does not exist"));
    }
    let dir = if p.is_file() {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    };
    if let Ok(top) = git(&dir, &["rev-parse", "--show-toplevel"]) {
        return Ok(Discovery::Repo {
            path: path_str(&normalize(Path::new(top.trim()))),
        });
    }
    let mut repos = Vec::new();
    scan(&dir, 1, &mut repos);
    match repos.len() {
        0 => Err(format!(
            "{} is not a git repository and contains none",
            dir.display()
        )),
        1 => Ok(Discovery::Repo {
            path: path_str(&normalize(&repos[0])),
        }),
        _ => {
            let root = normalize(&dir);
            Ok(Discovery::Group {
                name: root
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path_str(&root)),
                root: path_str(&root),
                repos: repos.iter().map(|r| path_str(&normalize(r))).collect(),
            })
        }
    }
}
