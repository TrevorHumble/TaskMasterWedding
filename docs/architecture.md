# Architecture

How a request travels through Wedding Master, and how the data is shaped. For the reasoning behind these choices see [`DESIGN.md`](../DESIGN.md).

**A note on scope:** the scoring/badge coverage in this document describes the design being built, not a finished system — the authority is [`docs/game-design-points-badges.md`](game-design-points-badges.md), specifically its "Data flow and architecture" section; the previous scoring/badge model, which the code below still runs today, is quarantined at the bottom under [Deprecated](#deprecated--the-previous-scoringbadge-system).

## Request path

A guest's phone and the admin's browser both reach the app server through a reverse proxy that terminates HTTPS, which forwards to Express. `src/app.js` runs the request through middleware, into a router, which calls services that read and write SQLite and the file store under `data/`.

```mermaid
flowchart TD
    phone["Guest phone (browser)"] --> proxy
    admin["Admin browser"] --> proxy
    proxy["HTTPS reverse proxy (host)"] --> express

    subgraph server["app server"]
        express["Express app (src/app.js)<br/>localhost:3000"]
        express --> mw["Middleware<br/>signed cookies, body parsing,<br/>attachGuest"]
        mw --> auth["routes/auth.js<br/>/join, /login, /admin/login"]
        mw --> guest["routes/guest.js<br/>/, /tasks, /tasks/:id/submit, /me/edit,<br/>/how-to-play, /bug-report"]
        mw --> community["routes/community.js<br/>/gallery, /feed, GET /p/:submissionId,<br/>/p/:submissionId/like, /p/:submissionId/comments,<br/>/p/:submissionId/comments/:commentId/delete,<br/>/leaderboard, /u/:guestId"]
        mw --> adminr["routes/admin.js (/admin)<br/>dashboard, guests, tasks, awards, export,<br/>/admin/comments, /admin/badges, /admin/bugs"]

        auth --> svc
        guest --> svc
        community --> svc
        adminr --> svc

        subgraph svc["services/"]
            photos["photos.js<br/>multer + sharp thumbs/avatars, takedown"]
            scoring["scoring.js<br/>points, badges, leaderboard"]
            submissions["submissions.js<br/>submit-or-replace sequence"]
            feed["feed.js<br/>gallery/feed visibility + ordering"]
            badges["badges.js<br/>badge engine (metric/transferable<br/>types deprecated, see bottom)"]
            identity["identity.js<br/>contact normalize, PIN"]
            export["export.js<br/>ZIP + summary.xlsx"]
            qr["qr.js<br/>QR data URLs"]
        end

        svc --> db[("SQLite (src/db.js)<br/>data/app.db")]
        photos --> files["File store<br/>data/uploads/, data/thumbs/"]
        export --> exports["data/exports/"]
    end

    express -. "static mounts" .-> static["/ → src/public<br/>/uploads → data/uploads<br/>/thumbs → data/thumbs"]
```

`app.js` mounts the routers in a deliberate order: `auth.js` and `admin.js` (at `/admin`) before `guest.js`, because `guest.js` applies `requireGuest` to everything under `/` and would otherwise intercept `/admin` and redirect the admin to `/join` instead of serving the admin dashboard (issue #241 changed `requireGuest` from a 403 message card to a `/join` redirect). It also creates the `data/` directories on boot and registers the 404 and error handlers last.

## Data model

Eight tables. Several UNIQUE constraints carry the core game rules. Three fields below (`guests.bonus_points`, `submissions.photo_bonus`, and the `special`/`metric`/`transferable` values of `badges.type`) belong to the scoring/badge model being replaced — see [Deprecated](#deprecated--the-previous-scoringbadge-system) for how they work today and `docs/game-design-points-badges.md`'s "Data flow and architecture" section for the settled stores (`tasks`, `submissions`, `likes`, `guest_badges`, `settings`) that replace them.

```mermaid
erDiagram
    guests ||--o{ submissions : "submits"
    tasks ||--o{ submissions : "completed by"
    guests ||--o{ guest_badges : "earns"
    badges ||--o{ guest_badges : "awarded as"
    guests ||--o{ likes : "likes"
    submissions ||--o{ likes : "liked by"
    guests ||--o{ comments : "comments"
    submissions ||--o{ comments : "commented on"
    guests ||--o{ bug_reports : "files"

    guests {
        int id PK
        text token UK "internal session credential, never distributed"
        text name
        text avatar_path
        text social_links "JSON"
        int bonus_points "deprecated - freeform award, dying (#683)"
        int onboarded
        text contact "normalized email or phone"
        text contact_type "email | phone"
        text pin "4-digit re-entry PIN, plaintext"
        int pinned "hoists guest's gallery section"
        text created_at
    }
    tasks {
        int worth "host-chosen 1-3, points a completed task pays (#727)"
        int id PK
        text title
        text description
        int sort_order
        text special_mode "none | hidden - the one liveness owner, replaced is_active (#727)"
        text created_at
    }
    submissions {
        int id PK
        int guest_id FK
        int task_id FK
        text photo_path
        text thumb_path
        text caption
        int taken_down
        int resubmitted "1 = guest replaced this while taken_down (issue #190)"
        int photo_bonus "deprecated - freeform award, dying (#684)"
        text created_at
    }
    badges {
        int id PK
        text code UK
        text name
        text type "auto | special | metric | transferable | custom - special/metric/transferable deprecated, dying (#661)"
        int threshold
        text art_path
        text description
    }
    guest_badges {
        int id PK
        int guest_id FK
        int badge_id FK
        text awarded_by "system | admin"
        text created_at
    }
    likes {
        int id PK
        int submission_id FK
        int guest_id FK
        text created_at
    }
    comments {
        int id PK
        int submission_id FK
        int guest_id FK
        text body
        int taken_down
        text created_at
    }
    bug_reports {
        int id PK
        int guest_id FK
        text body
        text page
        text user_agent
        int resolved
        text created_at
    }
```

UNIQUE constraints:

- `submissions UNIQUE(guest_id, task_id)` — one submission per guest per task. A task cannot be completed twice, so it cannot be double-scored.
- `guest_badges UNIQUE(guest_id, badge_id)` — a guest holds each badge at most once, making re-scoring and re-awarding idempotent.
- `likes UNIQUE(submission_id, guest_id)` — a guest can like a given photo at most once; the like route toggles this row.
- `guests` partial unique index on `contact` (`WHERE contact IS NOT NULL`) — two guests cannot share a normalized contact.

`submissions` and `guest_badges` reference `guests(id)` and their parent (`tasks`/`badges`) with `ON DELETE CASCADE`; `likes` and `comments` reference `submissions(id)` and `guests(id)` the same way; `bug_reports` references `guests(id)` the same way. Foreign keys are enforced (`PRAGMA foreign_keys = ON` in `src/db.js`).

## Walkthrough: a photo upload

1. A signed-in guest opens a task at `GET /tasks/:id`. The `attachGuest` middleware has already read the signed `gsid` cookie and loaded the guest onto `res.locals`; `requireGuest` confirms a guest is present.
2. The guest submits the form to `POST /tasks/:id/submit` as `multipart/form-data`. `guest.js` hands the upload to `services/photos.js`, where multer accepts the file and sharp writes a normalized original to `data/uploads/` and a thumbnail (width `THUMB_WIDTH`) to `data/thumbs/`.
3. A `submissions` row is inserted with the guest id, task id, photo and thumb paths, and any caption. The `UNIQUE(guest_id, task_id)` constraint prevents a second submission for the same task.
4. `services/scoring.js` recomputes the guest's completed-task count (non-taken-down submissions). If the count crossed a `BADGE_THRESHOLDS` boundary (5 / 10 / 15), the matching auto badge is recorded in `guest_badges` with `awarded_by = 'system'`; `UNIQUE(guest_id, badge_id)` makes this safe to repeat.
5. The guest is redirected back, the photo now counts toward the task's point worth (host-set per `docs/game-design-points-badges.md`), appears in `/gallery`, on the guest's profile, and affects the leaderboard.

If the admin later takes the photo down, the row's `taken_down` flips to 1: the photo drops out of the gallery, profiles, and scoring, and can be restored later. The takedown is sticky (issue #190): if the guest resubmits the same task while it is still taken down, the photo is replaced in place but `taken_down` stays 1 — a resubmit no longer un-hides it — and `resubmitted` flips to 1 so `/admin/photos` flags a decision waiting. Restoring the submission clears both `taken_down` and `resubmitted`.

## Walkthrough: a sign-in

Every guest gets the SAME link — one QR poster (`GET /admin/poster`), printed once instead of a hundred personal place-cards — pointing at `GET /join` (issue #240; issue #244 retired the older per-guest personal-link scheme entirely).

1. A guest scans the poster's QR code, landing on `GET /join`. The form collects a name, an email-or-phone contact, and a self-chosen 4-digit re-entry PIN, plus an optional avatar — signup IS onboarding here, there is no separate onboarding step afterward.
2. `POST /join` normalizes the contact and validates the PIN shape (`services/identity.js`), checks `getGuestByContact` for an existing account under that contact so the same person cannot create a second guest row, and otherwise inserts a new `guests` row with `onboarded = 1` and a fresh token from `makeUniqueToken()` (also in `services/identity.js`). The token is written straight into the signed `gsid` cookie and never shown to the guest — it is an internal session credential, not a link anyone reads or copies. The guest lands on `/` directly.
3. A contact that already has an account is redirected to `/login` (issue #241) to re-enter with their contact + PIN on any device instead — `POST /login` looks the guest up by contact, checks the PIN, and on a match sets the same signed `gsid` cookie.
4. On every later request, `attachGuest` reads and verifies the signed `gsid` cookie, loads the guest by token, and exposes it to routes and views. The cookie signature (via `cookie-parser` and `COOKIE_SECRET`) is what makes the token tamper-evident.

The admin sign-in is parallel: `POST /admin/login` checks the submitted password against the bcrypt hash in `data/admin.hash`, and on success sets the signed `admin` cookie that `requireAdmin` checks for every `/admin` route.

## Deprecated — the previous scoring/badge system

This is how scoring and badges used to work, and how the code above still behaves until #683, #684, and #661 land. The project is actively building away from it; do not extend it, and do not treat it as the plan. The settled replacement is `docs/game-design-points-badges.md`, with its data flow recorded in that document's "Data flow and architecture" section.

- **`guests.bonus_points`** — a freeform point total an admin could add to or subtract from a guest directly, with no task, photo, or reason attached. Dying with #683, which removes badges and freeform points from guests entirely.
- **`submissions.photo_bonus`** — a freeform point value an admin could attach to a single photo, again with no structured reason. Dying with #684.
- **`badges.type` values `special`, `metric`, and `transferable`** — a second, disconnected badge-tracking scheme that existed alongside the real `badges`/`guest_badges` substrate: `special` badges were hand-awarded to a guest from the admin panel (e.g. SHUTTERBUG), `metric`/`transferable` badges were placeholder test-era types. None of these carried the "one badge substrate" guarantee the settled design requires. All three die with #661's rewrite, leaving `auto` (the Bloom/Bouquet/Garden/Completionist set) and the new task-badge model as the only badge kinds.
- **The flat "+1 point per task" model** — every task paid exactly one point on completion, with no host-set worth, no daily/flash/lucky bonus, no ranked-award or crowd-favorite scoring. The upload walkthrough above used to read "the photo now counts for a point" before this document was updated; the settled model pays each task's host-chosen 1–3 point worth instead, per `docs/game-design-points-badges.md`.
