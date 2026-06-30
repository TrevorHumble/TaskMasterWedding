# DESIGN.md — Architecture decisions and rationale

Why the app is built the way it is. Decisions and tradeoffs, not getting-started instructions (those are in `README.md`) and not agent rules (those are in `CLAUDE.md`).

**North Star / goals:** confirmed. The product goals live in [`docs/north-star.md`](docs/north-star.md) (one-screen summary in [`CLAUDE.md`](CLAUDE.md)). The decisions recorded below serve those goals — most directly getting any guest in fast and keeping the app standing under the whole guest list at once (Goal A). One goal-driven decision is still **open and unbuilt**: Goal C's contained sharing (scoping content to the right audience). Moderation today is takedown-only (see "Photos: … takedown over delete" below); the audience-split design will be recorded here once chosen. The app must be live for guests by **Friday, Aug 7, 2026**.

## Constraints that shaped the design

- One Windows 11 laptop hosts everything for a single weekend. No cloud servers, no paid services.
- About 100 concurrent guests, all on phones, all over a public Cloudflare quick tunnel.
- The couple and a non-developer admin run it. Setup must be a handful of commands.
- Everything must be exportable after the event and then thrown away.

## Key decisions

### Single SQLite file via better-sqlite3 (synchronous)

One file at `data/app.db`, opened synchronously. No separate database server to install or babysit. better-sqlite3 ships prebuilt binaries for Node 20 on Windows x64. Synchronous calls keep route handlers linear and readable; at ~100 guests the load never justifies async DB plumbing. WAL journal mode and `foreign_keys = ON` are set on every open (`src/db.js`).

Tradeoff: synchronous DB calls block the event loop. Acceptable at this scale; would not be at thousands of concurrent users.

### Server-rendered EJS, vanilla client JS, no build step

Pages render on the server with EJS. The client side is plain JavaScript in `src/public/js/`. No bundler, no framework, no transpile step means nothing to build on the laptop and no toolchain to break the weekend of the event.

### Per-guest token in a signed cookie for guest auth

A guest is identified by a random token. The token travels in the QR link (`/j/:token`), and sign-in stores it in a signed `gsid` cookie. No guest passwords, no account creation. The signature (via `cookie-parser` and `COOKIE_SECRET`) stops cookie forgery; possession of the link is the credential, which fits physical place-cards handed to invited guests.

Tradeoff: anyone with a guest's link can act as that guest. For a private wedding this is the intended convenience.

### Single admin password, bcrypt hash on disk

The admin ("Task Master") authenticates with one password, hashed with bcryptjs into `data/admin.hash` (set by `scripts/set-admin-password.js`). Sign-in sets a signed `admin` cookie. One role, one secret, no user table for the admin side. The hash file is gitignored.

### COOKIE_SECRET must be fixed for the event

If `COOKIE_SECRET` is unset, `config.js` generates a random secret at boot and warns. That invalidates every signed cookie on restart, signing everyone out. For the wedding the secret is fixed in `.env` so restarts do not disrupt guests. The fallback exists only so a fresh clone still boots.

### Photos: multer intake, sharp normalization, takedown over delete

Uploads come in through multer; sharp produces a normalized full-size original plus a small thumbnail (`THUMB_WIDTH = 400`). Originals live in `data/uploads/`, thumbnails in `data/thumbs/`, served at `/uploads` and `/thumbs`. The admin "takes down" a photo by setting `taken_down = 1` rather than deleting the row, so a moderation action is reversible and the submission's history is preserved. A taken-down photo is hidden from the gallery, profiles, and scoring but can be restored.

### Scoring derived, not stored

A guest's score is computed: one point per completed task (a non-taken-down submission) plus `bonus_points` the admin sets by judgment. Completion count drives auto badges. Keeping score derived avoids a denormalized total that can drift out of sync when a photo is taken down or restored.

### Badge thresholds are config, special badges are a fixed set

Auto-badge thresholds (5 / 10 / 15) live once in `config.BADGE_THRESHOLDS` and are read by scoring and the guest routes; there is no second copy. The four special badges (EARLYBIRD, SHUTTERBUG, CROWDFAV, CHOICE) are a fixed catalog: the admin awards them but cannot invent new badge types. Adding one means adding an SVG in `src/public/badges/` and a seed row, then re-seeding. This keeps the admin UI small and matches the spec, which calls for special badges the admin awards, not an admin-managed badge catalog.

### Two UNIQUE constraints enforce the core rules in the schema

- `submissions UNIQUE(guest_id, task_id)` — one submission per guest per task, so a task cannot be completed twice for double points. This defines the duplicate error out of existence at the database layer rather than checking for it in application code.
- `guest_badges UNIQUE(guest_id, badge_id)` — a guest holds each badge at most once, so re-running scoring or re-awarding is idempotent.

### Export as a ZIP + xlsx, then discard

The admin runs one export: archiver streams a ZIP of all photos grouped one folder per guest, plus a `summary.xlsx` (exceljs) of points, badges, and tasks. After the event the photos are uploaded elsewhere and the `data/` directory is discarded. No long-term storage strategy is needed because the app's lifetime is the weekend.

### Cloudflare quick tunnel for public access

A free `cloudflared tunnel --url http://localhost:3000` gives a public HTTPS URL with no account. The URL changes each run; the app does not depend on a stable public hostname.

### Commit gate: review evidence bound to the staged tree

A commit is blocked unless review evidence bound to its exact `git write-tree` says PASS. Two records gate together: `.review_state/verdict.json` (the legacy single-line summary the `pre-commit` hook reads with `sed`) and the per-reviewer evidence files under `.review_state/reviews/<tree>/` (read by `tools/validate-verdict.ps1` through the shared `tools/verdict-core.ps1`). The evidence files are the authoritative per-reviewer record; the summary remains for the cheap shell check. Together they block the literal one-step bypass — a bare recorded PASS with no evidence files no longer authorizes a commit. They do **not** by themselves close the broader hole (see the honest bar below). They are written by **different** tools on purpose: `tools/review_verdict.ps1` records only the summary, and `tools/persist-review.ps1` is the sole writer of evidence — so the script that records a PASS cannot also fabricate the evidence the gate reads. Both records live under the gitignored `.review_state/`, so they never enter the tree they describe.

This is the honest bar: an **evidence-less commit is blocked**, but because the orchestrator can run both `review_verdict.ps1` and `persist-review.ps1` by hand with free-text reviewer ids, it can still self-attest — the self-attestation surface is **relocated, not eliminated**. That residual is made **tamper-evident** by a committed ledger + CI audit (a later slice) and is closed honestly only when the runner feeds real reviewer-agent returns into `persist-review.ps1` (also a later slice). We do not claim cryptographic unforgeability on a machine the orchestrator controls.

### Issue-review gate: every code commit names a reviewed issue (#46)

**Binding decision:** the `commit-msg` hook (`.githooks/commit-msg`) is the enforcement chokepoint. A code commit is blocked unless its message resolves to a GitHub issue number AND that issue has a recorded issue-review PASS under `.review_state/issue-reviews/<N>/`. Issue-number resolution is deterministic: message first (`(#N)` or `Closes/Fixes/Resolves #N`), branch fallback only from an anchored mandatory-prefix regex (`(?i)(?:^|[-/])issue[-/](\d+)(?:$|[-/])`). A branch like `enforce/v4-s1-gate-core` does not resolve — the branch regex requires an explicit `issue[-/]` token and cannot capture bare numerals from version strings. The shared counting kernel (`Reduce-Verdicts` in `tools/verdict-core.ps1`) drives both the PR/tree gate and the issue gate — one function, two call sites, no duplicated logic.

Doc-only commits (`*.md` / `*.markdown` extension) are exempt from the blocking gate; a code file under `docs/` (e.g. `docs/evil.ps1`) is still CODE — folder location does not exempt it. Doc-only commits still need a linked issue for merge, which the advisory `merge-association` CI job checks.

**Honest bar:** a code commit can no longer reach history through the hooks without naming a GitHub issue that has a recorded issue-review PASS — the evidence-less path (draft locally, skip review, implement) is blocked at the `commit-msg` chokepoint, which fails closed and is CI-integrity-checked. There is no `[no-issue]` bypass for code. **Still only tamper-evident:** the issue-review record is written by `tools/persist-issue-review.ps1` by hand, so a determined operator can record a PASS for an unreviewed issue. Authenticity (verdict from a real reviewer-agent return) is the deferred auto-runner slice. The record lands where a future ledger + CI audit can flag it; forgery is made visible, not impossible. Like `pre-commit`, the hook is bypassed by `git commit --no-verify` and inert in a clone where `core.hooksPath` is unset — the CI `commit-gate-integrity` and `merge-association` jobs are the server-side backstop, and the un-bypassable merge version is #48. **Not in this slice:** server-side merge enforcement ships as an advisory CI job; the un-bypassable version is #48. No un-forgeability claim on a machine the operator controls.

## System-level change (definition)

A **system-level change** is one that alters the development system itself rather than the wedding app's features. The gate (`tools/verdict-core.ps1`) treats a staged path as system-level when it is under `.githooks/`, `tools/`, `standards/`, `agents/`, `skills/`, `.github/`, or `.claude/`, or is `docs/north-star.md`, `DESIGN.md`, `CLAUDE.md`, or `AGENTS.md`. `skills/` is included deliberately: the runner's own logic lives there, so editing it must trip the stricter bar. These changes use the stricter two-independent-reviewer, both-must-PASS bar in `standards/adversarial-review-protocol.md`, because a defect there weakens every future change rather than one feature. (This prose and the regex in `tools/verdict-core.ps1` must list the same surface.)
