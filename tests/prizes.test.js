// tests/prizes.test.js
// Issue #469 acceptance criteria — the hosts' prizes blurb (Goal B's
// "visible stakes" outcome), a host-set free-text setting shown on
// /leaderboard and edited on the existing /admin/config form:
//   AC1 — admin sets the prizes text on the Configuration page: POST then GET
//         shows the saved text in the rendered textarea.
//   AC2 — guests see it on /leaderboard, inside .prizes-card, before the
//         podium markup in the document.
//   AC3 — blank (or whitespace-only) prizes means no .prizes-card marker at
//         all on /leaderboard.
//   AC4 — output is HTML-escaped (no raw <script> tag reaches the guest).
//   AC5 — a 600-char POST is truncated server-side to the first 500 chars,
//         matching the textarea's maxlength=500.
//   AC6 — a rejected save (bad timezone) leaves the stored prizes untouched,
//         same "nothing persists unless every field passes" rule
//         setEventConfig already gets.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);
});

// A valid timezone/date payload merged with whatever `prizes` value a test
// wants to exercise — every POST in this file must carry a passing
// timezone/date trio or the prizes save never even gets attempted.
function validConfigBody(prizes) {
  return { timezone: 'America/Denver', start_date: '2026-08-07', end_date: '2026-08-09', prizes };
}

// A fresh guest with a unique token each call (testApp.js's own seed()
// hard-codes a single 'seedtoken' — fine for a test that seeds once, but this
// file signs in a NEW guest per test/branch, so a repeat call needs its own
// distinct token to avoid guests.token's UNIQUE constraint), signed in via
// signInGuest's cookie mint (issue #244 retired the GET /j/:token route every
// older test used). Returns the guest id and the signed-in agent.
let guestSeq = 0;
function newGuest() {
  guestSeq += 1;
  const token = `prizes-test-token-${guestSeq}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, `Prizes Guest ${guestSeq}`).lastInsertRowid;
  return { guestId, agent: signInGuest(app, token) };
}

// Give a guest N extra 1-point submissions (a fresh task per submission,
// avoiding the UNIQUE(guest_id, task_id) collision) so the leaderboard has
// more than one distinct point value and showPodium is true — AC2 requires
// the .prizes-card to sit ahead of REAL podium markup, not the "everyone's
// tied" fallback banner.
let taskSeq = 0;
function addPoints(guestId, n) {
  const insertSub = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  );
  for (let i = 0; i < n; i++) {
    taskSeq += 1;
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run(`Prizes-test task ${taskSeq}`).lastInsertRowid;
    insertSub.run(guestId, taskId, `prizes-p${taskSeq}.jpg`, `prizes-t${taskSeq}.jpg`);
  }
}

describe('AC1: admin sets the prizes text on the Configuration page', () => {
  it('POSTing prizes text then GETting the page shows it in the rendered textarea', async () => {
    const postRes = await adminAgent
      .post('/admin/config')
      .type('form')
      .send(validConfigBody('1st: a bottle of the good stuff'));
    expect(postRes.status).toBe(303);

    const getRes = await adminAgent.get('/admin/config');
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('1st: a bottle of the good stuff');
    // Confirm it landed inside the textarea, not merely somewhere on the page.
    const textareaStart = getRes.text.indexOf('<textarea id="prizes"');
    const textareaEnd = getRes.text.indexOf('</textarea>', textareaStart);
    expect(textareaStart).toBeGreaterThan(-1);
    expect(getRes.text.slice(textareaStart, textareaEnd)).toContain(
      '1st: a bottle of the good stuff'
    );
  });
});

describe('AC2: guests see it on the leaderboard, ahead of the podium', () => {
  it('the .prizes-card markup contains the saved text and precedes the podium markup', async () => {
    await adminAgent
      .post('/admin/config')
      .type('form')
      .send(validConfigBody('1st: a bottle of the good stuff'));

    const { agent } = newGuest();
    // A second, higher-scoring guest so the field has 2 distinct point
    // values -> showPodium is true and real '<div class="podium">' markup
    // renders (a 1-guest or all-tied field would only show the "everyone's
    // tied" banner, which is not what AC2 is asking to be ordered against).
    const { guestId: otherGuestId } = newGuest();
    addPoints(otherGuestId, 3);

    const res = await agent.get('/leaderboard');
    expect(res.status).toBe(200);

    const cardStart = res.text.indexOf('<div class="prizes-card">');
    const podiumStart = res.text.indexOf('<div class="podium">');
    expect(cardStart).toBeGreaterThan(-1);
    expect(podiumStart).toBeGreaterThan(-1);
    expect(cardStart).toBeLessThan(podiumStart);

    const cardEnd = res.text.indexOf('</div>', res.text.indexOf('prizes-card-body'));
    expect(res.text.slice(cardStart, cardEnd)).toContain('1st: a bottle of the good stuff');
  });
});

describe('AC3: blank (or whitespace-only) prizes means no .prizes-card marker', () => {
  it('empty string', async () => {
    await adminAgent.post('/admin/config').type('form').send(validConfigBody(''));

    const res = await newGuest().agent.get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('prizes-card');
  });

  it('whitespace-only', async () => {
    await adminAgent.post('/admin/config').type('form').send(validConfigBody('   \n\t  '));

    const res = await newGuest().agent.get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('prizes-card');
  });
});

describe('AC4: output is HTML-escaped', () => {
  it('a raw <script> tag never reaches the guest; the escaped form does', async () => {
    await adminAgent
      .post('/admin/config')
      .type('form')
      .send(validConfigBody('<script>alert(1)</script>'));

    const res = await newGuest().agent.get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('AC5: server-side length cap at 500 chars', () => {
  it('a 600-char POST is stored/rendered as only the first 500 chars', async () => {
    const longText = 'A'.repeat(500) + 'B'.repeat(100);
    expect(longText.length).toBe(600);

    await adminAgent.post('/admin/config').type('form').send(validConfigBody(longText));

    const getRes = await adminAgent.get('/admin/config');
    expect(getRes.status).toBe(200);
    const textareaStart = getRes.text.indexOf('<textarea id="prizes"');
    const textareaEnd = getRes.text.indexOf('</textarea>', textareaStart);
    expect(textareaStart).toBeGreaterThan(-1);
    const textareaContent = getRes.text.slice(textareaStart, textareaEnd);
    expect(textareaContent).toContain('A'.repeat(500));
    // None of the 100 'B' chars survived -- confirms truncation landed at
    // exactly 500, not merely "at least 500".
    expect(textareaContent).not.toContain('B');
  });
});

describe('review fix: an absent prizes key preserves the stored value', () => {
  it('a POST with no prizes field at all (a pre-#469 cached form) does not erase the text', async () => {
    await adminAgent.post('/admin/config').type('form').send(validConfigBody('keep me'));

    const noKey = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'America/Denver',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
    });
    expect(noKey.status).toBe(303);
    expect(noKey.headers.location).not.toContain('err=1');

    const getRes = await adminAgent.get('/admin/config');
    expect(getRes.text).toContain('keep me');
  });
});

describe('review fix: the 500-char cut never strands half an emoji', () => {
  it('a lone lead surrogate left at position 500 is dropped, not stored', async () => {
    // 499 'A's then an emoji (2 UTF-16 units): slice(0, 500) would end on the
    // emoji's lead surrogate alone.
    const text = 'A'.repeat(499) + '\u{1F389}' + 'B'.repeat(50);
    await adminAgent.post('/admin/config').type('form').send(validConfigBody(text));

    const getRes = await adminAgent.get('/admin/config');
    const textareaStart = getRes.text.indexOf('<textarea id="prizes"');
    const textareaEnd = getRes.text.indexOf('</textarea>', textareaStart);
    const textareaContent = getRes.text.slice(textareaStart, textareaEnd);
    expect(textareaContent).toContain('A'.repeat(499));
    // Neither the replacement character nor any bare surrogate survived.
    expect(textareaContent).not.toContain('�');
    expect(/[\uD800-\uDFFF]/.test(textareaContent)).toBe(false);
  });
});

describe('AC6: a rejected save leaves stored prizes (and everything else) unchanged', () => {
  it('an invalid timezone with new prizes text saves nothing, prizes included', async () => {
    await adminAgent.post('/admin/config').type('form').send(validConfigBody('old prizes'));

    const rejected = await adminAgent.post('/admin/config').type('form').send({
      timezone: 'Mars/Nowhere',
      start_date: '2026-08-07',
      end_date: '2026-08-09',
      prizes: 'new prizes',
    });
    expect(rejected.status).toBe(303);
    expect(rejected.headers.location).toContain('err=1');

    const getRes = await adminAgent.get('/admin/config');
    expect(getRes.status).toBe(200);
    expect(getRes.text).toContain('old prizes');
    expect(getRes.text).not.toContain('new prizes');
  });
});
