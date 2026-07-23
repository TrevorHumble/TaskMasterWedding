// src/services/task-badges.js
//
// Per-task badge resolution and award writing (issue #483).
//
// FOUNDATION RULE: every task owns exactly one `badges` row of its own
// (type='custom', code='TASK-<id>', task_id set to that task). Distinct
// per task, so a guest completing two plain (un-customized) tasks holds two
// distinct badge_ids and never collides on the existing
// guest_badges UNIQUE(guest_id, badge_id) constraint. An un-customized
// task's row points its art_path at the shared DEFAULT_RIBBON_ART_PATH
// FILE — there is no shared catalog ROW; resolveTaskBadge lazily inserts the
// task's own row the first time it is asked for.
//
// This module is the ONLY task-badge write path:
//   - It never calls scoring.createCustomBadge (which is guarded to refuse
//     any TASK- code — see scoring.js's createCustomBadge).
//   - scoring.js's stmtGrantBadge (the system/auto/metric/transferable path)
//     never touches these rows either; awardTaskBadge below is the only
//     writer of an 'admin'-awarded row that carries points/note/submission_id.

'use strict';

const path = require('path');
const config = require('../../config');
const { db } = require('../db');
// The recap's single write path (issue #644), used by releaseRanking below to
// emit one badge_granted event per ranked winner. Safe as a top-level
// require: notifications.js's own requires (config, db, feed [db only, no
// scoring], relative-time [nothing], badge-icons [fs/path/config]) never lead
// back to this file, so this is a one-directional edge, not a cycle — unlike
// the lazy require('./photos') below, which exists purely to break a REAL
// cycle (see that require's own comment).
const notifications = require('./notifications');
// NOT required at top level: photos.js requires scoring.js, and scoring.js
// requires THIS module (for TASK_BADGE_CODE_PREFIX) — a top-level
// `require('./photos')` here would complete the cycle mid-load and capture
// photos.js's exports object before it finishes populating (an empty {},
// since photos.js reassigns module.exports at the bottom of the file rather
// than mutating it in place). unlinkUploadedArt below requires('./photos')
// lazily instead, at call time — by then Node's module cache always holds
// the fully-populated real module (photos.js is required well before any
// badge-art request reaches this function, by admin.js/guest.js at app
// boot), and the require() call itself is free after the first real load.

// The shared default-ribbon artwork every un-customized task badge points
// at (issue #483's "shared file, not a shared catalog row"). A single
// constant so the resolver and every caller agree on the exact path — never
// a literal duplicated at more than one call site.
const DEFAULT_RIBBON_ART_PATH = '/badges/default-ribbon.svg';

// Prefix every host-uploaded art_path carries (photos.urlForOriginal's own
// output shape — see admin.js's POST /tasks/:id/badge, which builds artPath
// via urlForOriginal(filename) before calling setTaskBadge). Anything NOT
// under this prefix is a shared static asset (today, only
// DEFAULT_RIBBON_ART_PATH) and must never be unlinked. Read from
// config.UPLOADS_URL_BASE (issue #508) rather than a local literal — that is
// the single owner of the /uploads mount prefix; config.js has no require
// back into services, so this is safe as a top-level require (unlike the
// lazy require('./photos') below).

// The code prefix every task badge's derived code carries ('TASK-' + taskId).
// The SINGLE owner of this literal: scoring.js's createCustomBadge imports
// it to refuse a freeform admin code starting with the same prefix (AC8)
// rather than hard-coding a second copy of 'TASK-' that could drift from
// the one taskBadgeCode() actually writes.
const TASK_BADGE_CODE_PREFIX = 'TASK-';

/** @param {number} taskId @returns {string} e.g. 'TASK-42' */
function taskBadgeCode(taskId) {
  return TASK_BADGE_CODE_PREFIX + taskId;
}

const stmtBadgeByTaskId = db.prepare('SELECT * FROM badges WHERE task_id = ?');
const stmtInsertTaskBadge = db.prepare(
  `INSERT INTO badges (code, name, type, threshold, art_path, description, task_id)
   VALUES (?, ?, 'custom', NULL, ?, '', ?)`
);
const stmtUpdateTaskBadge = db.prepare(
  `UPDATE badges SET name = ?, art_path = ? WHERE task_id = ?`
);

/**
 * Resolve task `taskId`'s own badge row, lazily inserting the default row
 * (code 'TASK-<id>', type 'custom', name 'Task Badge', art_path the shared
 * default-ribbon SVG) the first time it is asked for. The lazy insert is
 * idempotent — a second (or concurrent-in-the-same-process) call sees the
 * row the first call just wrote and returns it unchanged, never a second
 * row: the partial UNIQUE INDEX on badges(task_id) (src/db.js
 * ensureBadgeTaskIdColumn) would reject a genuine double-insert outright.
 *
 * @param {number} taskId
 * @returns {object} the badges row (freshly inserted, or already customized)
 */
function resolveTaskBadge(taskId) {
  const existing = stmtBadgeByTaskId.get(taskId);
  if (existing) return existing;

  stmtInsertTaskBadge.run(taskBadgeCode(taskId), 'Task Badge', DEFAULT_RIBBON_ART_PATH, taskId);
  return stmtBadgeByTaskId.get(taskId);
}

/**
 * Look up task `taskId`'s own badge row WITHOUT lazily inserting one —
 * unlike resolveTaskBadge, a task that has never been customized (and never
 * had its admin card rendered, which is what actually triggers the lazy
 * insert) returns undefined here rather than creating a row. Callers that
 * are about to delete the task itself (issue #501's task-delete handler) use
 * this instead of resolveTaskBadge: inserting a fresh badges row for a task
 * id that turns out not to exist would violate the badges.task_id FK
 * (REFERENCES tasks(id), foreign_keys=ON — src/db.js), and there is no
 * reason to insert-then-immediately-cascade-delete a row for a task that IS
 * about to be removed anyway.
 *
 * @param {number} taskId
 * @returns {object|undefined} the badges row, or undefined if none exists yet
 */
function getTaskBadge(taskId) {
  return stmtBadgeByTaskId.get(taskId);
}

/**
 * True when `artPath` points at a host-uploaded file under the /uploads
 * mount, as opposed to a shared static asset (today, only
 * DEFAULT_RIBBON_ART_PATH). The SINGLE owner of "is this badge art eligible
 * for deletion" (issue #501) — both setTaskBadge (below) and admin.js's
 * task-delete handler go through this test rather than each re-deriving the
 * /uploads/ prefix check on their own.
 *
 * @param {string|null|undefined} artPath
 * @returns {boolean}
 */
function isUploadedArtPath(artPath) {
  return typeof artPath === 'string' && artPath.startsWith(config.UPLOADS_URL_BASE + '/');
}

/**
 * Unlink `artPath`'s underlying file from disk IF it is a host-uploaded file
 * (isUploadedArtPath) — a no-op for the shared default ribbon SVG, or for any
 * falsy/non-uploaded path, so this can be called unconditionally without the
 * caller having to check eligibility itself. Derives the bare filename via
 * path.basename before handing it to photos.deleteOriginalFile, which joins
 * a BARE filename onto UPLOADS_DIR with no basename sanitization of its own
 * (see that function's doc comment) — path.basename is what keeps this call
 * safe even if a stored art_path were ever something other than the exact
 * "/uploads/<filename>" shape urlForOriginal produces.
 *
 * @param {string|null|undefined} artPath
 */
function unlinkUploadedArt(artPath) {
  if (!isUploadedArtPath(artPath)) return;
  // Lazy require — see the top-of-file note on why this cannot be a
  // top-level `require('./photos')`.
  const photos = require('./photos');
  photos.deleteOriginalFile(path.basename(artPath));
}

/**
 * Project a raw `badges` row down to the shape a renderer is allowed to
 * see: `{name, art_path}`. This is the SINGLE owner of "what a task badge
 * looks like to a renderer" (issue #486 round 2) — resolveTaskBadge's
 * return value is the full internal row (id, code, type, threshold,
 * description, task_id, ...), and every call site that needs to display a
 * task's badge (the guest task list, the admin task board) must go through
 * this function rather than hand-picking fields off that row itself, so the
 * display contract can only ever be defined in one place.
 *
 * @param {object} badgeRow a row as returned by resolveTaskBadge
 * @returns {{name: string, art_path: string}}
 */
function toTaskBadgeView(badgeRow) {
  return { name: badgeRow.name, art_path: badgeRow.art_path };
}

/**
 * Update task `taskId`'s badge name and/or art, resolving (and lazily
 * inserting) it first so this can be called on a task that has never been
 * customized before. An empty/absent `name` or `artPath` leaves that field
 * unchanged rather than blanking it — the admin form posts only the field(s)
 * it actually collected (e.g. art with no new name, or vice versa).
 *
 * Wrapped in a transaction (same reasoning as photos.js's
 * _setTakenDownAndRecount): the resolve-then-update is two statements on a
 * task that has never been customized before, and better-sqlite3's
 * transaction wrapper is what makes that pair atomic against a mid-write
 * crash rather than relying on there being nothing between them to fail.
 *
 * @param {number} taskId
 * @param {{name?: string, artPath?: string}} params
 * @returns {object} the updated badges row
 */
const setTaskBadge = db.transaction((taskId, { name, artPath } = {}) => {
  const badge = resolveTaskBadge(taskId);
  const nextName = name ? name : badge.name;
  const nextArtPath = artPath ? artPath : badge.art_path;

  // Unlink the PRIOR uploaded art file (issue #501) — but only when a new
  // artPath is actually being set (a name-only submit leaves art_path, and
  // therefore this condition, untouched) AND the prior file differs from the
  // incoming one (re-posting the exact same path is a no-op, not a
  // self-delete of the file the write below is about to store again).
  // unlinkUploadedArt's own isUploadedArtPath guard is what keeps
  // DEFAULT_RIBBON_ART_PATH un-deletable (AC2) without a second check here.
  if (artPath && badge.art_path !== nextArtPath) {
    unlinkUploadedArt(badge.art_path);
  }

  stmtUpdateTaskBadge.run(nextName, nextArtPath, taskId);
  return stmtBadgeByTaskId.get(taskId);
});

// ---------------------------------------------------------------------------
// Award write path.
// ---------------------------------------------------------------------------

const stmtSubmissionForAward = db.prepare(
  'SELECT guest_id, taken_down FROM submissions WHERE id = ?'
);
const stmtInsertAward = db.prepare(
  `INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by, points, note, submission_id)
   VALUES (?, ?, 'admin', ?, ?, ?)`
);
const stmtDeleteAwardBySubmission = db.prepare(
  'DELETE FROM guest_badges WHERE badge_id = ? AND submission_id = ?'
);

/**
 * Award task `taskId`'s badge to whoever took submission `submissionId`,
 * carrying `points` and an optional `note` on the award row (guest_badges),
 * not on the badge catalog row — the same task badge can be awarded to
 * different photos with different points/notes (AC4).
 *
 * The grantee is DERIVED from the submission, and the submission must be
 * currently visible (taken_down = 0); a missing or taken-down submission is
 * refused with no row written (returns null) rather than awarding a badge on
 * behalf of a photo the guest can no longer see. `points` is coerced with
 * the same Math.trunc(Number(...)) shape scoring.addBonusPoints uses for its
 * delta, so a non-numeric/NaN input becomes 0 instead of writing NaN into
 * SQLite (SQLite would otherwise happily store the string "NaN") — then
 * floored at 0, mirroring the non-negative invariant the existing per-photo
 * bonus (submissions.photo_bonus) enforces at its own route layer: an
 * award's points is a single Task Master judgment, never a debit.
 *
 * INSERT OR IGNORE on the existing guest_badges UNIQUE(guest_id, badge_id)
 * makes a repeat award to the SAME guest+badge a no-op, matching
 * scoring.js's stmtGrantBadge behavior for every other award path.
 *
 * Wrapped in a transaction: resolveTaskBadge may itself insert the task's
 * first-ever badge row, so an award against a never-customized task is two
 * writes (the lazy badge insert, then the award insert) that must both land
 * or neither should — same reasoning as setTaskBadge above.
 *
 * @param {number} taskId
 * @param {number} submissionId
 * @param {{points: number, note?: string}} params
 * @returns {object|null} the awarded badges row, or null if refused
 */
const awardTaskBadge = db.transaction((taskId, submissionId, { points, note } = {}) => {
  const submission = stmtSubmissionForAward.get(submissionId);
  if (!submission || submission.taken_down) {
    return null;
  }
  const badge = resolveTaskBadge(taskId);
  const amount = Math.max(0, Math.trunc(Number(points)) || 0);
  stmtInsertAward.run(submission.guest_id, badge.id, amount, note || null, submissionId);
  return badge;
});

/**
 * Remove the award task `taskId`'s badge made against submission
 * `submissionId`. No-op if the task has no badge row yet, or no such award
 * exists.
 *
 * @param {number} taskId
 * @param {number} submissionId
 */
function removeTaskAward(taskId, submissionId) {
  const badge = stmtBadgeByTaskId.get(taskId);
  if (!badge) return;
  stmtDeleteAwardBySubmission.run(badge.id, submissionId);
}

// ---------------------------------------------------------------------------
// Ranked release (issue #661) — the host ranks a task's 1-5 best photos and
// releases the badge + 5/4/3/2/1 points in one confirm. This supersedes the
// single-photo awardTaskBadge above as the route-facing write path (that
// module doc comment's "currently zero route callers" note is what this
// issue fills in) — awardTaskBadge/removeTaskAward are left untouched for
// their own existing callers/tests; releaseRanking below is the SEPARATE,
// whole-set-atomic write path GET/POST /admin/tasks/:id/rank uses.
// ---------------------------------------------------------------------------

// Points paid by placement, 1st..5th. The SINGLE server-side owner of the
// rank -> points mapping — src/routes/admin.js's GET /admin/tasks/:id/rank
// and releaseRanking below both read this array, never a re-typed literal.
// src/public/js/admin-badge-rank.js (a static asset with no access to a
// server require) keeps its OWN literal copy of these five numbers for
// INSTANT client-side display only (the live medal/points recompute while
// the host drags, before any POST) — that copy can never be the one that
// decides what gets written; a stale/hacked client value changes nothing,
// because the POST body only ever carries an ORDER of submission ids and
// this array (not the client) turns position into points. If this mapping
// ever changes, the client copy must be updated to match by hand — see that
// file's own comment for the cross-reference back to here.
const POINTS_BY_RANK = [5, 4, 3, 2, 1];

// The most winners a single release may carry (issue #661: "1 to 5", the
// host's choice, never a forced five) — derived from POINTS_BY_RANK's own
// length rather than a second literal `5`, so the two can never disagree.
const MAX_RANKED_WINNERS = POINTS_BY_RANK.length;

// The settings-table marker read by this page's read-only (Awarded) state
// and by #662's dashboard checklist item — same settings table + key-prefix
// idiom as src/services/host-checklist.js's MANUAL_ITEMS ('checklist.<id>')
// and src/services/lockout.js, rather than a dedicated column or table.
const TASK_BADGE_AWARDED_KEY_PREFIX = 'task_badge_awarded.';

function taskBadgeAwardedKey(taskId) {
  return TASK_BADGE_AWARDED_KEY_PREFIX + taskId;
}

const stmtSettingValue = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtUpsertSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

/**
 * Has task `taskId`'s badge ever been released (at least one ranked award
 * written)? The single fact GET /admin/tasks/:id/rank reads to decide between
 * the read-only Awarded state and the live pick/rank editor, and the same
 * fact #662's checklist item reads — both consult this function rather than
 * separately re-deriving "does this badge hold any rank IS NOT NULL award
 * row" from guest_badges, so "is this task's badge awarded" has exactly one
 * owner regardless of caller.
 * @param {number} taskId
 * @returns {boolean}
 */
function isTaskBadgeAwarded(taskId) {
  const row = stmtSettingValue.get(taskBadgeAwardedKey(taskId));
  return !!row && row.value === '1';
}

/**
 * Mark task `taskId`'s badge as released. Called only by releaseRanking
 * below, inside the same transaction that writes the ranked award rows, so
 * the marker and the rows it describes can never observably disagree (a
 * reader either sees both the pre-release state or both the post-release
 * state, never one without the other). There is no corresponding "un-award"
 * in this issue's scope: a re-rank always leaves at least one winner (the
 * release refuses an empty set — see releaseRanking), so nothing in this
 * module ever needs to write the marker back to unset.
 * @param {number} taskId
 */
function markTaskBadgeAwarded(taskId) {
  stmtUpsertSetting.run(taskBadgeAwardedKey(taskId), '1');
}

// Every ranked award currently held on task `taskId`'s badge, read fresh (no
// snapshot) so a page reopened after a takedown/restore or a re-rank always
// reflects the CURRENT guest_badges rows — never a separately-stored copy of
// "who won" that could drift from the one, real award table. LEFT JOIN
// submissions (not JOIN): AC4's own promise is that the award row survives a
// takedown of its earning photo, and this read must keep showing that
// winner's name/rank/points even if their photo's thumb_path briefly
// resolves to a taken-down file (the admin surface already shows taken-down
// photos elsewhere — GET /admin/photos's own "an admin wall shows
// everything" rule) rather than silently dropping the row.
const stmtCurrentRanking = db.prepare(`
  SELECT gb.rank         AS rank,
         gb.points        AS points,
         gb.submission_id AS submission_id,
         g.id             AS guest_id,
         g.name           AS guest_name,
         s.thumb_path     AS thumb_path
    FROM guest_badges gb
    JOIN guests g ON g.id = gb.guest_id
    LEFT JOIN submissions s ON s.id = gb.submission_id
   WHERE gb.badge_id = ? AND gb.rank IS NOT NULL
   ORDER BY gb.rank ASC
`);

/**
 * Task `taskId`'s current ranked winners (empty array if its badge has never
 * been released, or has no badges row yet), ordered 1st..Kth.
 * @param {number} taskId
 * @returns {Array<{rank:number, points:number, submission_id:number|null,
 *   guest_id:number, guest_name:string, thumb_path:string|null}>}
 */
function currentRanking(taskId) {
  const badge = stmtBadgeByTaskId.get(taskId);
  if (!badge) return [];
  return stmtCurrentRanking.all(badge.id);
}

// A placement's own submission, gated on belonging to THIS task and being
// currently visible — releaseRanking's per-entry validity check (below).
const stmtSubmissionForRanking = db.prepare(
  'SELECT id, guest_id, task_id, taken_down FROM submissions WHERE id = ?'
);

// Clears T's WHOLE prior ranked award set in one DELETE (AC6's "atomic
// replace", not a per-photo delete) — scoped to `rank IS NOT NULL` so a
// hypothetical non-ranked award on this same badge (e.g. a single-photo
// awardTaskBadge call from some other caller) is left untouched.
const stmtDeleteRankedAwards = db.prepare(
  'DELETE FROM guest_badges WHERE badge_id = ? AND rank IS NOT NULL'
);

// Explicit UPSERT (issue #661's own callout: the existing stmtInsertAward
// above is INSERT OR IGNORE, which would silently DROP a second guest's
// award, or a re-rank's changed points/rank/submission_id, on the same
// (guest_id, badge_id) pair). ON CONFLICT DO UPDATE is what makes the
// same-guest collapse (AC5) and the re-rank replace (AC6) both land
// correctly: a guest already holding this badge (from an earlier release, or
// collapsed onto within THIS release — see the byGuest fold below) gets
// their row's points/submission_id/rank overwritten, never silently ignored.
const stmtUpsertRankedAward = db.prepare(`
  INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points, note, submission_id, rank)
  VALUES (?, ?, 'admin', ?, NULL, ?, ?)
  ON CONFLICT(guest_id, badge_id) DO UPDATE SET
    points = excluded.points,
    submission_id = excluded.submission_id,
    rank = excluded.rank,
    awarded_by = 'admin'
`);

/**
 * Fold an ORDERED list of {submissionId, guestId} placements (index 0 =
 * 1st place, i.e. rank = index + 1) onto a Map keyed by guestId (AC5's
 * same-guest collapse): the first placement for a guest seeds their entry
 * (points, rank, submissionId); every later placement for the SAME guest
 * only ADDS its points to the running total.
 *
 * Rank/submissionId are never moved off a guest's FIRST-SEEN placement, and
 * that is provably always their BEST one: `rank` is derived from array
 * position (rank = index + 1), a strictly increasing function of `i`, and
 * `resolved`'s own order IS rank order (releaseRanking builds it by walking
 * `submissionIds` in the host's posted 1st..Kth order) — so a guest's first
 * occurrence in the array can never have a HIGHER index, and therefore never
 * a worse rank, than any later occurrence of the same guest. There is no
 * "is this later placement better" branch to speak of: given this function's
 * one real calling contract, "first seen" and "best placement" are the same
 * fact, not two facts kept in sync by a runtime comparison.
 *
 * Pulled out of releaseRanking as its own pure function (no DB access) so the
 * collapse algorithm can be unit-tested directly against a same-guest
 * scenario, independent of whether the real admin route's picking grid can
 * ever hand it one. In production it never can for a SINGLE task's grid:
 * `submissions` carries `UNIQUE(guest_id, task_id)`, so one guest holds at
 * MOST one visible submission for any given task, and every id
 * releaseRanking accepts is validated to belong to that one task — meaning
 * `resolved` (below) can never actually contain two entries sharing a
 * `guestId` today. This function stays correct regardless: it is the single
 * place the collapse rule is defined, so a future caller that resolves
 * placements from a wider set (e.g. a cross-task pick, should one ever ship)
 * inherits the exact same rule with no second implementation to keep in
 * sync, rather than a rule that only happens to hold today because of a
 * constraint this function does not itself enforce or depend on.
 *
 * @param {Array<{submissionId: number, guestId: number}>} resolved
 * @returns {Map<number, {points: number, rank: number, submissionId: number}>}
 */
function foldRankedPlacements(resolved) {
  const byGuest = new Map();
  resolved.forEach((entry, i) => {
    const rank = i + 1;
    const points = POINTS_BY_RANK[i];
    const existing = byGuest.get(entry.guestId);
    if (!existing) {
      byGuest.set(entry.guestId, { points, rank, submissionId: entry.submissionId });
      return;
    }
    existing.points += points;
  });
  return byGuest;
}

/**
 * Release task `taskId`'s badge to the ranked winners named by
 * `submissionIds` (index 0 = 1st place, ..., index K-1 = Kth), replacing
 * this badge's WHOLE prior award set in one transaction (AC6) rather than
 * adding to it. Every element must be a CURRENTLY VISIBLE submission
 * belonging to task `taskId` — the pick grid GET renders only ever offers
 * this task's visible photos as candidates, so an id that fails this check
 * signals a stale or forged post (a photo taken down mid-pick, a tampered
 * form) rather than a real host choice; the WHOLE release is refused (no
 * write at all) rather than silently dropping just the bad entry, which
 * would shift every following rank/points value out from under the host's
 * actual on-screen order without telling them.
 *
 * Same-guest collapse (AC5): a guest who owns two (or more) of the ranked
 * photos holds exactly ONE guest_badges row afterward — points SUMMED
 * across their placements, rank/submission_id pinned to their FIRST (and,
 * per foldRankedPlacements' own doc comment, therefore always their BEST)
 * placement — never two rows tripping guest_badges' UNIQUE(guest_id,
 * badge_id).
 *
 * Emits one 'badge_granted' recap event per WINNING GUEST (issue #644's
 * recordEvent, not per placement — a same-guest collapse still notifies
 * once), carrying that guest's pinned submission so the recap can link to
 * the winning photo (src/services/notifications.js's KIND_VIEW.badge_granted
 * reads the row's rank live via its own gb JOIN, so this event does not
 * need to carry the rank itself). The release never blocks on this — a
 * failure inside recordEvent would abort the whole transaction rather than
 * silently lose an award, but recordEvent itself has no failure mode beyond
 * the same DB the rest of this function already writes to.
 *
 * @param {number} taskId
 * @param {Array<number>} submissionIds - ordered 1st..Kth, 1 <= length <= 5
 * @returns {{badge: object, winners: number}|null} the released badge and
 *   how many distinct guests it now pays, or null if the release was refused
 */
const releaseRanking = db.transaction((taskId, submissionIds) => {
  if (
    !Array.isArray(submissionIds) ||
    submissionIds.length === 0 ||
    submissionIds.length > MAX_RANKED_WINNERS
  ) {
    return null;
  }
  const distinctCount = new Set(submissionIds).size;
  if (distinctCount !== submissionIds.length) {
    // The drag-to-rank UI can never itself produce a duplicate (the picked
    // list IS the membership — issue #661 design), so a duplicate here means
    // a stale or forged post; refuse rather than silently de-duping it.
    return null;
  }

  const resolved = [];
  for (const rawId of submissionIds) {
    const id = Number(rawId);
    const submission = stmtSubmissionForRanking.get(id);
    if (!submission || submission.task_id !== taskId || submission.taken_down) {
      return null;
    }
    resolved.push({ submissionId: id, guestId: submission.guest_id });
  }

  const badge = resolveTaskBadge(taskId);

  // Fold placements onto their guest (AC5) — see foldRankedPlacements' own
  // doc comment for why this collapse lives in its own pure function.
  const byGuest = foldRankedPlacements(resolved);

  stmtDeleteRankedAwards.run(badge.id);

  for (const [guestId, award] of byGuest) {
    stmtUpsertRankedAward.run(guestId, badge.id, award.points, award.submissionId, award.rank);
    notifications.recordEvent(guestId, 'badge_granted', {
      badgeId: badge.id,
      submissionId: award.submissionId,
    });
  }

  markTaskBadgeAwarded(taskId);

  return { badge, winners: byGuest.size };
});

module.exports = {
  DEFAULT_RIBBON_ART_PATH,
  TASK_BADGE_CODE_PREFIX,
  taskBadgeCode,
  resolveTaskBadge,
  getTaskBadge,
  toTaskBadgeView,
  setTaskBadge,
  awardTaskBadge,
  removeTaskAward,
  // Ranked release (issue #661).
  POINTS_BY_RANK,
  MAX_RANKED_WINNERS,
  isTaskBadgeAwarded,
  currentRanking,
  foldRankedPlacements,
  releaseRanking,
  // orphaned-art cleanup (issue #501) — exported for admin.js's task-delete
  // handler and for direct unit testing.
  isUploadedArtPath,
  unlinkUploadedArt,
};
