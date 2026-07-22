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

const { db } = require('../db');
const notifications = require('./notifications');

// Given more than one badge newly owed at once (e.g. the fifth submission
// crosses both a task-count threshold badge plus COMPLETIONIST crossed by
// the same submission, or a second badge granted elsewhere before the first
// was ever celebrated), the modal celebrates a single PRIMARY badge by this
// fixed priority (design, #255). The rest stay owed — genuinely owed, not
// just displayed-and-forgotten — and get paid one at a time on a later page
// render (issue #644 plan step 4).
const BADGE_MOMENT_PRIORITY = ['GARDEN', 'BOUQUET', 'BLOOM', 'COMPLETIONIST'];

// Every guest_badges row this guest holds that has never been shown its #255
// celebration (celebrated_at IS NULL) — "owed" by construction, since no
// grant call site in scoring.js ever writes celebrated_at non-NULL (see
// db.js's ensureGuestBadgeCelebratedAtColumn doc comment). Joined to the
// badge catalog so resolveBadgeMoment below never needs a second query.
//
// The EXISTS clause requires a matching notification_events 'badge_granted'
// row — i.e. the badge arrived through one of this app's REAL grant paths
// (recomputeBadges, recomputeTransferableBadges, awardSpecialBadge, every
// one of which calls notifications.recordEvent right beside the grant).
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

/**
 * Resolve THIS guest's one owed badge celebration for the render about to
 * happen, and mark it paid — the shared helper every guest-facing render
 * path calls (issue #644 plan step 4), so a badge is celebrated exactly once
 * no matter which page happens to render first. Not a per-route decision:
 * withBadgeMoment below is the ONE call site that invokes this, and every
 * res.render() in src/routes/guest.js and src/routes/community.js goes
 * through it.
 *
 * "Owed" is derived straight from guest_badges.celebrated_at (see
 * stmtOwedBadges above) rather than from the one-shot taskComplete reward
 * cookie — a badge granted by the recompute while the guest was on another
 * page, or awarded by a host through POST /admin/guests/:id/badge, is
 * exactly as owed as one just earned by the submission that redirected here,
 * and this single query covers all three sources without asking which one
 * fired (issue #644 AC1).
 *
 * MUST be called only where a page is about to render (never from
 * attachGuest middleware, which runs on every request including a POST that
 * redirects without rendering anything — stamping there would consume a
 * celebration on a request the guest never actually saw, recreating the
 * #563 defect this issue absorbs).
 *
 * @param {number} guestId
 * @returns {{code:string, name:string, art_path:string, description:string}|null}
 */
function resolveBadgeMoment(guestId) {
  const owed = stmtOwedBadges.all(guestId);
  if (owed.length === 0) {
    return null;
  }
  let primary = null;
  for (const code of BADGE_MOMENT_PRIORITY) {
    primary = owed.find((b) => b.code === code);
    if (primary) {
      break;
    }
  }
  if (!primary) {
    primary = owed[0];
  }
  stmtStampCelebrated.run(guestId, primary.badge_id);
  return {
    code: primary.code,
    name: primary.name,
    art_path: primary.art_path,
    description: primary.description,
  };
}

/**
 * Merge `extra` with the render-time-only locals every guest page needs:
 * `badgeMoment`, plus the recap panel's first page (`recapRows`/
 * `recapHasMore`). The single call site every res.render() in
 * src/routes/guest.js and src/routes/community.js passes through, so neither
 * can be missed by a route that forgets to wire it in by hand.
 *
 * Both locals share the identical timing constraint and are bundled here for
 * that reason, not because they are the same concern: `badgeMoment` MUST be
 * computed only at actual render time because resolveBadgeMoment above has a
 * side effect (the celebrated_at stamp) that must never fire on a request
 * whose response the guest never sees; `recapRows`/`recapHasMore` MUST be
 * computed only at actual render time because notifications.getRecap is
 * comparatively expensive (three source queries + a JS merge-sort, even
 * though issue #644's review bounded each source with a LIMIT) and running
 * it from attachGuest middleware — which runs on every request, including a
 * POST that redirects without ever rendering a page — paid that cost for no
 * reason on every request in the app, not just the ones that render a guest
 * page. src/middleware/session.js's attachGuest still computes the cheap
 * unread COUNT on every request (notifications.getUnreadCount), because the
 * strip/profile-row chip legitimately needs it on every render and it is a
 * handful of indexed COUNT(*) queries, not this full page assembly.
 *
 * A signed-out render (should not happen behind requireGuest, but this
 * module is also reachable indirectly) gets badgeMoment: null and an empty
 * recap page rather than throwing on a missing guest id.
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
    return Object.assign({ badgeMoment: null, recapRows: [], recapHasMore: false }, extra);
  }
  const badgeMoment = resolveBadgeMoment(guest.id);
  const firstPage = notifications.getRecap(guest.id);
  return Object.assign(
    { badgeMoment: badgeMoment, recapRows: firstPage.rows, recapHasMore: firstPage.hasMore },
    extra
  );
}

module.exports = { withBadgeMoment };
