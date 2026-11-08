//! Heuristic call graph of the functions touched by a diff.
//!
//! This is deliberately language-agnostic and dependency-free: sources are
//! "masked" (string and comment contents blanked out), function definitions are
//! found with per-language patterns, bodies are delimited by brace matching (or
//! indentation for Python/Ruby), and call sites are `name(` tokens resolved
//! against the functions we know about. It is not a compiler, but it is fast,
//! works on any revision and handles the common languages agents write.

use crate::diff::{self, DiffOptions, FileDiff, Selection};
use crate::git::{self, git};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Rust,
    Js,
    Python,
    Go,
    Ruby,
    /// Java, C#, Kotlin, Swift, C, C++, PHP, Scala, Dart …
    CLike,
}

pub fn lang_of(path: &str) -> Option<Lang> {
    let e = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match e.as_str() {
        "rs" => Lang::Rust,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" => Lang::Js,
        "py" | "pyi" => Lang::Python,
        "go" => Lang::Go,
        "rb" => Lang::Ruby,
        "java" | "kt" | "kts" | "swift" | "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" | "hh"
        | "cs" | "php" | "scala" | "dart" | "groovy" | "m" | "mm" => Lang::CLike,
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct FnDef {
    pub name: String,
    pub container: Option<String>,
    /// 1-based inclusive line range.
    pub start: usize,
    pub end: usize,
    pub signature: String,
}

impl FnDef {
    fn key(&self) -> (Option<String>, String) {
        (self.container.clone(), self.name.clone())
    }
    fn contains(&self, line: usize) -> bool {
        line >= self.start && line <= self.end
    }
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/// Blank out the contents of comments and string literals, preserving byte
/// offsets and newlines so line/column positions stay valid.
pub fn mask(src: &str, lang: Lang) -> String {
    let b = src.as_bytes();
    let mut out = b.to_vec();
    let n = b.len();
    let mut i = 0;
    let hash_comments = matches!(lang, Lang::Python | Lang::Ruby);
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for c in out.iter_mut().take(to.min(n)).skip(from) {
            if *c != b'\n' {
                *c = b' ';
            }
        }
    };
    while i < n {
        let c = b[i];
        let next = if i + 1 < n { b[i + 1] } else { 0 };
        if hash_comments && c == b'#' || !hash_comments && c == b'/' && next == b'/' {
            let end = b[i..]
                .iter()
                .position(|&x| x == b'\n')
                .map(|p| i + p)
                .unwrap_or(n);
            blank(&mut out, i, end);
            i = end;
        } else if !hash_comments && c == b'/' && next == b'*' {
            let end = find(b, i + 2, b"*/").map(|p| p + 2).unwrap_or(n);
            blank(&mut out, i, end);
            i = end;
        } else if lang == Lang::Python
            && (b[i..].starts_with(b"\"\"\"") || b[i..].starts_with(b"'''"))
        {
            let q = &b[i..i + 3];
            let end = find(b, i + 3, q).map(|p| p + 3).unwrap_or(n);
            blank(&mut out, i + 3, end.saturating_sub(3).max(i + 3));
            i = end;
        } else if c == b'"'
            || c == b'`'
            || (c == b'\'' && lang != Lang::Rust)
            || (c == b'\'' && is_rust_char(b, i))
        {
            let mut j = i + 1;
            while j < n && b[j] != c {
                if b[j] == b'\\' {
                    j += 1;
                } else if b[j] == b'\n' && c != b'`' && !(lang == Lang::Rust && c == b'"') {
                    break; // unterminated single-line string
                }
                j += 1;
            }
            blank(&mut out, i + 1, j);
            i = j + 1;
        } else {
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| src.to_string())
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// In Rust `'a` is usually a lifetime; only treat `'x'` / `'\n'` as char literals.
fn is_rust_char(b: &[u8], i: usize) -> bool {
    let rest = &b[i + 1..];
    if rest.first() == Some(&b'\\') {
        return true;
    }
    // A (possibly multi-byte) char followed by a closing quote.
    let len = match rest.first() {
        Some(c) if *c < 0x80 => 1,
        Some(c) if *c >= 0xF0 => 4,
        Some(c) if *c >= 0xE0 => 3,
        Some(_) => 2,
        None => return false,
    };
    rest.get(len) == Some(&b'\'')
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(
    RUST_FN,
    r"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:\x22[^\x22]*\x22\s+)?)?fn\s+([A-Za-z_]\w*)"
);
re!(
    RUST_CONTAINER,
    r"^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?(?:impl\b(?:\s*<[^{]*?>)?\s+(?:[^{]*?\bfor\s+)?([A-Za-z_][\w:]*)|trait\s+([A-Za-z_]\w*)|mod\s+([A-Za-z_]\w*)\s*\{)"
);
re!(
    JS_FN,
    r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)"
);
re!(
    JS_ARROW,
    r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\b\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>|(?:React\.)?(?:useCallback|memo|forwardRef)\s*\()"
);
re!(
    JS_METHOD,
    r"^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\("
);
re!(
    JS_CLASS,
    r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\{"
);
re!(PY_DEF, r"^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)");
re!(PY_CLASS, r"^(\s*)class\s+([A-Za-z_]\w*)");
re!(RB_DEF, r"^(\s*)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)");
re!(RB_CLASS, r"^(\s*)(?:class|module)\s+([A-Za-z_][\w:]*)");
re!(
    GO_FN,
    r"^func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)[^)]*\)\s*)?([A-Za-z_]\w*)"
);
re!(
    KW_FN,
    r"\b(?:fun|func|def|function)\s+(?:<[^>]*>\s*)?&?(?:[A-Za-z_][\w.]*\.)?([A-Za-z_]\w*)\s*[(<]"
);
re!(
    C_FN,
    r"^\s*(?:[\w<>\[\],.*&:~?@]+\s+)+[*&]*([A-Za-z_~][\w]*(?:::[A-Za-z_~]\w*)*)\s*\("
);
re!(
    C_CONTAINER,
    r"\b(?:class|struct|interface|enum|object|record|extension|protocol|trait|namespace)\s+([A-Za-z_]\w*)"
);
re!(
    CALL,
    r"([A-Za-z_$][\w$]*)\s*(?:::<[^>]*>)?(?:<[\w\s,<>\[\]]*>)?\s*\("
);

const KEYWORDS: &[&str] = &[
    "if",
    "else",
    "for",
    "while",
    "switch",
    "match",
    "return",
    "catch",
    "function",
    "fn",
    "func",
    "def",
    "new",
    "throw",
    "typeof",
    "sizeof",
    "await",
    "yield",
    "case",
    "do",
    "try",
    "with",
    "elif",
    "loop",
    "in",
    "of",
    "delete",
    "void",
    "assert",
    "super",
    "this",
    "self",
    "Some",
    "Ok",
    "Err",
    "None",
    "print",
    "println",
    "constructor",
    "lambda",
    "using",
    "lock",
    "foreach",
    "when",
    "guard",
    "defer",
    "go",
    "select",
    "unless",
    "until",
    "begin",
    "rescue",
    "elsif",
    "and",
    "or",
    "not",
    "is",
    "as",
    "where",
    "impl",
    "struct",
    "enum",
    "macro_rules",
    "vec",
    "format",
    "panic",
    "todo",
    "unimplemented",
    "unreachable",
    "require",
    "import",
    "export",
    "from",
    "extends",
    "implements",
    "synchronized",
    "static",
    "public",
    "private",
    "protected",
];

/// Common method names that would create noise when grepping the whole repo.
const NOISY: &[&str] = &[
    "get",
    "set",
    "new",
    "map",
    "len",
    "from",
    "into",
    "clone",
    "default",
    "fmt",
    "push",
    "pop",
    "then",
    "next",
    "init",
    "run",
    "main",
    "call",
    "apply",
    "bind",
    "find",
    "filter",
    "reduce",
    "keys",
    "values",
    "has",
    "add",
    "remove",
    "update",
    "create",
    "render",
    "to_string",
    "toString",
    "equals",
    "hash",
    "parse",
    "load",
    "save",
    "close",
    "open",
    "read",
    "write",
    "send",
    "start",
    "stop",
    "test",
    "log",
    "error",
    "info",
    "debug",
    "warn",
    "handle",
    "process",
    "build",
    "value",
    "data",
    "join",
    "split",
    "trim",
    "replace",
];

pub fn extract(src: &str, lang: Lang) -> Vec<FnDef> {
    let masked = mask(src, lang);
    let mlines: Vec<&str> = masked.lines().collect();
    let olines: Vec<&str> = src.lines().collect();
    match lang {
        Lang::Python => extract_indent(&mlines, &olines, &PY_DEF, &PY_CLASS, false),
        Lang::Ruby => extract_indent(&mlines, &olines, &RB_DEF, &RB_CLASS, true),
        _ => extract_braces(&mlines, &olines, lang),
    }
}

fn signature(olines: &[&str], start: usize) -> String {
    let mut sig = String::new();
    for l in olines.iter().skip(start).take(6) {
        let t = l.trim();
        sig.push_str(t);
        if t.contains('{') || t.ends_with(':') || t.contains("=>") {
            break;
        }
        sig.push(' ');
    }
    let sig = sig.trim().trim_end_matches('{').trim();
    sig.chars().take(220).collect()
}

/// Depth of `{` at the start of each line.
fn brace_depths(mlines: &[&str]) -> Vec<i32> {
    let mut depths = Vec::with_capacity(mlines.len() + 1);
    let mut d = 0i32;
    for l in mlines {
        depths.push(d);
        for c in l.bytes() {
            match c {
                b'{' => d += 1,
                b'}' => d -= 1,
                _ => {}
            }
        }
    }
    depths.push(d);
    depths
}

enum Body {
    /// Line of the closing brace, 0-based.
    Block(usize),
    /// Single expression body ending on this 0-based line.
    Expr(usize),
}

/// From (line, col), find the function body. Skips parentheses (parameter
/// lists may contain `{` for destructuring) and gives up on `;` (declaration).
fn find_body(mlines: &[&str], line: usize, col: usize, lang: Lang) -> Option<Body> {
    let mut paren = 0i32;
    let mut angle_ok = true;
    let mut saw_arrow = false;
    for (li, l) in mlines.iter().enumerate().skip(line).take(12) {
        let bytes = l.as_bytes();
        let from = if li == line { col.min(bytes.len()) } else { 0 };
        let mut k = from;
        while k < bytes.len() {
            let c = bytes[k];
            match c {
                b'(' | b'[' => paren += 1,
                b')' | b']' => paren -= 1,
                b'{' if paren <= 0 => return close_brace(mlines, li, k).map(Body::Block),
                b';' if paren <= 0 => {
                    return if saw_arrow {
                        Some(Body::Expr(li))
                    } else {
                        None
                    };
                }
                b'=' if paren <= 0 && bytes.get(k + 1) == Some(&b'>') => {
                    saw_arrow = true;
                    // Expression-bodied arrow: `=> expr`
                    let rest = l[k + 2..].trim_start();
                    if !rest.is_empty() && !rest.starts_with('{') {
                        return Some(Body::Expr(expr_end(mlines, li)));
                    }
                    k += 1;
                }
                b'=' if paren <= 0 && matches!(lang, Lang::CLike | Lang::Rust) && angle_ok => {
                    // Kotlin/Scala `fun x() = expr`
                    if lang == Lang::CLike && bytes.get(k + 1) != Some(&b'=') {
                        return Some(Body::Expr(expr_end(mlines, li)));
                    }
                    angle_ok = false;
                }
                _ => {}
            }
            k += 1;
        }
    }
    None
}

fn expr_end(mlines: &[&str], line: usize) -> usize {
    let mut paren = 0i32;
    for (li, l) in mlines.iter().enumerate().skip(line).take(40) {
        for c in l.bytes() {
            match c {
                b'(' | b'[' | b'{' => paren += 1,
                b')' | b']' | b'}' => paren -= 1,
                _ => {}
            }
        }
        let t = l.trim_end();
        if paren <= 0 && (t.ends_with(';') || t.ends_with(',') || li + 1 == mlines.len()) {
            return li;
        }
        if paren < 0 {
            return li;
        }
    }
    line
}

fn close_brace(mlines: &[&str], line: usize, col: usize) -> Option<usize> {
    let mut depth = 0i32;
    for (li, l) in mlines.iter().enumerate().skip(line) {
        let bytes = l.as_bytes();
        let from = if li == line { col } else { 0 };
        for &c in &bytes[from.min(bytes.len())..] {
            match c {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(li);
                    }
                }
                _ => {}
            }
        }
    }
    Some(mlines.len().saturating_sub(1))
}

struct Container {
    name: String,
    start: usize,
    end: usize,
    inner_depth: i32,
}

fn extract_braces(mlines: &[&str], olines: &[&str], lang: Lang) -> Vec<FnDef> {
    let depths = brace_depths(mlines);
    // Containers (impl/class/struct …) first.
    let mut containers: Vec<Container> = Vec::new();
    for (i, l) in mlines.iter().enumerate() {
        let caps = match lang {
            Lang::Rust => RUST_CONTAINER.captures(l),
            Lang::Js => JS_CLASS.captures(l),
            Lang::CLike => C_CONTAINER.captures(l),
            _ => None,
        };
        let Some(c) = caps else { continue };
        let Some(name) = (1..c.len()).find_map(|g| c.get(g)) else {
            continue;
        };
        let m_end = name.end();
        // Find the opening brace on this or the next few lines.
        let mut found = None;
        'scan: for (li, ll) in mlines.iter().enumerate().skip(i).take(6) {
            let from = if li == i { m_end } else { 0 };
            for (k, ch) in ll.bytes().enumerate().skip(from) {
                if ch == b'{' {
                    found = Some((li, k));
                    break 'scan;
                }
                if ch == b';' {
                    break 'scan;
                }
            }
        }
        if let Some((li, k)) = found {
            let end = close_brace(mlines, li, k).unwrap_or(li);
            let base = depths[li] + mlines[li][..k].bytes().filter(|&b| b == b'{').count() as i32
                - mlines[li][..k].bytes().filter(|&b| b == b'}').count() as i32;
            containers.push(Container {
                name: name
                    .as_str()
                    .rsplit("::")
                    .next()
                    .unwrap_or(name.as_str())
                    .to_string(),
                start: li,
                end,
                inner_depth: base + 1,
            });
        }
    }
    let container_at = |line: usize| -> Option<&Container> {
        containers
            .iter()
            .filter(|c| c.start <= line && line <= c.end && c.start != line)
            .min_by_key(|c| c.end - c.start)
    };

    let mut defs = Vec::new();
    for (i, l) in mlines.iter().enumerate() {
        let (name, col, container_override) = match lang {
            Lang::Rust => match RUST_FN.captures(l) {
                Some(c) => (c[1].to_string(), c.get(0).unwrap().end(), None),
                None => continue,
            },
            Lang::Go => match GO_FN.captures(l) {
                Some(c) => (
                    c[2].to_string(),
                    c.get(0).unwrap().end(),
                    c.get(1).map(|m| m.as_str().to_string()),
                ),
                None => continue,
            },
            Lang::Js => {
                if let Some(c) = JS_FN.captures(l) {
                    (c[1].to_string(), c.get(0).unwrap().end(), None)
                } else if let Some(c) = JS_ARROW.captures(l) {
                    // `const x = (` is only a function if an arrow follows.
                    let m = c.get(0).unwrap();
                    let eq = m.as_str().find('=').unwrap_or(0);
                    let rhs = &m.as_str()[eq..];
                    if rhs.ends_with('(')
                        && !rhs.contains("useCallback")
                        && !rhs.contains("memo")
                        && !rhs.contains("forwardRef")
                    {
                        let window: String = mlines
                            .iter()
                            .skip(i)
                            .take(8)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join("\n");
                        let arrow = window.find("=>");
                        let semi = window.find(';');
                        if arrow.is_none() || matches!((arrow, semi), (Some(a), Some(s)) if s < a) {
                            continue;
                        }
                    }
                    (c[1].to_string(), m.start() + eq + 1, None)
                } else if let Some(c) = JS_METHOD.captures(l) {
                    // Only a method if directly inside a class body.
                    let name = c[1].to_string();
                    let inside = container_at(i).is_some_and(|ct| ct.inner_depth == depths[i]);
                    if !inside || KEYWORDS.contains(&name.as_str()) && name != "constructor" {
                        continue;
                    }
                    (name, c.get(0).unwrap().end() - 1, None)
                } else {
                    continue;
                }
            }
            Lang::CLike => {
                if let Some(c) = KW_FN.captures(l) {
                    (c[1].to_string(), c.get(0).unwrap().end() - 1, None)
                } else if let Some(c) = C_FN.captures(l) {
                    let name = c[1].to_string();
                    let first = l.split_whitespace().next().unwrap_or("");
                    if KEYWORDS.contains(&name.as_str())
                        || matches!(
                            first,
                            "return"
                                | "else"
                                | "new"
                                | "throw"
                                | "case"
                                | "goto"
                                | "delete"
                                | "await"
                                | "yield"
                        )
                    {
                        continue;
                    }
                    let (container, short) = match name.rsplit_once("::") {
                        Some((a, b)) => (
                            Some(a.rsplit("::").next().unwrap_or(a).to_string()),
                            b.to_string(),
                        ),
                        None => (None, name),
                    };
                    (short, c.get(0).unwrap().end() - 1, container)
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        if KEYWORDS.contains(&name.as_str()) && name != "constructor" {
            continue;
        }
        let Some(body) = find_body(mlines, i, col, lang) else {
            continue;
        };
        let end = match body {
            Body::Block(end) => end,
            Body::Expr(end) => end,
        };
        let container = container_override.or_else(|| container_at(i).map(|c| c.name.clone()));
        defs.push(FnDef {
            name,
            container,
            start: i + 1,
            end: end + 1,
            signature: signature(olines, i),
        });
    }
    defs
}

fn indent_of(l: &str) -> usize {
    l.chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

fn extract_indent(
    mlines: &[&str],
    olines: &[&str],
    def: &Regex,
    class: &Regex,
    ruby: bool,
) -> Vec<FnDef> {
    // Block end = last line before the next non-blank line indented <= start.
    let block_end = |i: usize, ind: usize| -> usize {
        let mut end = i;
        for (j, l) in mlines.iter().enumerate().skip(i + 1) {
            if l.trim().is_empty() {
                continue;
            }
            let li = indent_of(l);
            if li <= ind {
                if ruby && li == ind && l.trim() == "end" {
                    return j;
                }
                if !ruby && l.trim_start().starts_with(')') {
                    end = j;
                    continue;
                }
                return end;
            }
            end = j;
        }
        end
    };
    let mut classes: Vec<(String, usize, usize)> = Vec::new();
    for (i, l) in mlines.iter().enumerate() {
        if let Some(c) = class.captures(l) {
            let ind = indent_of(&c[1]);
            classes.push((
                c[2].rsplit("::").next().unwrap_or(&c[2]).to_string(),
                i,
                block_end(i, ind),
            ));
        }
    }
    let mut defs = Vec::new();
    for (i, l) in mlines.iter().enumerate() {
        let Some(c) = def.captures(l) else { continue };
        let ind = indent_of(&c[1]);
        let end = block_end(i, ind);
        let container = classes
            .iter()
            .filter(|(_, s, e)| *s < i && i <= *e)
            .min_by_key(|(_, s, e)| e - s)
            .map(|(n, _, _)| n.clone());
        defs.push(FnDef {
            name: c[2].to_string(),
            container,
            start: i + 1,
            end: end + 1,
            signature: signature(olines, i),
        });
    }
    defs
}

/// Innermost function containing a 1-based line.
fn innermost(defs: &[FnDef], line: usize) -> Option<usize> {
    defs.iter()
        .enumerate()
        .filter(|(_, d)| d.contains(line))
        .min_by_key(|(_, d)| d.end - d.start)
        .map(|(i, _)| i)
}

/// Names called from a range of lines (1-based, inclusive), with the lines.
fn calls_in(
    masked_lines: &[&str],
    start: usize,
    end: usize,
    skip_first: bool,
) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    for ln in start..=end.min(masked_lines.len()) {
        let l = masked_lines[ln - 1];
        let text = if skip_first && ln == start {
            // Skip the definition's own name on its first line.
            match l.find('(') {
                Some(p) => &l[p..],
                None => continue,
            }
        } else {
            l
        };
        for c in CALL.captures_iter(text) {
            let m = c.get(1).unwrap();
            // Ignore definitions like `fn foo(` / `function foo(` / `def foo(`.
            let before = text[..m.start()].trim_end();
            if before.ends_with("fn")
                || before.ends_with("function")
                || before.ends_with("def")
                || before.ends_with("func")
            {
                continue;
            }
            let name = m.as_str();
            if !KEYWORDS.contains(&name) {
                out.push((name.to_string(), ln));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    #[default]
    Changed,
    Neighbours,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SnippetLine {
    pub kind: &'static str,
    pub text: String,
    pub line: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub name: String,
    pub container: Option<String>,
    pub file: String,
    pub line: usize,
    pub end_line: usize,
    /// "added" | "modified" | "deleted" | "moved" | "context"
    pub status: String,
    pub moved_from: Option<String>,
    pub additions: u32,
    pub deletions: u32,
    pub signature: String,
    pub snippet: Vec<SnippetLine>,
    /// The whole function: current code with this selection's changes
    /// interleaved (deleted lines in place, added lines marked).
    pub body: Vec<diff::Line>,
    pub is_test: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub from: String,
    pub to: String,
    /// The call site is on an added line.
    pub is_new: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CallGraph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// Changed files we could not analyse (unsupported language).
    pub skipped_files: Vec<String>,
}

struct Analysed {
    path: String,
    defs: Vec<FnDef>,
    masked: String,
    text: String,
    /// Index into the diff's files, when this file changed.
    diff: Option<usize>,
    added: HashSet<usize>,
}

const MAX_BODY_LINES: usize = 600;

/// Lines `start..=end` (1-based) of the new file, with the diff's deleted
/// lines interleaved where they were removed and added lines marked.
fn function_body(
    file: Option<&FileDiff>,
    lines: &[&str],
    start: usize,
    end: usize,
) -> Vec<diff::Line> {
    let mut added: HashSet<u32> = HashSet::new();
    let mut old_of: HashMap<u32, u32> = HashMap::new();
    let mut dels_before: HashMap<u32, Vec<diff::Line>> = HashMap::new();
    // (end of hunk on the new side, old-minus-new offset after it)
    let mut offsets: Vec<(u32, i64)> = Vec::new();
    if let Some(f) = file {
        for h in &f.hunks {
            let mut pending: Vec<diff::Line> = Vec::new();
            let mut next_new = h.new_start.max(1);
            for l in &h.lines {
                match l.kind {
                    "del" => pending.push(l.clone()),
                    _ => {
                        let n = l.new.unwrap_or(0);
                        if !pending.is_empty() {
                            dels_before.entry(n).or_default().append(&mut pending);
                        }
                        if l.kind == "add" {
                            added.insert(n);
                        } else if let Some(o) = l.old {
                            old_of.insert(n, o);
                        }
                        next_new = n + 1;
                    }
                }
            }
            if !pending.is_empty() {
                dels_before
                    .entry(next_new)
                    .or_default()
                    .append(&mut pending);
            }
            let new_end = h.new_start + h.new_lines;
            let old_end = h.old_start + h.old_lines;
            offsets.push((new_end, old_end as i64 - new_end as i64));
        }
    }
    let old_number = |n: u32| -> Option<u32> {
        if let Some(o) = old_of.get(&n) {
            return Some(*o);
        }
        if file.is_some_and(|f| f.status == "added") {
            return None;
        }
        let off = offsets
            .iter()
            .rev()
            .find(|(e, _)| *e <= n)
            .map(|(_, o)| *o)
            .unwrap_or(0);
        u32::try_from(n as i64 + off).ok()
    };
    let mut out = Vec::new();
    for n in start..=end.min(lines.len()) {
        let n32 = n as u32;
        if let Some(dels) = dels_before.get(&n32) {
            out.extend(dels.iter().cloned());
        }
        let text = lines[n - 1].to_string();
        out.push(if added.contains(&n32) {
            diff::Line {
                kind: "add",
                old: None,
                new: Some(n32),
                text,
            }
        } else {
            diff::Line {
                kind: "ctx",
                old: old_number(n32),
                new: Some(n32),
                text,
            }
        });
        if out.len() >= MAX_BODY_LINES {
            break;
        }
    }
    out
}

/// A deleted function: all of its old lines as deletions.
fn deleted_body(old_lines: &[&str], start: usize, end: usize) -> Vec<diff::Line> {
    (start..=end.min(old_lines.len()))
        .take(MAX_BODY_LINES)
        .map(|n| diff::Line {
            kind: "del",
            old: Some(n as u32),
            new: None,
            text: old_lines[n - 1].to_string(),
        })
        .collect()
}

fn node_id(path: &str, d: &FnDef) -> String {
    format!(
        "{}::{}::{}:{}",
        path,
        d.container.as_deref().unwrap_or(""),
        d.name,
        d.start
    )
}

/// Snippet lines plus (additions, deletions).
type Snippet = (Vec<SnippetLine>, u32, u32);

fn snippet_for(
    file: &FileDiff,
    new_range: Option<(usize, usize)>,
    old_range: Option<(usize, usize)>,
) -> Snippet {
    let in_new = |n: Option<u32>| matches!((n, new_range), (Some(n), Some((s, e))) if (n as usize) >= s && (n as usize) <= e);
    let in_old = |n: Option<u32>| matches!((n, old_range), (Some(n), Some((s, e))) if (n as usize) >= s && (n as usize) <= e);
    let mut lines = Vec::new();
    let (mut adds, mut dels) = (0, 0);
    for h in &file.hunks {
        for l in &h.lines {
            let keep = match l.kind {
                "add" => in_new(l.new),
                "del" => in_old(l.old),
                _ => in_new(l.new),
            };
            if !keep {
                continue;
            }
            if l.kind == "add" {
                adds += 1;
            } else if l.kind == "del" {
                dels += 1;
            }
            lines.push(SnippetLine {
                kind: l.kind,
                text: l.text.clone(),
                line: l.new.or(l.old),
            });
        }
    }
    // Keep a compact window around the first change.
    let first = lines.iter().position(|l| l.kind != "ctx").unwrap_or(0);
    let from = first.saturating_sub(1);
    let window: Vec<SnippetLine> = lines.into_iter().skip(from).take(10).collect();
    (window, adds, dels)
}

pub fn build(dir: &Path, sel: &Selection, scope: Scope) -> Result<CallGraph, String> {
    // Whitespace-only edits never make a function "changed".
    let d = diff::load(
        dir,
        sel,
        &DiffOptions {
            ignore_whitespace: true,
            context: None,
        },
    )?;
    let new_rev = d.new_rev.clone();
    let old_rev = d.old_rev.clone();
    let diff_files = &d.files;

    let mut skipped = Vec::new();
    let mut new_files: Vec<Analysed> = Vec::new();
    let mut nodes: Vec<Node> = Vec::new();
    let mut node_index: HashMap<String, usize> = HashMap::new();
    let mut deleted_candidates: Vec<(String, FnDef, Snippet, Vec<diff::Line>)> = Vec::new();
    let mut added_candidates: Vec<(usize, String)> = Vec::new(); // (node idx, body)

    // Old-side bodies of every changed file, for "moved" detection.
    let mut old_bodies: HashMap<String, Vec<(String, String)>> = HashMap::new(); // name -> [(path, body)]

    for (fidx, f) in d.files.iter().enumerate() {
        if f.binary
            || f.tags
                .iter()
                .any(|t| matches!(t.as_str(), "lockfile" | "asset" | "generated"))
        {
            continue;
        }
        let Some(lang) = lang_of(&f.path) else {
            // Only count files that could plausibly hold code.
            if f.status != "deleted" && f.tags.is_empty() {
                skipped.push(f.path.clone());
            }
            continue;
        };
        let old_path = f.old_path.clone().unwrap_or_else(|| f.path.clone());
        let old_src = if f.status == "added" {
            None
        } else {
            git::read_at(dir, Some(&old_rev), &old_path)
        };
        let new_src = if f.status == "deleted" {
            None
        } else {
            git::read_at(dir, new_rev.as_deref(), &f.path)
        };
        let old_defs = old_src
            .as_deref()
            .map(|s| extract(s, lang))
            .unwrap_or_default();
        let new_defs = new_src
            .as_deref()
            .map(|s| extract(s, lang))
            .unwrap_or_default();
        let old_lines: Vec<&str> = old_src
            .as_deref()
            .map(|s| s.lines().collect())
            .unwrap_or_default();
        let new_lines: Vec<&str> = new_src
            .as_deref()
            .map(|s| s.lines().collect())
            .unwrap_or_default();
        let body = |lines: &[&str], d: &FnDef| {
            lines
                .get(d.start - 1..d.end.min(lines.len()))
                .map(|s| s.join("\n"))
                .unwrap_or_default()
        };

        let mut added: HashSet<usize> = HashSet::new();
        let mut deleted: HashSet<usize> = HashSet::new();
        for h in &f.hunks {
            for l in &h.lines {
                match l.kind {
                    "add" => {
                        added.insert(l.new.unwrap_or(0) as usize);
                    }
                    "del" => {
                        deleted.insert(l.old.unwrap_or(0) as usize);
                    }
                    _ => {}
                }
            }
        }
        // Attribute each changed line to its innermost function only.
        let mut touched_new: BTreeSet<usize> = BTreeSet::new();
        for &ln in &added {
            if let Some(i) = innermost(&new_defs, ln) {
                touched_new.insert(i);
            }
        }
        let mut touched_old_keys: HashSet<(Option<String>, String)> = HashSet::new();
        for &ln in &deleted {
            if let Some(i) = innermost(&old_defs, ln) {
                touched_old_keys.insert(old_defs[i].key());
            }
        }
        let old_by_key: HashMap<_, &FnDef> = old_defs.iter().map(|d| (d.key(), d)).collect();
        let new_keys: HashSet<_> = new_defs.iter().map(|d| d.key()).collect();
        for od in &old_defs {
            old_bodies
                .entry(od.name.clone())
                .or_default()
                .push((old_path.clone(), body(&old_lines, od)));
        }

        let is_test = crate::classify::is_test(&f.path);
        for (i, nd) in new_defs.iter().enumerate() {
            let old = old_by_key.get(&nd.key());
            let status = if old.is_none() {
                "added"
            } else if touched_new.contains(&i) || touched_old_keys.contains(&nd.key()) {
                "modified"
            } else {
                continue;
            };
            let old_range = old.map(|o| (o.start, o.end));
            let (snippet, adds, dels) = snippet_for(f, Some((nd.start, nd.end)), old_range);
            let id = node_id(&f.path, nd);
            node_index.insert(id.clone(), nodes.len());
            if status == "added" {
                added_candidates.push((nodes.len(), body(&new_lines, nd)));
            }
            nodes.push(Node {
                id,
                name: nd.name.clone(),
                container: nd.container.clone(),
                file: f.path.clone(),
                line: nd.start,
                end_line: nd.end,
                status: status.into(),
                moved_from: None,
                additions: adds,
                deletions: dels,
                signature: nd.signature.clone(),
                snippet,
                body: function_body(Some(f), &new_lines, nd.start, nd.end),
                is_test,
            });
        }
        for od in &old_defs {
            if !new_keys.contains(&od.key()) {
                let snip = snippet_for(f, None, Some((od.start, od.end)));
                let body = deleted_body(&old_lines, od.start, od.end);
                deleted_candidates.push((old_path.clone(), od.clone(), snip, body));
            }
        }
        new_files.push(Analysed {
            path: f.path.clone(),
            masked: new_src
                .as_deref()
                .map(|s| mask(s, lang))
                .unwrap_or_default(),
            text: new_src.clone().unwrap_or_default(),
            diff: Some(fidx),
            defs: new_defs,
            added,
        });
    }

    // Moved functions: "added" here but an old body of the same name existed in
    // another changed file. Deleted counterparts are dropped.
    let mut moved_names: HashSet<String> = HashSet::new();
    for (idx, new_body) in &added_candidates {
        let n = &mut nodes[*idx];
        if let Some(olds) = old_bodies.get(&n.name) {
            if let Some((from, old_body)) = olds.iter().find(|(p, _)| *p != n.file) {
                n.moved_from = Some(from.clone());
                n.status = if normalize_ws(old_body) == normalize_ws(new_body) {
                    "moved".into()
                } else {
                    "modified".into()
                };
                moved_names.insert(n.name.clone());
            }
        }
    }
    for (path, od, (snippet, adds, dels), body) in deleted_candidates {
        if moved_names.contains(&od.name) {
            continue;
        }
        let id = format!("deleted::{}", node_id(&path, &od));
        node_index.insert(id.clone(), nodes.len());
        nodes.push(Node {
            id,
            name: od.name.clone(),
            container: od.container.clone(),
            file: path.clone(),
            line: od.start,
            end_line: od.end,
            status: "deleted".into(),
            moved_from: None,
            additions: adds,
            deletions: dels,
            signature: od.signature.clone(),
            snippet,
            body,
            is_test: crate::classify::is_test(&path),
        });
    }

    // Neighbour files: callers of changed functions anywhere in the repo.
    if scope == Scope::Neighbours {
        let changed_names: BTreeSet<String> = nodes
            .iter()
            .filter(|n| {
                n.status != "deleted" && n.name.len() >= 3 && !NOISY.contains(&n.name.as_str())
            })
            .map(|n| n.name.clone())
            .collect();
        let known: HashSet<String> = new_files.iter().map(|f| f.path.clone()).collect();
        for path in grep_callers(dir, new_rev.as_deref(), &changed_names) {
            if known.contains(&path) {
                continue;
            }
            let Some(lang) = lang_of(&path) else { continue };
            let Some(src) = git::read_at(dir, new_rev.as_deref(), &path) else {
                continue;
            };
            new_files.push(Analysed {
                path,
                defs: extract(&src, lang),
                masked: mask(&src, lang),
                text: src,
                diff: None,
                added: HashSet::new(),
            });
        }
    }

    // Symbol table over every analysed (new-side) function.
    let mut symbols: HashMap<String, Vec<(usize, usize)>> = HashMap::new(); // name -> (file idx, def idx)
    for (fi, af) in new_files.iter().enumerate() {
        for (di, d) in af.defs.iter().enumerate() {
            symbols.entry(d.name.clone()).or_default().push((fi, di));
        }
    }

    let mut edges: Vec<Edge> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();
    let mut context_nodes: Vec<Node> = Vec::new();
    let mut context_index: HashMap<String, usize> = HashMap::new();

    for (fi, af) in new_files.iter().enumerate() {
        let mlines: Vec<&str> = af.masked.lines().collect();
        for (di, d) in af.defs.iter().enumerate() {
            let from_id = node_id(&af.path, d);
            let from_changed = node_index.contains_key(&from_id);
            // Only the function's own lines, not nested functions' bodies.
            let nested: Vec<&FnDef> = af
                .defs
                .iter()
                .filter(|o| o.start > d.start && o.end <= d.end)
                .collect();
            for (name, ln) in calls_in(&mlines, d.start, d.end, true) {
                if nested.iter().any(|o| o.contains(ln)) {
                    continue;
                }
                let Some(cands) = symbols.get(&name) else {
                    continue;
                };
                // Prefer same file, then same container, else accept up to 3 matches.
                let same_file: Vec<_> = cands.iter().filter(|(cf, _)| *cf == fi).collect();
                let targets: Vec<&(usize, usize)> = if !same_file.is_empty() {
                    same_file
                } else if cands.len() <= 3 {
                    cands.iter().collect()
                } else {
                    continue;
                };
                for &&(tf, td) in &targets {
                    if tf == fi && td == di {
                        continue;
                    }
                    let tdef = &new_files[tf].defs[td];
                    let to_id = node_id(&new_files[tf].path, tdef);
                    let to_changed = node_index.contains_key(&to_id);
                    if !from_changed && !to_changed {
                        continue;
                    }
                    if scope == Scope::Changed && !(from_changed && to_changed) {
                        continue;
                    }
                    if !seen_edges.insert((from_id.clone(), to_id.clone())) {
                        continue;
                    }
                    for (id, owner, def, changed) in [
                        (&from_id, af, d, from_changed),
                        (&to_id, &new_files[tf], tdef, to_changed),
                    ] {
                        let file = &owner.path;
                        if !changed && !context_index.contains_key(id) {
                            let lines: Vec<&str> = owner.text.lines().collect();
                            let fd = owner.diff.map(|i| &diff_files[i]);
                            context_index.insert(id.clone(), context_nodes.len());
                            context_nodes.push(Node {
                                id: id.clone(),
                                name: def.name.clone(),
                                container: def.container.clone(),
                                file: file.clone(),
                                line: def.start,
                                end_line: def.end,
                                status: "context".into(),
                                moved_from: None,
                                additions: 0,
                                deletions: 0,
                                signature: def.signature.clone(),
                                snippet: vec![],
                                body: function_body(fd, &lines, def.start, def.end),
                                is_test: crate::classify::is_test(file),
                            });
                        }
                    }
                    edges.push(Edge {
                        from: from_id.clone(),
                        to: to_id,
                        is_new: af.added.contains(&ln),
                    });
                }
            }
        }
    }
    nodes.extend(context_nodes);
    Ok(CallGraph {
        nodes,
        edges,
        skipped_files: skipped,
    })
}

fn normalize_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Files (other than the changed ones) that call any of `names`.
fn grep_callers(dir: &Path, rev: Option<&str>, names: &BTreeSet<String>) -> Vec<String> {
    if names.is_empty() {
        return vec![];
    }
    let alternation = names
        .iter()
        .take(60)
        .map(|n| regex::escape(n))
        .collect::<Vec<_>>()
        .join("|");
    let pattern = format!(r"(^|[^A-Za-z0-9_$])({alternation})[[:space:]]*\(");
    let mut args = vec!["grep", "-l", "-I", "-E", &pattern];
    if let Some(r) = rev {
        args.push(r);
    }
    let out = git(dir, &args).unwrap_or_default();
    let mut files: Vec<String> = out
        .lines()
        .map(|l| match rev {
            Some(r) => l.strip_prefix(&format!("{r}:")).unwrap_or(l).to_string(),
            None => l.to_string(),
        })
        .filter(|p| {
            lang_of(p).is_some()
                && crate::classify::path_tags(p)
                    .iter()
                    .all(|t| *t != "generated")
        })
        .collect();
    files.truncate(40);
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(defs: &[FnDef]) -> Vec<String> {
        defs.iter()
            .map(|d| match &d.container {
                Some(c) => format!("{c}.{}@{}-{}", d.name, d.start, d.end),
                None => format!("{}@{}-{}", d.name, d.start, d.end),
            })
            .collect()
    }

    #[test]
    fn rust_functions_and_impls() {
        let src = r#"
pub fn top(a: &str) -> String {
    let s = "fn fake() {";
    helper(a)
}

impl<'a> Thing<'a> {
    pub async fn method(&self) {
        if x { y() }
    }
}

fn helper(a: &str) -> String { a.to_string() }
"#;
        assert_eq!(
            names(&extract(src, Lang::Rust)),
            vec!["top@2-5", "Thing.method@8-10", "helper@13-13"]
        );
    }

    #[test]
    fn ts_functions_arrows_and_methods() {
        let src = r#"export async function refreshSession(ctx: Ctx) {
  const t = await rotateToken(ctx);
}
export const isExpiringSoon = (t: Token, ms: number) => t.exp - now() < ms;
const handler = ({ a, b }: Props) => {
  return a;
};
const clock = {
  now(): number { return Date.now(); },
};
class Store {
  private cache = new Map();
  async get(key: string): Promise<string> {
    if (this.cache.has(key)) { return this.cache.get(key); }
  }
}
const config = (loadConfig());
"#;
        assert_eq!(
            names(&extract(src, Lang::Js)),
            vec![
                "refreshSession@1-3",
                "isExpiringSoon@4-4",
                "handler@5-7",
                "clock.now@9-9",
                "Store.get@13-15"
            ]
        );
    }

    #[test]
    fn python_and_go() {
        let py = "class A:\n    def m(self):\n        return f(1)\n\n    def n(self):\n        pass\n\ndef f(x):\n    return x\n";
        assert_eq!(
            names(&extract(py, Lang::Python)),
            vec!["A.m@2-3", "A.n@5-6", "f@8-9"]
        );
        let go = "package x\n\nfunc (s *Server) Handle(w http.ResponseWriter) {\n\tallow(\"k\")\n}\n\nfunc allow(key string) bool {\n\treturn true\n}\n";
        assert_eq!(
            names(&extract(go, Lang::Go)),
            vec!["Server.Handle@3-5", "allow@7-9"]
        );
    }

    #[test]
    fn calls_skip_definition_name_and_keywords() {
        let m = mask("fn a() {\n    if b(1) { c() }\n}\n", Lang::Rust);
        let lines: Vec<&str> = m.lines().collect();
        let calls: Vec<String> = calls_in(&lines, 1, 3, true)
            .into_iter()
            .map(|c| c.0)
            .collect();
        assert_eq!(calls, vec!["b", "c"]);
    }

    #[test]
    fn rust_lifetimes_do_not_start_strings() {
        let src = "fn a<'x>(v: &'x str) -> char { 'q' }\nfn b() {}\n";
        assert_eq!(names(&extract(src, Lang::Rust)), vec!["a@1-1", "b@2-2"]);
    }
}
