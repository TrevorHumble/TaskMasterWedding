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
// VISIBLE_WHERE owns the `s.`-aliased submission-visibility predicate only
// (issue #510). Three site shapes intentionally keep their own literal
// instead of importing this constant:
//   - no-alias single-table queries (e.g. scoring.js's completed-count and
//     photo-bonus-sum statements) — there is no `s` alias to reference, and
//     inventing one just to consume this constant would be a bigger, riskier
//     diff than the two-character literal it replaces.
//   - a differently-aliased subquery, e.g. scoring.js's `gbs`-aliased
//     leaderboard subquery — spelling `${VISIBLE_WHERE}` there would silently
//     depend on the caller happening to alias its table `s`, which this
//     module cannot see or enforce from here.
//   - compound sites that fuse the visibility check with an unrelated
//     condition, e.g. `taken_down = 0 AND task_id IS NOT NULL` — that AND'd
//     clause is a different rule (task-linked vs. memory submissions), not a
//     copy of this one, so folding it into VISIBLE_WHERE would conflate two
//     independent predicates under one name.
// Only a caller that already aliases the submissions table `s` and needs the
// bare visibility check may safely consume ${VISIBLE_WHERE} (see scoring.js's
// award-points-sum and leaderboard queries).
const VISIBLE_WHERE = 's.taken_down = 0';
// The ONE statement of "a comment is visible" (issue #644) — a separate flag
// from the submission-level taken_down VISIBLE_WHERE owns above, since a
// comment can be hidden independently of its photo. `c.` is the alias every
// consumer (community.js's attachComments/visibleCommentCount,
// notifications.js's derived comment source) already joins the comments
// table under, so this composes directly into each of their WHERE clauses
// with no re-aliasing. Owned here, beside VISIBLE_WHERE, rather than in
// community.js — a route module cannot be the single owner of a rule a
// service module (notifications.js) also needs, or the service would have to
// import a route file, inverting the app's route -> service dependency
// direction the file comment above already establishes.
const COMMENT_VISIBLE_WHERE = 'c.taken_down = 0';
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

// LEFT JOIN tasks (not JOIN): issue #247 made submissions.task_id nullable so
// a "memory" row (task_id IS NULL) can exist. An inner JOIN would silently
// drop every memory from the gallery/feed/detail queries below; LEFT JOIN
// keeps them, with t.id/t.title coming back NULL for a memory row. The
// s.taken_down = 0 predicate (VISIBLE_WHERE) is untouched by this change, so
// moderation still hides a taken-down memory exactly like a taken-down task
// photo.
const GALLERY_FROM = `
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
    LEFT JOIN tasks  t ON t.id = s.task_id`;

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
        // A memory row's task_title is NULL (LEFT JOIN, no task) — every
        // memory shares task_id NULL, so they partition into one group here,
        // headed "Memories" (issue #247, AC3) instead of a blank heading.
        heading: kind === 'task' ? row.task_title || 'Memories' : row.guest_name || 'Guest',
        photos: [],
        total: row.group_total,
      };
      if (kind === 'task') {
        group.task_id = row.task_id; // null for the Memories group (issue #247)
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
// the caller already has the guest). LEFT JOIN (not JOIN): a memory row
// (task_id IS NULL, issue #247) has no task to join, and must still appear on
// the guest's public profile with task_title coming back NULL.
const stmtGuestPhotos = db.prepare(`
  SELECT s.id         AS submission_id,
         s.task_id    AS task_id,
         s.thumb_path AS thumb_path,
         s.photo_path AS photo_path,
         s.caption    AS caption,
         s.created_at AS created_at,
         t.title      AS task_title
    FROM submissions s
    LEFT JOIN tasks t ON t.id = s.task_id
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

// The single newest VISIBLE submission with its guest's name — the admin
// dashboard's activity pulse line (issue #256). Owns the same visibility
// predicate and newest-first ordering as every other query in this file, so
// the pulse never surfaces a taken-down photo and always agrees with the
// gallery on "which one is newest".
const stmtNewestVisible = db.prepare(`
  SELECT s.created_at AS created_at,
         g.name       AS name
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
   WHERE ${VISIBLE_WHERE}
   ${ORDER_NEWEST_FIRST}
   LIMIT 1
`);

/**
 * The newest visible submission, joined to its guest for display.
 * @returns {{ name: string, created_at: string } | null} null when there are
 *   no visible submissions.
 */
function newestVisibleSubmission() {
  return stmtNewestVisible.get() || null;
}

// ---------------------------------------------------------------------------
// GET /slideshow's play sequence (issue #468).
// ---------------------------------------------------------------------------

// How many photos one section (the Most Liked opener, or a task group) holds
// at most, and how many task sections the reel carries at most. Both are the
// issue's own numbers ("the 5 highest-liked...", "the fullest up-to-5
// tasks") — named here so they read as intent, not magic numbers, at every
// call site below.
const SLIDESHOW_SECTION_SIZE = 5;
const SLIDESHOW_MAX_TASK_SECTIONS = 5;

// Rank-label text for a section's non-winner photos (2nd through 5th place).
// The winner (rank 1) never reads from this map — its label is the section's
// own winnerLabel ("Crowd favorite" for the Most Liked opener, "Top shot" for
// a task section), passed into buildSlideshowSection below.
const SLIDESHOW_ORDINAL_LABELS = { 2: '2nd place', 3: '3rd place', 4: '4th place', 5: '5th place' };

/**
 * One section's flat [title, ...photos] slice, in the view's `sequence`
 * contract. `rows` must already be sorted BEST-FIRST by the section's rank
 * metric (so `rows[0]` is the winner) — this takes the top
 * SLIDESHOW_SECTION_SIZE, assigns rank 1..N and a label, then reverses them
 * into ascending (worst-first) order so the winner (rank 1) renders LAST —
 * the "countdown to the winner" AC1/AC3 require.
 *
 * @param {object[]} rows - best-first rows (each carrying photo_path,
 *   guest_name, task_title, caption, like_count).
 * @param {{title: string, kicker: string}} titleItem - the section's title
 *   card, minus `count` (filled in here from the photos actually kept).
 * @param {string} winnerLabel - the rank-1 photo's label ("Crowd favorite" or
 *   "Top shot").
 * @returns {object[]} title item followed by up to SLIDESHOW_SECTION_SIZE
 *   photo items, worst-first / winner-last.
 */
function buildSlideshowSection(rows, titleItem, winnerLabel) {
  const top = rows.slice(0, SLIDESHOW_SECTION_SIZE);
  const photoItems = top.map((row, i) => {
    const rank = i + 1;
    const winner = rank === 1;
    return {
      type: 'photo',
      photo_path: row.photo_path,
      guest_name: row.guest_name,
      task_title: row.task_title,
      caption: row.caption,
      like_count: row.like_count,
      rank,
      winner,
      rankLabel: winner ? winnerLabel : SLIDESHOW_ORDINAL_LABELS[rank],
    };
  });
  photoItems.reverse();
  return [
    { type: 'title', title: titleItem.title, kicker: titleItem.kicker, count: top.length },
  ].concat(photoItems);
}

/**
 * The Most Liked opener's flat [title, ...photos] slice (issue #625) —
 * absorbs scoring.crowdFavorites() rather than reusing buildSlideshowSection
 * above. The difference is load-bearing, not stylistic: buildSlideshowSection
 * assigns each photo's rank from its ARRAY POSITION (i + 1), which is correct
 * for a task section (no cap on ties there) but WRONG here, where two photos
 * tied for a spot must render the identical rank label — a position-based
 * rank could never express that. Each entry's rank/points instead come
 * straight from `placing[i].rank` — scoring.crowdFavorites()'s own
 * standard-competition rank, the SAME number the standings and the recap
 * read — so the venue screen can never crown a photo the standings did not
 * pay (this issue's own design goal).
 *
 * `placing` must already be sorted BEST-FIRST (crowdFavorites()'s own
 * contract, never empty — callers check that first) and is reversed here
 * into worst-first / winner-last order, the same countdown-to-the-winner
 * shape (#468 AC1/AC3) buildSlideshowSection's task sections use.
 *
 * The title/kicker copy is unchanged, pre-existing text (issue #625 is the
 * engine; guest-facing wording is #788's to settle) — "five favorites" is
 * literally true only in the ordinary case; a big top tie can place more
 * than five, which this issue's own design notes call correct, not a bug.
 *
 * @param {Array<{submission_id: number, like_count: number, rank: number}>}
 *   placing - best-first, from scoring.crowdFavorites().
 * @param {Map<number, object>} rowsById - submission_id -> this file's own
 *   base-query row (photo_path, guest_name, task_title, caption) —
 *   crowdFavorites() itself carries no display fields. Every placing
 *   submission_id is guaranteed present: both queries read the same
 *   VISIBLE_WHERE submissions within one synchronous request, with no write
 *   between them (better-sqlite3 has no concurrent transactions mid-request).
 * @returns {object[]} title item followed by one photo item per placing
 *   photo, worst-first / winner-last.
 */
function buildCrowdFavoriteSection(placing, rowsById) {
  const photoItems = placing.map((p) => {
    const row = rowsById.get(p.submission_id);
    const winner = p.rank === 1;
    return {
      type: 'photo',
      photo_path: row.photo_path,
      guest_name: row.guest_name,
      task_title: row.task_title,
      caption: row.caption,
      like_count: p.like_count,
      rank: p.rank,
      winner,
      rankLabel: winner ? 'Crowd favorite' : SLIDESHOW_ORDINAL_LABELS[p.rank],
    };
  });
  photoItems.reverse();
  return [
    {
      type: 'title',
      title: 'Most Liked',
      kicker: "The crowd's five favorites",
      count: photoItems.length,
    },
  ].concat(photoItems);
}

/**
 * The end-of-night slideshow's play sequence (issue #468): a "Most Liked"
 * opener (the 5 highest-liked visible photos) followed by one section per
 * task (the fullest up-to-SLIDESHOW_MAX_TASK_SECTIONS tasks among the
 * REMAINING photos, up to SLIDESHOW_SECTION_SIZE photos each) — a photo
 * already used in the opener is never repeated ("show once"). Every section
 * plays as a countdown: its winner (rank 1) renders last.
 *
 * Owns no new visibility rule — composes VISIBLE_WHERE and ORDER_NEWEST_FIRST
 * like every other query in this file. The base query already returns rows
 * newest-first; every rank below is built by chaining STABLE sorts
 * (Array.prototype.sort has been a stable sort since ES2019) from
 * least-significant key to most-significant, so a tie at the primary metric
 * falls through to the secondary metric, and a tie at both falls through to
 * the base query's own newest-first order — without hand-rolling a
 * created_at/id comparator here.
 *
 * Rank metric per section:
 *   - Most Liked opener: scoring.crowdFavorites()'s own standard-competition
 *     rank over like_count (issue #625) — the SAME ranking the standings and
 *     the recap read, absorbing what used to be this file's own separate
 *     "top 5 by likes, points tiebreak" sort (see buildCrowdFavoriteSection).
 *   - Task groups: scoring.photoPoints(photo_bonus, worth, bonus_amount),
 *     ties broken by like_count.
 *
 * @returns {object[]} flat `sequence` matching the frozen slideshow view's
 *   contract (src/views/slideshow.ejs): `{ type: 'title', title, kicker,
 *   count }` and `{ type: 'photo', photo_path, guest_name, task_title,
 *   caption, like_count, rank, winner, rankLabel }`. `[]` when there are no
 *   visible submissions (the view's empty state, AC4).
 */
function slideshowSequence() {
  // Lazy require, not a top-level one: scoring.js requires feed.js (for
  // VISIBLE_WHERE) at ITS OWN top level, so a top-level require here would
  // create a load-order-sensitive cycle — whichever of the two modules
  // happens to load first would see the other's module.exports still
  // mid-assembly (missing keys) at the moment it destructures from it.
  // Deferring this require to call time sidesteps the cycle entirely: by the
  // time any route calls slideshowSequence(), both modules have long since
  // finished loading, and require() memoizes so this costs nothing beyond
  // the first call.
  const scoring = require('./scoring');

  const rows = db
    .prepare(
      `SELECT s.id            AS submission_id,
              s.photo_path    AS photo_path,
              s.caption       AS caption,
              s.photo_bonus   AS photo_bonus,
              s.bonus_amount  AS bonus_amount,
              s.task_id       AS task_id,
              g.name          AS guest_name,
              t.title         AS task_title,
              t.worth         AS worth,
              (SELECT COUNT(*) FROM likes l WHERE l.submission_id = s.id) AS like_count
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         LEFT JOIN tasks  t ON t.id = s.task_id
        WHERE ${VISIBLE_WHERE}
        ${ORDER_NEWEST_FIRST}`
    )
    .all();

  if (rows.length === 0) {
    return [];
  }

  for (const row of rows) {
    // worth 0 only for a memory (task_id IS NULL, issue #247, so the LEFT
    // JOIN's t.worth comes back NULL) — same rule community.js's
    // attachPhotoPoints applies to this same function (issue #727).
    // bonus_amount (issue #753/#756) needs no such guard — it is 0 for a
    // memory (nothing ever banks a one-day-only bonus on one) and for any
    // submission that never banked an on-day bonus.
    row.points = scoring.photoPoints(
      row.photo_bonus,
      row.task_id !== null ? row.worth : 0,
      row.bonus_amount
    );
  }

  // --- Most Liked opener --------------------------------------------------
  // Absorbed into scoring.crowdFavorites() (issue #625) — see
  // buildCrowdFavoriteSection's own doc comment for why this needed a
  // dedicated builder rather than reusing buildSlideshowSection. Not
  // size-capped (SLIDESHOW_SECTION_SIZE still bounds every TASK section
  // below, just not this one): the opener renders exactly the placing set,
  // usually ~5 photos, more only under a big top tie, and is omitted
  // entirely when the set is empty (nobody has any likes yet, AC4).
  const rowsById = new Map(rows.map((r) => [r.submission_id, r]));
  const placing = scoring.crowdFavorites();
  const openerIds = new Set(placing.map((p) => p.submission_id));
  const sequence = placing.length === 0 ? [] : buildCrowdFavoriteSection(placing, rowsById);

  // --- Task groups ---------------------------------------------------------
  // Only task-linked rows (task_id !== null) group into a task section — a
  // memory (issue #247) has no task to join. A row already shown in the
  // opener is dropped here, so it is never repeated ("show once").
  const remaining = rows.filter((r) => r.task_id !== null && !openerIds.has(r.submission_id));

  const byTaskId = new Map();
  for (const row of remaining) {
    if (!byTaskId.has(row.task_id)) {
      byTaskId.set(row.task_id, []);
    }
    byTaskId.get(row.task_id).push(row);
  }

  const taskGroups = Array.from(byTaskId.entries()).map(([taskId, taskRows]) => {
    // Ranked points-first, likes as the tiebreak; a full tie falls through to
    // the base query's newest-first order (Array.prototype.sort is stable).
    const sorted = taskRows
      .slice()
      .sort((a, b) => b.points - a.points || b.like_count - a.like_count);
    return { taskId, taskTitle: taskRows[0].task_title, rows: sorted };
  });

  // Fullest task first (most remaining photos); ties broken by task id
  // ascending — the issue specifies "the fullest up-to-5 tasks" but not a
  // tiebreak, so this picks the deterministic, stable option (older task
  // wins the tie) rather than leaving group order to Map iteration.
  taskGroups.sort((a, b) => b.rows.length - a.rows.length || a.taskId - b.taskId);

  for (const group of taskGroups.slice(0, SLIDESHOW_MAX_TASK_SECTIONS)) {
    sequence.push(
      ...buildSlideshowSection(
        group.rows,
        { title: group.taskTitle, kicker: 'Up next' },
        'Top shot'
      )
    );
  }

  return sequence;
}

module.exports = {
  GALLERY_PAGE_SIZE,
  FEED_PAGE_SIZE,
  GROUP_PREVIEW_SIZE,
  // The one visibility predicate ("a submission is visible iff taken_down = 0",
  // aliased `s`). Exported (#488) so other services consume this single owner
  // instead of re-deriving the literal; #510 migrated the two cleanly-composable
  // `s.`-aliased sites in scoring.js, while the other-shape sites intentionally
  // retain their own literal (see the declaration-site comment for why).
  VISIBLE_WHERE,
  // The one comment-visibility predicate (aliased `c`), exported for the same
  // reason as VISIBLE_WHERE above (issue #644) — community.js and
  // notifications.js both compose it rather than each typing their own copy.
  COMMENT_VISIBLE_WHERE,
  recentPage,
  feedWindow,
  grouped,
  guestPhotos,
  detail,
  neighbors,
  newestVisibleSubmission,
  slideshowSequence,
};
