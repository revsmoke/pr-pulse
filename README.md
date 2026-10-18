# pr-pulse

A Claude Code mod: a live pane of the current repo's open pull requests, from
opened to merged and branch-deleted.

For each PR it shows, refreshed on a timer and right after Claude runs
`git push` or `gh pr`:

- merge readiness (mergeable, blocked, behind, conflicts) and the review decision
- the branch rules that gate the merge (required checks, approvals, thread
  resolution, no force-push) and whether each one is satisfied now
- every check grouped by the app that runs it, with required ones marked
- reviewers, human and bot (CodeRabbit, Cursor Bugbot, Codex, Copilot, Claude
  Code, Gemini, ...), with their latest verdict
- review threads: resolved/open bar, each open thread's severity, file, who
  opened it, whether it got a reply, and how many commits landed since
- commits newest first, each with the agent that co-authored it and how many
  review threads it addressed
- the agents and models working on the PR, read from `Co-Authored-By`
  trailers and bot logins
- recently merged or closed PRs and whether their branch was deleted

It also keeps a **review-bot ledger** in SQLite (`~/.claude/pr-pulse/reviews.db`
by default): every bot finding with its severity, response time, whether the
code moved after it, and whether another bot raised the same thing. `/prs stats`
answers "is this bot earning its keep?" per bot: findings, used vs dismissed,
median time from push to comment, unique vs duplicated findings, and the
overlap between each pair of bots as judged by a cheap model call.

## Commands

| Command | Does |
| --- | --- |
| `/prs` | open the pane (all open PRs) |
| `/prs 262` | drill into PR #262 |
| `/prs back` | back to the list |
| `/prs refresh` | fetch now |
| `/prs close` | close the pane |
| `/prs repo owner/name` | watch another repository |
| `/prs stats [days\|all] [all-repos]` | per-bot usefulness and overlap report, also drawn in the pane |
| `/prs backfill [N]` | sweep the last N merged or closed PRs (default 30) into the ledger, in the background |
| `/prs judge [N]` | settle up to N unjudged "same finding?" pairs with the model |
| `/prs db` | print the ledger's path |

In the pane: digits `1`–`9` open a PR, `b` goes back, `r` refreshes, `s` shows
the stats view, `j` judges pending pairs.

## How the ledger scores a finding

- **findings**: inline review threads plus PR-level bot comments that report
  something (a "no issues found" or a walkthrough is recorded but not counted).
  That is how the Claude Code review action and summary-style bots are seen.
- **used**: the thread was resolved and the code moved under it: GitHub marked
  the diff outdated, the first commit after the comment has a hunk reaching the
  flagged line (with three lines of slack), or the reply says fixed/done/applied.
- **code-verified**: used with code evidence (outdated diff or hunk on the
  line), as opposed to a reply alone.
- **dismissed**: resolved with a reply like won't fix, false positive, by
  design, and no change on the line.
- **unknown**: resolved with no evidence either way (including a commit that
  touched the file but not the line).
- **open**: still unresolved.
- **response**: seconds from the commit the comment is anchored on (or the PR
  opening) to the comment.
- **duplicated**: another bot's finding on the same PR that the model judged
  to report the same issue. Candidates are co-located (same file within 8
  lines) or similar (enough words in common anywhere in the PR, PR-level
  comments included); each is settled by one low-effort Haiku call.
- **first / repeat**: among duplicated findings, how many this bot raised
  before the other bot, and how many it repeated after another bot had already
  said it. A bot that is mostly "repeat" adds little on top of the others.

The ledger is written whenever the pane loads a PR's detail, when the poller
sees an open PR change, when a PR settles, and by `/prs backfill`. Query it
with `sqlite3 ~/.claude/pr-pulse/reviews.db` (tables `prs`, `commits`,
`threads`, `thread_pairs`).

## Settings

`/config` lists the mod's fields: poll interval (seconds), open the pane
automatically when the repo has open PRs, pin a status line under the prompt,
toasts on changes (a failed check, new review threads, an approval, a merge).

## Requirements

- `gh` on PATH and signed in (`gh auth status`)
- `sqlite3` on PATH (ships with macOS) for the ledger; without it the pane
  still works and ledger writes are skipped
- Claude Code 2.1.302 or later (tested with 2.1.302)

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install pr-pulse --marketplace revsmoke/pr-pulse
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session). From a shell: `claude plugin install pr-pulse --marketplace revsmoke/pr-pulse`.
In the desktop app, click + next to the prompt box, then Plugins, Add
marketplace with `revsmoke/pr-pulse`, then Add plugin.

To run it from a checkout instead: `claude --plugin-dir /path/to/pr-pulse`, or
set `CLAUDE_CODE_PLUGIN_DIRS` to that path in the `env` block of
`~/.claude/settings.json`.

## Develop

```
claude plugin validate .
claude plugin test .
```
