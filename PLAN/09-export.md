# 09 — One-click export (zip of photos + xlsx) and teardown

> **Historical (hosting model changed 2026-07):** this document describes the original laptop + Cloudflare-tunnel deployment. Current hosting: see DESIGN.md § Hosted deployment and docs/deploy.md.

This section gives you the complete export service for **Garden Party Pastels**. One admin click downloads a single ZIP file that contains:

1. **One folder per guest** holding that guest's **original full-size photos**.
2. A top-level **`summary.xlsx`** spreadsheet with three sheets (Guests, Submissions, Badges).

It also gives you the `GET /admin/export` route to drop into `src/routes/admin.js`, a teardown/keepsake handoff for Trevor (back up the data folder, then Flickr upload + email blast), and an acceptance check.

You will create exactly one new file in this section: **`src/services/export.js`**. Everything else is an "ADD THIS" block into a file owned by another section.

---

## 0. Design decisions (already made for you — do not change them)

- **Taken-down photos ARE included in the ZIP.** The whole point of export is "nothing is lost so Trevor can upload to Flickr." A photo the admin hid from the public gallery is still a real photo someone took at the wedding. So the ZIP contains **every** original on disk. The `summary.xlsx` Submissions sheet has a `taken_down` column so Trevor can see which ones were hidden, but the image files themselves are all there.
- **The ZIP streams directly to the browser.** We do NOT build the ZIP into a temp file first. `archiver` writes the compressed bytes straight into the HTTP response as it goes, so ~1500 photos never sit in memory at once. (The `data/exports/` folder from the file tree exists as optional scratch space; this implementation does not need it.)
- **`summary.xlsx` is built fully in memory** with `exceljs` (one small spreadsheet, a few hundred rows max — tiny), turned into a Buffer, then appended to the archive. This is the simplest reliable ordering: the spreadsheet finishes before we call `finalize()`.
- **Folder names and file names are "sanitized".** Guest names and task titles can contain spaces, slashes, emoji, etc. Those characters break file paths. We strip them down to safe characters so the ZIP unzips cleanly on Windows.
- **Photo points / completed-task counts in the spreadsheet EXCLUDE taken-down photos** (a hidden photo does not score), matching the scoring rules from section 06. The ZIP still contains the image files regardless.

---

## 1. What the service needs from the database

The service reads directly from the SQLite database using the synchronous `better-sqlite3` handle exported by `src/db.js` (section 02). It uses these tables exactly as defined in the Foundation Contract: `guests`, `tasks`, `submissions`, `badges`, `guest_badges`.

It also reads the originals from disk at `config.UPLOADS_DIR` (the `data/uploads/` folder). Each `submissions.photo_path` stores **only the filename** (e.g. `3-7-1719500000000.jpg`), so the full path is `path.join(config.UPLOADS_DIR, photo_path)`.

> **Config casing (must match section 01).** `export.js` reads `config.UPLOADS_DIR` (UPPER_SNAKE_CASE). `config.js` MUST export that key in the exact same casing. If `config.js` instead exports a camelCase `uploadsDir`, then `config.UPLOADS_DIR` is `undefined`, `path.join(undefined, photo_path)` throws, and **every** photo append into the ZIP fails — the per-guest folders come out empty. This is the same root cause as the project-wide config-casing bug: resolve it by standardizing `config.js` on UPPER_SNAKE_CASE keys (`UPLOADS_DIR`, etc.). You can confirm the resolution with acceptance step 8 below — the ZIP must contain real photo files; if the per-guest folders are empty, `config.UPLOADS_DIR` is resolving to `undefined`.

---

## 2. Create the file `src/services/export.js`

Create this file exactly as shown. It exports one function, `streamExportZip(res)`, which the admin route calls.

```js
// src/services/export.js
'use strict';

const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const ExcelJS = require('exceljs');

const config = require('../../config');
const { db } = require('../db');

/**
 * Auto-badge completed-task thresholds, kept here as plain numbers so this
 * service has no hard dependency on scoring.js load order. These match the
 * canonical thresholds (5 / 10 / 15) from the Foundation Contract.
 */
const AUTO_THRESHOLDS = [5, 10, 15];

/**
 * Turn any guest name / task title into something safe to use as a file or
 * folder name on Windows (and everywhere else).
 *  - keeps letters, numbers, space, dash, underscore, dot
 *  - replaces every other character with a dash
 *  - collapses runs of dashes/spaces, trims them off the ends
 *  - falls back to a default if the result is empty
 */
function safeName(input, fallback) {
  const raw = (input == null ? '' : String(input));
  let cleaned = raw
    .replace(/[^A-Za-z0-9 _.-]+/g, '-') // disallowed chars -> dash
    .replace(/[\s-]+/g, '-')            // collapse spaces/dashes
    .replace(/^[.\-]+|[.\-]+$/g, '');   // trim leading/trailing dot or dash
  if (!cleaned) cleaned = fallback;
  // Keep names short enough to avoid Windows path-length problems.
  if (cleaned.length > 60) cleaned = cleaned.slice(0, 60);
  return cleaned;
}

/**
 * Get a file extension (including the leading dot, lowercased) from a stored
 * photo filename. Defaults to .jpg because sharp writes JPEGs.
 */
function extOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext || '.jpg';
}

/**
 * Format an ISO-ish datetime string (stored as datetime('now')) for display.
 * If parsing fails we just return the raw stored string.
 */
function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Build the summary.xlsx workbook entirely in memory and return it as a Buffer.
 * Three sheets: Guests, Submissions, Badges.
 */
async function buildSummaryBuffer() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Garden Party Pastels';
  workbook.created = new Date();

  // ---- Pull data once -----------------------------------------------------

  const guests = db
    .prepare('SELECT id, name, bonus_points, social_links, created_at FROM guests ORDER BY id')
    .all();

  const tasks = db
    .prepare('SELECT id, title, sort_order FROM tasks ORDER BY sort_order, id')
    .all();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const submissions = db
    .prepare(
      'SELECT s.id, s.guest_id, s.task_id, s.caption, s.taken_down, s.created_at ' +
        'FROM submissions s ORDER BY s.guest_id, s.task_id'
    )
    .all();

  const badges = db
    .prepare('SELECT id, code, name, type, threshold, description FROM badges ORDER BY id')
    .all();
  const badgeById = new Map(badges.map((b) => [b.id, b]));

  const guestBadges = db
    .prepare('SELECT guest_id, badge_id, awarded_by FROM guest_badges')
    .all();

  // ---- Pre-compute per-guest aggregates -----------------------------------

  // completed tasks = submissions that are NOT taken down (one per guest+task
  // is guaranteed by the UNIQUE(guest_id,task_id) constraint).
  const completedByGuest = new Map(); // guestId -> count
  for (const s of submissions) {
    if (s.taken_down === 1) continue;
    completedByGuest.set(s.guest_id, (completedByGuest.get(s.guest_id) || 0) + 1);
  }

  const badgeNamesByGuest = new Map(); // guestId -> [badge name, ...]
  for (const gb of guestBadges) {
    const badge = badgeById.get(gb.badge_id);
    if (!badge) continue;
    if (!badgeNamesByGuest.has(gb.guest_id)) badgeNamesByGuest.set(gb.guest_id, []);
    badgeNamesByGuest.get(gb.guest_id).push(badge.name);
  }

  // ---- Sheet 1: Guests ----------------------------------------------------

  const guestsSheet = workbook.addWorksheet('Guests');
  guestsSheet.columns = [
    { header: 'Guest ID', key: 'id', width: 10 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Completed Tasks', key: 'completed', width: 16 },
    { header: 'Bonus Points', key: 'bonus', width: 14 },
    { header: 'Total Points', key: 'total', width: 14 },
    { header: 'Badges', key: 'badges', width: 50 },
    { header: 'Social Links', key: 'social', width: 40 },
  ];
  guestsSheet.getRow(1).font = { bold: true };

  for (const g of guests) {
    const completed = completedByGuest.get(g.id) || 0;
    const bonus = g.bonus_points || 0;
    const total = completed + bonus; // 1 point per completed task + bonus
    const names = (badgeNamesByGuest.get(g.id) || []).join(', ');

    // social_links is a JSON object string; show it as "key: value" pairs.
    let socialText = '';
    try {
      const obj = JSON.parse(g.social_links || '{}');
      socialText = Object.keys(obj)
        .filter((k) => obj[k])
        .map((k) => `${k}: ${obj[k]}`)
        .join('; ');
    } catch (e) {
      socialText = '';
    }

    guestsSheet.addRow({
      id: g.id,
      name: g.name || '(no name yet)',
      completed,
      bonus,
      total,
      badges: names,
      social: socialText,
    });
  }

  // ---- Sheet 2: Submissions ----------------------------------------------

  const subsSheet = workbook.addWorksheet('Submissions');
  subsSheet.columns = [
    { header: 'Guest ID', key: 'guestId', width: 10 },
    { header: 'Guest', key: 'guest', width: 28 },
    { header: 'Task', key: 'task', width: 40 },
    { header: 'Caption', key: 'caption', width: 40 },
    { header: 'Date', key: 'date', width: 22 },
    { header: 'Taken Down', key: 'takenDown', width: 12 },
  ];
  subsSheet.getRow(1).font = { bold: true };

  const guestById = new Map(guests.map((g) => [g.id, g]));

  for (const s of submissions) {
    const g = guestById.get(s.guest_id);
    const t = taskById.get(s.task_id);
    subsSheet.addRow({
      guestId: s.guest_id,
      guest: g ? g.name || '(no name yet)' : `#${s.guest_id}`,
      task: t ? t.title : `Task #${s.task_id}`,
      caption: s.caption || '',
      date: fmtDate(s.created_at),
      takenDown: s.taken_down === 1 ? 'YES' : 'no',
    });
  }

  // ---- Sheet 3: Badges ----------------------------------------------------

  const badgesSheet = workbook.addWorksheet('Badges');
  badgesSheet.columns = [
    { header: 'Code', key: 'code', width: 14 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Type', key: 'type', width: 10 },
    { header: 'Threshold', key: 'threshold', width: 12 },
    { header: 'Description', key: 'description', width: 50 },
  ];
  badgesSheet.getRow(1).font = { bold: true };

  for (const b of badges) {
    badgesSheet.addRow({
      code: b.code,
      name: b.name,
      type: b.type,
      threshold: b.threshold == null ? '' : b.threshold,
      description: b.description || '',
    });
  }

  // ---- Serialize to a Buffer ---------------------------------------------

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Build the export ZIP and stream it to the Express response as a download.
 * The response gets Content-Disposition: attachment so the browser saves it.
 *
 * Layout inside the ZIP:
 *   summary.xlsx
 *   <SafeName>-<id>/task-<sortorder>-<safeTaskTitle>.<ext>
 *   ...
 *
 * ALL originals are included (taken-down photos too) so nothing is lost.
 */
async function streamExportZip(res) {
  // Filename like garden-party-export-2026-06-27.zip
  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `garden-party-export-${stamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  // If archiving fails, surface it. Once headers/data have started streaming we
  // can't send a clean error page, so we just destroy the socket; if it fails
  // before any bytes were sent, send a 500.
  archive.on('error', (err) => {
    console.error('[export] archive error:', err);
    if (res.headersSent) {
      res.destroy(err);
    } else {
      res.status(500).send('Export failed. See server console.');
    }
  });

  // 'warning' fires for non-fatal issues (e.g. a stat failure). Log and continue.
  archive.on('warning', (err) => {
    console.warn('[export] archive warning:', err);
  });

  // Pipe the archive bytes straight into the HTTP response.
  archive.pipe(res);

  // 1) Build the spreadsheet first and add it at the top level.
  const summaryBuffer = await buildSummaryBuffer();
  archive.append(summaryBuffer, { name: 'summary.xlsx' });

  // 2) Add every guest's original photos into a per-guest folder.
  const guests = db.prepare('SELECT id, name FROM guests ORDER BY id').all();

  const tasks = db
    .prepare('SELECT id, title, sort_order FROM tasks ORDER BY sort_order, id')
    .all();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Pull ALL submissions (taken-down included) grouped by guest.
  const subsStmt = db.prepare(
    'SELECT id, task_id, photo_path FROM submissions WHERE guest_id = ? ORDER BY task_id'
  );

  for (const g of guests) {
    const folder = `${safeName(g.name, 'guest')}-${g.id}`;
    const subs = subsStmt.all(g.id);

    for (const s of subs) {
      const sourcePath = path.join(config.UPLOADS_DIR, s.photo_path);

      // Skip silently if the file is missing on disk (keeps export robust).
      if (!fs.existsSync(sourcePath)) {
        console.warn(`[export] missing original on disk, skipping: ${sourcePath}`);
        continue;
      }

      const task = taskById.get(s.task_id);
      const sortOrder = task ? task.sort_order : 0;
      const titlePart = safeName(task ? task.title : `task-${s.task_id}`, `task-${s.task_id}`);
      const ext = extOf(s.photo_path);

      // e.g. Lily-Sckeiky-3/task-2-Find-the-cake.jpg
      const entryName = `${folder}/task-${sortOrder}-${titlePart}${ext}`;

      archive.append(fs.createReadStream(sourcePath), { name: entryName });
    }
  }

  // 3) Done adding entries — finalize. This flushes the rest to the response.
  await archive.finalize();
}

module.exports = { streamExportZip, buildSummaryBuffer, safeName };
```

### Why the code looks the way it does (read this so you understand it)

- **`require('../db')`** returns `{ db }` — the open `better-sqlite3` connection. All queries are synchronous: `.prepare(sql).all()` / `.get()` / `.run()`. There is no `await` on database calls.
- **`require('../../config')`** — `export.js` lives at `src/services/export.js`, so `config.js` at the project root is two folders up.
- **`config.UPLOADS_DIR` must be UPPER_SNAKE_CASE in `config.js`.** This service joins it with each stored filename. If `config.js` exports it under any other casing (e.g. `uploadsDir`), `config.UPLOADS_DIR` is `undefined` and `path.join(undefined, ...)` throws on the first photo, so the ZIP comes out with empty guest folders. Keep `config.js` standardized on UPPER_SNAKE_CASE keys.
- **`buildSummaryBuffer()` is `async`** only because `workbook.xlsx.writeBuffer()` returns a Promise. The data-gathering above it is all synchronous SQLite.
- **`archive.append(fs.createReadStream(path), { name })`** adds one file at a path you choose inside the ZIP. The `name` includes the folder, so `archiver` creates the folder automatically.
- **`archive.append(buffer, { name })`** adds an in-memory buffer (the spreadsheet) as a file.
- **`archive.pipe(res)` then `await archive.finalize()`** is the correct order: pipe first so bytes flow as they're produced, add all entries, then finalize to close the ZIP.
- **Two photos for the same guest can never collide** because `task_id` is unique per guest (the `UNIQUE(guest_id,task_id)` constraint), and the filename includes the task's sort order + sanitized title. (If two tasks somehow had identical titles and the same sort order, the ZIP would still be valid — archiver tolerates duplicate entry names — but this cannot happen for a single guest because each guest has at most one submission per task.)

---

## 3. ADD THIS to `src/routes/admin.js` — the `GET /admin/export` route

`src/routes/admin.js` is owned by section 08 (admin). Do **not** rewrite that file. Open it and make the two additions below.

### 3a. ADD THIS near the top of `src/routes/admin.js`, with the other `require` lines

```js
// src/routes/admin.js  (ADD THIS with the other requires at the top)
const { streamExportZip } = require('../services/export');
```

### 3b. ADD THIS as a new route inside `src/routes/admin.js`

Place it anywhere among the other admin routes, after `requireAdmin` is already applied to the router (section 08 applies `router.use(requireAdmin)` so every admin route is protected — this one is too). It must come **before** the final `module.exports = router;` line.

```js
// src/routes/admin.js  (ADD THIS as a new route, before module.exports = router)
//
// GET /admin/export
// One-click export: streams a ZIP (per-guest photo folders) plus summary.xlsx.
// Protected by requireAdmin (applied to this router in 08-admin).
router.get('/export', async (req, res, next) => {
  try {
    await streamExportZip(res);
  } catch (err) {
    // If nothing has been sent yet, hand off to the Express error handler.
    if (!res.headersSent) {
      next(err);
    } else {
      console.error('[admin/export] failed mid-stream:', err);
      res.destroy(err);
    }
  }
});
```

> If, in section 08, your admin router does **not** call `router.use(requireAdmin)` globally and instead lists `requireAdmin` on each route, then write the route as:
> ```js
> router.get('/export', requireAdmin, async (req, res, next) => { /* same body as above */ });
> ```
> Use whichever matches the pattern already in your `admin.js`. The route MUST be behind `requireAdmin` either way.

### 3c. The admin dashboard already links here

Section 08's `admin-dashboard.ejs` should contain a button/link pointing at `/admin/export`. If you are checking, it looks like this (do not add a duplicate — this is just so you know what triggers the download):

```html
<!-- src/views/admin-dashboard.ejs  (this link is owned by 08-admin; shown here for reference only) -->
<a class="btn" href="/admin/export">Download export (photos + spreadsheet)</a>
```

A plain link works because the route sets `Content-Disposition: attachment`, so clicking it makes the browser save the file instead of navigating.

---

## 4. Teardown / keepsake handoff (for Trevor, after the wedding)

These are the steps Trevor runs **after the reception is over** to preserve everything and do the Flickr + email handoff. Run them in **PowerShell from the project root** on the couple's laptop.

### 4a. Stop the public tunnel and the app

1. In the terminal running `cloudflared`, press `Ctrl + C` to close the public tunnel. Guests can no longer reach the site.
2. In the terminal running `npm start`, press `Ctrl + C` to stop the web app.

### 4b. Grab the one-click export (the convenience copy)

1. Start the app again (`npm start`) on the laptop — you do **not** need the tunnel for this.
2. Open a browser on the laptop to `http://localhost:3000/admin`, log in with the admin password (**ButtMonster**).
3. Click **Download export (photos + spreadsheet)**.
4. The browser saves `garden-party-export-<date>.zip`. This is the share-ready package: per-guest photo folders + `summary.xlsx`.

### 4c. Back up the raw application state (the safety copy)

The export ZIP is convenient, but the **entire, authoritative state** of the app is the `data/` folder. Copy it somewhere safe (external drive, second laptop, cloud drive). Run this in PowerShell from the project root, with a USB drive at `E:` (change the destination to wherever you want it):

```powershell
$dest = "E:\garden-party-backup-$(Get-Date -Format yyyy-MM-dd)"
New-Item -ItemType Directory -Force -Path $dest
Copy-Item -Path ".\data" -Destination $dest -Recurse -Force
```

After it finishes, confirm the backup actually has the photos:

```powershell
Get-ChildItem -Recurse "$dest\data\uploads" | Measure-Object | Select-Object -ExpandProperty Count
```

That number should be roughly the total number of photos guests uploaded (around 1500). If it is 0, the copy did not work — re-run it before doing anything else.

> Why both copies: the ZIP is for sharing; the `data/` folder is the master and can re-run the whole app or re-export later if you find a problem.

### 4d. Flickr upload handoff

1. Unzip `garden-party-export-<date>.zip` somewhere (right-click the file in File Explorer, **Extract All**).
2. You now have one folder per guest (e.g. `Lily-Sckeiky-3/`) full of full-size JPEGs.
3. Go to Flickr, sign in, and use **Upload** (the up-arrow icon). Drag in the extracted guest folders, or drag the whole extracted parent folder.
4. Flickr lets you create an album per upload batch — make an album per guest (named after the folder) or one big "Garden Party" album, whichever you prefer.
5. Set the album/photos to the visibility you want (public link to share, or friends/family).
6. Keep the original `data/` backup from 4c regardless — Flickr is the *shared* copy, not your archive.

### 4e. Email blast handoff

1. Open `summary.xlsx` from the export (or from `data/exports` if you saved one there). The **Guests** sheet has every guest's name, points, badges, and any social links they entered.
2. Use that sheet to assemble your recipient list and to personalize the note (you can mention the winner, who earned the most badges, etc.).
3. Send the blast from your normal email tool (the app has no email server — that was intentional). Include the Flickr album link(s) from step 4d so guests can see and download the photos.

---

## 5. Pre-flight: confirm dependencies are installed

`archiver` and `exceljs` were installed back in section 01 from the pinned dependency list. Confirm they're present before testing. Run from the project root in PowerShell:

```powershell
npm ls archiver exceljs
```

You should see `archiver@7.0.1` and `exceljs@4.4.0` listed (no "missing" / "UNMET DEPENDENCY"). If either is missing, install the exact pinned versions:

```powershell
npm install archiver@7.0.1 exceljs@4.4.0
```

---

## Acceptance check

Do these steps in order. The expected observable result is stated for each.

1. **Have some data.** Make sure at least one guest has uploaded at least one photo (do this through the normal guest flow, or rely on data already present). The export of an empty database still works but is boring to verify.

2. **Start the app** from the project root:
   ```powershell
   npm start
   ```
   Expected: console prints that it is listening on port 3000, no errors.

3. **Log in to admin.** Open `http://localhost:3000/admin/login`, enter the password **ButtMonster**, submit.
   Expected: you reach the admin dashboard (you are now holding the signed `admin` cookie).

4. **Trigger the export.** Click **Download export (photos + spreadsheet)** on the dashboard, OR open `http://localhost:3000/admin/export` directly in the same browser.
   Expected: the browser downloads a file named `garden-party-export-<today's date>.zip`. The server console shows no `[export] archive error` lines (a `[export] missing original` warning is fine and only appears if a file is gone from disk).

5. **Confirm the route is protected.** Open a **private/incognito** browser window (no admin cookie) and go to `http://localhost:3000/admin/export`.
   Expected: you are redirected to `/admin/login` (because `requireAdmin` blocks it). You do **not** get a ZIP.

6. **Open the ZIP.** In File Explorer, double-click the downloaded ZIP, or extract it.
   Expected contents:
   - A `summary.xlsx` at the top level.
   - One folder per guest named `<SafeName>-<id>` (e.g. `Lily-Sckeiky-3`).
   - Inside each guest folder, image files named like `task-2-Find-the-cake.jpg`.

7. **Verify the spreadsheet opens.** Double-click `summary.xlsx` (Excel, or LibreOffice, or upload to Google Sheets).
   Expected: it opens without a repair prompt and has three tabs:
   - **Guests** — columns Guest ID, Name, Completed Tasks, Bonus Points, Total Points, Badges, Social Links. Total Points should equal Completed Tasks + Bonus Points for each row.
   - **Submissions** — one row per photo submission, including a `Taken Down` column showing `YES`/`no`.
   - **Badges** — the 7 canonical badges (BLOOM, BOUQUET, GARDEN, EARLYBIRD, SHUTTERBUG, CROWDFAV, CHOICE) with their type and threshold.

8. **Verify a photo opens (and that `config.UPLOADS_DIR` resolved correctly).** Open one of the JPEGs inside a guest folder.
   Expected: it displays a real, full-size photo (the original, not a thumbnail). **If the per-guest folders are empty** — the ZIP has `summary.xlsx` but no image files — that is the signature of `config.UPLOADS_DIR` resolving to `undefined`: `config.js` is exporting the uploads path under the wrong casing (e.g. `uploadsDir`). Fix `config.js` to export `UPLOADS_DIR` in UPPER_SNAKE_CASE (see section 01) and re-export.

9. **Verify taken-down photos are still included.** If the admin has taken down at least one photo (section 08), confirm that photo's image file is **still present** in the guest's folder in the ZIP, AND its row in the Submissions sheet shows `Taken Down = YES`.
   Expected: the file is in the ZIP (nothing lost) but flagged as taken down in the spreadsheet.

If all nine steps pass, the export is working and ready for the post-wedding Flickr + email handoff.
