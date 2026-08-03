// tests/event-stats.test.js
// Service-level coverage for src/services/event-stats.js (issue #1022),
// direct DB seeding, no HTTP layer. Covers AC1-AC5 of the issue.
//
//   AC1 — eventDaySeries() buckets guests/photos into event-local calendar
//         days, labelled Fri/Sat/Sun (no duplicate weekday in a 3-row series).
//   AC2 — hourSeries() buckets by event-local HOUR, discriminating a bare
//         new Date(created_at) parse (wrong off UTC) from parseSqliteDatetime
//         (correct everywhere) — this suite pins process.env.TZ to a non-UTC
//         zone so the discriminating case actually fires (see event-days.js's
//         own AC2 test for the same discipline).
//   AC3 — a guest outside the configured range still lands in the series (the
//         union scope rule), and a duplicate weekday triggers the all-or-
//         nothing "Aug 7" fallback for every row.
//   AC4 — perTaskCompletion() ties break on sort_order; a memory (task_id
//         NULL) is absent from it but still counted in eventDaySeries()'s
//         photos.
//   AC5 — engagementTotals() is visibility-gated; participationBands() is
//         NOT — guest D (a like on a taken-down photo) is the case that
//         discriminates the two.
//
// REQUIRE ORDER: config / db are only required via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let eventStats;

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  // Required only after loadApp() so it reads the temp DATA_DIR-backed db.js
  // (event-stats.js requires ../db at its own top level).
  eventStats = require('../src/services/event-stats');
});

function resetTables() {
  db.prepare('DELETE FROM comments').run();
  db.prepare('DELETE FROM likes').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
}

function insertGuest(token, createdAt) {
  return db
    .prepare('INSERT INTO guests (token, name, created_at) VALUES (?, ?, ?)')
    .run(token, 'Guest ' + token, createdAt).lastInsertRowid;
}

function insertTask(title, sortOrder) {
  return db
    .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, ?)')
    .run(title, sortOrder || 0).lastInsertRowid;
}

function insertSubmission(guestId, taskId, takenDown, createdAt) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg', takenDown ? 1 : 0, createdAt).lastInsertRowid;
}

function insertLike(submissionId, guestId) {
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(
    submissionId,
    guestId
  );
}

function insertComment(submissionId, guestId, takenDown) {
  db.prepare(
    'INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, ?)'
  ).run(submissionId, guestId, 'nice!', takenDown ? 1 : 0);
}

// Default event config (settings unset) is America/Boise, 2026-08-07..09 —
// see src/db/event-config.js's getEventConfig() default. Every fixture below
// is built around that default range on purpose, matching the issue's own
// AC1 fixture.

describe('AC1: eventDaySeries buckets by event-local calendar day', () => {
  it('3 guests total (the third posts nothing): 2 guests + 3 photos on Aug 8, 1 guest + 1 photo on Aug 9 -> 3 rows, Fri/Sat/Sun, correct per-day counts', () => {
    resetTables();
    const taskId = insertTask('Selfie with the cake');

    // Aug 8 event-local: 19:00-23:00 MDT (UTC-6) = 01:00-05:00Z Aug 9.
    // g1 posts all 3 of Aug 8's photos; g2 joins but posts nothing — the
    // "third" guest AC1 pins, so joins (2) and photos (3) genuinely differ
    // on this day rather than coincidentally matching, the way a prior
    // version of this fixture let joins===photos on every row and left
    // src/services/event-stats.js:85-86 free to swap without failing.
    const g1 = insertGuest('ac1-g1', '2026-08-09 01:00:00');
    const g2 = insertGuest('ac1-g2', '2026-08-09 02:00:00');
    insertSubmission(g1, taskId, false, '2026-08-09 03:00:00');
    // UNIQUE(guest_id, task_id) allows at most one task-linked row per task,
    // so g1's other two Aug 8 photos are memories (task_id NULL) — SQL NULLs
    // never collide against the unique index, so multiple memories from the
    // same guest are fine.
    insertSubmission(g1, null, false, '2026-08-09 03:30:00');
    insertSubmission(g1, null, false, '2026-08-09 04:00:00');

    // Aug 9 event-local: 2026-08-10 01:00Z.
    const g3 = insertGuest('ac1-g3', '2026-08-10 01:00:00');
    insertSubmission(g3, taskId, false, '2026-08-10 02:00:00');

    const series = eventStats.eventDaySeries();
    expect(series.map((r) => r.iso)).toEqual(['2026-08-07', '2026-08-08', '2026-08-09']);
    expect(series.map((r) => r.label)).toEqual(['Fri', 'Sat', 'Sun']);

    const aug8 = series.find((r) => r.iso === '2026-08-08');
    const aug9 = series.find((r) => r.iso === '2026-08-09');
    expect(aug8).toMatchObject({ joins: 2, photos: 3 });
    expect(aug9).toMatchObject({ joins: 1, photos: 1 });
    expect(g2).toBeTruthy(); // g2 joined and is counted, but authored none of the 3 photos
  });
});

describe('AC2: hourSeries buckets by event-local HOUR (TZ-pinned)', () => {
  const originalTZ = process.env.TZ;
  beforeAll(() => {
    // Non-UTC, matching event-days.test.js's own discipline: this is what
    // discriminates parseSqliteDatetime (correct off UTC) from a bare
    // `new Date(created_at)` parse (silently correct only at UTC, since
    // vitest.config.mjs pins no TZ and CI runs at UTC).
    process.env.TZ = 'America/Boise';
  });
  afterAll(() => {
    if (originalTZ === undefined) delete process.env.TZ;
    else process.env.TZ = originalTZ;
  });

  it('literal stored strings 01:05/01:40/01:20 on 2026-08-09 (19:05/19:40/19:20 MDT on 2026-08-08) bucket into hour 19', () => {
    resetTables();
    const taskId = insertTask('Selfie with the cake');
    const g1 = insertGuest('ac2-g1', '2026-08-09 01:05:00');
    insertGuest('ac2-g2', '2026-08-09 01:40:00');
    insertSubmission(g1, taskId, false, '2026-08-09 01:20:00');

    const hours = eventStats.hourSeries('2026-08-08');
    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));

    const hour19 = hours.find((h) => h.hour === 19);
    expect(hour19).toEqual({ hour: 19, joins: 2, photos: 1 });

    // Every other hour is zero — a wrong bare-Date parse would have landed
    // these in hour 1, not hour 19, and this assertion would catch it.
    const others = hours.filter((h) => h.hour !== 19);
    others.forEach((h) => expect(h).toMatchObject({ joins: 0, photos: 0 }));
  });
});

describe('AC3: a day outside the configured range still lands in the series; a duplicate weekday triggers the all-or-nothing fallback', () => {
  it('a guest joining 2026-08-14 (also a Friday) yields 4 rows, sums equal the totals, every label falls back to "Aug 7" form', () => {
    resetTables();
    insertGuest('ac3-g1', '2026-08-07 12:00:00'); // Fri, in range
    insertGuest('ac3-g2', '2026-08-08 12:00:00'); // Sat, in range
    insertGuest('ac3-g3', '2026-08-14 12:00:00'); // Fri, OUT of range — duplicate weekday
    const taskId = insertTask('Selfie with the cake');
    const g4 = insertGuest('ac3-g4', '2026-08-08 13:00:00');
    insertSubmission(g4, taskId, false, '2026-08-08 13:30:00');

    const series = eventStats.eventDaySeries();
    expect(series).toHaveLength(4);
    expect(series.map((r) => r.iso)).toEqual([
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
      '2026-08-14',
    ]);

    const joinSum = series.reduce((s, r) => s + r.joins, 0);
    const photoSum = series.reduce((s, r) => s + r.photos, 0);
    expect(joinSum).toBe(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n);
    expect(photoSum).toBe(
      db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0').get().n
    );

    // Two Fridays (Aug 7 and Aug 14) -> every row falls back, none reads "Fri".
    series.forEach((r) => expect(r.label).not.toBe('Fri'));
    expect(series.map((r) => r.label)).toEqual(['Aug 7', 'Aug 8', 'Aug 9', 'Aug 14']);
  });
});

describe('AC4: perTaskCompletion ties break on sort_order; a memory is absent from it but still a photo', () => {
  it('descending count, tie broken by sort_order ascending; the memory counts in eventDaySeries photos, not perTaskCompletion', () => {
    resetTables();
    const taskA = insertTask('Task A (2 visible, 1 taken down)', 5);
    const taskB = insertTask('Task B (5 visible)', 10);
    const taskC = insertTask('Task C (2 visible, lower sort_order than A)', 1);

    const guests = Array.from({ length: 10 }, (_, i) =>
      insertGuest('ac4-g' + i, '2026-08-08 12:00:00')
    );
    let gi = 0;
    insertSubmission(guests[gi++], taskA, false, '2026-08-08 12:00:00');
    insertSubmission(guests[gi++], taskA, false, '2026-08-08 12:01:00');
    insertSubmission(guests[gi++], taskA, true, '2026-08-08 12:02:00'); // taken down

    for (let i = 0; i < 5; i++) {
      insertSubmission(guests[gi++], taskB, false, '2026-08-08 12:0' + i + ':00');
    }

    insertSubmission(guests[gi++], taskC, false, '2026-08-08 12:10:00');
    insertSubmission(guests[gi], taskC, false, '2026-08-08 12:11:00');

    // A memory: task_id NULL, visible.
    const memoryGuest = insertGuest('ac4-memory', '2026-08-08 12:20:00');
    insertSubmission(memoryGuest, null, false, '2026-08-08 12:21:00');

    const rows = eventStats.perTaskCompletion();
    expect(rows).toEqual([
      { taskId: taskB, title: 'Task B (5 visible)', count: 5 },
      { taskId: taskC, title: 'Task C (2 visible, lower sort_order than A)', count: 2 },
      { taskId: taskA, title: 'Task A (2 visible, 1 taken down)', count: 2 },
    ]);
    expect(rows.some((r) => r.taskId === null)).toBe(false);

    const series = eventStats.eventDaySeries();
    const aug8 = series.find((r) => r.iso === '2026-08-08');
    // 2(A) + 5(B) + 2(C) + 1(memory) = 10 visible photos on Aug 8.
    expect(aug8.photos).toBe(10);
  });
});

describe('AC5: engagementTotals is visibility-gated; participationBands is not', () => {
  it("guest D's like on a taken-down photo counts toward engagingOnly but not toward likes", () => {
    resetTables();
    const taskId = insertTask('Selfie with the cake');

    const a = insertGuest('ac5-a', '2026-08-08 10:00:00');
    const b = insertGuest('ac5-b', '2026-08-08 10:01:00');
    const c = insertGuest('ac5-c', '2026-08-08 10:02:00');
    const d = insertGuest('ac5-d', '2026-08-08 10:03:00');
    insertGuest('ac5-e', '2026-08-08 10:04:00'); // e: nothing at all

    const aSub = insertSubmission(a, taskId, false, '2026-08-08 10:10:00');
    const bSub = insertSubmission(b, taskId, true, '2026-08-08 10:11:00'); // taken down

    insertLike(aSub, c); // C likes A's visible photo
    insertLike(bSub, d); // D likes B's taken-down photo

    insertComment(aSub, a, false); // 1 visible comment
    insertComment(aSub, a, true); // 1 hidden comment

    expect(eventStats.engagementTotals()).toEqual({ likes: 1, comments: 1 });

    const bands = eventStats.participationBands();
    expect(bands).toEqual({ posting: 2, engagingOnly: 2, idle: 1, total: 5 });
    expect(bands.posting + bands.engagingOnly + bands.idle).toBe(bands.total);
  });
});
