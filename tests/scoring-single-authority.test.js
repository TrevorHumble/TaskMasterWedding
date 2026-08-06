// tests/scoring-single-authority.test.js
// Issue #104 (0057): points/completed-count must come from ONE authority
// (src/services/scoring.js), so the admin guests page, the export Guests
// sheet, and scoring.js itself can never disagree.
//
// Fixture: one guest with one VISIBLE submission (taken_down = 0, photo_bonus
// = 3, liked once by a couple-flagged guest, issue #1107), one TAKEN-DOWN
// submission (taken_down = 1, photo_bonus = 9), and guests.bonus_points = 4.
// Canonical rule (scoring.js, issue #89; worth-aware since issue #727,
// rescaled 3-5/default 3 by issue #1103; couple-heart term added by #1107):
//   completed = COUNT(visible submissions) = 1.
//   points    = SUM(visible task worth) + SUM(visible photo_bonus)
//             + guests.bonus_points + couplePointsByGuest() + crowdPointsByGuest()
//             = 3 (taskA's default worth) + 3 + 4 + 1 (one couple like) + 5
//             = 16.
// The crowd-favorite term (issue #625) is not a separate fixture choice: in
// this file's otherwise-empty test database, the one like that pays the
// couple-heart term is ALSO the only like anywhere, so that same photo is
// the sole crowd favorite too (rank 1, 5 points): every like is a crowd vote
// regardless of who casts it, so this fixture cannot exercise couple-heart
// points without incidentally exercising crowd-favorite points as well. The
// taken-down submission's photo_bonus (9) is excluded, so it never adds to
// the total. If the completed-count rule were inverted (counting ALL or only
// taken-down submissions), completed would read 2 or 0; if the photo_bonus
// term were dropped from scoring.js, points would read 13 instead of 16; if
// the couple-heart term were dropped, points would read 15; if the
// crowd-favorite term were dropped, points would read 11: any of these
// would fail an assertion below.
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const ExcelJS = require('exceljs');

let db;
let adminAgent;
let scoring;
let buildSummaryBuffer;
let guestId;

const EXPECTED_COMPLETED = 1;
// worth(3) + visible photo_bonus(3) + guests.bonus_points(4) + couple like(1)
// + crowd-favorite (5, this guest's only liked photo is the sole placer)
const EXPECTED_POINTS = 16;

beforeAll(async () => {
  const loaded = loadApp();
  db = loaded.db;

  // Required AFTER loadApp() so config/db bind to the temp DATA_DIR/DB_PATH
  // (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
  scoring = require('../src/services/scoring');
  ({ buildSummaryBuffer } = require('../src/services/export'));

  const taskA = db
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Find the cake').lastInsertRowid;
  const taskB = db
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Dance with the couple').lastInsertRowid;

  guestId = db
    .prepare('INSERT INTO guests (token, name, bonus_points) VALUES (?, ?, ?)')
    .run('authority-guest', 'Authority Guest', 4).lastInsertRowid;

  // Visible submission — counts, and its photo_bonus (3) is included.
  const visibleSubmissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
     VALUES (?, ?, ?, ?, 0, 3)`
    )
    .run(guestId, taskA, 'visible.jpg', 'visible-thumb.jpg').lastInsertRowid;

  // Taken-down submission — must NOT count: neither its base point nor its
  // photo_bonus (9) contributes to the total.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
     VALUES (?, ?, ?, ?, 1, 9)`
  ).run(guestId, taskB, 'hidden.jpg', 'hidden-thumb.jpg');

  // One couple-flagged guest liking the visible submission: the couple-heart
  // term (issue #1107) this file's term-sum coverage now extends to.
  const coupleGuestId = db
    .prepare('INSERT INTO guests (token, name, is_couple) VALUES (?, ?, ?)')
    .run('authority-couple', 'Authority Couple', 1).lastInsertRowid;
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(
    visibleSubmissionId,
    coupleGuestId
  );

  adminAgent = await makeAdminAgent(loaded.app);
});

describe('scoring single authority — issue #104', () => {
  it('AC: scoring.getCompletedCount ignores the taken-down submission', () => {
    expect(scoring.getCompletedCount(guestId)).toBe(EXPECTED_COMPLETED);
  });

  it('AC: scoring.getPoints sums every term: worth, photo_bonus, bonus_points, couple-heart, crowd-favorite', () => {
    expect(scoring.getPoints(guestId)).toBe(EXPECTED_POINTS);
  });

  it('AC1/AC2: admin guests page shows the same completed-count and points', async () => {
    const res = await adminAgent.get('/admin/guests');
    expect(res.status).toBe(200);

    // Card shape from admin-guests.ejs (rebuilt by issue #1093): the guest's
    // row carries a meta line "<points> pts &middot; <completed> of <total>
    // tasks" (the literal HTML entity, and "of" rather than #257's "/").
    // Anchor on this guest's row id so we can't match a different guest's
    // meta line.
    const cardPattern = new RegExp(
      `id="guest-${guestId}"[\\s\\S]*?${EXPECTED_POINTS} pts &middot; ${EXPECTED_COMPLETED} of \\d+ tasks`
    );
    expect(res.text).toMatch(cardPattern);
  });

  it('AC3: export Guests sheet cells equal scoring.getCompletedCount/getPoints', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const guestsSheet = wb.getWorksheet('Guests');
    expect(guestsSheet).toBeTruthy();

    // Columns are, in order: Guest ID(1), Name(2), Completed Tasks(3),
    // Bonus Points(4), Total Points(5), Badges(6), Social Links(7).
    // A loaded (not freshly-addRow'd) workbook only supports positional
    // getCell(n), not getCell('key') — the key map is a write-time-only
    // convenience (see tests/export-injection.test.js for the same pattern).
    let row;
    guestsSheet.eachRow((r) => {
      if (r.getCell(1).value === guestId) {
        row = r;
      }
    });

    expect(row).toBeTruthy();
    expect(row.getCell(3).value).toBe(EXPECTED_COMPLETED);
    expect(row.getCell(5).value).toBe(EXPECTED_POINTS);
  });
});
