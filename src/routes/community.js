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
// GET /gallery  — the shared photo wall (all visible submissions, newest first)
// ---------------------------------------------------------------------------
router.get('/gallery', (req, res) => {
  // Total number of visible photos, used to compute pagination.
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0`).get();
  const total = totalRow ? totalRow.n : 0;

  // Current page (1-based). Defaults to 1 if missing or invalid.
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) {
    page = 1;
  }
  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
  }
  const offset = (page - 1) * GALLERY_PAGE_SIZE;

  // One row per visible submission, joined to its uploader and task title.
  const photos = db
    .prepare(
      `SELECT s.id            AS submission_id,
              s.thumb_path    AS thumb_path,
              s.photo_path    AS photo_path,
              s.caption       AS caption,
              s.created_at    AS created_at,
              g.id            AS guest_id,
              g.name          AS guest_name,
              t.title         AS task_title
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         JOIN tasks  t ON t.id = s.task_id
        WHERE s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(GALLERY_PAGE_SIZE, offset);

  res.render('gallery', {
    title: 'Gallery',
    photos,
    page,
    totalPages,
    total,
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
