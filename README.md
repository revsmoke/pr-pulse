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

## Commands

| Command | Does |
| --- | --- |
| `/prs` | open the pane (all open PRs) |
| `/prs 262` | drill into PR #262 |
| `/prs back` | back to the list |
| `/prs refresh` | fetch now |
| `/prs close` | close the pane |
| `/prs repo owner/name` | watch another repository |

In the pane: digits `1`–`9` open a PR, `b` goes back, `r` refreshes.

## Settings

`/config` lists the mod's fields: poll interval (seconds), open the pane
automatically when the repo has open PRs, pin a status line under the prompt,
toasts on changes (a failed check, new review threads, an approval, a merge).

## Requirements

- `gh` on PATH and signed in (`gh auth status`)
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
