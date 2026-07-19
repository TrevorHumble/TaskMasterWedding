# Wedding Master — Domain Context

**As the AI agent working in this repo, I need the domain vocabulary defined once, so I use the same words the code and product use.**

Wedding photo task game: guests complete tasks by submitting photos, earn points and badges, and the couple's Wedding Master steers the game and moderates the result.

## Language

**Guest**:
A wedding attendee who plays the game. Signs up at `POST /join` (shared poster QR → name + contact + self-chosen PIN, mints the signed `gsid` session cookie) or re-enters at `POST /login` (same contact + PIN) on any device; identified in code by `req.guest` and the `guests` table. The old private per-guest sign-in link was retired by issue #244 — the old route now redirects to `/join` and sets no cookie.
_Avoid_: Player, user.

**Task**:
A photo task a guest completes by submitting a photo. Stored in the `tasks` table; `is_active` controls guest visibility, `sort_order` controls display order.
_Avoid_: Challenge, quest.

**Submission**:
The photo a guest turns in for a task. `UNIQUE(guest_id, task_id)` means submitting again for the same task replaces the prior submission rather than creating a duplicate. "Photo" is the informal name guests see; `submission` is the code's real entity.
_Avoid_: Photo (informal only), entry.

**Taken down / restore**:
The moderation state on a submission. A taken-down submission is hidden from the gallery and scoring but the file is kept and still included in the export. `restore` reverses it.
_Avoid_: Deleted, removed (those apply to the separate hard-delete action).

**Badge**:
An award shown on a guest's profile. `type` is one of five (`src/db.js`'s `badges.type` CHECK constraint): `auto` (BLOOM/BOUQUET/GARDEN, granted automatically at 5/10/15 completed tasks — thresholds owned by `src/services/scoring.js`), `special` (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE, hand-awarded by the Wedding Master), `metric` (e.g. COMPLETIONIST, computed by the badge engine from a fixed rule), `transferable` (e.g. MOSTPHOTOS/MOSTLIKED — computed from live data and can change hands as the data changes), and `custom` (any further badge the admin creates through the admin UI). `awarded_by` records `system` or `admin`.

**Points**:
A guest's score. Derived, not stored: completed-submission count plus `bonus_points`. `src/services/scoring.js` is the single authority on this calculation; `admin.js` and `db.js` contain shadow duplicates of the completed-count piece that must not diverge from it.
_Avoid_: Score (in code comments; `points` is the term used consistently elsewhere).

**Likes / Comments / Per-photo points**:
Three community features, all shipped and live. A guest reacts to a submission via `POST /p/:submissionId/like`; guest-to-guest text runs through `POST /p/:submissionId/comments` — both defined in `src/routes/community.js`, backed by the `likes` and `comments` tables in `src/db.js`. And per-photo points is the Wedding Master setting a submission's `photo_bonus` directly (an absolute set, not additive — distinct from a guest's overall `bonus_points`), via the admin route in `src/routes/admin.js`.

**Leaderboard**:
The ranking of guests by points, at `/leaderboard` (`scoring.leaderboard()`) — guest-gated (see Seams below), not public.

**Gallery**:
The shared wall of all live (non-taken-down) submissions, at `/gallery` — guest-gated (see Seams below), not public.

**Wedding Master**:
The product name for the admin role. The code calls this role `admin` throughout (the `admin` cookie, `requireAdmin` middleware, the `/admin` routes) — `Wedding Master` and `admin` are the same role; use `Wedding Master` in anything guest- or host-facing, `admin` when referring to code.
_Avoid_: the admin role's pre-#354 two-word brand name (retired at the 2026-07-19 rebrand — see that BUILDLOG entry if you meet it in git history); the current term is `Wedding Master`. Also avoid Host, organizer (as code terms — fine as casual English, but the code and product name is `Wedding Master`/`admin`).

**Contact / PIN / gsid / onboard**:
`contact` (email or phone, normalized by `src/services/identity.js`) plus a self-chosen 4-digit `pin` are what a guest signs up and re-enters with. `gsid` is the resulting signed guest session cookie, minted at `POST /join` or `POST /login`. `onboard`/`onboarded` is retired as a live first-run step (#244) — signup at `POST /join` collects name + avatar in the same request that creates the account, so there is no separate onboarding form; the `onboarded` flag now drives the one-time `/how-to-play` redirect (#564) instead.

**Export / keepsake**:
The one-click ZIP the Wedding Master generates after the event — `weddingmaster-export-<date>.zip`, containing per-guest photos plus a `summary.xlsx` (`streamExportZip` in `src/services/export.js`). "Keepsake" is the product word for this artifact.

## Seams worth knowing

- **Three audiences**: Guest (`requireGuest`), Wedding Master (`requireAdmin`, under `/admin`), and Public (`attachGuest`-only surfaces such as `POST /join`/`POST /login` themselves). Gallery, feed, leaderboard, and the community routes (likes/comments/profiles) are guest-gated (`requireGuest`) — a signed-out visitor is redirected to `/join`, not shown a public view.
- **Scoring authority**: `src/services/scoring.js` is canonical for points and badge thresholds. `admin.js` and `db.js` each carry a shadow duplicate of the completed-submission count — a change to scoring logic must be mirrored there or verified not to matter.
- **Submission lifecycle**: live → taken-down → hard-deleted. Taken-down is reversible and export-safe; hard-delete is not.

## Vision terms — not built yet

Named in `docs/north-star.md` but with no schema or route in the code today. Do not treat these as implemented when reading source:

- **Prize** — a physical/tangible reward tied to standings, displayed to guests.
- **Slideshow** — an end-of-event playback of favorited submissions.
- **Favorites** (host-curated) — a Wedding Master pick distinct from a guest's own submissions.

## Conventions for the design skills

- Decisions and ADRs for this repo are recorded in `DESIGN.md` under `## Key decisions`. This repo does NOT use a `docs/adr/` directory — do not create one.
- Installed design skills (`improve-codebase-architecture`, `codebase-design`, `grilling`, `domain-modeling`) live under `.agents/skills/`. `.claude/skills/` is a generated, gitignored symlink mirror of the same skills — read from `.agents/skills/`, not `.claude/skills/`.
