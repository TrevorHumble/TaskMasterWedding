# Build Log

Reverse-chronological record of notable changes to the repo.

## Entry conventions

Three entry types, appended in reverse-chronological order:

- `<sha> — #<n> — <summary>` — a committed issue; counted toward the periodic audit threshold.
- `[AUDIT] <sha> — <summary>` — full-system architectural audit, run on every 5th counted entry; excluded from the count.
- `[HALT] #<n> — <reason>` — segment halted at the impasse stop condition; the work is not committed.

The run-time Live-log ledger (per-increment `[HH:MM] elapsed=…` lines) lives in `docs/RESUME-STATE.md`.

## 2026-06-30

- #58 — triage the 34 pre-existing high-severity CodeQL alerts: all non-exploitable at this app's threat model. path-injection + DOM-XSS = false positives (multer generates random filenames so the client's name never reaches an fs sink — now proven by `tests/upload-filename-safety.test.js`; `javascript:` on an `<img>.src` does not execute); missing-rate-limiting = dismiss-with-justification (admin-login lockout is DoS-safe, other routes auth-gated or cheap reads, a limiter adds a Cloudflare proxy-trust footgun). Reasoning recorded in `docs/security/codeql-triage-2026-06.md`; 3 independent security reviewers confirmed no dismissal masks a live vuln. Alerts dismissed in code scanning post-merge.
- #59 — regression-guard the destructive-action confirmations: new `tests/destructive-confirm.test.js` renders the admin guests/photos/tasks pages as admin and asserts each destructive form (guest delete, photo takedown, task delete), isolated by its delete/takedown action route, carries `data-confirm=` and `method="post"` — so a future template edit (e.g. #40) can't silently drop a confirmation.
- #61 — Dependabot integration: two-tier merge policy (`auto` on green CI / `review` held) via a testable classifier `tools/classify-dep-pr.ps1` (single source of truth for the wedding-critical dep list, drift-guarded against `CLAUDE.md` and `.github/dependabot.yml`); grouped `dependabot.yml` with wedding-critical deps excluded so held items arrive as individual PRs; policy documented in `CLAUDE.md`/`orchestrator.md`. Exit authorized by the severity adjudicator (remaining defects inconsequential). Triage of the 14 open PRs follows per AC8.
- #62 — issue-lifecycle review marker: issues are born `needs-issue-review`; the label is cleared only by a recorded issue-review PASS via the separate reader-gated `tools/clear-issue-marker.ps1` (evidence writer stays board-free, so separation-of-writers holds); adds board-wide `tools/audit-issue-markers.ps1`; born-marked creation + narrowed bookkeeping carve-out documented in the pipeline.

## 2026-06-28

Repo initialized from the as-built Garden Party Pastels app; an adversarial review and refactor are underway.
