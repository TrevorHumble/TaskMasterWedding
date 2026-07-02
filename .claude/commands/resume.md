---
description: Re-orient after compaction or a break. Usage: /resume
---

Re-read these files in order — they carry the context you need:

1. `CLAUDE.md` — this repo's operating contract (behavioral rules, model policy, pipeline). Read this first.
2. `agents/orchestrator.md` — the pipeline, model policy, and ship flow for this repo.
3. `docs/RESUME-STATE.md` — where the work is: last commit, backlog priority order, the owner's merge boundary, and gotchas. Do not duplicate it here — read it there.
4. `docs/north-star.md` — the four goals every change must serve.

Optionally, if you have access to the user's global `~/.claude/CLAUDE.md`, read it afterward for personal working-style preferences. It is secondary to the repo's own `CLAUDE.md` and not required for safe operation in this repo.

Then confirm the gates are live:

```powershell
powershell -ExecutionPolicy Bypass -File tools/check-enforcement.ps1
```

This checks the commit gate (wired to `.githooks/pre-commit`), the goal gate, and the loop gate, and tells you in plain English whether each is on or off.

Report back:

- Current branch and last `BUILDLOG.md` entry; also report the last **Live-log ledger line** from the `## Live log` section of `docs/RESUME-STATE.md` (that ledger is the per-increment record of where the autonomous run left off).
- Where the work stands (one sentence from `RESUME-STATE.md`).
- Gate status from `check-enforcement.ps1`.
- The next item in the priority backlog.
