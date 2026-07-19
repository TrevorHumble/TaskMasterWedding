---
description: Re-orient after compaction or a break. Usage: /resume
---

Re-read these files in order — they carry the context you need:

1. `CLAUDE.md` — this repo's operating contract (behavioral rules, model policy, pipeline, and the
   governance freeze). Read this first.
2. `agents/orchestrator.md` — the pipeline, model policy, and ship flow for this repo.
3. `BUILDLOG.md` (tail) and the open issue board (`gh issue list`) — where the work is: last landed
   commit, what's open, and the current merge policy.
4. `docs/live-log.md` — the live per-increment ledger of autonomous runs; read the last line to
   confirm the loop is live.
5. `docs/north-star.md` — the four goals every change must serve.

Optionally, if you have access to the user's global `~/.claude/CLAUDE.md`, read it afterward for personal working-style preferences. It is secondary to the repo's own `CLAUDE.md` and not required for safe operation in this repo.

Then confirm the commit-msg hook is armed:

```powershell
git config --get core.hooksPath
```

This should print `.githooks`. If it does not, run `powershell -ExecutionPolicy Bypass -File tools/setup-hooks.ps1`.

Report back:

- Current branch and the last entry in `BUILDLOG.md` on `main`.
- The last line of `docs/live-log.md` (confirms the loop is live).
- Whether `core.hooksPath` is armed.
- The next item in the priority backlog.
- Whether the governance freeze (`CLAUDE.md` § "Governance freeze", through 2026-08-08) is still in
  effect, and if so, that any work on the governing-artifact surface needs recorded owner approval.
