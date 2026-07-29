// src/services/render-locals.js
//
// Render-time-only guest locals, all sharing one timing constraint: each
// must be computed at the moment a guest page actually renders, never
// earlier (issue #644 review, minor: this file was named badge-moment.js
// while also owning the recap page's first-page assembly — "are not the
// same concern" per withBadgeMoment's own comment below, so the FILE name is
// what was wrong, not the bundling; renamed to what it actually owns rather
// than split, since splitting would turn the "one call site every render
// passes through" guarantee below into two call sites a future route could
// forget to add). Holds the shared #255 celebration-stamp helper (issue #644
// plan step 4) and the render-time recap page one attachment (issue #644
// plan step 5/6 — see withBadgeMoment's own comment below for why the latter
// lives here too).
//
// Both src/routes/guest.js and src/routes/community.js render every
// guest-facing page through withBadgeMoment(req, res, extra) below. This
// module is a SERVICE, not a route: #644's first pass instead bolted
// withBadgeMoment onto src/routes/guest.js's exported Router object
// (`module.exports.withBadgeMoment = withBadgeMoment`) and had
// community.js require it back from guest.js — two ROUTE files requiring
// each other's exports, the same load-order hazard src/services/feed.js's
// own comment on slideshowSequence's deferred `require('./scoring')`
// documents and works around. A service module both routers import downward
// avoids that hazard outright instead of working around it, and keeps a
// database write (stmtStampCelebrated below) out of what read as a pure
// locals-merge helper.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const { db, getEventConfig } = require('../db');
const notifications = require('./notifications');
// rankBadgeCandidates/compareBadgeMoment (issue #714, widened by #902) are
// the single, catalog-derived owner of "which of several newly-owed badges
// wins the celebration slot, and in what order do the rest follow" — no
// badge code is hard-coded anywhere in that ordering rule. Given more than
// one badge newly owed at once (e.g. the fifth submission crosses both a
// task-count threshold badge plus COMPLETIONIST crossed by the same
// submission, or a second badge granted elsewhere before the first was ever
// celebrated), resolveBadgeMoment below passes rankBadgeCandidates the
// guest's own OWED codes (stmtOwedBadges, not reward.newBadgeIds — #644
// replaced the one-shot-cookie source with the celebrated_at-driven one) to
// order the WHOLE set. Only the top (head) is stamped here; the rest ride
// along genuinely owed — not displayed-and-forgotten — as the `badgeQueue`
// render local, paid one at a time by src/routes/guest.js's
// POST /badge-moment/celebrated as badge-moment.js's client-side
// continue-through flow actually shows each one (issue #902 plan step 2/4).
const scoring = require('./scoring');

// Every guest_badges row this guest holds that has never been shown its #255
// celebration (celebrated_at IS NULL) — "owed" by construction for almost
// every grant, since almost no grant call site in scoring.js ever writes
// celebrated_at non-NULL (see db.js's ensureGuestBadgeCelebratedAtColumn doc
// comment). EXCEPTION (issue #894): a transferable-badge re-grant of a badge
// this guest was already told about (notifications.grantWasAnnounced) is
// inserted already-celebrated on purpose — that row is correctly never
// "owed" here, since re-arming this query for it is exactly the replayed-
// dialog bug #894 fixes. Joined to the badge catalog so resolveBadgeMoment
// below never needs a second query.
//
// The EXISTS clause requires a matching notification_events 'badge_granted'
// row — i.e. the badge arrived through one of this app's REAL grant paths
// (recomputeBadges, recomputeTransferableBadges, awardSpecialBadge — each
// calls notifications.recordEvent right beside the grant, EXCEPT the #894
// silent re-grant, which deliberately relies on the event its first grant
// already wrote). This
// 'badge_granted' kind literal is notifications.js's own vocabulary — that
// module owns notification_events and its `kind` values (see its
// grantWasAnnounced/retractGrantAnnouncement, which read/write the identical
// predicate from the write side, issue #894) — this query just reads it.
// AC1 only ever describes those two grant paths ("whether granted by the
// recompute or awarded by a host"); a guest_badges row a test fixture (or a
// future admin tool) writes by hand, bypassing scoring.js entirely, has no
// matching event row and is correctly never "owed" — it also could not
// replay from the recap for the same reason (the row-in-scope emitters are
// notifications.js's only writer of badge rows), so this join keeps
// "auto-opens" and "appears in the recap" answering the same question.
const stmtOwedBadges = db.prepare(`
  SELECT b.id AS badge_id, b.code, b.name, b.art_path, b.description
    FROM guest_badges gb
    JOIN badges b ON b.id = gb.badge_id
   WHERE gb.guest_id = ? AND gb.celebrated_at IS NULL
     AND EXISTS (
       SELECT 1 FROM notification_events ne
        WHERE ne.guest_id = gb.guest_id AND ne.badge_id = gb.badge_id AND ne.kind = 'badge_granted'
     )
`);
const stmtStampCelebrated = db.prepare(
  `UPDATE guest_badges SET celebrated_at = datetime('now') WHERE guest_id = ? AND badge_id = ?`
);

// Issue #902 PR review, major finding 3: the SAME owed-predicate shape as
// stmtOwedBadges above (celebrated_at IS NULL, AND a matching
// notification_events 'badge_granted' row exists), applied as an UPDATE
// instead of a SELECT, resolving the target row by (guest_id, badge CODE)
// rather than by badge_id — the shape src/routes/guest.js's
// POST /badge-moment/celebrated actually has on hand (the client posts a
// code, never an id). Before this, that route hand-wrote its own UPDATE
// whose WHERE checked only `celebrated_at IS NULL` — a SECOND, narrower
// definition of "owed" than stmtOwedBadges', missing the EXISTS half
// entirely, so a guest_badges row a test fixture (or a future admin tool)
// inserted by hand, bypassing scoring.js's real grant paths, was refused by
// the auto-open query above but WOULD have been stampable through the route.
// The EXISTS subquery below correlates against `guest_badges.guest_id` /
// `guest_badges.badge_id` — the very row this UPDATE's own WHERE is
// filtering — which SQLite permits referencing from a subquery nested
// inside that same statement.
const stmtMarkCelebratedByCode = db.prepare(`
  UPDATE guest_badges
     SET celebrated_at = datetime('now')
   WHERE guest_id = ?
     AND celebrated_at IS NULL
     AND badge_id = (SELECT id FROM badges WHERE code = ?)
     AND EXISTS (
       SELECT 1 FROM notification_events ne
        WHERE ne.guest_id = guest_badges.guest_id
          AND ne.badge_id = guest_badges.badge_id
          AND ne.kind = 'badge_granted'
     )
`);

/**
 * Stamp ONE badge (identified by its catalog `code`, the shape the client
 * actually posts) celebrated_at for `guestId` — the single owner of "does
 * this stamp request actually apply," sharing stmtOwedBadges' exact
 * owed-predicate shape above (issue #902 PR review, major finding 3) so a
 * caller can never stamp a row the render-time auto-open query would not
 * itself have offered as owed. src/routes/guest.js's
 * POST /badge-moment/celebrated is the one caller: it maps a `false` return
 * to its 404 (not owed to this guest — unknown code, someone else's badge,
 * or already celebrated), keeping the route itself free of any hand-written
 * SQL for "what counts as owed."
 *
 * @param {number} guestId
 * @param {string} code - the badge's catalog code, as the client posts it.
 * @returns {boolean} true if a row was actually stamped; false if nothing
 *   matched.
 */
function markBadgeCelebrated(guestId, code) {
  const result = stmtMarkCelebratedByCode.run(guestId, code);
  return result.changes > 0;
}

/**
 * Resolve THIS guest's whole owed badge celebration QUEUE for the render
 * about to happen, and mark only the head paid — the shared helper every
 * guest-facing render path calls (issue #644 plan step 4; widened to a queue
 * by issue #902), so a badge is celebrated exactly once no matter which page
 * happens to render first. Not a per-route decision: withBadgeMoment below
 * is the ONE call site that invokes this, and every res.render() in
 * src/routes/guest.js and src/routes/community.js goes through it.
 *
 * "Owed" is derived straight from guest_badges.celebrated_at (see
 * stmtOwedBadges above) rather than from the one-shot taskComplete reward
 * cookie — a badge granted by the recompute while the guest was on another
 * page, or awarded by a host through POST /admin/guests/:id/badge, is
 * exactly as owed as one just earned by the submission that redirected here,
 * and this single query covers all three sources without asking which one
 * fired (issue #644 AC1).
 *
 * Issue #902: previously (#644) only the single winner was resolved and
 * stamped, and every OTHER owed badge stayed untouched for a later page to
 * pick up one at a time (the "drip"). The dialog now drives a client-side
 * continue-through queue instead, so this function resolves and orders the
 * WHOLE owed set up front — via scoring.rankBadgeCandidates, built from
 * getGuestBadges's row shape (carries the `type`/`threshold`
 * compareBadgeMoment ranks on; the bare stmtOwedBadges projection above does
 * not) — but stamps ONLY the head (position 0) here, exactly as the #644
 * single-badge render always did. Positions 1..K-1 (the `queue` half of the
 * return value) are deliberately left owed: src/routes/guest.js's
 * POST /badge-moment/celebrated stamps each one, one at a time, only when
 * badge-moment.js actually shows it via a Continue tap (AC3) — a queued
 * badge the guest never taps (they navigate away, close the tab) stays owed
 * and re-offers itself on the next render, the same safe-abandon posture
 * the old one-per-render drip already had.
 *
 * MUST be called only where a page is about to render (never from
 * attachGuest middleware, which runs on every request including a POST that
 * redirects without rendering anything — stamping there would consume a
 * celebration on a request the guest never actually saw, recreating the
 * #563 defect this issue absorbs).
 *
 * @param {number} guestId
 * @returns {{head: {code:string, name:string, art_path:string, description:string}|null,
 *   queue: Array<{code:string, name:string, art_path:string, description:string}>}}
 */
function resolveBadgeMoment(guestId) {
  const owed = stmtOwedBadges.all(guestId);
  if (owed.length === 0) {
    return { head: null, queue: [] };
  }
  // scoring.rankBadgeCandidates(guestId, codes) looks up the guest's
  // currently HELD badges (getGuestBadges), filters to the codes given, and
  // orders the WHOLE result by compareBadgeMoment's catalog-derived
  // type/threshold/code ordering (issue #714, widened by #902) — no badge
  // code hard-coded anywhere in the rule. Every owed badge is, by
  // construction, a guest_badges row this guest currently holds
  // (stmtOwedBadges above selects FROM guest_badges), so passing it the owed
  // codes finds exactly those rows within the held set.
  const ordered = scoring.rankBadgeCandidates(
    guestId,
    owed.map((b) => b.code)
  );
  if (ordered.length === 0) {
    // Unreachable in practice (every owed code is a held code by
    // construction, above), but resolveBadgeMoment's own contract is "return
    // nothing to celebrate" — degrade to that rather than stamping a
    // celebration for a badge this guest doesn't actually hold.
    return { head: null, queue: [] };
  }
  const toBadgeView = (b) => ({
    code: b.code,
    name: b.name,
    art_path: b.art_path,
    description: b.description,
  });
  const head = ordered[0];
  stmtStampCelebrated.run(guestId, head.badge_id);
  return {
    head: toBadgeView(head),
    queue: ordered.slice(1).map(toBadgeView),
  };
}

/**
 * Merge `extra` with the render-time-only locals every guest page needs:
 * `badgeMoment` (the head of the owed queue, stamped) plus `badgeQueue` (the
 * remainder, still owed — issue #902), plus the recap panel's first page
 * (`recapRows`/`recapHasMore`). The single call site every res.render() in
 * src/routes/guest.js and src/routes/community.js passes through, so none of
 * the four can be missed by a route that forgets to wire it in by hand.
 *
 * All four locals share the identical timing constraint and are bundled here
 * for that reason, not because they are the same concern: `badgeMoment`/
 * `badgeQueue` MUST be computed only at actual render time because
 * resolveBadgeMoment above has a side effect (the head's celebrated_at stamp)
 * that must never fire on a request whose response the guest never sees;
 * `recapRows`/`recapHasMore` MUST be computed only at actual render time
 * because notifications.getRecap is comparatively expensive (three source
 * queries + a JS merge-sort, even though issue #644's review bounded each
 * source with a LIMIT) and running it from attachGuest middleware — which
 * runs on every request, including a POST that redirects without ever
 * rendering a page — paid that cost for no reason on every request in the
 * app, not just the ones that render a guest page. src/middleware/session.js's
 * attachGuest still computes the cheap unread COUNT on every request
 * (notifications.getUnreadCount), because the strip/profile-row chip
 * legitimately needs it on every render and it is a handful of indexed
 * COUNT(*) queries, not this full page assembly.
 *
 * A signed-out render (should not happen behind requireGuest, but this
 * module is also reachable indirectly) gets badgeMoment: null, an empty
 * badgeQueue, and an empty recap page rather than throwing on a missing
 * guest id.
 *
 * A HEAD request never reaches a guest: Express's res.send (which res.render
 * routes through) computes the full body then discards it for a HEAD
 * request, but it discards it AFTER this function has already run — so
 * without this guard, a HEAD request carrying a guest cookie would stamp a
 * badge's celebrated_at (issue #644 review finding) and consume a
 * celebration the guest never actually received. Since nothing computed
 * here can ever reach a HEAD response body, skip both queries entirely
 * rather than merely skipping the stamp.
 *
 * @param {object} req
 * @param {object} res
 * @param {object} [extra]
 * @returns {object}
 */
function withBadgeMoment(req, res, extra) {
  const guest = res.locals.guest;
  if (!guest || (req && req.method === 'HEAD')) {
    return Object.assign(
      { badgeMoment: null, badgeQueue: [], recapRows: [], recapHasMore: false },
      extra
    );
  }
  const moment = resolveBadgeMoment(guest.id);
  // Issue #778: the announcements source reads task liveness/seal/flash
  // state AT an instant, so getRecap needs this render's own clock — this
  // file resolves its own timezone and hands it to
  // notifications.buildRecapClock, the one place the clock's shape is
  // assembled (src/middleware/session.js's getUnreadCount call and
  // src/routes/guest.js's GET /recap route build theirs the same way).
  const clock = notifications.buildRecapClock(getEventConfig().timezone);
  const firstPage = notifications.getRecap(guest.id, { clock: clock });
  return Object.assign(
    {
      badgeMoment: moment.head,
      badgeQueue: moment.queue,
      recapRows: firstPage.rows,
      recapHasMore: firstPage.hasMore,
    },
    extra
  );
}

module.exports = { withBadgeMoment, markBadgeCelebrated };
