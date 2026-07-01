# Build Log

Reverse-chronological record of notable changes to the repo.

## Entry conventions

Three entry types, appended in reverse-chronological order:

- `<sha> — #<n> — <summary>` — a committed issue; counted toward the periodic audit threshold.
- `[AUDIT] <sha> — <summary>` — full-system architectural audit, run on every 5th counted entry; excluded from the count.
- `[HALT] #<n> — <reason>` — segment halted at the impasse stop condition; the work is not committed.

The run-time Live-log ledger (per-increment `[HH:MM] elapsed=…` lines) lives in `docs/RESUME-STATE.md`.

## 2026-06-30

- #62 — issue-lifecycle review marker: issues are born `needs-issue-review`; the label is cleared only by a recorded issue-review PASS via the separate reader-gated `tools/clear-issue-marker.ps1` (evidence writer stays board-free, so separation-of-writers holds); adds board-wide `tools/audit-issue-markers.ps1`; born-marked creation + narrowed bookkeeping carve-out documented in the pipeline.

## 2026-06-28

Repo initialized from the as-built Garden Party Pastels app; an adversarial review and refactor are underway.
