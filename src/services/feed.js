// src/services/feed.js
//
// The "visible submissions feed" — the single place that knows which
// submissions are visible and in what order.
//
// Every community-facing view (gallery, feed, photo detail, public profile)
// needs the same rules: a submission is visible only when taken_down = 0, and
// visible submissions sort newest-first (created_at DESC, id DESC, the id
// tiebreak so same-second inserts still sort deterministically) — except the
// newer-neighbor keyset lookups, which walk the same order backwards
// (created_at ASC, id ASC) to find the nearest strictly-newer rows. Before
// this module, these rules were hand-typed at five call sites in
// src/routes/community.js. Here the one visibility predicate (VISIBLE_WHERE)
// and the two ordering clauses (ORDER_NEWEST_FIRST for the forward
// gallery/guest/older queries, and its ascending mirror ORDER_OLDEST_FIRST
// for the newer-side lookups) each live in exactly one constant, and every
// operation below composes them, so a route can ask a plain question ("give
// me guest 12's photos") without knowing the visibility/ordering rule exists.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const { db } = require('../db');

// How many gallery thumbnails to load per "page" (used for pagination links).
// Moved here from community.js — the feed owns pagination sizing because it
// owns the query that pagination slices.
const GALLERY_PAGE_SIZE = 60;

// How many photos one /feed page holds (issue #194). The feed used to render
// every visible submission unpaginated; feedWindow() below slices it into
// keyset windows of this size so the page's byte weight stays bounded as the
// weekend's photo count grows.
const FEED_PAGE_SIZE = 40;

// How many preview tiles a grouped gallery section shows (issue #251): up to
// two rows of three. When a group holds more, the view renders a "+N" overlay
// on the last tile; grouped() hands it `total` so it can do that math.
const GROUP_PREVIEW_SIZE = 6;

// ---------------------------------------------------------------------------
// The ONE visibility predicate and the ONE ordering clause (plus its mirror).
// Every operation in this file composes these constants — none is ever
// re-typed. ORDER_NEWEST_TERMS exists separately because window functions
// (grouped) need the bare terms inside an OVER (...) clause, where the
// ORDER BY keyword is already supplied by the OVER syntax position.
// ---------------------------------------------------------------------------
const VISIBLE_WHERE = 's.taken_down = 0';
const ORDER_NEWEST_TERMS = 's.created_at DESC, s.id DESC';
const ORDER_NEWEST_FIRST = `ORDER BY ${ORDER_NEWEST_TERMS}`;
// The reversed ordering, used only by the newer-side keyset lookups: they
// walk forward from a pivot to find the nearest strictly-newer submissions,
// so they need ascending order (closest match first) rather than the newest-
// first order the rest of this file uses.
const ORDER_OLDEST_FIRST = 'ORDER BY s.created_at ASC, s.id ASC';

// The one shared submission column list and FROM/JOIN block, used by the
// gallery queries (recentPage, grouped), the feed window, and the detail
// query below. Consumers read every column by alias name (never by
// position), so the column order here is not a contract. like_count rides
// along as a correlated subquery (idx_likes_submission makes it an index
// lookup) so every surface that renders a tile or a feed item gets the count
// without a second round trip.
const GALLERY_COLUMNS = `
         s.id            AS submission_id,
         s.thumb_path    AS thumb_path,
         s.photo_path    AS photo_path,
         s.caption       AS caption,
         s.created_at    AS created_at,
         g.id            AS guest_id,
         g.name          AS guest_name,
         g.avatar_path   AS guest_avatar_path,
         g.pinned        AS guest_pinned,
         t.id            AS task_id,
         t.title         AS task_title,
         (SELECT COUNT(*) FROM likes l WHERE l.submission_id = s.id) AS like_count`;

const GALLERY_FROM = `
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
    JOIN tasks  t ON t.id = s.task_id`;

const GALLERY_SELECT_BODY = `
  SELECT ${GALLERY_COLUMNS}${GALLERY_FROM}`;

/**
 * Build a fully-assembled, parameterized gallery query.
 *
 * shape        'count' | 'page' — the shape of the query to build.
 * taskFilter   positive integer to restrict to one task, or null for all tasks.
 * limit/offset only used when shape === 'page'.
 *
 * Returns { sql, args } ready for db.prepare(sql).get(...args) or .all(...args).
 */
function galleryQuery(shape, taskFilter, limit, offset) {
  const where = [VISIBLE_WHERE];
  const args = [];
  if (taskFilter !== null) {
    where.push('s.task_id = ?');
    args.push(taskFilter);
  }
  const whereSql = ' WHERE ' + where.join(' AND ');

  if (shape === 'count') {
    return { sql: `SELECT COUNT(*) AS n FROM submissions s${whereSql}`, args };
  }

  let sql = GALLERY_SELECT_BODY + whereSql + ' ' + ORDER_NEWEST_FIRST;
  if (shape === 'page') {
    sql += ' LIMIT ? OFFSET ?';
    args.push(limit, offset);
  }
  return { sql, args };
}

/**
 * A page of the flat, newest-first recent view.
 *
 * @param {number|null} taskFilter - positive integer to restrict to one task, or null for all.
 * @param {number} page - 1-based page number, straight from the caller (may be
 *        NaN, negative, zero, or a float). This function does its own
 *        floor-and-clamp: anything that is not a positive integer floors to
 *        1, and anything above the last page clamps down to it — the same
 *        behavior the route always had, now owned by feed instead of the route.
 * @returns {{ photos: object[], page: number, totalPages: number, total: number }}
 */
function recentPage(taskFilter, page) {
  const { sql: countSql, args: countArgs } = galleryQuery('count', taskFilter);
  const totalRow = db.prepare(countSql).get(...countArgs);
  const total = totalRow ? totalRow.n : 0;

  const totalPages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  let clampedPage = page;
  if (!Number.isInteger(clampedPage) || clampedPage < 1) {
    clampedPage = 1;
  }
  if (clampedPage > totalPages) {
    clampedPage = totalPages;
  }
  const offset = (clampedPage - 1) * GALLERY_PAGE_SIZE;

  const { sql: pageSql, args: pageArgs } = galleryQuery(
    'page',
    taskFilter,
    GALLERY_PAGE_SIZE,
    offset
  );
  const photos = db.prepare(pageSql).all(...pageArgs);

  return { photos, page: clampedPage, totalPages, total };
}

// One /feed window: the anchor row (inclusive) and everything older, capped.
// The +1 in the LIMIT is how olderFromId is discovered — the extra row, when
// present, is exactly the next-older page's anchor.
const stmtFeedWindowFromAnchor = db.prepare(`${GALLERY_SELECT_BODY}
   WHERE ${VISIBLE_WHERE}
     AND (s.created_at < ? OR (s.created_at = ? AND s.id <= ?))
   ${ORDER_NEWEST_FIRST}
   LIMIT ${FEED_PAGE_SIZE + 1}`);

const stmtFeedWindowFirstPage = db.prepare(`${GALLERY_SELECT_BODY}
   WHERE ${VISIBLE_WHERE}
   ${ORDER_NEWEST_FIRST}
   LIMIT ${FEED_PAGE_SIZE + 1}`);

// Up to FEED_PAGE_SIZE ids strictly newer than the window's first photo,
// walked ascending (nearest first). Used to find the next-newer page's
// anchor: when a full FEED_PAGE_SIZE of newer rows exists, the farthest of
// them starts a page that ends exactly where this window begins; when fewer
// exist, the newer page is simply the first page (/feed with no anchor).
const stmtFeedNewerIds = db.prepare(`
  SELECT s.id AS submission_id
    FROM submissions s
   WHERE ${VISIBLE_WHERE}
     AND (s.created_at > ? OR (s.created_at = ? AND s.id > ?))
   ${ORDER_OLDEST_FIRST}
   LIMIT ${FEED_PAGE_SIZE}`);

/**
 * One bounded page of the full-screen feed (issue #194).
 *
 * The window starts AT the anchor submission (so /feed?from=<id>#photo-<id>
 * always lands on a page containing that photo) and runs older from there,
 * capped at FEED_PAGE_SIZE rows. A missing, invalid, or taken-down anchor
 * falls back to the first (newest) page rather than erroring — a stale link
 * to a moderated photo should degrade to "show me the feed", not break.
 *
 * @param {number|null} fromId - anchor submission id, or null for the newest page.
 * @returns {{
 *   photos: object[],          // ≤ FEED_PAGE_SIZE rows, newest-first
 *   olderFromId: number|null,  // anchor for the next-older page, or null when none
 *   hasNewer: boolean,         // whether any newer photo exists above this window
 *   newerFromId: number|null   // anchor for the next-newer page; null (with
 *                              // hasNewer true) means that page is the first page
 * }}
 */
function feedWindow(fromId) {
  let anchor = null;
  if (Number.isInteger(fromId) && fromId >= 1) {
    anchor = stmtDetail.get(fromId) || null;
  }

  const rows = anchor
    ? stmtFeedWindowFromAnchor.all(anchor.created_at, anchor.created_at, anchor.submission_id)
    : stmtFeedWindowFirstPage.all();

  const photos = rows.slice(0, FEED_PAGE_SIZE);
  const olderFromId = rows.length > FEED_PAGE_SIZE ? rows[FEED_PAGE_SIZE].submission_id : null;

  let hasNewer = false;
  let newerFromId = null;
  if (photos.length > 0) {
    const first = photos[0];
    const newerIds = stmtFeedNewerIds.all(first.created_at, first.created_at, first.submission_id);
    if (newerIds.length > 0) {
      hasNewer = true;
      newerFromId =
        newerIds.length === FEED_PAGE_SIZE ? newerIds[newerIds.length - 1].submission_id : null;
    }
  }

  return { photos, olderFromId, hasNewer, newerFromId };
}

/**
 * The grouped gallery previews (issue #251): every group (task or guest) that
 * has at least one visible photo, each carrying its newest GROUP_PREVIEW_SIZE
 * photos and the group's true total, so the view can render a 6-tile preview
 * with a "+N" overlay when more exist.
 *
 * The per-group cap happens in SQL (ROW_NUMBER over the group, newest-first)
 * so a 400-photo weekend never materializes 400 rows to show 6-per-section
 * previews; COUNT(*) OVER the same partition rides along as the group total.
 *
 * Group ordering:
 *   kind='task' — by the group's newest photo, newest group first.
 *   kind='user' — pinned guests first (guests.pinned, the hosts' "our section
 *                 leads" flag, issue #251), then by the group's newest photo
 *                 ("recency is a party, alphabetical is a phonebook" — owner
 *                 decision), ties broken by the group's newest submission id
 *                 so same-second uploads still order deterministically.
 *
 * @param {'task'|'user'} kind
 * @param {number|null} taskFilter
 * @param {string} [q] - optional search text. Blank/absent means no filter.
 *        Groups whose heading does not contain q (case-insensitive substring)
 *        are dropped entirely. (The no-JS fallback for the client-side
 *        person search, which does word-prefix matching in the browser.)
 * @returns {Array<{ heading: string, photos: object[], total: number,
 *          task_id?: number, guest_id?: number, avatar_path?: string|null,
 *          pinned?: boolean }>}
 */
function grouped(kind, taskFilter, q) {
  const partitionKey = kind === 'task' ? 's.task_id' : 's.guest_id';
  const where = [VISIBLE_WHERE];
  const args = [];
  if (taskFilter !== null) {
    where.push('s.task_id = ?');
    args.push(taskFilter);
  }

  const groupOrder =
    kind === 'user'
      ? 'guest_pinned DESC, group_latest DESC, group_latest_id DESC'
      : 'group_latest DESC, group_latest_id DESC';

  const sql = `
    SELECT * FROM (
      SELECT ${GALLERY_COLUMNS},
             ROW_NUMBER() OVER (PARTITION BY ${partitionKey} ORDER BY ${ORDER_NEWEST_TERMS}) AS rn,
             COUNT(*)     OVER (PARTITION BY ${partitionKey}) AS group_total,
             MAX(s.created_at) OVER (PARTITION BY ${partitionKey}) AS group_latest,
             MAX(s.id)         OVER (PARTITION BY ${partitionKey}) AS group_latest_id
      ${GALLERY_FROM}
      WHERE ${where.join(' AND ')}
    )
    WHERE rn <= ${GROUP_PREVIEW_SIZE}
    ORDER BY ${groupOrder}, rn ASC`;

  const rows = db.prepare(sql).all(...args);

  const groups = [];
  const byKey = new Map();
  for (const row of rows) {
    const key = kind === 'task' ? row.task_id : row.guest_id;
    let group = byKey.get(key);
    if (!group) {
      group = {
        heading: kind === 'task' ? row.task_title : row.guest_name || 'Guest',
        photos: [],
        total: row.group_total,
      };
      if (kind === 'task') {
        group.task_id = row.task_id;
      } else {
        group.guest_id = row.guest_id;
        group.avatar_path = row.guest_avatar_path;
        group.pinned = row.guest_pinned === 1;
      }
      byKey.set(key, group);
      groups.push(group);
    }
    group.photos.push(row);
  }

  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (needle !== '') {
    return groups.filter((g) => g.heading.toLowerCase().includes(needle));
  }
  return groups;
}

// One guest's visible submissions, newest first, with the task title.
// Column list matches the public-profile template's needs (no guest_id/name —
// the caller already has the guest).
const stmtGuestPhotos = db.prepare(`
  SELECT s.id         AS submission_id,
         s.thumb_path AS thumb_path,
         s.photo_path AS photo_path,
         s.caption    AS caption,
         s.created_at AS created_at,
         t.title      AS task_title
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
   WHERE s.guest_id = ? AND ${VISIBLE_WHERE}
   ${ORDER_NEWEST_FIRST}
`);

/**
 * A single guest's visible submissions, newest-first.
 * @param {number} guestId
 * @returns {object[]}
 */
function guestPhotos(guestId) {
  return stmtGuestPhotos.all(guestId);
}

// SELECT for the photo detail query — reuses GALLERY_SELECT_BODY (same
// columns/FROM/JOINs as the gallery) plus the id + visibility filter.
const PHOTO_DETAIL_SELECT = `${GALLERY_SELECT_BODY}
   WHERE s.id = ? AND ${VISIBLE_WHERE}`;

const stmtDetail = db.prepare(PHOTO_DETAIL_SELECT);

/**
 * The visible submission row for one id, or null if missing/taken-down.
 * @param {number} submissionId
 * @returns {object|null}
 */
function detail(submissionId) {
  const row = stmtDetail.get(submissionId);
  return row || null;
}

/**
 * Find the next-older visible submission (the "next" link in a newest-first list).
 * Returns the row or undefined when the current photo is already the oldest.
 */
const stmtOlderNeighbor = db.prepare(`
  SELECT s.id AS submission_id
    FROM submissions s
   WHERE ${VISIBLE_WHERE}
     AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))
   ${ORDER_NEWEST_FIRST}
   LIMIT 1
`);

/**
 * Find the next-newer visible submission (the "previous" link in a newest-first list).
 * Returns the row or undefined when the current photo is already the newest.
 */
const stmtNewerNeighbor = db.prepare(`
  SELECT s.id AS submission_id
    FROM submissions s
   WHERE ${VISIBLE_WHERE}
     AND (s.created_at > ? OR (s.created_at = ? AND s.id > ?))
   ${ORDER_OLDEST_FIRST}
   LIMIT 1
`);

/**
 * The newer/older neighbors of a submission in the newest-first total order.
 *
 * The pivot must itself be visible: neighbors are computed from detail()'s
 * result, so a missing or taken-down submissionId yields a not-found result
 * ({ found: false }) rather than neighbors computed from a hidden row.
 *
 * Contract: returns { found: false } when the pivot submission is missing or
 * taken-down, and { found: true, newer, older } otherwise — callers must
 * check `found` (or pre-validate the pivot with detail()) before reading
 * `newer`/`older`.
 *
 * @param {number} submissionId
 * @returns {{ found: false } | { found: true, newer: number|null, older: number|null }}
 */
function neighbors(submissionId) {
  const pivot = stmtDetail.get(submissionId);
  if (!pivot) {
    return { found: false };
  }

  const older = stmtOlderNeighbor.get(pivot.created_at, pivot.created_at, pivot.submission_id);
  const newer = stmtNewerNeighbor.get(pivot.created_at, pivot.created_at, pivot.submission_id);

  return {
    found: true,
    newer: newer ? newer.submission_id : null,
    older: older ? older.submission_id : null,
  };
}

module.exports = {
  GALLERY_PAGE_SIZE,
  FEED_PAGE_SIZE,
  GROUP_PREVIEW_SIZE,
  recentPage,
  feedWindow,
  grouped,
  guestPhotos,
  detail,
  neighbors,
};
