//! Find agent sessions running in a worktree and inject review text into them.
//!
//! Supported multiplexers / terminals with a scripting interface:
//! - tmux        (`tmux load-buffer` + `paste-buffer`)
//! - WezTerm     (`wezterm cli send-text`)
//! - kitty       (`kitten @ send-text`, needs `allow_remote_control`)
//!
//! Everything else falls back to copy & paste in the UI.

use crate::actions::find_in_path;
use crate::git::{command, normalize};
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

const AGENTS: &[&str] = &[
    "claude",
    "codex",
    "aider",
    "gemini",
    "opencode",
    "amp",
    "cursor-agent",
    "goose",
    "crush",
    "qwen",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// "tmux:%3", "wezterm:12", "kitty:4"
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub command: String,
    pub is_agent: bool,
}

fn inside(cwd: &str, root: &Path) -> bool {
    !cwd.is_empty() && normalize(Path::new(cwd)).starts_with(root)
}

fn run(bin: &str, args: &[&str]) -> Option<String> {
    let out = command(bin)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn looks_like_agent(cmd: &str, title: &str) -> bool {
    let c = cmd.to_ascii_lowercase();
    let t = title.to_ascii_lowercase();
    AGENTS.iter().any(|a| c.contains(a) || t.contains(a)) || t.contains('✳')
}

pub fn list(worktree: &str) -> Vec<AgentSession> {
    let root = normalize(Path::new(worktree));
    let mut out = Vec::new();

    if find_in_path("tmux").is_some() {
        let fmt = "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}";
        if let Some(s) = run("tmux", &["list-panes", "-a", "-F", fmt]) {
            for l in s.lines() {
                let f: Vec<&str> = l.split('\t').collect();
                if f.len() >= 5 && inside(f[2], &root) {
                    out.push(AgentSession {
                        id: format!("tmux:{}", f[0]),
                        label: format!("tmux {}", f[1]),
                        cwd: f[2].into(),
                        command: f[3].into(),
                        is_agent: looks_like_agent(f[3], f[4]),
                    });
                }
            }
        }
    }

    if find_in_path("wezterm").is_some() {
        if let Some(s) = run("wezterm", &["cli", "list", "--format", "json"]) {
            if let Ok(serde_json::Value::Array(panes)) =
                serde_json::from_str::<serde_json::Value>(&s)
            {
                for p in panes {
                    let cwd = p["cwd"]
                        .as_str()
                        .unwrap_or("")
                        .trim_start_matches("file://");
                    // file://host/path -> /path
                    let cwd = cwd.find('/').map(|i| &cwd[i..]).unwrap_or(cwd);
                    if inside(cwd, &root) {
                        let title = p["title"].as_str().unwrap_or("");
                        out.push(AgentSession {
                            id: format!("wezterm:{}", p["pane_id"]),
                            label: format!("WezTerm pane {}", p["pane_id"]),
                            cwd: cwd.into(),
                            command: title.into(),
                            is_agent: looks_like_agent(title, title),
                        });
                    }
                }
            }
        }
    }

    if find_in_path("kitten").is_some() {
        if let Some(s) = run("kitten", &["@", "ls"]) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                for os_win in v.as_array().into_iter().flatten() {
                    for tab in os_win["tabs"].as_array().into_iter().flatten() {
                        for w in tab["windows"].as_array().into_iter().flatten() {
                            let cwd = w["cwd"].as_str().unwrap_or("");
                            if inside(cwd, &root) {
                                let cmdline = w["foreground_processes"][0]["cmdline"]
                                    .as_array()
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|x| x.as_str())
                                            .collect::<Vec<_>>()
                                            .join(" ")
                                    })
                                    .unwrap_or_default();
                                let title = w["title"].as_str().unwrap_or("");
                                out.push(AgentSession {
                                    id: format!("kitty:{}", w["id"]),
                                    label: format!("kitty window {}", w["id"]),
                                    cwd: cwd.into(),
                                    is_agent: looks_like_agent(&cmdline, title),
                                    command: cmdline,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    out.sort_by_key(|s| !s.is_agent);
    out
}

fn pipe(bin: &str, args: &[&str], input: &str) -> Result<(), String> {
    let mut child = command(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run {bin}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

pub fn inject(id: &str, text: &str, submit: bool) -> Result<(), String> {
    let (kind, target) = id.split_once(':').ok_or("invalid session id")?;
    let pause = || std::thread::sleep(std::time::Duration::from_millis(180));
    match kind {
        "tmux" => {
            pipe("tmux", &["load-buffer", "-b", "codewart", "-"], text)?;
            run(
                "tmux",
                &["paste-buffer", "-d", "-p", "-b", "codewart", "-t", target],
            )
            .ok_or("tmux paste-buffer failed")?;
            if submit {
                pause();
                run("tmux", &["send-keys", "-t", target, "Enter"])
                    .ok_or("tmux send-keys failed")?;
            }
        }
        "wezterm" => {
            pipe("wezterm", &["cli", "send-text", "--pane-id", target], text)?;
            if submit {
                pause();
                pipe(
                    "wezterm",
                    &["cli", "send-text", "--pane-id", target, "--no-paste"],
                    "\r",
                )?;
            }
        }
        "kitty" => {
            let m = format!("id:{target}");
            pipe(
                "kitten",
                &[
                    "@",
                    "send-text",
                    "--match",
                    &m,
                    "--bracketed-paste=enable",
                    "--stdin",
                ],
                text,
            )?;
            if submit {
                pause();
                pipe(
                    "kitten",
                    &["@", "send-text", "--match", &m, "--stdin"],
                    "\r",
                )?;
            }
        }
        _ => return Err(format!("unsupported session type {kind}")),
    }
    Ok(())
}
