// src/routes/guest/pages.js
// GET /how-to-play, GET /how-points-work — the static rules pages (issue #991
// split, seam table area "pages.js").

'use strict';

const express = require('express');
const router = express.Router();

// markGuestOnboarded (issue #564) is the single writer of guests.onboarded
// outside its own schema default — called below from GET /how-to-play.
const { markGuestOnboarded, getEventConfig } = require('../../db');

// eventDays is the ONE "what day is it for the event, and when does a given
// day open" owner (issue #753) — always the event's configured timezone
// (db.getEventConfig().timezone), never server UTC.
const eventDays = require('../../services/event-days');

const { withBadgeMoment } = require('../../services/render-locals');

// scoring.autoBadgeRows() (issue #1094) — the single source of the milestone
// badges' current names/thresholds, read here so GET /how-points-work's
// sentence tracks an admin's Configuration-page edit instead of a hard-coded
// literal.
const scoring = require('../../services/scoring');

// reachableLiveTaskCount (issue #754) — the single owner of "how many live
// tasks can this guest actually reach" (shared with home.js's GET /), see
// src/routes/guest/shared.js's own doc comment.
const { reachableLiveTaskCount } = require('./shared');

// ---------------------------------------------------------------------------
// GET /how-to-play  — the one-screen rules card (issue #246). Reachable from
// the profile menu (a plain GET, no query string). ?first=1 (still honored
// via req.query.first below) shows the "Skip for now" link for a guest
// mid-first-run; nothing currently redirects here with it since #244 retired
// the separate /onboard step.
//
// taskCount is the LIVE count of active tasks (owner directive: never a
// hard-coded number, so the copy tracks admin changes to the task list).
// The closing button always links to /tasks (the task board), never an
// individual task — issue #663: the owner wants the guest landing on the
// whole list to choose where to start, not dropped into one arbitrarily
// picked first-undone task.
// ---------------------------------------------------------------------------
router.get('/how-to-play', function (req, res) {
  const guest = res.locals.guest;

  // Same exclusion as GET / and GET /tasks (issue #754) — a sealed one-day-only
  // challenge the mystery-box ceiling suppresses must not inflate this "N
  // photo tasks" count past what a guest can actually reach.
  // reachableLiveTaskCount is the single owner (#754), shared
  // with GET /'s progress-bar denominator.
  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);
  const taskCount = reachableLiveTaskCount(todayIso, guest.id);

  // Issue #564: mark the guest onboarded on the RENDER of the rules, not on
  // arrival at the route — a guest who somehow never reaches the render
  // below is not marked, so they see the rules again next time (AC2). This
  // route runs behind src/routes/guest.js's router.use(requireGuest), so
  // res.locals.guest is always a real row here; markGuestOnboarded's falsy-id guard is defensive
  // only. Idempotent by design (see markGuestOnboarded's own comment) — an
  // already-onboarded guest re-reading this page (AC5) just writes the same
  // 1 again, no state change that matters.
  markGuestOnboarded(guest.id);

  res.render(
    'how-to-play',
    withBadgeMoment(req, res, {
      title: 'How to play',
      taskCount: taskCount,
      showSkip: req.query.first === '1',
    })
  );
});

// GET /how-points-work — the points-breakdown page reached from the
// "How to earn points" button on the how-to-play card (issue #818). Every
// row's titles/tags/description is fixed copy in the view EXCEPT the
// milestone-badges row (issue #1094): its sentence is composed here from
// scoring.autoBadgeRows() (the same DB-backed thresholds the admin
// Configuration page writes) plus the clean-sweep badge name, owned once by
// scoring.cleanSweepBadgeName() (src/services/scoring/badge-engine.js)
// rather than variant-hard-coded — scripts/badge-catalog.js's upsert already
// re-syncs `name` to the variant's own catalog entry ("Completionist"
// wedding, "Last Call" stag) on every boot, so reading it here instead of a
// local isStag ternary can never disagree with what the catalog actually
// seeded. At the seeded default thresholds (5/10/15 wedding, 5/10 stag) this
// composes to the exact bytes the old hard-coded copy rendered (AC7): "Rack
// up tasks and badges land on their own: <name> at <n>[, <name> at <n>...],
// <CleanSweep> for the clean sweep." — a flat comma list with no "and",
// matching the original literal's own punctuation exactly, so the
// render-identical claim holds without a second hand-typed template string
// to keep in sync.
router.get('/how-points-work', function (req, res) {
  const cleanSweepName = scoring.cleanSweepBadgeName();
  const milestoneParts = scoring
    .autoBadgeRows()
    .map((b) => `${b.name} at ${b.threshold}`)
    .concat(`${cleanSweepName} for the clean sweep`);
  const milestoneSentence =
    'Rack up tasks and badges land on their own: ' + milestoneParts.join(', ') + '.';

  res.render(
    'how-points-work',
    withBadgeMoment(req, res, { title: 'How to earn points', milestoneSentence })
  );
});

// GET /no-photos — the ceremony photo-notice explainer (issue #1042). Static
// copy that never depends on the toggle (AC6): the page stays reachable so a
// bookmarked link or a stale recap row never 404s, even with the notice off
// or on a day other than the configured ceremony date. Same shape as
// GET /how-points-work above, behind the same requireGuest gate every other
// route mounted on this router already gets.
router.get('/no-photos', function (req, res) {
  res.render('no-photos', withBadgeMoment(req, res, { title: 'No photos during the ceremony' }));
});

module.exports = router;
