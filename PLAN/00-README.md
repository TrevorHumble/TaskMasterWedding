# Garden Party Pastels — Wedding Scavenger Hunt

> **Historical (hosting model changed 2026-07):** this document describes the original laptop + Cloudflare-tunnel deployment. Current hosting: see DESIGN.md § Hosted deployment and docs/deploy.md.

A self-contained web app for **Axel Fenwick & Lily Sckeiky's** wedding. About 100 guests, each on their own phone, play a photo scavenger hunt: they scan a QR code on their table place-card, sign in, and complete tasks by uploading photos. Each completed task earns a point, badges unlock automatically, and there's a public leaderboard and a shared photo gallery. A password-protected admin (the "Task Master") manages tasks, awards bonus points and special badges, hides any photo, and runs a one-click export (a ZIP of all photos + an Excel summary) after the wedding. The whole thing runs on the couple's Windows 11 laptop for the weekend and is made publicly reachable by a free Cloudflare tunnel — no paid signups, nothing to install in the cloud.

> **Who this plan is for:** a junior developer who has never seen this project. Read this file top to bottom first, then open each numbered plan file in order and do exactly what it says. Every file gives you complete, copy-paste-ready code. Do not improvise or swap libraries.

---

## What you get

- **QR sign-in, no passwords for guests.** Every guest has a unique private link with a random token. The admin prints those links as QR codes onto table place-cards. A guest scans, the link opens on their phone, and they're signed in on that device.
- **One shared task list.** The admin adds, edits, reorders, activates/deactivates, and removes tasks at any time from an admin screen. Every guest sees the same list.
- **Complete a task by uploading a photo.** One photo per task per guest = that task is done = +1 point.
- **Scoring.** 1 point per completed task, plus **bonus points** the admin can award by judgment. A public **leaderboard** ranks everyone.
- **Badges.** Three **auto** badges unlock at 5 / 10 / 15 completed tasks. **Four special badges** the admin hands out manually. The special badge set is **fixed at these four** (EARLYBIRD / SHUTTERBUG / CROWDFAV / CHOICE) — there is no admin screen to invent new badge types. Adding a fifth special badge means adding a new SVG in `src/public/badges/` and a matching seed row in `scripts/seed.js`, then re-seeding. This fixed set is accepted scope per the SPEC (the SPEC mandates "special badges the admin awards manually," not an admin-managed badge catalog); confirm the couple is happy with exactly these four before the event. All badges are visible to everyone, with placeholder pastel SVG art we design (seven SVGs total = three auto + four special).
- **Shared photo gallery.** One big gallery everyone can browse, with a lightbox. The admin can **take down** any photo (hides it from the gallery, profiles, and scoring) and **restore** it later.
- **Guest profiles.** Each guest has an avatar, name, their badges, their photo submissions, and optional social links so guests can connect. Guests can view each other's profiles.
- **Admin (Task Master) panel.** Password-protected (`ButtMonster`, stored hashed). Manage tasks; create guests and generate their links/QR codes; award bonus points and special badges; take photos down and restore them; see everyone's progress; one-click export.
- **One-click export.** A ZIP of all photos (one folder per guest) plus a `summary.xlsx` spreadsheet of who earned what. Trevor uploads photos to Flickr and sends an email blast afterward.
- **Garden Party Pastels theme.** Soft blush pink, sky blue, lavender, butter yellow, peach, sage green on warm cream. Hand-lettered script font for headings, clean rounded body font. Mobile-first, because every guest is on a phone.

---

## Architecture at a glance

### Tech stack

| Layer | Technology | Version | Why |
|---|---|---|---|
| Runtime | Node.js | 20 LTS | The required runtime; ships prebuilt binaries for all our native deps on Windows x64. |
| Web framework | Express | 4.21.2 | HTTP server, routing, middleware, static files, EJS rendering. Express **4** (not 5). |
| Database | better-sqlite3 | 12.2.0 | One SQLite file, accessed synchronously. Simple, fast, no separate DB server. Prebuilt for Node 20 / Windows x64. |
| Templates | EJS | 3.1.10 | Server-rendered HTML. No build step, no front-end framework. |
| Uploads | multer | 1.4.5-lts.1 | Parses photo uploads (memory storage, so sharp handles them before disk). |
| Images | sharp | 0.33.5 | Makes a normalized full-size original + a small thumbnail per photo. Prebuilt libvips for Windows. |
| QR codes | qrcode | 1.5.4 | Generates per-guest QR codes for the printable place-card sheet. |
| Admin password | bcryptjs | 2.4.3 | Hashes/verifies the single admin password. Pure JS — no compiler needed. |
| Cookies | cookie-parser | 1.4.7 | Signs the guest (`gsid`) and admin (`admin`) cookies that drive sign-in. |
| Export ZIP | archiver | 7.0.1 | Streams the export ZIP (one folder per guest) straight to the download. |
| Export Excel | exceljs | 4.4.0 | Writes the `summary.xlsx` points/badges/tasks workbook. |
| Tokens | Node built-in `crypto` | (built in) | Generates each guest's random sign-in token. |
| Tunnel | cloudflared | latest | Free public HTTPS URL pointing at the laptop. No account needed. |

The app listens on **port 3000**.

### Data-flow diagram

```
   Guest's phone                                The couple's Windows 11 laptop
  ┌───────────────┐                            ┌──────────────────────────────────────────┐
  │  Scans QR on  │                            │                                            │
  │  place-card,  │      https (public)        │   cloudflared  (Cloudflare quick tunnel)   │
  │  opens link → │ ─────────────────────────► │   https://<random>.trycloudflare.com       │
  │  browser      │                            │              │ forwards to                  │
  └───────────────┘                            │              ▼                              │
                                               │   Node.js 20 + Express 4  (http://localhost:3000) │
                                               │              │                              │
                                               │      EJS views ◄── routes ──► services       │
                                               │              │                              │
                                               │     ┌────────┴─────────┐                    │
                                               │     ▼                  ▼                    │
                                               │  better-sqlite3     photo folders           │
                                               │  data/app.db        data/uploads/ (originals)│
                                               │  (all records)      data/thumbs/  (thumbs)   │
                                               │                     data/exports/ (scratch)  │
                                               └──────────────────────────────────────────┘
```

Everything lives in the `data/` folder: the SQLite file plus the photo folders. Back up the app by copying `data/`.

### The config contract (read this before you touch any file)

`config.js` (built in **01-setup**) is the single source of truth for paths, secrets, and tuning constants. **Every other file reads its values from `config`**, so the key names in `config.js` and the key names every consumer reads **must match exactly**. We use **`UPPER_SNAKE_CASE`** for every exported key, with no exceptions:

```
DATA_DIR  DB_PATH  UPLOADS_DIR  THUMBS_DIR  EXPORTS_DIR  ADMIN_HASH_PATH
BASE_URL  COOKIE_SECRET  MAX_UPLOAD_BYTES  THUMB_WIDTH  ALLOWED_MIME
PORT  BADGE_THRESHOLDS  PUBLIC_DIR  VIEWS_DIR  ROOT
```

Who reads what (so you can sanity-check as you build): `db.js` (02) reads `config.DATA_DIR`, `config.DB_PATH`; `auth.js` (03) reads `config.MAX_UPLOAD_BYTES`, `config.ADMIN_HASH_PATH`, `config.COOKIE_SECRET`; the `app.js` add-block (03) reads `config.COOKIE_SECRET`; `photos.js` (05) reads `config.UPLOADS_DIR`, `config.THUMBS_DIR`; `admin.js` (08) and `community.js` (07) read `config.BASE_URL`; `export.js` (09) reads `config.UPLOADS_DIR`. The Express bootstrap `app.js` (01) reads `config.PORT`, `config.VIEWS_DIR`, `config.PUBLIC_DIR`, `config.UPLOADS_DIR`, `config.THUMBS_DIR`, `config.DATA_DIR`, `config.EXPORTS_DIR`, `config.COOKIE_SECRET`.

> **Do not use camelCase config keys.** If `config.js` exported `dataDir`/`dbPath`/`uploadsDir`/etc. instead, every consumer above would read `undefined` and the app would crash on boot (e.g. `new Database(undefined)` in `db.js`, `multer({ limits: { fileSize: undefined } })`, `fs` calls on `undefined` paths). The plan files are written to the `UPPER_SNAKE_CASE` contract — keep it.

---

## Prerequisites

Do these once on the couple's laptop (or your own machine to develop). All commands are **PowerShell**. PowerShell does not support `&&` chaining — run each command on its own line.

### 1. Install Node.js 20 LTS

Option A — official installer (simplest):

1. Open `https://nodejs.org/en/download` in a browser.
2. Download the **Windows Installer (.msi), 64-bit, LTS (20.x)**.
3. Run it, accept defaults, finish.
4. Close and reopen PowerShell so the new `PATH` takes effect.

Option B — winget (if you prefer the command line):

```powershell
winget install OpenJS.NodeJS.LTS
```

Verify (you should see a v20 line and an npm version):

```powershell
node -v
npm -v
```

Expected, for example:

```
v20.18.1
10.8.2
```

If `node -v` does not start with `v20`, you have the wrong version installed — uninstall it and install the 20 LTS line.

### 2. Install cloudflared (the tunnel)

Option A — winget (simplest):

```powershell
winget install --id Cloudflare.cloudflared
```

Option B — direct download:

1. Open `https://github.com/cloudflare/cloudflared/releases/latest`.
2. Download `cloudflared-windows-amd64.exe`.
3. Rename it to `cloudflared.exe` and put it in a folder on your `PATH` (for example `C:\Tools\cloudflared\`, then add that folder to `PATH`).

Verify:

```powershell
cloudflared --version
```

Expected, for example:

```
cloudflared version 2024.x.x ...
```

You do **not** need a Cloudflare account. We use the free "quick tunnel" mode, which requires no login.

---

## Complete file tree

This is the entire project. The tag in brackets tells you which plan file creates that item.

```
garden-party-pastels/
├── package.json                      [01-setup]
├── .gitignore                        [01-setup]
├── .env.example                      [01-setup]
├── config.js                         [01-setup]
├── scripts/
│   ├── set-admin-password.js         [01-setup]  (writes data/admin.hash via bcryptjs)
│   └── seed.js                       [02-database] (seeds canonical badges + sample tasks)
├── src/
│   ├── app.js                        [01-setup]  (express bootstrap: middleware, view engine, static mounts, mount routers, ensure data dirs, 404 + error handlers, listen on 3000)
│   ├── db.js                         [02-database] (open better-sqlite3, pragmas, create schema, export db + helpers)
│   ├── middleware/
│   │   └── session.js                [03-auth-and-links] (attachGuest, requireGuest, requireAdmin)
│   ├── services/
│   │   ├── qr.js                     [03-auth-and-links] (QR generation)
│   │   ├── photos.js                 [05-photos] (multer config, file filter, limits, sharp thumbnails, save/locate/hide/delete)
│   │   ├── scoring.js                [06-scoring-badges] (points calc, auto-badge grant/revoke, special badge, bonus, leaderboard query, threshold constants)
│   │   └── export.js                 [09-export] (archiver zip + exceljs summary.xlsx)
│   ├── routes/
│   │   ├── auth.js                   [03-auth-and-links] (GET /j/:token, onboarding, /admin/login, /admin/logout)
│   │   ├── guest.js                  [04-guest-experience] (GET /, /tasks, /tasks/:id, POST /tasks/:id/submit, GET/POST /me/edit)
│   │   ├── community.js              [07-gallery-leaderboard] (GET /gallery, /leaderboard, /u/:guestId)
│   │   └── admin.js                  [08-admin] (dashboard, guest CRUD + bulk, /admin/qrsheet, task CRUD/reorder/active, bonus, special badge, photo takedown/restore; GET /admin/export ADD-THIS snippet from 09-export)
│   ├── views/
│   │   ├── partials/
│   │   │   ├── head.ejs              [10-theme-and-art]  ← REQUIRED before any view renders
│   │   │   ├── header.ejs           [10-theme-and-art]  ← REQUIRED before any view renders
│   │   │   └── footer.ejs           [10-theme-and-art]  ← REQUIRED before any view renders
│   │   ├── onboard.ejs              [03-auth-and-links]
│   │   ├── admin-login.ejs          [03-auth-and-links]
│   │   ├── guest-home.ejs           [04-guest-experience]
│   │   ├── tasks.ejs                [04-guest-experience]
│   │   ├── task.ejs                 [04-guest-experience]
│   │   ├── me-edit.ejs             [04-guest-experience]
│   │   ├── gallery.ejs             [07-gallery-leaderboard]
│   │   ├── leaderboard.ejs         [07-gallery-leaderboard]
│   │   ├── public-profile.ejs      [07-gallery-leaderboard]
│   │   ├── admin-dashboard.ejs     [08-admin]
│   │   ├── admin-guests.ejs        [08-admin]
│   │   ├── admin-qrsheet.ejs       [08-admin]
│   │   ├── admin-tasks.ejs         [08-admin]
│   │   ├── admin-photos.ejs        [08-admin]
│   │   ├── 404.ejs                 [01-setup]  (self-contained — no partials)
│   │   └── error.ejs              [01-setup]  (self-contained — no partials)
│   └── public/
│       ├── css/
│       │   └── theme.css           [10-theme-and-art]
│       ├── js/
│       │   ├── upload.js           [04-guest-experience]
│       │   ├── gallery.js          [07-gallery-leaderboard]
│       │   └── admin.js            [08-admin]
│       └── badges/
│           ├── bloom.svg           [10-theme-and-art]  (auto, 5 tasks)
│           ├── bouquet.svg         [10-theme-and-art]  (auto, 10 tasks)
│           ├── garden.svg          [10-theme-and-art]  (auto, 15 tasks)
│           ├── earlybird.svg       [10-theme-and-art]  (special, manual)
│           ├── shutterbug.svg      [10-theme-and-art]  (special, manual)
│           ├── crowdfav.svg        [10-theme-and-art]  (special, manual)
│           └── choice.svg          [10-theme-and-art]  (special, manual)
└── data/                             [01-setup creates on boot; gitignored]
    ├── app.db                        (better-sqlite3 file; created by db.js)
    ├── admin.hash                    (bcrypt hash; created by set-admin-password.js)
    ├── uploads/                      (sharp-written full-size originals)
    ├── thumbs/                       (sharp-written thumbnails)
    └── exports/                      (scratch space for export builds, if needed)
```

---

## MASTER BUILD ORDER

> **Read this first — it determines whether your pages render at all.**
> Almost every view (onboard, admin-login, guest-home, tasks, task, me-edit, gallery, leaderboard, public-profile, and all five admin views) starts with `<%- include('partials/head') %>` and ends with `<%- include('partials/footer') %>`. **EJS `include()` throws a hard error and returns HTTP 500 if the included file does not exist** — it does **not** silently skip a missing partial. So the three partials from section 10 (`head.ejs`, `header.ejs`, `footer.ejs`) are a **hard prerequisite** for every page that includes them. The only self-contained views are `404.ejs` and `error.ejs` (built in 01), which include no partials.
>
> **Therefore: build section 10 steps 2–5 (the three partials + `theme.css`) right after section 01, *before* you run any view-rendering acceptance check in sections 03–08.** Then build the logic sections 02–09 in order. The badge SVGs (the rest of section 10) can wait until the end — they are static assets, not partials, and nothing `include()`s them. The build order below reflects this.

Open each plan file in this order and complete it fully before moving on. After each step, the "works now" line tells you what should function so you can confirm progress.

1. **`01-setup.md`** — Create `package.json`, install all dependencies, write `.gitignore`, `.env.example`, `config.js` (UPPER_SNAKE_CASE keys — see "The config contract" above), the Express bootstrap `src/app.js`, the `404.ejs`/`error.ejs` views, and `scripts/set-admin-password.js`.
   *Works now:* `npm start` boots the server on port 3000, the `data/` folders are created, and visiting an unknown URL shows the 404 page (it is self-contained, so it renders even with no partials yet). Admin password hash is written.

2. **`10-theme-and-art.md` — steps 2–5 only (partials + theme.css), done early.** Write the `head.ejs` / `header.ejs` / `footer.ejs` partials and `src/public/css/theme.css`. **Skip the seven badge SVGs for now** (do them last, in step 11). This step is pulled forward because EVERY view in 03–08 `include()`s these partials and will 500 without them.
   *Works now:* the partials exist, so any page rendered in later sections will return HTML (and be themed) instead of throwing "Could not find include partials/head".

3. **`02-database.md`** — Write `src/db.js` (open the SQLite file, set pragmas, create all five tables) and `scripts/seed.js` (insert the seven canonical badges — three auto + the fixed four special — plus sample tasks).
   *Works now:* running the seed creates `data/app.db` with all tables, the badge catalog, and sample tasks.

4. **`03-auth-and-links.md`** — Write `src/middleware/session.js` (attachGuest / requireGuest / requireAdmin), `src/services/qr.js`, `src/routes/auth.js`, and the `onboard.ejs` + `admin-login.ejs` views.
   *Works now:* a guest link `/j/<token>` signs you in via a cookie and shows onboarding; the admin can log in at `/admin/login`. **These pages render only because you built the partials in step 2** — without them they would 500.

5. **`04-guest-experience.md`** — Write `src/routes/guest.js`, the `guest-home.ejs`, `tasks.ejs`, `task.ejs`, `me-edit.ejs` views, and `src/public/js/upload.js`.
   *Works now:* a signed-in guest sees their home, the task list, and a single task with a photo-upload form, and can edit their profile. (Upload save lands fully in step 6.)

6. **`05-photos.md`** — Write `src/services/photos.js` (multer config, file filter/limits, sharp originals + thumbnails, save/locate/hide/delete).
   *Works now:* uploading a photo to a task saves an original + thumbnail, creates the submission row, and marks the task complete.

7. **`06-scoring-badges.md`** — Write `src/services/scoring.js` (points calc, auto-badge grant/revoke at 5/10/15, special-badge + bonus award, leaderboard query, threshold constants).
   *Works now:* points are computed correctly, auto badges appear at 5/10/15 completed tasks, and the leaderboard query returns ranked guests.

8. **`07-gallery-leaderboard.md`** — Write `src/routes/community.js`, the `gallery.ejs`, `leaderboard.ejs`, `public-profile.ejs` views, and `src/public/js/gallery.js`.
   *Works now:* anyone can browse the shared gallery (with lightbox), the public leaderboard, and any guest's public profile.

9. **`08-admin.md`** — Write `src/routes/admin.js`, the `admin-dashboard.ejs`, `admin-guests.ejs`, `admin-qrsheet.ejs`, `admin-tasks.ejs`, `admin-photos.ejs` views, and `src/public/js/admin.js`.
   *Works now:* the admin can manage tasks, create guests, view the printable QR sheet, award bonus points + special badges (from the fixed four), and take photos down / restore them.

10. **`09-export.md`** — Write `src/services/export.js` and add the `GET /admin/export` route snippet into `src/routes/admin.js`.
    *Works now:* one admin click downloads a ZIP of all photos (one folder per guest) plus `summary.xlsx`.

11. **`10-theme-and-art.md` — the seven badge SVGs (finish what you skipped in step 2).** Write the seven badge SVGs in `src/public/badges/` (three auto: `bloom`, `bouquet`, `garden`; four special: `earlybird`, `shutterbug`, `crowdfav`, `choice`).
    *Works now:* badges render as pastel art everywhere they appear. The app is complete.

> **Why step 2 is pulled forward:** the partials and theme from section 10 are referenced by every view's `include(...)` calls in steps 4–9. Because EJS `include()` errors on a missing file (it does **not** silently skip it), those pages would all 500 if you left section 10 for last. Building the three partials + `theme.css` right after step 1 makes every view-rendering acceptance check in steps 4–9 pass — and your pages are styled as you go. The badge SVGs are plain static files that nothing includes, so they're safe to leave for the very end (step 11).

---

## Running it locally

Full detail is in **`01-setup.md`**. The headline commands, run from the project root in PowerShell:

```powershell
npm install
node scripts/set-admin-password.js ButtMonster
node scripts/seed.js
npm start
```

Then open `http://localhost:3000` in a browser. To reach the admin, go to `http://localhost:3000/admin/login` and enter `ButtMonster`.

---

## Going live for the wedding (Cloudflare tunnel + keep-awake)

Full detail is in **`01-setup.md`**. The headline steps on the day:

1. Start the app in one PowerShell window:

   ```powershell
   npm start
   ```

2. In a **second** PowerShell window, start the free tunnel:

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

   cloudflared prints a line like `https://<random-words>.trycloudflare.com`. That public URL is what guests reach. Generate the QR place-cards against this URL (see `08-admin.md`'s QR sheet and set `BASE_URL` to the tunnel URL — covered in `01-setup.md`).

3. Keep the laptop from sleeping (run PowerShell **as Administrator**, once):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change monitor-timeout-ac 0
   ```

---

## Day-of-event runbook

1. **Plug the laptop in** (the keep-awake settings only apply on AC power) and connect to reliable internet.
2. **Disable sleep** (as Administrator, once):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change monitor-timeout-ac 0
   ```

3. **Start the app** (window 1):

   ```powershell
   npm start
   ```

   You should see a line confirming it is listening on port 3000.
4. **Start the tunnel** (window 2):

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

   **Confirm the tunnel URL:** copy the `https://<random>.trycloudflare.com` line cloudflared prints. Open it on a phone to confirm the app loads. This is the URL the QR codes must point to.
   > Note: a free quick-tunnel URL is **random and changes every time cloudflared restarts**. Start the tunnel and lock in the URL **before** you generate/print the QR place-cards. If you must restart the tunnel after printing, the old QR codes will break — avoid restarting once cards are printed.
5. **Where photos land:** every uploaded photo is saved on the laptop under:
   - originals: `garden-party-pastels\data\uploads\`
   - thumbnails: `garden-party-pastels\data\thumbs\`

   All records (guests, tasks, points, badges) live in `garden-party-pastels\data\app.db`.
6. **Back up during the event:** copy the whole `data` folder to a USB drive or another folder. The `data\` folder is the entire app state.

   ```powershell
   Copy-Item -Recurse -Path .\data -Destination ".\data-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
   ```

7. **If it crashes or freezes:** in the app window press `Ctrl+C` to stop it (if it's still responsive), then restart:

   ```powershell
   npm start
   ```

   The database and photos are safe on disk, so guests just continue. If the **tunnel** window died, restart it too (window 2) — but remember the URL may change (see step 4). If the app window is fully frozen, close that PowerShell window, open a new one in the project folder, and run `npm start` again.

---

## After the wedding

1. With the app running (`npm start`), log in to the admin at `/admin/login`.
2. Click **Export** (the `GET /admin/export` action). Your browser downloads a ZIP containing one folder per guest with their original photos, plus `summary.xlsx` (points / badges / tasks per guest). Detail is in **`09-export.md`**.
3. Trevor uploads the photos to Flickr and sends the email blast.
4. **Teardown:** stop the tunnel and the app (`Ctrl+C` in each window). Make a final copy of the `data\` folder for safekeeping. Optionally restore the laptop's sleep settings:

   ```powershell
   powercfg /change standby-timeout-ac 30
   powercfg /change monitor-timeout-ac 10
   ```

---

## Glossary

Plain-language definitions of every technical term used across the plan.

- **Node.js** — the program that runs our JavaScript app on the laptop (no browser needed). We use version 20 LTS.
- **LTS** — "Long-Term Support": the stable, supported release line of a piece of software.
- **npm** — Node's package installer; `npm install` downloads the libraries the app depends on.
- **Express** — the web framework that handles incoming web requests and sends back pages.
- **route / router** — the code that says "when someone visits this URL, do this." A router groups related routes.
- **middleware** — a small function that runs on every request before the route, e.g. to check if you're signed in.
- **EJS** — a templating language: HTML files with little bits of code that fill in data (names, points) before sending the page.
- **partial** — a reusable chunk of a page (header, footer) included into many pages so you write it once. In EJS, `include('partials/head')` **errors with HTTP 500 if the partial file is missing** — it does not skip it — which is why the three partials must exist before any page that uses them renders.
- **SQLite** — a database that lives in a single file on disk; no separate database server to run.
- **better-sqlite3** — the library that lets our app read and write that SQLite file, synchronously (one step at a time).
- **pragma** — a SQLite setting (like turning on safety or foreign-key checks) you set when opening the database.
- **schema** — the definition of the database's tables and columns.
- **foreign key** — a column that points at a row in another table (e.g. a submission points at its guest), keeping data linked.
- **config contract** — the agreement that `config.js` exports specific UPPER_SNAKE_CASE keys (`DATA_DIR`, `DB_PATH`, `UPLOADS_DIR`, etc.) and every other file reads those exact names. Mismatched casing = `undefined` values = crash on boot. See "The config contract" above.
- **token** — a long random string that acts as a guest's secret key in their personal link. Knowing the token = being that guest.
- **QR code** — the square barcode on a place-card; scanning it with a phone camera opens the guest's link.
- **cookie** — a small piece of data the browser stores and sends back on each visit, so the site remembers who you are.
- **signed cookie** — a cookie stamped with a secret so the server can tell it wasn't tampered with. Our guest cookie is `gsid`, admin cookie is `admin`.
- **COOKIE_SECRET** — the secret string used to sign cookies. Set it in `.env`; if missing, the app makes a random one (which logs everyone out on restart).
- **session** — the state of being signed in, tracked here purely by the signed cookie (no server-side session store).
- **onboarding** — the first-time form a guest fills in (name, avatar, optional social links) right after scanning their QR.
- **avatar** — a guest's small profile picture.
- **bcrypt / bcryptjs** — a way to scramble a password so it can be checked but never read back. We use the pure-JavaScript `bcryptjs` so no compiler is needed.
- **hash** — the scrambled, one-way version of a secret (like the admin password). Stored in `data/admin.hash`.
- **multer** — the library that receives uploaded files from a web form.
- **memory storage** — multer keeps the uploaded file in memory briefly so sharp can process it before anything is written to disk.
- **sharp** — the image library that resizes/normalizes each photo and makes a small thumbnail.
- **thumbnail** — a small version of a photo used in gallery grids so pages load fast.
- **lightbox** — the pop-up overlay that shows a photo full-size when you tap a thumbnail.
- **MIME type** — the label for a file's kind (e.g. `image/jpeg`); we only accept image types.
- **static files** — files served as-is (CSS, client JS, badge art, uploaded photos) without templating.
- **leaderboard** — the public ranking of guests by points.
- **auto badge** — a badge granted automatically at 5/10/15 completed tasks (awarded_by = system).
- **special badge** — a badge the admin hands out by judgment (awarded_by = admin), no threshold. The set is **fixed at four** (EARLYBIRD / SHUTTERBUG / CROWDFAV / CHOICE); there is no admin UI to add badge types.
- **threshold** — the number of completed tasks that unlocks an auto badge (5, 10, or 15).
- **take down / restore** — admin hides a photo (removes it from gallery, profiles, and scoring) or un-hides it. The file stays on disk so it's still in the export.
- **bonus points** — extra points the admin awards on top of completed-task points.
- **export** — the one-click download: a ZIP of all photos (one folder per guest) plus an Excel summary.
- **ZIP** — a single compressed file bundling many files/folders.
- **archiver** — the library that builds the export ZIP and streams it straight to the download.
- **exceljs** — the library that writes the `summary.xlsx` Excel spreadsheet.
- **.xlsx** — the modern Excel spreadsheet file format.
- **cloudflared** — Cloudflare's small program that opens a tunnel from the public internet to the laptop.
- **tunnel (quick tunnel)** — a temporary, free, account-less public web address that forwards visitors to the app on the laptop.
- **port** — a numbered "door" on the laptop where the app listens. Ours is 3000.
- **BASE_URL** — the address the QR codes/links are built from (the tunnel URL during the event).
- **PowerShell** — the Windows command-line shell we type commands into.
- **PATH** — the list of folders Windows searches for programs you type by name (like `node` or `cloudflared`).
- **flash message** — a one-time notice (e.g. "Saved!") shown after an action, then cleared.
- **CRUD** — Create, Read, Update, Delete: the basic operations for managing records (tasks, guests).
- **seed** — pre-fill the database with starting data (the badge catalog and sample tasks).
- **CSS custom properties (variables)** — named colors/values defined once in CSS and reused everywhere, so the theme is consistent.

---

## Requirements coverage

Every SPEC feature mapped to the plan file(s) that implement it. Nothing is dropped.

| SPEC feature | Implemented in |
|---|---|
| Mobile-first guest UI on phones | 04-guest-experience, 10-theme-and-art |
| Unique private guest link with random token | 02-database (token column), 03-auth-and-links (`/j/:token`) |
| Printable QR codes for place-cards | 03-auth-and-links (qr.js), 08-admin (`/admin/qrsheet`) |
| QR scan signs guest in on their device | 03-auth-and-links (signed `gsid` cookie) |
| No guest passwords, no email server | 03-auth-and-links (token + cookie only) |
| Admin defines/edits tasks any time, one shared list, any number | 02-database (tasks table), 08-admin (task CRUD/reorder/active) |
| Complete a task by uploading one photo (per task per guest) | 02-database (UNIQUE guest+task), 04-guest-experience (submit), 05-photos |
| 1 point per completed task | 06-scoring-badges |
| Admin bonus points | 06-scoring-badges, 08-admin (`/admin/guests/:id/bonus`) |
| Public leaderboard | 06-scoring-badges (query), 07-gallery-leaderboard |
| 3 auto badges at 5/10/15 | 06-scoring-badges (thresholds + grant/revoke), 02-database (seed via 02), 10-theme-and-art (art) |
| Special badges awarded by hand (fixed set of four) | 06-scoring-badges, 08-admin (`/admin/guests/:id/badge`); the four are seeded in 02-database and arted in 10-theme-and-art. Adding more requires a new SVG + seed row (no admin UI) |
| All badges visible to everyone | 04-guest-experience, 07-gallery-leaderboard |
| Placeholder pastel SVG badge art (7 SVGs: 3 auto + 4 special) | 10-theme-and-art |
| ~15 photos/guest, ~1500 total, stored on local disk | 05-photos (data/uploads + data/thumbs) |
| Photos downloadable/exportable | 09-export |
| One shared gallery everyone sees | 07-gallery-leaderboard (gallery + gallery.js) |
| Admin can take down any photo (hide from gallery/profiles/points) | 02-database (taken_down), 06-scoring-badges (filter), 07 (filter), 08-admin (takedown/restore) |
| Guest profile: avatar, name, badges, submissions, optional social links | 02-database (guests columns), 04-guest-experience (own), 07-gallery-leaderboard (public) |
| Guests view each other's profiles | 07-gallery-leaderboard (`/u/:guestId`) |
| Password-protected admin, password `ButtMonster` hashed with bcryptjs | 01-setup (set-admin-password.js), 03-auth-and-links (login) |
| Admin: task add/edit/remove | 08-admin |
| Admin: create guests, generate links/QR | 08-admin, 03-auth-and-links |
| Admin: award bonus points, award special badges | 06-scoring-badges, 08-admin |
| Admin: take down/restore photos | 08-admin |
| Admin: see everyone's progress | 08-admin (dashboard) |
| One-click export: ZIP (folder per guest) + summary.xlsx | 09-export, 08-admin (`/admin/export`) |
| Hosting on Windows 11 laptop, Cloudflare quick tunnel, keep-awake | 00-README (runbook), 01-setup |
| Cheap/free, zero paid signups | 00-README, 01-setup (cloudflared no account) |
| Garden Party Pastels theme, Google Fonts (script + rounded) | 10-theme-and-art |
| Required stack & single SQLite file, self-contained | All files; foundation contract pins versions + config keys |

---

## Acceptance check

You have read and understood this README when all of the following are true. (These verify the README's own prerequisites and orientation — each plan file has its own acceptance check for its code.)

1. Run in PowerShell:

   ```powershell
   node -v
   npm -v
   cloudflared --version
   ```

   **Expected:** `node -v` prints a `v20.x` line; `npm -v` prints a version; `cloudflared --version` prints a version. If any command is "not recognized," revisit **Prerequisites**.

2. You can state, without looking, the order to build the plan files — and the one re-ordering that matters: build **01-setup**, then **section 10's three partials + theme.css early**, then the logic sections in order: `02-database` → `03-auth-and-links` → `04-guest-experience` → `05-photos` → `06-scoring-badges` → `07-gallery-leaderboard` → `08-admin` → `09-export`, finishing with **section 10's seven badge SVGs** last. You can explain *why* the partials come early: EJS `include()` errors (HTTP 500) on a missing partial, so every view in 03–08 needs `head.ejs`/`header.ejs`/`footer.ejs` to exist first.

3. You know the config-key rule: `config.js` exports **UPPER_SNAKE_CASE** keys (`DATA_DIR`, `DB_PATH`, `UPLOADS_DIR`, `THUMBS_DIR`, `EXPORTS_DIR`, `ADMIN_HASH_PATH`, `BASE_URL`, `COOKIE_SECRET`, `MAX_UPLOAD_BYTES`, `THUMB_WIDTH`, ...) and every consumer reads those exact names — camelCase would crash the app on boot.

4. You can point to where photos are stored on the laptop (`data\uploads\` for originals, `data\thumbs\` for thumbnails) and how to back the app up (copy the `data\` folder).

5. You know the two commands that bring the app online for the wedding (`npm start`, then `cloudflared tunnel --url http://localhost:3000` in a second window) and that the printed `trycloudflare.com` URL is what the QR codes must target.

6. You know the special badge set is **fixed at four** (EARLYBIRD / SHUTTERBUG / CROWDFAV / CHOICE) with no admin UI to add more, and that adding a fifth means a new SVG + seed row.

When all six hold, proceed to **`01-setup.md`**.
