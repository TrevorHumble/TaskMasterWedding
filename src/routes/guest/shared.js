// src/routes/guest/shared.js
// The single home of every guest-route limiter instance (issue #991 split,
// widened by #1021), plus two shared helpers: suppressedChallengeIds +
// reachableLiveTaskCount (the one-box-ceiling derivation, shared by
// home.js/tasks.js/pages.js). Not every limiter housed here is itself shared
// across area modules -- see each construction site's own comment below for
// which are and which have exactly one consumer.
'use strict';

const config = require('../../../config');

const { db } = require('../../db');

// createRateLimiter/guestOrIpKey for the three limiter instances constructed
// below (uploadRateLimiter/socialRateLimiter shared, clientErrorRateLimiter
// solo): see each construction site's own doc comment for the per-limiter
// detail.
const { createRateLimiter, guestOrIpKey } = require('../../middleware/rate-limit');

// The one active-task owner (issue #727) — every liveness check/count below
// consults tasks.liveTaskWhere()/isTaskLive() instead of a hand-written
// is_active/special_mode predicate.
const tasks = require('../../services/tasks');

// ---------------------------------------------------------------------------
// The one-box ceiling (issue #754, owner rule 2026-07-20): of every LIVE
// one-day-only challenge currently sealed, at most ONE is ever shown to a
// guest — the one unlocking soonest. This function is the SINGLE owner of
// which task ids that ceiling removes; GET / (home.js), GET /tasks (tasks.js)
// and GET /how-to-play (pages.js) each call it (GET / and GET /how-to-play
// via reachableLiveTaskCount below; GET /tasks directly, since it also needs
// the row list) instead of
// re-deciding the rule three times (the same "no second copy" reasoning
// src/views/tasks.ejs's own comment gives for not re-deciding rows the server
// already decided), so the /tasks chips, the home progress bar and the
// how-to-play mission count can never disagree about which challenges are
// suppressed.
//
// A challenge the guest has already completed is excluded from the sealed
// set entirely (#754) — it can never itself be
// suppressed (so a task re-dated into the future after the guest already
// submitted for it stays visible in Done, title and all) and it never
// consumes the one-box slot a still-locked challenge needs (so a completed
// sealed challenge sitting alongside an incomplete one can no longer suppress
// the only card that should render). #755's refusal rule — blocking a host
// from re-dating a task that already has submissions — is the PRIMARY guard
// against this situation ever arising; this exclusion is defence in depth,
// not a substitute for it.
//
// The tie-break comparator is total (#754 — a second
// challenge sharing the exact same special_date must resolve to one
// deterministic survivor, not whichever happens to sort first in `rows`):
// special_date, then sort_order, then id. Earlier versions relied on `rows`
// arriving pre-sorted `sort_order ASC, id ASC` and Array#sort's stability to
// preserve that order on a special_date tie — a caller obligation nothing
// enforced. Sorting on all three keys here means the result can never depend
// on the order `rows` arrives in, so there is no precondition left to state.
//
// @param {{id: number, special_date?: string|null, sort_order?: number,
//   done?: number|boolean}[]} rows - live tasks.
// @param {string} todayIso - event-local "today" (eventDays.eventLocalDateString).
// @returns {Set<number>} ids of the sealed challenges NOT shown to a guest.
// ---------------------------------------------------------------------------
function suppressedChallengeIds(rows, todayIso) {
  const sealed = rows.filter(function (t) {
    // isValidDateString guards the ceiling the same way GET /tasks' own
    // isDatedChallenge mapping (src/routes/guest/tasks.js) guards
    // locked/isToday/unlockAt
    // (#754): special_date is a free-form TEXT column, and
    // isSealed's plain string comparison treats a regex-invalid value like
    // '2026-08-1' as sorting ABOVE a valid '2026-08-06' (string '>' compares
    // character by character, and '1' > '0'), which could put a garbage row
    // into the sealed set ahead of a real one-day-only challenge and
    // suppress the real one instead. Without this guard that garbage row
    // never even renders as its own card (it isn't a real dated challenge),
    // so the guest sees NO mystery box at all — the same zero-locked-rows
    // outcome MAJOR A fixed, through a different door.
    return tasks.isValidDateString(t.special_date) && tasks.isSealed(t, todayIso) && !t.done;
  });
  sealed.sort(function (a, b) {
    if (a.special_date < b.special_date) return -1;
    if (a.special_date > b.special_date) return 1;
    const aSort = a.sort_order || 0;
    const bSort = b.sort_order || 0;
    if (aSort !== bSort) return aSort - bSort;
    return a.id - b.id;
  });
  const suppressed = new Set();
  for (let i = 1; i < sealed.length; i++) {
    suppressed.add(sealed[i].id);
  }
  return suppressed;
}

// ---------------------------------------------------------------------------
// The reachable-live-task COUNT (#754): the same
// "how many live tasks can this guest actually reach" derivation GET / and
// GET /how-to-play both need — live tasks minus whatever suppressedChallengeIds
// removes. Before this helper existed, both routes hand-wrote the identical
// query + suppressedChallengeIds call + `length - size` subtraction; this is
// now the one owner both call instead. Takes `guestId` (not just `todayIso`)
// because the MAJOR A exclusion above depends on per-guest completion — the
// query joins submissions the same way GET /tasks' own query does, so a
// challenge THIS guest completed is never treated as sealed here either.
//
// @param {string} todayIso - event-local "today" (eventDays.eventLocalDateString).
// @param {number} guestId
// @returns {number} count of live tasks reachable by this guest, post-ceiling.
// ---------------------------------------------------------------------------
function reachableLiveTaskCount(todayIso, guestId) {
  const rows = db
    .prepare(
      `SELECT t.id, t.special_date, t.sort_order,
              CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS done
         FROM tasks t
         LEFT JOIN submissions s
                ON s.task_id = t.id
               AND s.guest_id = ?
               AND s.taken_down = 0
        WHERE ${tasks.liveTaskWhere('t')}
        ORDER BY t.sort_order ASC, t.id ASC`
    )
    .all(guestId);
  const suppressedIds = suppressedChallengeIds(rows, todayIso);
  return rows.length - suppressedIds.size;
}

// Route-level rate limiting (issue #283). DISTINCT from services/rate-limit
// (required by src/routes/guest/memories.js), which keeps owning POST
// /memories and the HEIC-decode throttle — see src/middleware/rate-limit.js's
// file comment for the boundary. All three instances below are guest-keyed
// (guestOrIpKey, falling back to an IP bucket when signed out); whether that
// fallback branch is live differs between the three -- see clientErrorRateLimiter's
// own comment below, and src/app.js's mount comment, for which one and why.
// uploadRateLimiter is SHARED between POST /tasks/:id/submit (tasks.js), POST
// /me/edit, and POST /me/avatar/delete (both in profile.js) — one combined
// per-guest budget, config.RATE_LIMIT_UPLOAD_MAX;
// socialRateLimiter is SHARED between POST /bug-report, POST /recap/seen
// (issue #644), and POST /badge-moment/celebrated (issue #902) — one combined budget, config.RATE_LIMIT_SOCIAL_MAX — a
// SEPARATE instance from the one src/routes/community.js creates for /like +
// /comments, even though both read the same config value.
//
// Constructed here, ONCE, at module load (issue #991) — Node's require cache
// guarantees a single instance of each however many area modules require
// this file. Two instances per limiter would silently double the combined
// budget each was meant to enforce.
const uploadRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.RATE_LIMIT_UPLOAD_MAX,
  keyFn: guestOrIpKey,
});
const socialRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.RATE_LIMIT_SOCIAL_MAX,
  keyFn: guestOrIpKey,
});

// clientErrorRateLimiter (issue #1021) is its OWN instance, budget
// config.CLIENT_ERROR_RATE_MAX -- never shared with socialRateLimiter above.
// A looping client-side crash posting to /client-error must never burn the
// budget POST /bug-report (the human fallback channel) depends on. Its one
// consumer, src/routes/guest/client-error.js, is not gated by requireGuest --
// see src/app.js's mount comment for why that makes its IP branch a real,
// reachable bucket rather than a defensive default.
const clientErrorRateLimiter = createRateLimiter({
  windowMs: () => config.RATE_LIMIT_WINDOW_MS,
  max: () => config.CLIENT_ERROR_RATE_MAX,
  keyFn: guestOrIpKey,
});

module.exports = {
  suppressedChallengeIds,
  reachableLiveTaskCount,
  uploadRateLimiter,
  socialRateLimiter,
  clientErrorRateLimiter,
};
