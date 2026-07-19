// src/routes/community.js
'use strict';

const express = require('express');
const config = require('../../config');
const { db } = require('../db');
const { requireGuest } = require('../middleware/session');
const scoring = require('../services/scoring');
const feed = require('../services/feed');
const photos = require('../services/photos');
const submissions = require('../services/submissions');
// Route-level rate limiting (issue #283). DISTINCT from
// src/services/rate-limit.js (owns POST /memories and the HEIC-decode
// throttle elsewhere) — see src/middleware/rate-limit.js's file comment for
// the boundary. Guest-keyed (falls back to an IP bucket for the signed-out
// case, which requireGuest below would redirect to /join anyway before
// either handler body runs). One SHARED instance across POST /p/:id/like and POST
// /p/:id/comments — a guest reacting AND commenting draws from the same
// budget, config.RATE_LIMIT_SOCIAL_MAX. This is a SEPARATE instance from
// src/routes/guest.js's POST /bug-report limiter, even though both read the
// same config value. guestOrIpKey is the single owner of the "guest-keyed,
// IP fallback when signed out" rule, shared with guest.js.
const { createRateLimiter, guestOrIpKey } = require('../middleware/rate-limit');

const router = express.Router();

const socialRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.RATE_LIMIT_SOCIAL_MAX,
  keyFn: guestOrIpKey,
});

// Community pages are guest-gated by this router's own path-scoped
// requireGuest below (issue #466), not by src/app.js's mount order. Both
// `req.guest` (what requireGuest reads) and `res.locals.guest` (what the
// views render from — feed.ejs dereferences guest.id and guest.avatar_path
// unguarded, and res.render('feed', ...) passes no `guest` key of its own)
// are supplied by the global app.use(attachGuest) mount in src/app.js
// (src/middleware/session.js), which runs on every request before this router
// is reached. Neither is redundant: pruning res.locals.guest 500s /feed.
// The guard list below is this router's complete set of route prefixes: any
// NEW route prefix added to this file must be added to it too, or that route
// ships ungated.
router.use(['/gallery', '/feed', '/leaderboard', '/p', '/badge', '/u', '/slideshow'], requireGuest);

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
 * The badges a guest currently holds, in this route's own display order
 * (award created_at ascending, badge id as the tiebreak — the order the
 * leaderboard badge strip and public profile have used since before issue
 * #487). The guest_badges/badges join itself has exactly one owner,
 * src/services/scoring.js's getGuestBadges (design-philosophy review of
 * #487) — this is a thin re-sort over that shared result, not a second copy
 * of the query.
 */
function loadGuestBadges(guestId) {
  return scoring.getGuestBadges(guestId).sort((a, b) => {
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.badge_id - b.badge_id;
  });
}

/**
 * Attach a `viewer_liked` boolean to each photo in place, in one grouped
 * query rather than one query per photo — has THIS signed-in guest liked it?
 * The feed view renders the like button's pressed state from it (solid heart
 * = already liked), and the progressive-enhancement client keeps it current
 * after a fetch toggle. An anonymous viewer (guestId null) gets false
 * everywhere without touching the DB. Loaded only for the submission ids the
 * feed already handed us — visibility stays owned by feed.js.
 */
function attachViewerLikes(photos, guestId) {
  if (photos.length === 0) {
    return photos;
  }
  // Unreachable via the live HTTP app: this router's own requireGuest gate
  // (see the router.use(...) call near the top of this file) means guestId
  // is always set by the time a handler calls this function. Retained
  // defensively, per #466.
  if (!guestId) {
    for (const p of photos) {
      p.viewer_liked = false;
    }
    return photos;
  }
  const placeholders = photos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT submission_id AS submission_id
         FROM likes
        WHERE guest_id = ? AND submission_id IN (${placeholders})`
    )
    .all(guestId, ...photos.map((p) => p.submission_id));

  const likedIds = new Set(rows.map((r) => r.submission_id));
  for (const p of photos) {
    p.viewer_liked = likedIds.has(p.submission_id);
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

// The ONE statement of "a comment is visible" — mirrors feed.js's VISIBLE_WHERE
// for submissions. A comment is visible when its own moderation flag is clear;
// this is a separate flag from the submission-level taken_down that
// feed.feedWindow() owns. Every query that must agree with the rendered thread
// (attachComments below, and the badge/See-all count in the comments POST
// route) composes this constant, so the rule appears exactly once — if comment
// moderation ever grows a second condition, the count and the list cannot
// drift apart. The `c.` alias qualifier matches attachComments' JOIN alias and
// is harmless in the unaliased count query (SQLite resolves it to the one
// comments table).
const COMMENT_VISIBLE_WHERE = 'c.taken_down = 0';

/**
 * Attach a `comments` array to each photo in place, in one grouped query
 * rather than one query per photo. Loaded only for the submission ids the
 * feed already handed us — those rows are already visible because they came
 * from feed.feedWindow(), which owns the taken_down = 0 rule on submissions.
 * This function never re-types that submission rule; it composes
 * COMMENT_VISIBLE_WHERE for the separate comment-level moderation flag.
 * Oldest-first within each photo, joined to the commenter's name.
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
          AND ${COMMENT_VISIBLE_WHERE}
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
 * How many visible comments a submission has — the count the feed's badge and
 * the "See all <N> comments" line render. Composes COMMENT_VISIBLE_WHERE so it
 * can never disagree with the thread attachComments builds from the same rule.
 * @param {number} submissionId
 * @returns {number}
 */
function visibleCommentCount(submissionId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments c WHERE c.submission_id = ? AND ${COMMENT_VISIBLE_WHERE}`
    )
    .get(submissionId).n;
}

/**
 * Attach a `points` field (base + photo_bonus) to each photo in place, in
 * one grouped query rather than one query per photo — mirrors
 * attachViewerLikes/attachComments above. Loaded only for the submission ids
 * the feed already handed us — those rows are already visible because they
 * came from feed.feedWindow(), which owns the taken_down = 0 rule. This
 * function never re-types that visibility rule; it only reads photo_bonus for
 * ids already known to be visible. The per-photo point value comes from
 * scoring.photoPoints (the single authority for the base), so the "1" base is
 * never a literal here. A MEMORY (issue #247, task_id IS NULL) earns no
 * automatic base point — only its admin bonus — so its task_id is read here
 * and passed as scoring.photoPoints's hasTask flag, keeping the feed
 * per-photo display consistent with the aggregate getPoints/leaderboard rule
 * that already withholds a memory's base point. A photo with no row found
 * (should not happen given the id came from feed.feedWindow()) zero-fills its
 * bonus to 0 and is treated as a task photo, so the view never has to branch
 * on a missing field.
 */
function attachPhotoPoints(photos) {
  if (photos.length === 0) {
    return photos;
  }
  const placeholders = photos.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id AS submission_id, photo_bonus AS photo_bonus, task_id AS task_id
         FROM submissions
        WHERE id IN (${placeholders})`
    )
    .all(...photos.map((p) => p.submission_id));

  const rowById = new Map(rows.map((r) => [r.submission_id, r]));
  for (const p of photos) {
    const row = rowById.get(p.submission_id);
    const bonus = row ? row.photo_bonus : 0;
    // hasTask false for a memory (task_id IS NULL) so photoPoints omits the base.
    const hasTask = row ? row.task_id !== null : true;
    p.points = scoring.photoPoints(bonus, hasTask);
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
    // --- Grouped views: capped 6-tile previews per group (issue #251). ---
    // ?q= is an optional search term (blank/absent = no filter), trimmed here
    // so feed.grouped() never has to distinguish "absent" from "whitespace".
    // The header count sums each group's TRUE total, not the capped preview
    // arrays — 25 photos in a task is 25 photos, even though 6 tiles show.
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const groups = feed.grouped(view, taskFilter, q);
    const total = groups.reduce((sum, g) => sum + g.total, 0);
    return renderGallery(res, { view, groups, total, taskFilter, q });
  }

  // --- recent view: flat, paginated, newest-first. ---
  const requestedPage = parseInt(req.query.page, 10);
  const { photos, page, totalPages, total } = feed.recentPage(taskFilter, requestedPage);

  return renderGallery(res, { view, photos, page, totalPages, total, taskFilter });
});

// ---------------------------------------------------------------------------
// GET /feed  — full-screen vertical scroll, one bounded window at a time.
//
// The gallery grid's thumbnails link here as /feed?from=<id>#photo-<id>:
// feed.feedWindow(from) returns a page that STARTS at that photo (issue #194
// — anchor resolution is server-side, so the fragment always has an element
// to land on even though the page is bounded), and the browser's native
// fragment anchoring scrolls to it on load (no JS). A missing or stale ?from
// falls back to the newest page. like_count arrives on each row from the
// feed query itself; comments, per-photo points, and the viewer's own liked
// state are attached per-window here.
// ---------------------------------------------------------------------------
router.get('/feed', (req, res) => {
  const fromParam = parseInt(req.query.from, 10);
  const fromId = Number.isInteger(fromParam) && fromParam >= 1 ? fromParam : null;

  const window = feed.feedWindow(fromId);
  const photos = attachViewerLikes(
    attachComments(attachPhotoPoints(window.photos)),
    req.guest ? req.guest.id : null
  );

  // hasNewer with a null newerFromId means "the newer page is the first
  // page" — fewer than a full window of newer photos exist, so /feed (no
  // anchor) shows them all without a gap.
  const olderHref = window.olderFromId !== null ? '/feed?from=' + window.olderFromId : null;
  const newerHref = window.hasNewer
    ? window.newerFromId !== null
      ? '/feed?from=' + window.newerFromId
      : '/feed'
    : null;

  return res.render('feed', {
    title: 'Feed',
    pageScript: 'feed.js',
    photos,
    commentMaxLength: COMMENT_MAX_LENGTH,
    captionMaxLength: submissions.CAPTION_MAX_LENGTH,
    olderHref,
    newerHref,
  });
});

// ---------------------------------------------------------------------------
// GET /slideshow  — end-of-night full-screen slideshow (issue #468).
//
// feed.slideshowSequence() owns the Most-Liked-opener + per-task sectioning,
// ranking, and winner selection entirely; this route's only decision is Auto
// vs Directed. mode is whitelisted here (not left to the view or the client
// script) so a garbage ?mode= value degrades to Auto rather than the client
// having to also defend against an arbitrary string.
// ---------------------------------------------------------------------------
router.get('/slideshow', (req, res) => {
  const mode = req.query.mode === 'directed' ? 'directed' : 'auto';
  const sequence = feed.slideshowSequence();
  return res.render('slideshow', { title: 'Slideshow — Lilly & Axel', sequence, mode });
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/like  — toggle the signed-in guest's like on a photo.
//
// Guest-only (requireGuest redirects an anonymous request to /join before
// this handler runs, so no likes row is ever created for AC4). One like per
// guest per photo is the schema's job (UNIQUE (submission_id, guest_id)) —
// this handler just decides which half of the toggle to run: a row already
// exists → remove it; otherwise add it. A taken-down or missing submission
// 404s, mirroring the GET /p/:submissionId handler below.
//
// Two response shapes (issue #194 AC3): the plain form POST redirects back to
// the bounded feed page CONTAINING this photo (/feed?from=<id>#photo-<id>),
// and a fetch() from src/public/js/feed.js — which sends Accept:
// application/json — gets { liked, likeCount } so the page updates in place
// without re-downloading the feed. The form path is the no-JS fallback; both
// run the identical toggle.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/like', requireGuest, socialRateLimiter, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  let liked;
  if (hasLiked(submissionId, req.guest.id)) {
    db.prepare(`DELETE FROM likes WHERE submission_id = ? AND guest_id = ?`).run(
      submissionId,
      req.guest.id
    );
    liked = false;
  } else {
    db.prepare(`INSERT OR IGNORE INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      req.guest.id
    );
    liked = true;
  }

  // A like/unlike can move the MOSTLIKED holder set (issue #484), so
  // recompute the transferable badges here — once, after the toggle mutation
  // and before either response branch below — the same "recompute right
  // after the data that feeds it changes" rule submissions.js/photos.js
  // follow via recomputeAfterSubmissionChange.
  scoring.recomputeTransferableBadges();

  if (req.accepts(['html', 'json']) === 'json') {
    const likeCount = db
      .prepare(`SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?`)
      .get(submissionId).n;
    return res.json({ liked, likeCount });
  }

  return res.redirect('/feed?from=' + submissionId + '#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/comments  — a signed-in guest leaves a comment.
//
// Guest-only (requireGuest redirects an anonymous request to /join before
// this handler runs, so no comments row is ever created for AC8). A
// taken-down or missing submission 404s, mirroring the like route above. The
// body is trimmed and rejected (no insert) if empty or over
// COMMENT_MAX_LENGTH — for a plain form post that rejection is silent
// (redirect, no row), matching the issue's server-side-cap AC4; there is no
// separate error page because "your comment didn't post" needs no more
// ceremony than the redirect back to the same photo.
//
// Two response shapes (#248 amendment AC8, mirroring the like route): the
// plain form POST redirects back to the bounded feed page CONTAINING this
// photo, and a fetch() from the comments dialog — which sends Accept:
// application/json — gets { comment, commentCount } so the client appends
// the new comment in place without re-downloading the feed. The form path
// is the no-JS fallback; both run the identical insert. On the JSON path an
// invalid body answers 400 JSON (a fetch cannot see a "silent" redirect).
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/comments', requireGuest, socialRateLimiter, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const jsonWanted = req.accepts(['html', 'json']) === 'json';

  const body = (req.body.body || '').trim();
  if (body.length === 0 || body.length > COMMENT_MAX_LENGTH) {
    if (jsonWanted) {
      return res.status(400).json({ error: `Comment must be 1-${COMMENT_MAX_LENGTH} characters.` });
    }
    return res.redirect('/feed?from=' + submissionId + '#photo-' + submissionId);
  }

  const info = db
    .prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`)
    .run(submissionId, req.guest.id, body);

  if (jsonWanted) {
    // Count only what the feed itself renders — visibleCommentCount composes
    // the same COMMENT_VISIBLE_WHERE rule attachComments builds the thread
    // from, so the badge/see-all numbers the client writes from this response
    // always match the next full page load.
    const commentCount = visibleCommentCount(submissionId);
    return res.json({
      comment: {
        id: info.lastInsertRowid,
        body,
        guest_id: req.guest.id,
        guest_name: req.guest.name,
      },
      commentCount,
    });
  }

  return res.redirect('/feed?from=' + submissionId + '#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/comments/:commentId/delete  — a guest deletes their
// own comment (issue #338).
//
// Guest-only (requireGuest redirects an anonymous request to /join before
// this handler runs). A taken-down or missing submission 404s, mirroring the
// routes above. An unknown commentId, or one that does not belong to this
// submission (covers "already deleted" too — a second delete attempt finds no
// row the second time), also 404s. Authorization is absolute and server-side:
// a comment whose guest_id is not the caller's is refused with 403 and the
// row is left untouched — the Delete control never renders for another
// guest's comment (src/views/feed.ejs), but this check is what actually stops
// a forged request, not the hidden control.
//
// This is a HARD delete (issue design: "no edited/removed tombstone, the row
// is gone") — unlike admin moderation's taken_down flag (owned by
// src/routes/admin.js), which hides without removing. The two never overlap:
// a guest can delete their own row in any moderation state; only the row's
// existence and its guest_id are checked here.
//
// Two response shapes, mirroring the like/comments routes above: the plain
// form POST (no-JS fallback) redirects back to the bounded feed page
// CONTAINING this photo, and a fetch() from src/public/js/feed.js — which
// sends Accept: application/json — gets { deleted, commentCount } so the
// client removes the row and updates the badge/See-all line in place.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/comments/:commentId/delete', requireGuest, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  const commentId = parseInt(req.params.commentId, 10);
  if (
    !Number.isInteger(submissionId) ||
    submissionId < 1 ||
    !Number.isInteger(commentId) ||
    commentId < 1
  ) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const photo = feed.detail(submissionId);
  if (!photo) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const comment = db
    .prepare(`SELECT id, guest_id FROM comments WHERE id = ? AND submission_id = ?`)
    .get(commentId, submissionId);
  if (!comment) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const jsonWanted = req.accepts(['html', 'json']) === 'json';

  if (comment.guest_id !== req.guest.id) {
    if (jsonWanted) {
      return res.status(403).json({ error: 'You can only delete your own comments.' });
    }
    return res.status(403).render('partials/message-card', {
      title: "That's not your comment",
      heading: 'Not Your Comment',
      paragraphs: ['You can only delete comments you posted yourself.'],
      links: [
        { href: '/feed?from=' + submissionId + '#photo-' + submissionId, text: 'Back to the feed' },
      ],
    });
  }

  db.prepare(`DELETE FROM comments WHERE id = ? AND guest_id = ?`).run(commentId, req.guest.id);

  if (jsonWanted) {
    // Same COMMENT_VISIBLE_WHERE-composed count the badge/See-all line render
    // elsewhere — see visibleCommentCount's own comment for why that matters.
    const commentCount = visibleCommentCount(submissionId);
    return res.json({ deleted: true, commentCount });
  }

  return res.redirect('/feed?from=' + submissionId + '#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/caption  — a guest edits the caption on their OWN
// photo (issue #387).
//
// Guest-only (requireGuest redirects an anonymous request to /join before
// this handler runs). Ownership is read from a direct SELECT rather than
// feed.detail() — feed.detail() 404s a taken-down row and does not expose
// guest_id, but a guest must still be able to fix the caption on a photo a
// host (or the guest's own Delete) has taken down, and the row's existence
// is a separate question from its visibility. An unknown/non-integer id, or
// one with no matching row, 404s. A row that exists but belongs to another
// guest 403s with NO write — the ⋯ menu never renders for a non-owner
// (src/views/partials/photo-owner-menu.ejs), but that hidden control is not
// what stops a forged request; this check is. The stored value always runs
// through submissions.normalizeCaption — the same trim().slice(0,500) rule
// the upload path applies — so an edit can never exceed the column's cap.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/caption', requireGuest, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const row = db
    .prepare('SELECT id, guest_id, caption FROM submissions WHERE id = ?')
    .get(submissionId);
  if (!row) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  if (row.guest_id !== req.guest.id) {
    return res.status(403).render('partials/message-card', {
      title: "That's not your photo",
      heading: 'Not Your Photo',
      paragraphs: ['You can only edit the caption on photos you posted yourself.'],
      links: [
        { href: '/feed?from=' + submissionId + '#photo-' + submissionId, text: 'Back to the feed' },
      ],
    });
  }

  db.prepare('UPDATE submissions SET caption = ? WHERE id = ?').run(
    submissions.normalizeCaption(req.body.caption),
    submissionId
  );

  return res.redirect('/feed?from=' + submissionId + '#photo-' + submissionId);
});

// ---------------------------------------------------------------------------
// POST /p/:submissionId/delete  — a guest takes down their OWN photo
// (issue #387).
//
// Guest-only, same id-guard and ownership check as the caption route above
// (direct SELECT, not feed.detail() — a guest must be able to take down a
// photo regardless of its current visibility). "Delete" here means take
// down, not destroy: photos.hideSubmission is this codebase's single writer
// of taken_down for moderation (flips the flag AND recomputes the owning
// guest's auto-badges in one transaction — see src/services/photos.js), the
// same seam the admin takedown path uses. The file stays on disk for the
// couple's export and a host can still restore it (Goal D, Goal C) — a
// guest cannot unilaterally erase the couple's record, only hide their own
// contribution from the feed/gallery/scoring.
// ---------------------------------------------------------------------------
router.post('/p/:submissionId/delete', requireGuest, (req, res) => {
  const submissionId = parseInt(req.params.submissionId, 10);
  if (!Number.isInteger(submissionId) || submissionId < 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const row = db.prepare('SELECT id, guest_id FROM submissions WHERE id = ?').get(submissionId);
  if (!row) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  if (row.guest_id !== req.guest.id) {
    return res.status(403).render('partials/message-card', {
      title: "That's not your photo",
      heading: 'Not Your Photo',
      paragraphs: ['You can only take down photos you posted yourself.'],
      links: [
        { href: '/feed?from=' + submissionId + '#photo-' + submissionId, text: 'Back to the feed' },
      ],
    });
  }

  photos.hideSubmission(submissionId);

  return res.redirect('/feed');
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

  // neighbors() re-derives visibility from the id rather than trusting
  // `photo` above — the pivot can be taken down in the gap between the
  // detail() call and this one, so `found` must still be checked here.
  const result = feed.neighbors(submissionId);

  // The template expects next/prev as { submission_id } (or null), truthy-checked.
  // prev = newer (earlier in the newest-first order); next = older.
  return res.render('photo', {
    title: photo.task_title,
    pageScript: 'photo.js',
    photo,
    captionMaxLength: submissions.CAPTION_MAX_LENGTH,
    next: result.found && result.older !== null ? { submission_id: result.older } : null,
    prev: result.found && result.newer !== null ? { submission_id: result.newer } : null,
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

  // Compute rank ONCE here (rows arrive ordered best-first from scoring), so
  // the podium and the list agree. Standard-competition ("1224") ranking: a
  // guest's rank is 1 + the number of guests with strictly MORE points, which
  // makes tied guests share a rank and skips the numbers after a tie
  // (points [5,4,3,3,3,3,1] -> ranks 1,2,3,3,3,3,7). Because rows are already
  // sorted by points DESC, the first index at which a given points value
  // appears is exactly that "count of guests with strictly more points", i.e.
  // the shared rank for the whole tie group.
  let lastPoints = null;
  let lastRank = 0;
  const ranked = rows.map((row, index) => {
    let rank;
    if (lastPoints === null || row.points !== lastPoints) {
      rank = index + 1; // first row of a new points value: 1 + (rows above it)
      lastRank = rank;
      lastPoints = row.points;
    } else {
      rank = lastRank; // same points as the row above: share its rank
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

  // A row is tied when it shares its rank with an adjacent row. Mark each row
  // and give it the display label the view renders verbatim: `T{rank}` when
  // tied, else `{rank}`. Done in a second pass so a row can see BOTH neighbors.
  ranked.forEach((row, index) => {
    const prev = ranked[index - 1];
    const next = ranked[index + 1];
    row.isTied = Boolean((prev && prev.rank === row.rank) || (next && next.rank === row.rank));
    row.rankLabel = row.isTied ? `T${row.rank}` : `${row.rank}`;
  });

  // Low-spread guard (authoritative comment). distinctRankCount is how many
  // distinct ranks exist across the whole field. When it is 1, every guest is
  // tied on points, so the podium conveys nothing — showPodium (below) is false
  // and the view renders a friendly "everyone's tied" banner instead (AC4).
  const distinctRankCount = new Set(ranked.map((r) => r.rank)).size;

  // Build the podium's group structure HERE so "what is a tie" lives in exactly
  // one layer (this route), not re-derived in the view. Group the ranked rows
  // by their shared rank, keep only ranks 1-3, and return them in podium
  // display order (2nd, 1st, 3rd — 1st centered/tallest). A tied group renders
  // EVERY tied guest (issue #249): the view shows up to 3 overlapping avatars
  // plus a "+N" chip, and a names line built here. The view renders this
  // structure verbatim and never re-buckets or re-tests tie membership.
  const groupsByRank = new Map();
  for (const row of ranked) {
    // rows are sorted by rank ascending, so once rank > 3 no rank <= 3 can
    // follow — safe to stop.
    if (row.rank > 3) break;
    if (!groupsByRank.has(row.rank)) {
      groupsByRank.set(row.rank, {
        rank: row.rank,
        rankLabel: row.rankLabel,
        members: [],
      });
    }
    groupsByRank.get(row.rank).members.push(row);
  }
  const ORDINALS = { 1: '1st', 2: '2nd', 3: '3rd' };
  for (const group of groupsByRank.values()) {
    const members = group.members;
    group.ordinal = ORDINALS[group.rank];
    group.points = members[0].points;
    group.isTie = members.length > 1;
    // Bar label rendered on every plinth, tied or not: "2nd · 12 pts".
    group.barLabel = `${group.ordinal} · ${group.points} pt${group.points === 1 ? '' : 's'}`;
    // Sub-line under a tied group's names: "2nd place · 12 pts each".
    group.subLine = `${group.ordinal} place · ${group.points} pt${group.points === 1 ? '' : 's'} each`;
    // Names line for tied groups joins first names naturally — "Liam, Priya
    // and Noah" for up to 3 members; "Liam, Priya and 3 more" for 4+ (matching
    // the 3-avatar cap). The view renders each name as a /u/<id> link, so the
    // route hands it structure (named members + a tail), not a flat string.
    members.forEach((m) => {
      m.firstName = (m.name || 'Guest').trim().split(/\s+/)[0];
    });
    if (members.length <= 3) {
      group.namedMembers = members;
      group.namesTail = null; // every member is named, no "and N more"
    } else {
      group.namedMembers = members.slice(0, 2);
      group.namesTail = `and ${members.length - 2} more`;
    }
    group.shownMembers = members.slice(0, 3);
    group.extraCount = members.length - group.shownMembers.length;
  }
  // Podium display order: 2nd, 1st, 3rd. Skip ranks with no members.
  const podiumGroups = [groupsByRank.get(2), groupsByRank.get(1), groupsByRank.get(3)].filter(
    Boolean
  );

  // See the low-spread guard comment at distinctRankCount above.
  const showPodium = distinctRankCount > 1;

  res.render('leaderboard', {
    title: 'Leaderboard',
    rows: ranked,
    podiumGroups,
    showPodium,
    badgeCap: config.LEADERBOARD_BADGE_CAP,
  });
});

// ---------------------------------------------------------------------------
// GET /badge/:code  — what one badge is for, and who has it (issue #488)
//
// Guest-gated: this router's own path-scoped router.use(requireGuest) above
// redirects any request without a guest session to /join before this handler
// runs — so an anonymous visitor never reaches this handler, exactly like GET
// /u/:id. AC5's 404 is therefore observed by a signed-in guest. Unknown code
// -> 404 (AC5).
//
// scoring.badgeWithHolders(code) already carries every field either rendered
// shape needs; the ONE thing this route decides — and the ONLY place it is
// decided — is which of the two shapes this badge gets. The discriminant is
// task_id, NOT type: a task's own badge (default ribbon or customized) is the
// only kind that carries per-award points/note/photo, and it is exactly the
// set with task_id set (src/services/task-badges.js). type='custom' is NOT a
// safe proxy — POST /admin/badges (src/routes/admin.js) mints host-defined
// custom badges with type='custom' and task_id NULL, which must render the
// plain holder list, not empty award rows. The view never re-derives this.
// ---------------------------------------------------------------------------
router.get('/badge/:code', (req, res) => {
  const result = scoring.badgeWithHolders(req.params.code);
  if (!result) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  return res.render('badge-detail', {
    title: result.badge.name,
    badge: result.badge,
    holders: result.holders,
    isTaskMaster: result.badge.task_id != null,
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
