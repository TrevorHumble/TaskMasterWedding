// src/services/notifications.js
//
// The recap ("what you missed") service — issue #644. The single owner of
// "what does this guest see": unions STORED events (notification_events —
// badge grants/revokes, and moderation kinds #783 will add) with THREE
// DERIVED sources (likes, comments, and — issue #778 — host announcements),
// scoped by the same visibility owners the rest of the app already uses —
// feed.VISIBLE_WHERE for the photo, feed.COMMENT_VISIBLE_WHERE for the
// comment, both re-exported from their single owner (src/services/feed.js)
// rather than re-typed here.
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
// exist at all. An announcement row (issue #778) is EPHEMERAL like a
// like-batch, for the same reason and more strongly so — see this file's
// bottom section for the full announcements design note.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const config = require('../../config');
const { db, getEventConfig } = require('../db');
const { VISIBLE_WHERE, COMMENT_VISIBLE_WHERE } = require('./feed');
const { relativeTime, parseSqliteDatetime, toSqliteDatetime } = require('./relative-time');
const { isIconArtPath } = require('./badge-icons');
const tasks = require('./tasks');
const eventDays = require('./event-days');

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
// it emits badge_granted/badge_revoked/badge_removed itself — the four
// moderation kinds (photo_takedown/photo_restore/comment_hidden/
// comment_restored) get their MAP entries here but are actually EMITTED by
// #783, once that issue lands the moderation routes. #625 adds
// crowd_favorite/crowd_favorite_lost as a THIRD emitter of this same map —
// see scoring.recordCrowdFavoriteChanges, called from the like-toggle route
// and from photos.js's hideSubmission/restoreSubmission.
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
const KIND_VIEW = {
  badge_granted: {
    view: 'badge',
    dead: false,
    parts: (ev) => [{ text: 'You earned ' }, { text: ev.badge_name, emphasis: true }],
    href: () => null,
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
  // Crowd favorites (issue #625). The stored row carries only guest_id +
  // submission_id (scoring.recordCrowdFavoriteChanges' single write path) —
  // rank and points are NEVER stored (a stored rank would be the one thing
  // here that could go stale the moment a later like/takedown/restore moves
  // it), so `parts` below reads the CURRENT placing set live from
  // scoring.crowdFavorites() every time this row renders.
  crowd_favorite: {
    view: 'gold',
    dead: false,
    parts: (ev) => {
      // Lazy require (call-time, not module top level): scoring.js requires
      // this module ('./notifications') at ITS OWN top level (see this
      // file's header comment), so a top-level require('./scoring') here
      // would create a load-order-sensitive cycle — whichever of the two
      // modules happens to load first would see the other's module.exports
      // still mid-assembly at the moment it destructures from it, and every
      // recap render would throw. Deferring to call time sidesteps the cycle
      // entirely, mirroring feed.js's own deferred require('./scoring')
      // inside slideshowSequence.
      const scoring = require('./scoring');
      const placing = scoring.crowdFavorites().find((cf) => cf.submission_id === ev.submission_id);
      if (!placing) {
        // The photo has since left the placing set again (a later like or
        // takedown moved it out between the event being recorded and this
        // render) — degrade to naming it without a stale rank/points rather
        // than showing a number that is no longer true. The corresponding
        // crowd_favorite_lost row (recorded at the moment it actually left)
        // is what carries that story; this row just avoids overclaiming.
        return [{ text: 'Your photo is a ' }, { text: 'crowd favorite', emphasis: true }];
      }
      return [
        { text: "You're the " },
        { text: `#${placing.rank} crowd favorite`, emphasis: true },
        { text: ` — +${placing.points} pts` },
      ];
    },
    href: (ev) => (ev.submission_id != null ? `/p/${ev.submission_id}` : null),
  },
  crowd_favorite_lost: {
    view: 'loss',
    dead: true,
    parts: () => [
      { text: 'Your photo ' },
      { text: 'dropped out', emphasis: true },
      { text: ' of the crowd favorites' },
    ],
    href: () => null,
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
// were both wired here ahead of their own emitters landing (their approved
// CSS already existed — `.recap-icon-gold`, `.recap-row-announce
// .recap-icon`) — `announce` is now used, by this file's own
// announceCandidateRows() below (issue #778); `gold` is still ahead of its
// emitter (#647).
//
// NOT wired here, and staying that way: three PLANNED per-announcement-detail
// glyphs (`day`, `flash`, `task`) an earlier plan floated keeping room for.
// Issue #778's own Design section retired that plan (owner decision,
// 2026-07-21): differentiating the three announcement kinds by glyph is
// unapproved new art, a separable future nicety, not something this issue
// (or any of its acceptance criteria) needs — every announcement row, of all
// three kinds, renders through the single `announce` glyph above. See
// DESIGN.md's "Recap" ADR for the full history of this reversal.
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
         s.thumb_path      AS thumb_path
    FROM notification_events ne
    LEFT JOIN badges b ON b.id = ne.badge_id
    LEFT JOIN submissions s ON s.id = ne.submission_id
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

// ---------------------------------------------------------------------------
// Announcements (issue #778) — host broadcasts ("a task went live", "a
// one-day-only challenge unsealed", "a flash window opened"), the fourth
// recap source this file's header comment and the EXISTENCE-predicate
// section above both already anticipated.
//
// A BROADCAST, not a per-guest fact — the one structural way this source
// differs from the three above it. storedRows/commentRows/likeBatchRows are
// all guest-scoped in SQL (`WHERE ... guest_id = ?` / `s.guest_id = ?`)
// because their underlying fact — "you got a badge", "someone liked YOUR
// photo" — only ever belongs to one guest. An announcement belongs to no
// guest at all; it is a fact about a TASK, and it is "for" every guest whose
// own checkpoint happens to predate it. So ANNOUNCE_EXISTENCE_WHERE below
// carries no guest_id bind (there is nothing to bind it to), and "is this
// announcement for THIS guest" is answered entirely in JS, by comparing the
// fact's own instant to the checkpoint passed in — never derived a second
// time from a stored per-guest row (see this issue's Design section, and
// DESIGN.md's "Recap" ADR, for why a stored broadcast row was rejected:
// notification_events is guest_id-keyed NOT NULL, so broadcasting through it
// would mean either an O(guests) fan-out write per host action or a nullable
// guest_id on the hottest recap read path — neither warranted when every
// fact an announcement asserts is already sitting on the task row itself).
//
// ANNOUNCE_EXISTENCE_WHERE is a NECESSARY, not sufficient, pre-filter: a live
// task with a live_since stamp, a special_date, or a flash trio MIGHT
// announce, depending on how its columns compare to the checkpoint/clock —
// exactly which of the three it actually does (if any) is decided in JS by
// qualifyingAnnounceFacts() below, consuming tasks.isOnDay/flashWindow/
// flashState (the single owners of that state) rather than re-deriving any
// of the three from raw columns here. liveTaskWhere (also the single owner)
// gates ALL three derivations at once — a hidden task can never announce
// under any of the three rules, satisfying issue #778 AC6 structurally
// rather than as a per-derivation check.
const ANNOUNCE_EXISTENCE_WHERE = `${tasks.liveTaskWhere('t')} AND (t.live_since IS NOT NULL OR t.special_date IS NOT NULL OR t.flash_start_at IS NOT NULL)`;

const stmtAnnounceCandidates = db.prepare(`
  SELECT t.id             AS id,
         t.title           AS title,
         t.live_since      AS live_since,
         t.special_date    AS special_date,
         t.flash_start_at  AS flash_start_at,
         t.flash_minutes   AS flash_minutes,
         t.flash_bonus     AS flash_bonus
    FROM tasks t
   WHERE ${ANNOUNCE_EXISTENCE_WHERE}
`);

// toSqliteDatetime (epoch ms -> the exact "YYYY-MM-DD HH:MM:SS" shape every
// `datetime('now')` column in this app writes) is imported from
// relative-time.js above, the single owner of both halves of this
// storage-format rule (parseSqliteDatetime is the other half, also imported
// above) — see that module's header comment. Needed here because two of the
// three announcement facts below (challenge-unseal, flash-open) start life
// as a JS instant (event-days.js's dayOpensAt, tasks.js's flashWindow), not a
// SQLite column, and every row's `when` this whole module produces must
// share one comparable shape — allRows' merge-sort and getRecap's `unread`
// flag both do a bare string comparison against the guest's checkpoint,
// never a parsed-Date comparison (see the "Cross-format datetime
// comparisons" note on qualifyingAnnounceFacts below for the one place that
// shape rule is NOT enough by itself, and why).

/**
 * The composite (when, key) "is this older than the cursor" test every
 * SQL FETCH statement above expresses as a WHERE clause (see the "Bounded,
 * cursor-paged source queries" comment higher in this file) — reimplemented
 * in JS here because the announcements source has no SQL query to attach a
 * WHERE clause to (qualifyingAnnounceFacts below is JS-side by necessity, not
 * choice — see its own doc comment). Same semantics as the SQL version
 * exactly: `cursor` null means "first page, no filtering"; otherwise a row
 * qualifies when strictly older, OR tied on `when` and sorting strictly
 * before on `key`.
 * @param {string} when
 * @param {string} key
 * @param {{when: string, key: string|null}|null} cursor
 * @returns {boolean}
 */
function passesAnnounceCursor(when, key, cursor) {
  if (!cursor) {
    return true;
  }
  if (when < cursor.when) {
    return true;
  }
  return when === cursor.when && cursor.key != null && key < cursor.key;
}

/**
 * Every announcement CURRENTLY true for one checkpoint/clock pair — the
 * announcements source's `_EXISTENCE_WHERE` equivalent (issue #778 plan step
 * 3), consumed by BOTH announceRows (the FETCH path, paged/capped) and
 * announceCount (the COUNT path, exact) below, so the two can no more
 * disagree about which announcements exist than the SQL-backed sources'
 * shared `_EXISTENCE_WHERE` constants can. Unbounded and uncapped on
 * purpose — FETCH_LIMIT/paging is a presentation concern the two callers
 * apply on top, not part of "what exists."
 *
 * Three independent derivations per candidate task, ALL gated live by
 * ANNOUNCE_EXISTENCE_WHERE's SQL already having excluded a hidden task (issue
 * #778 AC6) — a task can qualify under more than one derivation at once (an
 * "and it's a flash today" edge is real), and each becomes its OWN row with
 * its own key, deliberately not deduplicated to one row per task: they are
 * two distinct pieces of news, not one repeated fact.
 *
 * (a) Live-transition: `live_since` is set and newer than the checkpoint —
 *     both sides are the SAME storage shape (`datetime('now')`), so this is
 *     a plain string comparison, identical in spirit to every other
 *     `_EXISTENCE_WHERE` in this file.
 * (b) Challenge unseal: `tasks.isOnDay` says `special_date` is today (the
 *     single owner of that fact, never re-derived here), AND the checkpoint
 *     predates today's event-local START — `eventDays.dayOpensAt` gives that
 *     start as a UTC instant, converted via toSqliteDatetime() to the same
 *     comparable shape as `checkpoint` before comparing (see (c) for why
 *     this conversion is necessary, not optional).
 * (c) Flash open: `tasks.flashState` says ACTIVE as of `clock.nowMs` (the
 *     single owner of that fact), AND the flash's own start instant
 *     (`tasks.flashWindow(t).startMs`, epoch milliseconds) is newer than the
 *     checkpoint. Cross-format datetime comparisons (issue #778 edge case):
 *     `checkpoint` is a whole-SECOND SQLite string; `flash_start_at` is a
 *     UTC ISO instant with MILLISECOND precision
 *     (`YYYY-MM-DDTHH:MM:SS.sssZ`). String-comparing the two directly (the
 *     way (a)/(b) safely can, since every operand there already shares the
 *     same whole-second shape) would be comparing different-precision,
 *     different-punctuation representations of time and can disagree with
 *     the true instant ordering right at a second boundary. So (c) instead
 *     converts BOTH sides to a common basis — epoch milliseconds — via
 *     `parseSqliteDatetime` (checkpoint) and `flashWindow().startMs`
 *     (already milliseconds, no reparsing of `flash_start_at` needed) and
 *     compares those, exactly the discipline this issue's edge-case list
 *     calls for. One accepted, narrow consequence of mixing an
 *     millisecond-precise EXISTENCE test with a whole-second-precise `when`
 *     display value: a flash starting within the same whole SECOND as the
 *     checkpoint can exist (this test) yet render with `unread: false` (
 *     getRecap's own `r.when > checkpoint` re-check, at whole-second
 *     resolution) — the same class of single-second edge DESIGN.md's "Recap"
 *     ADR already documents as an accepted limitation for likes, not a new
 *     gap this issue introduces.
 *
 * A null `checkpoint` (checkpointFor's contract: only a nonexistent guest id)
 * short-circuits to no facts, matching getUnreadCount's own early-return for
 * the same input — not reachable via any real authenticated request, but
 * guarding it here avoids `parseSqliteDatetime(null)` producing a
 * `checkpointMs` of `null` that would then coerce to `0` in a bare `<`
 * comparison and silently over-qualify every flash as "newer than checkpoint".
 *
 * @param {string|null} checkpoint
 * @param {{todayIso: string, nowMs: number, timezone: string}} clock
 * @returns {Array<object>} unsorted, uncapped recap row objects.
 */
function qualifyingAnnounceFacts(checkpoint, clock) {
  if (checkpoint === null) {
    return [];
  }
  const checkpointInstant = parseSqliteDatetime(checkpoint);
  const checkpointMs = checkpointInstant ? checkpointInstant.getTime() : null;

  const facts = [];
  for (const t of stmtAnnounceCandidates.all()) {
    if (t.live_since != null && t.live_since > checkpoint) {
      facts.push({
        key: `announce-live-${t.id}`,
        when: t.live_since,
        parts: [{ text: 'The hosts made ' }, { text: t.title, emphasis: true }, { text: ' live' }],
      });
    }

    if (tasks.isOnDay(t, clock.todayIso)) {
      const dayStart = toSqliteDatetime(eventDays.dayOpensAt(clock.todayIso, clock.timezone).getTime());
      if (checkpoint < dayStart) {
        facts.push({
          key: `announce-unseal-${t.id}`,
          when: dayStart,
          parts: [{ text: t.title, emphasis: true }, { text: ' unseals today' }],
        });
      }
    }

    const win = tasks.flashWindow(t);
    if (
      win &&
      checkpointMs !== null &&
      checkpointMs < win.startMs &&
      tasks.flashState(t, clock.nowMs) === tasks.FLASH_ACTIVE
    ) {
      // Bonus amount AND window length, present tense — the issue's own
      // approved copy ("Flash on now — +3 for 20 minutes",
      // data/wip-issues/778-recap-announcements.md) names both, since both
      // are the actionable "is it worth dropping what I'm doing" facts a
      // guest steered toward this task needs; a bare "a flash bonus is open"
      // (this row's pre-review copy) dropped the two numbers that make it
      // worth acting on.
      const minuteWord = t.flash_minutes === 1 ? 'minute' : 'minutes';
      facts.push({
        key: `announce-flash-${t.id}`,
        when: toSqliteDatetime(win.startMs),
        parts: [
          { text: t.title, emphasis: true },
          { text: ` — flash bonus on now, +${t.flash_bonus} for ${t.flash_minutes} ${minuteWord}` },
        ],
      });
    }
  }

  return facts.map((f) => ({
    key: f.key,
    kind: 'announce',
    dead: false,
    parts: f.parts,
    href: '/tasks',
    thumb: null,
    badge: null,
    badgeArtHtml: null,
    glyph: KIND_GLYPH.announce,
    when: f.when,
  }));
}

/**
 * The FETCH path over qualifyingAnnounceFacts — cursor-filtered, sorted
 * newest-first, capped at FETCH_LIMIT, mirroring the SQL sources' own
 * `ORDER BY ... LIMIT FETCH_LIMIT` shape (issue #778 plan step 3), just done
 * in JS since this source has no SQL query of its own to attach that clause
 * to (see qualifyingAnnounceFacts' doc comment for why).
 * @param {string|null} checkpoint
 * @param {{todayIso: string, nowMs: number, timezone: string}} clock
 * @param {{when: string, key: string|null}|null} cursor
 * @returns {Array<object>}
 */
function announceRows(checkpoint, clock, cursor) {
  const rows = qualifyingAnnounceFacts(checkpoint, clock).filter((r) =>
    passesAnnounceCursor(r.when, r.key, cursor)
  );
  rows.sort((a, b) => {
    if (a.when !== b.when) {
      return a.when < b.when ? 1 : -1;
    }
    return a.key < b.key ? 1 : -1;
  });
  return rows.slice(0, FETCH_LIMIT);
}

/**
 * The COUNT path over qualifyingAnnounceFacts — exact, uncapped (unlike
 * announceRows above), matching the other three sources' COUNT statements'
 * own "never the FETCH-bounded number" discipline (see getUnreadCount's doc
 * comment). Every fact IS unread by construction (an announcement only
 * exists at all while newer than the checkpoint — see qualifyingAnnounceFacts'
 * own doc comment), so the count is simply how many facts exist.
 * @param {string|null} checkpoint
 * @param {{todayIso: string, nowMs: number, timezone: string}} clock
 * @returns {number}
 */
function announceCount(checkpoint, clock) {
  return qualifyingAnnounceFacts(checkpoint, clock).length;
}

/**
 * The recap's request-scoped clock (issue #778) — `{todayIso, nowMs,
 * timezone}`, the shape the announcements source's read-time derivations
 * need. This is the ONE place that object literal is assembled: every real
 * HTTP call site (src/middleware/session.js, src/services/render-locals.js,
 * src/routes/guest.js's `GET /recap`) resolves its OWN `timezone` from
 * `getEventConfig()` and passes it in here, rather than each hand-building the
 * same three-field literal (issue #778 PR review finding: the literal was
 * inlined verbatim in four places, including this module's own fallback
 * below). Injecting `timezone` rather than resolving it inside this function
 * keeps the builder a pure function of its argument — the deliberate
 * purity/testability tradeoff a reviewer noted (this module's own
 * defaultAnnounceClock below resolves it via getEventConfig for callers that
 * have no request timezone to hand). `nowMs` is read
 * fresh on every call, matching the "one clock per request, built once, read
 * fresh — never cached across requests" discipline src/routes/admin.js's
 * currentClock() and src/services/tasks.js's own doc comments establish for
 * every other clock parameter in this app.
 * @param {string} timezone
 * @returns {{todayIso: string, nowMs: number, timezone: string}}
 */
function buildRecapClock(timezone) {
  return {
    todayIso: eventDays.eventLocalDateString(timezone),
    nowMs: Date.now(),
    timezone: timezone,
  };
}

// The default clock (issue #778) for a caller that has no request-scoped
// instant to thread through — delegates to buildRecapClock (this module's
// own timezone-resolving caller, since a non-HTTP caller — e.g. a test, or a
// script — has no request to resolve one from any other way). This fallback
// exists only so getRecap/getUnreadCount stay callable with their PRE-#778
// signature — every test and internal call site written before this issue
// exists calls them with no clock argument at all.
function defaultAnnounceClock() {
  return buildRecapClock(getEventConfig().timezone);
}

/**
 * One bounded, time-ordered (newest first) slice of one guest's recap row
 * set — every STORED event, every visible non-self comment, every unread
 * like-batch, and every currently-true announcement (issue #778), each
 * strictly older than `cursor` (or every one, when `cursor` is null), merged
 * and sorted, capped at FETCH_LIMIT rows PER SOURCE (issue #644 review — the
 * pre-review version pulled every row of every source with no LIMIT at all).
 *
 * Correctness of the per-source FETCH_LIMIT bound: the caller (getRecap)
 * only ever wants the true top PAGE_SIZE rows of this merge, plus whether a
 * (PAGE_SIZE + 1)-th exists. Those top (PAGE_SIZE + 1) rows can include AT
 * MOST (PAGE_SIZE + 1) rows from any ONE of the four sources — trivially,
 * since (PAGE_SIZE + 1) is the total count wanted. So asking each source for
 * its own top FETCH_LIMIT = PAGE_SIZE + 1 rows (in the same order the merge
 * uses) is guaranteed to include the source's full contribution to the true
 * top (PAGE_SIZE + 1), even though it may also include some rows that do
 * NOT end up in that true top (PAGE_SIZE + 1) once merged with the other
 * sources — which is fine, since getRecap only reads this array's sorted
 * prefix and its length, never relies on every returned row being "in the
 * final page."
 *
 * @param {number} guestId
 * @param {string} checkpoint
 * @param {{when: string, key: string|null}|null} [cursor]
 * @param {{todayIso: string, nowMs: number, timezone: string}} clock
 * @returns {Array<object>} newest-first, sorted by (when, key) descending —
 *   callers (getRecap) depend on this exact order for their paging cursor.
 */
function allRows(guestId, checkpoint, cursor, clock) {
  const rows = storedRows(guestId, cursor).concat(
    commentRows(guestId, cursor),
    likeBatchRows(guestId, checkpoint, cursor),
    announceRows(checkpoint, clock, cursor)
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
 * @param {{before?: string, beforeKey?: string, clock?: {todayIso: string, nowMs: number, timezone: string}}} [opts] -
 *   `before`: an ISO-ish SQLite datetime string; rows strictly older (by the
 *   composite (when, key) order, see allRows) are returned. Omit both
 *   `before`/`beforeKey` for the first page. `beforeKey` omitted with
 *   `before` present falls back to a plain `when`-only comparison (see the
 *   source-query comment above). `clock` (issue #778) is the request's
 *   single event-local instant, needed only by the announcements source —
 *   the caller-supplied instant a real HTTP request builds once (see
 *   defaultAnnounceClock's doc comment); omitted, this falls back to a
 *   fresh one so this function's pre-#778 callers (including every test
 *   written before this issue) keep working unchanged.
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
  const clock = opts.clock || defaultAnnounceClock();
  const rows = allRows(guestId, checkpoint, cursor, clock);

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
 * This is four independent per-source counts, not a count derived from
 * allRows/getRecap — deliberately, since getRecap's job is a bounded PAGE,
 * and a guest can have far more than one page of unread rows (the count must
 * still be exact for all of them). The three SQL sources' COUNT statements
 * share their `_EXISTENCE_WHERE` constant (defined above the FETCH
 * statements, issue #644 review — the source registry) with the matching
 * FETCH query storedRows/commentRows/likeBatchRows runs, so the two are
 * STRUCTURALLY unable to disagree about which rows exist for a given
 * checkpoint — not "kept in lockstep by hand," the failure mode this JSDoc
 * used to flag and leave unfixed. The fourth source, announcements (issue
 * #778), follows the identical shape one level up in JS rather than SQL:
 * announceCount() and announceRows() both consume the SAME
 * qualifyingAnnounceFacts(), so they too cannot disagree about which
 * announcements exist for a given checkpoint/clock.
 * @param {number} guestId
 * @param {{todayIso: string, nowMs: number, timezone: string}} [clock] -
 *   issue #778's request-scoped instant, needed only by the announcements
 *   source; omitted, falls back to a fresh one (see defaultAnnounceClock).
 * @returns {number}
 */
function getUnreadCount(guestId, clock) {
  const checkpoint = checkpointFor(guestId);
  if (checkpoint === null) {
    return 0;
  }
  const events = stmtUnreadEventCount.get(guestId, checkpoint).n;
  const comments = stmtUnreadCommentCount.get(guestId, checkpoint).n;
  const likes = stmtUnreadLikeSubmissionCount.get(guestId, checkpoint).n;
  const announces = announceCount(checkpoint, clock || defaultAnnounceClock());
  return events + comments + likes + announces;
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
  buildRecapClock,
};
