// tests/gallery-avatars.test.js
// Covers issue #1011 (the shared partials/guest-avatar.ejs component) AC2/AC3/AC4:
//   AC2 — a guest whose avatar_path is set shows their photo (<img
//         src="/uploads/...">) wherever a surface renders their guest-avatar
//         element, with no initials text alongside it.
//   AC3 — a guest with no avatar_path shows their initials instead; a guest
//         whose raw name is empty renders initials that match the label
//         printed as text beside the same circle — never a mismatched "?" —
//         on the two surfaces this file exercises: the guest feed card header
//         (src/views/feed.ejs, which passes `p.guest_name || 'Guest'` to the
//         partial, the exact expression its adjacent <span> prints) and the
//         admin inline moderation feed card header (src/views/admin-photos.ejs,
//         which passes `p._guest_label`, the single-owner value — guestLabel(),
//         src/routes/admin/moderation.js — its adjacent .admin-feed-name span
//         already prints).
//   AC4 — GET /admin/photos?view=user (src/routes/admin/moderation.js) now
//         carries real guest_avatar_path/avatar_path data onto both admin
//         surfaces (the By-person section head and the inline feed card)
//         instead of the deleted phase-1 hard-coded name->filename scaffold;
//         the last test in the AC4 block confirms that scaffold is gone.
//
// NOT covered here: the Shared Gallery By-person head (src/views/gallery.ejs)
// and the admin By-person head (src/views/admin-photos.ejs) — both already
// pass an already-resolved label (`g.heading`, from `groupPhotos()`/
// `guestLabel()` or feed.js's `grouped()`) to the partial and satisfied AC3's
// rule with no code change; see DESIGN.md's #1011 entry for the full picture
// of all four call sites.
//
// Setup mirrors tests/feed-likers.test.js (ad hoc guests/tasks/submissions via
// db.prepare, signInGuest for the guest-facing route, makeAdminAgent for the
// admin route) rather than the full event-fixture generator, which this issue
// does not need.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, signInGuest, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

const ADMIN_PHOTOS_EJS_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'views', 'admin-photos.ejs'),
  'utf8'
);

/** Insert a guest row, returning its id. avatarPath omitted/null -> no avatar. */
function insertGuest(token, name, avatarPath) {
  return db
    .prepare(`INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)`)
    .run(token, name, avatarPath || null).lastInsertRowid;
}

/** Insert a task + one visible (not taken-down) submission for guestId. */
function insertVisibleSubmission(guestId, taskTitle) {
  const taskId = db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(taskTitle).lastInsertRowid;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, `ga-${guestId}.jpg`, `ga-${guestId}-thumb.jpg`).lastInsertRowid;
}

/**
 * Extract the balanced <span ...>...</span> block whose opening tag is the
 * nearest one at-or-before `fromIndex` — depth-counts nested <span>/</span>
 * pairs (the initials fallback nests one span inside the outer .guest-avatar
 * span) the same way tests/feed-full-bleed.test.js's extractBalancedBlock
 * depth-counts braces for a CSS rule.
 */
function extractOuterSpan(source, fromIndex) {
  const openStart = source.lastIndexOf('<span', fromIndex);
  if (openStart === -1) throw new Error('no <span at or before index ' + fromIndex);
  let depth = 0;
  let i = openStart;
  while (i < source.length) {
    if (source.startsWith('</span>', i)) {
      depth--;
      i += '</span>'.length;
      if (depth === 0) return source.slice(openStart, i);
    } else if (source.startsWith('<span', i)) {
      depth++;
      i += '<span'.length;
    } else {
      i++;
    }
  }
  throw new Error('unbalanced <span> starting at index ' + openStart);
}

/** The guest-avatar element whose class attribute is the first one at-or-after `anchorIndex`. */
function avatarAfter(body, anchorIndex) {
  const classIdx = body.indexOf('class="guest-avatar', anchorIndex);
  expect(classIdx).toBeGreaterThan(-1);
  return extractOuterSpan(body, classIdx);
}

/** The guest-avatar element whose class attribute is the nearest one at-or-before `anchorIndex`. */
function avatarBefore(body, anchorIndex) {
  const classIdx = body.lastIndexOf('class="guest-avatar', anchorIndex);
  expect(classIdx).toBeGreaterThan(-1);
  return extractOuterSpan(body, classIdx);
}

describe('AC2/AC3: guest feed card header (src/views/feed.ejs)', () => {
  it('a guest with a photo shows <img src="/uploads/..."> and no initials text', async () => {
    const posterId = insertGuest('ga-feed-photo', 'Ava Fenwick', 'abc.jpg');
    const subId = insertVisibleSubmission(posterId, 'Gallery Avatars - feed photo');
    const viewer = signInGuest(app, 'ga-feed-photo', request.agent(app));

    const res = await viewer.get('/feed');
    expect(res.status).toBe(200);
    const cardIdx = res.text.indexOf('id="photo-' + subId + '"');
    expect(cardIdx).toBeGreaterThan(-1);
    const avatar = avatarAfter(res.text, cardIdx);
    expect(avatar).toContain('<img');
    expect(avatar).toContain('src="/uploads/abc.jpg"');
    expect(avatar).toContain('alt=""');
    expect(avatar).not.toContain('aria-hidden');
  });

  it('a guest with no avatar_path shows their initials, no <img>', async () => {
    const posterId = insertGuest('ga-feed-initials', 'Zoe Chen', null);
    const subId = insertVisibleSubmission(posterId, 'Gallery Avatars - feed initials');
    const viewer = signInGuest(app, 'ga-feed-initials', request.agent(app));

    const res = await viewer.get('/feed');
    const cardIdx = res.text.indexOf('id="photo-' + subId + '"');
    expect(cardIdx).toBeGreaterThan(-1);
    const avatar = avatarAfter(res.text, cardIdx);
    expect(avatar).toContain('ZC');
    expect(avatar).not.toContain('<img');
  });

  it('a guest with an empty name shows initials matching the printed label ("Guest" -> "G")', async () => {
    const posterId = insertGuest('ga-feed-noname', '', null);
    const subId = insertVisibleSubmission(posterId, 'Gallery Avatars - feed noname');
    const viewer = signInGuest(app, 'ga-feed-noname', request.agent(app));

    const res = await viewer.get('/feed');
    const cardIdx = res.text.indexOf('id="photo-' + subId + '"');
    expect(cardIdx).toBeGreaterThan(-1);
    // The name node beside the circle prints "Guest" (feed.ejs's own
    // `p.guest_name || 'Guest'` fallback) — the avatar's initials must derive
    // from that same label, not a different one.
    expect(res.text.indexOf('>Guest<', cardIdx)).toBeGreaterThan(-1);
    const avatar = avatarAfter(res.text, cardIdx);
    expect(avatar).toContain('>G<');
    expect(avatar).not.toContain('<img');
  });
});

describe('AC4: admin surfaces get real avatar data (src/routes/admin/moderation.js)', () => {
  it('GET /admin/photos?view=user renders a real avatar on the By-person head and the inline feed card', async () => {
    const withPhotoId = insertGuest('ga-admin-photo', 'Priya Patel', 'admin-abc.jpg');
    const withoutPhotoId = insertGuest('ga-admin-initials', 'Owen Bennett', null);
    const subWithPhoto = insertVisibleSubmission(withPhotoId, 'Gallery Avatars - admin photo');
    const subWithoutPhoto = insertVisibleSubmission(
      withoutPhotoId,
      'Gallery Avatars - admin initials'
    );

    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.get('/admin/photos?view=user');
    expect(res.status).toBe(200);

    // --- By-person section head ---
    const headingWithPhotoIdx = res.text.indexOf('>Priya Patel<');
    expect(headingWithPhotoIdx).toBeGreaterThan(-1);
    const headAvatarWithPhoto = avatarBefore(res.text, headingWithPhotoIdx);
    expect(headAvatarWithPhoto).toContain('src="/uploads/admin-abc.jpg"');

    const headingWithoutPhotoIdx = res.text.indexOf('>Owen Bennett<');
    expect(headingWithoutPhotoIdx).toBeGreaterThan(-1);
    const headAvatarWithoutPhoto = avatarBefore(res.text, headingWithoutPhotoIdx);
    expect(headAvatarWithoutPhoto).toContain('OB');
    expect(headAvatarWithoutPhoto).not.toContain('<img');

    // --- Inline moderation feed card ---
    const cardWithPhotoIdx = res.text.indexOf('id="feed-photo-' + subWithPhoto + '"');
    expect(cardWithPhotoIdx).toBeGreaterThan(-1);
    const cardAvatarWithPhoto = avatarAfter(res.text, cardWithPhotoIdx);
    expect(cardAvatarWithPhoto).toContain('src="/uploads/admin-abc.jpg"');

    const cardWithoutPhotoIdx = res.text.indexOf('id="feed-photo-' + subWithoutPhoto + '"');
    expect(cardWithoutPhotoIdx).toBeGreaterThan(-1);
    const cardAvatarWithoutPhoto = avatarAfter(res.text, cardWithoutPhotoIdx);
    expect(cardAvatarWithoutPhoto).toContain('OB');
    expect(cardAvatarWithoutPhoto).not.toContain('<img');
  });

  it('an empty-name guest reads "G#<id>" initials on the admin inline feed card, matching its printed label', async () => {
    const noNameId = insertGuest('ga-admin-noname', '', null);
    const subId = insertVisibleSubmission(noNameId, 'Gallery Avatars - admin noname');

    const adminAgent = await makeAdminAgent(app);
    const res = await adminAgent.get('/admin/photos?view=user');
    const cardIdx = res.text.indexOf('id="feed-photo-' + subId + '"');
    expect(cardIdx).toBeGreaterThan(-1);
    // The name node beside the circle prints "Guest #<id>" (guestLabel(),
    // stamped as p._guest_label) — the avatar's initials must derive from
    // that same label, not the raw (empty) guests.name.
    expect(res.text.indexOf('>Guest #' + noNameId + '<', cardIdx)).toBeGreaterThan(-1);
    const avatar = avatarAfter(res.text, cardIdx);
    expect(avatar).toContain('>G#<');
    expect(avatar).not.toContain('<img');
  });

  it('no hard-coded avatar filename remains in admin-photos.ejs (the deleted phase-1 scaffold)', () => {
    expect(ADMIN_PHOTOS_EJS_SOURCE).not.toMatch(/\.(jpg|jpeg|png|webp)['"]/i);
  });
});
