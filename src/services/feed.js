// src/services/feed.js
//
// The "visible submissions feed" — the single place that knows which
// submissions are visible and in what order.
//
// Every community-facing view (gallery, photo detail, public profile) needs
// the same rules: a submission is visible only when taken_down = 0, and
// visible submissions sort newest-first (created_at DESC, id DESC, the id
// tiebreak so same-second inserts still sort deterministically) — except the
// newer-neighbor keyset lookup, which walks the same order backwards
// (created_at ASC, id ASC) to find the nearest strictly-newer row. Before
// this module, these rules were hand-typed at five call sites in
// src/routes/community.js. Here the one visibility predicate (VISIBLE_WHERE)
// and the two ordering clauses (ORDER_NEWEST_FIRST for the forward
// gallery/guest/older-neighbor queries, and its ascending mirror
// ORDER_OLDEST_FIRST for the newer-neighbor lookup) each live in exactly one
// constant, and every operation below composes them, so a route can ask a
// plain question ("give me guest 12's photos") without knowing the
// visibility/ordering rule exists.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const { db } = require('../db');

// How many gallery thumbnails to load per "page" (used for pagination links).
// Moved here from community.js — the feed owns pagination sizing because it
// owns the query that pagination slices.
const GALLERY_PAGE_SIZE = 60;

// ---------------------------------------------------------------------------
// The ONE visibility predicate and the ONE ordering clause (plus its mirror).
// Every operation in this file composes these constants — none is ever
// re-typed.
// ---------------------------------------------------------------------------
const VISIBLE_WHERE = 's.taken_down = 0';
const ORDER_NEWEST_FIRST = 'ORDER BY s.created_at DESC, s.id DESC';
// The reversed ordering, used only by the newer-neighbor keyset lookup: it
// walks forward from the pivot to find the nearest strictly-newer submission,
// so it needs ascending order (closest match first) rather than the newest-
// first order the rest of this file uses.
const ORDER_OLDEST_FIRST = 'ORDER BY s.created_at ASC, s.id ASC';

// The one shared submission SELECT body — columns plus FROM/JOINs — used by
// both the gallery queries (recentPage, grouped) and the detail query below.
// Consumers read every column by alias name (never by position), so the
// column order here is not a contract.
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
 * shape        'count' | 'page' | 'all' — the shape of the query to build.
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
 * Group a flat photo array into [{ heading, photos }] sections by a key
 * function that returns the group label for each photo.
 * Groups preserve insertion order (which is already newest-first within each
 * group because the SQL uses ORDER_NEWEST_FIRST).
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

/**
 * Every visible submission, flat and newest-first, unpaginated.
 *
 * Backs the full-screen feed (/feed), where every submission must be
 * present so a `#photo-<id>` fragment link always resolves to an element on
 * the page — unlike recentPage() (LIMIT/OFFSET) or grouped() (sections,
 * not a flat list), neither of which guarantees that.
 *
 * @returns {object[]}
 */
function allVisible() {
  const { sql, args } = galleryQuery('all', null);
  return db.prepare(sql).all(...args);
}

/**
 * All visible photos for a task filter, grouped by task title or guest name.
 *
 * @param {'task'|'user'} kind
 * @param {number|null} taskFilter
 * @returns {Array<{ heading: string, photos: object[] }>}
 */
function grouped(kind, taskFilter) {
  const { sql, args } = galleryQuery('all', taskFilter);
  const photos = db.prepare(sql).all(...args);

  if (kind === 'task') {
    return groupPhotos(photos, (p) => p.task_title);
  }
  return groupPhotos(photos, (p) => p.guest_name || 'Guest');
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
  recentPage,
  allVisible,
  grouped,
  guestPhotos,
  detail,
  neighbors,
};
