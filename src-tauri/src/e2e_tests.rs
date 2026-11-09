//! End-to-end tests against a throwaway git repository with a linked worktree.

use crate::callgraph::{self, Scope};
use crate::diff::{self, DiffOptions, Selection};
use crate::git;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Repo {
    root: PathBuf,
}

impl Drop for Repo {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn sh(dir: &Path, args: &[&str]) {
    let st = Command::new("git")
        .current_dir(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        st.status.success(),
        "git {:?}: {}",
        args,
        String::from_utf8_lossy(&st.stderr)
    );
}

fn write(dir: &Path, path: &str, body: &str) {
    let p = dir.join(path);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// main: src/session.ts with refreshSession + isExpiringSoon.
/// worktree `agent` on branch feat/x: adds rotateToken (called from
/// refreshSession), changes isExpiringSoon, adds a test, a lockfile and a
/// whitespace-only change; plus an uncommitted new helper.
fn fixture(name: &str) -> (Repo, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("codewart-e2e-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let main = root.join("api");
    std::fs::create_dir_all(&main).unwrap();
    sh(&main, &["init", "-q", "-b", "main"]);
    write(
        &main,
        "src/session.ts",
        "export async function refreshSession(ctx: Ctx) {\n  const token = await ctx.store.get(ctx.userId);\n  return token;\n}\n\nexport function isExpiringSoon(t: Token, ms: number) {\n  return t.exp - Date.now() < ms;\n}\n",
    );
    write(
        &main,
        "src/util.ts",
        "export function pad(s: string) {\n  return s;\n}\n",
    );
    sh(&main, &["add", "."]);
    sh(&main, &["commit", "-q", "-m", "init"]);

    let wt = root.join("api.agent");
    sh(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/x",
            wt.to_str().unwrap(),
        ],
    );
    write(
        &wt,
        "src/session.ts",
        "export async function refreshSession(ctx: Ctx) {\n  const token = await ctx.store.get(ctx.userId);\n  if (isExpiringSoon(token, 60_000)) {\n    return rotateToken(token);\n  }\n  return token;\n}\n\nexport function isExpiringSoon(t: Token, ms: number) {\n  const now = clock.now();\n  return t.exp - now < ms;\n}\n",
    );
    write(&wt, "src/token.ts", "export async function rotateToken(t: Token) {\n  return sign(t);\n}\n\nfunction sign(t: Token) {\n  return t;\n}\n");
    write(&wt, "src/session.test.ts", "test('x', () => {});\n");
    write(&wt, "package-lock.json", "{}\n");
    write(
        &wt,
        "src/util.ts",
        "export function pad(s: string) {\n    return s;\n}\n",
    );
    sh(&wt, &["add", "."]);
    sh(&wt, &["commit", "-q", "-m", "Rotate tokens"]);
    // Uncommitted, untracked helper.
    write(
        &wt,
        "src/lonely.ts",
        "export function lonely() {\n  return 1;\n}\n",
    );
    let repo = Repo { root };
    (repo, git::normalize(&main), git::normalize(&wt))
}

#[test]
fn project_is_identified_from_either_checkout() {
    let (_repo, main, wt) = fixture("project");
    let from_main = git::open_project(main.to_str().unwrap()).unwrap();
    let from_wt = git::open_project(wt.join("src").to_str().unwrap()).unwrap();
    assert_eq!(from_main.id, from_wt.id);
    assert_eq!(from_main.name, "api");
    assert_eq!(from_wt.opened_worktree, git::path_str(&wt));
    assert_eq!(from_main.worktrees.len(), 2);
    assert!(from_main.worktrees[0].is_main);
    assert_eq!(from_main.worktrees[1].branch.as_deref(), Some("feat/x"));
    assert_eq!(from_main.default_branch.as_deref(), Some("main"));
}

#[test]
fn history_diff_and_classification() {
    let (_repo, _main, wt) = fixture("diff");
    let h = git::history(&wt).unwrap();
    assert_eq!(h.branch.as_deref(), Some("feat/x"));
    assert_eq!(h.commits.len(), 1);
    assert_eq!(h.commits[0].subject, "Rotate tokens");
    assert_eq!(h.base.as_ref().unwrap().subject, "init");
    assert_eq!(h.working.as_ref().unwrap().files, 1);

    let d = diff::load(
        &wt,
        &Selection::Commit {
            sha: h.commits[0].sha.clone(),
        },
        &DiffOptions::default(),
    )
    .unwrap();
    let tags = |p: &str| d.files.iter().find(|f| f.path == p).unwrap().tags.clone();
    assert_eq!(tags("src/session.test.ts"), vec!["test"]);
    assert_eq!(tags("package-lock.json"), vec!["lockfile"]);
    assert_eq!(tags("src/util.ts"), vec!["whitespace"]);
    assert!(tags("src/session.ts").is_empty());

    let working = diff::load(&wt, &Selection::Working, &DiffOptions::default()).unwrap();
    assert_eq!(working.files.len(), 1);
    assert_eq!(working.files[0].path, "src/lonely.ts");
    assert_eq!(working.files[0].status, "added");

    let branch = diff::load(&wt, &Selection::Branch, &DiffOptions::default()).unwrap();
    assert_eq!(branch.files.len(), 6);

    let ws = diff::load(
        &wt,
        &Selection::Branch,
        &DiffOptions {
            ignore_whitespace: true,
            context: None,
        },
    )
    .unwrap();
    assert!(ws
        .files
        .iter()
        .all(|f| f.path != "src/util.ts" || f.hunks.is_empty()));
}

#[test]
fn call_graph_connects_new_calls() {
    let (_repo, _main, wt) = fixture("graph");
    let g = callgraph::build(&wt, &Selection::Branch, Scope::Changed).unwrap();
    let status = |name: &str| {
        g.nodes
            .iter()
            .find(|n| n.name == name)
            .map(|n| n.status.clone())
    };
    assert_eq!(status("refreshSession").as_deref(), Some("modified"));
    assert_eq!(status("isExpiringSoon").as_deref(), Some("modified"));
    assert_eq!(status("rotateToken").as_deref(), Some("added"));
    assert_eq!(status("sign").as_deref(), Some("added"));
    assert_eq!(status("lonely").as_deref(), Some("added"));
    assert_eq!(status("pad"), None, "whitespace-only edits are not changes");

    let id = |name: &str| g.nodes.iter().find(|n| n.name == name).unwrap().id.clone();
    let edge = |a: &str, b: &str| {
        g.edges
            .iter()
            .find(|e| e.from == id(a) && e.to == id(b))
            .cloned()
    };
    assert!(edge("refreshSession", "rotateToken").unwrap().is_new);
    assert!(edge("refreshSession", "isExpiringSoon").unwrap().is_new);
    assert!(edge("rotateToken", "sign").is_some());
    assert!(g
        .edges
        .iter()
        .all(|e| e.from != id("lonely") && e.to != id("lonely")));
    // Whole function, additions marked, old/new line numbers mapped.
    let refresh = g.nodes.iter().find(|n| n.name == "refreshSession").unwrap();
    let kinds: String = refresh.body.iter().map(|l| &l.kind[..1]).collect();
    assert_eq!(kinds, "ccaaacc");
    assert_eq!(refresh.body[0].old, Some(1));
    assert_eq!(refresh.body.last().unwrap().old, Some(4));
    assert_eq!(refresh.body.last().unwrap().new, Some(7));
    // A deleted line inside a function shows up in place.
    let exp = g.nodes.iter().find(|n| n.name == "isExpiringSoon").unwrap();
    let kinds: String = exp.body.iter().map(|l| &l.kind[..1]).collect();
    assert_eq!(kinds, "cdaac");
    let rotate = g.nodes.iter().find(|n| n.name == "rotateToken").unwrap();
    assert!(rotate
        .snippet
        .iter()
        .any(|l| l.kind == "add" && l.text.contains("sign(t)")));
}

#[test]
fn call_graph_never_links_across_languages() {
    let root = std::env::temp_dir().join(format!("codewart-e2e-lang-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let repo = Repo { root: root.clone() };
    sh(&root, &["init", "-q", "-b", "main"]);
    write(&root, "README.md", "x\n");
    sh(&root, &["add", "."]);
    sh(&root, &["commit", "-q", "-m", "init"]);
    // Uncommitted: a JS caller, a TS `persist` and a Ruby `persist`.
    write(
        &root,
        "web/app.js",
        "export function run(x) {\n  return persist(x);\n}\n",
    );
    write(
        &root,
        "web/store.ts",
        "export function persist(x: number) {\n  return x;\n}\n",
    );
    write(
        &root,
        "app/models/user.rb",
        "class User\n  def persist(x)\n    x\n  end\nend\n",
    );

    let g = callgraph::build(&git::normalize(&root), &Selection::Working, Scope::Changed).unwrap();
    let file_of = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().file.clone();
    let callees: Vec<String> = g.edges.iter().map(|e| file_of(&e.to)).collect();
    assert_eq!(
        callees,
        vec!["web/store.ts".to_string()],
        "edges: {:?}",
        g.edges
    );
    drop(repo);
}

#[test]
fn fingerprint_changes_when_files_change() {
    let (_repo, _main, wt) = fixture("fp");
    let a = git::fingerprint(&wt).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(
        &wt,
        "src/lonely.ts",
        "export function lonely() {\n  return 2;\n}\n// more\n",
    );
    let b = git::fingerprint(&wt).unwrap();
    assert_ne!(a, b);
}

#[test]
fn discovers_single_repo_and_folder_of_repos() {
    use crate::discover::{discover, Discovery};
    let (repo, main, wt) = fixture("discover");
    // Inside a repo → that repo.
    assert_eq!(
        discover(main.join("src").to_str().unwrap()).unwrap(),
        Discovery::Repo {
            path: git::path_str(&main)
        }
    );
    // The folder holding `api/` and `api.agent/` → a group of both checkouts.
    match discover(repo.root.to_str().unwrap()).unwrap() {
        Discovery::Group { repos, name, .. } => {
            assert!(name.starts_with("codewart-e2e-discover"));
            assert_eq!(repos, vec![git::path_str(&main), git::path_str(&wt)]);
        }
        other => panic!("expected a group, got {other:?}"),
    }
    // A folder without repos is an error.
    let empty = repo.root.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(discover(empty.to_str().unwrap()).is_err());
}

#[cfg(unix)]
#[test]
fn launcher_script_is_valid_and_points_at_the_app() {
    let s = crate::cli::script_for_test(Path::new("/Apps/Codewart.app/Contents/MacOS/codewart"));
    assert!(s.contains("Codewart launcher"));
    assert!(
        s.contains("CODEWART_BIN=\"${CODEWART_BIN:-/Apps/Codewart.app/Contents/MacOS/codewart}\"")
    );
    let path = std::env::temp_dir().join(format!("codewart-launcher-{}", std::process::id()));
    std::fs::write(&path, &s).unwrap();
    let ok = Command::new("sh")
        .arg("-n")
        .arg(&path)
        .status()
        .unwrap()
        .success();
    let _ = std::fs::remove_file(&path);
    assert!(ok, "generated launcher has a shell syntax error");
}
