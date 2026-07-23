// src/services/notifications.js
//
// The recap ("what you missed") service — issue #644. The single owner of
// "what does this guest see": unions STORED events (notification_events —
// badge grants/revokes, and later moderation/announcement kinds #783/#778
// add) with two DERIVED sources (likes, comments), scoped by the same
// visibility owners the rest of the app already uses — feed.VISIBLE_WHERE for
// the photo, feed.COMMENT_VISIBLE_WHERE for the comment, both re-exported
// from their single owner (src/services/feed.js) rather than re-typed here.
//
// Two shapes of "existence" on purpose (recorded here since it is the one
// judgment call this module makes that isn't spelled out row-by-row in the
// issue): a STORED event (badge_granted/revoked) is PERMANENT — it stays in
// the recap forever, tinted read/white once its checkpoint passes, so a
// badge row can still replay its celebration "on demand" long after it was
// first shown (issue #644 AC1). A DERIVED like-batch is EPHEMERAL — it only
// exists in the list while it has at least one like strictly newer than the
// guest's checkpoint, and its displayed count is ONLY those new likes, never
// a lifetime total (AC3's own wording: "5 older likes and 3 new ones still
// reads 3"). Comments sit with the permanent group (one row per comment,
// tinted like badges) since each comment already has its own natural
// per-event identity, unlike a like batch which has to pick some window to
// exist at all.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const config = require('../../config');
const { db } = require('../db');
const { VISIBLE_WHERE, COMMENT_VISIBLE_WHERE } = require('./feed');
const { relativeTime } = require('./relative-time');
const { isIconArtPath } = require('./badge-icons');

// How many rows one recap page holds (issue #644 plan step 5). Also the
// per-source fetch bound below (FETCH_LIMIT): the true top PAGE_SIZE rows of
// a 3-way merge can never draw more than PAGE_SIZE rows from any ONE source
// (there are only PAGE_SIZE seats total), so asking each source for its own
// top PAGE_SIZE + 1 (ordered/cursor-filtered identically to the final merge)
// is always enough to both answer the page correctly AND know whether a
// further page exists — see allRows' doc comment for the full argument.
// Bounding each source this way (issue #644 review) is what makes this
// module's per-request cost independent of a guest's total lifetime event
// count, not just "small in practice for one wedding weekend."
const PAGE_SIZE = 20;
const FETCH_LIMIT = PAGE_SIZE + 1;

// Stored `kind` (notification_events.kind) -> complete view treatment: the
// CSS class suffix header.ejs's frozen markup renders (`.recap-row-<view>`),
// whether the row is inert ("dead" — no link, greyed thumb), the row copy
// (`parts`), and where it links (`href`). #644 owns the COMPLETE map so the
// vocabulary has one author (plan step 1, matching that step's own table);
// it emits badge_granted/badge_revoked/badge_removed itself — the other four
// are wired by #783 (moderation) once #644 has shipped this table/service/map.
// `parts`/`href` are functions of the stored event row (`ev`) rather than
// plain strings so the SAME entry both supplies the copy text AND decides
// the destination — folding what used to be a separate if/else chain in
// storedRows into this one table (issue #644 review: a sibling issue adding
// a kind to the data half of KIND_VIEW alone, with the copy/href half left
// as a parallel if/else, could add a kind that renders a blank row).
//
// `parts` is an array of `{ text, emphasis?, quote? }` segments, not a
// pre-built HTML string: the view (header.ejs / recap.js) is what turns each
// segment into markup, applying `<strong>`/quote styling AND HTML-escaping
// through its own output mechanism (EJS's `<%= %>`, the DOM's textContent) —
// escaping-by-construction (issue #644 review), so a new copy branch can
// never forget to call a hand-rolled escaper the way the pre-review version
// of this module required.
// Ordinal copy for a ranked task-badge win (issue #661), 1-indexed. Task
// ranking pays at most MAX_RANKED_WINNERS (task-badges.js) placements, so
// this array only ever needs to cover 1..5 — a rank outside that range
// cannot reach KIND_VIEW.badge_granted's parts() below (releaseRanking is
// the only writer of a non-NULL guest_badges.rank, and it refuses a release
// longer than 5).
const RANK_ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];

const KIND_VIEW = {
  badge_granted: {
    view: 'badge',
    dead: false,
    // A ranked task-badge win (issue #661) carries a placement — `ev.rank`,
    // read LIVE off the guest_badges row the stored event's (guest_id,
    // badge_id) pair currently points at (stmtStoredEvents' own `gb` JOIN,
    // below), never snapshotted onto the event row itself, exactly like
    // `ev.badge_name`/`ev.badge_art_path` above are already read live off
    // `badges` rather than duplicated at write time. An auto/metric/
    // transferable/special grant never carries a rank (releaseRanking is the
    // only writer of a non-NULL guest_badges.rank), so `ordinal` is undefined
    // for every one of those and this falls through to the original,
    // unchanged "You earned X" copy.
    parts: (ev) => {
      const ordinal = RANK_ORDINAL[ev.rank - 1];
      if (ordinal) {
        return [
          { text: 'You placed ' },
          { text: ordinal, emphasis: true },
          { text: ' for ' },
          { text: ev.badge_name, emphasis: true },
        ];
      }
      return [{ text: 'You earned ' }, { text: ev.badge_name, emphasis: true }];
    },
    // A ranked win's stored event carries the winning submission_id
    // (task-badges.js's releaseRanking passes it to recordEvent) — link to
    // it (AC8's "linking to the winning photo"). Every other badge_granted
    // source (system auto/metric grants) never sets submission_id, so this
    // stays null for them exactly as before.
    href: (ev) => (ev.submission_id != null ? `/p/${ev.submission_id}` : null),
  },
  badge_revoked: {
    view: 'loss',
    dead: false,
    parts: (ev) => [
      { text: ev.badge_name, emphasis: true },
      { text: ' left your profile — the hosts added a task' },
    ],
    href: () => '/tasks',
  },
  // The HOST-INITIATED removal path (scoring.js's removeSpecialBadge — a host
  // un-awarding a mistakenly-given special/custom badge), kept as its own
  // stored kind rather than reusing badge_revoked (issue #644 review, PR
  // finding): badge_revoked's copy asserts a specific reason ("the hosts
  // added a task") that is only true for the auto/metric/transferable
  // threshold-recompute revoke paths (recomputeBadges/
  // recomputeTransferableBadges) — false for a direct host removal, whose
  // href to /tasks also goes nowhere useful for that case (there is no task
  // change to go look at). `dead: true` here (no link/button) rather than
  // inventing a destination that may not exist.
  badge_removed: {
    view: 'loss',
    dead: true,
    parts: (ev) => [{ text: ev.badge_name, emphasis: true }, { text: ' was removed by the hosts' }],
    href: () => null,
  },
  photo_takedown: {
    view: 'loss',
    dead: true,
    parts: () => [{ text: 'The hosts ' }, { text: 'took your photo down', emphasis: true }],
    href: () => null,
  },
  photo_restore: {
    view: 'photo',
    dead: false,
    parts: () => [{ text: 'Your photo is ' }, { text: 'back up', emphasis: true }],
    href: (ev) => (ev.submission_id != null ? `/p/${ev.submission_id}` : null),
  },
  comment_hidden: {
    view: 'loss',
    dead: false,
    parts: () => [
      { text: 'A comment on your photo was ' },
      { text: 'removed by the hosts', emphasis: true },
    ],
    href: (ev) => (ev.submission_id != null ? `/p/${ev.submission_id}` : null),
  },
  comment_restored: {
    view: 'photo',
    dead: false,
    parts: () => [{ text: 'A comment on your photo is ' }, { text: 'back', emphasis: true }],
    href: (ev) => (ev.submission_id != null ? `/p/${ev.submission_id}` : null),
  },
};

// Per-VIEW-KIND glyph markup (issue #644 review: the phase-2 pass deleted
// the phase-1 preview's per-kind glyph entirely, leaving every thumbless row
// — including a `loss` row — rendering the `badge` trophy). Defined ONCE
// here as a literal SVG string and attached to every row's `glyph` field
// below, so header.ejs (server-rendered) and recap.js (client-rendered, for
// a scrolled-in page fetched as JSON) drop in the IDENTICAL markup rather
// than each maintaining their own copy that can silently drift apart — the
// exact divergence risk a reviewer flagged (#778's Touches lists header.ejs
// but not recap.js, so a glyph restored only in the EJS template would look
// right on page one and wrong on every page after). `gold` and `announce`
// are wired here now (their approved CSS already exists — `.recap-icon-gold`,
// `.recap-row-announce .recap-icon`) even though no emitter in THIS issue's
// scope produces those view kinds yet (#647 and #778 respectively) — the
// glyph table is complete for every view kind currently named in the
// approved row-anatomy list, not just the ones #644 itself emits.
//
// NOT wired here: three PLANNED per-announcement-detail glyphs (`day`,
// `flash`, `task`) this issue's own plan said to keep for #778 — see
// DESIGN.md's "Recap" ADR, "Known gap" entry. The phase-1 art for them was
// never committed to this branch, so there is nothing here to restore; #778
// owns adding them when it lands the emitters that need them.
const KIND_GLYPH = {
  badge:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 15.5 7 21l5-2.2L17 21l-1.5-5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  loss: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 12h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  photo:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="4" y="5" width="16" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="9" cy="10" r="1.4" fill="currentColor"/><path d="m5.5 16.5 4-4 3 3 3.5-4.5 3.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gold: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 20s-7-4.4-9.3-8.8C1.4 8 3 5 6.2 5 8.4 5 10 6.3 12 8.4 14 6.3 15.6 5 17.8 5 21 5 22.6 8 21.3 11.2 19 15.6 12 20 12 20Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  announce:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 4v16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6 5c3-1.4 5 1.4 8 0v8c-3 1.4-5-1.4-8 0V5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

// Server-rendered badge medallion markup for a recap row's on-demand replay
// (issue #644 review, Rule 5 in docs/economy-architecture-2026-07-20.md):
// the replay dialog must render through the SAME shared partial every other
// badge-display call site uses, not a hand-composed `<img>`. Compiled once
// from the real src/views/partials/badge-art.ejs file — not a second copy of
// its markup — so this module can never drift from what every other badge
// call site renders. badgeIsIcon (the partial's one required local besides
// `badge`/`alt`) is passed explicitly rather than relying on Express's
// app.locals merge, since this compiled template is invoked directly
// (ejs.compile), outside any res.render() call.
const badgeArtTemplatePath = path.join(config.VIEWS_DIR, 'partials', 'badge-art.ejs');
const renderBadgeArtPartial = ejs.compile(fs.readFileSync(badgeArtTemplatePath, 'utf8'), {
  filename: badgeArtTemplatePath,
});

/**
 * The badge-art partial's rendered HTML for one badge, or null when there is
 * no badge to render (every non-badge_granted row).
 * @param {{name: string, art_path: string}|null} badge
 * @returns {string|null}
 */
function renderBadgeArt(badge) {
  if (!badge) {
    return null;
  }
  return renderBadgeArtPartial({
    badge: badge,
    alt: badge.name + ' badge',
    badgeIsIcon: isIconArtPath,
  });
}

// The guest's recap checkpoint: COALESCE(recap_checked_at, created_at) —
// db.js's ensureRecapCheckedAtColumn doc comment explains why a NULL
// checkpoint must never reach a bare comparison (a never-checked guest is
// never treated as having no checkpoint — issue #644 AC8).
const stmtCheckpoint = db.prepare(
  `SELECT COALESCE(recap_checked_at, created_at) AS checkpoint FROM guests WHERE id = ?`
);

/**
 * This guest's current recap checkpoint (event-local SQLite datetime
 * string), or null if the guest id does not exist.
 * @param {number} guestId
 * @returns {string|null}
 */
function checkpointFor(guestId) {
  const row = stmtCheckpoint.get(guestId);
  return row ? row.checkpoint : null;
}

const stmtRecordEvent = db.prepare(
  `INSERT INTO notification_events (guest_id, kind, submission_id, badge_id) VALUES (?, ?, ?, ?)`
);

/**
 * Record one STORED recap event. The single write path every emitter
 * (scoring.js's recomputeBadges/recomputeTransferableBadges/
 * awardSpecialBadge/removeSpecialBadge today; #783's moderation routes and
 * #778's announcement seam later) calls, so the row shape has one owner even
 * though the emit CALL SITES are necessarily scattered across the seams
 * where each fact is already in scope (issue #644 plan step 2/3 — a badge
 * event is written where the badge identity is in scope, not re-derived
 * later).
 * @param {number} guestId
 * @param {string} kind - one of the seven stored kinds in KIND_VIEW.
 * @param {{submissionId?: number|null, badgeId?: number|null}} [opts]
 */
function recordEvent(guestId, kind, opts = {}) {
  const submissionId = opts.submissionId != null ? opts.submissionId : null;
  const badgeId = opts.badgeId != null ? opts.badgeId : null;
  stmtRecordEvent.run(guestId, kind, submissionId, badgeId);
}

// ---------------------------------------------------------------------------
// Bounded, cursor-paged source queries.
//
// Each of the three sources below takes the SAME four cursor params, in the
// SAME order — (before, before, before, beforeKey, beforeKey) — bound after
// guestId (and, for likes, the unread checkpoint): `before`/`beforeKey` NULL
// means "first page, no filtering"; otherwise a row qualifies when it is
// strictly older than `before`, OR exactly AT `before` and its own composite
// key sorts strictly before `beforeKey` — the identical (when, key) tuple
// comparison allRows' merge-sort below uses, so the SQL-side cursor and the
// JS-side final order can never disagree about which row comes first
// (issue #644 review: the previous cursor compared `when` alone, silently
// dropping or re-serving rows that shared a same-second timestamp — SQLite's
// datetime('now') has only whole-second resolution, and recomputeBadges can
// emit two grants inside one transaction). `beforeKey` bound NULL (a caller
// that only sends `before`) falls back to a plain `created_at < before`
// comparison — every tied row at the boundary second is excluded rather than
// risking a duplicate, matching this module's pre-cursor-fix behavior
// exactly for a caller that does not send the new param.
//
// The `('<prefix>-' || id)` computed key must match this module's own `key`
// field format on the mapped row objects below EXACTLY (event-<id>,
// comment-<id>, like-<submission_id>) and the ORDER BY must sort by that
// same computed expression (not the bare numeric id) — a numeric-id ORDER BY
// can disagree with the string-key comparator at a tie (e.g. id 9 sorts
// before id 10 numerically DESC, but "comment-9" sorts AFTER "comment-10"
// lexicographically), which would silently violate the FETCH_LIMIT
// per-source bound's correctness (see allRows' doc comment).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-source EXISTENCE predicates — the source registry (issue #644 review:
// each source's ROW-FETCH statement below and its cheap COUNT statement
// further down used to spell out the identical WHERE-clause rule as two
// separately typed SQL string literals, with nothing stopping the two from
// silently drifting apart the next time either was hand-edited. Each
// constant below defines that rule EXACTLY ONCE — the same guest-scope +
// visibility + self-exclusion predicate every row from this source must
// satisfy to exist at all, independent of paging/cursor concerns — and both
// this source's FETCH query and its COUNT query interpolate the same
// constant rather than retyping it. This does NOT merge the two queries into
// one (that would reintroduce the full-union cost getUnreadCount exists to
// avoid) — it only guarantees the one WHERE-fragment both queries must agree
// on is written down a single time. #778 adding a fourth source (its own
// announcement rows) follows the same shape: define that source's own
// `_EXISTENCE_WHERE` constant once, reuse it in both its FETCH and COUNT
// statements, rather than hand-copying a new WHERE clause into two new
// prepared statements.
// ---------------------------------------------------------------------------
const EVENT_EXISTENCE_WHERE = `ne.guest_id = ?`;
const COMMENT_EXISTENCE_WHERE = `s.guest_id = ? AND ${VISIBLE_WHERE} AND ${COMMENT_VISIBLE_WHERE} AND c.guest_id != s.guest_id`;
// The checkpoint bound (`l.created_at > ?`) is part of what makes a like
// "exist" as an unread source row at all (issue #644 AC3 — no checkpoint, no
// row), unlike the FETCH-side cursor bound below (which only decides which
// PAGE an already-existing row falls on) — so it belongs in the shared
// existence predicate, not bolted on separately by each query.
const LIKE_EXISTENCE_WHERE = `s.guest_id = ? AND ${VISIBLE_WHERE} AND l.created_at > ?`;

const stmtStoredEvents = db.prepare(`
  SELECT ne.id            AS id,
         ne.kind           AS kind,
         ne.submission_id  AS submission_id,
         ne.created_at     AS created_at,
         b.code            AS badge_code,
         b.name            AS badge_name,
         b.art_path        AS badge_art_path,
         b.description     AS badge_description,
         s.thumb_path      AS thumb_path,
         gb.rank           AS rank
    FROM notification_events ne
    LEFT JOIN badges b ON b.id = ne.badge_id
    LEFT JOIN submissions s ON s.id = ne.submission_id
    -- issue #661: a ranked task-badge win's placement, read LIVE off the
    -- guest's CURRENT guest_badges row for this exact (guest_id, badge_id)
    -- pair — never stored on the event itself (see KIND_VIEW.badge_granted's
    -- own comment for why). UNIQUE(guest_id, badge_id) means at most one row
    -- can ever match, so this LEFT JOIN can never fan a stored event out into
    -- more than one recap row. NULL for every non-badge event (ne.badge_id
    -- IS NULL, so the ON clause matches nothing) and for a system/special
    -- grant (that guest_badges row's own rank column is NULL).
    LEFT JOIN guest_badges gb ON gb.guest_id = ne.guest_id AND gb.badge_id = ne.badge_id
   WHERE ${EVENT_EXISTENCE_WHERE}
     AND (
       ? IS NULL
       OR ne.created_at < ?
       OR (ne.created_at = ? AND ? IS NOT NULL AND ('event-' || ne.id) < ?)
     )
   ORDER BY ne.created_at DESC, ('event-' || ne.id) DESC
   LIMIT ${FETCH_LIMIT}
`);

// DERIVED comment rows: every comment on one of the guest's VISIBLE photos
// (feed.VISIBLE_WHERE), excluding a HIDDEN comment (feed.COMMENT_VISIBLE_WHERE)
// and excluding the guest's OWN comment on their OWN photo (issue #644 AC5 —
// a guest's own action never notifies them; the like route already refuses a
// self-like, but the comment route has no such guard, so the exclusion lives
// in this read instead). See COMMENT_EXISTENCE_WHERE above for the shared
// existence predicate this query and stmtUnreadCommentCount below both use.
const stmtCommentEvents = db.prepare(`
  SELECT c.id            AS id,
         c.body           AS body,
         c.created_at     AS created_at,
         c.submission_id  AS submission_id,
         s.thumb_path     AS thumb_path,
         g.name           AS commenter_name
    FROM comments c
    JOIN submissions s ON s.id = c.submission_id
    JOIN guests g ON g.id = c.guest_id
   WHERE ${COMMENT_EXISTENCE_WHERE}
     AND (
       ? IS NULL
       OR c.created_at < ?
       OR (c.created_at = ? AND ? IS NOT NULL AND ('comment-' || c.id) < ?)
     )
   ORDER BY c.created_at DESC, ('comment-' || c.id) DESC
   LIMIT ${FETCH_LIMIT}
`);

// DERIVED like-batches: one row per VISIBLE submission the guest owns that
// has at least one like NEWER than the checkpoint passed in — both the
// row's existence and its displayed count are scoped to "since checkpoint"
// (issue #644 AC3), never a lifetime total. A self-like can never appear
// here (community.js's POST /p/:id/like already refuses one before any
// likes row is written — issue #712), so no guest_id exclusion is needed
// the way stmtCommentEvents needs one. The HAVING clause applies the same
// cursor comparison as the other two sources, against the aggregated
// `latest` (MAX(l.created_at)) rather than a per-row column. See
// LIKE_EXISTENCE_WHERE above for the shared existence predicate this query
// and stmtUnreadLikeSubmissionCount below both use. Known limitation (not
// fixed — see DESIGN.md's "Recap" ADR): a like landing in the identical
// whole SECOND as the guest's checkpoint (markSeen's `datetime('now')`) is
// excluded by the strict `>` here and is a DERIVED row, so that exclusion is
// permanent, not just delayed to the next page.
const stmtLikeBatches = db.prepare(`
  SELECT s.id            AS submission_id,
         s.thumb_path     AS thumb_path,
         COUNT(*)         AS like_count,
         MAX(l.created_at) AS latest
    FROM likes l
    JOIN submissions s ON s.id = l.submission_id
   WHERE ${LIKE_EXISTENCE_WHERE}
   GROUP BY s.id
  HAVING (
       ? IS NULL
       OR MAX(l.created_at) < ?
       OR (MAX(l.created_at) = ? AND ? IS NOT NULL AND ('like-' || s.id) < ?)
     )
   ORDER BY latest DESC, ('like-' || s.id) DESC
   LIMIT ${FETCH_LIMIT}
`);

/**
 * Bind the four cursor params in the fixed order every source statement
 * above shares. `cursor` is `{ when, key }` or null for the first page.
 * @param {{when: string, key: string|null}|null} cursor
 * @returns {[string|null, string|null, string|null, string|null]}
 */
function cursorParams(cursor) {
  const when = cursor ? cursor.when : null;
  const key = cursor ? cursor.key : null;
  return [when, when, when, key, key];
}

/**
 * Build the row objects for one guest's STORED events, up to FETCH_LIMIT
 * rows (bounded — see allRows' doc comment). `parts`/`href`/`dead`/`kind`
 * come from KIND_VIEW, the one place the stored-kind -> treatment map lives
 * (mirrors the table in the issue's implementation plan step 1).
 */
function storedRows(guestId, cursor) {
  const events = stmtStoredEvents.all(guestId, ...cursorParams(cursor));
  const rows = [];
  for (const ev of events) {
    const treatment = KIND_VIEW[ev.kind];
    if (!treatment) {
      // An unrecognized kind (should not happen — KIND_VIEW is the complete
      // vocabulary) is skipped defensively rather than crashing the recap.
      continue;
    }
    const badge =
      ev.kind === 'badge_granted'
        ? {
            code: ev.badge_code,
            name: ev.badge_name,
            art_path: ev.badge_art_path,
            description: ev.badge_description,
          }
        : null;
    rows.push({
      key: `event-${ev.id}`,
      kind: treatment.view,
      dead: treatment.dead,
      parts: treatment.parts(ev),
      href: treatment.href(ev),
      thumb: ev.thumb_path,
      badge: badge,
      badgeArtHtml: renderBadgeArt(badge),
      glyph: KIND_GLYPH[treatment.view] || KIND_GLYPH.photo,
      when: ev.created_at,
    });
  }
  return rows;
}

function commentRows(guestId, cursor) {
  return stmtCommentEvents.all(guestId, ...cursorParams(cursor)).map((c) => ({
    key: `comment-${c.id}`,
    kind: 'photo',
    dead: false,
    parts: [
      { text: c.commenter_name, emphasis: true },
      { text: ' commented: ' },
      { text: c.body, quote: true },
    ],
    href: `/p/${c.submission_id}`,
    thumb: c.thumb_path,
    badge: null,
    badgeArtHtml: null,
    glyph: KIND_GLYPH.photo,
    when: c.created_at,
  }));
}

function likeBatchRows(guestId, checkpoint, cursor) {
  return stmtLikeBatches.all(guestId, checkpoint, ...cursorParams(cursor)).map((l) => ({
    key: `like-${l.submission_id}`,
    kind: 'photo',
    dead: false,
    parts: [
      { text: `${l.like_count} ${l.like_count === 1 ? 'person' : 'people'}`, emphasis: true },
      { text: ' liked your photo' },
    ],
    href: `/p/${l.submission_id}`,
    thumb: l.thumb_path,
    badge: null,
    badgeArtHtml: null,
    glyph: KIND_GLYPH.photo,
    when: l.latest,
  }));
}

/**
 * One bounded, time-ordered (newest first) slice of one guest's recap row
 * set — every STORED event, every visible non-self comment, and every
 * unread like-batch strictly older than `cursor` (or every one, when
 * `cursor` is null), merged and sorted, capped at FETCH_LIMIT rows PER
 * SOURCE (issue #644 review — the pre-review version pulled every row of
 * every source with no LIMIT at all).
 *
 * Correctness of the per-source FETCH_LIMIT bound: the caller (getRecap)
 * only ever wants the true top PAGE_SIZE rows of this merge, plus whether a
 * (PAGE_SIZE + 1)-th exists. Those top (PAGE_SIZE + 1) rows can include AT
 * MOST (PAGE_SIZE + 1) rows from any ONE of the three sources — trivially,
 * since (PAGE_SIZE + 1) is the total count wanted. So asking each source for
 * its own top FETCH_LIMIT = PAGE_SIZE + 1 rows (in the same order the merge
 * uses) is guaranteed to include the source's full contribution to the true
 * top (PAGE_SIZE + 1), even though it may also include some rows that do
 * NOT end up in that true top (PAGE_SIZE + 1) once merged with the other two
 * sources — which is fine, since getRecap only reads this array's sorted
 * prefix and its length, never relies on every returned row being "in the
 * final page."
 *
 * @param {number} guestId
 * @param {string} checkpoint
 * @param {{when: string, key: string|null}|null} [cursor]
 * @returns {Array<object>} newest-first, sorted by (when, key) descending —
 *   callers (getRecap) depend on this exact order for their paging cursor.
 */
function allRows(guestId, checkpoint, cursor) {
  const rows = storedRows(guestId, cursor).concat(
    commentRows(guestId, cursor),
    likeBatchRows(guestId, checkpoint, cursor)
  );
  rows.sort((a, b) => {
    if (a.when !== b.when) {
      return a.when < b.when ? 1 : -1;
    }
    return a.key < b.key ? 1 : -1;
  });
  return rows;
}

/**
 * One page of this guest's recap, newest-first, `before`/`beforeKey`-cursor
 * paginated at PAGE_SIZE rows (issue #644 plan step 5/6).
 *
 * The checkpoint used for both the like-batch window and each row's `unread`
 * flag is read FRESH on every call (the same "read fresh, never thread a
 * timestamp across requests" pattern the rest of this app uses everywhere).
 * One accepted consequence, recorded here rather than silently: the first
 * page a guest opens reads the checkpoint from BEFORE POST /recap/seen has
 * advanced it (that POST fires asynchronously, after this render), so it
 * correctly shows what they missed; a later page fetched via ?before= during
 * the SAME open happens after /recap/seen has already landed, so a like
 * batch whose only new likes fall entirely before that already-advanced
 * checkpoint would not surface on that later page. Given the badge/comment
 * sources are permanent (unaffected by this), and a guest paging past 20
 * events in one sitting is the rare case for a three-day wedding, this is an
 * accepted simplification, not a silent bug.
 *
 * @param {number} guestId
 * @param {{before?: string, beforeKey?: string}} [opts] - `before`: an
 *   ISO-ish SQLite datetime string; rows strictly older (by the composite
 *   (when, key) order, see allRows) are returned. Omit both for the first
 *   page. `beforeKey` omitted with `before` present falls back to a plain
 *   `when`-only comparison (see the source-query comment above).
 * @returns {{ rows: Array<object>, hasMore: boolean }}
 */
function getRecap(guestId, opts = {}) {
  const checkpoint = checkpointFor(guestId);
  const cursor =
    typeof opts.before === 'string' && opts.before
      ? {
          when: opts.before,
          key: typeof opts.beforeKey === 'string' && opts.beforeKey ? opts.beforeKey : null,
        }
      : null;
  const rows = allRows(guestId, checkpoint, cursor);

  const page = rows.slice(0, PAGE_SIZE).map((r) => ({
    key: r.key,
    kind: r.kind,
    dead: r.dead,
    parts: r.parts,
    href: r.href,
    thumb: r.thumb,
    badge: r.badge,
    badgeArtHtml: r.badgeArtHtml,
    glyph: r.glyph,
    when: r.when,
    whenLabel: relativeTime(r.when),
    unread: checkpoint !== null && r.when > checkpoint,
  }));

  return { rows: page, hasMore: rows.length > PAGE_SIZE };
}

// Cheap counting statements — deliberately NOT the full union above (getRecap
// runs a heavier merge that this issue's plan explicitly avoids paying for on
// every request — plan step 5: "never the full union, because step 6 runs it
// on every request for every guest"). Each reuses the matching source's own
// `_EXISTENCE_WHERE` constant (defined once, above the FETCH statements) so
// the count is STRUCTURALLY unable to disagree with what the list would
// render for the same checkpoint — not just "kept in sync by convention."
const stmtUnreadEventCount = db.prepare(
  `SELECT COUNT(*) AS n FROM notification_events ne WHERE ${EVENT_EXISTENCE_WHERE} AND ne.created_at > ?`
);
const stmtUnreadCommentCount = db.prepare(`
  SELECT COUNT(*) AS n
    FROM comments c
    JOIN submissions s ON s.id = c.submission_id
   WHERE ${COMMENT_EXISTENCE_WHERE}
     AND c.created_at > ?
`);
// DISTINCT submission_id — a chip counts ONE row per liked photo, matching
// the batched row the list renders, never a per-like count (issue #644 AC2:
// "8 new likes on one photo and one badge earned" reads 2, not 9).
const stmtUnreadLikeSubmissionCount = db.prepare(`
  SELECT COUNT(DISTINCT s.id) AS n
    FROM likes l
    JOIN submissions s ON s.id = l.submission_id
   WHERE ${LIKE_EXISTENCE_WHERE}
`);

/**
 * How many recap ROWS are currently unread for this guest — "it must count
 * what the list renders" (issue #644 plan step 5): the batched-like row
 * counts once per photo, never once per like.
 *
 * This is three independent per-source COUNT queries, not a count derived
 * from allRows/getRecap — deliberately, since getRecap's job is a bounded
 * PAGE, and a guest can have far more than one page of unread rows (the
 * count must still be exact for all of them). Each COUNT's WHERE clause
 * shares its `_EXISTENCE_WHERE` constant (defined above the FETCH
 * statements, issue #644 review — the source registry) with the matching
 * FETCH query storedRows/commentRows/likeBatchRows runs, so the two are
 * STRUCTURALLY unable to disagree about which rows exist for a given
 * checkpoint — not "kept in lockstep by hand," the failure mode this JSDoc
 * used to flag and leave unfixed. #778 adding a new stored/derived source
 * (an announcement source with its own existence rule) follows the same
 * shape: define that source's own `_EXISTENCE_WHERE` constant once, reuse it
 * in both its FETCH statement and its new fourth COUNT statement here, and
 * the same structural guarantee extends to it automatically.
 * @param {number} guestId
 * @returns {number}
 */
function getUnreadCount(guestId) {
  const checkpoint = checkpointFor(guestId);
  if (checkpoint === null) {
    return 0;
  }
  const events = stmtUnreadEventCount.get(guestId, checkpoint).n;
  const comments = stmtUnreadCommentCount.get(guestId, checkpoint).n;
  const likes = stmtUnreadLikeSubmissionCount.get(guestId, checkpoint).n;
  return events + comments + likes;
}

const stmtMarkSeen = db.prepare(
  `UPDATE guests SET recap_checked_at = datetime('now') WHERE id = ?`
);

/**
 * Advance this guest's recap checkpoint to now. The ONLY writer of
 * guests.recap_checked_at once db.js's one-time migration backfill has run
 * (POST /recap/seen, src/routes/guest.js, is the sole caller). Dismissing
 * the strip must NEVER call this (issue #644 design: "Dismiss hides, never
 * marks read") — only opening the recap panel does, from either entry point.
 * @param {number} guestId
 */
function markSeen(guestId) {
  stmtMarkSeen.run(guestId);
}

module.exports = {
  recordEvent,
  getRecap,
  getUnreadCount,
  markSeen,
};
