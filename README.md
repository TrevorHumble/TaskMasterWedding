# Garden Party Pastels — Wedding Scavenger Hunt

A photo scavenger-hunt web app for the wedding of **Axel Fenwick & Lily Sckeiky**. Around 100 guests, each on their own phone, scan a per-guest QR code on their place-card, sign in with no password, and complete tasks by uploading photos. Each completed task earns a point, badges unlock automatically, and there is a public leaderboard and a shared photo gallery. A password-protected admin (the "Task Master") manages tasks, awards bonus points and special badges, hides photos, and exports everything at the end.

It runs on a single Windows laptop for the wedding weekend and is made publicly reachable by a free Cloudflare quick tunnel. No paid services, nothing to install in the cloud.

## What it does

- **QR sign-in, no guest passwords.** Each guest has a unique link carrying a random token, printed as a QR code. Scanning it signs the guest in on that device.
- **Photo tasks.** One photo per task per guest marks that task done and adds +1 point.
- **Badges.** Three auto badges unlock at 5 / 10 / 15 completed tasks. Four special badges (EARLYBIRD, SHUTTERBUG, CROWDFAV, CHOICE) are awarded by the admin.
- **Leaderboard + gallery.** A public ranking and one shared photo gallery with a lightbox.
- **Profiles.** Avatar, name, badges, submissions, and optional social links. Guests can view each other's profiles.
- **Admin panel.** Create guests and QR codes, manage tasks, award bonus points and special badges, take photos down and restore them, and run a one-click export (a ZIP of all photos plus `summary.xlsx`).

## Quickstart

**Already have this folder checked out? Check it is current first:**

```powershell
powershell -File tools/check-freshness.ps1
```

Build sessions merge their work on GitHub from separate worktrees, so this folder never updates itself — if the check says you are N commits behind, run `git pull` before looking at the app, or you will be reviewing a version that no longer exists. The check is read-only; it never changes your files.

Requires **Node.js 20+** on Windows (PowerShell). From the project root:

```powershell
npm install
node scripts/set-admin-password.js <password>   # sets the admin (Task Master) password
node scripts/seed.js                  # creates tables, badges, and sample data
npm run serve                         # starts the server on port 3000
```

Then open <http://localhost:3000>.

- `npm run serve` runs the app under `scripts/serve-resilient.js`, which restarts the server about a second after any crash — one bad request cannot end the event. (`npm start` runs the bare server with no restart safety net; use it only when you want a crash to stay down, e.g. while debugging.)

- `node scripts/set-admin-password.js <password>` writes a bcrypt hash to `data/admin.hash`. Run it again any time to change the password; the old one stops working immediately.
- `node scripts/seed.js` creates the SQLite schema and seeds badges plus sample tasks/guests.
- `npm run seed-event -- --guests 100 --seed 1` generatively seeds a realistic ~100-guest event (dense leaderboard, earned and special badges, moderated photos, real image files on disk) for pre-wedding testing at true scale. It must be pointed at a non-live `DATA_DIR` (e.g. `data-demo`) — set the `DATA_DIR` environment variable first, since it deletes and replaces its own fixture data on every run and refuses to touch a directory holding real guests.
- Copy `.env.example` to `.env` and set a fixed `COOKIE_SECRET` before the event. Without it the app generates a random secret on each boot and signs everyone out on every restart.

## How it is used

**Guests** scan their QR code, which opens `/j/:token` and signs them in (a signed `gsid` cookie). First sign-in goes through `/onboard` to set a name and avatar. From the home page they browse `/tasks`, open a task, upload a photo to complete it, and view `/gallery`, `/leaderboard`, and profiles at `/u/:guestId`.

**Admin** signs in at `/admin/login` (a signed `admin` cookie validated against `data/admin.hash`). The dashboard at `/admin` links to guest creation and bulk create, the printable QR sheet at `/admin/qrsheet`, task CRUD, awarding points and badges, photo takedown, and `/admin/export`.

## Going live (Cloudflare tunnel)

Start the app, then point a free Cloudflare quick tunnel at it (no account needed):

```powershell
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a public `https://<random>.trycloudflare.com` URL that forwards to the laptop. Share that URL (or print QR codes against it) so guests can reach the app from anywhere. The URL changes on each run.

### Working in a worktree

Running more than one AI build session against this repo at once? Give each one its own folder so they cannot interfere with each other's uncommitted work:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/new-agent-worktree.ps1 -Branch <name>
```

This creates a sibling folder checked out on `<name>`, sharing this repo's history. It prints the folder's path once ready — `cd` there and work as normal; the commit gate is already active.

## Backups

`data/` is the only copy of the event on the laptop: the SQLite database plus every uploaded photo and thumbnail. Back it up during the event, to a **second location** — a copy sitting next to `data/` on the same disk does not survive a disk failure or an accidental `rm -rf data/`.

Run a backup any time the app is up (safe to run against a live, in-use database):

```powershell
node scripts/backup.js
```

This writes a timestamped snapshot to `backups/<YYYYMMDD-HHMMSS>/`, containing:

- `app.db` — a consistent copy of the database, taken with SQLite's own online backup API (not a plain file copy, which can read a torn/partial file while the app is writing in WAL mode)
- `uploads/` — a copy of every uploaded photo and avatar
- `thumbs/` — a copy of every generated thumbnail

The backup folder location is controlled by the `BACKUP_DIR` config key. Its default resolves to `<ROOT>/backups` — a sibling of `<ROOT>/data`, i.e. outside `data/`, not a subfolder of it (see `config.js`). Set the `BACKUP_DIR` environment variable to point backups at a second drive or a mounted external location.

### Restoring

To restore a snapshot back into a fresh `data/` (e.g. after a crash or corrupted database):

1. Stop the app.
2. Make sure `data/` is empty (or doesn't exist yet) — restoring on top of an existing `data/` overwrites it.
3. Create an empty `data/` directory (needed before the `app.db` copy below, since `Copy-Item` will not create a missing parent):
   ```powershell
   New-Item -ItemType Directory -Force data | Out-Null
   ```
4. Copy the snapshot's database and photo folders back:
   ```powershell
   Copy-Item backups\<timestamp>\app.db data\app.db
   Copy-Item backups\<timestamp>\uploads data\uploads -Recurse
   Copy-Item backups\<timestamp>\thumbs data\thumbs -Recurse
   ```
5. Start the app again.

### Gitignored, and cleared at teardown

`backups/` is gitignored, exactly like `data/` — it holds the same database and guest photos, so it must never be committed. Post-event teardown must clear **both** `data/` and the backup directory (`BACKUP_DIR`), not just `data/`.

## Where things live

```
config.js                 Central config + tiny .env loader; paths, port, badge thresholds
scripts/
  set-admin-password.js   Hashes the admin password into data/admin.hash
  seed.js                 Creates schema, seeds badges + sample tasks/guests
src/
  app.js                  Express bootstrap: middleware, static mounts, routers, handlers
  db.js                   better-sqlite3 connection, schema, shared helpers
  middleware/session.js   attachGuest, requireGuest, requireAdmin, one-shot flash
  routes/
    auth.js               /j/:token sign-in, /onboard, /admin/login, /admin/logout
    guest.js              /, /tasks, /tasks/:id, /tasks/:id/submit, /me/edit
    community.js          /gallery, /leaderboard, /u/:guestId
    admin.js              /admin dashboard, guests + bulk create, qrsheet, tasks, awards, takedown, export
  services/
    photos.js             multer disk storage, sharp thumbnails/avatars, takedown/delete
    scoring.js            points, auto badges (5/10/15), special badges, leaderboard
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

- Manual pre-wedding walkthrough (step-by-step test plan): [`docs/test-plan.md`](docs/test-plan.md).
- Peak-load test harness and how to read a run: [`docs/loadtest.md`](docs/loadtest.md).
- Detailed build plan: [`PLAN/00-README.md`](PLAN/00-README.md) and the numbered files through `10-theme-and-art.md`.
- Architecture diagrams and walkthroughs: [`docs/architecture.md`](docs/architecture.md).
- Design rationale and tradeoffs: [`DESIGN.md`](DESIGN.md).
- Refactor roadmap: [`PLAN.md`](PLAN.md).
- How to contribute through the orchestrator pipeline (issue → review → implement → review → PR): [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
- What a green build actually proves, in plain English: [`WHAT-IT-CHECKS.md`](WHAT-IT-CHECKS.md).
