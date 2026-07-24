# Wedding Master — Domain Context

**As the AI agent working in this repo, I need the domain vocabulary defined once, so I use the same words the code and product use.**

Wedding photo task game: guests complete tasks by submitting photos, earn points and badges, and the couple's Wedding Master steers the game and moderates the result.

## Language

**Guest**:
A wedding attendee who plays the game. Signs up at `POST /join` (shared poster QR → name + contact + self-chosen PIN, mints the signed `gsid` session cookie) or re-enters at `POST /login` (same contact + PIN) on any device; identified in code by `req.guest` and the `guests` table. The old private per-guest sign-in link was retired by issue #244 — the old route now redirects to `/join` and sets no cookie.
_Avoid_: Player, user.

**Task**:
A photo task a guest completes by submitting a photo. Stored in the `tasks` table; `special_mode` (`none` / `hidden` / `oneday`) is the single liveness owner — a task is live for guests whenever it is not `hidden` (`src/services/tasks.js`'s `liveTaskWhere`/`isTaskLive`) — and `worth` (host-chosen, 1-3) is the points a completed task pays. `sort_order` controls display order. A task can also carry one of three special-day variants — see One-day challenge, Flash task, and Lucky task below.
_Avoid_: Challenge, quest, `is_active` (retired by #727 — replaced by `special_mode`).

**Submission**:
The photo a guest turns in for a task. `UNIQUE(guest_id, task_id)` means submitting again for the same task replaces the prior submission rather than creating a duplicate. "Photo" is the informal name guests see; `submission` is the code's real entity.
_Avoid_: Photo (informal only), entry.

**Taken down / restore**:
The moderation state on a submission. A taken-down submission is hidden from the gallery and scoring but the file is kept and still included in the export. `restore` reverses it.
_Avoid_: Deleted, removed (those apply to the separate hard-delete action).

**Badge**:
An award shown on a guest's profile. `type` is one of five (`src/db.js`'s `badges.type` CHECK constraint), all five currently live: `auto` (BLOOM/BOUQUET/GARDEN, granted automatically at 5/10/15 completed tasks — thresholds owned by `src/services/scoring.js`), `special` (EARLYBIRD is the current seeded example, hand-awarded by the Wedding Master via `POST /admin/guests/:id/badge`), `metric` (COMPLETIONIST — computed by `src/services/badges.js`'s `isCompletionist`; revoked the moment even one live, non-challenge task exists that the guest hasn't visibly completed), `transferable` (TOPLIKED, "Crowd Favorite" — every guest currently owning a rank 1-5 crowd-favorite placing; see Crowd favorite / crown below), and `custom` (any further badge the Wedding Master creates through the admin UI, plus the reserved `TASK-<id>` per-task badges `src/services/task-badges.js` manages). `awarded_by` records `system` or `admin`. Retired catalog codes no longer exist on any database: `MOSTPHOTOS`/`MOSTLIKED` (#711, superseded by TOPLIKED) and the give-a-badge collision trio `SHUTTERBUG`/`CROWDFAV`/`CHOICE` (#661, whole picker retired).

**Points**:
A guest's score. Derived, not stored — `src/services/scoring.js`'s `getPoints()` (and its all-guests generalization `leaderboard()`) is the single authority, summing several terms: a completed task's host-chosen `worth` (1-3); its banked special bonus (`submissions.bonus_amount` — the one-day-only/flash/lucky bonus banked at submit time); `guests.bonus_points` (an admin freeform award, still live, pending removal — see `docs/architecture.md`'s Deprecated section, #683); a `submissions.photo_bonus` remnant (a legacy admin per-photo award — the write route is retired, #684, so this only ever reflects a pre-#684 value, never a new one); the profile-photo starter point (+1 while `guests.avatar_path` is set, re-derived on every read); held-badge points (`guest_badges.points` — +1 per auto/metric badge currently held, plus a ranked task-badge award's own amount); the memory-of-the-day bonus (+1 per distinct event-local day with a visible memory); and the crowd-favorite term (a guest's summed placing points from `scoring.crowdFavorites()`). There is no live admin action that sets a photo's points directly.
_Avoid_: Score (in code comments; `points` is the term used consistently elsewhere).

**Likes / Comments**:
Two community features, shipped and live. A guest reacts to a submission via `POST /p/:submissionId/like` (`UNIQUE(submission_id, guest_id)` makes the toggle idempotent; a placing photo's likes also feed the crowd-favorite point term above); guest-to-guest text runs through `POST /p/:submissionId/comments` — both defined in `src/routes/community.js`, backed by the `likes` and `comments` tables in `src/db.js`.

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

**Memory**:
A guest photo shared straight to the gallery with no matching task — a `submissions` row with `task_id = NULL` (issue #247). Shared via `GET /memories/new` → `POST /memories` (`src/services/photos.js`'s `uploadMemoryBatch`, up to 10 photos per batch, `src/routes/guest.js`). A memory earns no task-completion base point, but the guest's first VISIBLE memory each event-local day pays +1 (`scoring.memoryDaysFor`/`memoryDayCount`) — capped at one point per day, not per memory. A memory competes in crowd favorites exactly like a task photo.
_Avoid_: Extra photo, bonus photo.

**One-day challenge** ("mystery box"):
A task carrying `tasks.special_date` (paired with `special_bonus`, 1-3, issue #753) — the AUTHORITATIVE "this is a challenge" fact; `special_mode = 'oneday'` is a lockstep marker written alongside it, never read for the fact itself (`src/services/tasks.js`'s `isChallenge`/`isSealed`/`isOnDay`). Before its date the guest sees a locked "mystery box" card instead of the task; on the day itself it unseals and pays its bonus if completed that day; after, it behaves like an ordinary task with no further bonus. The "one-box ceiling" (owner rule, 2026-07-20): a guest sees at most one locked mystery-box card at a time, ever — `src/routes/guest.js`'s `suppressedChallengeIds` hides every sealed challenge but the earliest-dated one. Excluded from COMPLETIONIST (`tasks.challengeTaskWhere`).
_Avoid_: Daily challenge (the code's internal vocabulary — `SPECIAL_DAILY`, `BONUS_REASON_ONEDAY` — but the guest- and host-facing name is one-day-only / one-day challenge).

**Flash task**:
A task with a live, time-boxed bonus window — `tasks.flash_start_at`/`flash_minutes`/`flash_bonus` (issue #761), deliberately no `special_mode` member (widening that CHECK would force a table rebuild for no behavioral gain). `src/services/tasks.js`'s `flashState()` derives `none | scheduled | active | expired` from the row and the clock at read time — nothing is precomputed or stored. Pays its bonus only while `active`; the guest sees a countdown / drain-fill marker while the window runs.
_Avoid_: Timed task, limited-time task.

**Lucky task**:
A task with a secret bonus — `tasks.lucky_date`/`lucky_bonus` (issue #650), also deliberately no `special_mode` member. Unlike a one-day challenge or flash task, a lucky task carries NO guest-facing marker before a guest's own first completion of it — the bonus is a surprise revealed only on the success screen — and it pays only a guest's first-ever completion of the task (a resubmit after a soft takedown does not re-win it: `banksOnReplace: false`, `src/services/tasks.js`).
_Avoid_: Secret task, hidden task.

**Crowd favorite / crown**:
A top-5 (rank 1-5, standard-competition ranking by like count, ties included) submission, computed live by `scoring.crowdFavorites()` — no `guest_badges` row is written for the placing itself. A placing photo wears a crown mark on its tile (`src/views/partials/crowd-favorite-mark.ejs`, composing the shared crown SVG partial) — gold for a lone rank-1, white for rank 2-5 or a tied rank-1. Placing pays `CROWD_FAVORITE_POINTS` (5/4/3/2/1) into the owning guest's total (see Points above), with no cap on sweeping several placings. The same placing set also backs the TOPLIKED transferable badge ("Crowd Favorite" — see Badge above): every current placement holder holds the badge, recomputed as likes move.
_Avoid_: Most Liked (retired display name — `MOSTLIKED` is a retired, deleted badge code, #711; do not confuse with the live `TOPLIKED`/"Crowd Favorite" badge). Also do not confuse with the leaderboard's own champion crown (`src/views/partials/crown.ejs` used directly in `leaderboard.ejs` for the #1 standings guest) — the same SVG partial, a different feature.

**Slideshow**:
The end-of-night full-screen playback, `GET /slideshow` (`src/routes/community.js`, issue #468). `services/feed.js`'s `slideshowSequence()` owns the whole sequence: a Most-Liked opener, then a per-task section with its winners. `?mode=directed` vs the default Auto is the route's only own decision; a garbage `mode` value falls back to Auto.
_Avoid_: Recap (a separate, per-guest "what happened to me" notification feature, `src/services/notifications.js` — not this shared end-of-night playback).

**Favorites** (host-curated):
A Wedding Master pick on the admin photos screen, distinct from a guest's own likes — one shared flag per photo (`admin_favorites` table, row presence IS the favorite, issue #259), since this app has exactly one shared admin login rather than per-admin identity. Toggled via `POST /admin/photos/:id/favorite` (`src/services/favorites.js`'s `toggleFavorite`).
_Avoid_: Like (a guest-facing, per-guest action on `likes` — a different table, a different audience).

## Seams worth knowing

- **Three audiences**: Guest (`requireGuest`), Wedding Master (`requireAdmin`, under `/admin`), and Public (`attachGuest`-only surfaces such as `POST /join`/`POST /login` themselves). Gallery, feed, leaderboard, and the community routes (likes/comments/profiles) are guest-gated (`requireGuest`) — a signed-out visitor is redirected to `/join`, not shown a public view.
- **Scoring authority**: `src/services/scoring.js` is canonical for points and badge thresholds — `getPoints()`/`leaderboard()` for points, `recomputeBadges`/`recomputeTransferableBadges` for badge grant/revoke. Every other reader (`admin.js`'s dashboard, `guest.js`'s progress bar) calls into this module rather than re-deriving the count itself.
- **Submission lifecycle**: live → taken-down → hard-deleted. Taken-down is reversible and export-safe; hard-delete is not.

## Vision terms — not built yet

Named in `docs/north-star.md` but with no schema or route in the code today. Do not treat these as implemented when reading source:

- **Prize** — a physical/tangible reward tied to standings, displayed to guests.

Slideshow and Favorites, both formerly listed here, have shipped — see their Language entries above.

## Conventions for the design skills

- Decisions and ADRs for this repo are recorded in `DESIGN.md` under `## Key decisions`. This repo does NOT use a `docs/adr/` directory — do not create one.
- Installed design skills (`improve-codebase-architecture`, `codebase-design`, `grilling`, `domain-modeling`) live under `.agents/skills/`. `.claude/skills/` is a generated, gitignored symlink mirror of the same skills — read from `.agents/skills/`, not `.claude/skills/`.
