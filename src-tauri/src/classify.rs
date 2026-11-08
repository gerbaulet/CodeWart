//! Decide which files are tests and which do not contribute to code logic.
//!
//! Tags returned for a file:
//! - `test`        test sources, fixtures, snapshots
//! - `lockfile`    package manager lockfiles
//! - `asset`       images, fonts, media, binaries
//! - `generated`   build output, generated code, minified bundles, source maps
//! - `docs`        markdown / text / licences
//! - `config`      dotfiles and editor / formatter config
//! - `rename`      pure rename or copy with no content change
//! - `whitespace`  only whitespace / indentation changed
//! - `comments`    only comments (wording) changed
//!
//! Everything except `test` counts as "non-functional" in the UI.

use crate::diff::FileDiff;

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "npm-shrinkwrap.json",
    "cargo.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "mix.lock",
    "pubspec.lock",
    "podfile.lock",
    "package.resolved",
    "flake.lock",
    "deno.lock",
    "gradle.lockfile",
    "packages.lock.json",
];

const ASSET_EXT: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "icns", "tiff", "psd", "svg",
    "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "flac",
    "pdf", "zip", "gz", "tar", "jar", "wasm", "so", "dylib", "dll", "exe", "bin", "dat", "db",
    "sqlite", "glb", "gltf", "fbx", "obj",
];

const DOC_EXT: &[&str] = &["md", "mdx", "markdown", "txt", "rst", "adoc", "org"];

const CONFIG_FILES: &[&str] = &[
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc",
    ".prettierignore",
    ".eslintignore",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
    ".dockerignore",
    ".gitmodules",
    ".mailmap",
    "rustfmt.toml",
    ".rustfmt.toml",
    "clippy.toml",
    ".clang-format",
    ".python-version",
    "codeowners",
];

fn ext(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(i) if i > 0 => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn is_test(path: &str) -> bool {
    let p = format!("/{}", path.to_ascii_lowercase());
    let name = p.rsplit('/').next().unwrap_or("");
    const DIRS: &[&str] = &[
        "/test/",
        "/tests/",
        "/__tests__/",
        "/__mocks__/",
        "/spec/",
        "/specs/",
        "/e2e/",
        "/cypress/",
        "/playwright/",
        "/fixtures/",
        "/__fixtures__/",
        "/__snapshots__/",
        "/testdata/",
        "/test-utils/",
        "/androidtest/",
        "/uitests/",
    ];
    if DIRS.iter().any(|d| p.contains(d)) {
        return true;
    }
    let stem = name.split('.').next().unwrap_or("");
    name.contains(".test.")
        || name.contains(".spec.")
        || name.contains(".stories.")
        || name.ends_with(".snap")
        || stem.ends_with("_test")
        || stem.ends_with("_spec")
        || stem.starts_with("test_")
        || (stem.ends_with("test")
            && stem.len() > 4
            && matches!(ext(name).as_str(), "java" | "kt" | "cs" | "swift" | "scala"))
        || (stem.ends_with("tests") && matches!(ext(name).as_str(), "java" | "kt" | "cs" | "swift"))
        || name == "conftest.py"
}

pub fn path_tags(path: &str) -> Vec<&'static str> {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let e = ext(&lower);
    let mut tags = Vec::new();
    if is_test(path) {
        tags.push("test");
    }
    if LOCKFILES.contains(&name) {
        tags.push("lockfile");
    } else if ASSET_EXT.contains(&e.as_str()) {
        tags.push("asset");
    } else if is_generated(&lower, name) {
        tags.push("generated");
    } else if DOC_EXT.contains(&e.as_str())
        || name.starts_with("license")
        || name.starts_with("changelog")
    {
        tags.push("docs");
    } else if CONFIG_FILES.contains(&name) {
        tags.push("config");
    }
    tags
}

fn is_generated(lower: &str, name: &str) -> bool {
    let p = format!("/{lower}");
    const DIRS: &[&str] = &[
        "/__generated__/",
        "/generated/",
        "/gen/",
        "/dist/",
        "/build/",
        "/out/",
        "/target/",
        "/vendor/",
        "/node_modules/",
        "/.next/",
        "/coverage/",
    ];
    DIRS.iter().any(|d| p.contains(d))
        || name.contains(".generated.")
        || name.contains(".gen.")
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || name.ends_with(".pb.go")
        || name.ends_with("_pb2.py")
        || name.ends_with(".g.dart")
        || name.ends_with(".freezed.dart")
        || name.ends_with(".designer.cs")
        || name.ends_with(".d.ts") && p.contains("/types/generated")
}

fn comment_prefixes(path: &str) -> &'static [&'static str] {
    match ext(path).as_str() {
        "py" | "rb" | "sh" | "bash" | "zsh" | "fish" | "pl" | "r" | "toml" | "yaml" | "yml"
        | "nix" | "ex" | "exs" | "cmake" | "dockerfile" | "tf" | "conf" | "ini" => &["#"],
        "sql" | "lua" | "hs" | "elm" => &["--"],
        "html" | "xml" | "vue" | "svelte" => &["<!--", "-->", "//", "/*", "*", "*/"],
        "clj" | "cljs" | "lisp" | "el" | "scm" => &[";"],
        "ml" | "mli" => &["(*", "*", "*)"],
        "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "go" | "java" | "kt" | "kts"
        | "swift" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "scala" | "dart" | "php" | "css"
        | "scss" | "less" | "zig" | "proto" | "groovy" | "gradle" => {
            &["//", "/*", "*", "*/", "#[doc", "///", "//!"]
        }
        _ => &[],
    }
}

/// All changed lines are comments (or blank) -> a wording-only change.
fn comment_only(file: &FileDiff) -> bool {
    let prefixes = comment_prefixes(&file.path);
    if prefixes.is_empty() || file.hunks.is_empty() {
        return false;
    }
    let mut any = false;
    for h in &file.hunks {
        for l in &h.lines {
            if l.kind == "ctx" {
                continue;
            }
            let t = l.text.trim();
            if t.is_empty() {
                continue;
            }
            if !prefixes.iter().any(|p| t.starts_with(p)) {
                return false;
            }
            any = true;
        }
    }
    any
}

pub fn tags(file: &FileDiff, whitespace_only: bool) -> Vec<String> {
    let mut tags: Vec<String> = path_tags(&file.path)
        .into_iter()
        .map(String::from)
        .collect();
    if file.binary && !tags.iter().any(|t| t == "asset") {
        tags.push("asset".into());
    }
    if (file.status == "renamed" || file.status == "copied")
        && file.additions == 0
        && file.deletions == 0
    {
        tags.push("rename".into());
    }
    if whitespace_only {
        tags.push("whitespace".into());
    } else if comment_only(file) {
        tags.push("comments".into());
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_tests() {
        for p in [
            "src/auth/session.test.ts",
            "pkg/limiter_test.go",
            "tests/test_api.py",
            "app/src/test/java/FooTest.java",
            "web/__tests__/x.tsx",
            "crates/core/tests/it.rs",
        ] {
            assert!(is_test(p), "{p}");
        }
        for p in [
            "src/testing.rs",
            "src/contest.ts",
            "src/attest.go",
            "lib/latest.py",
        ] {
            assert!(!is_test(p), "{p}");
        }
    }

    #[test]
    fn detects_non_functional() {
        assert_eq!(path_tags("pnpm-lock.yaml"), vec!["lockfile"]);
        assert_eq!(path_tags("src-tauri/Cargo.lock"), vec!["lockfile"]);
        assert_eq!(path_tags("public/logo.svg"), vec!["asset"]);
        assert_eq!(path_tags("src/__generated__/schema.ts"), vec!["generated"]);
        assert_eq!(path_tags("README.md"), vec!["docs"]);
        assert_eq!(path_tags(".gitignore"), vec!["config"]);
        assert!(path_tags("src/main.rs").is_empty());
    }
}
