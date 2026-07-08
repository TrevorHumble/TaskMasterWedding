// tests/export-social.test.js
// Covers issue #192 acceptance criteria:
//   AC1 — Comments sheet exists with the right shape (Guest, Task, Photo Owner,
//         Comment, Date, Hidden), including a taken_down comment labeled YES.
//   AC2 — Submissions sheet carries Likes and Photo Bonus columns fed from
//         likes/submissions.photo_bonus.
//   AC3 — Comments sheet cells go through the same formula-injection guard as
//         every other sheet (neutralizeCell).
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH — export.js must be required after loadApp() too, or it
// binds to the real dev DB (see tests/export-injection.test.js for the same
// pattern).
'use strict';

const { loadApp } = require('./helpers/testApp');
const ExcelJS = require('exceljs');

let buildSummaryBuffer;
let db;
let guestId;
let taskId;
let submissionId;

beforeAll(() => {
  const result = loadApp();
  db = result.db;
  ({ buildSummaryBuffer } = require('../src/services/export'));

  taskId = db.prepare('INSERT INTO tasks (title) VALUES (?)').run('Find the cake').lastInsertRowid;

  guestId = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('social-guest', 'Priya').lastInsertRowid;

  submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, ?, 0, 2)`
    )
    .run(guestId, taskId, 'cake.jpg', 'cake-thumb.jpg', 'Found it!').lastInsertRowid;

  // Exactly 3 likes from 3 distinct liking guests (UNIQUE(submission_id, guest_id)
  // means one guest can only like a submission once, so 3 likers -> 3 rows).
  const likerIds = [];
  for (let i = 0; i < 3; i++) {
    likerIds.push(
      db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(`liker-${i}`, `Liker ${i}`)
        .lastInsertRowid
    );
  }
  const insertLike = db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)');
  for (const likerId of likerIds) {
    insertLike.run(submissionId, likerId);
  }

  // One visible comment, one hidden (taken_down) comment, one formula-injection
  // attempt — all from the same commenter for simplicity.
  const insertComment = db.prepare(
    `INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, ?)`
  );
  insertComment.run(submissionId, guestId, 'Congrats!', 0);
  insertComment.run(submissionId, guestId, 'Should be hidden', 1);
  insertComment.run(submissionId, guestId, '=SUM(A1)', 0);
});

describe('buildSummaryBuffer — social layer (issue #192)', () => {
  it('AC1: Comments sheet has the right shape, including a Hidden=YES row for a taken_down comment', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const commentsSheet = wb.getWorksheet('Comments');
    expect(commentsSheet).toBeTruthy();

    const headerRow = commentsSheet.getRow(1).values.slice(1); // ExcelJS values are 1-indexed
    expect(headerRow).toEqual(['Guest', 'Task', 'Photo Owner', 'Comment', 'Date', 'Hidden']);

    const rows = [];
    commentsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push(row.values.slice(1));
    });

    const visible = rows.find((r) => r[3] === 'Congrats!');
    expect(visible).toBeTruthy();
    expect(visible[0]).toBe('Priya'); // Guest (commenter)
    expect(visible[1]).toBe('Find the cake'); // Task
    expect(visible[2]).toBe('Priya'); // Photo Owner (same guest here)
    expect(visible[5]).toBe('no'); // Hidden

    const hidden = rows.find((r) => r[3] === 'Should be hidden');
    expect(hidden).toBeTruthy();
    // If the taken_down->Hidden mapping were inverted, this would read 'no'
    // instead of 'YES' and the assertion below would fail.
    expect(hidden[5]).toBe('YES');
  });

  it('AC2: Submissions sheet carries Likes=3 and Photo Bonus=2 for the seeded submission', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const subsSheet = wb.getWorksheet('Submissions');
    expect(subsSheet).toBeTruthy();

    const headerRow = subsSheet.getRow(1).values.slice(1);
    expect(headerRow).toContain('Likes');
    expect(headerRow).toContain('Photo Bonus');
    const likesCol = headerRow.indexOf('Likes') + 1; // back to 1-indexed
    const bonusCol = headerRow.indexOf('Photo Bonus') + 1;

    // Match the row by guest id (column 1) since submission id isn't a column;
    // there is exactly one submission for this guest.
    let found = null;
    subsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.values[1] === guestId) {
        found = row.values;
      }
    });

    expect(found).toBeTruthy();
    // If Likes/Photo Bonus were swapped or unpopulated, these would read 0/undefined
    // instead of 3/2.
    expect(found[likesCol]).toBe(3);
    expect(found[bonusCol]).toBe(2);
  });

  it('AC3: a comment body starting with =SUM(A1) is neutralized in the Comments sheet', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const commentsSheet = wb.getWorksheet('Comments');
    let neutralized = null;
    let bareFormula = false;

    commentsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const comment = row.values[4];
      if (comment === '=SUM(A1)') bareFormula = true;
      if (typeof comment === 'string' && comment.startsWith("'=SUM(A1)")) {
        neutralized = comment;
      }
    });

    expect(bareFormula).toBe(false);
    expect(neutralized).toBeTruthy();
    expect(neutralized.startsWith("'=")).toBe(true);
  });
});
