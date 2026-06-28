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

## System-level change (definition)

A **system-level change** is one that alters the development system itself rather than the wedding app's features: the orchestrator pipeline, the enforcement hooks (`.githooks/`, `tools/`), the standards in `standards/`, or the agent definitions in `agents/`. These changes use the stricter two-independent-reviewer, both-must-PASS bar in `standards/adversarial-review-protocol.md`, because a defect there weakens every future change rather than one feature.
