# Build Log

Reverse-chronological record of notable changes to the repo.

## Entry conventions

Three entry types, appended in reverse-chronological order:

- `<sha> — #<n> — <summary>` — a committed issue; counted toward the periodic audit threshold.
- `[AUDIT] <sha> — <summary>` — full-system architectural audit, run on every 5th counted entry; excluded from the count.
- `[HALT] #<n> — <reason>` — segment halted at the impasse stop condition; the work is not committed.

The run-time Live-log ledger (per-increment `[HH:MM] elapsed=…` lines) lives in `docs/RESUME-STATE.md`.

## 2026-07-01

- #40 — alpha mobile-design pass: `.task-link` gets `min-width:0` so a long title/description can't push a task row past the mobile column (description already truncates; done/todo pill stays pinned); guest-home profile header collapses points + "Edit profile" onto one line with a mid-dot divider; new `src/utils/initials.js` (exposed as `app.locals.initials`) derives two-letter avatar initials ("Ava Fenwick"→"AF", "Cher"→"C", ""→"") and replaces four inline single-letter fallbacks across guest-home/public-profile/leaderboard; `crowdfav.svg` orbiting circles moved inward (radius 46→30). Serves Goals A/B (finished-feeling mobile UI). Visual — left as an open PR for the owner's eye. Reviewed: issue PASS; PR panel (3 Opus) unanimous PASS; design-philosophy PASS.

## 2026-06-30

- #44 — maintenance mode: a `MAINTENANCE` config flag makes guest routes serve an on-brand 503 "We'll be right back" page (reusing the error-page design) with a `Retry-After` header, while `/admin` stays reachable so the host can recover; plus `scripts/serve-resilient.js`, a no-dependency wrapper that relaunches the server on crash with backoff + a crash-loop cap and forwards SIGINT/SIGTERM to the child. Resilience for the live event (Goal A). Behavior decided from the goals (the issue left it open); the page reuses the established design system, not new product direction.
- #71 — make admin-login bcrypt async: `POST /admin/login` now uses `await bcrypt.compare` instead of the synchronous `bcrypt.compareSync`, so a burst of login attempts can't block the single event loop and freeze the app for guests (Goal A). Branch order unchanged, so #49's invariant (a correct password authenticates even during a lockout) is preserved; new `tests/login-lockout-async.test.js` proves it. Surfaced by the #58 security review.
- #58 — triage the 34 pre-existing high-severity CodeQL alerts: all non-exploitable at this app's threat model. path-injection + DOM-XSS = false positives (multer generates random filenames so the client's name never reaches an fs sink — now proven by `tests/upload-filename-safety.test.js`; `javascript:` on an `<img>.src` does not execute); missing-rate-limiting = dismiss-with-justification (admin-login lockout is DoS-safe, other routes auth-gated or cheap reads, a limiter adds a Cloudflare proxy-trust footgun). Reasoning recorded in `docs/security/codeql-triage-2026-06.md`; triaged as non-exploitable; verdicts recorded in docs/security/codeql-triage-2026-06.md and confirmed through adversarial security review before merge. Alerts dismissed in code scanning post-merge.
- #59 — regression-guard the destructive-action confirmations: new `tests/destructive-confirm.test.js` renders the admin guests/photos/tasks pages as admin and asserts each destructive form (guest delete, photo takedown, task delete), isolated by its delete/takedown action route, carries `data-confirm=` and `method="post"` — so a future template edit (e.g. #40) can't silently drop a confirmation.
- #61 — Dependabot integration: two-tier merge policy (`auto` on green CI / `review` held) via a testable classifier `tools/classify-dep-pr.ps1` (single source of truth for the wedding-critical dep list, drift-guarded against `CLAUDE.md` and `.github/dependabot.yml`); grouped `dependabot.yml` with wedding-critical deps excluded so held items arrive as individual PRs; policy documented in `CLAUDE.md`/`orchestrator.md`. Exit authorized by the severity adjudicator (remaining defects inconsequential). Triage of the 14 open PRs follows per AC8.
- #62 — issue-lifecycle review marker: issues are born `needs-issue-review`; the label is cleared only by a recorded issue-review PASS via the separate reader-gated `tools/clear-issue-marker.ps1` (evidence writer stays board-free, so separation-of-writers holds); adds board-wide `tools/audit-issue-markers.ps1`; born-marked creation + narrowed bookkeeping carve-out documented in the pipeline.

## 2026-06-28

Repo initialized from the as-built Garden Party Pastels app; an adversarial review and refactor are underway.
