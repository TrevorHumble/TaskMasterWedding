# 02 — Database schema, init, and seed

This section creates the two files that bring the SQLite database to life:

- **`src/db.js`** — opens the single SQLite database file, turns on the safety settings (pragmas), creates every table if it does not already exist, and exports the live database connection plus a couple of small helper functions other sections will reuse.
- **`scripts/seed.js`** — fills the freshly created database with the 7 fixed badges and 6 sample scavenger-hunt tasks, so the app has something in it the first time it runs.

You do not need to understand the rest of the app to do this section. Just create the two files exactly as written, then run the numbered commands at the bottom and confirm the "Acceptance check" passes.

> **Important background you must trust:**
> - `better-sqlite3` is **synchronous**. There is no `await`, no callbacks, no promises. You call `.prepare(sql)` to compile a statement, then `.run(...)` (for INSERT/UPDATE/CREATE), `.get(...)` (one row), or `.all(...)` (many rows). That is all you need here.
> - This section depends on **`config.js`**, which is created in section 01-setup. `config.js` gives us the file paths (where the database lives, where uploads go, etc.). Section 01 also creates the `data/` folder on boot. If you are running these files before section 01 exists, the commands below include a fallback so you can still test.

---

## Step 1 — Confirm prerequisites

1. You must have completed **section 01-setup**, which created `package.json`, ran `npm install`, and created `config.js`. In particular `better-sqlite3@12.2.0` must be installed.
2. Open PowerShell and change into the project root (the folder that contains `package.json`):

```powershell
# Run from wherever you keep the project; adjust the path to match your machine.
cd C:\Users\thumb\garden-party-pastels
```

3. Verify the dependency is present (this should print a version number, not an error):

```powershell
node -e "console.log('better-sqlite3', require('better-sqlite3/package.json').version)"
```

Expected output:

```
better-sqlite3 12.2.0
```

If that errors, go back and finish section 01-setup (`npm install`) before continuing.

---

## Step 2 — Create `src/db.js`

Create the file `src/db.js` with the **exact** contents below. This file:

- reads the database path and data-directory paths from `config.js`,
- makes sure the `data/` folder exists (so opening the database never fails on a fresh checkout),
- opens the database,
- turns on **WAL** journal mode (faster, safer concurrent reads) and **foreign keys** (so the `REFERENCES ... ON DELETE CASCADE` rules in the schema are actually enforced — SQLite has them OFF by default),
- creates all five tables if they do not already exist,
- exports the live `db` connection plus three small helper functions.

```javascript
// src/db.js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

// --- Make sure the data directory exists before we try to open the DB file. ---
// (Section 01-setup also does this on boot, but we do it here too so that
//  running scripts/seed.js or this file directly never fails on a fresh clone.)
fs.mkdirSync(config.DATA_DIR, { recursive: true });

// --- Open the single SQLite database file (created automatically if missing). ---
const db = new Database(config.DB_PATH);

// --- Pragmas: safety + speed settings, applied every time the DB is opened. ---
// WAL = Write-Ahead Logging: better read/write concurrency and durability.
db.pragma('journal_mode = WAL');
// Foreign keys are OFF by default in SQLite; turn them ON so the
// REFERENCES ... ON DELETE CASCADE constraints below are enforced.
db.pragma('foreign_keys = ON');

// --- Schema: create every table if it does not already exist. ---
// exec() runs multiple statements in one call. Running this repeatedly is safe
// because of the "IF NOT EXISTS" guards.
db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL DEFAULT '',
    avatar_path   TEXT,
    social_links  TEXT    NOT NULL DEFAULT '{}',
    bonus_points  INTEGER NOT NULL DEFAULT 0,
    onboarded     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    task_id     INTEGER NOT NULL REFERENCES tasks(id)  ON DELETE CASCADE,
    photo_path  TEXT    NOT NULL,
    thumb_path  TEXT    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT '',
    taken_down  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('auto','special')),
    threshold    INTEGER,
    art_path     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS guest_badges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    awarded_by  TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
  );
`);

// --- Shared helpers used by other sections (scoring, profiles, gallery, etc.). ---

/**
 * Count how many tasks a guest has actually completed.
 * A completed task = one submission row for that guest that is NOT taken down.
 * Taken-down photos (taken_down = 1) do not count toward points or badges.
 * @param {number} guestId
 * @returns {number}
 */
function getCompletedCount(guestId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM submissions
        WHERE guest_id = ?
          AND taken_down = 0`
    )
    .get(guestId);
  return row.n;
}

/**
 * Load a single guest row by its sign-in token, or undefined if none.
 * Used by the auth/session middleware in section 03.
 * @param {string} token
 * @returns {object|undefined}
 */
function getGuestByToken(token) {
  return db.prepare(`SELECT * FROM guests WHERE token = ?`).get(token);
}

/**
 * Load a single guest row by numeric id, or undefined if none.
 * @param {number} guestId
 * @returns {object|undefined}
 */
function getGuestById(guestId) {
  return db.prepare(`SELECT * FROM guests WHERE id = ?`).get(guestId);
}

module.exports = {
  db,
  getCompletedCount,
  getGuestByToken,
  getGuestById,
};
```

**Notes for you (the junior dev), do not change anything above:**

- `require('../config')` works because `src/db.js` is one folder deep, so `..` climbs back to the project root where `config.js` lives.
- The `avatar_path` column has **no** `NOT NULL` and **no** default, which is correct: a guest has no avatar until they finish onboarding, so it stays `NULL`.
- The `threshold` column on `badges` is also intentionally nullable: special badges have no threshold (it is `NULL`); auto badges have `5`, `10`, or `15`.

> **Config naming must match `config.js` (read this before you run anything).**
> This file reads `config.DATA_DIR` and `config.DB_PATH` (UPPER_SNAKE_CASE). Section 01-setup's `config.js` **must export those exact names**, i.e. `DATA_DIR` and `DB_PATH`. The 01-setup section has been standardized to UPPER_SNAKE_CASE, so `db.js` works as written.
>
> Why this matters: if `config.js` instead exports the camelCase names `dataDir` / `dbPath`, then `config.DATA_DIR` and `config.DB_PATH` are both `undefined`. The very first line that touches them, `fs.mkdirSync(config.DATA_DIR, { recursive: true })`, would receive `undefined` and throw `TypeError: The "path" argument must be of type string`. Because that happens at *import* time, `src/db.js` fails to load and **`scripts/seed.js` cannot even start** — this is the first place a config-casing mismatch shows up at runtime.
>
> The two files must agree. If for any reason you keep `config.js` on camelCase instead, change the two references in `db.js` above to `config.dataDir` and `config.dbPath`. Either way, verify by running `node scripts/seed.js` (Step 4 below) — that is this section's own acceptance step and it will fail loudly if the names do not line up.

> **How other sections must import this connection (so they don't break later).**
> `src/db.js` exports an **object**: `{ db, getCompletedCount, getGuestByToken, getGuestById }`. The live connection is the `db` *property* of that object — it is **not** the export itself. So the only correct way to get the connection is to **destructure** it:
>
> ```javascript
> const { db } = require('../db');   // correct — db is the connection
> db.prepare('SELECT ...');          // works
> ```
>
> If a consumer instead writes `const db = require('../db');` and then calls `db.prepare(...)`, it is calling `.prepare` on the *exports object*, which has no such method — every query throws `db.prepare is not a function`. When you build sections **04 (guest experience)**, **06 (scoring/badges)**, and **07 (gallery/leaderboard)**, make sure each one uses `const { db } = require('../db');` (with the braces), not `const db = require('../db');`. Sections 05 (export) and the admin routes already destructure correctly.

---

## Step 3 — Create `scripts/seed.js`

Create the file `scripts/seed.js` with the **exact** contents below. This file:

- imports the `db` from `src/db.js` (importing it also creates the tables, because that code runs on import),
- inserts the **7 canonical badges** — but only if a badge with that `code` does not already exist, so running the seed twice does not create duplicates,
- inserts **6 sample garden-party scavenger tasks** with increasing `sort_order` — but only if the `tasks` table is currently empty, so re-seeding does not pile up duplicate tasks or stomp on tasks the admin has since edited,
- prints a short summary and exits.

```javascript
// scripts/seed.js
'use strict';

const { db } = require('../src/db');

// ---------------------------------------------------------------------------
// 1) Canonical badge catalog. These 7 rows are fixed by the project spec.
//    'auto' badges are granted automatically at a completed-task threshold.
//    'special' badges have threshold = null and are hand-awarded by the admin.
// ---------------------------------------------------------------------------
const BADGES = [
  {
    code: 'BLOOM',
    name: 'First Bloom',
    type: 'auto',
    threshold: 5,
    art_path: '/badges/bloom.svg',
    description: 'Completed 5 tasks.',
  },
  {
    code: 'BOUQUET',
    name: 'Bouquet Builder',
    type: 'auto',
    threshold: 10,
    art_path: '/badges/bouquet.svg',
    description: 'Completed 10 tasks.',
  },
  {
    code: 'GARDEN',
    name: 'Full Garden',
    type: 'auto',
    threshold: 15,
    art_path: '/badges/garden.svg',
    description: 'Completed 15 tasks.',
  },
  {
    code: 'EARLYBIRD',
    name: 'Early Bird',
    type: 'special',
    threshold: null,
    art_path: '/badges/earlybird.svg',
    description: 'Awarded by the Task Master for early arrival.',
  },
  {
    code: 'SHUTTERBUG',
    name: 'Shutterbug',
    type: 'special',
    threshold: null,
    art_path: '/badges/shutterbug.svg',
    description: 'Awarded by the Task Master for great photography.',
  },
  {
    code: 'CROWDFAV',
    name: 'Crowd Favorite',
    type: 'special',
    threshold: null,
    art_path: '/badges/crowdfav.svg',
    description: 'Awarded by the Task Master as the crowd favorite.',
  },
  {
    code: 'CHOICE',
    name: "Task Master's Choice",
    type: 'special',
    threshold: null,
    art_path: '/badges/choice.svg',
    description: "Awarded by the Task Master as their personal pick.",
  },
];

// ---------------------------------------------------------------------------
// 2) Sample scavenger-hunt tasks for a garden-party wedding.
//    The admin can edit/add/remove these later; these just seed a starting set.
//    sort_order controls display order (0 first).
// ---------------------------------------------------------------------------
const TASKS = [
  {
    title: 'Snap the happy couple',
    description: 'Get a photo with Axel and Lily together. Bonus charm for a candid one.',
  },
  {
    title: 'Catch someone on the dance floor',
    description: 'Photograph a guest mid-dance move. Blurry feet are encouraged.',
  },
  {
    title: 'Find the prettiest flower',
    description: 'Hunt the garden for the bloom you think is the most beautiful and photograph it.',
  },
  {
    title: 'Toast with a stranger',
    description: 'Clink glasses with someone you have not met yet and capture the cheers.',
  },
  {
    title: 'Pastel outfit spotting',
    description: 'Find a guest dressed in our garden-party pastels and snap their look.',
  },
  {
    title: 'Sweet treat selfie',
    description: 'Take a selfie with something delicious from the dessert table.',
  },
];

// ---------------------------------------------------------------------------
// 3) Insert badges idempotently (only if the code is not already present).
// ---------------------------------------------------------------------------
const findBadge = db.prepare(`SELECT id FROM badges WHERE code = ?`);
const insertBadge = db.prepare(`
  INSERT INTO badges (code, name, type, threshold, art_path, description)
  VALUES (@code, @name, @type, @threshold, @art_path, @description)
`);

let badgesInserted = 0;
let badgesSkipped = 0;
for (const b of BADGES) {
  if (findBadge.get(b.code)) {
    badgesSkipped += 1;
  } else {
    insertBadge.run(b);
    badgesInserted += 1;
  }
}

// ---------------------------------------------------------------------------
// 4) Insert sample tasks ONLY if the tasks table is currently empty,
//    so re-running the seed never duplicates or overwrites admin edits.
// ---------------------------------------------------------------------------
const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get().n;
const insertTask = db.prepare(`
  INSERT INTO tasks (title, description, sort_order, is_active)
  VALUES (@title, @description, @sort_order, 1)
`);

let tasksInserted = 0;
if (taskCount === 0) {
  // better-sqlite3 transaction: all inserts succeed together or none do.
  const insertAll = db.transaction((rows) => {
    rows.forEach((t, index) => {
      insertTask.run({
        title: t.title,
        description: t.description,
        sort_order: index, // 0, 1, 2, ... preserves the listed order
      });
      tasksInserted += 1;
    });
  });
  insertAll(TASKS);
}

// ---------------------------------------------------------------------------
// 5) Report what happened.
// ---------------------------------------------------------------------------
console.log('Seed complete.');
console.log(`  Badges: ${badgesInserted} inserted, ${badgesSkipped} already existed.`);
if (taskCount === 0) {
  console.log(`  Tasks:  ${tasksInserted} inserted.`);
} else {
  console.log(`  Tasks:  skipped (${taskCount} already present).`);
}
```

**Notes for you (the junior dev):**

- `@code`, `@name`, etc. are **named parameters**. better-sqlite3 fills them from the keys of the object you pass to `.run(...)`. This is why each badge object's keys must match the `@` names exactly.
- The badge insert is idempotent by `code`: safe to run as many times as you like.
- The task insert only runs when the table is empty, so you will not get duplicate sample tasks if you re-seed.
- Note the import line: `const { db } = require('../src/db');` uses **destructuring braces** because `src/db.js` exports an object. This is the same rule the consumers in sections 04/06/07 must follow.

---

## Step 4 — Run the seed

From the project root in PowerShell:

```powershell
node scripts/seed.js
```

Expected output the **first** time:

```
Seed complete.
  Badges: 7 inserted, 0 already existed.
  Tasks:  6 inserted.
```

Expected output the **second** time you run it (proves it is idempotent — no duplicates):

```
Seed complete.
  Badges: 0 inserted, 7 already existed.
  Tasks:  skipped (6 already present).
```

This also created the database file at `data/app.db` (plus WAL helper files `data/app.db-wal` and `data/app.db-shm` — those are normal, leave them alone).

> If this step throws `TypeError: The "path" argument must be of type string` (or a stack trace mentioning `mkdirSync` / `new Database`), it means `config.js` is not exporting `DATA_DIR` / `DB_PATH` under those exact UPPER_SNAKE_CASE names. Go fix the export names in `config.js` (section 01-setup) so they match, then re-run. See the config-naming note at the end of Step 2.

---

## Step 5 — Verify the rows exist

You do not need any extra software. Run this one-off query with Node (PowerShell, single line):

```powershell
node -e "const {db}=require('./src/db'); console.log('badges:'); console.table(db.prepare('SELECT code,name,type,threshold FROM badges ORDER BY id').all()); console.log('tasks:'); console.table(db.prepare('SELECT id,title,sort_order,is_active FROM tasks ORDER BY sort_order').all());"
```

Expected: a table of **7 badges** (BLOOM/BOUQUET/GARDEN with thresholds 5/10/15 and type `auto`; EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE with `null` threshold and type `special`) followed by a table of **6 tasks** with `sort_order` 0 through 5 and `is_active` 1.

(Optional) If you prefer a visual tool, install **DB Browser for SQLite** (free, https://sqlitebrowser.org), open `data/app.db`, and look at the `badges` and `tasks` tables. **Close DB Browser before starting the app**, since it can hold a lock on the file.

---

## Acceptance check

You are done with this section when **all** of the following are true:

1. **Files exist:** `src/db.js` and `scripts/seed.js` exist with the exact contents above.

2. **Seed runs clean.** Running:
   ```powershell
   node scripts/seed.js
   ```
   prints `Seed complete.` with no errors (a stack trace means something is wrong).

3. **Database file created.** The file `data/app.db` now exists. Confirm:
   ```powershell
   Test-Path data\app.db
   ```
   prints `True`.

4. **Correct counts.** Running:
   ```powershell
   node -e "const {db}=require('./src/db'); console.log('badges', db.prepare('SELECT COUNT(*) n FROM badges').get().n); console.log('tasks', db.prepare('SELECT COUNT(*) n FROM tasks').get().n);"
   ```
   prints:
   ```
   badges 7
   tasks 6
   ```

5. **All five tables exist.** Running:
   ```powershell
   node -e "const {db}=require('./src/db'); console.table(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all());"
   ```
   lists (at minimum): `badges`, `guest_badges`, `guests`, `submissions`, `tasks`. (You may also see `sqlite_sequence`, which SQLite creates automatically for AUTOINCREMENT — that is expected.)

6. **Foreign keys are ON and the UNIQUE constraints work.** Running this quick self-test should print `OK`:
   ```powershell
   node -e "const {db,getCompletedCount}=require('./src/db'); const t=db.prepare('SELECT id FROM tasks ORDER BY sort_order LIMIT 1').get().id; const tok='testtoken'+Date.now(); const g=db.prepare(\"INSERT INTO guests(token,name) VALUES(?, 'Test')\").run(tok).lastInsertRowid; db.prepare('INSERT INTO submissions(guest_id,task_id,photo_path,thumb_path) VALUES(?,?,?,?)').run(g,t,'a.jpg','a.jpg'); let dup=false; try{ db.prepare('INSERT INTO submissions(guest_id,task_id,photo_path,thumb_path) VALUES(?,?,?,?)').run(g,t,'b.jpg','b.jpg'); }catch(e){ dup=true; } const n=getCompletedCount(g); db.prepare('DELETE FROM guests WHERE id=?').run(g); console.log(dup && n===1 ? 'OK' : 'FAIL', '(duplicate blocked:',dup,', completed count:',n,')');"
   ```
   Expected output:
   ```
   OK (duplicate blocked: true , completed count: 1 )
   ```
   This proves: a second submission for the same guest+task is rejected by `UNIQUE(guest_id, task_id)`; `getCompletedCount` returns `1`; and deleting the guest cascades to remove its submission (foreign keys ON). The test cleans up after itself.

If every check passes, the database layer is ready for the auth, scoring, and admin sections to build on.
