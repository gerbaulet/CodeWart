# Codewart

> Codewart is a desktop app in which a human reviews code written by coding agents: diffs per commit or worktree, a call-chain diagram of changed functions, and line / function / whole-file review comments that go back to the agent. As an agent, use its `wart` command to show your work to the user and to ask for their review and wait for it.

Codewart runs on the user's machine (macOS, Linux, Windows). It never edits code: it only reads git repositories and worktrees. Check that it is available with `command -v wart`. If it's missing, the user installs the app and clicks **Install `wart`** in its top bar.

## Commands

- `wart [PATH...]`: open a repository, any of its worktrees, or a folder of repositories (default: the current directory) in Codewart. If Codewart is running, it opens as a tab there. The command returns immediately. Use it to show the user what you changed.
- `wart review [-m MESSAGE] [--timeout SECS] [PATH]`: ask the user to review the worktree at PATH (default: current directory) and **wait** until they respond. The message is shown to the reviewer next to your changes: say briefly what you changed and what deserves a close look. Uncommitted changes are included.
  - Exit `0`: the response is on stdout (see below).
  - Exit `3`: `--timeout` passed with no response. The request stays open, so run the same command again to keep waiting. Use this when your shell tool has a time limit (e.g. Claude Code's Bash tool: at most 10 minutes, so use `--timeout 570` and re-run on exit 3).
  - Exit `1`: error (not a git repository, Codewart not installed).
- `wart agent`: print this guide.

## Review responses

`wart review` prints exactly one of:

- `APPROVED: …`: no changes requested. Continue or finish.
- `DISMISSED: …`: the user doesn't want to review now. Continue without feedback.
- Review feedback in markdown, starting with `Review feedback on <what was reviewed>:`, then the reviewer's overall notes, then numbered comments. Each comment starts with its location, optionally followed by the code it refers to in a fenced block, and then the feedback:
  - `` `path/to/file.ts:14` `` or `` `path/to/file.ts:14-18` ``: lines in the reviewed version
  - `` `path/to/file.ts:7 (removed line)` ``: a line the change deleted
  - `` `refreshSession` in `src/session.ts:12` ``: a function (from the call-chain view)
  - `` `src/token.ts` (whole file) ``: the file as a whole

Several responses that arrive before you collect them are joined with a line containing `---`.

Handle feedback by addressing every numbered comment and the overall notes. Line numbers refer to the version that was reviewed, so find the code by the quoted snippet if it has moved. Then summarise what you changed per comment number. If the user wants review rounds, request the next review the same way.

## Suggested instructions for AGENTS.md / CLAUDE.md

```markdown
When you finish a task, run `wart review -m "<what changed, what to check>"` and wait for my review
(re-run it if it exits 3). Address every comment it prints, then ask for the next review.
```

Claude Code users can instead install the `codewart-review` skill (`make install-skill` in the Codewart repository).

## More

- Source and docs: https://github.com/ivostrugar/Codewart
- Downloads: https://github.com/ivostrugar/Codewart/releases/latest
