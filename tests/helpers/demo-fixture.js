// tests/helpers/demo-fixture.js
//
// A reusable, deterministic "realistic event" fixture: 10 named guests, 6
// demo tasks, and 18 submissions (16 visible + 2 taken-down) with a real
// point spread (a unique top score and a mid-pack tie). Used by both
// tests/demo-fixture.test.js and scripts/seed-demo.js so the demo data and
// its test coverage never drift apart.
//
// Scope: this module writes ONLY database rows. It never touches the
// filesystem — that is scripts/seed-demo.js's installSamplePhotos() job (see
// MANIFEST below for the exact filenames the two sides agree on).
//
// Filename convention: submissions.photo_path / thumb_path (and
// guests.avatar_path) must match the storage-filename allowlist enforced by
// src/services/photos.js's static-serve guards:
//   ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i
//   THUMB_RE    = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$/i
// Any other name 404s when the gallery tries to load it. The MANIFEST below
// uses fixed (non-random) 16-hex-char + numeric-stamp names so re-seeding is
// idempotent and always matches whatever installSamplePhotos() wrote to disk.
'use strict';

// Demo tasks carry this title prefix so seedDemo can find-and-delete exactly
// its own rows on every run without touching scripts/seed.js's real tasks.
const DEMO_TASK_PREFIX = 'Demo: ';

const DEMO_TASKS = [
  `${DEMO_TASK_PREFIX}Snap the getaway car`,
  `${DEMO_TASK_PREFIX}Find the guestbook`,
  `${DEMO_TASK_PREFIX}Toast the newlyweds`,
  `${DEMO_TASK_PREFIX}Spot a pastel bowtie`,
  `${DEMO_TASK_PREFIX}Catch the bouquet toss`,
  `${DEMO_TASK_PREFIX}Photograph the dessert table`,
];

// 10 guests: a mix of single- and multi-word real names, varied bonus_points,
// and >= 2 with a non-null avatar_path (filled in from MANIFEST.avatars below).
// `visibleTasks` lists which DEMO_TASKS indices (0-based) this guest has a
// VISIBLE (taken_down = 0) submission for — engineered so:
//   - Ava:            4 visible + bonus 2 = 6  -> unique top score
//   - Liam / Priya:   3 visible + bonus 0 = 3  -> mid-pack tie (not the max)
//   - Noah .. Isabella: 1 visible each, varied bonus, so >= 6 distinct guests
//     and >= 4 distinct tasks carry a visible submission
//   - Owen:           0 visible submissions (his 2 taken-down rows land here)
const DEMO_GUESTS = [
  { name: 'Ava Martinez', bonusPoints: 2, avatar: true, visibleTasks: [0, 1, 2, 3] },
  { name: 'Liam Chen', bonusPoints: 0, avatar: false, visibleTasks: [0, 1, 2] },
  { name: 'Priya Patel', bonusPoints: 0, avatar: true, visibleTasks: [1, 2, 3] },
  { name: 'Noah Thompson', bonusPoints: 1, avatar: false, visibleTasks: [4] },
  { name: 'Sofia Rossi', bonusPoints: 0, avatar: false, visibleTasks: [5] },
  { name: 'Ethan Wright', bonusPoints: 0, avatar: false, visibleTasks: [0] },
  { name: 'Maya Johnson', bonusPoints: 0, avatar: false, visibleTasks: [3] },
  { name: 'Jacob Lee', bonusPoints: 0, avatar: false, visibleTasks: [4] },
  { name: 'Isabella Garcia', bonusPoints: 0, avatar: false, visibleTasks: [5] },
  { name: 'Owen Bennett', bonusPoints: 0, avatar: false, visibleTasks: [] },
];

// Owen (index 9, no visible submissions) carries the 2 taken-down rows, on
// tasks he otherwise has no visible submission for — so his total stays 0.
const TAKEN_DOWN = [
  { guestIndex: 9, taskIndex: 0 },
  { guestIndex: 9, taskIndex: 1 },
];

// ---------------------------------------------------------------------------
// MANIFEST: deterministic {photo_path, thumb_path} pairs and avatar filenames.
// Fixed (not Date.now()/random) so re-seeding is idempotent and always lines
// up with whatever scripts/seed-demo.js's installSamplePhotos() wrote to
// UPLOADS_DIR / THUMBS_DIR. 16 hex chars + '-' + digits + '.jpg', matching
// ORIGINAL_RE; thumb name = original + '.jpg', matching THUMB_RE.
// ---------------------------------------------------------------------------
// Derived (not hand-maintained) so it can never silently drift from the
// guest/taken-down data above: sum of every guest's visibleTasks length (16)
// plus TAKEN_DOWN.length (2) = 18.
const SUBMISSION_COUNT =
  DEMO_GUESTS.reduce((n, g) => n + g.visibleTasks.length, 0) + TAKEN_DOWN.length;

function buildManifest() {
  const photos = [];
  for (let i = 0; i < SUBMISSION_COUNT; i++) {
    // 16 hex chars: pad the index into a fixed-width hex string prefixed with
    // zeros, e.g. "000000000000000a". Numeric stamp is a fixed 13-digit value
    // (looks like a millisecond timestamp) offset by i so each is distinct.
    const hex = i.toString(16).padStart(16, '0');
    const stamp = 1700000000000 + i;
    const photo_path = `${hex}-${stamp}.jpg`;
    const thumb_path = thumbNameFor(photo_path);
    photos.push({ photo_path, thumb_path });
  }

  const avatars = ['aaaaaaaaaaaaaaaa-1700000001000.jpg', 'bbbbbbbbbbbbbbbb-1700000002000.jpg'];

  return { photos, avatars };
}

const MANIFEST = buildManifest();

// The stored thumbnail name is dictated by src/services/photos.js: its PUBLIC
// storage-serve allowlist THUMB_RE requires thumb = original + '.jpg', and
// makeThumb() derives its return value the same way. This is the single place
// that rule lives on the fixture side — scripts/seed-demo.js asserts at
// install time (via photos.makeThumb's actual return value) that this still
// agrees with photos.js, so a future change to makeThumb's naming is caught
// there, not silently.
function thumbNameFor(originalName) {
  return `${originalName}.jpg`;
}

// ---------------------------------------------------------------------------
// Seeding.
// ---------------------------------------------------------------------------

/**
 * Clean-then-seed a realistic demo data set into `db`.
 *
 * Deletes (in order, inside one transaction): all submissions, all guests,
 * and any task whose title starts with DEMO_TASK_PREFIX — so scripts/seed.js's
 * real tasks/badges are left untouched, but re-running this on a demo DB
 * always produces the exact same 10 guests / 18 submissions.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ taskIds: number[], guestIds: number[] }}
 */
function seedDemo(db) {
  const run = db.transaction(() => {
    // --- Clean: submissions first (FK), then guests, then demo-prefixed tasks. ---
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM guests').run();
    db.prepare(`DELETE FROM tasks WHERE title LIKE ?`).run(`${DEMO_TASK_PREFIX}%`);

    // --- Seed tasks. ---
    const insertTask = db.prepare(
      `INSERT INTO tasks (title, description, sort_order) VALUES (?, ?, ?)`
    );
    const taskIds = DEMO_TASKS.map(
      (title, index) => insertTask.run(title, '', index).lastInsertRowid
    );

    // --- Seed guests. ---
    const insertGuest = db.prepare(
      `INSERT INTO guests (token, name, avatar_path, bonus_points, onboarded)
       VALUES (?, ?, ?, ?, 1)`
    );
    let avatarSeq = 0;
    const guestIds = DEMO_GUESTS.map((g, index) => {
      const token = `demo-guest-token-${index}`;
      // Wrap (%) intentionally: more avatar-bearing guests than avatar files
      // is tolerated by cycling back through MANIFEST.avatars, unlike photo
      // indexing below which must never repeat a pair.
      const avatarPath = g.avatar ? MANIFEST.avatars[avatarSeq++ % MANIFEST.avatars.length] : null;
      return insertGuest.run(token, g.name, avatarPath, g.bonusPoints).lastInsertRowid;
    });

    // --- Seed submissions: visible first, then taken-down, each getting the
    //     next manifest pair in order so every row's photo_path/thumb_path is
    //     unique and traceable back to MANIFEST. Distinct created_at per row
    //     (offset by index) so ordering is deterministic. ---
    const insertSubmission = db.prepare(
      `INSERT INTO submissions
         (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`
    );

    let manifestIndex = 0;
    const baseTime = new Date('2026-08-07T18:00:00Z').getTime();
    function nextCreatedAt() {
      const ts = new Date(baseTime + manifestIndex * 60000); // +1 min per row
      return ts
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
    }

    // Shared by both the visible and taken-down loops below so the insert
    // body (and manifest-pair/created_at bookkeeping) exists in one place.
    function insertOne(guestId, taskId, takenDown) {
      const pair = MANIFEST.photos[manifestIndex];
      insertSubmission.run(
        guestId,
        taskId,
        pair.photo_path,
        pair.thumb_path,
        takenDown,
        nextCreatedAt()
      );
      manifestIndex += 1;
    }

    DEMO_GUESTS.forEach((g, guestIndex) => {
      for (const taskIndex of g.visibleTasks) {
        insertOne(guestIds[guestIndex], taskIds[taskIndex], 0);
      }
    });

    for (const td of TAKEN_DOWN) {
      insertOne(guestIds[td.guestIndex], taskIds[td.taskIndex], 1);
    }

    return { taskIds, guestIds };
  });

  return run();
}

module.exports = {
  seedDemo,
  thumbNameFor,
  MANIFEST,
  DEMO_TASK_PREFIX,
  DEMO_TASKS,
  DEMO_GUESTS,
  TAKEN_DOWN,
};
