# Wedding Master

A photo task game for the wedding of **Axel Fenwick & Lilly Sckeiky**. Around 100 guests, each on their own phone, scan one shared QR code on a poster, sign up with no password, and complete tasks by uploading photos — goofy, funny, or touching, building a shared record of memories the couple keeps: one keepsake of the whole day. A completed task pays its host-set worth (1–3 points) plus any bonuses that apply, badges unlock automatically or get hand-awarded, and there is a leaderboard, shared photo gallery, an end-of-night slideshow, and a recap of what a guest missed, all visible to every signed-in guest. A password-protected admin (the Wedding Master) manages tasks, awards bonus points and special badges, hides photos, and exports everything at the end.

It runs on a small rented Linux host with a persistent disk, reachable over HTTPS through the host's reverse proxy at a stable domain the QR codes point to; see [`docs/deploy.md`](docs/deploy.md) for the full deploy runbook. It originally ran on a laptop behind a temporary Cloudflare tunnel.

## What it does

- **QR sign-up, no guest passwords.** One shared QR code, printed once on a poster, opens `/join` for every guest, who signs up with a name, contact, and a self-chosen 4-digit PIN. A returning guest re-enters at `/login` with that same contact + PIN on any device.
- **Photo tasks.** One photo per task per guest marks that task done. A completed task pays its host-set worth (1–3 points, set per task by the admin) plus any bonuses that apply — an admin-set per-photo bonus, a banked one-day-only challenge bonus, badge award points, and more (see `src/services/scoring.js`) — never a flat "+1".
- **Memories.** A task-free photo share (no task required) at `/memories/new` — it earns no base point, but a guest's first visible memory on a given event day pays a once-per-day bonus point.
- **Mystery-box challenge.** A one-day-only task (host-scheduled) stays sealed until its day, then appears as a locked "mystery box" card; a guest sees at most one locked card at a time (the one-box ceiling).
- **Badges.** Auto badges unlock at 5 / 10 / 15 completed tasks; a metric badge (Completionist) is computed from live data; special badges are hand-awarded by the admin; a transferable badge (the TOPLIKED / Crowd Favorite crown) is recomputed live and can change hands as likes shift; and the admin can create further `custom` badges. Not a fixed set.
- **Rank-and-award.** Per task, the admin ranks the submitted photos and releases the ranking to award that task's badge to the top finishers — this is how a task's own badge is actually won.
- **Leaderboard + gallery.** A ranking and one shared photo gallery — tap a thumbnail to open its own photo page — visible to every signed-in guest.
- **Feed, likes, comments.** A live `/feed` shows recent photos; guests can like and comment on any photo.
- **End-of-night slideshow.** A full-screen `/slideshow` sequence over the event's photos, opened with the crowd's most-liked shots.
- **Recap / notifications.** A per-guest "what you missed" panel — new badges, likes, comments, and host announcements since the guest last checked.
- **Profiles.** Avatar, name, badges, submissions, and optional social links. Guests can view each other's profiles.
- **Admin panel.** View and edit a guest's contact and re-entry PIN (or delete a guest), print the shared entry poster, manage tasks, rank and award task badges, award bonus points and special badges, favorite and take photos down and restore them, moderate comments inline on the photos screen, set the event timezone and dates, work through a live host-checklist dashboard, handle a bug-report queue, and run a one-click export (a ZIP of all photos plus `summary.xlsx`).

## Quickstart

**Already have this folder checked out? Check it is current first:**

```powershell
powershell -File tools/check-freshness.ps1
```

Build sessions merge their work on GitHub from separate worktrees, so this folder never updates itself — if the check says you are N commits behind, run `git pull` before looking at the app, or you will be reviewing a version that no longer exists. The check is read-only; it never changes your files.

**Then check the installed dependencies actually match the lockfile CI tested:**

```powershell
powershell -File tools/check-deps-parity.ps1
```

Code being current does not mean `node_modules/` is — a dependency bump merged on GitHub does not update this machine's installed packages by itself. This check compares each installed prod dependency (plus the devDependencies the tests need) against `package-lock.json` and exits 1 on any mismatch or missing install. If it flags drift, see [`docs/dependency-upgrade.md`](docs/dependency-upgrade.md) for the reconciliation procedure (`npm ci`). Also read-only; it never installs or changes anything itself.

Requires **Node.js 20+** on Windows (PowerShell) for local development. Production runs on Linux — see [`docs/deploy.md`](docs/deploy.md) for the hosted deploy. From the project root:

```powershell
npm install
node scripts/set-admin-password.js <password>   # sets the admin (Wedding Master) password
node scripts/seed.js                  # creates tables, seeds badges + sample tasks (no guests)
npm run serve                         # starts the server on port 3000
```

Then open <http://localhost:3000>.

- `npm run serve` runs the app under `scripts/serve-resilient.js`, which restarts the server about a second after any crash — one bad request cannot end the event. (`npm start` runs the bare server with no restart safety net; use it only when you want a crash to stay down, e.g. while debugging.)

- `node scripts/set-admin-password.js <password>` writes a bcrypt hash to `data/admin.hash`. Run it again any time to change the password; the old one stops working immediately.
- `node scripts/seed.js` creates the SQLite schema and seeds badges plus sample tasks only — **no guests**. The badge catalog itself is also healed on every app boot (`src/db.js`, issue #314) — INSERT-OR-IGNORE, so it backfills any badge added since a database was first seeded, even on an already-played `app.db`, without touching sample tasks or anything an admin has edited.
- `npm run seed-event -- --guests 100 --seed 1` (`scripts/seed-event.js`) generatively seeds a realistic ~100-guest event (dense leaderboard, earned and special badges, moderated photos, real image files on disk) for pre-wedding testing at true scale. It must be pointed at a non-live `DATA_DIR` (e.g. `data-demo`) — set the `DATA_DIR` environment variable first, since it deletes and replaces its own fixture data on every run and refuses to touch a directory holding real guests.
- `node scripts/seed-story.js --story <normal|extreme>` seeds one of two named, disk-swappable "story" datasets (built on `seed-event.js`'s sample-photo install) for demoing a specific scenario — a representative mid-size wedding, or a stress case with a leaderboard tie and heavy engagement. Also dev-data tooling; point `DATA_DIR` at a scratch folder first, same as `seed-event.js`.
- Copy `.env.example` to `.env` and set a fixed `COOKIE_SECRET` before the event. In production, the app refuses to boot without one (issue #242) — a regenerated secret would silently sign out every guest and admin at once, mid-event. In dev/test, a missing secret just generates a random one on each boot and signs everyone out on every restart.

## How it is used

**Guests** scan one shared QR code (printed once, on the poster) which opens `/join`, where they sign up with a name, an email or phone, an optional avatar, and a self-chosen 4-digit PIN — one form does signup and onboarding together, and signs them in immediately (a signed `gsid` cookie). A guest who already has an account is sent to `/login` to re-enter with that same contact + PIN, on any device, and can `/logout` from any device too. From the home page they browse `/tasks`, open a task, upload a photo to complete it, or share a task-free photo at `/memories/new` (listed at `/memories`); they can also view `/gallery`, `/feed` (where they can like and comment on photos, open a photo's own page at `/p/:submissionId`, and — as its owner — edit its caption or delete it), `/leaderboard`, tap any earned badge at `/badge/:code` for its detail, watch the end-of-night `/slideshow`, and open `/recap` for what they missed (dismissed via `/recap/seen`) and profiles at `/u/:guestId`. They can revisit `/how-to-play`, remove their avatar (`/me/avatar/delete`), or send in `/bug-report` from the profile menu. This list is representative, not exhaustive — see "Where things live" below for the full route map.

**Admin** signs in at `/admin/login` (a signed `admin` cookie validated against `data/admin.hash`). The dashboard at `/admin` links to the guest table (rename, delete, and set/read a guest's contact + PIN), the printable entry poster at `/admin/poster`, task CRUD, rank-and-award (ranking a task's submitted photos and releasing the ranking to award that task's badge), awarding bonus points and special badges, `/admin/config` (event timezone and dates), photo favorites and takedown on `/admin/photos` (where comment moderation is also handled, inline, per photo), the host-checklist dashboard, the bug-report queue at `/admin/bugs`, and `/admin/export`.

## Going live

Production runs on a rented Linux host, not the dev laptop: a host with a persistent disk, environment variables set per the table in `docs/deploy.md` (including `BASE_URL` and `TRUST_PROXY`), then `docker compose up -d --build` or the systemd unit described there. The host's reverse proxy terminates HTTPS at the stable domain the QR codes encode. See [`docs/deploy.md`](docs/deploy.md) for the full procedure — provisioning, TLS, environment variables, and the process supervisor.

### Working in a worktree

Running more than one AI build session against this repo at once? Give each one its own folder so they cannot interfere with each other's uncommitted work:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/new-agent-worktree.ps1 -Branch <name>
```

This creates a sibling folder checked out on `<name>`, sharing this repo's history. It prints the folder's path once ready — `cd` there and work as normal; the commit-msg hook (issue-reference check) is already active.

**Clean up when a session is done:** a worktree that is created but never removed leaves a full second source copy on disk. If one shows up nested inside this checkout (`.claude/worktrees/<name>/`, seen after issue #319), delete that folder and remove its entry from git's worktree list:

```powershell
git worktree remove .claude/worktrees/<name>
```

`eslint.config.js` ignores `.claude/worktrees/**` so a leftover one never pollutes `npm run lint` output here, but the disk space and git worktree registration are still real — remove it rather than leaving it.

## Backups

`data/` is the only copy of the event: the SQLite database plus every uploaded photo and thumbnail. Back it up to a **second location** — a copy sitting next to `data/` on the same disk does not survive a disk failure or an accidental `rm -rf data/`.

### Scheduled backups

In production the host runs backups on a schedule and keeps the last `BACKUP_RETENTION_COUNT` snapshots, copying each one off-host (not just to another folder on the same disk) so a lost host does not also mean a lost event. Setup and the retention/off-host settings are covered in the backups section of [`docs/deploy.md`](docs/deploy.md).

### Manual run (dev)

Run a backup any time the app is up (safe to run against a live, in-use database) — the right way to take a one-off local snapshot. `scripts/backup.js` takes three modes; the default runs both halves:

```powershell
node scripts/backup.js                 # default: database snapshot + photo store, both
node scripts/backup.js --db-only       # database snapshot only, no photos
node scripts/backup.js --photos-only   # photo store only, no database snapshot
```

This is a **split shape** (see [`docs/deploy.md`](docs/deploy.md) § "Backups" for the full rationale): the database and the photos are backed up independently, because they have opposite cadences.

- The `--db-only` half writes a timestamped folder to `backups/<YYYYMMDD-HHMMSS>/`, containing only:
  - `app.db` — a consistent copy of the database, taken with SQLite's own online backup API (not a plain file copy, which can read a torn/partial file while the app is writing in WAL mode)
  - `admin.hash` — the hashed admin password, if one has been set (a fresh event with no admin password configured yet has none to copy)
- The `--photos-only` half (also run by default) copies any new file from `uploads/`/`thumbs/` into **one shared, append-only store** at `BACKUP_DIR/photos/{uploads,thumbs}` — not into the timestamped folder, and not re-copied per run. A photo is write-once, so this store is never pruned by retention and is never duplicated per snapshot.

The backup folder location is controlled by the `BACKUP_DIR` config key. Its default resolves to `<ROOT>/backups` — a sibling of `<ROOT>/data`, i.e. outside `data/`, not a subfolder of it (see `config.js`). Set the `BACKUP_DIR` environment variable to point backups at a second drive or a mounted external location.

### Restoring

The hosted restore procedure is canonical — see the restore section of [`docs/deploy.md`](docs/deploy.md). To restore a snapshot back into a fresh `data/` locally (e.g. after a crash or corrupted database):

1. Stop the app.
2. Make sure `data/` is empty (or doesn't exist yet) — restoring on top of an existing `data/` overwrites it.
3. Create an empty `data/` directory (needed before the `app.db` copy below):
   ```bash
   mkdir -p data
   ```
   ```powershell
   New-Item -ItemType Directory -Force data | Out-Null
   ```
4. Copy the database from the chosen timestamped snapshot, and the photos from the shared store — not from inside the snapshot folder:
   ```bash
   cp backups/<timestamp>/app.db data/app.db
   cp -r backups/photos/uploads data/uploads
   cp -r backups/photos/thumbs data/thumbs
   ```
   ```powershell
   Copy-Item backups\<timestamp>\app.db data\app.db
   Copy-Item backups\photos\uploads data\uploads -Recurse
   Copy-Item backups\photos\thumbs data\thumbs -Recurse
   ```
5. Copy the admin password hash back, if the snapshot has one (skip this step if `admin.hash` isn't in the snapshot folder — that just means no admin password had been set yet). Without this step the restored app has no admin password configured, and the host cannot log into `/admin` until one is set again:
   ```bash
   cp backups/<timestamp>/admin.hash data/admin.hash
   ```
   ```powershell
   Copy-Item backups\<timestamp>\admin.hash data\admin.hash
   ```
6. Start the app again.

### Gitignored, and cleared at teardown

`backups/` is gitignored, exactly like `data/` — it holds the same database and guest photos, so it must never be committed. Post-event teardown must clear **both** `data/` and the backup directory (`BACKUP_DIR`), not just `data/`.

## Where things live

Route lists below are representative (the router files themselves are the source of truth for
the exact set); the services list is the full current `src/services/` set.

```
config.js                 Central config + tiny .env loader; paths, port
scripts/
  set-admin-password.js   Hashes the admin password into data/admin.hash
  seed.js                 Creates schema, seeds badges + sample tasks only (no guests)
  seed-event.js           Generatively seeds a realistic multi-guest event at scale (dev data)
  seed-story.js           Seeds a named "story" dataset (normal / extreme) for demos (dev data)
src/
  app.js                  Express bootstrap: middleware, static mounts, routers, handlers
  db.js                   better-sqlite3 connection, schema, shared helpers
  middleware/session.js      attachGuest, requireGuest, requireAdmin, one-shot flash
  middleware/rate-limit.js   Shared fixed-window limiter (issue #283) backing POST /join,
                             /login, /tasks/:id/submit, /me/edit, /bug-report, /p/:id/like,
                             /p/:id/comments
  routes/
    auth.js               /join (signup), /login (re-entry), /logout, /admin/login, /admin/logout
    guest.js              /, /tasks, /tasks/:id, /tasks/:id/submit, /memories/new, /memories,
                           /me/edit, /me/avatar/delete, /recap, /recap/seen,
                           /how-to-play, /bug-report
    community.js          /gallery, /feed, /slideshow, GET /p/:submissionId,
                           /p/:submissionId/like, /p/:submissionId/comments,
                           /p/:submissionId/comments/:commentId/delete, /p/:submissionId/caption,
                           /p/:submissionId/delete, /leaderboard, /badge/:code, /u/:guestId
    admin.js              /admin dashboard, guests (rename/delete/identity), poster, tasks,
                           rank-and-award (/admin/tasks/:id/rank), awards, /admin/config,
                           photos (favorite/takedown, with inline comment moderation),
                           /admin/bugs, export
  services/
    badge-icons.js        Badge art path resolution + icon-vs-file classification
    badges.js             Metric badge (Completionist) + transferable badge (TOPLIKED /
                           Crowd Favorite) registries
    event-days.js         Event-local calendar-day derivation from a configured timezone
    export.js             ZIP of photos by guest + summary.xlsx
    favorites.js          Host-scoped admin photo favorites
    feed.js               gallery/feed visibility (owns the taken_down filter), ordering, and
                           the end-of-night slideshow sequence
    heic-worker.js        Background HEIC-to-JPEG conversion for uploaded photos
    host-checklist.js     The admin dashboard's live setup checklist
    identity.js           contact normalization + PIN validation for guest sign-in/re-entry
    lockout.js            Persisted admin-login lockout state
    notifications.js      The recap ("what you missed") event log and derived feed
    photos.js             multer disk storage, sharp thumbnails/avatars, takedown/delete
    qr.js                 QR data URLs
    rank.js               Dense-rank (leaderboard) and standard-competition rank (crowd
                           favorites, task rank-and-award) algorithms
    rate-limit.js         Per-guest sliding-window throttle for memory uploads and HEIC
                           decode attempts, plus the disk-free-space guard (hasFreeSpace) —
                           NOT the shared join/login/upload limiter (see middleware/rate-limit.js)
    relative-time.js      SQLite datetime parsing + human-relative-time formatting
    render-locals.js      Per-request view locals shared across routes
    scoring.js            Points (task worth + bonuses), auto badges (5/10/15), special
                           badges, crowd favorites, leaderboard
    submissions.js        submit-or-replace sequence for a task photo or memory
    task-badges.js        Per-task badge resolution + rank-and-award writing
    tasks.js              Task CRUD helpers, one-day-only ("mystery box") challenge rules
  views/                  EJS templates + partials
  public/                 css, client js, badge SVGs
data/                     Runtime state (gitignored): app.db, uploads/, thumbs/, exports/, admin.hash
skills/                   This repo's own /build pipeline skills
.agents/skills/           Design skills installed via the skills CLI (improve-codebase-architecture,
                          codebase-design, grilling, domain-modeling); .claude/skills/ is a gitignored
                          symlink mirror regenerated from .agents/skills/ + skills-lock.json
PLAN/                     Historical build-plan summary (history.md)
docs/architecture.md      Request-path and data-model diagrams + walkthroughs
standards/                Checkable standards the orchestrator pipeline enforces
```

## Documentation

- Hosted deploy runbook (containers, systemd, TLS, backups): [`docs/deploy.md`](docs/deploy.md).
- Manual pre-wedding walkthrough (step-by-step test plan): [`docs/test-plan.md`](docs/test-plan.md).
- Peak-load test harness and how to read a run: [`docs/loadtest.md`](docs/loadtest.md).
- Historical build-plan summary: [`PLAN/history.md`](PLAN/history.md) (superseded; for current hosting see docs/deploy.md).
- Architecture diagrams and walkthroughs: [`docs/architecture.md`](docs/architecture.md).
- Design rationale and tradeoffs: [`DESIGN.md`](DESIGN.md).
- Refactor roadmap: [`PLAN.md`](PLAN.md).
- How to contribute through the orchestrator pipeline (issue → review → implement → review → PR): [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
- What a green build actually proves, in plain English: [`WHAT-IT-CHECKS.md`](WHAT-IT-CHECKS.md).
