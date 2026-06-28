# 06 — Scoring engine and badge logic

This section gives you the **complete, copy-paste contents** of `src/services/scoring.js`. This file is the single source of truth for: how many points a guest has, which auto badges they have earned (granted and revoked automatically), how the admin hand-awards the four special badges and bonus points, and how the public leaderboard is ordered.

You are a junior developer with no prior context. Follow the numbered steps exactly. Do not change any names, paths, or numbers. Everything you need is in this file.

---

## 0. Before you start — what already exists

These were built in earlier sections. You are **not** building them here; you only rely on them:

- `src/db.js` (section 02-database) exports an object with a ready-to-use better-sqlite3 database handle on its `db` property: `module.exports = { db, ... }`. You import the handle with destructuring: `const { db } = require('../db');`. **Do not write `const db = require('../db');`** — that gives you the module object, not the handle, and `db.prepare` would be `undefined`, crashing this file the moment it loads (the very first `db.prepare(...)` at module scope throws). **better-sqlite3 is synchronous** — every query uses `db.prepare(sql).get(...)`, `.all(...)`, or `.run(...)`. There is no `await`, no callbacks, no Promises anywhere in this file.
- The database already contains these tables (from the schema in section 02): `guests`, `tasks`, `submissions`, `badges`, `guest_badges`.
- `scripts/seed.js` (section 02) has already inserted the 7 canonical badge rows into the `badges` table, including the three auto badges with codes `BLOOM` (threshold 5), `BOUQUET` (threshold 10), `GARDEN` (threshold 15).

The key columns this file reads and writes (from the Foundation Contract schema — do not redefine them):

- `submissions.guest_id`, `submissions.task_id`, `submissions.taken_down` (0 = visible/counts, 1 = hidden and does **not** count).
- `guests.id`, `guests.bonus_points`.
- `badges.id`, `badges.code`, `badges.type` (`'auto'` or `'special'`), `badges.threshold`.
- `guest_badges.guest_id`, `guest_badges.badge_id`, `guest_badges.awarded_by` (`'system'` for auto, `'admin'` for special), with `UNIQUE(guest_id, badge_id)`.

---

## 1. The scoring rules in plain English

These rules come straight from the project spec and the Foundation Contract. The code in step 3 implements exactly these:

1. **A guest's "completed task count"** = the number of their submissions where `taken_down = 0`. Because `submissions` has `UNIQUE(guest_id, task_id)`, there is at most one submission per task, so this count is also the number of distinct tasks they have completed. **This is the canonical completed-count rule** — see section 1a — and the same rule is used everywhere: `getCompletedCount`, `leaderboard`, `recomputeAutoBadges`, and the guest home page's "X of N complete" display.
2. **Total points** = completed task count (1 point each) **plus** that guest's `bonus_points` (set by the admin). Bonus points are clamped at 0: the admin can deduct, but a guest's `bonus_points` can never go below 0 (see section 1a).
3. **Auto badges** are granted automatically the moment a guest's completed task count reaches a threshold: 5 → `BLOOM`, 10 → `BOUQUET`, 15 → `GARDEN`.
4. **Auto badges are also REVOKED automatically** if a takedown drops the completed count back below a threshold. This is a deliberate choice — see the next section for why.
5. **Special badges** (`EARLYBIRD`, `SHUTTERBUG`, `CROWDFAV`, `CHOICE`) are never automatic. The admin awards and removes them by hand. The scoring code never touches them on its own.

---

## 1a. Two contract decisions every section must honor (read this)

These two rules resolve cross-section ambiguities. They are settled here so that scoring.js, section 04 (guest), section 07 (community/leaderboard), and section 08 (admin) all behave identically. Do **not** "fix" one side without the other.

**Decision A — one canonical completed-count rule: a completed task = a visible submission, regardless of whether the task is still active.**

A "completed task" is exactly: a row in `submissions` for that guest with `taken_down = 0`. The task's `is_active` flag is **irrelevant** to counting. Rationale: taking a task offline (deactivating it) should not retroactively strip points or badges a guest already earned — that would punish guests for an admin's later housekeeping. So:

- `getCompletedCount`, the `leaderboard` query, and `recomputeAutoBadges` all count `submissions WHERE taken_down = 0` with **no join to `tasks` and no `is_active` filter**.
- The guest home page ("X of N complete") must use the **same** count. If section 04's guest-home query currently counts completed only for `is_active = 1` tasks, **remove the `AND t.is_active = 1` from its completed-count query** so it matches scoring. (The denominator "N" — total tasks shown — may still be the active-task list; only the completed numerator must use the canonical rule.)

If you ever see a guest's leaderboard points exceed the "X of N complete" on their own home page, the two count rules have drifted apart — fix the home page to match this section, not the other way around.

**Decision B — bonus points are clamped at 0.**

`addBonusPoints(guestId, delta)` may receive a negative `delta` (the admin deducting points), but a guest's stored `bonus_points` can **never go below 0**. The UPDATE uses `MAX(0, bonus_points + ?)`. So deducting 3 from a guest who has 0 bonus leaves them at 0, not -3. Section 08 (admin) relies on this: its acceptance check expects a guest's bonus to read `0` after an over-deduction, not a negative number. Keep scoring.js and section 08 in agreement on this.

---

## 2. Why auto badges are revoked when a takedown drops the count (read this)

The admin can **take down** a photo at any time (for example, a blurry or inappropriate picture). A taken-down photo stops counting toward points **and** toward the auto-badge thresholds. The spec says taken-down photos are hidden "from gallery, profiles AND scoring."

So imagine this sequence:

1. A guest completes their 5th task → they cross the threshold → we grant `BLOOM` ("First Bloom").
2. The admin takes down one of that guest's 5 photos → the guest now only has 4 completed tasks.

If we left `BLOOM` on their profile, the leaderboard and profile would be **lying**: the badge says "completed 5 tasks" but the honest count is now 4. To keep the public display truthful, we **revoke** `BLOOM` until they complete a 5th task again (which re-grants it automatically). The same logic applies at 10 and 15.

This is why our single function `recomputeAutoBadges(guestId)` does **both** directions every time it runs: it grants any auto badge whose threshold is met, and revokes any auto badge whose threshold is no longer met. It is *idempotent* — running it twice in a row changes nothing the second time — so it is always safe to call after any event that could change a guest's completed count.

Special badges are **never** revoked by this logic. They are awarded by human judgment and only the admin can remove them.

---

## 3. Who calls what (the integration map)

You are writing the functions. Other sections (already specified) call them. This is how the pieces connect — you do not edit those other files here, but you must export the function names exactly so their calls resolve:

| Event | Where it happens | Function it calls from this file |
|---|---|---|
| Guest uploads a photo for a task (completes it) | `routes/guest.js`, `POST /tasks/:id/submit` (section 04) | `recomputeAutoBadges(guestId)` after the submission row is inserted |
| Admin takes a photo down | `routes/admin.js`, `POST /admin/photos/:submissionId/takedown` (section 08) | `recomputeAutoBadges(guestId)` after setting `taken_down = 1` |
| Admin restores a taken-down photo | `routes/admin.js`, `POST /admin/photos/:submissionId/restore` (section 08) | `recomputeAutoBadges(guestId)` after setting `taken_down = 0` |
| Admin awards a special badge | `routes/admin.js`, `POST /admin/guests/:id/badge` (section 08) | `awardSpecialBadge(guestId, code)` |
| Admin removes a special badge (same handler, "remove" action) | `routes/admin.js`, `POST /admin/guests/:id/badge` (section 08) | `removeSpecialBadge(guestId, code)` |
| Admin awards (or deducts) bonus points | `routes/admin.js`, `POST /admin/guests/:id/bonus` (section 08) | `addBonusPoints(guestId, delta)` |
| Render the leaderboard | `routes/community.js`, `GET /leaderboard` (section 07) | `leaderboard()` |
| Show a guest's points (home page, profile) | `routes/guest.js` and `routes/community.js` (sections 04, 07) | `getPoints(guestId)` and `getCompletedCount(guestId)` |
| Read the auto-badge thresholds as plain numbers (progress bars, copy) | `routes/guest.js` (section 04) | `AUTO_THRESHOLDS` (a numeric array `[5, 10, 15]`) |

> Reminder for the section-04 and section-08 author (not your job here, just context): those files do `const scoring = require('../services/scoring');` and then call e.g. `scoring.recomputeAutoBadges(req.params /* the guest id */);`. Section 04 also does `const { AUTO_THRESHOLDS } = require('../services/scoring');` and indexes it numerically (e.g. `completedTasks < AUTO_THRESHOLDS[i]`), so `AUTO_THRESHOLDS` **must** be a plain array of numbers `[5, 10, 15]` — **not** the array of `{code, n}` objects. Both are exported (see step 3); use the right one. The exact wiring lives in those sections.

---

## 4. Build step — create the file

1. Open a PowerShell terminal at the project root (`garden-party-pastels`).
2. Confirm the services folder exists (it was created in earlier sections). Run:

   ```powershell
   Test-Path src\services
   ```

   If it prints `True`, continue. If it prints `False`, create it:

   ```powershell
   New-Item -ItemType Directory -Force -Path src\services
   ```

3. Create the file `src/services/scoring.js` with the **exact** contents in the code block below. Copy the whole block, including the first comment line.

```javascript
// src/services/scoring.js
//
// Scoring engine and badge logic for Garden Party Pastels.
//
// Responsibilities:
//   - getPoints / getCompletedCount: how many points a guest has.
//   - recomputeAutoBadges: grant/revoke the auto badges (BLOOM/BOUQUET/GARDEN)
//     based on the guest's current completed-task count. Idempotent.
//   - awardSpecialBadge / removeSpecialBadge: admin-only hand-awarded badges.
//   - addBonusPoints: admin adjusts a guest's bonus point total (clamped at 0).
//   - leaderboard: every guest ordered by total points, with their badge codes.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

// src/db.js exports { db, ... }. Destructure the handle — do NOT write
// `const db = require('../db')` or `db.prepare` is undefined and this file
// crashes at load time on the first prepared statement below.
const { db } = require('../db');

// ---------------------------------------------------------------------------
// Canonical auto-badge thresholds. These MUST match the seeded `badges` rows
// (section 02 seed.js): BLOOM=5, BOUQUET=10, GARDEN=15 completed tasks.
//
// Two shapes are exported on purpose:
//   - BADGE_THRESHOLDS: array of { code, n } objects, used internally by
//     recomputeAutoBadges to map a code to its threshold number.
//   - AUTO_THRESHOLDS:  plain array of numbers [5, 10, 15], used by section 04
//     for numeric comparisons and progress-bar math. It is derived from
//     BADGE_THRESHOLDS so the two can never drift apart.
// These are the single source of truth for the threshold numbers used in UI
// copy and tests.
// ---------------------------------------------------------------------------
const BADGE_THRESHOLDS = [
  { code: 'BLOOM', n: 5 },
  { code: 'BOUQUET', n: 10 },
  { code: 'GARDEN', n: 15 },
];

// Plain numeric thresholds, e.g. [5, 10, 15]. Section 04 imports THIS one for
// `completedTasks < AUTO_THRESHOLDS[i]` style comparisons and progress math.
const AUTO_THRESHOLDS = BADGE_THRESHOLDS.map((b) => b.n);

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call for speed).
// ---------------------------------------------------------------------------

// Count a guest's completed tasks = visible submissions (taken_down = 0).
// UNIQUE(guest_id, task_id) guarantees at most one row per task, so this is
// both "submissions that count" and "distinct tasks completed".
//
// CANONICAL completed-count rule (see section 1a, Decision A): we count
// visible submissions regardless of whether the task is still active. There
// is intentionally NO join to `tasks` and NO is_active filter here, so a guest
// keeps points/badges even if the admin later deactivates a task. The guest
// home page must use this same rule for its "X of N complete" numerator.
const stmtCompletedCount = db.prepare(
  'SELECT COUNT(*) AS c FROM submissions WHERE guest_id = ? AND taken_down = 0'
);

// Read a guest's admin-set bonus points.
const stmtBonusPoints = db.prepare(
  'SELECT bonus_points FROM guests WHERE id = ?'
);

// Look up a badge row by its code (e.g. 'BLOOM', 'EARLYBIRD').
const stmtBadgeByCode = db.prepare('SELECT * FROM badges WHERE code = ?');

// Does this guest already hold this badge? (returns the guest_badges row or undefined)
const stmtGuestBadge = db.prepare(
  'SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?'
);

// Grant a badge to a guest. UNIQUE(guest_id, badge_id) prevents duplicates;
// "INSERT OR IGNORE" makes a repeat grant a harmless no-op.
const stmtGrantBadge = db.prepare(
  'INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, ?)'
);

// Remove a specific badge from a guest.
const stmtRevokeBadge = db.prepare(
  'DELETE FROM guest_badges WHERE guest_id = ? AND badge_id = ?'
);

// Adjust a guest's bonus points by a delta (can be negative), clamped at 0.
// MAX(0, ...) enforces the floor (see section 1a, Decision B): a deduction can
// never drive bonus_points below zero. Section 08's admin acceptance check
// depends on this floor.
const stmtAddBonus = db.prepare(
  'UPDATE guests SET bonus_points = MAX(0, bonus_points + ?) WHERE id = ?'
);

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Number of tasks this guest has completed (visible submissions only).
 * Uses the canonical rule: taken_down = 0, ignoring task active state.
 * @param {number} guestId
 * @returns {number}
 */
function getCompletedCount(guestId) {
  const row = stmtCompletedCount.get(guestId);
  return row ? row.c : 0;
}

/**
 * Total points for a guest = completed tasks (1 each) + admin bonus_points.
 * bonus_points is stored clamped at >= 0, so total points are always >= 0.
 * @param {number} guestId
 * @returns {number}
 */
function getPoints(guestId) {
  const completed = getCompletedCount(guestId);
  const bonusRow = stmtBonusPoints.get(guestId);
  const bonus = bonusRow ? bonusRow.bonus_points : 0;
  return completed + bonus;
}

// ---------------------------------------------------------------------------
// Auto-badge grant/revoke
// ---------------------------------------------------------------------------

/**
 * Recompute the three AUTO badges for one guest based on their current
 * completed-task count. GRANTS any auto badge whose threshold is met and
 * REVOKES any auto badge whose threshold is no longer met (e.g. after a
 * photo takedown drops the count). Special badges are NEVER touched here.
 *
 * Idempotent: running it repeatedly produces the same end state, so it is
 * safe to call after every submit, takedown, or restore.
 *
 * Wrapped in a transaction so the (possibly multiple) grant/revoke writes
 * either all apply or none do.
 *
 * @param {number} guestId
 */
const recomputeAutoBadges = db.transaction((guestId) => {
  const completed = getCompletedCount(guestId);

  for (const { code, n } of BADGE_THRESHOLDS) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Badge catalog not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const has = stmtGuestBadge.get(guestId, badge.id);

    if (completed >= n) {
      // Threshold met: grant if missing. awarded_by = 'system'.
      if (!has) {
        stmtGrantBadge.run(guestId, badge.id, 'system');
      }
    } else {
      // Threshold no longer met: revoke ONLY if it was a system grant.
      // (Defensive: an auto badge should always be system-granted, but we
      // never want to delete an admin-awarded badge by accident.)
      if (has && has.awarded_by === 'system') {
        stmtRevokeBadge.run(guestId, badge.id);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Special (hand-awarded) badges
// ---------------------------------------------------------------------------

/**
 * Admin hand-awards a SPECIAL badge to a guest.
 * Validates that the code exists and is of type 'special' (so this can never
 * be used to fake an auto badge). awarded_by = 'admin'. No-op if already held.
 *
 * @param {number} guestId
 * @param {string} code  one of EARLYBIRD / SHUTTERBUG / CROWDFAV / CHOICE
 * @returns {boolean} true if a badge was granted (or already present), false if the code was invalid
 */
function awardSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || badge.type !== 'special') {
    return false;
  }
  stmtGrantBadge.run(guestId, badge.id, 'admin');
  return true;
}

/**
 * Admin removes a SPECIAL badge from a guest.
 * Only removes badges of type 'special' so this can never strip an auto badge.
 *
 * @param {number} guestId
 * @param {string} code
 * @returns {boolean} true if the code was a valid special badge, false otherwise
 */
function removeSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || badge.type !== 'special') {
    return false;
  }
  stmtRevokeBadge.run(guestId, badge.id);
  return true;
}

// ---------------------------------------------------------------------------
// Bonus points
// ---------------------------------------------------------------------------

/**
 * Add `delta` to a guest's bonus_points (delta may be negative to deduct).
 * The stored bonus_points is clamped at 0 by the UPDATE (MAX(0, ...)), so a
 * deduction can never push it negative. Returns the guest's new total points
 * so the caller can show it.
 *
 * @param {number} guestId
 * @param {number} delta
 * @returns {number} the guest's new total points
 */
function addBonusPoints(guestId, delta) {
  const amount = Math.trunc(Number(delta)) || 0;
  stmtAddBonus.run(amount, guestId);
  return getPoints(guestId);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Public leaderboard: every guest ordered by total points (desc), then by
 * name, then id (stable tiebreak). Total points = visible submissions + bonus.
 * Each row carries the guest's earned badge codes (auto + special).
 *
 * The completed-count here uses the SAME canonical rule as getCompletedCount
 * (section 1a, Decision A): visible submissions only (taken_down = 0), with no
 * is_active filter, so leaderboard points always match a guest's own
 * "X complete" home-page count. bonus_points is clamped >= 0, so points >= 0.
 *
 * @returns {Array<{
 *   id: number,
 *   name: string,
 *   avatar_path: string|null,
 *   completed: number,
 *   bonus_points: number,
 *   points: number,
 *   badges: string[]
 * }>}
 */
function leaderboard() {
  // One query computes completed-count and points per guest. We LEFT JOIN
  // submissions filtered to taken_down = 0 so guests with zero (or all
  // taken-down) photos still appear with 0 points. No tasks join / is_active
  // filter — same canonical rule as getCompletedCount.
  const rows = db
    .prepare(
      `SELECT
         g.id            AS id,
         g.name          AS name,
         g.avatar_path   AS avatar_path,
         g.bonus_points  AS bonus_points,
         COUNT(s.id)                 AS completed,
         COUNT(s.id) + g.bonus_points AS points
       FROM guests g
       LEFT JOIN submissions s
         ON s.guest_id = g.id AND s.taken_down = 0
       GROUP BY g.id
       ORDER BY points DESC, g.name ASC, g.id ASC`
    )
    .all();

  // Attach each guest's badge codes. Done as a second small query per guest;
  // at ~100 guests this is trivially fast.
  const stmtBadgesForGuest = db.prepare(
    `SELECT b.code
       FROM guest_badges gb
       JOIN badges b ON b.id = gb.badge_id
      WHERE gb.guest_id = ?
      ORDER BY b.code ASC`
  );

  for (const row of rows) {
    row.badges = stmtBadgesForGuest.all(row.id).map((r) => r.code);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Badges a single guest holds (with display fields)
// ---------------------------------------------------------------------------

// Every badge a guest currently holds, joined to the badge catalog so callers
// get the display fields directly. Auto badges come first (ordered by their
// threshold 5 -> 10 -> 15), then special badges by code.
const stmtGuestBadgesFull = db.prepare(
  `SELECT b.code, b.name, b.art_path, b.type, b.description, gb.awarded_by
     FROM guest_badges gb
     JOIN badges b ON b.id = gb.badge_id
    WHERE gb.guest_id = ?
    ORDER BY CASE WHEN b.type = 'special' THEN 1 ELSE 0 END ASC,
             b.threshold ASC,
             b.code ASC`
);

/**
 * All badges a guest currently holds, each with { code, name, art_path, type,
 * description, awarded_by }. Used by the section 04 home page, the section 07
 * public profile, and the section 08 admin guest view.
 * @param {number} guestId
 * @returns {Array<object>}
 */
function getGuestBadges(guestId) {
  return stmtGuestBadgesFull.all(guestId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  BADGE_THRESHOLDS,
  AUTO_THRESHOLDS,
  getCompletedCount,
  getPoints,
  getGuestBadges,
  recomputeAutoBadges,
  awardSpecialBadge,
  removeSpecialBadge,
  addBonusPoints,
  leaderboard,
};
```

4. Save the file.

---

## 5. Notes the next developer must not "fix" away

- **Import the db handle with destructuring: `const { db } = require('../db');`.** `src/db.js` exports `{ db, ... }`. If you "simplify" this to `const db = require('../db');`, `db.prepare` becomes `undefined` and the file throws at load time on the first prepared statement — which also breaks every file that imports scoring (sections 04, 07, 08).
- **Do not switch any query to async / Promises.** better-sqlite3 is synchronous on purpose; the rest of the app depends on these functions returning values directly.
- **`recomputeAutoBadges` is a `db.transaction(...)`.** You call it exactly like a normal function: `recomputeAutoBadges(guestId)`. The transaction wrapper just makes the grant/revoke writes atomic. Do not call it inside another open transaction unless you know better-sqlite3 supports nesting (it does via savepoints, but you don't need that here).
- **`awardSpecialBadge` / `removeSpecialBadge` only ever touch `type = 'special'` badges**, and `recomputeAutoBadges` only revokes `awarded_by = 'system'` rows. Together these guarantees mean the admin's hand-awarded badges and the system's auto badges can never clobber each other.
- **`INSERT OR IGNORE`** is how we honor the `UNIQUE(guest_id, badge_id)` constraint without errors when a badge is granted twice.
- **Two threshold exports, two shapes.** `BADGE_THRESHOLDS` is `[{code, n}, ...]` (internal). `AUTO_THRESHOLDS` is `[5, 10, 15]` (numbers, for section 04's math). Don't collapse them into one — section 04 indexes `AUTO_THRESHOLDS[i]` as a number and would get `NaN%` progress bars if handed the object array.
- **Bonus is floored at 0** via `MAX(0, bonus_points + ?)`. Don't drop the `MAX(0, ...)`: section 08's admin acceptance check expects an over-deduction to land on `0`, not a negative number.
- **One completed-count rule** (section 1a, Decision A): visible submissions, no `is_active` filter, everywhere. Don't add a `tasks` join here without also changing the guest home page, or the two displays will disagree.

---

## Acceptance check

You will verify the file works in isolation, before the routes that call it exist. Run every command from the project root in PowerShell.

1. **Prerequisites** (from earlier sections — run them if you have not already):

   ```powershell
   node scripts/seed.js
   ```

   This creates `data/app.db` (if missing) and seeds the 7 badges plus sample tasks. You should see no errors.

2. **Create a throwaway test script.** Save the following as `tmp-scoring-check.js` in the project root:

   ```javascript
   // tmp-scoring-check.js  (throwaway — delete after the check)
   // NOTE: src/db.js exports { db, ... }, so destructure the handle. Writing
   // `const db = require('./src/db')` would make db.prepare undefined.
   const { db } = require('./src/db');
   const scoring = require('./src/services/scoring');

   // Fresh guest with no submissions.
   const guestId = db
     .prepare("INSERT INTO guests (token, name) VALUES (?, ?)")
     .run('testtoken' + Date.now(), 'Scoring Test Guest').lastInsertRowid;

   // Helper: make N completed tasks for this guest by inserting N submissions.
   function addSubmissions(n) {
     for (let i = 0; i < n; i++) {
       const taskId = db
         .prepare("INSERT INTO tasks (title) VALUES (?)")
         .run('Task ' + Date.now() + '-' + i).lastInsertRowid;
       db.prepare(
         "INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path) VALUES (?, ?, 'p.jpg', 't.jpg')"
       ).run(guestId, taskId);
     }
   }

   function badges() {
     return db
       .prepare(
         "SELECT b.code, gb.awarded_by FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id WHERE gb.guest_id = ? ORDER BY b.code"
       )
       .all(guestId)
       .map((r) => r.code + '(' + r.awarded_by + ')')
       .join(', ');
   }

   // 1) Zero tasks -> 0 points, no badges.
   scoring.recomputeAutoBadges(guestId);
   console.log('A) completed=%d points=%d badges=[%s]  (expect 0 / 0 / empty)',
     scoring.getCompletedCount(guestId), scoring.getPoints(guestId), badges());

   // 2) Five completed tasks -> 5 points, BLOOM granted by system.
   addSubmissions(5);
   scoring.recomputeAutoBadges(guestId);
   console.log('B) completed=%d points=%d badges=[%s]  (expect 5 / 5 / BLOOM(system))',
     scoring.getCompletedCount(guestId), scoring.getPoints(guestId), badges());

   // 3) Add bonus +3 -> points = 8, badges unchanged.
   scoring.addBonusPoints(guestId, 3);
   console.log('C) points=%d badges=[%s]  (expect 8 / BLOOM(system))',
     scoring.getPoints(guestId), badges());

   // 4) Take down one photo -> completed 4, BLOOM revoked. points = 4 + 3 bonus = 7.
   const oneSub = db
     .prepare('SELECT id FROM submissions WHERE guest_id = ? LIMIT 1')
     .get(guestId).id;
   db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(oneSub);
   scoring.recomputeAutoBadges(guestId);
   console.log('D) completed=%d points=%d badges=[%s]  (expect 4 / 7 / empty)',
     scoring.getCompletedCount(guestId), scoring.getPoints(guestId), badges());

   // 5) Award a special badge by hand -> SHUTTERBUG(admin) appears.
   scoring.awardSpecialBadge(guestId, 'SHUTTERBUG');
   console.log('E) badges=[%s]  (expect SHUTTERBUG(admin))', badges());

   // 6) Try to award a fake/auto code as "special" -> rejected, no change.
   const okBloom = scoring.awardSpecialBadge(guestId, 'BLOOM');   // auto, not special
   const okFake = scoring.awardSpecialBadge(guestId, 'NOPE');     // does not exist
   console.log('F) awardSpecial BLOOM=%s NOPE=%s badges=[%s]  (expect false / false / SHUTTERBUG(admin))',
     okBloom, okFake, badges());

   // 7) Remove the special badge.
   scoring.removeSpecialBadge(guestId, 'SHUTTERBUG');
   console.log('G) badges=[%s]  (expect empty)', badges());

   // 8) Leaderboard contains our guest with the right totals.
   const lb = scoring.leaderboard();
   const me = lb.find((r) => r.id === guestId);
   console.log('H) leaderboard row: completed=%d points=%d badges=%j  (expect 4 / 7 / [])',
     me.completed, me.points, me.badges);

   // 9) Bonus is clamped at 0: deduct more than the guest has -> bonus floored to 0.
   //    Guest currently has bonus 3 and completed 4. Deduct 10 -> bonus = MAX(0, 3-10) = 0,
   //    so points = completed(4) + bonus(0) = 4.
   scoring.addBonusPoints(guestId, -10);
   console.log('I) points=%d  (expect 4 — bonus clamped at 0, not negative)',
     scoring.getPoints(guestId));

   // 10) AUTO_THRESHOLDS is a plain numeric array for section 04's math.
   console.log('J) AUTO_THRESHOLDS=%j  (expect [5,10,15])', scoring.AUTO_THRESHOLDS);

   // Clean up the test guest so the DB stays tidy.
   db.prepare('DELETE FROM guests WHERE id = ?').run(guestId);
   console.log('Done. Test guest removed.');
   ```

3. **Run it:**

   ```powershell
   node tmp-scoring-check.js
   ```

4. **Expected output** (timestamps in task titles vary; the numbers must match):

   ```
   A) completed=0 points=0 badges=[]  (expect 0 / 0 / empty)
   B) completed=5 points=5 badges=[BLOOM(system)]  (expect 5 / 5 / BLOOM(system))
   C) points=8 badges=[BLOOM(system)]  (expect 8 / BLOOM(system))
   D) completed=4 points=7 badges=[]  (expect 4 / 7 / empty)
   E) badges=[SHUTTERBUG(admin)]  (expect SHUTTERBUG(admin))
   F) awardSpecial BLOOM=false NOPE=false badges=[SHUTTERBUG(admin)]  (expect false / false / SHUTTERBUG(admin))
   G) badges=[]  (expect empty)
   H) leaderboard row: completed=4 points=7 badges=[]  (expect 4 / 7 / [])
   I) points=4  (expect 4 — bonus clamped at 0, not negative)
   J) AUTO_THRESHOLDS=[5,10,15]  (expect [5,10,15])
   ```

   The pass conditions to confirm:
   - **B** proves an auto badge is granted exactly at the threshold, by `system`.
   - **D** proves a takedown drops the count and **revokes** the auto badge — the honest-leaderboard behavior from section 2.
   - **F** proves you cannot hand-award an auto code or a nonexistent code as a special badge (both return `false`).
   - **H** proves the leaderboard reflects the same totals and badge list, using the same canonical completed-count rule.
   - **I** proves bonus points are clamped at 0 (section 1a, Decision B) — over-deducting lands on 0, never negative. Section 08 depends on this.
   - **J** proves `AUTO_THRESHOLDS` is the plain numeric array section 04 expects (`[5,10,15]`), not the `{code,n}` object array.

5. **Delete the throwaway test file** so it does not ship:

   ```powershell
   Remove-Item tmp-scoring-check.js
   ```

If every line matches, `src/services/scoring.js` is complete and correct, and sections 04 (guest submit), 07 (gallery/leaderboard), and 08 (admin) can call into it as mapped in step 3.
