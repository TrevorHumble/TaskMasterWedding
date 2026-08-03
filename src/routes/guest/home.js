// src/routes/guest/home.js
// GET /  — the guest's own home / own-stats page (issue #991 split, seam
// table area "home.js").

'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined.
const { db, getEventConfig } = require('../../db');

// eventDays is the ONE "what day is it for the event, and when does a given
// day open" owner (issue #753) — always the event's configured timezone
// (db.getEventConfig().timezone), never server UTC.
const eventDays = require('../../services/event-days');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../../services/scoring');

// The 'u<id>'/'t<id>'/'m' scope-token grammar's single owner (issue #952 PR
// review) — GET / below calls feed.scopeToken to hand My Photos' tile grid
// its own already-tokenized scope, rather than the view hand-concatenating
// 'u' + guest.id the way it did before this fix. No other export of this
// module is used here; community.js remains the primary feed.js consumer.
const feed = require('../../services/feed');

// The shared badge-moment stamp (issue #644 plan step 4) — see that module's
// header comment for why it is a service rather than living here, and why
// it also carries the render-time recap-page attachment. The router-wide
// invariant (every res.render() across src/routes/guest/ passes through it)
// is stated once in the entry's area map, src/routes/guest.js.
const { withBadgeMoment } = require('../../services/render-locals');

// reachableLiveTaskCount (issue #754) — the single owner of "how many live
// tasks can this guest actually reach" (shared with pages.js's GET
// /how-to-play), see src/routes/guest/shared.js's own doc comment.
const { reachableLiveTaskCount } = require('./shared');

// ---------------------------------------------------------------------------
// GET /  — the guest's own home / profile page.
// Shows: points, badges (with art), and a task-completion progress bar
// (completed tasks vs total active tasks).
// ---------------------------------------------------------------------------
router.get('/', function (req, res) {
  const guest = res.locals.guest;

  // Total live tasks (guests only ever see live tasks), minus any sealed
  // one-day-only challenge the mystery-box ceiling suppresses (issue #754) —
  // reachableLiveTaskCount is the single owner of this derivation (#754),
  // shared with GET /how-to-play, so this progress bar can
  // never count a challenge a guest can never actually reach.
  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);
  const totalActiveCount = reachableLiveTaskCount(todayIso, guest.id);

  // Completed tasks for this guest, routed through scoring.getCompletedCount
  // (issue #104) so this count can never drift from points, which use the
  // same canonical rule (visible submissions, no liveness filter). Badges no
  // longer use this rule alone (issue #1060): the auto-badge thresholds now
  // key on scoring.thresholdCompletedCount, this same figure plus the
  // profile-photo starter's own contribution (starter.done_count, added into
  // completedTasksWithStarter below). A guest with a photo therefore has a
  // badge input exactly one higher than the bare completedTasks this
  // comment describes; #1057's next-badge nudge must derive its remaining
  // count from thresholdCompletedCount, not from this getCompletedCount call.
  const completedTasks = scoring.getCompletedCount(guest.id);

  // Issue #409: the hardcoded "Upload your profile photo" starter task is a
  // real task from the guest's point of view — it renders as a counted row in
  // the /tasks list and shows in Done once the avatar is set. This home
  // progress bar counts it the same way (via the single owner
  // scoring.starterTaskContribution, shared with GET /tasks) so a guest who
  // has completed it never sees it sitting in Done while the headline still
  // reads "0 of N".
  const starter = scoring.starterTaskContribution(guest);
  const totalTasks = totalActiveCount + starter.total;
  const completedTasksWithStarter = completedTasks + starter.done_count;

  // Points and badges from the scoring service (section 06 real exports).
  const points = scoring.getPoints(guest.id);
  const badges = scoring.getGuestBadges(guest.id); // each: {code,name,art_path,description,points,...}

  // Issue #1057: the next unearned threshold badge, or null when every
  // threshold is held or the smallest unearned one is out of reach. The
  // ceiling is totalTasks (below), not totalActiveCount: once #1060 landed
  // the starter task counts on the completion side (thresholdCompletedCount),
  // so it must count on the reachable side too, or a threshold exactly equal
  // to the real task count would be judged unreachable and the row would
  // hide when it should show. Both sides of this reachability comparison
  // count the same set; that identity is the invariant, not any particular
  // variable name.
  const nextBadge = scoring.nextThresholdBadge(guest.id, totalTasks);

  // The guest's own (non-taken-down) submissions, newest first, joined to
  // task title so we can label each thumbnail on the home page. LEFT JOIN
  // (not JOIN): a memory (issue #247, task_id IS NULL) has no task row to
  // join, and must still appear in My Photos with task_title coming back
  // NULL — the view falls back to the memory's own caption instead (AC8).
  const submissions = db
    .prepare(
      `SELECT s.id, s.task_id, s.photo_path, s.thumb_path, s.caption,
              s.created_at, t.title AS task_title
         FROM submissions s
         LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.guest_id = ?
          AND s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(guest.id);

  // Progress bar reflects task completion (X of Y), not badge thresholds.
  // Issue #88 removed an earlier "next badge" framing because it
  // contradicted this bar whenever the highest badge threshold was
  // unreachable given the active task count. Issue #1057 brought the nudge
  // back (nextBadge, above) in a reachability-gated form: it renders only
  // when the next threshold is at or below totalTasks, so it can never
  // repeat that broken promise.
  //
  // completedTasks uses the canonical count (visible submissions, NO
  // liveness filter) while totalTasks counts only live tasks, so a guest
  // who completed a task the admin later hid can have
  // completedTasks > totalTasks. Both guest-facing renderings of this pair —
  // the bar's aria-valuenow/width and the caption's "N of T" text — must
  // never show a numerator past its denominator, so the bound is computed
  // ONCE here and both derive from it (issue #717; #88 is the precedent for
  // why a second, independently-written clamp on the same rule is a defect,
  // not a style choice).
  const clampedCompletedTasks = Math.min(completedTasksWithStarter, totalTasks);

  // clampedCompletedTasks is in [0, totalTasks] by construction, so this
  // ratio is already in [0,1] and the rounded percent is already in
  // [0,100] — no separate Math.max/Math.min guard needed here.
  const progressPercent =
    totalTasks === 0 ? 0 : Math.round((clampedCompletedTasks / totalTasks) * 100);

  res.render(
    'guest-home',
    withBadgeMoment(req, res, {
      title: 'Home',
      points: points,
      badges: badges,
      nextBadge: nextBadge,
      submissions: submissions,
      totalTasks: totalTasks,
      completedTasks: clampedCompletedTasks,
      progressPercent: progressPercent,
      // My Photos' own scope token (issue #952 PR review) — every tile here
      // is this signed-in guest's own photo, so the token is resolved once,
      // here, via feed.scopeToken rather than the view hand-building 'u' +
      // guest.id itself.
      scopeToken: feed.scopeToken({ type: 'guest', id: guest.id }),
    })
  );
});

module.exports = router;
