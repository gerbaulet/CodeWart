mod actions;
mod callgraph;
mod classify;
mod cli;
mod diff;
mod discover;
mod git;
mod pr;
mod review;
mod session;

#[cfg(test)]
mod e2e_tests;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Paths passed on the command line, consumed by the UI on startup.
#[derive(Default)]
struct LaunchPaths(Mutex<Vec<String>>);

/// A `wart review` request passed on the command line at startup.
#[derive(Default)]
struct LaunchReview(Mutex<Option<review::ReviewRequest>>);

/// Turn CLI arguments into absolute project paths. No argument = cwd.
fn paths_from_args(args: &[String], cwd: &Path) -> Vec<String> {
    let mut paths: Vec<String> = args
        .iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            let abs = if p.is_absolute() { p } else { cwd.join(p) };
            git::path_str(&git::normalize(&abs))
        })
        .collect();
    let launched_from_shell =
        std::env::var_os("TERM").is_some() || std::env::var_os("CODEWART_CWD").is_some();
    if paths.is_empty() && launched_from_shell && cwd != Path::new("/") {
        paths.push(git::path_str(&git::normalize(cwd)));
    }
    paths
}

fn launch_cwd() -> PathBuf {
    std::env::var_os("CODEWART_CWD")
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("/"))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn launch_paths(state: tauri::State<LaunchPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[tauri::command]
fn launch_review(state: tauri::State<LaunchReview>) -> Option<review::ReviewRequest> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn review_waiting(reply: String) -> bool {
    review::is_waiting(&reply)
}

#[tauri::command]
fn write_review_reply(reply: String, text: String) -> Result<(), String> {
    review::write_reply(&reply, &text)
}

/// Bounce the Dock icon / flash the taskbar without stealing focus.
#[tauri::command]
fn request_attention(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[tauri::command]
async fn open_project(path: String) -> Result<git::Project, String> {
    blocking(move || git::open_project(&path)).await
}

#[tauri::command]
async fn discover(path: String) -> Result<discover::Discovery, String> {
    blocking(move || discover::discover(&path)).await
}

#[tauri::command]
fn cli_status() -> cli::CliStatus {
    cli::status()
}

#[tauri::command]
fn install_cli() -> Result<cli::CliStatus, String> {
    cli::install()
}

#[tauri::command]
async fn history(worktree: String) -> Result<git::History, String> {
    blocking(move || git::history(Path::new(&worktree))).await
}

#[tauri::command]
async fn diff(
    worktree: String,
    selection: diff::Selection,
    options: diff::DiffOptions,
) -> Result<diff::DiffResult, String> {
    blocking(move || diff::load(Path::new(&worktree), &selection, &options)).await
}

#[tauri::command]
async fn call_graph(
    worktree: String,
    selection: diff::Selection,
    scope: callgraph::Scope,
) -> Result<callgraph::CallGraph, String> {
    blocking(move || callgraph::build(Path::new(&worktree), &selection, scope)).await
}

/// A file's full text at a revision (None = working tree), for expanding
/// unchanged lines around diff hunks.
#[tauri::command]
async fn read_file(
    worktree: String,
    rev: Option<String>,
    path: String,
) -> Result<Option<String>, String> {
    let inside = !Path::new(&path).is_absolute()
        && !Path::new(&path)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir));
    if !inside {
        return Err(format!("not a path inside the repository: {path}"));
    }
    blocking(move || Ok(git::read_at(Path::new(&worktree), rev.as_deref(), &path))).await
}

#[tauri::command]
async fn fingerprint(worktree: String) -> Result<String, String> {
    blocking(move || git::fingerprint(Path::new(&worktree))).await
}

#[tauri::command]
async fn pr_status(worktree: String, branch: String) -> Result<Option<pr::PullRequest>, String> {
    blocking(move || Ok(pr::for_branch(Path::new(&worktree), &branch))).await
}

#[tauri::command]
fn editor_info() -> Option<actions::Editor> {
    actions::detect_editor()
}

#[tauri::command]
fn open_in_editor(root: String, file: Option<String>, line: Option<u32>) -> Result<(), String> {
    actions::open_in_editor(&root, file.as_deref(), line)
}

#[tauri::command]
fn open_in_terminal(path: String) -> Result<(), String> {
    actions::open_terminal(&path)
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    actions::open_url(&url)
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    actions::reveal(&path)
}

#[tauri::command]
async fn list_sessions(worktree: String) -> Result<Vec<session::AgentSession>, String> {
    blocking(move || Ok(session::list(&worktree))).await
}

#[tauri::command]
async fn inject_text(session: String, text: String, submit: bool) -> Result<(), String> {
    blocking(move || session::inject(&session, &text, submit)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("codewart {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.iter().any(|a| a == "--agent-help") {
        print!("{}", include_str!("../../docs/agents.md"));
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!("codewart {}\n\nUsage: wart [PATH...]   (or codewart [PATH...])\n\nOpens the git project, worktree, or folder of repositories at PATH\n(default: current directory).\nIf codewart is already running the project opens as a new tab.\n\n       wart review [-m MESSAGE] [--timeout SECS] [PATH]\n\nAsks for a review of the worktree at PATH in Codewart and waits; prints the\nreview when you send it (exit 3 if --timeout passes first).\n\n       wart agent\n\nGuide for coding agents: what Codewart is for and how to use it.\n\nEnvironment:\n  CODEWART_EDITOR    editor command (default: first of cursor, code, zed, subl …)\n  CODEWART_TERMINAL  terminal app/command for \"open in terminal\"", env!("CARGO_PKG_VERSION"));
        return;
    }
    if std::env::var_os("TERM").is_none() {
        actions::fix_path_env();
    }
    let initial = paths_from_args(&args, &launch_cwd());
    let initial_review = review::from_args(&args, &initial);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let cwd = if cwd.is_empty() {
                launch_cwd()
            } else {
                PathBuf::from(cwd)
            };
            let paths = paths_from_args(&argv, &cwd);
            // A review request opens its worktree itself and doesn't steal focus.
            if let Some(req) = review::from_args(&argv, &paths) {
                let _ = app.emit("review-request", req);
                return;
            }
            for p in paths {
                let _ = app.emit("open-path", p);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(LaunchPaths(Mutex::new(initial)))
        .manage(LaunchReview(Mutex::new(initial_review)))
        .invoke_handler(tauri::generate_handler![
            launch_paths,
            launch_review,
            review_waiting,
            write_review_reply,
            request_attention,
            discover,
            open_project,
            cli_status,
            install_cli,
            history,
            diff,
            call_graph,
            fingerprint,
            read_file,
            pr_status,
            editor_info,
            open_in_editor,
            open_in_terminal,
            reveal_in_file_manager,
            open_url,
            list_sessions,
            inject_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running codewart");
}
