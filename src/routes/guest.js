// src/routes/guest.js
'use strict';

const express = require('express');
const router = express.Router();

const config = require('../../config');

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined. markGuestOnboarded (issue #564) is the single writer of
// guests.onboarded outside its own schema default — called below from GET
// /how-to-play.
const { db, markGuestOnboarded, getEventConfig } = require('../db');

// requireGuest comes from section 03. It loads the current guest into
// res.locals.guest (and req.guest) from the signed gsid cookie, or
// redirects visitors who have no valid guest link. setFlash is the shared
// one-shot flash writer (also in section 03), the single owner of the signed
// `flash` cookie's shape.
const { requireGuest, setFlash, setTaskCompleteReward } = require('../middleware/session');

// Route-level rate limiting (issue #283) — see the createRateLimiter call
// sites below (after the services/rate-limit require) for the two instances
// this file wires up. guestOrIpKey is the single owner of the "guest-keyed,
// IP fallback when signed out" rule, shared with community.js.
const { createRateLimiter, guestOrIpKey } = require('../middleware/rate-limit');

// withUploadSlot (issue #311 AC3) bounds how many concurrent submitPhoto
// calls run their heavy thumbnail+DB-write pipeline at once -- see
// src/utils/upload-concurrency.js's file comment for why.
const { withUploadSlot } = require('../utils/upload-concurrency');

// The one guest-facing "your photo didn't save" copy, shared by every
// submitPhoto failure mode below -- the thumb_failed status branch AND the
// caught-throw branch (issue #311 AC1) -- so the two call sites that must say
// the same thing cannot drift apart (same pattern as photos.js's
// DISALLOWED_TYPE_MESSAGE).
const PHOTO_SAVE_FAILED_MESSAGE = 'Sorry, we could not save that photo. Please try again.';

// isValidPin (issue #243) — the SAME 4-digit-shape rule signup (routes/auth.js)
// and the admin identity route (routes/admin.js) already share from
// services/identity.js. POST /me/edit below calls this single owner rather
// than re-encoding the shape rule a third time.
const { isValidPin } = require('../services/identity');

// Per-task badge resolution (issue #483) — resolveTaskBadge returns the
// task's own badge row (custom art/name if uploaded, else the shared
// default-ribbon art), lazily inserting the default row the first time a
// task is asked for. GET /tasks below is the ONLY other resolveTaskBadge
// caller outside admin.js; both read the same row, never a second copy of
// "which badge does this task earn".
const taskBadges = require('../services/task-badges');

// The one active-task owner (issue #727) — every liveness check/count below
// consults tasks.liveTaskWhere()/isTaskLive() instead of a hand-written
// is_active/special_mode predicate.
const tasks = require('../services/tasks');

// eventDays is the ONE "what day is it for the event, and when does a given
// day open" owner (issue #753) — always the event's configured timezone
// (db.getEventConfig().timezone), never server UTC. Used below by the
// one-day-only mystery-box surface (issue #754): the seal/live/today
// decisions on GET /, GET /tasks, GET /tasks/:id and GET /how-to-play.
const eventDays = require('../services/event-days');

// Photos service (section 05) — REAL exports only.
// `upload` is the multer DISK-storage middleware ALREADY BOUND to single('photo')
// — call it directly as `photos.upload(req, res, cb)` (do NOT call .single on it).
// After it runs, req.file.filename is the stored original filename and
// req.file.path its absolute path. makeThumb(path) is ASYNC and returns the
// thumbnail filename.
// `uploadAvatar` is the multer MEMORY-storage middleware ALREADY BOUND to
// single('avatar') (issue #122) — call it directly the same way. After it runs,
// req.file.buffer holds the raw bytes (no req.file.path on this path).
// saveAvatar(buffer, guestId) is ASYNC, writes the avatar file, sets
// guests.avatar_path, and returns the filename. deleteOriginalFile() and
// deleteThumbFile() remove files from disk.
const photos = require('../services/photos');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../services/scoring');

// Submission-intake service (issue #106) — owns the whole submit-or-replace
// sequence for POST /tasks/:id/submit: task-active check, thumbnail, upsert,
// caption normalization, and scoring recompute. This route calls it once and
// maps the returned status to a response; see the handler below.
const submissions = require('../services/submissions');

// Memory-upload abuse guardrails (issue #247). config (required above) owns
// MEMORY_RATE_MAX / MEMORY_RATE_WINDOW_MS / MIN_FREE_DISK_BYTES; the rate-limit
// service owns the per-guest limiter and the injectable free-space reader.
// Applied only to POST /memories below.
const rateLimit = require('../services/rate-limit');

// Copy shown when a guest is over the memory rate limit (AC11) or the data
// volume is below MIN_FREE_DISK_BYTES (AC12). Kept as named constants so the
// route and the tests reference the same literal in one place.
const MEMORY_RATE_LIMIT_MESSAGE =
  "Whoa — that's a lot of memories at once. Give it a minute and try again.";
const MEMORY_DISK_FULL_MESSAGE = 'The gallery is full right now — please tell the hosts.';

// Route-level rate limiting (issue #283). DISTINCT from services/rate-limit
// (required above), which keeps owning POST /memories and the HEIC-decode
// throttle — see src/middleware/rate-limit.js's file comment for the
// boundary. Both instances below are guest-keyed (falls back to an IP bucket
// for the signed-out case, which requireGuest below would redirect anyway).
// uploadRateLimiter is SHARED between POST /tasks/:id/submit and POST
// /me/edit (one combined per-guest budget, config.RATE_LIMIT_UPLOAD_MAX);
// socialRateLimiter backs POST /bug-report alone (its own budget,
// config.RATE_LIMIT_SOCIAL_MAX — a SEPARATE instance from the one
// src/routes/community.js creates for /like + /comments, even though both
// read the same config value).
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

// ---------------------------------------------------------------------------
// The one-box ceiling (issue #754, owner rule 2026-07-20): of every LIVE
// one-day-only challenge currently sealed, at most ONE is ever shown to a
// guest — the one unlocking soonest. This function is the SINGLE owner of
// which task ids that ceiling removes; GET /, GET /tasks and GET /how-to-play
// below each call it (GET / and GET /how-to-play via reachableLiveTaskCount
// below; GET /tasks directly, since it also needs the row list) instead of
// re-deciding the rule three times (the same "no second copy" reasoning
// src/views/tasks.ejs's own comment gives for not re-deciding rows the server
// already decided), so the /tasks chips, the home progress bar and the
// how-to-play mission count can never disagree about which challenges are
// suppressed.
//
// A challenge the guest has already completed is excluded from the sealed
// set entirely (issue #754 review fix, MAJOR A) — it can never itself be
// suppressed (so a task re-dated into the future after the guest already
// submitted for it stays visible in Done, title and all) and it never
// consumes the one-box slot a still-locked challenge needs (so a completed
// sealed challenge sitting alongside an incomplete one can no longer suppress
// the only card that should render). #755's refusal rule — blocking a host
// from re-dating a task that already has submissions — is the PRIMARY guard
// against this situation ever arising; this exclusion is defence in depth,
// not a substitute for it.
//
// The tie-break comparator is total (issue #754 review fix — a second
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
    // isDatedChallenge mapping guards locked/isToday/unlockAt below (issue
    // #754 review fix): special_date is a free-form TEXT column, and
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
// The reachable-live-task COUNT (issue #754 review fix, MAJOR C): the same
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

// Every route in this router requires a signed-in guest.
router.use(requireGuest);

// ---------------------------------------------------------------------------
// GET /  — the guest's own home / profile page.
// Shows: points, badges (with art), and a task-completion progress bar
// (completed tasks vs total active tasks).
// ---------------------------------------------------------------------------
router.get('/', function (req, res) {
  const guest = res.locals.guest;

  // Total live tasks (guests only ever see live tasks), minus any sealed
  // one-day-only challenge the mystery-box ceiling suppresses (issue #754) —
  // reachableLiveTaskCount is the single owner of this derivation (review
  // fix, MAJOR C), shared with GET /how-to-play, so this progress bar can
  // never count a challenge a guest can never actually reach.
  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);
  const totalActiveCount = reachableLiveTaskCount(todayIso, guest.id);

  // Completed tasks for this guest — routed through scoring.getCompletedCount
  // (issue #104) so this count can never drift from points and badges, which
  // use the same canonical rule (visible submissions, no liveness filter).
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

  // Progress bar reflects task completion (X of Y), not badge thresholds —
  // the "next badge" framing was removed because it contradicted this bar
  // whenever the highest badge threshold was unreachable given the active
  // task count (see issue #88).
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

  res.render('guest-home', {
    title: 'Home',
    points: points,
    badges: badges,
    submissions: submissions,
    totalTasks: totalTasks,
    completedTasks: clampedCompletedTasks,
    progressPercent: progressPercent,
  });
});

// ---------------------------------------------------------------------------
// GET /tasks  — list all ACTIVE tasks with this guest's done/not-done state.
// ---------------------------------------------------------------------------
router.get('/tasks', function (req, res) {
  const guest = res.locals.guest;

  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);

  // For each live task, join the guest's submission (if any) so we know
  // whether it is done. taken_down submissions do NOT count as done. Named
  // `taskRows` (not `tasks`) so it never shadows the tasks.js service module
  // required at the top of this file. special_date/special_bonus (issue
  // #754) are selected alongside the rest so this ONE query serves the
  // one-box ceiling (suppressedChallengeIds below), the per-row locked/isToday
  // mapping, AND the existing done/points columns — no second query.
  // s.created_at orders the ?view=done list (the default view no longer uses it — see below).
  const taskRows = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.sort_order, t.worth,
              t.special_date, t.special_bonus,
              CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS done,
              s.thumb_path AS thumb_path,
              s.created_at AS done_at
         FROM tasks t
         LEFT JOIN submissions s
                ON s.task_id = t.id
               AND s.guest_id = ?
               AND s.taken_down = 0
        WHERE ${tasks.liveTaskWhere('t')}
        ORDER BY t.sort_order ASC, t.id ASC`
    )
    .all(guest.id);

  // The one-box ceiling (issue #754): applied server-side, BEFORE anything
  // below ever sees a suppressed row, so a sealed challenge's title can never
  // leak through page source (criterion 2: "nowhere in the page's markup").
  // taskRows already carries `done` (this guest's own completion), which
  // suppressedChallengeIds needs for the MAJOR A exclusion (see its own doc
  // comment above).
  const suppressedIds = suppressedChallengeIds(taskRows, todayIso);
  const visibleTaskRows = taskRows.filter(function (t) {
    return !suppressedIds.has(t.id);
  });

  // Attach each task's own resolved badge (issue #486) so the list can show
  // "earn [name] plus extra points" before the guest even takes the photo —
  // the same custom-or-default resolution admin.js's task board already
  // uses, so a customized badge shows here the moment it is uploaded.
  // Mapped onto `visibleTaskRows` BEFORE the todo/done split below so both
  // derived lists carry the badge without a second resolve pass.
  //
  // Also resolves the one-day-only mystery-box fields tasks.ejs/task-todo-row
  // consume (issue #754):
  //   locked   — tasks.isSealed: this challenge's day has not arrived.
  //   isToday  — tasks.isOnDay (the single owner, shared with
  //              submissions.js's bonus-banking check — issue #754 review
  //              fix, MAJOR B) AND it carries a usable (>0) bonus; a
  //              challenge whose special_bonus is NULL/0 (submissions.js:98's
  //              documented legacy-row shape) renders as an ORDINARY row
  //              instead of a gold flag reading "+null pts" over a
  //              struck-through "+NaN pts".
  //   unlockAt — the absolute instant (event-local midnight) this challenge's
  //              day opens, for the countdown partial's data-unlock-at.
  //   specialBonus — coerced to a number so the template's arithmetic can
  //              never read undefined/null.
  //   onedayPriority — the render-priority flag tasks.ejs partitions the
  //              to-do list on: `locked || isToday`, not tasks.isChallenge
  //              (which stays true forever, special_date IS NOT NULL) — so a
  //              challenge whose day has already passed falls through to an
  //              ordinary row (locked=false, isToday=false) instead of
  //              staying pinned to the top of the list all weekend
  //              (criterion 4's "takes no priority position" clause).
  //
  // isDatedChallenge (issue #754 review fix, MINOR I) guards all three
  // date-derived fields at once: special_date is a free-form TEXT column with
  // no shape constraint, and eventDays.dayOpensAt()'s Intl date math throws a
  // RangeError on a value that isn't a real YYYY-MM-DD string. A malformed
  // special_date is treated as "not a dated challenge at all" — an ordinary
  // row, unlockAt null — rather than taking down /tasks for every guest.
  const tasksWithBadges = visibleTaskRows.map(function (t) {
    const badge = taskBadges.resolveTaskBadge(t.id);
    const isDatedChallenge = tasks.isValidDateString(t.special_date);
    const locked = isDatedChallenge && tasks.isSealed(t, todayIso);
    const specialBonus = Number(t.special_bonus) || 0;
    const isToday = isDatedChallenge && tasks.isOnDay(t, todayIso) && specialBonus > 0;
    const unlockAt = isDatedChallenge
      ? eventDays.dayOpensAt(t.special_date, timezone).toISOString()
      : null;
    return Object.assign({}, t, {
      badge: taskBadges.toTaskBadgeView(badge),
      locked: locked,
      isToday: isToday,
      unlockAt: unlockAt,
      specialBonus: specialBonus,
      onedayPriority: locked || isToday,
    });
  });

  const todoTasks = tasksWithBadges.filter(function (t) {
    return t.done !== 1;
  });
  // Done tasks, most recent completion first. The default (to-do) view no
  // longer renders any of this list (issue #339) — it feeds only the chip
  // count and the full ?view=done list.
  const doneTasks = tasksWithBadges
    .filter(function (t) {
      return t.done === 1;
    })
    .sort(function (a, b) {
      return String(b.done_at || '').localeCompare(String(a.done_at || ''));
    });

  // Issue #409: the hardcoded "Upload your profile photo" starter renders as a
  // real row inside the to-do or done list (tasks.ejs) and is counted in the
  // chip counts, so no visible list disagrees with its adjacent count. Both
  // the counts and the tile's placement/label come from the single owner in
  // the scoring service (scoring.starterTaskContribution / STARTER_PHOTO_POINT)
  // — this route re-derives neither the avatar rule nor the point value.
  const starter = scoring.starterTaskContribution(guest);

  res.render('tasks', {
    title: 'Tasks',
    view: req.query.view === 'done' ? 'done' : 'todo',
    todoTasks: todoTasks,
    doneTasks: doneTasks,
    doneCount: doneTasks.length + starter.done_count,
    todoCount: todoTasks.length + starter.todo_count,
    totalCount: visibleTaskRows.length + starter.total,
    starterDone: starter.done,
    starterPoints: starter.points,
  });
});

// ---------------------------------------------------------------------------
// GET /how-to-play  — the one-screen rules card (issue #246). Reachable from
// the profile menu (a plain GET, no query string). ?first=1 (still honored
// via req.query.first below) shows the "Skip for now" link for a guest
// mid-first-run; nothing currently redirects here with it since #244 retired
// the separate /onboard step that used to.
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
  // photo missions" count past what a guest can actually reach.
  // reachableLiveTaskCount is the single owner (review fix, MAJOR C), shared
  // with GET /'s progress-bar denominator.
  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);
  const taskCount = reachableLiveTaskCount(todayIso, guest.id);

  // Issue #564: mark the guest onboarded on the RENDER of the rules, not on
  // arrival at the route — a guest who somehow never reaches the render
  // below is not marked, so they see the rules again next time (AC2). This
  // route runs behind router.use(requireGuest) above, so res.locals.guest is
  // always a real row here; markGuestOnboarded's falsy-id guard is defensive
  // only. Idempotent by design (see markGuestOnboarded's own comment) — an
  // already-onboarded guest re-reading this page (AC5) just writes the same
  // 1 again, no state change that matters.
  markGuestOnboarded(guest.id);

  res.render('how-to-play', {
    title: 'How to play',
    taskCount: taskCount,
    showSkip: req.query.first === '1',
  });
});

// Copy shown to the guest after a bug report is stored (AC1) and when the
// body field is left empty (AC5). Named constants so the route and the tests
// reference the same literal in one place.
const BUG_REPORT_THANKS = 'Thanks — the Wedding Masters have been told.';
const BUG_REPORT_EMPTY_ERROR = 'Tell us what went wrong first.';
// A stored bug body is capped at this many characters (issue #245 AC6) — long
// enough for a real description. This bounds only the per-request body
// length, not the number of reports a guest can file; an unbounded report
// count is a known, accepted minor under the guest-comments threat model.
const BUG_REPORT_BODY_MAX = 1000;

// Pull just the path (no scheme/host) out of a Referer header, so
// bug_reports.page never stores a full origin a guest's phone happened to be
// on. Real browsers send an absolute URL; some test/tooling clients send a
// bare path directly, so a same-origin-only relative string is accepted too.
// Returns null when the header is absent or unusable.
function refererPath(rawReferer) {
  if (typeof rawReferer !== 'string' || rawReferer.length === 0) {
    return null;
  }
  try {
    return new URL(rawReferer).pathname;
  } catch (e) {
    return rawReferer.startsWith('/') ? rawReferer : null;
  }
}

// ---------------------------------------------------------------------------
// GET /bug-report  — the "Report a bug" form (issue #245). Guest-gated by the
// router.use(requireGuest) above, same as every other route in this file
// (AC2: a signed-out visitor is redirected to /join instead — issue #241).
// ---------------------------------------------------------------------------
router.get('/bug-report', function (req, res) {
  res.render('bug-report', { title: 'Report a bug', error: '' });
});

// ---------------------------------------------------------------------------
// POST /bug-report  — store a guest's bug report (issue #245).
// The app auto-attaches guest id, the referring path (Referer header, origin
// stripped), and the User-Agent — the guest form itself carries only the
// message body, per the design ("no email field, no screenshot upload").
// ---------------------------------------------------------------------------
router.post('/bug-report', socialRateLimiter, function (req, res) {
  const guest = res.locals.guest;

  const raw = typeof req.body.body === 'string' ? req.body.body : '';
  const trimmed = raw.trim();

  // AC5: an empty (or whitespace-only) body inserts no row and re-renders the
  // form with the required error copy.
  if (trimmed.length === 0) {
    return res.render('bug-report', { title: 'Report a bug', error: BUG_REPORT_EMPTY_ERROR });
  }

  // AC6: truncate to BUG_REPORT_BODY_MAX chars — 1001 'a' characters store as
  // exactly 1000.
  const body = trimmed.slice(0, BUG_REPORT_BODY_MAX);

  const page = refererPath(req.get('referer'));
  const userAgent = req.get('user-agent') || null;

  db.prepare(
    `INSERT INTO bug_reports (guest_id, body, page, user_agent, resolved)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guest.id, body, page, userAgent);

  setFlash(res, 'success', BUG_REPORT_THANKS);
  return res.redirect('/');
});

// When one submission earns more than one new badge (rare — e.g. an auto
// badge plus COMPLETIONIST at once), the modal celebrates a single PRIMARY
// badge by this fixed priority (design, #255). The rest are still awarded
// and appear on the guest's profile — one modal, one badge (v1).
const BADGE_MOMENT_PRIORITY = ['GARDEN', 'BOUQUET', 'BLOOM', 'COMPLETIONIST'];

// ---------------------------------------------------------------------------
// GET /tasks/:id  — one task's detail + the upload form. If the guest has
// already submitted, show their photo (or, if a host took it down, the
// "with the hosts" state — issue #190) and allow replacing it.
// ---------------------------------------------------------------------------
router.get('/tasks/:id', function (req, res) {
  const guest = res.locals.guest;
  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const task = db
    .prepare(
      'SELECT id, title, description, special_mode, special_date, worth FROM tasks WHERE id = ?'
    )
    .get(taskId);

  // Hide hidden or missing tasks from guests outright — no submission of any
  // shape can make a hidden/deleted task reachable.
  if (!task || !tasks.isTaskLive(task)) {
    return res.status(404).render('404', { title: 'Not found' });
  }
  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);

  // The guest's submission for this task, loaded REGARDLESS of taken_down
  // (issue #190): a host takedown must not make the task page fall back to
  // "not done" and invite a resubmit that would have silently reversed the
  // takedown. task.ejs branches on submission.taken_down to render the
  // "with the hosts" state instead of the ordinary complete state. Loaded
  // BEFORE the seal gate below (issue #754 review fix, MAJOR A) so the gate
  // can tell "sealed, and the guest has no visible submission" apart from
  // "sealed, but the guest already has one" — see that gate's own comment.
  const submission = db
    .prepare(
      `SELECT id, photo_path, thumb_path, caption, created_at, taken_down
         FROM submissions
        WHERE guest_id = ? AND task_id = ?`
    )
    .get(guest.id, taskId);

  // Hide a (issue #754) currently-sealed one-day-only challenge from guests —
  // special_date is selected above alongside the rest so isSealed reads the
  // real value rather than undefined (which would silently report "not
  // sealed" and leak a guessed URL a day early). A guessed URL for a sealed
  // task 404s exactly like a hidden one, so it gives up neither the title nor
  // an early submission (criterion 5) — the submit-side half of this same
  // gate lives in submissions.js's submitPhoto.
  //
  // EXCEPT (issue #754 review fix, MAJOR A; widened by the #754 re-check) when
  // the guest already holds ANY submission for it — visible or taken down —
  // e.g. a host re-dated the task's special_date to a future day after the
  // guest already completed it. #755's refusal rule (blocking that re-date
  // while submissions exist) is the PRIMARY guard against this ever
  // happening; this fall-through is defence in depth so the guest's own
  // already-completed photo can never itself 404 if that guard is ever
  // bypassed. A TAKEN-DOWN submission also grants this fall-through (not just
  // a visible one) — task.ejs renders the #190 "your photo is with the hosts"
  // state for that row on this same page, and submitPhoto's matching gate
  // (src/services/submissions.js) accepts a resubmit from either state, so
  // this render-side gate must let the guest reach the page in both.
  const hasSubmission = !!submission;
  if (tasks.isSealed(task, todayIso) && !hasSubmission) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // This task's own badge (issue #488 follow-up) — always resolvable, shown
  // and linked whether or not the guest has completed the task yet.
  const taskBadge = taskBadges.resolveTaskBadge(taskId);

  // Success card + badge modal (issue #255): resolve the one-shot
  // taskComplete reward (read and cleared by attachGuest,
  // src/middleware/session.js) into what task.ejs needs. Points live ONLY on
  // the inline card (taskComplete.points); a newly-earned badge gets its own
  // separate badgeMoment, which task.ejs renders as an auto-opening modal.
  //
  // Badge codes are resolved against the guest's CURRENT held badges rather
  // than trusted as-is, so a badge id that no longer resolves (defensive; not
  // expected to happen within the same redirect) is silently dropped instead
  // of rendering a blank badge entry.
  let taskComplete = null;
  let badgeMoment = null;
  if (res.locals.taskCompleteReward) {
    const reward = res.locals.taskCompleteReward;
    taskComplete = { points: reward.points };

    if (reward.newBadgeIds.length > 0) {
      const heldBadges = scoring.getGuestBadges(guest.id);
      const earnedBadges = heldBadges.filter((b) => reward.newBadgeIds.includes(b.code));

      // Pick the primary badge by fixed priority; if none of the earned
      // badges appear in the priority list (a future code not yet added to
      // it), fall back to the first earned badge rather than showing none.
      let primary = null;
      for (const code of BADGE_MOMENT_PRIORITY) {
        primary = earnedBadges.find((b) => b.code === code);
        if (primary) {
          break;
        }
      }
      if (!primary) {
        primary = earnedBadges[0] || null;
      }

      if (primary) {
        // Use the badge's OWN catalog data — its name is the title, its
        // description is the subtitle (scripts/badge-catalog.js). No invented
        // per-badge copy: the modal shows only what the badge actually carries.
        badgeMoment = {
          code: primary.code,
          name: primary.name,
          art_path: primary.art_path,
          description: primary.description,
        };
      }
    }
  }

  res.render('task', {
    title: task.title,
    task: task,
    taskBadge: taskBadge, // this task's badge — always present, unlike badgeMoment
    submission: submission, // null if none yet
    taskComplete: taskComplete, // null unless a 'created' submit just redirected here
    badgeMoment: badgeMoment, // null unless that submit also earned a new badge
    pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/submit  — handle the multipart photo upload.
// Field name is "photo" (single). photos.upload is multer DISK storage, so
// after the middleware runs req.file.filename is the stored original filename
// and req.file.path its absolute path on disk. Everything past "we have a
// file" — task-active check, thumbnail, insert-or-replace, caption, scoring
// recompute — is one call to submissions.submitPhoto (issue #106); this
// handler only owns what needs req/res: running multer, the multer-error and
// missing-file branches, and mapping the returned status to a response.
//
// Issue #311 AC1/AC3: the submitPhoto call is wrapped in try/catch (its
// synchronous better-sqlite3 writes are unguarded, so an unexpected throw --
// a constraint violation, disk-full mid-write, a future regression -- used
// to escape this async multer callback as an unhandled rejection and, with
// no process-level guard existing anywhere in src/ before this, crash the
// whole process) and run through withUploadSlot, which bounds how many of
// these heavy pipelines run at once under a concurrent-upload burst (see
// src/utils/upload-concurrency.js).
// ---------------------------------------------------------------------------
router.post('/tasks/:id/submit', uploadRateLimiter, function (req, res) {
  // Run multer first; it may error (file too big, wrong type, no file).
  // photos.upload is the ALREADY-BOUND single('photo') middleware (section 05),
  // so call it directly. The callback is async because submitPhoto is async.
  photos.upload(req, res, async function (err) {
    const guest = res.locals.guest;
    const taskId = Number(req.params.id);

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(404).render('404', { title: 'Not found' });
    }

    if (err) {
      // Multer/file-filter error (size limit or disallowed type).
      setFlash(res, 'error', 'That photo could not be uploaded: ' + err.message);
      return res.redirect('/tasks/' + taskId);
    }

    // Disk storage: a successful upload has req.file with .filename and .path.
    if (!req.file) {
      setFlash(res, 'error', 'Please choose a photo to upload.');
      return res.redirect('/tasks/' + taskId);
    }

    let result;
    try {
      result = await withUploadSlot(() =>
        submissions.submitPhoto({
          guestId: guest.id,
          taskId: taskId,
          file: req.file,
          caption: req.body.caption,
        })
      );
    } catch (submitErr) {
      // Issue #311 AC1: submitPhoto's DB writes are unguarded synchronous
      // better-sqlite3 statements. Mirror the thumb_failed branch below
      // exactly -- from the guest's point of view this is the identical
      // "your photo didn't save, try again" outcome, whatever the internal
      // cause. Logging with the `[submit]` prefix is the stderr signal an
      // operator watching the console needs (the #311 evidence: failures
      // that never reach here left stdout/stderr completely silent).
      console.error('[submit] submitPhoto threw for guest', guest.id, 'task', taskId, submitErr);
      setFlash(res, 'error', PHOTO_SAVE_FAILED_MESSAGE);
      return res.redirect('/tasks/' + taskId);
    }

    if (result.status === 'task_inactive') {
      return res.status(404).render('404', { title: 'Not found' });
    }
    if (result.status === 'thumb_failed') {
      setFlash(res, 'error', PHOTO_SAVE_FAILED_MESSAGE);
      return res.redirect('/tasks/' + taskId);
    }

    // created (issue #255): the success card supersedes the plain flash for
    // this case, so a one-shot taskComplete payload is written instead of
    // setFlash — task.ejs renders the card on the redirected GET and header.ejs
    // never gets a flash to also print, avoiding a double-render of the same
    // moment.
    //
    // replaced_hidden (issue #190): the resubmit landed on a still-taken-down
    // row, so it does not go live — tell the guest that plainly rather than
    // claiming "Photo replaced!" for something that isn't visible yet. These
    // two statuses keep their existing plain flash (AC4).
    if (result.status === 'created') {
      setTaskCompleteReward(res, { points: result.pointsTotal, newBadgeIds: result.newBadgeIds });
    } else if (result.status === 'replaced_hidden') {
      setFlash(res, 'success', 'Photo received — it will appear once the hosts approve it.');
    } else {
      // status === 'replaced'
      setFlash(res, 'success', 'Photo replaced!');
    }
    return res.redirect('/tasks/' + taskId);
  });
});

// ---------------------------------------------------------------------------
// GET /memories/new  — the "share a memory" form (issue #247). Guest-gated by
// the router.use(requireGuest) above, same as every other route in this file
// (AC6: a signed-out visitor is redirected to /join instead — issue #241).
// ---------------------------------------------------------------------------
router.get('/memories/new', function (req, res) {
  res.render('memory-new', { title: 'Share a memory' });
});

// ---------------------------------------------------------------------------
// POST /memories  — handle the multi-photo "memory" batch upload.
// Field name is "photos" (multiple, up to photos.MEMORY_BATCH_MAX_FILES).
// photos.uploadMemoryBatch is multer DISK storage bound to .array('photos');
// after it runs, req.files is an array of { filename, path, ... } descriptors
// (empty array if none were attached — multer's `files` limit is a maximum,
// not a minimum, so zero files is not itself a multer error).
//
// The 11th file trips multer's own files-limit guard with MulterError code
// LIMIT_FILE_COUNT (see photos.js's uploadMemoryBatch doc comment for why —
// NOT the LIMIT_UNEXPECTED_FILE a naive `.array('photos', 10)` would throw
// instead). That case re-renders the form directly (no redirect) with the
// literal copy AC2 requires, and inserts no rows — submissions.submitMemoryBatch
// is never called in that branch.
//
// Abuse guardrails (issue #247), applied AFTER multer parses the batch but
// BEFORE any row or thumbnail is written:
//   - Rate limit (AC11): at most MEMORY_RATE_MAX batches per guest per
//     MEMORY_RATE_WINDOW_MS. Over the limit, the batch is rejected.
//   - Disk-space guard (AC12): if free space on the data volume is below
//     MIN_FREE_DISK_BYTES, the batch is rejected.
// Multer's disk storage has already written the originals to UPLOADS_DIR by
// the time this callback runs, so a rejecting guard deletes those originals
// (cleanupBatchOriginals) and never calls submitMemoryBatch — so a rejected
// batch leaves zero rows AND zero files behind (no residue), and no
// thumbnails are ever generated for it.
// ---------------------------------------------------------------------------

// Delete the originals multer already wrote for a batch we are about to
// reject, so a rejected batch leaves no file residue on disk. No thumbnails
// exist yet at any rejection point (submitMemoryBatch has not run), so only
// the originals need removing.
function cleanupBatchOriginals(files) {
  for (const file of files) {
    photos.deleteOriginalFile(file.filename);
  }
}

router.post('/memories', function (req, res, next) {
  photos.uploadMemoryBatch(req, res, async function (err) {
    const guest = res.locals.guest;

    if (err) {
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.render('memory-new', {
          title: 'Share a memory',
          error: 'Ten photos at a time — send the rest in a second batch.',
        });
      }
      // Any other multer/file-filter error (size limit or disallowed type,
      // including the shared HEIC-rejection copy — issue #188).
      setFlash(res, 'error', 'That batch could not be uploaded: ' + err.message);
      return res.redirect('/memories/new');
    }

    const files = req.files || [];
    if (files.length === 0) {
      setFlash(res, 'error', 'Please choose at least one photo to share.');
      return res.redirect('/memories/new');
    }

    // Rate-limit guard (AC11). recordMemoryAttempt only consumes the guest's
    // budget when it ALLOWS the attempt, so a rejected batch does not extend
    // the penalty past the real window. Reject before persisting; clean up the
    // originals multer wrote so nothing is left behind.
    const rl = rateLimit.recordMemoryAttempt(guest.id);
    if (!rl.allowed) {
      cleanupBatchOriginals(files);
      return res.render('memory-new', {
        title: 'Share a memory',
        error: MEMORY_RATE_LIMIT_MESSAGE,
      });
    }

    // Disk-space guard (AC12). Read free space via the injectable reader; a
    // reader failure is a real server error, so route it to next(err) rather
    // than silently letting the batch through. Reject before submitMemoryBatch
    // writes any thumbnail; clean up the originals so no files remain.
    let spaceOk;
    try {
      spaceOk = await rateLimit.hasFreeSpace();
    } catch (spaceErr) {
      cleanupBatchOriginals(files);
      return next(spaceErr);
    }
    if (!spaceOk) {
      cleanupBatchOriginals(files);
      return res.render('memory-new', {
        title: 'Share a memory',
        error: MEMORY_DISK_FULL_MESSAGE,
      });
    }

    // Persist the batch. Wrapped so a thrown error routes to the Express error
    // handler (next(err)) rather than becoming an unhandled promise rejection
    // that hangs the request (plan step 9b).
    let result;
    try {
      result = await submissions.submitMemoryBatch({
        guestId: guest.id,
        files: files,
        caption: req.body.caption,
      });
    } catch (batchErr) {
      return next(batchErr);
    }

    // If every file failed to thumbnail, submitMemoryBatch inserts zero rows —
    // do NOT tell the guest the batch was shared when nothing was (plan step
    // 9a). Surface an error instead.
    if (!result.submissionIds || result.submissionIds.length === 0) {
      setFlash(res, 'error', "Sorry, we couldn't save those photos. Please try again.");
      return res.redirect('/memories/new');
    }

    setFlash(res, 'success', "Shared! They're in the gallery.");
    return res.redirect('/gallery');
  });
});

// ---------------------------------------------------------------------------
// GET /me/edit  — edit own display name, avatar, and social links.
// social_links is stored as a JSON object string in guests.social_links.
// ---------------------------------------------------------------------------
router.get('/me/edit', function (req, res) {
  const guest = res.locals.guest;

  // Parse social_links JSON safely into an object for the form.
  let social;
  try {
    social = JSON.parse(guest.social_links || '{}');
    if (social === null || typeof social !== 'object') {
      social = {};
    }
  } catch (e) {
    social = {};
  }

  res.render('me-edit', {
    title: 'Edit My Profile',
    social: social,
    pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
  });
});

// ---------------------------------------------------------------------------
// POST /me/edit  — save name, optional new avatar, and social links.
// Avatar uses the SAME memory-storage `uploadAvatar` middleware (field name
// "avatar") as onboarding (issue #122), so req.file.buffer is already the raw
// bytes — no disk read-back/unlink needed. We call photos.saveAvatar(buffer,
// guestId) (async; it sets avatar_path) and remove a replaced avatar with
// deleteOriginalFile. No thumbnail, no submission row.
// ---------------------------------------------------------------------------
router.post('/me/edit', uploadRateLimiter, function (req, res) {
  // photos.uploadAvatar is the ALREADY-BOUND single('avatar') MEMORY-storage
  // middleware (section 05). The callback is async because saveAvatar() is async.
  photos.uploadAvatar(req, res, async function (err) {
    const guest = res.locals.guest;

    if (err) {
      setFlash(res, 'error', 'That avatar could not be uploaded: ' + err.message);
      return res.redirect('/me/edit');
    }

    // Optional new re-entry code (issue #243 AC3/AC4). Empty/absent means
    // "leave the existing pin unchanged" — a guest correcting only their name
    // or avatar must never accidentally wipe a working code. Validated with
    // isValidPin (see the require at top of this file), checked FIRST before
    // any other field is touched, so an invalid pin short-circuits the whole
    // save — nothing (name, avatar, socials, pin) is written — rather than
    // silently saving the rest alongside a rejected pin.
    const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
    if (rawPin && !isValidPin(rawPin)) {
      setFlash(res, 'error', 'Please choose a 4-digit PIN (numbers only).');
      return res.redirect('/me/edit');
    }
    const newPin = rawPin ? rawPin : guest.pin; // blank submitted -> keep existing

    // Name: required-ish. If blank, keep the old name rather than wiping it.
    let name = '';
    if (typeof req.body.name === 'string') {
      name = req.body.name.trim().slice(0, 80);
    }
    if (name.length === 0) {
      name = guest.name; // keep existing
    }

    // Build the social_links JSON. Start from the EXISTING object so keys we
    // don't render here (e.g. facebook entered at onboarding) are PRESERVED
    // rather than wiped. We only overwrite the keys this form edits:
    // instagram, facebook, website. Empty values remove that key.
    let social = {};
    try {
      const parsed = JSON.parse(guest.social_links || '{}');
      if (parsed && typeof parsed === 'object') {
        social = parsed;
      }
    } catch (e) {
      social = {};
    }

    const editableKeys = ['instagram', 'facebook', 'website'];
    editableKeys.forEach(function (key) {
      const val = (req.body[key] || '').toString().trim().slice(0, 200);
      if (val) {
        social[key] = val;
      } else {
        delete social[key];
      }
    });
    const socialJson = JSON.stringify(social);

    // Optional new avatar. photos.uploadAvatar (memory storage, field "avatar")
    // already gives us req.file.buffer directly — hand it straight to
    // saveAvatar(buffer, guestId), which writes the stored avatar file, sets
    // guests.avatar_path, and returns the filename. No temp file to read back
    // or clean up.
    let newAvatarPath = guest.avatar_path; // keep existing unless replaced
    if (req.file) {
      let savedAvatar;
      try {
        savedAvatar = await photos.saveAvatar(req.file.buffer, guest.id); // stored filename
      } catch (e) {
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        return res.redirect('/me/edit');
      }

      const oldAvatar = guest.avatar_path;
      newAvatarPath = savedAvatar;

      // Issue #716: no separate award step needed here — the starter point
      // is derived from guests.avatar_path (scoring.starterTaskContribution),
      // and the UPDATE below sets that column.

      // Delete the previous avatar file if it changed. Avatars live in the
      // uploads dir (no thumbnail), so deleteOriginalFile removes them.
      try {
        if (oldAvatar && oldAvatar !== newAvatarPath) {
          photos.deleteOriginalFile(oldAvatar);
        }
      } catch (e) {
        // Non-fatal.
      }
    }

    db.prepare(
      'UPDATE guests SET name = ?, avatar_path = ?, social_links = ?, pin = ? WHERE id = ?'
    ).run(name, newAvatarPath, socialJson, newPin, guest.id);

    setFlash(res, 'success', 'Profile updated!');
    return res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// POST /me/avatar/delete  — issue #528: clear the signed-in guest's own
// profile photo. A STANDALONE form on me-edit.ejs (deliberately not a submit
// button of the profile-edit form — see that view's comment), so it reads no
// request body: the target guest comes ONLY from res.locals.guest (set by
// requireGuest above, from the signed gsid cookie), never from req.body/query
// (AC2 — no cross-guest removal via a manipulated field).
//
// Clearing avatar_path is the only write needed for the #409/#716 interplay
// (AC4): starterTaskContribution/getPoints derive BOTH "done" and the point
// itself from `!!avatar_path` alone (issue #716 — the point is no longer a
// one-time banked award), so the starter tile reverts to to-do AND the +1
// leaves the guest's total automatically once this runs, with no separate
// point-clawback write needed. A later re-upload sets avatar_path again and
// the point simply returns (mirrors POST /me/edit's replace path).
//
// No-op-but-safe when the guest has no avatar (idempotent redirect) — same
// "nothing to delete" shape as POST /me/edit's replace-avatar branch, which
// also only calls deleteOriginalFile when an old avatar actually exists.
//
// The file unlink is wrapped non-fatal, and the avatar_path UPDATE runs
// regardless — the same ordering POST /me/edit's replace branch uses (guest.js
// ~836). deleteOriginalFile swallows ENOENT but rethrows a non-ENOENT failure
// (e.g. a transient Windows lock while express.static serves the file); letting
// that throw would 500 the request and leave avatar_path set, so "Remove photo"
// would silently fail as to state. Clearing the column is the user-visible
// contract; a rare orphaned file on disk is the lesser evil.
// ---------------------------------------------------------------------------
// uploadRateLimiter (shared with POST /me/edit, the sibling avatar-write path):
// this handler does filesystem + DB work, so it gets the same per-guest budget
// its sibling does rather than being an unthrottled fs/db endpoint.
router.post('/me/avatar/delete', uploadRateLimiter, function (req, res) {
  const guest = res.locals.guest;

  if (guest.avatar_path) {
    try {
      photos.deleteOriginalFile(guest.avatar_path);
    } catch (e) {
      // Non-fatal — the column clear below is the contract, not the unlink.
    }
    db.prepare('UPDATE guests SET avatar_path = NULL WHERE id = ?').run(guest.id);
    setFlash(res, 'success', 'Photo removed.');
  }

  return res.redirect('/me/edit');
});

module.exports = router;
