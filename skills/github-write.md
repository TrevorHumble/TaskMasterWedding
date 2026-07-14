---
name: github-write
description: >-
  How to create/update GitHub issues and commit changes in this project using git
  and the GitHub CLI (ship flow: branch, then pull request, then merge on green CI —
  see agents/orchestrator.md). Triggers: "create an issue", "commit this", "push to
  GitHub", "open a PR", "close the issue", any task that writes to git or GitHub
  for this project.
---

# github-write

## Critical: gh path

`gh` is NOT on PATH. Always use the full path:

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" <subcommand>
```

The remote is this project's own GitHub repo (set when you created it from the template). `gh` commands default to it — you rarely need `--repo`.

## GitHub is the single source of truth — keep issues in sync

Every issue file `data/wip-issues/<N>-slug.md` has a matching GitHub issue, and **the GitHub issue owns the
status** (open/closed/labels). The file is the detail; the board is the state. The pipeline keeps them
equal — see DESIGN.md "Source of truth". The sync rule:

- **On issue creation** → `gh issue create` (title `#NNNN <short title>`, label by tier: `ready` /
  `backlog` / `low priority`). The issue body can summarize and link the file.
- **On merge to `main` (via pull request)** → `gh issue close` the matching card, referencing the commit.
- **On graduation/supersession** → update the card (re-label, or close with a pointer to the successor).
- Never leave the board disagreeing with the issue files / BUILDLOG; `agents/reviewer-tracker-sync.md`
  FAILs a commit that does.

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" issue create `
  --title "#NNNN Short title" `
  --label "ready" `
  --body @'
Tracks data/wip-issues/<N>-slug.md (canonical detail in the repo).

## Summary
...
'@
```

## Committing

```powershell
git add <specific files>   # never git add -A blindly
git commit -m @'
Short imperative summary

Co-Authored-By: <committing model> <noreply@anthropic.com>
'@
```

Run `git status` before staging to avoid committing `.env` or large binaries.

## Opening a PR

```powershell
git push -u origin <branch>
& "C:\Program Files\GitHub CLI\gh.exe" pr create `
  --title "Short title" `
  --body @'
## Summary
- ...

## Test plan
- [ ] ...
'@
```

## Conventions

- No FINAL / LAST / TRULY_FINAL in branch names or commit messages.
- Prefer specific file staging over `git add .`.
- PowerShell line continuation: backtick `` ` ``, not `\`.
