//! Pull request lookup via the GitHub CLI (`gh`). Optional: without `gh`, or
//! when it isn't logged in or the remote isn't on GitHub, there is simply no PR.

use crate::git::command;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN, CLOSED or MERGED.
    pub state: String,
    pub is_draft: bool,
    /// APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty.
    #[serde(default)]
    pub review_decision: Option<String>,
}

/// The PR whose head is `branch`: an open one if there is one, else the most recent.
pub fn for_branch(dir: &Path, branch: &str) -> Option<PullRequest> {
    let out = command("gh")
        .current_dir(dir)
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--limit",
            "10",
            "--json",
            "number,title,url,state,isDraft,reviewDecision",
        ])
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    pick(serde_json::from_slice(&out.stdout).ok()?)
}

/// `gh pr list` returns newest first.
fn pick(prs: Vec<PullRequest>) -> Option<PullRequest> {
    let open = prs.iter().position(|p| p.state == "OPEN");
    open.map(|i| prs[i].clone())
        .or_else(|| prs.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64, state: &str) -> PullRequest {
        PullRequest {
            number,
            title: String::new(),
            url: String::new(),
            state: state.into(),
            is_draft: false,
            review_decision: None,
        }
    }

    #[test]
    fn prefers_open_then_newest() {
        assert_eq!(
            pick(vec![pr(9, "MERGED"), pr(7, "OPEN")]).unwrap().number,
            7
        );
        assert_eq!(
            pick(vec![pr(9, "CLOSED"), pr(3, "MERGED")]).unwrap().number,
            9
        );
        assert!(pick(vec![]).is_none());
    }

    #[test]
    fn parses_gh_json() {
        let json = r#"[{"number":12,"title":"Add x","url":"https://github.com/o/r/pull/12","state":"OPEN","isDraft":true,"reviewDecision":""}]"#;
        let prs: Vec<PullRequest> = serde_json::from_str(json).unwrap();
        assert!(prs[0].is_draft);
        assert_eq!(prs[0].review_decision.as_deref(), Some(""));
    }
}
