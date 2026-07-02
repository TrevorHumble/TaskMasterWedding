// src/routes/community.js
'use strict';

const express = require('express');
const { db } = require('../db');
const { attachGuest } = require('../middleware/session');
const scoring = require('../services/scoring');

const router = express.Router();

// Community pages are public, but we still attach the guest (when signed in)
// so the leaderboard can highlight the viewer's own row.
router.use(attachGuest);

// How many gallery thumbnails to load per "page" (used for pagination links).
const GALLERY_PAGE_SIZE = 60;

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
    let ok = false;
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
// taken_down = 0 is enforced on every query path (AC6).
// ---------------------------------------------------------------------------

// SELECT columns + FROM/JOINs, without a WHERE clause.
// Every gallery query's filters are applied by galleryQuery() below,
// so taken_down = 0 and any task constraint live in exactly one place.
const GALLERY_SELECT_BODY = `
  SELECT s.id            AS submission_id,
         s.thumb_path    AS thumb_path,
         s.photo_path    AS photo_path,
         s.caption       AS caption,
         s.created_at    AS created_at,
         g.id            AS guest_id,
         g.name          AS guest_name,
         t.id            AS task_id,
         t.title         AS task_title
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
    JOIN tasks  t ON t.id = s.task_id`;

/**
 * Build a fully-assembled, parameterized gallery query.
 *
 * kind         'count' | 'page' | 'all'
 * taskFilter   positive integer to restrict to one task, or null for all tasks.
 * limit/offset only used when kind === 'page'.
 *
 * Returns { sql, args } ready for db.prepare(sql).get(...args) or .all(...args).
 */
function galleryQuery(kind, taskFilter, limit, offset) {
  // taken_down = 0 is the one non-negotiable predicate on every path (AC6).
  const where = ['s.taken_down = 0'];
  const args = [];
  if (taskFilter !== null) {
    where.push('s.task_id = ?');
    args.push(taskFilter);
  }
  const whereSql = ' WHERE ' + where.join(' AND ');

  if (kind === 'count') {
    return { sql: `SELECT COUNT(*) AS n FROM submissions s${whereSql}`, args };
  }

  let sql = GALLERY_SELECT_BODY + whereSql + ' ORDER BY s.created_at DESC, s.id DESC';
  if (kind === 'page') {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, offset);
  }
  return { sql, args };
}

/**
 * Group a flat photo array into [{ heading, photos }] sections by a key
 * function that returns the group label for each photo.
 * Groups preserve insertion order (which is already newest-first within each
 * group because the SQL uses ORDER BY s.created_at DESC, s.id DESC).
 */
function groupPhotos(photos, keyFn) {
  const order = [];
  const map = Object.create(null);
  for (const photo of photos) {
    const key = keyFn(photo);
    if (!map[key]) {
      map[key] = [];
      order.push(key);
    }
    map[key].push(photo);
  }
  return order.map((key) => ({ heading: key, photos: map[key] }));
}

// Single function that owns the gallery template contract.
// Every branch calls this so the template's expected keys live in one place.
function renderGallery(
  res,
  { view, groups = [], photos = [], page = 1, totalPages = 1, total = 0, taskFilter = null }
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
    // --- Grouped views: no pagination; load all visible photos. ---
    const { sql, args } = galleryQuery('all', taskFilter);
    const photos = db.prepare(sql).all(...args);

    const groups =
      view === 'task'
        ? groupPhotos(photos, (p) => p.task_title)
        : groupPhotos(photos, (p) => p.guest_name || 'Guest');

    return renderGallery(res, { view, groups, total: photos.length, taskFilter });
  }

  // --- recent view: flat, paginated, newest-first. ---
  const { sql: countSql, args: countArgs } = galleryQuery('count', taskFilter);
  const totalRow = db.prepare(countSql).get(...countArgs);
  const total = totalRow ? totalRow.n : 0;

  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }
  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
  }
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  const { sql: pageSql, args: pageArgs } = galleryQuery(
    'page',
    taskFilter,
    GALLERY_PAGE_SIZE,
    offset
  );
  const photos = db.prepare(pageSql).all(...pageArgs);

  return renderGallery(res, { view, photos, page, totalPages, total, taskFilter });
});

// ---------------------------------------------------------------------------
// GET /p/:submissionId  — full-resolution photo detail view
//
// Shows the original-resolution image, caption, task title, and uploader link.
// Prev (newer) and next (older) links follow the same created_at DESC, id DESC
// total order as the gallery. Taken-down and nonexistent ids → 404.
// ---------------------------------------------------------------------------

// SELECT body for the photo detail query — reuses GALLERY_SELECT_BODY columns.
const PHOTO_DETAIL_SELECT = `
  SELECT s.id            AS submission_id,
         s.photo_path    AS photo_path,
         s.thumb_path    AS thumb_path,
         s.caption       AS caption,
         s.created_at    AS created_at,
         g.id            AS guest_id,
         g.name          AS guest_name,
         t.id            AS task_id,
         t.title         AS task_title
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
    JOIN tasks  t ON t.id = s.task_id
   WHERE s.id = ? AND s.taken_down = 0`;

/**
 * Find the next-older visible submission (the "next" link in a newest-first list).
 * Returns the row or undefined when the current photo is already the oldest.
 */
function findOlderNeighbor(createdAt, id) {
  return db
    .prepare(
      `SELECT s.id AS submission_id
         FROM submissions s
        WHERE s.taken_down = 0
          AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1`
    )
    .get(createdAt, createdAt, id);
}

/**
 * Find the next-newer visible submission (the "previous" link in a newest-first list).
 * Returns the row or undefined when the current photo is already the newest.
 */
function findNewerNeighbor(createdAt, id) {
  return db
    .prepare(
      `SELECT s.id AS submission_id
         FROM submissions s
        WHERE s.taken_down = 0
          AND (s.created_at > ? OR (s.created_at = ? AND s.id > ?))
        ORDER BY s.created_at ASC, s.id ASC
        LIMIT 1`
    )
    .get(createdAt, createdAt, id);
}

router.get('/p/:submissionId', (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = db.prepare(PHOTO_DETAIL_SELECT).get(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const next = findOlderNeighbor(photo.created_at, photo.submission_id);
  const prev = findNewerNeighbor(photo.created_at, photo.submission_id);

  return res.render('photo', {
    title: photo.task_title,
    pageScript: 'photo.js',
    photo,
    next: next || null,
    prev: prev || null,
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
  const photos = db
    .prepare(
      `SELECT s.id         AS submission_id,
              s.thumb_path AS thumb_path,
              s.photo_path AS photo_path,
              s.caption    AS caption,
              s.created_at AS created_at,
              t.title      AS task_title
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
        WHERE s.guest_id = ? AND s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(guestId);

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
