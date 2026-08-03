// src/services/scoring/badge-engine.js
// Auto/metric/transferable badge grant-revoke engine plus admin hand-award
// (issue #969). badgeByCode(code) is exported (issue #969 AC2's shared-
// statement rule, PR review fix): it wraps the private stmtBadgeByCode
// statement, consumed here AND by guest-badges.js's badgeWithHolders (the
// badge detail page), so the statement itself lives in exactly one place
// rather than being re-prepared in both, without handing every caller a raw
// prepared statement to misuse. Requires ./points for getCompletedCount and
// starterTaskContribution (thresholdCompletedCount's two terms, issue #1060),
// one-directional (points.js never requires this file back), so no cycle.
'use strict';

const { db, AUTO_METRIC_BADGE_POINTS } = require('../../db');
const { METRIC_BADGES, TRANSFERABLE_BADGES } = require('../badges');
const { TASK_BADGE_CODE_PREFIX } = require('../task-badges');
// The recap's single write path (issue #644 plan step 2/3) — notifications.js
// requires '../db', './feed', and './relative-time' (relative-time.js
// requires nothing further). This DOES put a cycle-shaped edge in the graph:
// this file (reached via src/services/scoring.js's entry) -> notifications.js
// -> feed.js -> scoring.js, since feed.js requires the scoring ENTRY back
// (for slideshowSequence's badge-points ranking), which in turn requires
// this file. That back-edge is safe for the identical reason the direct
// scoring -> feed -> scoring edge already was before notifications.js
// existed: feed.js's own require of './scoring' is DEFERRED (called inside
// slideshowSequence's function body, not at feed.js's top level — see
// feed.js's own comment on that require), so it only resolves after every
// module already mid-load (this file included) has finished its initial
// evaluation, no matter how many hops of top-level requires lead into
// feed.js in between.
const notifications = require('../notifications');
const { getCompletedCount, starterTaskContribution } = require('./points');

// ---------------------------------------------------------------------------
// Canonical auto-badge thresholds. These MUST match the seeded `badges` rows
// (section 02 seed.js): BLOOM=5, BOUQUET=10, GARDEN=15 against the threshold
// count (thresholdCompletedCount below: visible task-linked submissions plus
// the profile-photo starter task, issue #1060).
//
// Two shapes are exported on purpose:
//   - BADGE_THRESHOLDS: array of { code, n } objects, used internally by
//     recomputeBadges to map a code to its threshold number.
//   - AUTO_THRESHOLDS:  plain array of numbers [5, 10, 15], used by section 04
//     for numeric comparisons and progress-bar math. It is derived from
//     BADGE_THRESHOLDS so the two can never drift apart.
// These are the single source of truth for the threshold numbers used in UI
// copy and tests.
// ---------------------------------------------------------------------------
const BADGE_THRESHOLDS = [
  { code: 'BLOOM', n: 5 },
  { code: 'BOUQUET', n: 10 },
  { code: 'GARDEN', n: 15 },
];

// Plain numeric thresholds, e.g. [5, 10, 15]. Section 04 imports THIS one for
// `completedTasks < AUTO_THRESHOLDS[i]` style comparisons and progress math.
const AUTO_THRESHOLDS = BADGE_THRESHOLDS.map((b) => b.n);

// Look up a badge row by its code (e.g. 'BLOOM', 'EARLYBIRD'). Private —
// callers outside this file use the badgeByCode(code) wrapper exported
// below, never this statement directly (issue #969 PR review fix: a raw
// exported Statement let a consumer call an internal better-sqlite3 method
// on it, e.g. .pluck()/.raw(), that this file's own call sites never use and
// never verified).
const stmtBadgeByCode = db.prepare('SELECT * FROM badges WHERE code = ?');

/**
 * Look up a badge row by its code (e.g. 'BLOOM', 'EARLYBIRD'), or undefined
 * if no badge carries it. The one exported entry point onto the private
 * stmtBadgeByCode statement above — guest-badges.js's badgeWithHolders (the
 * badge detail page) calls this instead of importing the statement itself.
 * @param {string} code
 * @returns {object|undefined}
 */
function badgeByCode(code) {
  return stmtBadgeByCode.get(code);
}

// Does this guest already hold this badge? (returns the guest_badges row or undefined)
const stmtGuestBadge = db.prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

// Grant a badge to a guest. UNIQUE(guest_id, badge_id) prevents duplicates;
// "INSERT OR IGNORE" makes a repeat grant a harmless no-op (a repeat call
// with a different `points` value does NOT update the existing row — the
// grant call sites below only ever call this when the guest does not yet
// hold the badge, so that never matters in practice).
//
// `points` (issue #709) is the ONE place a grant decides whether holding
// this badge is worth anything: the two recomputeBadges branches below pass
// AUTO_METRIC_BADGE_POINTS for an auto/metric grant, while
// recomputeTransferableBadges and awardSpecialBadge pass 0 — a transferable
// or admin-special badge stays a display-only award. Whatever is written
// here is exactly what stmtAwardPointsSum/leaderboard later sum on read; no
// other statement in this file writes guest_badges.points for a system/
// admin grant — this remains the ONE statement that does so, issue #894
// included (see the `alreadyAnnounced` param below, not a second INSERT).
//
// `alreadyAnnounced` (0 or 1, issue #894) is the ONLY thing that varies
// celebrated_at at grant time: 1 stamps celebrated_at = now in the same
// INSERT (a transferable re-grant of a badge notifications.grantWasAnnounced
// says this guest was already told about — see recomputeTransferableBadges'
// grant branch below); every other call site passes 0, leaving celebrated_at
// NULL (omitted from the CASE's ELSE, so SQLite's column default — no
// default, hence NULL — applies exactly as it did before this column had a
// writer here at all).
const stmtGrantBadge = db.prepare(
  `INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by, points, celebrated_at)
   VALUES (?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)`
);

// Remove a specific badge from a guest.
const stmtRevokeBadge = db.prepare('DELETE FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

/**
 * Revoke one guest's SYSTEM-granted transferable badge, used only by
 * recomputeTransferableBadges' holder-set diff below. Retracts the badge's
 * badge_granted announcement FIRST, before the row it describes is deleted,
 * if — and only if — the guest never actually saw it celebrated (issue #894:
 * the module boundary is deliberate here — notifications.js owns
 * notification_events and its `kind` vocabulary, so scoring.js asks it to
 * retract rather than deleting the row itself). A celebrated row is left
 * alone: that announcement already happened and stands. badge_revoked itself
 * is always emitted, unchanged by #894 (issue #644 AC4: the guest_badges row
 * this deletes is the only record the badge was ever held).
 * @param {number} guestId
 * @param {{id: number}} badge - a badges catalog row.
 */
function revokeBadgeRetractingUnannounced(guestId, badge) {
  // existingRow is guaranteed to exist here, not merely likely: guestId came
  // from existingSystemHolders, read from the SAME guest_badges table (by
  // badge_id + awarded_by = 'system', a broader predicate this per-guest
  // lookup narrows under UNIQUE(guest_id, badge_id)) moments earlier inside
  // this SAME db.transaction, and better-sqlite3 is fully synchronous /
  // single-threaded — no concurrent write can have deleted it in between.
  const existingRow = stmtGuestBadge.get(guestId, badge.id);
  if (existingRow.celebrated_at === null) {
    notifications.retractGrantAnnouncement(guestId, badge.id);
  }
  stmtRevokeBadge.run(guestId, badge.id);
  notifications.recordEvent(guestId, 'badge_revoked', { badgeId: badge.id });
}

/**
 * Grant one guest a transferable badge — SYSTEM-awarded, points = 0 (issue
 * #709: transferable badges stay display-only) — used only by
 * recomputeTransferableBadges' holder-set diff below. If notifications.
 * grantWasAnnounced says this guest was already told about this badge (a
 * flap: revoked and re-granted as a side effect of another guest's like,
 * issue #894), the row is restored already-celebrated (the `1` flag to
 * stmtGrantBadge) and no second badge_granted event is written; otherwise
 * this is a genuine first grant (or one whose never-celebrated prior event
 * revokeBadgeRetractingUnannounced just retracted) and gets announced
 * normally.
 * @param {number} guestId
 * @param {{id: number}} badge - a badges catalog row.
 */
function grantBadgeAnnouncingOnce(guestId, badge) {
  const alreadyAnnounced = notifications.grantWasAnnounced(guestId, badge.id);
  stmtGrantBadge.run(guestId, badge.id, 'system', 0, alreadyAnnounced ? 1 : 0);
  if (!alreadyAnnounced) {
    notifications.recordEvent(guestId, 'badge_granted', { badgeId: badge.id });
  }
}

// All badges of a given type (used by recomputeTransferableBadges to walk
// every 'transferable' catalog row without hard-coding a code list here).
const stmtBadgesByType = db.prepare('SELECT * FROM badges WHERE type = ?');

// Every 'system'-awarded holder of one badge (used by recomputeTransferableBadges
// to diff the current holder set against the freshly computed one).
const stmtSystemHoldersOfBadge = db.prepare(
  "SELECT guest_id FROM guest_badges WHERE badge_id = ? AND awarded_by = 'system'"
);

// Every guest id, used by recomputeAfterTaskChange to re-run the per-guest
// pass for the whole event (issue #701). An empty guests table yields an
// empty array, so the for-of loop below is a no-op — no guest, no crash.
const stmtAllGuestIds = db.prepare('SELECT id FROM guests');

// ---------------------------------------------------------------------------
// Auto-badge grant/revoke
// ---------------------------------------------------------------------------

// A guest's avatar_path alone, read for thresholdCompletedCount below. The
// existing guest-row read that already carries avatar_path
// (points.js's stmtBonusPoints) is module-private and not exported (issue
// #1060), so this is a second, narrower statement over the same column for
// this file's own need. starterTaskContribution (required from ./points
// above) stays the single owner of what avatar_path MEANS (done, points,
// counts): this statement only supplies the raw row it reads.
const stmtGuestAvatarPath = db.prepare('SELECT avatar_path FROM guests WHERE id = ?');

/**
 * The single owner of "what counts toward a badge threshold" (issue #1060):
 * a guest's visible, task-linked submission count (getCompletedCount) plus
 * the profile-photo starter task's own contribution, read through
 * starterTaskContribution (src/services/scoring/points.js), the single owner
 * of the avatar_path rule. Exported so a caller elsewhere on screen (the
 * next-badge nudge) counts the exact same way recomputeThresholdBadges below
 * grants against, so the two numbers can never disagree: that agreement is
 * the whole reason this function exists rather than staying a local
 * expression inside recomputeThresholdBadges.
 * @param {number} guestId
 * @returns {number}
 */
function thresholdCompletedCount(guestId) {
  const completed = getCompletedCount(guestId);
  const guestRow = stmtGuestAvatarPath.get(guestId);
  const starter = starterTaskContribution(guestRow);
  return completed + starter.done_count;
}

/**
 * The next unearned threshold badge this guest could still reach, or null
 * when every threshold is already held, or when the smallest unearned
 * threshold exceeds `reachableTaskCount` (issue #1057). The single owner of
 * the next-badge nudge derivation: reads thresholdCompletedCount (issue
 * #1060) rather than the bare getCompletedCount, so the remaining count this
 * returns and the count recomputeThresholdBadges grants on are always the
 * same scale (AC7) and can never disagree.
 *
 * BADGE_THRESHOLDS is already ordered ascending (5, 10, 15), so the first
 * entry with `n > completed` is the smallest reachable-or-not next
 * threshold. Reachability is then a single comparison against
 * `reachableTaskCount`, the caller's own denominator (GET / passes
 * `totalTasks`, the same figure the progress caption prints). This
 * function never recomputes that count itself, so the two can never use a
 * different set.
 *
 * name/art_path are read via the exported badgeByCode(code) wrapper above,
 * never a second `SELECT … FROM badges` beside the private stmtBadgeByCode
 * it already owns. A missing catalog row (e.g. the stag variant deliberately
 * has no GARDEN entry, scripts/badge-catalog.js, while BADGE_THRESHOLDS still
 * lists it) returns null here too: that branch is reachable in production,
 * not merely defensive.
 *
 * @param {number} guestId
 * @param {number} reachableTaskCount - the same denominator the progress
 *   caption prints (active reachable tasks plus the profile-photo starter).
 * @returns {{code: string, name: string, art_path: string, threshold: number, remaining: number}|null}
 */
function nextThresholdBadge(guestId, reachableTaskCount) {
  const completed = thresholdCompletedCount(guestId);
  const next = BADGE_THRESHOLDS.find(({ n }) => n > completed);
  if (!next || next.n > reachableTaskCount) {
    return null;
  }
  const badge = badgeByCode(next.code);
  if (!badge) {
    return null;
  }
  return {
    code: badge.code,
    name: badge.name,
    art_path: badge.art_path,
    threshold: next.n,
    remaining: next.n - completed,
  };
}

/**
 * Recompute the three AUTO threshold badges (BLOOM/BOUQUET/GARDEN) for one
 * guest, keyed on thresholdCompletedCount (issue #1060) rather than the bare
 * task-submission count. Split out of recomputeBadges (below) so a caller
 * that only needs the threshold pass, an avatar write (POST /me/edit,
 * POST /me/avatar/delete), never also runs the METRIC_BADGES loop: granting
 * COMPLETIONIST off an avatar write, at an event with no live tasks, would be
 * a real, unasked-for product change (isCompletionist qualifies trivially on
 * an empty active-task set), and this narrow function is what keeps that
 * from happening.
 *
 * `revokeKind` (issue #1060) is the notification_events.kind recorded on a
 * revoke, defaulting to 'badge_revoked' so recomputeBadges below (and every
 * other existing caller) is unchanged. Only POST /me/avatar/delete passes
 * 'badge_revoked_photo', naming the profile photo as the reason a threshold
 * badge was lost.
 *
 * Idempotent, and wrapped in its own transaction so the (possibly multiple)
 * grant/revoke writes either all apply or none do.
 *
 * @param {number} guestId
 * @param {string} [revokeKind='badge_revoked']
 */
const recomputeThresholdBadges = db.transaction((guestId, revokeKind = 'badge_revoked') => {
  const completed = thresholdCompletedCount(guestId);

  for (const { code, n } of BADGE_THRESHOLDS) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Badge catalog not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const has = stmtGuestBadge.get(guestId, badge.id);

    if (completed >= n) {
      // Threshold met: grant if missing. awarded_by = 'system'. Carries
      // AUTO_METRIC_BADGE_POINTS (issue #709) — an auto badge is worth +1
      // for as long as the guest holds it; revocation below deletes the
      // row, so the point leaves with no separate scoring step.
      if (!has) {
        // Flag 0 — celebrated_at stays NULL (issue #894's flag param is only
        // ever 1 for recomputeTransferableBadges' announced-re-grant path
        // above; every per-guest auto/metric grant is a plain first grant).
        stmtGrantBadge.run(guestId, badge.id, 'system', AUTO_METRIC_BADGE_POINTS, 0);
        // Issue #644: emit right beside the grant, where the badge identity
        // is already in scope — celebrated_at starts NULL (the 0 flag just
        // above), so this badge is "owed" the instant this row exists.
        notifications.recordEvent(guestId, 'badge_granted', { badgeId: badge.id });
      }
    } else {
      // Threshold no longer met: revoke ONLY if it was a system grant.
      // (Defensive: an auto badge should always be system-granted, but we
      // never want to delete an admin-awarded badge by accident.)
      if (has && has.awarded_by === 'system') {
        stmtRevokeBadge.run(guestId, badge.id);
        // Issue #644 AC4: the guest_badges row this DELETE just removed is
        // the only record of the badge ever having been held — the event
        // row is what lets the recap outlive it. revokeKind lets the
        // caller (issue #1060) say WHY, defaulting to the original reason.
        notifications.recordEvent(guestId, revokeKind, { badgeId: badge.id });
      }
    }
  }
});

/**
 * Recompute every PER-GUEST badge kind for one guest: (a) the three AUTO
 * threshold badges, via recomputeThresholdBadges above, keyed on
 * thresholdCompletedCount (issue #1060: visible task-linked submissions plus
 * the profile-photo starter), and (b) every 'metric' badge in the registry
 * (src/services/badges.js METRIC_BADGES), grant if its compute function
 * returns true, revoke the system row if it returns false. Special and
 * custom (admin-awarded) badges are NEVER touched here. This function only
 * ever writes/deletes `awarded_by = 'system'` rows (AC4).
 *
 * Idempotent: running it repeatedly produces the same end state, so it is
 * safe to call after every submit, takedown, or restore.
 *
 * Wrapped in a transaction so the (possibly multiple) grant/revoke writes
 * either all apply or none do. Nesting recomputeThresholdBadges' own
 * transaction inside this one is safe: better-sqlite3 nests transaction
 * functions via SAVEPOINTs.
 *
 * @param {number} guestId
 */
const recomputeBadges = db.transaction((guestId) => {
  recomputeThresholdBadges(guestId);

  for (const code of Object.keys(METRIC_BADGES)) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Catalog row not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const qualifies = METRIC_BADGES[code](guestId);
    const has = stmtGuestBadge.get(guestId, badge.id);

    if (qualifies) {
      // Same AUTO_METRIC_BADGE_POINTS grant as the auto branch above — a
      // metric badge (e.g. COMPLETIONIST) is worth +1 for as long as the
      // guest holds it (issue #709).
      if (!has) {
        // Flag 0 — see the auto-badge branch above for why this is always 0 here.
        stmtGrantBadge.run(guestId, badge.id, 'system', AUTO_METRIC_BADGE_POINTS, 0);
        notifications.recordEvent(guestId, 'badge_granted', { badgeId: badge.id });
      }
    } else if (has && has.awarded_by === 'system') {
      stmtRevokeBadge.run(guestId, badge.id);
      // Issue #644 AC4 — same "row-in-hand" reasoning as the auto branch
      // above (e.g. Completionist revoked when the active task set changes).
      notifications.recordEvent(guestId, 'badge_revoked', { badgeId: badge.id });
    }
  }
});

/**
 * Recompute every 'transferable' badge GLOBALLY (not per-guest): for each
 * transferable catalog row, compute its current holder set from the registry
 * (src/services/badges.js TRANSFERABLE_BADGES), then replace that badge's
 * `awarded_by = 'system'` rows with exactly that set — revoking anyone who
 * dropped out and granting anyone who newly qualifies (including ties, AC2).
 * Admin-awarded rows on the same badge code are never touched (AC4), though
 * in practice a transferable code is refused at admin-award time (AC5) so
 * that case should not arise.
 *
 * Wrapped in a transaction. better-sqlite3 nests transaction functions via
 * SAVEPOINTs, so calling this from inside another db.transaction (e.g.
 * photos.js's hide/restore transaction) is safe.
 */
const recomputeTransferableBadges = db.transaction(() => {
  const transferableCatalog = stmtBadgesByType.all('transferable');

  for (const badge of transferableCatalog) {
    const computeHolders = TRANSFERABLE_BADGES[badge.code];
    if (!computeHolders) {
      // A 'transferable' catalog row with no registered rule — skip rather
      // than crash (defensive; every seeded transferable badge should have one).
      continue;
    }

    const currentHolders = computeHolders();
    const existingSystemHolders = new Set(
      stmtSystemHoldersOfBadge.all(badge.id).map((row) => row.guest_id)
    );

    // Plain set diff — a guest who dropped out of the current holder set is
    // revoked, one who newly entered it is granted. Issue #894's
    // announcement-memory rule lives inside the two helpers above, not here.
    for (const guestId of existingSystemHolders) {
      if (!currentHolders.has(guestId)) {
        revokeBadgeRetractingUnannounced(guestId, badge);
      }
    }
    for (const guestId of currentHolders) {
      if (!existingSystemHolders.has(guestId)) {
        grantBadgeAnnouncingOnce(guestId, badge);
      }
    }
  }
});

/**
 * The single recompute seam a data-mutating caller invokes after a submission
 * change (new/replaced submission, takedown, restore). Runs the per-guest
 * pass (auto + metric) and THEN the global transferable pass, in that order —
 * the order that would keep a transferable badge consistent with the
 * guest's just-changed visible-submission count, if any transferable badge
 * is registered (none currently is, #711).
 *
 * This exists so no mutator has to remember the ordered pair itself: a future
 * mutator that adopts only recomputeBadges (forgetting recomputeTransferableBadges)
 * would silently desync any future transferable badge. Both mutators
 * (submissions.js, photos.js) go through here instead.
 *
 * Itself a db.transaction, and better-sqlite3 nests transaction functions via
 * SAVEPOINTs, so it is safe to call from inside photos.js's existing
 * hide/restore transaction as well as standalone from submissions.js.
 *
 * @param {number} guestId - the guest whose submission set just changed.
 */
const recomputeAfterSubmissionChange = db.transaction((guestId) => {
  recomputeBadges(guestId);
  recomputeTransferableBadges();
});

/**
 * The all-guests generalization of recomputeAfterSubmissionChange (issue
 * #701): the seam a caller invokes after the ACTIVE-TASK SET changes
 * (add/hide/un-hide/delete a task) rather than after one guest's own
 * submissions change. Every metric badge (COMPLETIONIST) depends on the
 * current active-task set, not just on the guest who happened to trigger the
 * write, so a task-set change can make ANY guest's Completionist stale —
 * this runs the per-guest pass (auto + metric) for every guest, then the
 * global transferable pass once, same ordered pair and same reasoning as
 * recomputeAfterSubmissionChange.
 *
 * Always runs the FULL pass (not a Completionist-only shortcut) because a
 * task delete cascades its submissions away, which moves the inputs to the
 * count-based auto badges (BLOOM/BOUQUET/GARDEN) and any registered
 * transferable badges too, not just COMPLETIONIST. For add/hide/
 * un-hide, which touch no submission, the auto/transferable recompute for
 * each guest is simply a cheap no-op (their inputs did not change) — no
 * separate code path is worth the duplication.
 *
 * Idempotent (inherited from recomputeBadges/recomputeTransferableBadges,
 * both idempotent themselves) and a safe no-op on an event with zero guests
 * (the for-of loop below just never runs).
 *
 * Itself a db.transaction, and better-sqlite3 nests transaction functions
 * via SAVEPOINTs, so it is safe to call from inside another db.transaction
 * if a future caller needs to.
 */
const recomputeAfterTaskChange = db.transaction(() => {
  const guestIds = stmtAllGuestIds.all();
  for (const { id } of guestIds) {
    recomputeBadges(id);
  }
  recomputeTransferableBadges();
});

// ---------------------------------------------------------------------------
// Special (hand-awarded) badges
// ---------------------------------------------------------------------------

// Badge types the admin may hand-award/remove. 'metric' and 'transferable'
// are system-owned (computed by recomputeBadges/recomputeTransferableBadges)
// and are deliberately excluded here — an admin award/remove request for
// either is refused (issue #80 AC5), so recompute's exclusive ownership of
// those rows can never be bypassed by hand.
const ADMIN_AWARDABLE_TYPES = new Set(['special', 'custom']);

/**
 * Admin hand-awards a SPECIAL or CUSTOM badge to a guest.
 * Validates that the code exists and is of an admin-awardable type (so this
 * can never be used to fake an auto/metric/transferable badge). awarded_by =
 * 'admin'. No-op if already held.
 *
 * @param {number} guestId
 * @param {string} code  a 'special' or 'custom' badge code
 * @returns {boolean} true if a badge was granted (or already present), false if the code was invalid/refused
 */
function awardSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || !ADMIN_AWARDABLE_TYPES.has(badge.type)) {
    return false;
  }
  // ADMIN_AWARDABLE_TYPES is 'special'/'custom' only — never auto/metric
  // (issue #709) — so this grant carries points = 0, unchanged from before
  // #709. Flag 0 (issue #894's flag is only ever 1 for
  // recomputeTransferableBadges' announced-re-grant path) — a host award is
  // always a plain grant, celebrated_at stays NULL.
  const info = stmtGrantBadge.run(guestId, badge.id, 'admin', 0, 0);
  // Issue #644 AC5: stmtGrantBadge is INSERT OR IGNORE, so a host re-awarding
  // a badge the guest already holds (or a double-submitted award form) is a
  // real possibility — info.changes is 0 for that no-op INSERT, and only a
  // REAL state change (a new row actually written) gets an event.
  if (info.changes > 0) {
    notifications.recordEvent(guestId, 'badge_granted', { badgeId: badge.id });
  }
  return true;
}

/**
 * Admin removes a SPECIAL or CUSTOM badge from a guest.
 * Only removes admin-awardable badge types so this can never strip an
 * auto/metric/transferable (system-owned) badge.
 *
 * @param {number} guestId
 * @param {string} code
 * @returns {boolean} true if the code was a valid admin-awardable badge, false otherwise
 */
function removeSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || !ADMIN_AWARDABLE_TYPES.has(badge.type)) {
    return false;
  }
  const info = stmtRevokeBadge.run(guestId, badge.id);
  // Issue #644 AC5: the DELETE is unguarded (no held-check first), so a
  // remove request for a badge the guest doesn't hold is a real possibility
  // — info.changes is 0 for that no-op DELETE, and only a real state change
  // gets an event. 'badge_removed', not 'badge_revoked' (issue #644 review,
  // PR finding): this is a HOST-INITIATED removal (a mistakenly-given
  // special/custom badge taken back), a different event from a threshold
  // recompute revoking an auto/metric/transferable badge — the two need
  // different recap copy (notifications.js's KIND_VIEW.badge_removed says
  // so plainly, badge_revoked's "the hosts added a task" reason would be
  // false here), so they are different stored kinds rather than one kind
  // pretending to cover both reasons.
  if (info.changes > 0) {
    notifications.recordEvent(guestId, 'badge_removed', { badgeId: badge.id });
  }
  return true;
}

/**
 * Admin creates a new host-defined CUSTOM badge in the catalog.
 * Refuses to create a badge whose type is 'metric' or 'transferable'
 * (system-owned types — AC5), or whose code begins with the reserved
 * 'TASK-' prefix (issue #483 AC8 — that prefix is reserved for the per-task
 * badges task-badges.js manages, which never go through this function):
 * either way no row is written and the function returns null. `code` must
 * otherwise be unique (the DB's UNIQUE constraint enforces this; a
 * duplicate throws SqliteError like any other catalog insert would).
 *
 * @param {{code: string, name: string, type: string, artPath: string, description?: string}} params
 * @returns {object|null} the inserted badge row, or null if refused
 */
function createCustomBadge({ code, name, type, artPath, description }) {
  if (!ADMIN_AWARDABLE_TYPES.has(type)) {
    return null;
  }
  if (typeof code === 'string' && code.startsWith(TASK_BADGE_CODE_PREFIX)) {
    return null;
  }
  const info = db
    .prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .run(code, name, type, artPath, description || '');
  return db.prepare('SELECT * FROM badges WHERE id = ?').get(info.lastInsertRowid);
}

module.exports = {
  BADGE_THRESHOLDS,
  AUTO_THRESHOLDS,
  badgeByCode,
  thresholdCompletedCount,
  nextThresholdBadge,
  recomputeThresholdBadges,
  recomputeBadges,
  recomputeTransferableBadges,
  recomputeAfterSubmissionChange,
  recomputeAfterTaskChange,
  awardSpecialBadge,
  removeSpecialBadge,
  createCustomBadge,
};
