// tests/badge-queue.test.js
// Issue #902: queue multiple new badges into one continue-through celebration,
// replacing #644's render-time drip (one owed badge paid per render).
//
// AC7's three required areas:
//   - queue resolution ordering — badges of different TYPES prove the
//     comparator path (compareBadgeMoment's type rank, then threshold
//     descending), not just SQL's own code-ascending fallback.
//   - stamp-only-when-shown — POST /badge-moment/celebrated stamps a
//     genuinely owed badge and refuses a non-owed/foreign/unknown one.
//   - abandon-keeps-owed — a queued badge never shown via the endpoint is
//     still owed (celebrated_at NULL) on the next render, and surfaces then
//     as the new head, matching #644's own pre-#902 drip continuity for a
//     guest who never engages the Continue button at all.
//
// Follows tests/badge-moment-priority.test.js's direct-grant fixture idiom
// (INSERT guest_badges bypassing recomputeBadges — full control over which
// badges are "owed together") and tests/recap.test.js's real-route-render
// convention (renderAndTakeBadgeMoment-style: assert on the actual rendered
// page, not a re-derivation of the SQL). notifications.recordEvent is called
// directly for each grant — render-locals.js's stmtOwedBadges requires a
// matching `badge_granted` event (issue #644's EXISTS guard) before treating
// a guest_badges row as owed at all; a hand-rolled INSERT skipping that would
// prove nothing about the real "owed" contract.
'use strict';

const crypto = require('crypto');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let notifications;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  notifications = require('../src/services/notifications');
});

function insertGuest(name) {
  const token = `badge-queue-${crypto.randomUUID()}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function badgeIdByCode(code) {
  return db.prepare('SELECT id FROM badges WHERE code = ?').get(code).id;
}

// Grant an already-seeded catalog badge directly to `guestId` (bypassing
// recomputeBadges/recomputeTransferableBadges, the same shortcut
// tests/badge-moment-priority.test.js's own grantBadge helper takes) AND
// record the matching badge_granted event through the real
// notifications.recordEvent — render-locals.js's "owed" query requires that
// event to exist (issue #644), so skipping it would silently make every
// fixture in this file inert (never owed, never celebrated, nothing to test).
function grantOwedBadge(guestId, code) {
  const badgeId = badgeIdByCode(code);
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'system', 0)`
  ).run(guestId, badgeId);
  notifications.recordEvent(guestId, 'badge_granted', { badgeId });
}

function celebratedAt(guestId, code) {
  return db
    .prepare(
      `SELECT gb.celebrated_at FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ? AND b.code = ?`
    )
    .get(guestId, code).celebrated_at;
}

async function agentFor(token) {
  return signInGuest(app, token);
}

// ---------------------------------------------------------------------------
// Queue resolution: ordering
// ---------------------------------------------------------------------------
describe('queue resolution: ordering by compareBadgeMoment across badge TYPES', () => {
  it('stamps the top-ranked badge as head and orders the rest auto > metric > special, threshold descending within auto', async () => {
    const guest = insertGuest('Queue Order Guest');

    // Five badges owed at once, spanning three different `type`s so the
    // comparator's TYPE rank (not just SQL's code-ascending fallback) is what
    // this test actually proves — auto badges GARDEN(15) > BOUQUET(10) >
    // BLOOM(5) by threshold descending, then metric (COMPLETIONIST), then
    // special (EARLYBIRD) last (scoring.js's BADGE_TYPE_RANK: auto:0,
    // metric:1, special:4). Granted in a DELIBERATELY scrambled order so a
    // comparator that silently fell back to insertion order would fail this
    // test instead of accidentally passing it.
    grantOwedBadge(guest.id, 'EARLYBIRD');
    grantOwedBadge(guest.id, 'BLOOM');
    grantOwedBadge(guest.id, 'COMPLETIONIST');
    grantOwedBadge(guest.id, 'GARDEN');
    grantOwedBadge(guest.id, 'BOUQUET');

    const agent = await agentFor(guest.token);
    const page = await agent.get('/');
    expect(page.status).toBe(200);

    // Head: GARDEN — highest threshold among the auto-type badges, the same
    // top-rank slot #714's compareBadgeMoment already owns.
    expect(page.text).toContain('/js/badge-moment.js');
    expect(page.text).toContain('Full Garden!');
    expect(celebratedAt(guest.id, 'GARDEN')).not.toBeNull();

    // Every OTHER owed badge stays unstamped (queued, not paid) — the #902
    // behavior change from #644's original single-winner resolveBadgeMoment,
    // which never touched celebrated_at for anything but the head.
    expect(celebratedAt(guest.id, 'BOUQUET')).toBeNull();
    expect(celebratedAt(guest.id, 'BLOOM')).toBeNull();
    expect(celebratedAt(guest.id, 'COMPLETIONIST')).toBeNull();
    expect(celebratedAt(guest.id, 'EARLYBIRD')).toBeNull();

    // Queue order in the rendered #badge-queue-data list must be exactly
    // BOUQUET, BLOOM, COMPLETIONIST, EARLYBIRD — proving both the threshold
    // tie-break within `auto` AND the type-rank ordering across auto ->
    // metric -> special in one page. Scoped to the #badge-queue-data list
    // itself (not the whole page): every one of these badges ALSO has its
    // own recap-panel row (each grant recorded a badge_granted event), in
    // RECAP order (most recent grant first) — a page-wide indexOf would find
    // that occurrence first and assert nothing about queue order at all.
    const queueListStart = page.text.indexOf('id="badge-queue-data"');
    expect(queueListStart).toBeGreaterThanOrEqual(0);
    const queueListEnd = page.text.indexOf('</ul>', queueListStart);
    const queueListHtml = page.text.slice(queueListStart, queueListEnd);

    const idxBouquet = queueListHtml.indexOf('data-badge-code="BOUQUET"');
    const idxBloom = queueListHtml.indexOf('data-badge-code="BLOOM"');
    const idxCompletionist = queueListHtml.indexOf('data-badge-code="COMPLETIONIST"');
    const idxEarlybird = queueListHtml.indexOf('data-badge-code="EARLYBIRD"');
    expect(idxBouquet).toBeGreaterThanOrEqual(0);
    expect(idxBloom).toBeGreaterThan(idxBouquet);
    expect(idxCompletionist).toBeGreaterThan(idxBloom);
    expect(idxEarlybird).toBeGreaterThan(idxCompletionist);

    // GARDEN (the head) is stamped and rendered via the dialog, not the
    // queue list — it must not also appear as a queued item.
    expect(queueListHtml).not.toContain('data-badge-code="GARDEN"');
  });

  it('a single owed badge renders with no queue list at all (AC4 — byte-identical single-badge case)', async () => {
    const guest = insertGuest('Single Badge Guest');
    grantOwedBadge(guest.id, 'EARLYBIRD');

    const agent = await agentFor(guest.token);
    const page = await agent.get('/');
    expect(page.text).toContain('/js/badge-moment.js');
    expect(page.text).toContain('Early Bird!');
    expect(page.text).not.toContain('badge-queue-data');
  });
});

// ---------------------------------------------------------------------------
// Stamp-only-when-shown: POST /badge-moment/celebrated
// ---------------------------------------------------------------------------
describe('POST /badge-moment/celebrated: stamps only a genuinely owed badge', () => {
  it('stamps a still-owed queued badge for the signed-in guest, and refuses a repeat once stamped', async () => {
    const guest = insertGuest('Stamp Guest');
    grantOwedBadge(guest.id, 'GARDEN'); // becomes head, stamped by the render
    grantOwedBadge(guest.id, 'BOUQUET'); // stays queued

    const agent = await agentFor(guest.token);
    await agent.get('/'); // render: stamps GARDEN, leaves BOUQUET owed
    expect(celebratedAt(guest.id, 'BOUQUET')).toBeNull();

    const shown = await agent
      .post('/badge-moment/celebrated')
      .type('json')
      .send({ code: 'BOUQUET' });
    expect(shown.status).toBe(204);
    expect(celebratedAt(guest.id, 'BOUQUET')).not.toBeNull();

    // A second POST for the SAME already-stamped badge is refused — no
    // re-stamping (the timestamp does not move) and no 2xx pretending it
    // worked again.
    const before = celebratedAt(guest.id, 'BOUQUET');
    const repeat = await agent
      .post('/badge-moment/celebrated')
      .type('json')
      .send({ code: 'BOUQUET' });
    expect(repeat.status).toBe(404);
    expect(celebratedAt(guest.id, 'BOUQUET')).toBe(before);
  });

  it('refuses a code naming a badge this guest does not hold (foreign badge), leaving the real owner untouched', async () => {
    const owner = insertGuest('Real Owner');
    const attacker = insertGuest('Different Guest');
    grantOwedBadge(owner.id, 'BLOOM'); // owed to `owner`, not `attacker`

    const attackerAgent = await agentFor(attacker.token);
    const res = await attackerAgent
      .post('/badge-moment/celebrated')
      .type('json')
      .send({ code: 'BLOOM' });
    expect(res.status).toBe(404);

    // The real owner's row is untouched by the attacker's request.
    expect(celebratedAt(owner.id, 'BLOOM')).toBeNull();
  });

  it('refuses an unknown badge code', async () => {
    const guest = insertGuest('Unknown Code Guest');
    const agent = await agentFor(guest.token);
    const res = await agent
      .post('/badge-moment/celebrated')
      .type('json')
      .send({ code: 'NOT-A-REAL-BADGE-CODE' });
    expect(res.status).toBe(404);
  });

  it('rejects a request with no code at all', async () => {
    const guest = insertGuest('No Code Guest');
    const agent = await agentFor(guest.token);
    const res = await agent.post('/badge-moment/celebrated').type('json').send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Abandon-keeps-owed
// ---------------------------------------------------------------------------
describe('abandon-keeps-owed: an unshown queue member stays owed across renders', () => {
  it('a queued badge never posted to the endpoint remains owed, and surfaces as the new head on the next render', async () => {
    const guest = insertGuest('Abandon Guest');
    // Three auto badges, distinct thresholds — GARDEN(15) > BOUQUET(10) >
    // BLOOM(5), so the promotion order across renders is unambiguous.
    grantOwedBadge(guest.id, 'BLOOM');
    grantOwedBadge(guest.id, 'BOUQUET');
    grantOwedBadge(guest.id, 'GARDEN');

    const agent = await agentFor(guest.token);

    // First render: GARDEN is resolved as head and stamped; BOUQUET and
    // BLOOM ride along in the queue, UNSTAMPED.
    const first = await agent.get('/');
    expect(first.text).toContain('Full Garden!');
    expect(celebratedAt(guest.id, 'GARDEN')).not.toBeNull();
    expect(celebratedAt(guest.id, 'BOUQUET')).toBeNull();
    expect(celebratedAt(guest.id, 'BLOOM')).toBeNull();

    // The guest abandons here — no Continue tap, so
    // POST /badge-moment/celebrated is never called for BOUQUET or BLOOM.

    // Second render (a fresh page load, as if the guest came back later):
    // BOUQUET — the next-highest-ranked STILL-owed badge — becomes the new
    // head and gets stamped in its place; BLOOM remains owed, untouched.
    const second = await agent.get('/');
    expect(second.text).toContain('/js/badge-moment.js');
    expect(second.text).toContain('Bouquet Builder!');
    expect(celebratedAt(guest.id, 'BOUQUET')).not.toBeNull();
    expect(celebratedAt(guest.id, 'BLOOM')).toBeNull();

    // A third render promotes BLOOM in turn, and nothing is left owed after
    // that — proving no badge was silently lost across the two abandoned
    // renders above.
    const third = await agent.get('/');
    expect(third.text).toContain('First Bloom!');
    expect(celebratedAt(guest.id, 'BLOOM')).not.toBeNull();

    const fourth = await agent.get('/');
    expect(fourth.text).not.toContain('/js/badge-moment.js');
  });
});
