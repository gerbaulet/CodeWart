//! Open a worktree in the user's editor, terminal or file manager.

use crate::git::command;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let c = dir.join(format!("{name}.{ext}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

/// GUI apps launched from the Dock/Finder get a minimal PATH. Ask the user's
/// login shell for the real one so `git`, `code`, `tmux` … resolve.
pub fn fix_path_env() {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = command(&shell)
            .args(["-ilc", "printf '__CODEWART__%s__CODEWART__' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        if let Ok(out) = out {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(path) = s.split("__CODEWART__").nth(1) {
                if !path.is_empty() {
                    std::env::set_var("PATH", path);
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub id: String,
    pub label: String,
}

/// Editors we know how to launch at a specific line, in preference order.
const EDITORS: &[(&str, &str)] = &[
    ("cursor", "Cursor"),
    ("code", "VS Code"),
    ("zed", "Zed"),
    ("windsurf", "Windsurf"),
    ("subl", "Sublime Text"),
    ("idea", "IntelliJ IDEA"),
    ("webstorm", "WebStorm"),
    ("rustrover", "RustRover"),
    ("fleet", "Fleet"),
];

pub fn detect_editor() -> Option<Editor> {
    if let Ok(e) = std::env::var("CODEWART_EDITOR") {
        if !e.trim().is_empty() {
            return Some(Editor {
                id: e.clone(),
                label: e,
            });
        }
    }
    EDITORS
        .iter()
        .find(|(bin, _)| find_in_path(bin).is_some())
        .map(|(bin, label)| Editor {
            id: bin.to_string(),
            label: label.to_string(),
        })
}

pub fn open_in_editor(root: &str, file: Option<&str>, line: Option<u32>) -> Result<(), String> {
    let root = Path::new(root);
    let target = file.map(|f| root.join(f));
    let Some(editor) = detect_editor() else {
        // Fall back to the OS default handler.
        return open_with_os(target.as_deref().unwrap_or(root));
    };
    let mut parts = editor.id.split_whitespace();
    let bin = parts.next().unwrap_or("code").to_string();
    let extra: Vec<String> = parts.map(String::from).collect();
    let name = Path::new(&bin)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = command(&bin);
    cmd.args(&extra);
    match (&target, line) {
        (Some(t), Some(l)) => match name.as_str() {
            "code" | "cursor" | "windsurf" | "codium" => {
                cmd.arg(root).arg("-g").arg(format!("{}:{l}", t.display()));
            }
            "idea" | "webstorm" | "rustrover" | "pycharm" | "goland" | "fleet" => {
                cmd.arg(root).arg("--line").arg(l.to_string()).arg(t);
            }
            _ => {
                cmd.arg(format!("{}:{l}", t.display()));
            }
        },
        (Some(t), None) => {
            if matches!(name.as_str(), "code" | "cursor" | "windsurf" | "codium") {
                cmd.arg(root);
            }
            cmd.arg(t);
        }
        _ => {
            cmd.arg(root);
        }
    }
    cmd.current_dir(root)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not launch {bin}: {e}"))
}

pub fn open_with_os(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = command("open");
        c.arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = command("explorer");
        c.arg(path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = command("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub fn reveal(path: &str) -> Result<(), String> {
    open_with_os(Path::new(path))
}

/// Open a web link (a PR page) in the default browser. Only http(s) URLs.
pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("not a web link: {url}"));
    }
    open_with_os(Path::new(url))
}

pub fn open_terminal(path: &str) -> Result<(), String> {
    let custom = std::env::var("CODEWART_TERMINAL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    #[cfg(target_os = "macos")]
    {
        let app = custom.unwrap_or_else(|| {
            ["Ghostty", "iTerm", "Warp", "WezTerm", "kitty", "Alacritty"]
                .iter()
                .find(|a| Path::new(&format!("/Applications/{a}.app")).exists())
                .map(|a| a.to_string())
                .unwrap_or_else(|| "Terminal".into())
        });
        command("open")
            .args(["-a", &app, path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(t) = custom {
            return command(&t)
                .current_dir(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        if find_in_path("wt").is_some() {
            return command("wt")
                .args(["-d", path])
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        command("cmd")
            .args(["/C", "start", "cmd", "/K", "cd", "/d", path])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(t) = custom {
            return command(&t)
                .current_dir(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &[]),
            ("gnome-terminal", &["--working-directory"]),
            ("konsole", &["--workdir"]),
            ("ghostty", &[]),
            ("wezterm", &["start", "--cwd"]),
            ("kitty", &["--directory"]),
            ("alacritty", &["--working-directory"]),
            ("xfce4-terminal", &["--working-directory"]),
        ];
        for (bin, flag) in candidates {
            if find_in_path(bin).is_some() {
                let mut cmd = command(bin);
                if flag.is_empty() {
                    cmd.current_dir(path);
                } else {
                    cmd.args(*flag).arg(path);
                }
                return cmd.spawn().map(|_| ()).map_err(|e| e.to_string());
            }
        }
        Err("no terminal emulator found; set CODEWART_TERMINAL".into())
    }
}
