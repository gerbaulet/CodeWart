//! Install the `wart` command-line launcher from inside the app, pointing at
//! wherever this copy of Codewart lives. Works for any install location, so a
//! downloaded build gets `wart .` without the source repo.

use crate::actions::find_in_path;
use serde::Serialize;
use std::path::{Path, PathBuf};

const NAMES: &[&str] = &["wart", "codewart"];
const MARKER: &str = "Codewart launcher";

#[cfg(unix)]
const TEMPLATE: &str = include_str!("../../scripts/wart");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// `wart` on PATH is one of our launchers.
    pub installed: bool,
    /// Where it is (or would be) installed.
    pub path: String,
    /// The install directory is on PATH.
    pub on_path: bool,
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

fn ours(p: &Path) -> bool {
    std::fs::read_to_string(p)
        .map(|s| s.contains(MARKER))
        .unwrap_or(false)
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(".codewart-write-test");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// Preferred install directory: a user bin dir already on PATH, else a
/// writable system one, else ~/.local/bin (and tell the user to add it).
#[allow(unused_variables)]
fn install_dir() -> PathBuf {
    let on_path = path_dirs();
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let apps = PathBuf::from(local).join("Microsoft").join("WindowsApps");
            if apps.is_dir() {
                return apps;
            }
        }
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        return home.join("bin");
    }
    #[cfg(unix)]
    {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let candidates = [
            home.join(".local/bin"),
            home.join("bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
        ];
        for c in &candidates {
            if on_path.contains(c) && c.is_dir() && writable(c) {
                return c.clone();
            }
        }
        home.join(".local/bin")
    }
}

fn file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.cmd")
    } else {
        name.to_string()
    }
}

pub fn status() -> CliStatus {
    let dir = install_dir();
    let found = find_in_path(&file_name("wart")).or_else(|| find_in_path("wart"));
    let installed = found.as_deref().is_some_and(ours);
    CliStatus {
        installed,
        path: found
            .filter(|_| installed)
            .unwrap_or_else(|| dir.join(file_name("wart")))
            .to_string_lossy()
            .into_owned(),
        on_path: path_dirs().contains(&dir),
    }
}

fn script(exe: &Path) -> String {
    #[cfg(unix)]
    {
        let line = format!("CODEWART_BIN=\"${{CODEWART_BIN:-{}}}\"", exe.display());
        TEMPLATE.replace("# @CODEWART_BIN@", &line)
    }
    #[cfg(windows)]
    {
        format!(
            "@echo off\r\nrem {MARKER} (wart .)\r\nset \"CODEWART_CWD=%CD%\"\r\nif \"%~1\"==\"\" (start \"\" \"{exe}\" \"%CD%\") else (start \"\" \"{exe}\" %*)\r\n",
            exe = exe.display()
        )
    }
}

pub fn install() -> Result<CliStatus, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let dir = install_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let body = script(&exe);
    for name in NAMES {
        let target = dir.join(file_name(name));
        if target.exists() && !ours(&target) {
            if *name == "wart" {
                return Err(format!(
                    "{} already exists and is not a Codewart launcher",
                    target.display()
                ));
            }
            continue; // leave someone else's `codewart` alone
        }
        std::fs::write(&target, &body)
            .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    let mut st = status();
    st.installed = true;
    st.path = dir.join(file_name("wart")).to_string_lossy().into_owned();
    Ok(st)
}

#[cfg(all(test, unix))]
pub fn script_for_test(exe: &Path) -> String {
    script(exe)
}
