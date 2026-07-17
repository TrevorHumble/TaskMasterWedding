# Garden Party Pastels — Wedding Scavenger Hunt

A photo scavenger-hunt web app for the wedding of **Axel Fenwick & Lily Sckeiky**. Around 100 guests, each on their own phone, scan one shared QR code on a poster, sign up with no password, and complete tasks by uploading photos. Each completed task earns a point, badges unlock automatically, and there is a public leaderboard and a shared photo gallery. A password-protected admin (the "Task Master") manages tasks, awards bonus points and special badges, hides photos, and exports everything at the end.

It runs on a small rented Linux host with a persistent disk, reachable over HTTPS through the host's reverse proxy at a stable domain the QR codes point to; see [`docs/deploy.md`](docs/deploy.md) for the full deploy runbook. It originally ran on a laptop behind a temporary Cloudflare tunnel.

## What it does

- **QR sign-up, no guest passwords.** One shared QR code, printed once on a poster, opens `/join` for every guest, who signs up with a name, contact, and a self-chosen 4-digit PIN. A returning guest re-enters at `/login` with that same contact + PIN on any device.
- **Photo tasks.** One photo per task per guest marks that task done and adds +1 point.
- **Badges.** Auto badges unlock at 5 / 10 / 15 completed tasks; special badges are hand-awarded by the admin; metric and transferable badges are computed by the badge engine from live data (e.g. a "most photos" badge that can change hands); and the admin can create further `custom` badges. Not a fixed set.
- **Leaderboard + gallery.** A public ranking and one shared photo gallery with a lightbox.
- **Feed, likes, comments.** A live `/feed` shows recent photos; guests can like and comment on any photo.
- **Profiles.** Avatar, name, badges, submissions, and optional social links. Guests can view each other's profiles.
- **Admin panel.** View and edit a guest's contact and re-entry PIN (or delete a guest), print the shared entry poster, manage tasks, award bonus points and per-photo bonus points, award special badges, take photos down and restore them, moderate comments, work a bug-report queue, and run a one-click export (a ZIP of all photos plus `summary.xlsx`).

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
node scripts/set-admin-password.js <password>   # sets the admin (Task Master) password
node scripts/seed.js                  # creates tables, badges, and sample data
npm run serve                         # starts the server on port 3000
```

Then open <http://localhost:3000>.

- `npm run serve` runs the app under `scripts/serve-resilient.js`, which restarts the server about a second after any crash — one bad request cannot end the event. (`npm start` runs the bare server with no restart safety net; use it only when you want a crash to stay down, e.g. while debugging.)

- `node scripts/set-admin-password.js <password>` writes a bcrypt hash to `data/admin.hash`. Run it again any time to change the password; the old one stops working immediately.
- `node scripts/seed.js` creates the SQLite schema and seeds badges plus sample tasks/guests. The badge catalog itself is also healed on every app boot (`src/db.js`, issue #314) — INSERT-OR-IGNORE, so it backfills any badge added since a database was first seeded, even on an already-played `app.db`, without touching sample tasks/guests or anything an admin has edited.
- `npm run seed-event -- --guests 100 --seed 1` generatively seeds a realistic ~100-guest event (dense leaderboard, earned and special badges, moderated photos, real image files on disk) for pre-wedding testing at true scale. It must be pointed at a non-live `DATA_DIR` (e.g. `data-demo`) — set the `DATA_DIR` environment variable first, since it deletes and replaces its own fixture data on every run and refuses to touch a directory holding real guests.
- Copy `.env.example` to `.env` and set a fixed `COOKIE_SECRET` before the event. In production, the app refuses to boot without one (issue #242) — a regenerated secret would silently sign out every guest and admin at once, mid-event. In dev/test, a missing secret just generates a random one on each boot and signs everyone out on every restart.

## How it is used

**Guests** scan one shared QR code (printed once, on the poster) which opens `/join`, where they sign up with a name, an email or phone, an optional avatar, and a self-chosen 4-digit PIN — one form does signup and onboarding together, and signs them in immediately (a signed `gsid` cookie). A guest who already has an account is sent to `/login` to re-enter with that same contact + PIN, on any device. From the home page they browse `/tasks`, open a task, upload a photo to complete it, view `/gallery`, `/feed` (where they can like and comment on photos), `/leaderboard`, and profiles at `/u/:guestId`, and can revisit `/how-to-play` or send in `/bug-report` from the profile menu.

**Admin** signs in at `/admin/login` (a signed `admin` cookie validated against `data/admin.hash`). The dashboard at `/admin` links to the guest table (rename, delete, and set/read a guest's contact + PIN), the printable entry poster at `/admin/poster`, task CRUD, awarding points and badges, comment moderation at `/admin/comments`, the bug-report queue at `/admin/bugs`, photo takedown, and `/admin/export`.

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

Run a backup any time the app is up (safe to run against a live, in-use database) — the right way to take a one-off local snapshot:

```powershell
node scripts/backup.js
```

This writes a timestamped snapshot to `backups/<YYYYMMDD-HHMMSS>/`, containing:

- `app.db` — a consistent copy of the database, taken with SQLite's own online backup API (not a plain file copy, which can read a torn/partial file while the app is writing in WAL mode)
- `uploads/` — a copy of every uploaded photo and avatar
- `thumbs/` — a copy of every generated thumbnail
- `admin.hash` — the hashed admin password, if one has been set (a fresh event with no admin password configured yet has none to copy)

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
4. Copy the snapshot's database and photo folders back:
   ```bash
   cp backups/<timestamp>/app.db data/app.db
   cp -r backups/<timestamp>/uploads data/uploads
   cp -r backups/<timestamp>/thumbs data/thumbs
   ```
   ```powershell
   Copy-Item backups\<timestamp>\app.db data\app.db
   Copy-Item backups\<timestamp>\uploads data\uploads -Recurse
   Copy-Item backups\<timestamp>\thumbs data\thumbs -Recurse
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

```
config.js                 Central config + tiny .env loader; paths, port
scripts/
  set-admin-password.js   Hashes the admin password into data/admin.hash
  seed.js                 Creates schema, seeds badges + sample tasks/guests
src/
  app.js                  Express bootstrap: middleware, static mounts, routers, handlers
  db.js                   better-sqlite3 connection, schema, shared helpers
  middleware/session.js   attachGuest, requireGuest, requireAdmin, one-shot flash
  routes/
    auth.js               /join (signup), /login (re-entry), /admin/login, /admin/logout
    guest.js              /, /tasks, /tasks/:id, /tasks/:id/submit, /me/edit,
                           /how-to-play, /bug-report
    community.js          /gallery, /feed, GET /p/:submissionId, /p/:submissionId/like,
                           /p/:submissionId/comments, /p/:submissionId/comments/:commentId/delete,
                           /leaderboard, /u/:guestId
    admin.js              /admin dashboard, guests (rename/delete/identity), poster,
                           tasks, awards, takedown, export, /admin/bugs
  services/
    photos.js             multer disk storage, sharp thumbnails/avatars, takedown/delete
    scoring.js            points, auto badges (5/10/15), special badges, leaderboard
    submissions.js        submit-or-replace sequence for a task photo
    feed.js               gallery/feed visibility (owns the taken_down filter) + ordering
    badges.js             metric/transferable badge engine (e.g. Completionist, Most Photos)
    identity.js           contact normalization + PIN validation for guest sign-in/re-entry
    export.js             ZIP of photos by guest + summary.xlsx
    qr.js                 QR data URLs
  views/                  EJS templates + partials
  public/                 css, client js, badge SVGs
data/                     Runtime state (gitignored): app.db, uploads/, thumbs/, exports/, admin.hash
skills/                   This repo's own /build pipeline skills
.agents/skills/           Design skills installed via the skills CLI (improve-codebase-architecture,
                          codebase-design, grilling, domain-modeling); .claude/skills/ is a gitignored
                          symlink mirror regenerated from .agents/skills/ + skills-lock.json
PLAN/                     Detailed build/implementation plan (00-README.md .. 10-theme-and-art.md)
docs/architecture.md      Request-path and data-model diagrams + walkthroughs
standards/                Checkable standards the orchestrator pipeline enforces
```

## Documentation

- Hosted deploy runbook (containers, systemd, TLS, backups): [`docs/deploy.md`](docs/deploy.md).
- Manual pre-wedding walkthrough (step-by-step test plan): [`docs/test-plan.md`](docs/test-plan.md).
- Peak-load test harness and how to read a run: [`docs/loadtest.md`](docs/loadtest.md).
- Detailed build plan: [`PLAN/00-README.md`](PLAN/00-README.md) and the numbered files through `10-theme-and-art.md` (historical; for current hosting see docs/deploy.md).
- Architecture diagrams and walkthroughs: [`docs/architecture.md`](docs/architecture.md).
- Design rationale and tradeoffs: [`DESIGN.md`](DESIGN.md).
- Refactor roadmap: [`PLAN.md`](PLAN.md).
- How to contribute through the orchestrator pipeline (issue → review → implement → review → PR): [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
- What a green build actually proves, in plain English: [`WHAT-IT-CHECKS.md`](WHAT-IT-CHECKS.md).
