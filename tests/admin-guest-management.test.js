// tests/admin-guest-management.test.js
// Issue #181: admin guest-management routes need tests that assert real
// response/DB outcomes, not just that a handler ran. Covers edit, delete
// (missing-file resilience), and bonus points (add/subtract/reject).
//
// Issue #244 AC3 retired admin-side guest CREATION (POST /admin/guests and
// POST /admin/guests/bulk) — guests now join themselves at /join, so those
// two routes must 404 and write no row; see the first describe block below.
// The create/bulk-create coverage this file used to carry is gone with them.
//
// Issue #1093 widened POST /admin/guests/:id/edit into the popup's single
// Save (name/contact/pin/is_couple/blocked in one request) and dropped
// `pinned` from its UPDATE statement entirely: the approved popup has no
// pinned control, and carrying the old absent-key-is-false rule forward
// would have silently unpinned every guest on every Save. The old
// "pin/unpin round-trips" test below asserted exactly the behavior #1093
// deliberately removed, so it is rewritten rather than kept: the new
// contract is that Save never touches `pinned` at all.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let scoring;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
  // Required only now: scoring.js requires ../db, which reads config.DATA_DIR
  // at module-load time. Requiring it before loadApp() sets DATA_DIR would
  // bind it to the real project data/app.db instead of this test's temp DB.
  scoring = require('../src/services/scoring');
});

// ---------------------------------------------------------------------------
// Retired guest-creation routes (issue #244 AC3)
// ---------------------------------------------------------------------------
describe('POST /admin/guests and POST /admin/guests/bulk are retired', () => {
  it('POST /admin/guests 404s and creates no row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const res = await adminAgent.post('/admin/guests').type('form').send({ name: 'Aunt Carol' });

    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(before);
  });

  it('POST /admin/guests/bulk 404s and creates no row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const res = await adminAgent.post('/admin/guests/bulk').type('form').send({ count: '3' });

    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Edit (rename + pin/unpin)
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/edit', () => {
  it('unknown id redirects with "Guest not found." and creates no row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    const res = await adminAgent
      .post('/admin/guests/99999/edit')
      .type('form')
      .send({ name: 'Nobody' });

    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(before);
  });

  it('a Save never touches pinned: a guest stored pinned=1 still reads pinned=1 afterwards (#1093)', async () => {
    const guestId = db
      .prepare('INSERT INTO guests (token, name, pinned) VALUES (?, ?, 1)')
      .run('pintoken0000000000000000000000', 'Lilly').lastInsertRowid;

    // The popup posts no `pinned` field at all: it has no such control. The
    // old route read that absence as "unpin"; the new one does not read
    // `pinned` at all, so the stored value must survive untouched.
    await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send({ name: 'Lilly Renamed' });

    const row = db.prepare('SELECT name, pinned FROM guests WHERE id = ?').get(guestId);
    expect(row.name).toBe('Lilly Renamed');
    expect(row.pinned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #1093: the popup's single Save. name/contact/pin/is_couple/blocked
// all persisted by one request, validation only on non-empty pin/contact,
// and an empty box always writes NULL rather than being skipped.
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/edit: the consolidated popup Save (#1093)', () => {
  // Criterion 3: all five fields persisted by one request.
  it('criterion 3: one request persists name/contact/pin/is_couple/blocked together', async () => {
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin, is_couple, blocked)
         VALUES (?, 'Old', 'old@example.com', 'email', '1111', 0, 0)`
      )
      .run('c3token00000000000000000000000a').lastInsertRowid;

    const res = await adminAgent.post(`/admin/guests/${guestId}/edit`).type('form').send({
      name: 'New',
      contact: 'new@example.com',
      pin: '2222',
      is_couple: '1',
      blocked: '1',
    });

    expect(res.headers.location).toContain('/admin/guests');
    expect(res.headers.location).toContain(encodeURIComponent('Guest updated.'));
    const row = db
      .prepare('SELECT name, contact, pin, is_couple, blocked FROM guests WHERE id = ?')
      .get(guestId);
    expect(row).toEqual({
      name: 'New',
      contact: 'new@example.com',
      pin: '2222',
      is_couple: 1,
      blocked: 1,
    });
  });

  // Criterion 4: an invalid non-empty PIN writes nothing at all.
  it('criterion 4: an invalid PIN (pin=12) writes nothing and flashes the retired /identity message', async () => {
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin, is_couple, blocked)
         VALUES (?, 'Old', 'old@example.com', 'email', '1111', 0, 0)`
      )
      .run('c4token00000000000000000000000a').lastInsertRowid;

    const res = await adminAgent.post(`/admin/guests/${guestId}/edit`).type('form').send({
      name: 'New',
      contact: 'new@example.com',
      pin: '12',
      is_couple: '1',
      blocked: '1',
    });

    expect(res.headers.location).toContain(
      encodeURIComponent('Please choose a 4-digit PIN (numbers only).')
    );
    const row = db
      .prepare('SELECT name, contact, pin, is_couple, blocked FROM guests WHERE id = ?')
      .get(guestId);
    expect(row).toEqual({
      name: 'Old',
      contact: 'old@example.com',
      pin: '1111',
      is_couple: 0,
      blocked: 0,
    });
  });

  // Criterion 5, half A: a contact-less, pin-less guest saves fine with
  // empty boxes, the common case the seeded event's own guests are in
  // (tests/helpers/event-fixture.js's insertGuest never sets contact/pin).
  it('criterion 5a: a guest with NULL contact/pin saves fine with both boxes left empty', async () => {
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('c5atoken0000000000000000000000', 'No Contact Guest').lastInsertRowid;

    const before = db.prepare('SELECT contact, pin FROM guests WHERE id = ?').get(guestId);
    expect(before.contact).toBeNull();
    expect(before.pin).toBeNull();

    const res = await adminAgent.post(`/admin/guests/${guestId}/edit`).type('form').send({
      name: 'Renamed',
      contact: '',
      pin: '',
      blocked: '1',
    });

    expect(res.headers.location).toContain(encodeURIComponent('Guest updated.'));
    const row = db
      .prepare('SELECT name, contact, pin, blocked FROM guests WHERE id = ?')
      .get(guestId);
    expect(row).toEqual({ name: 'Renamed', contact: null, pin: null, blocked: 1 });
  });

  // Criterion 5, half B: a guest who DOES hold contact/pin has both cleared
  // to NULL by the same empty-box save: a blank box is a real value, never
  // a reason to leave the stored one alone.
  it('criterion 5b: clearing both boxes on a guest who holds contact/pin writes NULL to both', async () => {
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin)
         VALUES (?, 'Has Contact', 'c5b-old@example.com', 'email', '1111')`
      )
      .run('c5btoken0000000000000000000000').lastInsertRowid;

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send({ name: 'Has Contact', contact: '', pin: '' });

    expect(res.headers.location).toContain(encodeURIComponent('Guest updated.'));
    const row = db
      .prepare('SELECT contact, contact_type, pin FROM guests WHERE id = ?')
      .get(guestId);
    expect(row).toEqual({ contact: null, contact_type: null, pin: null });
  });

  it('a non-empty contact that collides with another guest writes nothing', async () => {
    db.prepare(
      `INSERT INTO guests (token, name, contact, contact_type)
       VALUES (?, 'Taken', 'taken@example.com', 'email')`
    ).run('collidetoken0000000000000000000');
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('collideenow0000000000000000000a', 'Wants It').lastInsertRowid;

    const res = await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send({ name: 'Wants It', contact: 'taken@example.com' });

    expect(res.headers.location).toContain(
      encodeURIComponent('That contact is already in use by another guest.')
    );
    expect(db.prepare('SELECT contact FROM guests WHERE id = ?').get(guestId).contact).toBeNull();
  });

  // The three states a form field can arrive in. "Submitted empty" and "not
  // submitted at all" look the same to a careless reader and mean opposite
  // things here: the first clears a guest's way back in, the second must
  // never touch it. The popup always sends both keys, so only a caller that
  // is NOT the popup omits one.
  it('leaves contact and PIN alone when the keys are not submitted at all', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin)
         VALUES (?, ?, ?, 'email', ?)`
      )
      .run(
        'absentkeys0000000000000000000a',
        'Absent Keys',
        'absent@example.com',
        '1111'
      ).lastInsertRowid;

    await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send({ name: 'Absent Keys', is_couple: '1' });

    const row = db
      .prepare('SELECT name, contact, pin, is_couple FROM guests WHERE id = ?')
      .get(guestId);
    expect(row).toEqual({
      name: 'Absent Keys',
      contact: 'absent@example.com',
      pin: '1111',
      is_couple: 1,
    });
  });

  it('refuses a repeated name instead of throwing, and writes nothing', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin)
         VALUES (?, ?, ?, 'email', ?)`
      )
      .run(
        'repeatedname00000000000000000a',
        'Repeated Name',
        'dee@example.com',
        '5555'
      ).lastInsertRowid;

    // A bare (req.body.name || '').trim() throws on an array, turning a
    // malformed submit into a 500 instead of a refusal.
    const res = await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send('name=A&name=B&contact=dee@example.com&pin=5555');

    expect(res.status).toBe(303);
    expect(res.headers.location).toContain(
      encodeURIComponent('That form could not be read. Please try again.')
    );
    const row = db.prepare('SELECT name, contact, pin FROM guests WHERE id = ?').get(guestId);
    expect(row).toEqual({ name: 'Repeated Name', contact: 'dee@example.com', pin: '5555' });
  });

  // Checkboxes take the OPPOSITE absent-key rule from the text fields: an
  // unchecked box sends nothing, so absence is its only "off" signal. These
  // three pin the rule the route already had, so widening it for #1093 does
  // not quietly move it.
  it('a checkbox submitted empty still means off, and a checked one still means on', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare('INSERT INTO guests (token, name, is_couple, blocked) VALUES (?, ?, 1, 1)')
      .run('emptycheckbox000000000000000a', 'Empty Checkbox').lastInsertRowid;

    await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send('name=Empty Checkbox&contact=&pin=&is_couple=&blocked=');
    expect(db.prepare('SELECT is_couple, blocked FROM guests WHERE id = ?').get(guestId)).toEqual({
      is_couple: 0,
      blocked: 0,
    });

    await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send('name=Empty Checkbox&contact=&pin=&is_couple=1&blocked=1');
    expect(db.prepare('SELECT is_couple, blocked FROM guests WHERE id = ?').get(guestId)).toEqual({
      is_couple: 1,
      blocked: 1,
    });
  });

  it('a repeated checkbox key is refused rather than read as checked', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare('INSERT INTO guests (token, name, is_couple, blocked) VALUES (?, ?, 0, 0)')
      .run('repeatedcheckbox000000000000a', 'Repeated Checkbox').lastInsertRowid;

    // An array is truthy, so reading presence alone would let a malformed
    // submit block or unblock a guest on a request that was never valid.
    const res = await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send('name=Changed&contact=&pin=&blocked=1&blocked=1');

    expect(res.headers.location).toContain(
      encodeURIComponent('That form could not be read. Please try again.')
    );
    const row = db.prepare('SELECT name, is_couple, blocked FROM guests WHERE id = ?').get(guestId);
    expect(row).toEqual({ name: 'Repeated Checkbox', is_couple: 0, blocked: 0 });
  });

  it('an unknown guest answers "Guest not found." even when a field is malformed', async () => {
    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent
      .post('/admin/guests/999999/edit')
      .type('form')
      .send('name=A&name=B');

    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
  });

  it('leaves the name alone when the name key is not submitted at all', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('absentname0000000000000000000a', 'Keep This Name').lastInsertRowid;

    await adminAgent.post(`/admin/guests/${guestId}/edit`).type('form').send({ blocked: '1' });

    const row = db.prepare('SELECT name, blocked FROM guests WHERE id = ?').get(guestId);
    expect(row).toEqual({ name: 'Keep This Name', blocked: 1 });
  });

  it('refuses a repeated key instead of reading it as a cleared box', async () => {
    const adminAgent = await makeAdminAgent(app);
    const guestId = db
      .prepare(
        `INSERT INTO guests (token, name, contact, contact_type, pin)
         VALUES (?, ?, ?, 'email', ?)`
      )
      .run(
        'repeatedkey000000000000000000a',
        'Repeated Key',
        'repeat@example.com',
        '3333'
      ).lastInsertRowid;

    // Express parses a repeated key into an ARRAY. Trimming that to '' would
    // read as "the host cleared this box" and delete the guest's contact.
    const res = await adminAgent
      .post(`/admin/guests/${guestId}/edit`)
      .type('form')
      .send('name=Repeated Key&contact=x@example.com&contact=z@example.com&pin=4444');

    expect(res.headers.location).toContain(
      encodeURIComponent('Please enter a valid email or phone number.')
    );
    const row = db.prepare('SELECT contact, pin FROM guests WHERE id = ?').get(guestId);
    expect(row).toEqual({ contact: 'repeat@example.com', pin: '3333' });
  });
});

// ---------------------------------------------------------------------------
// Bonus points
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/points', () => {
  it('adds then subtracts, agreeing with scoring.getPoints', async () => {
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('pointstoken000000000000000000a', 'Point Guest').lastInsertRowid;

    let res = await adminAgent
      .post(`/admin/guests/${guestId}/points`)
      .type('form')
      .send({ delta: '5' });
    expect(
      db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
    ).toBe(5);
    expect(scoring.getPoints(guestId)).toBe(5);
    expect(res.headers.location).toContain(encodeURIComponent('Awarded 5'));

    res = await adminAgent
      .post(`/admin/guests/${guestId}/points`)
      .type('form')
      .send({ delta: '-2' });
    expect(
      db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
    ).toBe(3);
    expect(scoring.getPoints(guestId)).toBe(3);
    expect(res.headers.location).toContain(encodeURIComponent('Removed 2'));
  });

  it.each(['0', 'abc'])(
    'rejects delta=%s — bonus_points unchanged, message says "non-zero"',
    async (delta) => {
      const guestId = db
        .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
        .run(`rejtoken${delta}00000000000000000`.slice(0, 32), 'Reject Guest').lastInsertRowid;

      const res = await adminAgent
        .post(`/admin/guests/${guestId}/points`)
        .type('form')
        .send({ delta });

      expect(
        db.prepare('SELECT bonus_points FROM guests WHERE id = ?').get(guestId).bonus_points
      ).toBe(0);
      expect(res.headers.location).toContain(encodeURIComponent('non-zero'));
    }
  );

  it('unknown guest id redirects with "Guest not found."', async () => {
    const res = await adminAgent
      .post('/admin/guests/999999/points')
      .type('form')
      .send({ delta: '5' });
    expect(res.headers.location).toContain(encodeURIComponent('Guest not found.'));
  });
});

// ---------------------------------------------------------------------------
// Delete — survives a missing file on disk
// ---------------------------------------------------------------------------
describe('POST /admin/guests/:id/delete — missing photo file on disk', () => {
  it('deletes the guest and their submission even though the file is already gone', async () => {
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Missing-file Task').lastInsertRowid;
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('missingfiletoken00000000000000a', 'Missing File Guest').lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(
        guestId,
        taskId,
        'does-not-exist-on-disk.jpg',
        'does-not-exist-on-disk.jpg.jpg'
      ).lastInsertRowid;

    const res = await adminAgent.post(`/admin/guests/${guestId}/delete`).type('form').send({});

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT id FROM guests WHERE id = ?').get(guestId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId)).toBeUndefined();
  });
});
