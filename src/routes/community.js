// src/routes/community.js
'use strict';

const express = require('express');
const { db } = require('../db');
const { attachGuest, requireGuest } = require('../middleware/session');
const scoring = require('../services/scoring');
const feed = require('../services/feed');

const router = express.Router();

// Community pages are public, but we still attach the guest (when signed in)
// so the leaderboard can highlight the viewer's own row.
router.use(attachGuest);

/**
 * Parse a guest's social_links JSON string into a safe array of links.
 * Only http/https/mailto URLs are kept; everything else is dropped so a
 * guest cannot inject a "javascript:" or other dangerous URL.
 * Returns: [{ key, label, href, display }]
 */
function parseSocialLinks(raw) {
  let obj;
  try {
    obj = JSON.parse(raw || '{}');
  } catch (e) {
    obj = {};
  }
  if (!obj || typeof obj !== 'object') {
    return [];
  }

  const labels = {
    instagram: 'Instagram',
    facebook: 'Facebook',
    twitter: 'Twitter / X',
    tiktok: 'TikTok',
    linkedin: 'LinkedIn',
    website: 'Website',
    email: 'Email',
  };

  const out = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed === '') {
      continue;
    }

    let href = trimmed;
    // Bare email address -> mailto link.
    if (key === 'email' && !/^mailto:/i.test(href) && href.includes('@')) {
      href = 'mailto:' + href;
    }
    // Bare domain/handle for non-email -> assume https.
    if (key !== 'email' && !/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
      href = 'https://' + href;
    }

    // Final safety check: only allow http, https, mailto.
    let ok;
    try {
      const proto = new URL(href).protocol;
      ok = proto === 'http:' || proto === 'https:' || proto === 'mailto:';
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      continue;
    }

    out.push({
      key,
      label: labels[key] || key,
      href,
      display: trimmed,
    });
  }
  return out;
}

/**
 * Load the badges a guest currently holds, joined to the badge catalog so we
 * have name + art_path for display. Newest awards first.
 */
function loadGuestBadges(guestId) {
  return db
    .prepare(
      `SELECT b.code, b.name, b.art_path, b.type, gb.awarded_by, gb.created_at
         FROM guest_badges gb
         JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ?
        ORDER BY gb.created_at ASC, b.id ASC`
    )
    .all(guestId);
}

/**
 * Attach a `like_count` to each photo in place, in one grouped query rather
 * than one query per photo. The count is computed only over the submission ids
 * the feed already handed us — those rows are already visible because they came
 * from feed.allVisible(), which owns the taken_down = 0 rule. Visibility stays
 * owned by feed.js; this function never re-types the takedown rule. A like on a
 * taken-down photo is therefore never counted, because that photo's id is not
 * in the list.
 * Photos with zero likes get 0, not undefined, so the view never has to branch
 * on a missing field.
 */
function attachLikeCounts(photos) {
  if (photos.length === 0) {
    return photos;
  }
  const placeholders = photos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT submission_id AS submission_id, COUNT(*) AS n
         FROM likes
        WHERE submission_id IN (${placeholders})
        GROUP BY submission_id`
    )
    .all(...photos.map((p) => p.submission_id));

  const countsById = new Map(rows.map((r) => [r.submission_id, r.n]));
  for (const p of photos) {
    p.like_count = countsById.get(p.submission_id) || 0;
  }
  return photos;
}

/**
 * Has this guest already liked this submission? Used by the toggle route to
 * decide insert vs. delete.
 */
function hasLiked(submissionId, guestId) {
  return !!db
    .prepare(`SELECT 1 FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, guestId);
}

// The single source of the comment-length cap. It is enforced server-side in
// the POST route below (AC4) AND passed to the feed view, which renders it as
// the comment input's maxlength — so the browser-side limit is never a
// hand-copied literal that can drift from this server rule.
const COMMENT_MAX_LENGTH = 300;

/**
 * Attach a `comments` array to each photo in place, in one grouped query
 * rather than one query per photo. Loaded only for the submission ids the
 * feed already handed us — those rows are already visible because they came
 * from feed.allVisible(), which owns the taken_down = 0 rule on submissions.
 * This function never re-types that rule; it only adds the comment-level
 * taken_down = 0 filter, which is a separate moderation flag on comments
 * themselves. Oldest-first within each photo, joined to the commenter's name.
 * Photos with zero comments get [], not undefined, so the view never has to
 * branch on a missing field.
 */
function attachComments(photos) {
  if (photos.length === 0) {
    return photos;
  }
  const placeholders = photos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT c.id            AS id,
              c.submission_id AS submission_id,
              c.body          AS body,
              g.id            AS guest_id,
              g.name          AS guest_name
         FROM comments c
         JOIN guests g ON g.id = c.guest_id
        WHERE c.submission_id IN (${placeholders})
          AND c.taken_down = 0
        ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(...photos.map((p) => p.submission_id));

  const commentsById = new Map();
  for (const row of rows) {
    if (!commentsById.has(row.submission_id)) {
      commentsById.set(row.submission_id, []);
    }
    commentsById.get(row.submission_id).push(row);
  }
  for (const p of photos) {
    p.comments = commentsById.get(p.submission_id) || [];
  }
  return photos;
}

/**
 * Attach a `points` field (base + photo_bonus) to each photo in place, in
 * one grouped query rather than one query per photo — mirrors
 * attachLikeCounts/attachComments above. Loaded only for the submission ids
 * the feed already handed us — those rows are already visible because they
 * came from feed.allVisible(), which owns the taken_down = 0 rule. This
 * function never re-types that visibility rule; it only reads photo_bonus for
 * ids already known to be visible. The per-photo point value comes from
 * scoring.photoPoints (the single authority for the base), so the "1" base is
 * never a literal here. A photo with no row found (should not happen given the
 * id came from feed.allVisible()) zero-fills its bonus to 0, so the view never
 * has to branch on a missing field.
 */
function attachPhotoPoints(photos) {
  if (photos.length === 0) {
    return photos;
  }
  const placeholders = photos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id AS submission_id, photo_bonus AS photo_bonus
         FROM submissions
        WHERE id IN (${placeholders})`
    )
    .all(...photos.map((p) => p.submission_id));

  const bonusById = new Map(rows.map((r) => [r.submission_id, r.photo_bonus]));
  for (const p of photos) {
    p.points = scoring.photoPoints(bonusById.get(p.submission_id) || 0);
  }
  return photos;
}

// ---------------------------------------------------------------------------
// GET /gallery  — the shared photo wall.
//
// view=recent (default): flat newest-first list, paginated.
// view=task:            photos grouped by task, newest-first within each group.
// view=user:            photos grouped by guest, newest-first within each group.
// Anything else falls back to recent (HTTP 200, no error).
//
// Optional filters (applied on top of the view):
//   ?task=<id>   show only submissions for that task (any view; 0 results if unknown)
//
// Visibility (which submissions are hidden) and ordering are owned entirely
// by src/services/feed.js — this handler asks feed for a page or a grouping
// and renders whatever comes back; it never touches SQL.
// ---------------------------------------------------------------------------

// Single function that owns the gallery template contract.
// Every branch calls this so the template's expected keys live in one place.
function renderGallery(
  res,
  { view, groups = [], photos = [], page = 1, totalPages = 1, total = 0, taskFilter = null, q = '' }
) {
  return res.render('gallery', {
    title: 'Gallery',
    view,
    groups,
    photos,
    page,
    totalPages,
    total,
    taskFilter,
    q,
  });
}

router.get('/gallery', (req, res) => {
  // Whitelist view; anything unrecognized falls back to 'recent'.
  const VALID_VIEWS = new Set(['recent', 'task', 'user']);
  const view = VALID_VIEWS.has(req.query.view) ? req.query.view : 'recent';

  // Optional single-task filter.
  // If ?task is present but not a positive integer, short-circuit to an empty
  // result rather than running a query that can never match (e.g. task=0 or
  // task=abc). A valid-looking but non-existent id (e.g. 999999) is still a
  // positive integer and flows through the normal query, returning 0 rows
  // naturally — that is what AC3 tests.
  let taskFilter = null;
  if (req.query.task !== undefined) {
    const parsed = parseInt(req.query.task, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return renderGallery(res, { view });
    }
    taskFilter = parsed;
  }

  if (view === 'task' || view === 'user') {
    // --- Grouped views: no pagination; all visible photos. ---
    // ?q= is an optional search term (blank/absent = no filter), trimmed here
    // so feed.grouped() never has to distinguish "absent" from "whitespace".
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const groups = feed.grouped(view, taskFilter, q);
    const total = groups.reduce((sum, g) => sum + g.photos.length, 0);
    return renderGallery(res, { view, groups, total, taskFilter, q });
  }

  // --- recent view: flat, paginated, newest-first. ---
  const requestedPage = parseInt(req.query.page, 10);
  const { photos, page, totalPages, total } = feed.recentPage(taskFilter, requestedPage);

  return renderGallery(res, { view, photos, page, totalPages, total, taskFilter });
});

// ---------------------------------------------------------------------------
// GET /feed  — full-screen vertical scroll of every visible photo.
//
// The gallery grid's thumbnails link here as /feed#photo-<id>: the browser's
// native fragment anchoring scrolls straight to that photo on load (no JS).
// That only works if every visible submission is on the page, so this route
// renders feed.allVisible() — the flat, unpaginated, newest-first list — not
// a paginated or grouped view.
// ---------------------------------------------------------------------------
router.get('/feed', (req, res) => {
  const photos = attachComments(attachPhotoPoints(attachLikeCounts(feed.allVisible())));
  return res.render('feed', { title: 'Feed', photos, commentMaxLength: COMMENT_MAX_LENGTH });
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/like  — toggle the signed-in guest's like on a photo.
//
// Guest-only (requireGuest 403s anonymous requests before this handler runs,
// so no likes row is ever created for AC4). One like per guest per photo is
// the schema's job (UNIQUE (submission_id, guest_id)) — this handler just
// decides which half of the toggle to run: a row already exists → remove it;
// otherwise add it. A taken-down or missing submission 404s, mirroring the
// GET /p/:submissionId handler below.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/like', requireGuest, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  if (hasLiked(submissionId, req.guest.id)) {
    db.prepare(`DELETE FROM likes WHERE submission_id = ? AND guest_id = ?`).run(
      submissionId,
      req.guest.id
    );
  } else {
    db.prepare(`INSERT OR IGNORE INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      req.guest.id
    );
  }

  return res.redirect('/feed#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/comments  — a signed-in guest leaves a comment.
//
// Guest-only (requireGuest 403s anonymous requests before this handler runs,
// so no comments row is ever created for AC8). A taken-down or missing
// submission 404s, mirroring the like route above. The body is trimmed and
// rejected (no insert) if empty or over COMMENT_MAX_LENGTH — that rejection
// is silent (redirect, no row), matching the issue's server-side-cap AC4;
// there is no separate error page because "your comment didn't post" needs
// no more ceremony than the redirect back to the same photo.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/comments', requireGuest, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const body = (req.body.body || '').trim();
  if (body.length === 0 || body.length > COMMENT_MAX_LENGTH) {
    return res.redirect('/feed#photo-' + submissionId);
  }

  db.prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`).run(
    submissionId,
    req.guest.id,
    body
  );

  return res.redirect('/feed#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// GET /p/:submissionId  — full-resolution photo detail view
//
// Shows the original-resolution image, caption, task title, and uploader link.
// Prev (newer) and next (older) links follow the same newest-first total
// order as the gallery, owned entirely by feed.detail()/feed.neighbors().
// Taken-down and nonexistent ids → 404.
// ---------------------------------------------------------------------------

router.get('/p/:submissionId', (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // neighbors() re-derives visibility from the id, so this is safe even
  // though we already have `photo` — the pivot is guaranteed visible because
  // detail() above already 404'd on a missing/taken-down id.
  const { newer, older } = feed.neighbors(submissionId);

  // The template expects next/prev as { submission_id } (or null), truthy-checked.
  // prev = newer (earlier in the newest-first order); next = older.
  return res.render('photo', {
    title: photo.task_title,
    pageScript: 'photo.js',
    photo,
    next: older !== null ? { submission_id: older } : null,
    prev: newer !== null ? { submission_id: newer } : null,
  });
});

// ---------------------------------------------------------------------------
// GET /leaderboard  — all guests ranked by points
// ---------------------------------------------------------------------------
router.get('/leaderboard', (req, res) => {
  // scoring.leaderboard() returns rows already ordered best-first, each with:
  //   { id, name, avatar_path, points, completed }
  // NOTE: the completed-task count is keyed `completed` (not completed_count)
  // in section 06's query — read row.completed here.
  const rows = scoring.leaderboard();

  // Attach rank (with ties sharing a rank) and each guest's badge icons.
  let lastPoints = null;
  let lastRank = 0;
  const ranked = rows.map((row, index) => {
    let rank;
    if (lastPoints === null || row.points !== lastPoints) {
      rank = index + 1; // standard competition ranking (1,2,2,4,...)
      lastRank = rank;
      lastPoints = row.points;
    } else {
      rank = lastRank;
    }
    return {
      rank,
      id: row.id,
      name: row.name,
      avatar_path: row.avatar_path,
      points: row.points,
      completed_count: row.completed,
      badges: loadGuestBadges(row.id),
    };
  });

  res.render('leaderboard', {
    title: 'Leaderboard',
    rows: ranked,
  });
});

// ---------------------------------------------------------------------------
// GET /u/:guestId  — public profile for any guest
// ---------------------------------------------------------------------------
router.get('/u/:guestId', (req, res, next) => {
  const guestId = parseInt(req.params.guestId, 10);
  if (!Number.isInteger(guestId) || guestId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const profileGuest = db
    .prepare(
      `SELECT id, name, avatar_path, social_links, bonus_points, created_at
         FROM guests
        WHERE id = ?`
    )
    .get(guestId);

  if (!profileGuest) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // This guest's score, for display on the profile header.
  // scoring.getPoints(guestId) is the real API from section 06.
  const score = { points: scoring.getPoints(guestId) };

  const badges = loadGuestBadges(guestId);
  const socialLinks = parseSocialLinks(profileGuest.social_links);

  // Visible photos by this guest, newest first, with the task title.
  const photos = feed.guestPhotos(guestId);

  res.render('public-profile', {
    title: profileGuest.name || 'Guest',
    profileGuest,
    badges,
    socialLinks,
    photos,
    score,
  });
});

module.exports = router;
