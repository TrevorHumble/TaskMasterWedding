// src/routes/community.js
'use strict';

const express = require('express');
const { db } = require('../db');
const { attachGuest } = require('../middleware/session');
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
    // --- Grouped views: no pagination; all visible photos. ---
    const groups = feed.grouped(view, taskFilter);
    const total = groups.reduce((sum, g) => sum + g.photos.length, 0);
    return renderGallery(res, { view, groups, total, taskFilter });
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
  const photos = feed.allVisible();
  return res.render('feed', { title: 'Feed', photos });
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
