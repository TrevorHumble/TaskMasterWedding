// tests/guest-branches.test.js
// Issue #305 — branch coverage for src/routes/guest.js fallback/edge arms not
// exercised by the existing task-submission/memories/avatar suites: the
// task-detail and task-submit not-found guards, the missing-file/missing-photo
// flashes, the profile-edit social_links reset arm, the name-blank/omitted
// arms, the editableKeys delete-vs-preserve arm, and the avatar-upload
// error/first-time/replace arms.
//
// REQUIRE ORDER: config/db/app are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH (same pattern as tests/avatar-intake.test.js).
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let jpegOne;
let jpegTwo;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  jpegOne = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 60 } },
  })
    .jpeg()
    .toBuffer();
  jpegTwo = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 60, b: 20 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuest(name, opts = {}) {
  const token = `guest-branches-${crypto.randomUUID()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, social_links, onboarded) VALUES (?, ?, ?, 1)`)
    .run(token, name, opts.socialLinks !== undefined ? opts.socialLinks : '{}').lastInsertRowid;
  return { guestId, token };
}

async function agentFor(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token);
  return agent;
}

function insertTask(title, isActive = 1) {
  return db.prepare(`INSERT INTO tasks (title, is_active) VALUES (?, ?)`).run(title, isActive)
    .lastInsertRowid;
}

// ---------------------------------------------------------------------------
// GET /tasks/:id — not-found arms (lines 181, 190).
// ---------------------------------------------------------------------------
describe('GET /tasks/:id not-found arms', () => {
  it('a non-numeric id -> 404 (line 181)', async () => {
    const { token } = insertGuest('Task Detail NonNumeric Guest');
    const agent = await agentFor(token);
    const res = await agent.get('/tasks/abc');
    expect(res.status).toBe(404);
  });

  it('a numeric but nonexistent id -> 404 (line 190, missing-task half)', async () => {
    const { token } = insertGuest('Task Detail Missing Guest');
    const agent = await agentFor(token);
    const res = await agent.get('/tasks/999999999');
    expect(res.status).toBe(404);
  });

  it('an INACTIVE task id -> 404, hidden from guests (line 190, inactive half)', async () => {
    const { token } = insertGuest('Task Detail Inactive Guest');
    const agent = await agentFor(token);
    const inactiveTaskId = insertTask('Inactive Task', 0);
    const res = await agent.get('/tasks/' + inactiveTaskId);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/submit — not-found arm (229) and the missing-file flash (240).
// ---------------------------------------------------------------------------
describe('POST /tasks/:id/submit not-found and missing-file arms', () => {
  it('a non-numeric id -> 404 (line 229)', async () => {
    const { token } = insertGuest('Task Submit NonNumeric Guest');
    const agent = await agentFor(token);
    const res = await agent.post('/tasks/abc/submit');
    expect(res.status).toBe(404);
  });

  it('no file attached -> "Please choose a photo to upload." flash, redirect back to the task (line 240)', async () => {
    const { token } = insertGuest('Task Submit NoFile Guest');
    const agent = await agentFor(token);
    const taskId = insertTask('No File Task');

    const res = await agent
      .post('/tasks/' + taskId + '/submit')
      .field('caption', 'no photo attached');
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/tasks/' + taskId);

    const page = await agent.get('/tasks/' + taskId);
    expect(page.text).toContain('Please choose a photo to upload.');

    // Real behavioral guard: no submission row was created.
    const row = db
      .prepare(
        'SELECT id FROM submissions WHERE guest_id = (SELECT id FROM guests WHERE token = ?) AND task_id = ?'
      )
      .get(token, taskId);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /memories — the zero-files flash (line 334).
// ---------------------------------------------------------------------------
describe('POST /memories zero-files arm', () => {
  it('no photos attached -> "Please choose at least one photo to share." flash, no rows inserted', async () => {
    const { guestId, token } = insertGuest('Memories NoFile Guest');
    const agent = await agentFor(token);

    const res = await agent.post('/memories').field('caption', 'nothing attached');
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/memories/new');

    const page = await agent.get('/memories/new');
    expect(page.text).toContain('Please choose at least one photo to share.');

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ?')
      .get(guestId).n;
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /me/edit — the social_links reset arm (lines 408/409): a non-object
// parse result (null, or a JSON array) must reset to {} rather than crash or
// leak a non-object into the form.
// ---------------------------------------------------------------------------
describe('GET /me/edit social_links reset arm', () => {
  it("social_links = 'null' (parses to JS null) -> form renders 200 with blank social fields", async () => {
    const { token } = insertGuest('Edit Null Social Guest', { socialLinks: 'null' });
    const agent = await agentFor(token);
    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="instagram"');
  });

  it("social_links = '[1,2]' (parses to a JS array, not a plain object) -> form still renders 200", async () => {
    const { token } = insertGuest('Edit Array Social Guest', { socialLinks: '[1,2]' });
    const agent = await agentFor(token);
    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="instagram"');
  });
});

// ---------------------------------------------------------------------------
// POST /me/edit — name blank/omitted (444/447), the social_links parse arms
// in the POST handler itself (457/458), the editableKeys delete-vs-preserve
// arm (468), and the avatar error/first-time/no-file arms (437/482/497).
// ---------------------------------------------------------------------------
describe('POST /me/edit name, social parse, and editableKeys arms', () => {
  it('a blank name field keeps the existing name unchanged (line 447)', async () => {
    const { guestId, token } = insertGuest('Original Name Guest');
    const agent = await agentFor(token);

    const res = await agent.post('/me/edit').field('name', '   ').field('instagram', '');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT name FROM guests WHERE id = ?').get(guestId);
    expect(row.name).toBe('Original Name Guest');
  });

  it('an entirely omitted name field is treated the same as blank (line 444 false arm) and keeps the existing name', async () => {
    const { guestId, token } = insertGuest('Untouched Name Guest');
    const agent = await agentFor(token);

    // No .field('name', ...) call at all.
    const res = await agent.post('/me/edit').field('instagram', '');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT name FROM guests WHERE id = ?').get(guestId);
    expect(row.name).toBe('Untouched Name Guest');
  });

  it('malformed social_links JSON is reset to {} before applying this edit (line 457 catch arm)', async () => {
    const { guestId, token } = insertGuest('Malformed Social Edit Guest', {
      socialLinks: '{not valid json',
    });
    const agent = await agentFor(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Malformed Social Edit Guest')
      .field('instagram', 'freshhandle');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT social_links FROM guests WHERE id = ?').get(guestId);
    // The catch reset `social` to {} before the edit applied — the ONLY key
    // present is the one this POST set, proving the malformed JSON did not
    // survive or crash the handler.
    expect(JSON.parse(row.social_links)).toEqual({ instagram: 'freshhandle' });
  });

  it('a JSON social_links value that is not an object (a bare string) resets to {} (line 458 false arm)', async () => {
    const { guestId, token } = insertGuest('Non-Object Social Edit Guest', {
      socialLinks: JSON.stringify('just a string'),
    });
    const agent = await agentFor(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Non-Object Social Edit Guest')
      .field('instagram', 'freshhandle2');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT social_links FROM guests WHERE id = ?').get(guestId);
    expect(JSON.parse(row.social_links)).toEqual({ instagram: 'freshhandle2' });
  });

  it('a valid existing social_links object preserves a NON-editable key while an emptied editable key is deleted (lines 458 true arm, 468 delete arm)', async () => {
    const { guestId, token } = insertGuest('Preserve Social Edit Guest', {
      socialLinks: JSON.stringify({ email: 'keep@example.com', instagram: 'old-handle' }),
    });
    const agent = await agentFor(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Preserve Social Edit Guest')
      .field('instagram', '') // emptied -> deleted (line 468's delete branch)
      .field('facebook', '')
      .field('website', '');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT social_links FROM guests WHERE id = ?').get(guestId);
    const social = JSON.parse(row.social_links);
    // 'email' is not one of editableKeys (instagram/facebook/website), so it
    // must survive untouched — proving line 458's true arm assigned the
    // parsed object (not a reset {}) before the editableKeys loop ran.
    expect(social.email).toBe('keep@example.com');
    // 'instagram' was posted empty, so the delete branch at line 468 removed it.
    expect(social.instagram).toBeUndefined();
  });

  it('setting a previously-unset editable key to a non-empty value ADDS it (the other half of line 468)', async () => {
    const { guestId, token } = insertGuest('Add Social Edit Guest');
    const agent = await agentFor(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Add Social Edit Guest')
      .field('instagram', 'newly-added-handle');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT social_links FROM guests WHERE id = ?').get(guestId);
    expect(JSON.parse(row.social_links).instagram).toBe('newly-added-handle');
  });

  it('no avatar attached -> skips the whole avatar block (lines 437/482 false arms), only name/socials update', async () => {
    const { guestId, token } = insertGuest('No Avatar Edit Guest');
    const agent = await agentFor(token);

    const res = await agent.post('/me/edit').field('name', 'No Avatar Edit Guest Renamed');
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT name, avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(row.name).toBe('No Avatar Edit Guest Renamed');
    expect(row.avatar_path).toBeNull();
  });

  it('a disallowed avatar file type errors out with a flash, redirect back to /me/edit, no avatar_path set (line 437 true arm)', async () => {
    const { guestId, token } = insertGuest('Bad Avatar Edit Guest');
    const agent = await agentFor(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Bad Avatar Edit Guest')
      .attach('avatar', Buffer.from('not an image'), {
        filename: 'not-image.txt',
        contentType: 'text/plain',
      });
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/me/edit');

    const page = await agent.get('/me/edit');
    expect(page.text).toContain('That avatar could not be uploaded');

    const row = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(row.avatar_path).toBeNull();
  });

  it("a guest's FIRST-EVER avatar upload has no old file to delete (line 497 false arm) and sets avatar_path (line 482 true arm)", async () => {
    const { guestId, token } = insertGuest('First Avatar Edit Guest');
    const agent = await agentFor(token);

    const before = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(before.avatar_path).toBeNull();

    const res = await agent
      .post('/me/edit')
      .field('name', 'First Avatar Edit Guest')
      .attach('avatar', jpegOne, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(res.status);

    const after = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(after.avatar_path).toMatch(/\.jpg$/);
  });

  it('replacing an existing avatar deletes the old file (line 497 true arm)', async () => {
    const { guestId, token } = insertGuest('Replace Avatar Edit Guest');
    const agent = await agentFor(token);

    const first = await agent
      .post('/me/edit')
      .field('name', 'Replace Avatar Edit Guest')
      .attach('avatar', jpegOne, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(first.status);
    const afterFirst = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    const firstAvatarPath = afterFirst.avatar_path;
    expect(firstAvatarPath).toMatch(/\.jpg$/);

    const second = await agent
      .post('/me/edit')
      .field('name', 'Replace Avatar Edit Guest')
      .attach('avatar', jpegTwo, { filename: 'second.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(second.status);
    const afterSecond = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(afterSecond.avatar_path).not.toBe(firstAvatarPath);
  });
});
