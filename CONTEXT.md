# Garden Party Pastels — Domain Context

Wedding photo scavenger hunt: guests complete tasks by submitting photos, earn points and badges, and the couple's Task Master steers the game and moderates the result.

## Language

**Guest**:
A wedding attendee who plays the game. Signs in via a per-guest link (`token`) at `/j/:token`; identified in code by `req.guest` and the `guests` table.
_Avoid_: Player, user.

**Task**:
A scavenger-hunt item a guest completes by submitting a photo. Stored in the `tasks` table; `is_active` controls guest visibility, `sort_order` controls display order.
_Avoid_: Challenge, quest.

**Submission**:
The photo a guest turns in for a task. `UNIQUE(guest_id, task_id)` means submitting again for the same task replaces the prior submission rather than creating a duplicate. "Photo" is the informal name guests see; `submission` is the code's real entity.
_Avoid_: Photo (informal only), entry.

**Taken down / restore**:
The moderation state on a submission. A taken-down submission is hidden from the gallery and scoring but the file is kept and still included in the export. `restore` reverses it.
_Avoid_: Deleted, removed (those apply to the separate hard-delete action).

**Badge**:
An award shown on a guest's profile. `type` is `auto` (BLOOM/BOUQUET/GARDEN, granted automatically at 5/10/15 completed tasks — thresholds owned by `src/services/scoring.js`) or `special` (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE, granted by the Task Master). `awarded_by` records `system` or `admin`.

**Points**:
A guest's score. Derived, not stored: completed-submission count plus `bonus_points`. `src/services/scoring.js` is the single authority on this calculation; `admin.js` and `db.js` contain shadow duplicates of the completed-count piece that must not diverge from it.
_Avoid_: Score (in code comments; `points` is the term used consistently elsewhere).

**Likes / Comments / Per-photo points**:
Three community features, all shipped and live. A guest reacts to a submission via `POST /p/:submissionId/like`; guest-to-guest text runs through `POST /p/:submissionId/comments` — both defined in `src/routes/community.js`, backed by the `likes` and `comments` tables in `src/db.js`. And per-photo points is the Task Master setting a submission's `photo_bonus` directly (an absolute set, not additive — distinct from a guest's overall `bonus_points`), via the admin route in `src/routes/admin.js`.

**Leaderboard**:
The public ranking of guests by points, at `/leaderboard` (`scoring.leaderboard()`).

**Gallery**:
The public shared wall of all live (non-taken-down) submissions, at `/gallery`.

**Task Master**:
The product name for the admin role. The code calls this role `admin` throughout (the `admin` cookie, `requireAdmin` middleware, the `/admin` routes) — `Task Master` and `admin` are the same role; use `Task Master` in anything guest- or host-facing, `admin` when referring to code.
_Avoid_: Host, organizer (as code terms — fine as casual English, but the code and product name is `Task Master`/`admin`).

**Token / gsid / admin session / onboard**:
`token` is the secret in a guest's private sign-in link, consumed once at `/j/:token`. `gsid` is the resulting guest session cookie. `admin` (session cookie) is the separate Task Master session, unrelated to a guest's `gsid`. `onboard`/`onboarded` is the guest's first-time setup (name + avatar) that runs on first sign-in.

**Export / keepsake**:
The one-click ZIP the Task Master generates after the event — `garden-party-export-<date>.zip`, containing per-guest photos plus a `summary.xlsx` (`streamExportZip` in `src/services/export.js`). "Keepsake" is the product word for this artifact.

## Seams worth knowing

- **Three audiences**: Guest (`requireGuest`), Task Master (`requireAdmin`, under `/admin`), and Public (`community.js`, `attachGuest` — no login required for gallery/leaderboard).
- **Scoring authority**: `src/services/scoring.js` is canonical for points and badge thresholds. `admin.js` and `db.js` each carry a shadow duplicate of the completed-submission count — a change to scoring logic must be mirrored there or verified not to matter.
- **Submission lifecycle**: live → taken-down → hard-deleted. Taken-down is reversible and export-safe; hard-delete is not.

## Vision terms — not built yet

Named in `docs/north-star.md` (and drafted in `data/wip-issues/0050`–`0055`) but with no schema or route in the code today. Do not treat these as implemented when reading source:

- **Prize** — a physical/tangible reward tied to standings, displayed to guests.
- **Slideshow** — an end-of-event playback of favorited submissions.
- **Favorites** (host-curated) — a Task Master pick distinct from a guest's own submissions.

## Conventions for the design skills

- Decisions and ADRs for this repo are recorded in `DESIGN.md` under `## Key decisions`. This repo does NOT use a `docs/adr/` directory — do not create one.
- Installed design skills (`improve-codebase-architecture`, `codebase-design`, `grilling`, `domain-modeling`) live under `.agents/skills/`. `.claude/skills/` is a generated, gitignored symlink mirror of the same skills — read from `.agents/skills/`, not `.claude/skills/`.
