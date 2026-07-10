// tests/export-zip.test.js
// Issue #181: the export is the keepsake (Goal D). Covers the ZIP route
// (headers, per-guest folder naming, missing-file skip, taken-down inclusion,
// extension fallback) and the summary.xlsx workbook (Guests/Submissions/
// Badges/Comments sheets), plus a safeName unit table.
//
// tests/export-injection.test.js (neutralizeCell) and tests/export-social.test.js
// (social-links / likes / photo-bonus / comments columns) already cover their
// own acceptance criteria — this file does not repeat those assertions.
//
// REQUIRE ORDER: config / db / export are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH.
'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

// A 1x1 red pixel PNG — valid-enough bytes for a file the export just streams
// as-is (it never decodes the image), tiny and dependency-free.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let app;
let db;
let adminAgent;
let uploadsDir;
let buildSummaryBuffer;
let safeName;
let scoring;

// Fixture ids, filled in beforeAll.
let guestA; // 'Lilly & Axel #1!' — real photo + missing photo, liked, commented on
let guestB; // nameless — taken-down photo, also a liker/commenter
let taskA;
let taskB;
let subA; // guestA/taskA — real file on disk, photo_bonus 4

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);

  // Required only now: both modules require ../db, which reads
  // config.DATA_DIR at module-load time. Requiring them before loadApp() sets
  // DATA_DIR would bind them to the real project data/app.db instead of this
  // test's temp DB.
  const config = require('../config');
  uploadsDir = config.UPLOADS_DIR;
  ({ buildSummaryBuffer, safeName } = require('../src/services/export'));
  scoring = require('../src/services/scoring');

  guestA = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('exportguesta00000000000000000a', 'Lilly & Axel #1!').lastInsertRowid;
  guestB = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('exportguestb00000000000000000b', '').lastInsertRowid;

  taskA = db
    .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
    .run('Find the Cake').lastInsertRowid;
  taskB = db
    .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)')
    .run('Dance Floor').lastInsertRowid;

  // (a) real file on disk, visible, photo_bonus 4.
  fs.writeFileSync(path.join(uploadsDir, 'real-a.jpg'), TINY_PNG);
  subA = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, 0, 4)`
    )
    .run(guestA, taskA, 'real-a.jpg', 'real-a.jpg.jpg').lastInsertRowid;

  // (b) photo_path names a file that does NOT exist on disk.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guestA, taskB, 'missing-b.jpg', 'missing-b.jpg.jpg');

  // (c) taken down, but the file still exists — "nothing is lost" contract.
  fs.writeFileSync(path.join(uploadsDir, 'takendown-c.jpg'), TINY_PNG);
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 1)`
  ).run(guestB, taskA, 'takendown-c.jpg', 'takendown-c.jpg.jpg');

  // Likes on (a) from both guests.
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(subA, guestA);
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(subA, guestB);

  // One visible comment, one hidden comment, both on (a).
  db.prepare(
    'INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 0)'
  ).run(subA, guestB, 'Congrats you two!');
  db.prepare(
    'INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 1)'
  ).run(subA, guestA, 'Removed later.');

  // BLOOM (threshold 5) and CHOICE (threshold NULL) already exist here
  // (#314): src/db.js's boot-heal runs ensureBadgeCatalog() at module load,
  // so loadApp() above already seeded the canonical catalog — including the
  // one-with-a-threshold / one-without-a-threshold pair the null-render check
  // below needs, with no manual insert required.

  // Extension-fallback fixture: an uppercase .PNG and a no-extension file.
  const extGuest = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('extguesttoken0000000000000000a', 'Ext Guest').lastInsertRowid;
  const extTaskUpper = db
    .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 2)')
    .run('Ext Task Upper').lastInsertRowid;
  const extTaskNone = db
    .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 3)')
    .run('Ext Task None').lastInsertRowid;

  fs.writeFileSync(path.join(uploadsDir, 'upper.PNG'), TINY_PNG);
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(extGuest, extTaskUpper, 'upper.PNG', 'upper.PNG.jpg');

  fs.writeFileSync(path.join(uploadsDir, 'noext'), TINY_PNG);
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(extGuest, extTaskNone, 'noext', 'noext.jpg');
});

// Binary-safe response parser: accumulate raw Buffer chunks rather than
// letting superagent coerce the body through a string encoding, which would
// corrupt the ZIP bytes.
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function fetchZip() {
  const res = await adminAgent.get('/admin/export').buffer(true).parse(binaryParser);
  return res;
}

describe('GET /admin/export — headers', () => {
  it('AC: 200, application/zip, and a dated attachment filename', async () => {
    const res = await fetchZip();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="garden-party-export-\d{4}-\d{2}-\d{2}\.zip"/
    );
  });
});

describe('GET /admin/export — ZIP entries', () => {
  it('the archive contains summary.xlsx', async () => {
    const res = await fetchZip();
    expect(res.body.includes(Buffer.from('summary.xlsx'))).toBe(true);
  });

  it('per-guest folder naming: safeName + id for the named guest, guest-<id> fallback for nameless', async () => {
    const res = await fetchZip();

    const folderA = `${safeName('Lilly & Axel #1!', 'guest')}-${guestA}`;
    const expectedEntryA = `${folderA}/task-0-Find-the-Cake.jpg`;
    expect(res.body.includes(Buffer.from(expectedEntryA))).toBe(true);

    // Nameless guest (guestB) has one submission: the taken-down one on taskA.
    const folderB = `guest-${guestB}`;
    const expectedEntryC = `${folderB}/task-0-Find-the-Cake.jpg`;
    expect(res.body.includes(Buffer.from(expectedEntryC))).toBe(true);
  });

  it('a missing file is skipped, not fatal — response still completes with other entries present', async () => {
    const res = await fetchZip();
    expect(res.status).toBe(200);

    const folderA = `${safeName('Lilly & Axel #1!', 'guest')}-${guestA}`;
    const missingEntry = `${folderA}/task-1-Dance-Floor.jpg`;
    expect(res.body.includes(Buffer.from(missingEntry))).toBe(false);

    // The real entry from the same guest is still present alongside it.
    const presentEntry = `${folderA}/task-0-Find-the-Cake.jpg`;
    expect(res.body.includes(Buffer.from(presentEntry))).toBe(true);
  });

  it('a taken-down photo is still included ("nothing is lost")', async () => {
    const res = await fetchZip();
    const folderB = `guest-${guestB}`;
    const entryC = `${folderB}/task-0-Find-the-Cake.jpg`;
    expect(res.body.includes(Buffer.from(entryC))).toBe(true);
  });

  it('extension fallback: uppercase .PNG lowercases, no extension defaults to .jpg', async () => {
    const res = await fetchZip();
    expect(res.body.includes(Buffer.from('task-2-Ext-Task-Upper.png'))).toBe(true);
    expect(res.body.includes(Buffer.from('task-3-Ext-Task-None.jpg'))).toBe(true);
  });
});

describe('buildSummaryBuffer — workbook contents', () => {
  it('Guests sheet: Completed Tasks / Total Points match scoring for the liked guest', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const guestsSheet = wb.getWorksheet('Guests');
    let foundRow = null;
    guestsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.values[1] === guestA) foundRow = row.values;
    });

    expect(foundRow).toBeTruthy();
    // Columns: [_, id, name, completed, bonus, total, badges, social]
    expect(foundRow[3]).toBe(scoring.getCompletedCount(guestA));
    expect(foundRow[5]).toBe(scoring.getPoints(guestA));
  });

  it('Submissions sheet: (a) carries Likes=2 and Photo Bonus=4; (c) is Taken Down=YES', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const subsSheet = wb.getWorksheet('Submissions');
    const headerRow = subsSheet.getRow(1).values.slice(1);
    const takenDownCol = headerRow.indexOf('Taken Down') + 1;
    const likesCol = headerRow.indexOf('Likes') + 1;
    const bonusCol = headerRow.indexOf('Photo Bonus') + 1;

    let rowA = null;
    let rowC = null;
    subsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      // guestA has two submissions in this fixture (real + missing-file);
      // photo_bonus=4 is unique to (a), so key on that rather than guest id
      // alone to avoid picking up the missing-file row instead.
      if (row.values[1] === guestA && row.getCell(bonusCol).value === 4) rowA = row.values;
      if (row.values[1] === guestB) rowC = row.values;
    });

    expect(rowA).toBeTruthy();
    expect(rowA[likesCol]).toBe(2);
    expect(rowA[bonusCol]).toBe(4);

    expect(rowC).toBeTruthy();
    expect(rowC[takenDownCol]).toBe('YES');
  });

  it('Comments sheet: both comments present, hidden one Hidden=YES, names resolve', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const commentsSheet = wb.getWorksheet('Comments');
    const rows = [];
    commentsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push(row.values.slice(1));
    });

    const visible = rows.find((r) => r[3] === 'Congrats you two!');
    expect(visible).toBeTruthy();
    expect(visible[0]).toBe('(no name yet)'); // guestB has no name
    expect(visible[2]).toBe('Lilly & Axel #1!'); // photo owner is guestA
    expect(visible[5]).toBe('no');

    const hidden = rows.find((r) => r[3] === 'Removed later.');
    expect(hidden).toBeTruthy();
    expect(hidden[0]).toBe('Lilly & Axel #1!');
    expect(hidden[5]).toBe('YES');
  });

  it('Badges sheet: one row per badge; a null threshold renders as "" not null', async () => {
    const buf = await buildSummaryBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const badgesSheet = wb.getWorksheet('Badges');
    const rows = [];
    badgesSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      rows.push(row.values.slice(1));
    });

    // One sheet row per row in the badges table (the canonical catalog,
    // seeded by boot-heal — #314 — rather than a fixture-only count).
    const catalogCount = db.prepare('SELECT COUNT(*) AS n FROM badges').get().n;
    expect(rows.length).toBe(catalogCount);
    const bloom = rows.find((r) => r[0] === 'BLOOM');
    const choice = rows.find((r) => r[0] === 'CHOICE');
    expect(bloom[3]).toBe(5);
    expect(choice[3]).toBe(''); // NULL threshold must render as empty string, not the literal null
  });
});

describe('safeName — unit table', () => {
  it('strips disallowed characters and collapses separators', () => {
    expect(safeName('Lilly & Axel!!', 'guest')).toBe('Lilly-Axel');
  });

  it('falls back on null, and on input that collapses to nothing', () => {
    expect(safeName(null, 'guest')).toBe('guest');
    expect(safeName('...', 'guest')).toBe('guest');
  });

  it('truncates to 60 characters', () => {
    const long = 'A'.repeat(70);
    expect(safeName(long, 'guest').length).toBe(60);
  });

  it('trims leading/trailing dots (Windows path safety)', () => {
    expect(safeName('..hidden..', 'guest')).toBe('hidden');
  });
});
