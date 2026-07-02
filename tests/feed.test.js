// tests/feed.test.js
// Covers issue #107 acceptance criteria — calls src/services/feed.js
// directly (no HTTP), so these tests exercise the visibility/ordering rule
// itself rather than parsing rendered HTML.
//
//   AC1 — recentPage(): newest-first order, page 1 pagination math, totalPages
//   AC2 — every operation excludes taken_down = 1 submissions
//   AC3 — neighbors(): newer/older for a visible pivot; skips a taken-down
//         immediate neighbor; not-found result for a missing/taken-down pivot
//
// REQUIRE ORDER: config / db / feed are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH (see tests/helpers/testApp.js). Do not hoist requires
// above the loadApp() call.
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let feed;

// Seeded ids, set in beforeAll.
let taskId1;
let taskId2;
let guestId1; // "Alice"
let guestId2; // "" (empty name -> falls back to "Guest" in grouped('user'))
let idA; // oldest, visible
let idB; // middle, visible
let idC; // newest, visible
let idX; // taken-down, sits between A and B

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  // feed.js is required only now, after loadApp() has set DATA_DIR/DB_PATH
  // and required src/db.js once (module cache), so it opens the same temp DB.
  feed = require('../src/services/feed');

  guestId1 = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('feedtoken1', 'Alice').lastInsertRowid;
  // Empty name on purpose — exercises the grouped('user') "Guest" fallback.
  guestId2 = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('feedtoken2', '').lastInsertRowid;

  taskId1 = db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run('Cut the cake').lastInsertRowid;
  taskId2 = db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run('First dance').lastInsertRowid;

  // A (oldest) -> X (taken-down) -> B -> C (newest), one-hour steps so
  // created_at ordering is unambiguous.
  idA = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, 'a.jpg', 'at.jpg', 'Caption A', 0, '2024-06-01 10:00:00')`
    )
    .run(guestId1, taskId1).lastInsertRowid;

  idX = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'x.jpg', 'xt.jpg', 1, '2024-06-01 11:00:00')`
    )
    .run(guestId2, taskId1).lastInsertRowid;

  idB = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'b.jpg', 'bt.jpg', 0, '2024-06-01 12:00:00')`
    )
    .run(guestId1, taskId2).lastInsertRowid;

  idC = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'c.jpg', 'ct.jpg', 0, '2024-06-01 13:00:00')`
    )
    .run(guestId2, taskId2).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC1 — recentPage(): newest-first order + pagination math
// ---------------------------------------------------------------------------
describe('AC1: recentPage ordering and pagination', () => {
  it('page 1 returns visible submissions newest-first: [C, B, A]', () => {
    const result = feed.recentPage(null, 1);
    const ids = result.photos.map((p) => p.submission_id);
    // Real expected values, not just "some order" — this fails if DESC/ASC
    // or the id tiebreak is broken.
    expect(ids).toEqual([idC, idB, idA]);
  });

  it('totalPages equals ceil(total / GALLERY_PAGE_SIZE) with more rows than one page', () => {
    // Insert enough additional visible submissions (one per task, since
    // (guest_id, task_id) is UNIQUE) to exceed GALLERY_PAGE_SIZE, all older
    // than idA so they sort after C/B/A and don't disturb the [C, B, A]
    // assertion above. Torn down at the end of this test (via the cascading
    // guest delete) so later tests in this file — which assert "A is the
    // oldest submission that exists" / "C is the newest" — see exactly the
    // A/B/C/X fixture from beforeAll, not this test's temporary bulk data.
    const extraCount = feed.GALLERY_PAGE_SIZE + 5;
    const extraGuestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('feed-extra-guest', 'Bulk Guest').lastInsertRowid;
    for (let i = 0; i < extraCount; i++) {
      const tid = db
        .prepare(`INSERT INTO tasks (title) VALUES (?)`)
        .run(`Bulk task ${i}`).lastInsertRowid;
      db.prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, ?, ?, 0, '2024-01-01 00:00:00')`
      ).run(extraGuestId, tid, `bulk-${i}.jpg`, `bulk-${i}-t.jpg`);
    }

    try {
      // 4 from beforeAll (A, B, C visible; X hidden) + extraCount new visible ones.
      const expectedTotal = 3 + extraCount;
      const result = feed.recentPage(null, 1);

      expect(result.total).toBe(expectedTotal);
      expect(result.totalPages).toBe(Math.ceil(expectedTotal / feed.GALLERY_PAGE_SIZE));
      // Page 1 returns exactly the newest GALLERY_PAGE_SIZE of them.
      expect(result.photos.length).toBe(feed.GALLERY_PAGE_SIZE);
    } finally {
      // Cascading delete (submissions.guest_id REFERENCES guests(id) ON DELETE
      // CASCADE) removes the guest and every bulk submission it owns in one
      // statement, restoring the table for every test that runs after this one.
      db.prepare(`DELETE FROM guests WHERE id = ?`).run(extraGuestId);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — taken-down submissions never appear in ANY feed operation
// ---------------------------------------------------------------------------
describe('AC2: taken-down submissions are excluded everywhere', () => {
  it('recentPage() never includes the taken-down id', () => {
    const result = feed.recentPage(null, 1);
    const ids = result.photos.map((p) => p.submission_id);
    expect(ids).not.toContain(idX);
  });

  it("grouped('task') never includes the taken-down id", () => {
    const groups = feed.grouped('task', null);
    const allIds = groups.flatMap((g) => g.photos.map((p) => p.submission_id));
    expect(allIds).not.toContain(idX);
  });

  it("grouped('user') never includes the taken-down id", () => {
    const groups = feed.grouped('user', null);
    const allIds = groups.flatMap((g) => g.photos.map((p) => p.submission_id));
    expect(allIds).not.toContain(idX);
  });

  it('guestPhotos() never includes the taken-down id (even for its own guest)', () => {
    // idX belongs to guestId2 — confirm it is filtered from that exact guest's feed.
    const photos = feed.guestPhotos(guestId2);
    const ids = photos.map((p) => p.submission_id);
    expect(ids).not.toContain(idX);
  });

  it('detail() returns null for a taken-down id', () => {
    expect(feed.detail(idX)).toBeNull();
  });

  it('neighbors() returns a not-found result for a taken-down pivot', () => {
    const result = feed.neighbors(idX);
    expect(result.found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — neighbors(): newer/older for a visible pivot; skip taken-down;
//        not-found for a missing/taken-down pivot
// ---------------------------------------------------------------------------
describe('AC3: neighbors', () => {
  it('for visible pivot B: newer is C, older is A (skipping taken-down X)', () => {
    const result = feed.neighbors(idB);
    expect(result.found).toBe(true);
    // Real expected VALUES — this fails if the immediate (taken-down) neighbor
    // X were returned instead of the correct visible one.
    expect(result.newer).toBe(idC);
    expect(result.older).toBe(idA);
  });

  it('for the newest visible submission C: newer is null (nothing newer exists)', () => {
    const result = feed.neighbors(idC);
    expect(result.found).toBe(true);
    expect(result.newer).toBeNull();
  });

  it('for the oldest visible submission A: older is null (nothing older exists)', () => {
    const result = feed.neighbors(idA);
    expect(result.found).toBe(true);
    expect(result.older).toBeNull();
  });

  it('a nonexistent submissionId returns a not-found result', () => {
    const result = feed.neighbors(999999);
    expect(result.found).toBe(false);
  });

  it('newer skips a taken-down submission between the pivot and the next visible row', () => {
    // Insert a taken-down row strictly between B (12:00) and C (13:00), the
    // mirror of the X fixture (between A and B) that the older-side test
    // above already exercises. Proves the newer-neighbor keyset lookup skips
    // taken-down rows too, not just the older-neighbor lookup.
    //
    // Every (guestId1|guestId2) x (taskId1|taskId2) pair is already taken by
    // A/X/B/C (submissions has a UNIQUE(guest_id, task_id) constraint), so
    // this needs its own task — same pattern as the AC1 pagination test's
    // scoped fixture rows, cleaned up in `finally`.
    const extraTaskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Bouquet toss').lastInsertRowid;
    const idY = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, 'y.jpg', 'yt.jpg', 1, '2024-06-01 12:30:00')`
      )
      .run(guestId1, extraTaskId).lastInsertRowid;

    try {
      const result = feed.neighbors(idB);
      expect(result.found).toBe(true);
      // Real expected VALUE — this fails if the immediate (taken-down) neighbor
      // Y were returned instead of skipping through to the correct visible one.
      expect(result.newer).toBe(idC);
    } finally {
      // Remove Y and its task so later tests in this file see the original
      // A/B/C/X fixture.
      db.prepare(`DELETE FROM submissions WHERE id = ?`).run(idY);
      db.prepare(`DELETE FROM tasks WHERE id = ?`).run(extraTaskId);
    }
  });

  it('detail() returns the visible row (not null) for a real visible id', () => {
    // Confirms detail() itself distinguishes visible from hidden — if the
    // taken_down predicate were inverted, this would return null instead.
    const row = feed.detail(idB);
    expect(row).not.toBeNull();
    expect(row.submission_id).toBe(idB);
  });
});

// ---------------------------------------------------------------------------
// AC4 — grouped(): groups by task title or guest name; empty name -> "Guest"
// ---------------------------------------------------------------------------
describe("AC4: grouped('task') and grouped('user')", () => {
  it("grouped('task') groups by task title", () => {
    const groups = feed.grouped('task', null);
    const headings = groups.map((g) => g.heading);
    expect(headings).toContain('Cut the cake');
    expect(headings).toContain('First dance');
  });

  it("grouped('user') groups by guest name, falling back to 'Guest' for an empty name", () => {
    const groups = feed.grouped('user', null);
    const headings = groups.map((g) => g.heading);
    // guestId1 has name "Alice"; guestId2 has an empty name -> "Guest".
    expect(headings).toContain('Alice');
    expect(headings).toContain('Guest');
  });
});
