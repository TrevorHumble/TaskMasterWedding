// tests/csrf.test.js
// Issue #284: app-wide CSRF protection (signed double-submit token) +
// security headers. This file is the ONE place the real, unforgiving
// mechanism runs end-to-end — every other test file in this suite predates
// CSRF and relies on src/middleware/csrf.js's test-only legacy grandfather
// clause (a request supplying NO token at all is forgiven while
// NODE_ENV=test and the flag is at its default) to keep passing unmodified.
// This file calls _setLegacyBypassForTest(false) up front so its own
// assertions are never quietly waved through by that clause — see
// src/middleware/csrf.js's own comment on legacyBypassEnabled for the full
// rationale, and DESIGN.md's "Test-only legacy grandfather clause" note.
//
// REQUIRE ORDER: config / db / app / csrf are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH env vars (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let config;
let csrf;
let validJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  csrf = require('../src/middleware/csrf');
  // Disable the legacy grandfather clause for this whole file — every
  // assertion below wants the real mechanism, not the "nothing supplied"
  // leniency the rest of this suite relies on. vitest's default per-file
  // module isolation (vitest.config.mjs carries no isolate:false) keeps this
  // from bleeding into any other test file's own module instance.
  csrf._setLegacyBypassForTest(false);

  validJpeg = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg()
    .toBuffer();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extract the CSRF token off the <meta name="csrf-token"> tag every page renders. */
function extractToken(html) {
  const m = /<meta name="csrf-token" content="([^"]*)">/.exec(html);
  expect(m).toBeTruthy();
  expect(m[1].length).toBeGreaterThan(0);
  return m[1];
}

/**
 * A signed-in guest agent that has ALSO already GETted a page (minting the
 * signed csrf cookie into its jar and reading the matching token off the
 * rendered meta tag) — the exact "first GET, then read the cookie + the
 * rendered token" flow the issue's test plan describes.
 */
async function guestAgentWithToken(name) {
  const token = `csrf-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, name).lastInsertRowid;
  const agent = signInGuest(app, token);
  const homeRes = await agent.get('/');
  const csrfToken = extractToken(homeRes.text);
  return { agent, guestId, csrfToken };
}

/**
 * A logged-in admin agent that has ALSO minted a real csrf token. The login
 * POST itself needs the legacy bypass (it supplies no token of its own —
 * makeAdminAgent is the SHARED helper every other test file relies on
 * unmodified) — toggled on only for that one bootstrap call, then back off
 * before returning, so every assertion this file makes afterward still runs
 * under strict enforcement.
 */
async function adminAgentWithToken() {
  csrf._setLegacyBypassForTest(true);
  const agent = await makeAdminAgent(app);
  csrf._setLegacyBypassForTest(false);
  const dashRes = await agent.get('/admin');
  const csrfToken = extractToken(dashRes.text);
  return { agent, csrfToken };
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title, special_mode) VALUES (?, 'none')`).run(title)
    .lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Security headers — every response, including a plain GET.
// ---------------------------------------------------------------------------
describe('security headers', () => {
  it('sets X-Content-Type-Options, X-Frame-Options, and Referrer-Policy on every response', async () => {
    const res = await request(app).get('/join');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('does not set a Content-Security-Policy header (deliberate omission)', async () => {
    const res = await request(app).get('/join');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('a GET request receives a signed csrf cookie and a rendered token', async () => {
    const res = await request(app).get('/join');
    expect(res.headers['set-cookie'].some((c) => c.startsWith('csrf='))).toBe(true);
    extractToken(res.text); // throws/fails the expectation inside if absent
  });

  it('a GET route is never blocked — no token needed, unlike the same-session POST', async () => {
    // Same signed-in admin session as AC1 uses, WITHOUT ever supplying a
    // token: GET/HEAD/OPTIONS are exempt from verification (only
    // POST/PUT/PATCH/DELETE are checked — see csrfMiddleware's
    // UNSAFE_METHODS set), so a page render always succeeds regardless of
    // whether the caller has ever seen a token, while the exact same
    // session's POST without one (AC1 above) is refused 403.
    const { agent } = await adminAgentWithToken();
    const res = await agent.get('/admin/bugs');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC1 — admin: a state-changing admin POST with a signed-in admin session but
// a missing/wrong _csrf is refused 403, and no state changes.
// ---------------------------------------------------------------------------
describe('AC1: admin state-changing route rejects a missing/wrong token', () => {
  it('POST /admin/tasks/:id/delete with NO token is refused 403 and the task survives', async () => {
    const { agent } = await adminAgentWithToken();
    const taskId = insertTask('AC1 no-token survivor');

    const res = await agent.post('/admin/tasks/' + taskId + '/delete');
    expect(res.status).toBe(403);

    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(row).toBeTruthy();
  });

  it('POST /admin/tasks/:id/delete with a WRONG token is refused 403 and the task survives', async () => {
    const { agent } = await adminAgentWithToken();
    const taskId = insertTask('AC1 wrong-token survivor');

    const res = await agent
      .post('/admin/tasks/' + taskId + '/delete')
      .set('X-CSRF-Token', 'not-the-real-token');
    expect(res.status).toBe(403);

    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(row).toBeTruthy();
  });

  it('POST /admin/tasks/:id/delete with the CORRECT token succeeds and the task is gone', async () => {
    const { agent, csrfToken } = await adminAgentWithToken();
    const taskId = insertTask('AC1 correct-token deleted');

    const res = await agent
      .post('/admin/tasks/' + taskId + '/delete')
      .set('X-CSRF-Token', csrfToken);
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC2 — guest: same shape for a guest write route.
// ---------------------------------------------------------------------------
describe('AC2: guest state-changing route rejects a missing/wrong token', () => {
  it('POST /p/:id/like with NO token is refused 403 and no likes row is created', async () => {
    const author = await guestAgentWithToken('ac2-author');
    const liker = await guestAgentWithToken('ac2-liker');
    const taskId = insertTask('AC2 like task');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'ac2.jpg', 'ac2t.jpg', 0)`
      )
      .run(author.guestId, taskId).lastInsertRowid;

    const res = await liker.agent.post('/p/' + submissionId + '/like');
    expect(res.status).toBe(403);

    const row = db
      .prepare('SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?')
      .get(submissionId, liker.guestId);
    expect(row).toBeUndefined();
  });

  it('POST /p/:id/like with a WRONG token is refused 403 and no likes row is created', async () => {
    const author = await guestAgentWithToken('ac2-author-wrong');
    const liker = await guestAgentWithToken('ac2-liker-wrong');
    const taskId = insertTask('AC2 like task wrong');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'ac2w.jpg', 'ac2wt.jpg', 0)`
      )
      .run(author.guestId, taskId).lastInsertRowid;

    const res = await liker.agent.post('/p/' + submissionId + '/like').set('X-CSRF-Token', 'nope');
    expect(res.status).toBe(403);

    const row = db
      .prepare('SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?')
      .get(submissionId, liker.guestId);
    expect(row).toBeUndefined();
  });

  it('POST /p/:id/like with the CORRECT token succeeds and a likes row is created', async () => {
    const author = await guestAgentWithToken('ac2-author-ok');
    const liker = await guestAgentWithToken('ac2-liker-ok');
    const taskId = insertTask('AC2 like task ok');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'ac2ok.jpg', 'ac2okt.jpg', 0)`
      )
      .run(author.guestId, taskId).lastInsertRowid;

    const res = await liker.agent
      .post('/p/' + submissionId + '/like')
      .set('X-CSRF-Token', liker.csrfToken);
    expect(res.status).toBe(302);

    const row = db
      .prepare('SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?')
      .get(submissionId, liker.guestId);
    expect(row).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC3 — multipart: a real upload with the correct token succeeds (both via
// the header and via the hidden _csrf form field); a forged multipart POST
// (wrong/no token) is refused and leaves no residue on disk or in the DB.
// ---------------------------------------------------------------------------
describe('AC3: multipart upload — success with a correct token, refusal when forged', () => {
  it('succeeds with the token as the X-CSRF-Token header (the JS-upload path)', async () => {
    const guest = await guestAgentWithToken('ac3-header');
    const taskId = insertTask('AC3 header task');

    const res = await guest.agent
      .post('/tasks/' + taskId + '/submit')
      .set('X-CSRF-Token', guest.csrfToken)
      .attach('photo', validJpeg, { filename: 'ac3-header.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(res.status);

    const row = db
      .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.guestId, taskId);
    expect(row).toBeTruthy();
  });

  it('succeeds with the token as the hidden _csrf form field (the no-JS native submit path)', async () => {
    const guest = await guestAgentWithToken('ac3-field');
    const taskId = insertTask('AC3 field task');

    const res = await guest.agent
      .post('/tasks/' + taskId + '/submit')
      .field('_csrf', guest.csrfToken)
      .attach('photo', validJpeg, { filename: 'ac3-field.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(res.status);

    const row = db
      .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.guestId, taskId);
    expect(row).toBeTruthy();
  });

  it('a forged multipart POST (no token at all) is refused 403, creates no row, and leaves no file on disk', async () => {
    const guest = await guestAgentWithToken('ac3-forged-none');
    const taskId = insertTask('AC3 forged task none');

    const before = fs.readdirSync(config.UPLOADS_DIR);
    const res = await guest.agent
      .post('/tasks/' + taskId + '/submit')
      .attach('photo', validJpeg, { filename: 'ac3-forged-none.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);

    const row = db
      .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.guestId, taskId);
    expect(row).toBeUndefined();

    const after = fs.readdirSync(config.UPLOADS_DIR);
    expect(after.length).toBe(before.length);
  });

  it('a forged multipart POST (wrong token) is refused 403, creates no row, and leaves no file on disk', async () => {
    const guest = await guestAgentWithToken('ac3-forged-wrong');
    const taskId = insertTask('AC3 forged task wrong');

    const before = fs.readdirSync(config.UPLOADS_DIR);
    const res = await guest.agent
      .post('/tasks/' + taskId + '/submit')
      .field('_csrf', 'definitely-not-the-real-token')
      .attach('photo', validJpeg, { filename: 'ac3-forged-wrong.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);

    const row = db
      .prepare('SELECT * FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guest.guestId, taskId);
    expect(row).toBeUndefined();

    const after = fs.readdirSync(config.UPLOADS_DIR);
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review regression (issue #284): a non-upload route must not be
// able to bypass CSRF simply by declaring a multipart Content-Type. Only the
// four dedicated upload paths (MULTIPART_UPLOAD_PATHS in
// src/middleware/csrf.js) are allowed to defer verification into the route
// itself; every other route is verified by header right here in the
// middleware, exactly like a non-multipart request would be. Before the fix,
// isMultipart(req) alone (with no path check) deferred EVERY multipart
// request unconditionally and only the four upload routes ever called
// assertCsrf — so a forged multipart POST to any other state-changing route
// (the two cases below) sailed through with no CSRF check of any kind. This
// is the exact attack the finding described: it must fail before the fix and
// pass after it.
// ---------------------------------------------------------------------------
describe('Multipart-bypass regression: a non-upload route still rejects a forged multipart POST with no token', () => {
  it('POST /p/:id/like declared as multipart/form-data with no token is refused 403, and no likes row is created', async () => {
    const author = await guestAgentWithToken('mp-bypass-author');
    const liker = await guestAgentWithToken('mp-bypass-liker');
    const taskId = insertTask('multipart bypass like task');
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'mpbypass.jpg', 'mpbypasst.jpg', 0)`
      )
      .run(author.guestId, taskId).lastInsertRowid;

    // .field() (with no .attach()) is enough to make superagent send a real
    // multipart/form-data body with a boundary — no _csrf field inside it,
    // and no X-CSRF-Token header set either.
    const res = await liker.agent.post('/p/' + submissionId + '/like').field('_dummy', '1');
    expect(res.status).toBe(403);

    const row = db
      .prepare('SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?')
      .get(submissionId, liker.guestId);
    expect(row).toBeUndefined();
  });

  it('POST /admin/tasks/:id/delete declared as multipart/form-data with no token is refused 403, and the task survives', async () => {
    const { agent } = await adminAgentWithToken();
    const taskId = insertTask('multipart bypass admin delete task');

    const res = await agent.post('/admin/tasks/' + taskId + '/delete').field('_dummy', '1');
    expect(res.status).toBe(403);

    const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
    expect(row).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AC4 — table-driven: a representative state-changing route from every
// router (auth.js, guest.js, community.js, admin.js), spanning urlencoded,
// JSON, and no-body shapes, each rejects a request carrying a valid session
// but no CSRF token — so a future route that forgets to sit behind
// csrfMiddleware (wired app-wide, ahead of every router, in src/app.js) fails
// this suite. Placeholder ids are safe here (never real seeded rows):
// csrfMiddleware runs BEFORE any router dispatch, so a non-multipart route's
// own handler — including its own 404-on-missing-row logic — never runs at
// all on a request this table rejects.
// ---------------------------------------------------------------------------
describe('AC4: every router rejects a valid session with no CSRF token', () => {
  let guestAgent;
  let adminAgent;

  beforeAll(async () => {
    const guest = await guestAgentWithToken('ac4-table-guest');
    guestAgent = guest.agent;
    const admin = await adminAgentWithToken();
    adminAgent = admin.agent;
  });

  const guestRoutes = [
    { method: 'post', path: '/bug-report', label: 'guest.js POST /bug-report (urlencoded)' },
    { method: 'post', path: '/recap/seen', label: 'guest.js POST /recap/seen (no body)' },
    {
      method: 'post',
      path: '/me/avatar/delete',
      label: 'guest.js POST /me/avatar/delete (no body)',
    },
    { method: 'post', path: '/p/999999/like', label: 'community.js POST /p/:id/like' },
    { method: 'post', path: '/p/999999/caption', label: 'community.js POST /p/:id/caption' },
    { method: 'post', path: '/logout', label: 'auth.js POST /logout (no body)' },
  ];

  const adminRoutes = [
    {
      method: 'post',
      path: '/admin/checklist/setup/toggle',
      label: 'admin.js POST /admin/checklist/:id/toggle',
    },
    { method: 'post', path: '/admin/config', label: 'admin.js POST /admin/config (urlencoded)' },
    {
      method: 'post',
      path: '/admin/tasks/999999/active',
      label: 'admin.js POST /admin/tasks/:id/active',
    },
    {
      method: 'post',
      path: '/admin/photos/999999/favorite',
      label: 'admin.js POST /admin/photos/:id/favorite',
    },
    {
      method: 'post',
      path: '/admin/tasks/reorder-all',
      label: 'admin.js POST /admin/tasks/reorder-all (JSON)',
    },
    { method: 'post', path: '/admin/logout', label: 'auth.js POST /admin/logout (no body)' },
  ];

  it.each(guestRoutes)(
    '$label rejects a signed-in guest with no token (403)',
    async ({ method, path: routePath }) => {
      const res = await guestAgent[method](routePath);
      expect(res.status).toBe(403);
    }
  );

  it.each(adminRoutes)(
    '$label rejects a signed-in admin with no token (403)',
    async ({ method, path: routePath }) => {
      const res = await adminAgent[method](routePath);
      expect(res.status).toBe(403);
    }
  );

  // Anonymous routes (no session at all yet) still require a matching token —
  // login/signup CSRF matters too, since a forged login/signup can still act
  // on the victim's behalf once they land on the resulting session.
  it('auth.js POST /login rejects a request with no token (403)', async () => {
    const res = await request(app).post('/login').type('form').send({ contact: 'x', pin: '0000' });
    expect(res.status).toBe(403);
  });

  it('auth.js POST /admin/login rejects a request with no token (403)', async () => {
    const res = await request(app).post('/admin/login').type('form').send({ password: 'x' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// AC5: every <form method="post"> in src/views/** carries name="_csrf".
// A filesystem walk over the real view templates — not a rendered-page
// sample — so a new form added anywhere under src/views fails this test the
// moment it is written without the include, regardless of whether any
// existing test happens to render that particular view.
// ---------------------------------------------------------------------------
describe('AC5: every <form method="post"> in src/views/** includes the CSRF field', () => {
  function walk(dir) {
    let out = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        out = out.concat(walk(full));
      } else if (entry.endsWith('.ejs')) {
        out.push(full);
      }
    }
    return out;
  }

  it('has no <form method="post"> anywhere in src/views/** missing the csrf-field include', () => {
    const viewsDir = path.join(config.ROOT, 'src', 'views');
    const files = walk(viewsDir);
    const missing = [];
    let formsChecked = 0;

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      // Issue #284 adversarial review: scanning the RAW text with
      // /<form\b[^>]*>/gi was broken for a form whose opening tag itself
      // contains an EJS output tag, e.g.
      // `<form action="/x/<%= id %>/y" method="post">` — `[^>]*` stops at
      // the FIRST '>' it finds, which is the one INSIDE `%>`, so the
      // captured "tag" text never reaches `method="post"` and the form was
      // silently skipped. admin-bugs.ejs, admin-guests.ejs (5 forms),
      // admin-tasks.ejs, and task.ejs (the photo-upload form) all shipped
      // with the real csrf-field include already, but this test could not
      // have caught a missing one on any of them.
      //
      // Fix: replace every `<%...%>` block with a SAME-LENGTH run of spaces
      // before scanning for <form> tags — this removes the embedded '>'
      // without shifting any character's offset, so the start/lineNo math
      // below still lands on the right place in the ORIGINAL text. The
      // include itself (`<%- include('partials/csrf-field') %>`) lives
      // inside an EJS tag too, so the include-presence check below reads
      // from the ORIGINAL (unstripped) text, never the stripped copy.
      const stripped = text.replace(/<%[\s\S]*?%>/g, (m) => ' '.repeat(m.length));
      const formRegex = /<form\b[^>]*>/gi;
      let m;
      while ((m = formRegex.exec(stripped))) {
        const tag = m[0];
        if (!/method\s*=\s*['"]post['"]/i.test(tag)) {
          continue;
        }
        formsChecked += 1;
        const start = m.index + tag.length;
        const closeIdx = text.indexOf('</form>', start);
        const body =
          closeIdx === -1 ? text.slice(start, start + 2000) : text.slice(start, closeIdx);
        // The partial's own doc comment mentions the literal string
        // `<form method="post">` for documentation purposes — it defines no
        // real form of its own, so it is excluded rather than miscounted.
        // (Now moot in practice: that literal lives inside the partial's own
        // `<%# ... %>` doc comment, which the stripping above already blanks
        // out before the form regex ever runs — kept as a defensive no-op.)
        if (file.endsWith(path.join('partials', 'csrf-field.ejs'))) {
          continue;
        }
        if (!body.includes('csrf-field')) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          missing.push(path.relative(config.ROOT, file) + ' @ line ' + lineNo);
        }
      }
    }

    expect(missing).toEqual([]);
    // Regression guard on the guard itself (issue #284 adversarial review):
    // the broken regex above didn't fail loudly — it just quietly checked
    // fewer forms, so `missing` stayed `[]` even while real unchecked forms
    // existed. Asserting a real floor on how many forms were actually
    // inspected means a future regex regression that silently drops forms
    // fails this suite instead of passing green having checked almost
    // nothing. ~35 forms carry the include today (per #284's implementation
    // notes); 30 leaves headroom for a form or two moving/merging later
    // without this floor itself becoming the maintenance burden.
    expect(formsChecked).toBeGreaterThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// Happy path: a normal urlencoded POST with a matching token succeeds.
// ---------------------------------------------------------------------------
describe('happy path', () => {
  it('a normal urlencoded POST with a matching token succeeds and writes the row', async () => {
    const guest = await guestAgentWithToken('happy-path');

    const res = await guest.agent
      .post('/bug-report')
      .set('X-CSRF-Token', guest.csrfToken)
      .type('form')
      .send({ body: 'The lightbox is a little slow on my phone.' });
    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT * FROM bug_reports WHERE guest_id = ?').get(guest.guestId);
    expect(row).toBeTruthy();
    expect(row.body).toBe('The lightbox is a little slow on my phone.');
  });
});
