// tests/scoring-single-authority.test.js
// Issue #104 (0057): points/completed-count must come from ONE authority
// (src/services/scoring.js), so the admin guests page, the export Guests
// sheet, and scoring.js itself can never disagree.
//
// Fixture: one guest with one VISIBLE submission (taken_down = 0, photo_bonus
// = 3), one TAKEN-DOWN submission (taken_down = 1, photo_bonus = 9), and
// guests.bonus_points = 4.
// Canonical rule (scoring.js, three-term formula, issue #89):
//   completed = COUNT(visible submissions) = 1.
//   points    = completed*POINTS_PER_PHOTO + SUM(visible photo_bonus) + guests.bonus_points
//             = 1*1 + 3 + 4 = 8.
// The taken-down submission's photo_bonus (9) is excluded, so it never adds to
// the total. If the completed-count rule were inverted (counting ALL or only
// taken-down submissions), completed would read 2 or 0; if the photo_bonus
// term were dropped from scoring.js, points would read 5 instead of 8 — either
// way an assertion below would fail.
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');
const ExcelJS = require('exceljs');

let db;
let adminAgent;
let scoring;
let buildSummaryBuffer;
let guestId;

const EXPECTED_COMPLETED = 1;
const EXPECTED_POINTS = 8; // completed(1)*1 + visible photo_bonus(3) + guests.bonus_points(4)

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
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
     VALUES (?, ?, ?, ?, 0, 3)`
  ).run(guestId, taskA, 'visible.jpg', 'visible-thumb.jpg');

  // Taken-down submission — must NOT count: neither its base point nor its
  // photo_bonus (9) contributes to the total.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
     VALUES (?, ?, ?, ?, 1, 9)`
  ).run(guestId, taskB, 'hidden.jpg', 'hidden-thumb.jpg');

  adminAgent = await makeAdminAgent(loaded.app);
});

describe('scoring single authority — issue #104', () => {
  it('AC: scoring.getCompletedCount ignores the taken-down submission', () => {
    expect(scoring.getCompletedCount(guestId)).toBe(EXPECTED_COMPLETED);
  });

  it('AC: scoring.getPoints = completed*POINTS_PER_PHOTO + visible photo_bonus + guests.bonus_points', () => {
    expect(scoring.getPoints(guestId)).toBe(EXPECTED_POINTS);
  });

  it('AC1/AC2: admin guests page shows the same completed-count and points', async () => {
    const res = await adminAgent.get('/admin/guests');
    expect(res.status).toBe(200);

    // Card shape from admin-guests.ejs (#257): the guest's card carries a
    // meta line "<points> pts · <completed>/<total> tasks". Anchor on this
    // guest's card id so we can't match a different guest's meta line.
    const cardPattern = new RegExp(
      `id="guest-${guestId}"[\\s\\S]*?${EXPECTED_POINTS} pts · ${EXPECTED_COMPLETED}/\\d+ tasks`
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
