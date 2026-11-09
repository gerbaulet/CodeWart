---
name: codewart-review
description: Ask the user to review your code changes in Codewart and wait for their feedback, then address it. Use when the user asks you to get their review, "request a review in Codewart", "wait for my review", or to iterate on a task with review rounds; also at the end of a task when the user has asked to review your work before you continue.
---

# Review rounds with Codewart

Codewart is the user's desktop app for reviewing agent-written code. `wart review` opens the current worktree there, shows the user that you are waiting, and blocks until they send a review. It then prints the review to stdout.

## Request a review

1. Finish a coherent piece of work first. Uncommitted changes are fine: Codewart shows them.
2. From the repository or worktree you changed, run (Bash tool, **with `timeout: 600000`**):

   ```sh
   wart review --timeout 570 -m "<2-4 lines: what you changed and what deserves a close look>"
   ```

   The message is shown to the reviewer next to your changes. Keep it short and concrete.

3. Read the exit code:
   - **0**: the review is on stdout. Go to *Handle the review*.
   - **3**: no review yet (the Bash tool can't wait longer than 10 minutes). Run **the exact same command again** right away. Keep going until you get exit 0. Don't end your turn or ask the user while waiting; they are reviewing.
   - **1** or `command not found`: Codewart or its `wart` command isn't installed. Tell the user to install the app and click **Install `wart`** in its top bar, then stop.

## Handle the review

The output is one of:

- **`APPROVED: …`**: nothing to change. Tell the user in one line and continue with the task, or finish.
- **`DISMISSED: …`**: the user doesn't want to review now. Continue without feedback.
- **Review feedback** (markdown): starts with `Review feedback on …`, followed by overall notes and numbered comments. Each comment names a location like `` `src/session.ts:14-18` ``, `` `src/foo.ts:3 (removed line)` ``, `` `refreshSession` in `src/session.ts:12` `` or `` `src/token.ts` (whole file) ``, often with the code it refers to, then the feedback.
  1. Address **every** numbered comment and the overall notes. Line numbers refer to the version the user reviewed, so locate the code by the quoted snippet if lines have moved.
  2. If a comment is unclear or you disagree, say so briefly in your summary instead of guessing.
  3. When done, give a short summary mapping each comment number to what you changed.
  4. If the user asked for review rounds, request the next review the same way. Mention in `-m` which comments you addressed.

Several reviews sent before you picked them up arrive together, separated by `---`. Handle all of them.

`wart agent` prints the full reference (all commands, exit codes and the review format).
