// tests/guest-delete-attribution.test.js
// Issue #886 acceptance criteria 1-7 — a guest's own photo deletion must be
// distinguishable from a host takedown (submissions.taken_down_by), so a
// guest's own delete-then-reupload never lands on the host's "Re-review a
// resubmitted photo" checklist, and a host takedown stays sticky exactly as
// #190 requires.
//
// AC1 is deliberately the FIRST test below (not just first in the AC1
// section): it is the only assertion in this file that checks GET /admin for
// the ABSENCE of the resubmitted-checklist row, and host-checklist.js's own
// query is a single "most recent resubmitted row" lookup with no per-guest
// scoping — if a HOST-takedown test elsewhere in this file ran first and left
// a resubmitted=1 row behind, that unrelated row would satisfy the same
// query and this test would pass for the wrong reason (or fail for a reason
// that has nothing to do with AC1). Every other test in this file is free to
// create resubmitted=1 rows because none of them assert its absence.
//
// REQUIRE ORDER: config/db/services are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH — see tests/helpers/testApp.js. AC7's own describe block
// requires a SECOND, independent database — see that block's own header
// comment for why it evicts require.cache first, mirroring
// tests/flash-migration.test.js's bootFreshDb technique.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');
const { stripComments } = require('./helpers/source-text');

let app;
let db;
let photos;
let adminAgent;
let validJpeg;

beforeAll(async () => {
  // A tiny real JPEG so photos.makeThumb (sharp) succeeds on every submit —
  // same fixture shape as tests/moderation-sticky.test.js and
  // tests/lucky-task.test.js.
  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 60, g: 30, b: 90 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  photos = require('../src/services/photos');

  adminAgent = await makeAdminAgent(app, 'guest-delete-attribution-admin-pw');
});

let seq = 0;

function insertGuest() {
  seq += 1;
  const token = `gda-guest-${seq}-${crypto.randomUUID()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, `GDA Guest ${seq}`).lastInsertRowid;
  return { guestId, token };
}

/** A guest row plus a supertest agent already signed in as that guest. */
function signedInGuest() {
  const { guestId, token } = insertGuest();
  const agent = signInGuest(app, token);
  return { guestId, agent };
}

function insertTask(title) {
  seq += 1;
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title || `GDA Task ${seq}`)
    .lastInsertRowid;
}

function getSubmission(guestId, taskId) {
  return db
    .prepare(`SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?`)
    .get(guestId, taskId);
}

/** POST a photo submit for taskId as the given guest agent; returns the redirect response. */
async function postPhoto(agent, taskId, filename) {
  return agent
    .post('/tasks/' + taskId + '/submit')
    .attach('photo', validJpeg, { filename, contentType: 'image/jpeg' });
}

// ---------------------------------------------------------------------------
// AC1: a guest's own deletion never reaches the host queue.
// ---------------------------------------------------------------------------
it("AC1: a guest's own delete-then-reupload never lands on the host's resubmitted checklist", async () => {
  const guest = signedInGuest();
  const taskId = insertTask('AC1 Task');

  const firstRes = await postPhoto(guest.agent, taskId, 'ac1-first.jpg');
  expect([302, 303]).toContain(firstRes.status);
  const firstRow = getSubmission(guest.guestId, taskId);
  expect(firstRow.taken_down).toBe(0);

  // The guest's OWN delete.
  const deleteRes = await guest.agent.post('/p/' + firstRow.id + '/delete');
  expect([302, 303]).toContain(deleteRes.status);
  const afterDelete = getSubmission(guest.guestId, taskId);
  expect(afterDelete.taken_down).toBe(1);
  expect(afterDelete.taken_down_by).toBe('guest');

  // The guest uploads a new photo for the SAME task.
  const secondRes = await postPhoto(guest.agent, taskId, 'ac1-second.jpg');
  expect([302, 303]).toContain(secondRes.status);

  const afterReupload = getSubmission(guest.guestId, taskId);
  expect(afterReupload.id).toBe(firstRow.id);
  expect(afterReupload.taken_down).toBe(0);
  expect(afterReupload.resubmitted).toBe(0);
  expect(afterReupload.taken_down_by).toBeNull();

  const feedRes = await guest.agent.get('/feed');
  expect(feedRes.status).toBe(200);
  expect(feedRes.text).toContain(afterReupload.thumb_path);

  const galleryRes = await guest.agent.get('/gallery');
  expect(galleryRes.status).toBe(200);
  expect(galleryRes.text).toContain(afterReupload.thumb_path);

  const adminPage = await adminAgent.get('/admin');
  expect(adminPage.status).toBe(200);
  expect(adminPage.text).not.toContain('Re-review a resubmitted photo');
});

// ---------------------------------------------------------------------------
// PR re-check fix: the restoreSubmission swallow path. A guest's replace
// that lands on their own hidden row un-hides through the GUARDED
// photos.restoreSubmission call inside src/services/submissions.js — if that
// throws, the failure is logged and swallowed rather than losing the
// guest's just-saved photo. Before this fix, guestCleanSlateReplace was
// assigned BEFORE that try/catch, so a swallowed failure still reported
// guestCleanSlateReplace: true and src/routes/guest.js fired the one-shot
// "Task complete!" success card for a row that, at that exact moment, was
// still taken_down = 1 and absent from the feed/gallery. This test forces
// restoreSubmission to throw and asserts the new photo survives (on disk
// and in the row) while NO success-card reward is issued for it.
// ---------------------------------------------------------------------------
it('a swallowed restoreSubmission failure keeps the new photo but issues no success-card reward', async () => {
  const guest = signedInGuest();
  const taskId = insertTask('Swallow-Path Task');

  await postPhoto(guest.agent, taskId, 'swallow-first.jpg');
  const firstRow = getSubmission(guest.guestId, taskId);

  // The guest's OWN delete — the row the replace below will land on.
  await guest.agent.post('/p/' + firstRow.id + '/delete');
  const afterDelete = getSubmission(guest.guestId, taskId);
  expect(afterDelete.taken_down_by).toBe('guest');

  // Force the guarded un-hide to throw. submissions.js calls
  // photos.restoreSubmission(existing.id) through the SAME `photos` module
  // object this test file already required in beforeAll, so spying on that
  // export intercepts the call submitPhoto makes.
  const restoreSpy = vi.spyOn(photos, 'restoreSubmission').mockImplementation(() => {
    throw new Error('forced restoreSubmission failure (swallow-path test)');
  });
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    const secondRes = await postPhoto(guest.agent, taskId, 'swallow-second.jpg');
    expect([302, 303]).toContain(secondRes.status);

    // The replace itself still landed: same row id, new photo/thumb on disk
    // and in the DB — a badge-recount-adjacent failure must never cost the
    // guest the submission they just made.
    const afterSwallow = getSubmission(guest.guestId, taskId);
    expect(afterSwallow.id).toBe(firstRow.id);
    expect(afterSwallow.photo_path).not.toBe(afterDelete.photo_path);
    expect(fs.existsSync(photos.absOriginalPath(afterSwallow.photo_path))).toBe(true);
    expect(fs.existsSync(photos.absThumbPath(afterSwallow.thumb_path))).toBe(true);

    // The un-hide did NOT happen (restoreSubmission threw before it could
    // clear the flag) — the row is still, in fact, hidden.
    expect(afterSwallow.taken_down).toBe(1);
    expect(afterSwallow.taken_down_by).toBe('guest');

    // No success-card reward: the redirected task page shows the plain
    // "Photo replaced!" flash, not "Task complete!" — mirrors
    // tests/rewards.test.js's own AC4 assertion shape for an ordinary
    // (non-clean-slate) replace.
    const page = await guest.agent.get(secondRes.headers.location);
    expect(page.text).not.toContain('Task complete!');
    expect(page.text).toContain('Photo replaced!');
  } finally {
    restoreSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// AC2: a host takedown stays sticky (#190 unchanged).
// ---------------------------------------------------------------------------
it('AC2: a host takedown stays sticky across a guest resubmit', async () => {
  const guest = signedInGuest();
  const taskId = insertTask('AC2 Task');

  await postPhoto(guest.agent, taskId, 'ac2-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  const takedownRes = await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  expect(takedownRes.status).toBe(303);
  const afterTakedown = getSubmission(guest.guestId, taskId);
  expect(afterTakedown.taken_down).toBe(1);
  expect(afterTakedown.taken_down_by).toBe('admin');

  const replaceRes = await postPhoto(guest.agent, taskId, 'ac2-second.jpg');
  expect([302, 303]).toContain(replaceRes.status);

  const afterReplace = getSubmission(guest.guestId, taskId);
  expect(afterReplace.taken_down).toBe(1);
  expect(afterReplace.resubmitted).toBe(1);

  const feedRes = await guest.agent.get('/feed');
  expect(feedRes.text).not.toContain(afterReplace.thumb_path);

  const galleryRes = await guest.agent.get('/gallery');
  expect(galleryRes.text).not.toContain(afterReplace.thumb_path);
});

// ---------------------------------------------------------------------------
// AC3: an unattributed takedown is sticky too (a legacy/raw-inserted row
// with taken_down = 1 and taken_down_by IS NULL is read exactly like
// 'admin', per the Attribution convention).
// ---------------------------------------------------------------------------
it('AC3: an unattributed (taken_down_by IS NULL) takedown stays sticky across a guest resubmit', async () => {
  const guest = signedInGuest();
  const taskId = insertTask('AC3 Task');

  await postPhoto(guest.agent, taskId, 'ac3-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  // Raw-set taken_down = 1, leaving taken_down_by NULL — mirrors
  // tests/rewards.test.js:314's pre-existing raw UPDATE, the exact shape a
  // legacy row (or any write path this issue does not touch) can leave
  // behind.
  db.prepare(`UPDATE submissions SET taken_down = 1 WHERE id = ?`).run(row.id);
  expect(getSubmission(guest.guestId, taskId).taken_down_by).toBeNull();

  const replaceRes = await postPhoto(guest.agent, taskId, 'ac3-second.jpg');
  expect([302, 303]).toContain(replaceRes.status);

  const afterReplace = getSubmission(guest.guestId, taskId);
  expect(afterReplace.taken_down).toBe(1);
  expect(afterReplace.resubmitted).toBe(1);

  const taskPage = await guest.agent.get('/tasks/' + taskId);
  expect(taskPage.status).toBe(200);
  expect(taskPage.text).toContain('with the hosts');
});

// ---------------------------------------------------------------------------
// AC4: a guest cannot launder a host takedown into their own.
// ---------------------------------------------------------------------------
it("AC4: a guest's own delete on an already host-taken-down photo leaves the attribution at 'admin'", async () => {
  const guest = signedInGuest();
  const taskId = insertTask('AC4 Task');

  await postPhoto(guest.agent, taskId, 'ac4-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  await adminAgent.post('/admin/photos/' + row.id + '/takedown');
  expect(getSubmission(guest.guestId, taskId).taken_down_by).toBe('admin');

  // The owning guest tries to "delete" a photo the host already hid.
  const deleteRes = await guest.agent.post('/p/' + row.id + '/delete');
  expect([302, 303]).toContain(deleteRes.status);

  const afterGuestDelete = getSubmission(guest.guestId, taskId);
  expect(afterGuestDelete.taken_down).toBe(1);
  expect(afterGuestDelete.taken_down_by).toBe('admin');

  // A subsequent re-upload still behaves per AC2: stays hidden, resubmitted.
  const replaceRes = await postPhoto(guest.agent, taskId, 'ac4-second.jpg');
  expect([302, 303]).toContain(replaceRes.status);
  const afterReplace = getSubmission(guest.guestId, taskId);
  expect(afterReplace.taken_down).toBe(1);
  expect(afterReplace.resubmitted).toBe(1);
});

// ---------------------------------------------------------------------------
// AC5: the approved screen.
// ---------------------------------------------------------------------------
describe('AC5: the approved guest-facing screen', () => {
  it('a guest who deleted their own photo sees the never-submitted shape, not the "with the hosts" state', async () => {
    const guest = signedInGuest();
    const taskId = insertTask('AC5 Guest-Delete Task');

    await postPhoto(guest.agent, taskId, 'ac5-first.jpg');
    const row = getSubmission(guest.guestId, taskId);
    await guest.agent.post('/p/' + row.id + '/delete');

    const taskPage = await guest.agent.get('/tasks/' + taskId);
    expect(taskPage.status).toBe(200);
    // Issue #611 removed the "Upload a photo to complete this task" heading
    // this test originally anchored to; re-anchored to the never-submitted
    // branch's own two markers — its submit button reads "Upload & complete"
    // (the replace branch's reads "Upload & replace" instead), and its
    // <details class="replace-disclosure"> wrapper is absent entirely (that
    // element only renders when task.ejs takes the has-a-submission branch).
    expect(taskPage.text).toContain('Upload &amp; complete');
    expect(taskPage.text).not.toContain('replace-disclosure');
    expect(taskPage.text).not.toContain('with the hosts');
    expect(taskPage.text.toLowerCase()).not.toContain('restore');
  });

  it('a guest whose photo a HOST took down still sees the "with the hosts" state', async () => {
    const guest = signedInGuest();
    const taskId = insertTask('AC5 Host-Takedown Task');

    await postPhoto(guest.agent, taskId, 'ac5-host-first.jpg');
    const row = getSubmission(guest.guestId, taskId);
    await adminAgent.post('/admin/photos/' + row.id + '/takedown');

    const taskPage = await guest.agent.get('/tasks/' + taskId);
    expect(taskPage.status).toBe(200);
    expect(taskPage.text).toContain('with the hosts');
  });
});

// ---------------------------------------------------------------------------
// PR review fix H: hideSubmission's validation contract (the `by` argument)
// was exercised only indirectly through the HTTP routes above (community.js
// always passes 'guest', admin.js always passes 'admin') — neither the
// explicit-invalid-value throw nor the omitted-argument default had a direct
// test of its own.
// ---------------------------------------------------------------------------
describe("hideSubmission's validation contract", () => {
  it("throws a TypeError for an explicitly invalid 'by' value and leaves the row unchanged", () => {
    const guest = insertGuest();
    const taskId = insertTask('Validation Task');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'validation.jpg', 'validation-thumb.jpg', 0)`
      )
      .run(guest.guestId, taskId).lastInsertRowid;

    expect(() => photos.hideSubmission(submissionId, 'host')).toThrow(TypeError);

    const row = getSubmission(guest.guestId, taskId);
    expect(row.taken_down).toBe(0);
    expect(row.taken_down_by).toBeNull();
  });

  it("an omitted 'by' argument still defaults to 'admin' (the pre-#886 compatibility contract)", () => {
    const guest = insertGuest();
    const taskId = insertTask('Default Actor Task');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'default-actor.jpg', 'default-actor-thumb.jpg', 0)`
      )
      .run(guest.guestId, taskId).lastInsertRowid;

    photos.hideSubmission(submissionId);

    const row = getSubmission(guest.guestId, taskId);
    expect(row.taken_down).toBe(1);
    expect(row.taken_down_by).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// AC6: the couple's record is kept.
// ---------------------------------------------------------------------------
it("AC6: a guest's own deletion keeps the row and both files, and stays Restore-able from /admin/photos", async () => {
  const guest = signedInGuest();
  const taskId = insertTask('AC6 Task');

  await postPhoto(guest.agent, taskId, 'ac6-first.jpg');
  const row = getSubmission(guest.guestId, taskId);

  const originalAbs = photos.absOriginalPath(row.photo_path);
  const thumbAbs = photos.absThumbPath(row.thumb_path);
  expect(fs.existsSync(originalAbs)).toBe(true);
  expect(fs.existsSync(thumbAbs)).toBe(true);

  await guest.agent.post('/p/' + row.id + '/delete');

  const afterDelete = getSubmission(guest.guestId, taskId);
  expect(afterDelete).toBeDefined();
  expect(afterDelete.taken_down).toBe(1);
  expect(afterDelete.taken_down_by).toBe('guest');
  // Files untouched — hideSubmission never touches disk (only the flag).
  expect(fs.existsSync(originalAbs)).toBe(true);
  expect(fs.existsSync(thumbAbs)).toBe(true);

  const adminPhotosPage = await adminAgent.get('/admin/photos');
  expect(adminPhotosPage.status).toBe(200);

  const imgAt = adminPhotosPage.text.indexOf('src="/thumbs/' + afterDelete.thumb_path + '"');
  expect(imgAt).toBeGreaterThan(-1);
  const start = adminPhotosPage.text.lastIndexOf('<figure', imgAt);
  const end = adminPhotosPage.text.indexOf('</figure>', imgAt);
  const chunk = adminPhotosPage.text.slice(start, end);
  expect(chunk).toContain('admin-tile is-down');

  const feedMarker = 'id="feed-photo-' + afterDelete.id + '"';
  const feedAt = adminPhotosPage.text.indexOf(feedMarker);
  expect(feedAt).toBeGreaterThan(-1);
  const feedEnd = adminPhotosPage.text.indexOf('</article>', feedAt);
  const feedChunk = adminPhotosPage.text.slice(feedAt, feedEnd);
  expect(feedChunk).toContain('action="/admin/photos/' + afterDelete.id + '/restore"');

  // Restore actually works (the couple's record can still be surfaced by a
  // host, even though the guest chose to remove it from their own view).
  const restoreRes = await adminAgent.post('/admin/photos/' + afterDelete.id + '/restore');
  expect(restoreRes.status).toBe(303);
  const restored = getSubmission(guest.guestId, taskId);
  expect(restored.taken_down).toBe(0);
  expect(restored.taken_down_by).toBeNull();
});

// ---------------------------------------------------------------------------
// AC7: existing databases migrate correctly.
//
// This describe block requires a SECOND, independent database via a fresh
// `require('../src/db')`, exactly like tests/flash-migration.test.js's
// bootFreshDb helper (its own header comment explains why): the tests above
// already called loadApp(), which cached src/db.js (and config.js) pointed
// at THEIR temp database. A second plain `require('../src/db')` would return
// that SAME cached module rather than re-running the module-load migrations
// against a new database, so this block evicts both modules from
// require.cache before requiring again — proven safe by flash-migration.
// test.js's own two-boots-in-one-process verification (see that file's
// header comment). Declared LAST in this file so its cache eviction and
// process.env mutation can never run ahead of (and poison) the loadApp()-
// based tests above.
// ---------------------------------------------------------------------------
describe('AC7: an existing (pre-#886) database migrates taken_down_by correctly on boot', () => {
  let dbModule;
  let migratedDb;
  let hiddenRowId;
  let visibleRowId;
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-taken-down-by-migration-test-'));
    const dbPath = path.join(dir, 'test.db');

    // Lay down the real pre-#886 shape: guests (needed for submissions' own
    // FK) plus submissions carrying every column this codebase has added up
    // through #190/#753/#684, but NOT taken_down_by. task_id is left NULL on
    // both seeded rows (memory-shaped) so no `tasks` table is needed here —
    // db.js's own `CREATE TABLE IF NOT EXISTS tasks` creates it fresh, with
    // no rows, the moment it is required below, same as
    // tests/bug-report-status-migration.test.js's own pattern.
    const seedDb = new Database(dbPath);
    seedDb.exec(`
      CREATE TABLE guests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT    NOT NULL UNIQUE,
        name          TEXT    NOT NULL DEFAULT '',
        avatar_path   TEXT,
        social_links  TEXT    NOT NULL DEFAULT '{}',
        bonus_points  INTEGER NOT NULL DEFAULT 0,
        onboarded     INTEGER NOT NULL DEFAULT 0,
        contact       TEXT,
        contact_type  TEXT,
        pin           TEXT,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE submissions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        guest_id     INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
        task_id      INTEGER,
        photo_path   TEXT    NOT NULL,
        thumb_path   TEXT    NOT NULL,
        caption      TEXT    NOT NULL DEFAULT '',
        taken_down   INTEGER NOT NULL DEFAULT 0,
        photo_bonus  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        resubmitted  INTEGER NOT NULL DEFAULT 0,
        bonus_amount INTEGER NOT NULL DEFAULT 0,
        bonus_reason TEXT,
        CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
      );
    `);

    const guestId = seedDb
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('taken-down-by-migration-guest', 'Migration Guest').lastInsertRowid;

    hiddenRowId = seedDb
      .prepare(
        `INSERT INTO submissions (guest_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, 1)`
      )
      .run(guestId, 'pre886-hidden.jpg', 'pre886-hidden-thumb.jpg').lastInsertRowid;

    visibleRowId = seedDb
      .prepare(
        `INSERT INTO submissions (guest_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, 0)`
      )
      .run(guestId, 'pre886-visible.jpg', 'pre886-visible-thumb.jpg').lastInsertRowid;

    seedDb.close();

    delete require.cache[require.resolve('../config')];
    delete require.cache[require.resolve('../src/db')];
    process.env.DATA_DIR = dir;
    process.env.DB_PATH = dbPath;

    // Requiring src/db.js NOW runs its real module-load migrations —
    // including the real, exported ensureTakenDownByColumn — against the
    // old-shape table above.
    dbModule = require('../src/db');
    migratedDb = dbModule.db;
  });

  afterAll(() => {
    dbModule.db.close();
    delete process.env.DATA_DIR;
    delete process.env.DB_PATH;
  });

  it('submissions.taken_down_by now exists', () => {
    const cols = migratedDb
      .prepare('PRAGMA table_info(submissions)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('taken_down_by');
  });

  it('a pre-existing taken_down = 1 row backfills to taken_down_by = admin', () => {
    const row = migratedDb.prepare('SELECT * FROM submissions WHERE id = ?').get(hiddenRowId);
    expect(row.taken_down).toBe(1);
    expect(row.taken_down_by).toBe('admin');
  });

  it('a pre-existing taken_down = 0 row is left with taken_down_by IS NULL', () => {
    const row = migratedDb.prepare('SELECT * FROM submissions WHERE id = ?').get(visibleRowId);
    expect(row.taken_down).toBe(0);
    expect(row.taken_down_by).toBeNull();
  });

  it("the CHECK constraint accepts 'admin', 'guest', and NULL, and rejects anything else", () => {
    expect(() =>
      migratedDb
        .prepare(`UPDATE submissions SET taken_down_by = 'admin' WHERE id = ?`)
        .run(visibleRowId)
    ).not.toThrow();
    expect(() =>
      migratedDb
        .prepare(`UPDATE submissions SET taken_down_by = 'guest' WHERE id = ?`)
        .run(visibleRowId)
    ).not.toThrow();
    expect(() =>
      migratedDb
        .prepare(`UPDATE submissions SET taken_down_by = NULL WHERE id = ?`)
        .run(visibleRowId)
    ).not.toThrow();
    expect(() =>
      migratedDb
        .prepare(`UPDATE submissions SET taken_down_by = 'host' WHERE id = ?`)
        .run(visibleRowId)
    ).toThrow(/CHECK/i);
  });

  // Drift guard (PR re-check fix): the set of legal taken_down_by values is
  // declared independently in two places — this CHECK constraint (src/db.js's
  // ensureTakenDownByColumn) and photos.js's VALID_TAKEN_DOWN_BY
  // (hideSubmission's own runtime validation) — with nothing pinning them
  // together. Parses both source files' literal text rather than importing
  // one module's internal constant into the other, the same idiom
  // tests/classify-dep-pr.test.js's own "wedding-critical drift guard"
  // describe block already uses for its two independently-declared lists.
  it('the CHECK constraint and photos.js VALID_TAKEN_DOWN_BY agree on the legal attribution values', () => {
    // Comment-stripped (issue #939) -- .match takes the FIRST match, so a
    // comment quoting either pattern would silently shadow the real
    // declaration and this drift guard would stop guarding anything. The
    // constraint/set literal themselves live in template-literal/array
    // syntax, which stripComments preserves untouched.
    const dbSrc = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')
    );
    const checkMatch = dbSrc.match(
      /CHECK \(taken_down_by IS NULL OR taken_down_by IN \(([^)]+)\)\)/
    );
    if (!checkMatch) {
      throw new Error('Could not locate the taken_down_by CHECK constraint in src/db.js');
    }
    const checkValues = [...checkMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    const photosSrc = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'photos.js'), 'utf8')
    );
    const validSetMatch = photosSrc.match(/VALID_TAKEN_DOWN_BY\s*=\s*new Set\(\[([^\]]+)\]\)/);
    if (!validSetMatch) {
      throw new Error('Could not locate VALID_TAKEN_DOWN_BY in src/services/photos.js');
    }
    const validSetValues = [...validSetMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    expect(checkValues).toEqual(['admin', 'guest']);
    expect(validSetValues).toEqual(['admin', 'guest']);
    expect(checkValues).toEqual(validSetValues);
  });

  it('a second run of the real guard against the already-migrated DB does not throw and does not duplicate the column', () => {
    expect(() => migratedDb.exec('ALTER TABLE submissions ADD COLUMN taken_down_by TEXT')).toThrow(
      /duplicate column/i
    );

    expect(() => dbModule.ensureTakenDownByColumn()).not.toThrow();

    const cols = migratedDb.prepare('PRAGMA table_info(submissions)').all();
    expect(cols.filter((c) => c.name === 'taken_down_by')).toHaveLength(1);

    // Idempotent end-to-end too: the backfilled row has been untouched since
    // the migration's own backfill (the CHECK test above only ever writes
    // visibleRowId), so this confirms the repeat run neither re-derives from
    // taken_down nor clears the attribution on a later boot.
    expect(
      migratedDb.prepare('SELECT taken_down_by FROM submissions WHERE id = ?').get(hiddenRowId)
        .taken_down_by
    ).toBe('admin');
  });
});
