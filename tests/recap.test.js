// tests/recap.test.js
// Issue #644: the recap ("what you missed") panel — bell notifications for
// badges, likes, and comments, pull-only, never push.
//
// AC1 — owed celebration paid exactly once, however the badge was granted.
// AC2 — unread count matches the rows, and dismiss does not clear it.
// AC3 — likes batch, comments do not; hidden comment excluded; takedown
//       removes the whole photo's rows.
// AC4 — a revoked badge outlives its deleted guest_badges row.
// AC5 — a guest's own actions never notify them; a repeat award never
//       double-notifies.
// AC6 — paging and reset.
// AC7 — zero-event state.
// AC8 — neither existing nor brand-new guests flood or starve across the
//       migration.
//
// AC8's "existing database" half needs a table that genuinely predates this
// issue (missing guests.recap_checked_at / guest_badges.celebrated_at), the
// same standalone technique tests/avatar-point-migration.test.js uses: lay
// down the OLD shape with a raw better-sqlite3 connection, point
// DATA_DIR/DB_PATH at that file, then require the real src/db.js so its
// module-load migrations — including the real, exported
// ensureRecapCheckedAtColumn/ensureGuestBadgeCelebratedAtColumn — run against
// it for real. Unlike that file, this ONE pre-seeded database is then reused
// for every other AC in this file too (rather than living in its own file):
// re-requiring src/db.js a second time inside one file does not reliably
// yield a second independent connection, so there is no way to get a
// "fresh, already-migrated" database in the same process afterward — but a
// database that has ALREADY migrated is a perfectly ordinary, fully
// functional app database, and every guest/task/badge a later AC needs is
// simply created fresh in it, the same way loadApp()'s fresh database would
// be filled by any other test file.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const request = require('supertest');
const { signInGuest, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let dbModule;
let scoring;
let notifications;
let photos;

// The one pre-existing guest+badge this file's AC8 half is built around —
// seeded into the OLD-shape database below, before src/db.js ever runs.
let legacyGuestToken;
let legacyGuestId;
let legacyBadgeId;
let legacyAwardCreatedAt;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-recap-'));
  const dbPath = path.join(dir, 'test.db');

  // Lay down guests/badges/guest_badges in their pre-#644 shape: every
  // column those tables carry today, MINUS recap_checked_at (guests) and
  // celebrated_at (guest_badges) — the two this issue's migration adds.
  // tasks/submissions/likes/comments/settings are deliberately absent here:
  // db.js's own `CREATE TABLE IF NOT EXISTS` block creates each of those
  // fresh, in its current full shape, since IF NOT EXISTS only no-ops for a
  // table (guests/badges/guest_badges) this seed already created.
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
      pinned        INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE badges (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT    NOT NULL UNIQUE,
      name         TEXT    NOT NULL,
      type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
      threshold    INTEGER,
      art_path     TEXT    NOT NULL,
      description  TEXT    NOT NULL DEFAULT ''
    );
    CREATE TABLE guest_badges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
      awarded_by  TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
    );
  `);

  legacyGuestToken = `recap-legacy-${crypto.randomUUID()}`;
  legacyAwardCreatedAt = '2026-01-02 00:00:00';
  legacyGuestId = seedDb
    .prepare(`INSERT INTO guests (token, name, created_at) VALUES (?, ?, ?)`)
    .run(legacyGuestToken, 'Legacy Guest', '2026-01-01 00:00:00').lastInsertRowid;
  legacyBadgeId = seedDb
    .prepare(`INSERT INTO badges (code, name, type, art_path, description) VALUES (?, ?, ?, ?, ?)`)
    .run('BLOOM', 'placeholder', 'auto', '/placeholder.svg', 'placeholder').lastInsertRowid;
  seedDb
    .prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, created_at) VALUES (?, ?, 'system', ?)`
    )
    .run(legacyGuestId, legacyBadgeId, legacyAwardCreatedAt);
  seedDb.close();

  process.env.DATA_DIR = dir;
  process.env.DB_PATH = dbPath;

  // Requiring src/db.js NOW runs its real module-load migrations —
  // including ensureRecapCheckedAtColumn and
  // ensureGuestBadgeCelebratedAtColumn — against the old-shape tables above.
  dbModule = require('../src/db');
  db = dbModule.db;
  app = require('../src/app');
  scoring = require('../src/services/scoring');
  notifications = require('../src/services/notifications');
  photos = require('../src/services/photos');
});

afterAll(() => {
  dbModule.db.close();
  delete process.env.DATA_DIR;
  delete process.env.DB_PATH;
});

// ---------------------------------------------------------------------------
// Shared helpers (same shapes as rewards.test.js / tasks-page.test.js).
// ---------------------------------------------------------------------------

// A row's `text` field (issue #644 review) is now a structured `parts` array
// — [{ text, emphasis?, quote? }] — not a pre-built HTML string, so escaping
// happens in the VIEW (EJS `<%= %>` / DOM textContent), never in this
// service. Tests that need to assert on a row's rendered COPY join the parts
// back into plain text, quote marks included, the same shape a guest would
// actually read (curly quotes match header.ejs's &ldquo;/&rdquo; render).
function partsText(parts) {
  return (parts || []).map((part) => (part.quote ? `“${part.text}”` : part.text)).join('');
}

function insertGuest(name) {
  const token = `recap-${crypto.randomUUID()}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId, opts = {}) {
  const createdAt = opts.createdAt || null;
  const info = createdAt
    ? db
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`
        )
        .run(guestId, taskId, `p-${guestId}-${taskId}.jpg`, `t-${guestId}-${taskId}.jpg`, createdAt)
    : db
        .prepare(
          `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
           VALUES (?, ?, ?, ?, 0)`
        )
        .run(guestId, taskId, `p-${guestId}-${taskId}.jpg`, `t-${guestId}-${taskId}.jpg`);
  return info.lastInsertRowid;
}

// SQLite's datetime('now') has whole-SECOND precision — a guest inserted
// and an event on them inserted (with no explicit created_at) inside the
// same wall-clock second land on the IDENTICAL string, which the checkpoint
// comparison's strict `>` correctly (and deliberately, matching every other
// timestamp comparison in this codebase — e.g. feed.js's neighbor lookups)
// treats as "not newer." Backdating the guest's own created_at removes that
// race for a test that needs a guaranteed-real gap without introducing a
// real sleep.
function backdateGuest(guestId, createdAt) {
  db.prepare(`UPDATE guests SET created_at = ? WHERE id = ?`).run(createdAt, guestId);
}

function seedCompletedTasks(guestId, n, labelPrefix) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const taskId = insertTask(`${labelPrefix} task ${i}`);
    ids.push(insertSubmission(guestId, taskId));
  }
  return ids;
}

async function agentFor(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

function likeAs(likerGuestId, submissionId, createdAt) {
  if (createdAt) {
    db.prepare(
      `INSERT OR IGNORE INTO likes (submission_id, guest_id, created_at) VALUES (?, ?, ?)`
    ).run(submissionId, likerGuestId, createdAt);
  } else {
    db.prepare(`INSERT OR IGNORE INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      likerGuestId
    );
  }
}

function commentAs(commenterGuestId, submissionId, body, createdAt) {
  if (createdAt) {
    db.prepare(
      `INSERT INTO comments (submission_id, guest_id, body, created_at) VALUES (?, ?, ?, ?)`
    ).run(submissionId, commenterGuestId, body, createdAt);
  } else {
    db.prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`).run(
      submissionId,
      commenterGuestId,
      body
    );
  }
}

// ---------------------------------------------------------------------------
// AC8 — neither existing nor brand-new guests flood or starve.
// ---------------------------------------------------------------------------
describe('AC8: migration — existing vs brand-new guests', () => {
  it('drops no data and adds guests.recap_checked_at / guest_badges.celebrated_at', () => {
    const guestCols = db
      .prepare('PRAGMA table_info(guests)')
      .all()
      .map((c) => c.name);
    const gbCols = db
      .prepare('PRAGMA table_info(guest_badges)')
      .all()
      .map((c) => c.name);
    expect(guestCols).toContain('recap_checked_at');
    expect(gbCols).toContain('celebrated_at');
  });

  it('backfills the pre-existing guest_badges row to celebrated_at = created_at (not NULL)', () => {
    const row = db
      .prepare(
        'SELECT celebrated_at, created_at FROM guest_badges WHERE guest_id = ? AND badge_id = ?'
      )
      .get(legacyGuestId, legacyBadgeId);
    expect(row.celebrated_at).toBe(legacyAwardCreatedAt);
    expect(row.celebrated_at).toBe(row.created_at);
  });

  it('backfills the pre-existing guest to a non-null recap_checked_at', () => {
    const row = db.prepare('SELECT recap_checked_at FROM guests WHERE id = ?').get(legacyGuestId);
    expect(row.recap_checked_at).not.toBeNull();
  });

  it('given a pre-existing badge, no celebration dialog fires and the unread count is 0', async () => {
    const agent = await agentFor(legacyGuestToken);
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    // No auto-open script for a badge that was already "celebrated" by the
    // backfill — badgeMoment resolves to null.
    expect(res.text).not.toContain('/js/badge-moment.js');
    expect(res.text).not.toContain('class="recap-strip"');
    expect(res.text).not.toContain('class="notifications-entry-count"');
    expect(notifications.getUnreadCount(legacyGuestId)).toBe(0);
  });

  it('a guest who joins AFTER the migration keeps recap_checked_at NULL until they open the recap', () => {
    const fresh = insertGuest('Fresh Joiner');
    const row = db.prepare('SELECT recap_checked_at FROM guests WHERE id = ?').get(fresh.id);
    expect(row.recap_checked_at).toBeNull();
  });

  it('a never-checked guest is never treated as having no checkpoint: one event afterward gives unread count 1', () => {
    const fresh = insertGuest('Fresh Joiner Two');
    backdateGuest(fresh.id, '2020-01-01 00:00:00');
    const liker = insertGuest('Liker Of Fresh Two');
    const taskId = insertTask('AC8 fresh task');
    const subId = insertSubmission(fresh.id, taskId);
    likeAs(liker.id, subId);
    expect(notifications.getUnreadCount(fresh.id)).toBe(1);
  });

  it('re-running the real guarded migrations against the already-migrated DB does not throw', () => {
    expect(() => dbModule.ensureRecapCheckedAtColumn()).not.toThrow();
    expect(() => dbModule.ensureGuestBadgeCelebratedAtColumn()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC1 — owed celebration is paid exactly once, however the badge was granted.
// ---------------------------------------------------------------------------
describe('AC1: owed celebration paid exactly once', () => {
  it('a recompute-granted badge auto-opens on the redirected task page, and never again on a later page', async () => {
    const guest = insertGuest('AC1 Recompute Guest');
    seedCompletedTasks(guest.id, 4, 'ac1');
    const fifthTaskId = insertTask('AC1 fifth task');
    const agent = await agentFor(guest.token);

    // Cross the BLOOM threshold via the same submitPhoto route rewards.test.js
    // uses (multer requires a real file — go through submissions.js directly
    // instead, which is what AC3 of that file already does for the identical
    // reason: no HTTP upload machinery needed to exercise the badge grant).
    const submissions = require('../src/services/submissions');
    const sharp = require('sharp');
    const jpeg = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    const config = require('../config');
    const filePath = path.join(config.UPLOADS_DIR, `ac1-${crypto.randomUUID()}.jpg`);
    fs.writeFileSync(filePath, jpeg);
    const result = await submissions.submitPhoto({
      guestId: guest.id,
      taskId: fifthTaskId,
      file: { filename: path.basename(filePath), path: filePath },
      caption: '',
    });
    expect(result.newBadgeIds).toContain('BLOOM');

    const taskPage = await agent.get(`/tasks/${fifthTaskId}`);
    expect(taskPage.status).toBe(200);
    expect(taskPage.text).toContain('/js/badge-moment.js');
    expect(taskPage.text).toContain('First Bloom!');

    // A second request — the SAME task page again — must not auto-open it.
    const taskPageAgain = await agent.get(`/tasks/${fifthTaskId}`);
    expect(taskPageAgain.text).not.toContain('/js/badge-moment.js');

    // Nor does a DIFFERENT guest page.
    const home = await agent.get('/');
    expect(home.text).not.toContain('/js/badge-moment.js');

    // The recap row survives, carrying replay data — "without depending on
    // the badge still being owed" (AC1): the row and its data-badge-* payload
    // are still present even though celebrated_at is now non-NULL.
    expect(home.text).toContain('recap-row-badge');
    expect(home.text).toContain('data-badge-code="BLOOM"');
    expect(home.text).toContain('data-badge-name="First Bloom"');
  });

  it('a host-awarded badge is owed exactly like a recompute-granted one', async () => {
    const guest = insertGuest('AC1 Host-Award Guest');
    const adminAgent = await makeAdminAgent(app, `ac1-admin-${crypto.randomUUID()}`);
    const award = await adminAgent
      .post(`/admin/guests/${guest.id}/badge`)
      .type('form')
      .send({ code: 'EARLYBIRD', action: 'award' });
    expect(award.status).toBe(303);

    const agent = await agentFor(guest.token);
    const page = await agent.get('/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('/js/badge-moment.js');
    expect(page.text).toContain('Early Bird!');

    const again = await agent.get('/');
    expect(again.text).not.toContain('/js/badge-moment.js');
  });
});

// ---------------------------------------------------------------------------
// AC2 — unread count matches the rows, and dismiss does not clear it.
// ---------------------------------------------------------------------------
describe('AC2: unread count matches the rows; dismiss does not clear it', () => {
  it('8 new likes on one photo + one badge earned reads 2, not 9 — and survives a reload', async () => {
    const guest = insertGuest('AC2 Guest');
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask('AC2 photo task');
    const subId = insertSubmission(guest.id, taskId);
    for (let i = 0; i < 8; i++) {
      const liker = insertGuest(`AC2 Liker ${i}`);
      likeAs(liker.id, subId);
    }
    scoring.awardSpecialBadge(guest.id, 'EARLYBIRD');

    expect(notifications.getUnreadCount(guest.id)).toBe(2);

    const agent = await agentFor(guest.token);
    const page = await agent.get('/');
    expect(page.text).toContain('2 new notification');

    // Dismiss is a client-side-only DOM removal (src/public/js/recap.js) —
    // it never calls the server, so a reload with NO /recap/seen call in
    // between (exactly what "dismissed, then reloaded" is server-side) must
    // show the identical, unchanged count.
    const reload = await agent.get('/');
    expect(reload.text).toContain('2 new notification');
    expect(notifications.getUnreadCount(guest.id)).toBe(2);
  });

  it('after the guest opens the recap (POST /recap/seen), a subsequent render shows no count and no strip', async () => {
    const guest = insertGuest('AC2 Open Guest');
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask('AC2 open task');
    const subId = insertSubmission(guest.id, taskId);
    const liker = insertGuest('AC2 Open Liker');
    likeAs(liker.id, subId);
    expect(notifications.getUnreadCount(guest.id)).toBe(1);

    const agent = await agentFor(guest.token);
    const before = await agent.get('/');
    expect(before.text).toContain('class="recap-strip"');

    const seen = await agent.post('/recap/seen');
    expect(seen.status).toBe(204);

    const after = await agent.get('/');
    expect(after.text).not.toContain('class="recap-strip"');
    expect(after.text).not.toContain('class="notifications-entry-count"');
    expect(notifications.getUnreadCount(guest.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — likes batch, comments do not; hidden comment excluded; takedown
// removes the whole photo's rows.
// ---------------------------------------------------------------------------
describe('AC3: likes batch, comments do not; visibility owners apply', () => {
  it('3 new likes + 2 comments render as 1 batched like row + 2 comment rows; a photo with 5 older + 3 newer likes still reads 3', async () => {
    const guest = insertGuest('AC3 Guest');
    const taskId = insertTask('AC3 task');
    const subId = insertSubmission(guest.id, taskId);

    // 5 OLDER likes (before the checkpoint) — must not inflate the count.
    for (let i = 0; i < 5; i++) {
      const liker = insertGuest(`AC3 Old Liker ${i}`);
      likeAs(liker.id, subId, '2020-01-01 00:00:00');
    }
    // Checkpoint sits between the old and new likes.
    db.prepare(`UPDATE guests SET recap_checked_at = ? WHERE id = ?`).run(
      '2025-01-01 00:00:00',
      guest.id
    );
    // 3 NEWER likes.
    for (let i = 0; i < 3; i++) {
      const liker = insertGuest(`AC3 New Liker ${i}`);
      likeAs(liker.id, subId, '2026-01-01 00:00:00');
    }
    const commenter1 = insertGuest('AC3 Commenter One');
    const commenter2 = insertGuest('AC3 Commenter Two');
    commentAs(commenter1.id, subId, 'this is the best one yet', '2026-01-01 00:00:01');
    commentAs(commenter2.id, subId, 'hahaha love it', '2026-01-01 00:00:02');

    const { rows } = notifications.getRecap(guest.id);
    const likeRows = rows.filter((r) => partsText(r.parts).includes('liked your photo'));
    expect(likeRows).toHaveLength(1);
    expect(partsText(likeRows[0].parts)).toContain('3');
    expect(partsText(likeRows[0].parts)).not.toContain('8');

    const commentRows = rows.filter((r) => partsText(r.parts).includes('commented'));
    expect(commentRows).toHaveLength(2);
    expect(commentRows.some((r) => partsText(r.parts).includes('this is the best one yet'))).toBe(
      true
    );
    expect(commentRows.some((r) => partsText(r.parts).includes('hahaha love it'))).toBe(true);

    // Host hides one comment — only 1 remains, and its body is gone from the
    // recap entirely (not just unlinked).
    const commentRow = db
      .prepare('SELECT id FROM comments WHERE submission_id = ? AND body = ?')
      .get(subId, 'hahaha love it');
    const adminAgent = await makeAdminAgent(app, `ac3-admin-${crypto.randomUUID()}`);
    const hideRes = await adminAgent.post(`/admin/comments/${commentRow.id}/hide`);
    expect(hideRes.status).toBe(303);

    const afterHide = notifications
      .getRecap(guest.id)
      .rows.filter((r) => partsText(r.parts).includes('commented'));
    expect(afterHide).toHaveLength(1);
    expect(partsText(afterHide[0].parts)).not.toContain('hahaha love it');
    expect(partsText(afterHide[0].parts)).toContain('this is the best one yet');

    // Host takes the photo itself down — no row survives for it at all, not
    // the likes, not the remaining comment.
    photos.hideSubmission(subId);
    const afterTakedown = notifications.getRecap(guest.id).rows;
    expect(afterTakedown.some((r) => r.href === `/p/${subId}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — a revoked badge outlives its deleted guest_badges row.
// ---------------------------------------------------------------------------
describe('AC4: a revoked badge outlives its deleted row', () => {
  it('crossing then un-crossing the BLOOM threshold (the same revoke path Completionist uses) leaves a revoked recap row linking to /tasks', () => {
    const guest = insertGuest('AC4 Guest');
    const subIds = seedCompletedTasks(guest.id, 5, 'ac4');
    scoring.recomputeBadges(guest.id);

    const bloomBadgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('BLOOM').id;
    const held = db
      .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guest.id, bloomBadgeId);
    expect(held).toBeTruthy();

    // Drop below the threshold (the recompute door's real trigger — a
    // takedown — rather than a hand-written DELETE, so this exercises the
    // exact seam AC4 depends on).
    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(subIds[0]);
    scoring.recomputeBadges(guest.id);

    const stillHeld = db
      .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guest.id, bloomBadgeId);
    expect(stillHeld).toBeUndefined();

    const revokedRow = notifications
      .getRecap(guest.id)
      .rows.find((r) => r.kind === 'loss' && partsText(r.parts).includes('First Bloom'));
    expect(revokedRow).toBeTruthy();
    expect(revokedRow.href).toBe('/tasks');
  });
});

// ---------------------------------------------------------------------------
// AC5 — a guest's own actions never notify them; a repeat award never
// double-notifies.
// ---------------------------------------------------------------------------
describe("AC5: a guest's own actions never notify them; a repeat award never double-notifies", () => {
  it('a guest commenting on their own photo gets no recap row for it', () => {
    const guest = insertGuest('AC5 Self-Comment Guest');
    const taskId = insertTask('AC5 self-comment task');
    const subId = insertSubmission(guest.id, taskId);
    commentAs(guest.id, subId, 'nice job me', '2026-01-01 00:00:00');

    const rows = notifications.getRecap(guest.id).rows;
    expect(rows.some((r) => partsText(r.parts).includes('nice job me'))).toBe(false);
  });

  it('a host re-awarding an already-held badge (double-submit) writes exactly one earned row', () => {
    const guest = insertGuest('AC5 Repeat Award Guest');
    scoring.awardSpecialBadge(guest.id, 'EARLYBIRD');
    scoring.awardSpecialBadge(guest.id, 'EARLYBIRD'); // double-submit / re-award

    const earlyBirdBadgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('EARLYBIRD').id;
    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_events
          WHERE guest_id = ? AND kind = 'badge_granted' AND badge_id = ?`
      )
      .get(guest.id, earlyBirdBadgeId).n;
    expect(count).toBe(1);

    const earnedRows = notifications
      .getRecap(guest.id)
      .rows.filter((r) => r.kind === 'badge' && partsText(r.parts).includes('Early Bird'));
    expect(earnedRows).toHaveLength(1);
  });

  it('removing a badge the guest does not hold writes no revoked row', () => {
    const guest = insertGuest('AC5 Remove Not-Held Guest');
    scoring.removeSpecialBadge(guest.id, 'EARLYBIRD'); // never awarded

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM notification_events WHERE guest_id = ?`)
      .get(guest.id).n;
    expect(count).toBe(0);
  });

  // PR review finding: removeSpecialBadge used to emit the SAME 'badge_revoked'
  // kind the threshold-recompute revoke paths use, whose copy ("the hosts
  // added a task") and /tasks link are both false for a direct host removal.
  it('a host removing a HELD badge writes its own badge_removed row, dead, with host-removal copy (not badge_revoked\'s "added a task")', () => {
    const guest = insertGuest('AC5 Host-Removal Guest');
    scoring.awardSpecialBadge(guest.id, 'EARLYBIRD');
    scoring.removeSpecialBadge(guest.id, 'EARLYBIRD');

    const earlyBirdBadgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('EARLYBIRD').id;
    const revokedKindCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_events
          WHERE guest_id = ? AND kind = 'badge_revoked' AND badge_id = ?`
      )
      .get(guest.id, earlyBirdBadgeId).n;
    expect(revokedKindCount).toBe(0);
    const removedKindCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_events
          WHERE guest_id = ? AND kind = 'badge_removed' AND badge_id = ?`
      )
      .get(guest.id, earlyBirdBadgeId).n;
    expect(removedKindCount).toBe(1);

    const removedRow = notifications
      .getRecap(guest.id)
      .rows.find((r) => partsText(r.parts).includes('Early Bird'));
    expect(removedRow).toBeTruthy();
    expect(removedRow.dead).toBe(true);
    expect(partsText(removedRow.parts)).toContain('was removed by the hosts');
    expect(partsText(removedRow.parts)).not.toContain('added a task');
    expect(removedRow.href).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC6 — paging and reset.
// ---------------------------------------------------------------------------
describe('AC6: paging and reset', () => {
  it('GET /recap pages 20 rows at a time via a before cursor, with a real end', async () => {
    const guest = insertGuest('AC6 Guest');
    const badgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('BLOOM').id;
    // 25 distinct stored events, strictly decreasing timestamps so ordering
    // (and therefore paging) is deterministic.
    for (let i = 0; i < 25; i++) {
      const createdAt = `2026-02-01 12:${String(59 - i).padStart(2, '0')}:00`;
      db.prepare(
        `INSERT INTO notification_events (guest_id, kind, badge_id, created_at) VALUES (?, 'badge_granted', ?, ?)`
      ).run(guest.id, badgeId, createdAt);
    }

    const agent = await agentFor(guest.token);
    const first = await agent.get('/recap');
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(20);
    expect(first.body.hasMore).toBe(true);

    const cursor = first.body.rows[first.body.rows.length - 1].when;
    const second = await agent.get('/recap?before=' + encodeURIComponent(cursor));
    expect(second.status).toBe(200);
    expect(second.body.rows).toHaveLength(5);
    expect(second.body.hasMore).toBe(false);

    // No overlap between the two pages.
    const firstWhens = new Set(first.body.rows.map((r) => r.when));
    expect(second.body.rows.every((r) => !firstWhens.has(r.when))).toBe(true);
  });

  it('a same-second tie at the page boundary is neither dropped nor duplicated across pages (composite before/beforeKey cursor)', async () => {
    const guest = insertGuest('AC6 Tie Guest');
    const badgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('BLOOM').id;
    // 19 events with distinct, strictly decreasing timestamps, then 4 MORE
    // sharing the exact same timestamp as what would be the page boundary —
    // the same "23 events, 4 share a second" shape the #644 review measured
    // losing 3 rows under a `when`-only cursor: page one returned 20 rows,
    // page two returned 0 with hasMore false, and the remaining 3 tied rows
    // were unreachable forever (SQLite's datetime('now') has only
    // whole-second precision, so a same-transaction double grant — e.g.
    // recomputeBadges crossing two thresholds at once — can genuinely land
    // on the identical second).
    for (let i = 0; i < 19; i++) {
      const createdAt = `2026-03-01 12:${String(59 - i).padStart(2, '0')}:00`;
      db.prepare(
        `INSERT INTO notification_events (guest_id, kind, badge_id, created_at) VALUES (?, 'badge_granted', ?, ?)`
      ).run(guest.id, badgeId, createdAt);
    }
    const tiedAt = '2026-03-01 12:40:00';
    for (let i = 0; i < 4; i++) {
      db.prepare(
        `INSERT INTO notification_events (guest_id, kind, badge_id, created_at) VALUES (?, 'badge_granted', ?, ?)`
      ).run(guest.id, badgeId, tiedAt);
    }

    const agent = await agentFor(guest.token);
    const first = await agent.get('/recap');
    expect(first.status).toBe(200);
    expect(first.body.rows).toHaveLength(20);
    expect(first.body.hasMore).toBe(true);

    const lastRow = first.body.rows[first.body.rows.length - 1];
    expect(lastRow.key).toBeTruthy();
    const second = await agent.get(
      '/recap?before=' +
        encodeURIComponent(lastRow.when) +
        '&beforeKey=' +
        encodeURIComponent(lastRow.key)
    );
    expect(second.status).toBe(200);
    expect(second.body.hasMore).toBe(false);

    // Every one of the 23 rows appears EXACTLY once across the two pages —
    // neither dropped (the pre-fix bug) nor duplicated (a naive fix that
    // widened the comparison to <= instead of composing the tie-break key).
    const allKeys = first.body.rows.map((r) => r.key).concat(second.body.rows.map((r) => r.key));
    expect(allKeys).toHaveLength(23);
    expect(new Set(allKeys).size).toBe(23);
  });

  it('structural: recap.js discards paged-in rows and resets scroll on the panel close event', () => {
    const scriptSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'public', 'js', 'recap.js'),
      'utf8'
    );
    expect(scriptSource).toContain("addEventListener('close', reset)");
    expect(scriptSource).toContain('FIRST_PAGE_COUNT');
    expect(scriptSource).toContain('list.scrollTop = 0');
  });
});

// ---------------------------------------------------------------------------
// AC7 — zero-event state.
// ---------------------------------------------------------------------------
describe('AC7: zero-event state', () => {
  it('a guest with no events sees the empty line, no strip, and no count chip', async () => {
    const guest = insertGuest('AC7 Guest');
    expect(notifications.getUnreadCount(guest.id)).toBe(0);
    expect(notifications.getRecap(guest.id).rows).toHaveLength(0);

    const agent = await agentFor(guest.token);
    const home = await agent.get('/');
    expect(home.status).toBe(200);
    expect(home.text).not.toContain('class="recap-strip"');
    expect(home.text).not.toContain('class="notifications-entry-count"');
    expect(home.text).toContain('Nothing yet');
  });
});

// ---------------------------------------------------------------------------
// Minor (issue #644 review): the recap panel and its script must not ship to
// a signed-out visitor. header.ejs previously gated the whole block on
// `!isAdmin` alone, which is also true for a signed-out guest — join.ejs and
// login.ejs both include this same header, so a visitor who has never signed
// in downloaded /js/recap.js and rendered an (always-empty) recap dialog for
// no reason.
// ---------------------------------------------------------------------------
describe('Minor: recap panel is gated on a signed-in guest, not just !isAdmin', () => {
  it('GET /join (no guest session) renders no recap strip, panel, or script', async () => {
    const res = await request(app).get('/join');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('class="recap-strip"');
    expect(res.text).not.toContain('id="recap-panel"');
    expect(res.text).not.toContain('id="badge-dialog"');
    expect(res.text).not.toContain('/js/recap.js');
  });
});

// ---------------------------------------------------------------------------
// MAJOR (PR review): a render that never went through withBadgeMoment (e.g.
// GET /admin/login, which is !isAdmin and reachable by a signed-in guest —
// GET /admin redirects there — but calls res.render('admin-login', ...)
// directly, never withBadgeMoment) used to still ship the strip because
// header.ejs's OLD guard was `!_isAdmin && _guest` alone: recapUnreadCount
// comes from attachGuest middleware (runs on every request), so the strip
// showed the guest's real unread count while the panel underneath it, having
// no recapRows to assemble from, always rendered the empty "Nothing yet"
// state — a real count promising rows that were never there. The fix gates
// the whole block on `typeof recapRows !== 'undefined'` too, so a render
// that did not assemble the recap page ships neither the strip nor the panel.
// ---------------------------------------------------------------------------
describe('MAJOR (PR review): recap block requires an actual withBadgeMoment render, not just isAdmin+guest', () => {
  it('GET /admin/login as a signed-in guest with an unread notification renders no strip and no panel/dialog', async () => {
    const guest = insertGuest('Admin-Login Guest');
    backdateGuest(guest.id, '2020-01-01 00:00:00');
    const taskId = insertTask('Admin-login gate task');
    const subId = insertSubmission(guest.id, taskId);
    const liker = insertGuest('Admin-Login Liker');
    likeAs(liker.id, subId);
    expect(notifications.getUnreadCount(guest.id)).toBe(1);

    const agent = await agentFor(guest.token);
    const res = await agent.get('/admin/login');
    expect(res.status).toBe(200);
    // Before the fix: strip present (real "1 new notification" count) over an
    // empty panel — asserting the strip's absence is the load-bearing check.
    expect(res.text).not.toContain('class="recap-strip"');
    expect(res.text).not.toContain('new notification');
    expect(res.text).not.toContain('id="recap-panel"');
    expect(res.text).not.toContain('recap-empty');
    expect(res.text).not.toContain('id="badge-dialog"');
    expect(res.text).not.toContain('/js/recap.js');
  });
});
