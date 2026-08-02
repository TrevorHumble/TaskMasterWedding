// src/routes/guest/tasks.js
// GET /tasks, GET /tasks/:id, POST /tasks/:id/submit — the task board, task
// detail, and photo-submit routes (issue #991 split, seam table area
// "tasks.js").

'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined.
const { db, getEventConfig } = require('../../db');

// setFlash is the shared one-shot flash writer (also in section 03), the
// single owner of the signed `flash` cookie's shape.
const { setFlash, setTaskCompleteReward } = require('../../middleware/session');

// CSRF (issue #284): the multer-driven POST /tasks/:id/submit route runs
// multer manually, so req.body is not parsed until inside that callback —
// assertCsrf is the shared post-multer verifier every multer-driven route in
// this app calls immediately before any state change; rejectCsrf is the one
// shared 403 response, same literal as csrfMiddleware's own rejection.
const { assertCsrf, rejectCsrf } = require('../../middleware/csrf');

// withUploadSlot (issue #311 AC3, extended to memory batches by #857) bounds
// how many concurrent submitPhoto / submitMemoryBatch calls run their heavy
// thumbnail+DB-write pipeline at once -- see
// src/utils/upload-concurrency.js's file comment for why.
const { withUploadSlot } = require('../../utils/upload-concurrency');

// The one guest-facing "your photo didn't save" copy, shared by every
// submitPhoto failure mode below -- the thumb_failed status branch AND the
// caught-throw branch (issue #311 AC1) -- so the two call sites that must say
// the same thing cannot drift apart (same pattern as photos.js's
// DISALLOWED_TYPE_MESSAGE).
const PHOTO_SAVE_FAILED_MESSAGE = 'Sorry, we could not save that photo. Please try again.';

// Per-task badge resolution (issue #483) — resolveTaskBadge returns the
// task's own badge row (custom art/name if uploaded, else the shared
// default-ribbon art), lazily inserting the default row the first time a
// task is asked for. GET /tasks below is the ONLY other resolveTaskBadge
// caller outside admin.js; both read the same row, never a second copy of
// "which badge does this task earn".
const taskBadges = require('../../services/task-badges');

// The one active-task owner (issue #727) — every liveness check/count below
// consults tasks.liveTaskWhere()/isTaskLive() instead of a hand-written
// is_active/special_mode predicate.
const tasks = require('../../services/tasks');

// eventDays is the ONE "what day is it for the event, and when does a given
// day open" owner (issue #753) — always the event's configured timezone
// (db.getEventConfig().timezone), never server UTC. Used below by the
// one-day-only mystery-box surface (issue #754): the seal/live/today
// decisions on GET /tasks and GET /tasks/:id.
const eventDays = require('../../services/event-days');

// Photos service (section 05) — REAL exports only.
// `upload` is the multer DISK-storage middleware ALREADY BOUND to single('photo')
// — call it directly as `photos.upload(req, res, cb)` (do NOT call .single on it).
// After it runs, req.file.filename is the stored original filename and
// req.file.path its absolute path. makeThumb(path) is ASYNC and returns the
// thumbnail filename.
const photos = require('../../services/photos');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../../services/scoring');

const { withBadgeMoment } = require('../../services/render-locals');

// Submission-intake service (issue #106) — owns the whole submit-or-replace
// sequence for POST /tasks/:id/submit: task-active check, thumbnail, upsert,
// caption normalization, and scoring recompute. This route calls it once and
// maps the returned status to a response; see the handler below.
const submissions = require('../../services/submissions');

// uploadRateLimiter (shared with POST /me/edit, see
// src/routes/guest/shared.js) — one combined per-guest budget,
// config.RATE_LIMIT_UPLOAD_MAX. suppressedChallengeIds (issue #754) — the
// single owner of which sealed one-day-only challenge ids the one-box
// ceiling removes, shared with home.js/pages.js via reachableLiveTaskCount.
const { uploadRateLimiter, suppressedChallengeIds } = require('./shared');

// ---------------------------------------------------------------------------
// GET /tasks  — list all ACTIVE tasks with this guest's done/not-done state.
// ---------------------------------------------------------------------------
router.get('/tasks', function (req, res) {
  const guest = res.locals.guest;

  const timezone = getEventConfig().timezone;
  const todayIso = eventDays.eventLocalDateString(timezone);

  // clock (issue #762 plan step 1) — built once per request, beside
  // todayIso, so every row in one render answers to the same instant.
  // tasks.bonusForTask (called per row below) throws on a non-finite nowMs,
  // so it cannot be omitted here the way it could be for a caller that never
  // reaches the flash branch.
  const clock = { todayIso: todayIso, nowMs: Date.now() };

  // For each live task, join the guest's submission (if any) so we know
  // whether it is done. taken_down submissions do NOT count as done. Named
  // `taskRows` (not `tasks`) so it never shadows the tasks.js service module
  // required at the top of this file. special_date/special_bonus (issue
  // #754) and flash_start_at/flash_minutes/flash_bonus (issue #762) are
  // selected alongside the rest so this ONE query serves the one-box ceiling
  // (suppressedChallengeIds below), the per-row locked/isToday/flashActive
  // mapping, AND the existing done/points columns — no second query.
  // s.created_at orders the ?view=done list (the default view no longer uses it — see below).
  const taskRows = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.sort_order, t.worth,
              t.special_date, t.special_bonus,
              t.flash_start_at, t.flash_minutes, t.flash_bonus,
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
  // comment in src/routes/guest/shared.js).
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
  //              challenge whose special_bonus is NULL/0 (the legacy
  //              pre-chk_special_pairing row shape documented in
  //              submissions.js — special_date set, special_bonus still
  //              NULL) renders as an ORDINARY row instead of a gold flag
  //              reading "+null pts" over a struck-through "+NaN pts".
  //   unlockAt — the absolute instant (event-local midnight) this challenge's
  //              day opens, for the countdown partial's data-unlock-at.
  //   specialBonus — coerced to a number so the template's arithmetic can
  //              never read undefined/null.
  //
  //   This route deliberately does NOT also emit a render-priority flag
  //   (#762) — that would be a SECOND owner of "which rows are special"
  //   alongside tasks.ejs's own specialRank() ranking function; a future
  //   special type added to rank alone, without also widening this flag,
  //   would land its row silently in ordinaryTodo, un-ranked, in host sort
  //   order, with no marker position — nothing would fail, the row would
  //   just be in the wrong place.
  //   tasks.ejs's specialRank() is now the single owner of both "is this row
  //   special" and "where does it sort": membership is derived FROM the
  //   rank (below the shared ordinary floor) rather than asserted here a
  //   second way. A challenge whose day has already passed still falls
  //   through to an ordinary rank (locked=false, isToday=false) instead of
  //   staying pinned to the top of the list all weekend (criterion 4's
  //   "takes no priority position" clause) — specialRank reads exactly the
  //   same locked/isToday/flashActive booleans this map already computes.
  //
  // isDatedChallenge (#754) guards all three
  // date-derived fields at once: special_date is a free-form TEXT column with
  // no shape constraint, and eventDays.dayOpensAt()'s Intl date math throws a
  // RangeError on a value that isn't a real YYYY-MM-DD string. A malformed
  // special_date is treated as "not a dated challenge at all" — an ordinary
  // row, unlockAt null — rather than taking down /tasks for every guest.
  //
  // Flash fields (#762 plan step 1) — flashActive, flashEndsAt, flashBonus, flashTotalMs:
  //   flashActive/flashBonus — read off tasks.bonusForTask(t, clock), the
  //              declared single owner of "is anything paying, and if so
  //              what" (src/services/tasks.js), not hand-composed here as
  //              `whatSpecial(...) === SPECIAL_FLASH && flashState(...) ===
  //              FLASH_ACTIVE` — that would be a second copy of the exact
  //              precedence-plus-paying rule bonusForTask already owns, with
  //              flashBonus read straight off the column rather than the
  //              amount bonusForTask says will actually bank. A future guard
  //              added to the flash rule's `paying` (SPECIAL_RULES, tasks.js)
  //              would then move bonusForTask's answer without moving a
  //              hand-composed copy here, letting the pill advertise a bonus
  //              the submission does not pay -- precisely the defect
  //              criterion 2 exists to prevent, arriving through a second,
  //              un-collapsed owner.
  //              `bonusDecision.reason === tasks.BONUS_REASON_FLASH` (rather
  //              than just `bonusDecision !== null`) is criterion 2's
  //              tie-break: the 'daily' rule can also be the one paying, and
  //              only a FLASH payout should ever set flashActive.
  //   flashWindowVal — tasks.flashWindow(t): the one owner of the window's
  //              arithmetic (src/services/tasks.js). Computed once per row;
  //              flashActive implies it is non-null (bonusForTask cannot pay
  //              'flash' for a row flashWindow() answers null for -- see
  //              flashState's own doc comment), so flashEndsAt/flashTotalMs
  //              read it without a further null check.
  //   flashEndsAt — the window's end instant as an ISO string, for the
  //              countdown script's data-ends-at, only when active.
  //   flashTotalMs — the window's total duration, for the drain fill's
  //              denominator, only when active.
  //
  //   Two known seams (issue #762), worth a comment rather than a guard —
  //   re-deriving exclusivity locally here to dodge either one would
  //   recreate the two-owners defect criterion 2 exists to prevent:
  //     - the 'daily' rule calls tasks.isSealed, which compares
  //       special_date > todayIso as strings. A row whose special_date is
  //       malformed can therefore claim 'daily' and suppress a live flash,
  //       even though isToday/locked above are guarded by
  //       tasks.isValidDateString (isDatedChallenge).
  //     - isToday is gated on specialBonus > 0, while the 'daily' rule is
  //       spoken for on isSealed || isOnDay alone. A legacy row dated today
  //       with a NULL special_bonus and a simultaneously active flash
  //       therefore renders NO marker at all — Today Only suppressed by the
  //       > 0 gate, flash suppressed because 'daily' is spoken for — and
  //       banks 0. chk_special_pairing covers rows written after #753, so
  //       this is legacy-only.
  const tasksWithBadges = visibleTaskRows.map(function (t) {
    const badge = taskBadges.resolveTaskBadge(t.id);
    const isDatedChallenge = tasks.isValidDateString(t.special_date);
    const locked = isDatedChallenge && tasks.isSealed(t, todayIso);
    const specialBonus = Number(t.special_bonus) || 0;
    const isToday = isDatedChallenge && tasks.isOnDay(t, todayIso) && specialBonus > 0;
    const unlockAt = isDatedChallenge
      ? eventDays.dayOpensAt(t.special_date, timezone).toISOString()
      : null;
    const bonusDecision = tasks.bonusForTask(t, clock);
    const flashActive = bonusDecision !== null && bonusDecision.reason === tasks.BONUS_REASON_FLASH;
    const flashWindowVal = tasks.flashWindow(t);
    const flashBonus = flashActive ? bonusDecision.amount : 0;
    // Missed bonus (FOMO): a bonus this guest can no longer earn — a flash whose
    // window closed, or a one-day challenge whose day has passed. Read off
    // tasks.missedBonusForTask(), the single owner of "did a bonus slip away
    // here, and how much was it", so this route never re-derives "expired" per
    // special type (the same discipline flashActive follows for bonusForTask).
    // Gated on amount > 0: a legacy row carrying a date with a NULL bonus never
    // had anything to miss, and must not render "+0".
    //
    // NOT mutually exclusive with the live markers by construction (#926).
    // isToday/locked are derived here from tasks.isSealed/isOnDay
    // directly, while missedBonusForTask() independently walks each rule's OWN
    // `missed` predicate, which does not consult whether that rule is
    // presently "spoken for" (findSpecialRule's separate question). A task
    // whose special_date has already passed but which ALSO carries a live or
    // scheduled flash window is spoken-for by 'flash' (daily's own spokenFor
    // is false once its date has passed) while STILL matching daily's
    // `missed` predicate — so flashActive and a raw missedBonusForTask()
    // result can both be true on the SAME row at once (host-reachable: arm a
    // flash on a task whose day already passed, or let a flash expire on a
    // task dated today). The two markers say opposite things ("worth more
    // right now" vs. "you missed this"), so exactly one must win. That
    // precedence is decided HERE, once — live beats missed — rather than left
    // for the view's price-column else-if order to (accidentally) also
    // decide: without this gate the row could carry the `task-bonus-missed`
    // class from this flag while its price column rendered the LIVE
    // treatment (isToday/flashActive checked first in the partial's else-if
    // chain), two owners of one precedence disagreeing on the same row. Lucky
    // deliberately reports no miss regardless (it wears no live marker
    // either; see its SPECIAL_RULES entry).
    //
    // This flag feeds both todoTasks and doneTasks below (both are filtered
    // FROM this same mapped array) — but the missed marker only ever RENDERS
    // on a todo row (task-todo-row.ejs is not used for done rows), so a done
    // row simply carries an unused, harmless bonusMissed value.
    const missedDecision = tasks.missedBonusForTask(t, clock);
    const bonusMissed =
      !isToday && !flashActive && missedDecision !== null && missedDecision.amount > 0;
    return Object.assign({}, t, {
      badge: taskBadges.toTaskBadgeView(badge),
      locked: locked,
      isToday: isToday,
      unlockAt: unlockAt,
      specialBonus: specialBonus,
      flashActive: flashActive,
      flashEndsAt: flashActive ? new Date(flashWindowVal.endMs).toISOString() : null,
      flashBonus: flashBonus,
      flashTotalMs: flashActive ? flashWindowVal.totalMs : null,
      bonusMissed: bonusMissed,
      bonusMissedAmount: bonusMissed ? missedDecision.amount : 0,
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

  res.render(
    'tasks',
    withBadgeMoment(req, res, {
      title: 'Tasks',
      view: req.query.view === 'done' ? 'done' : 'todo',
      todoTasks: todoTasks,
      doneTasks: doneTasks,
      doneCount: doneTasks.length + starter.done_count,
      todoCount: todoTasks.length + starter.todo_count,
      totalCount: visibleTaskRows.length + starter.total,
      starterDone: starter.done,
      starterPoints: starter.points,
    })
  );
});

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
  // BEFORE the seal gate below (#754) so the gate
  // can tell "sealed, and the guest has no visible submission" apart from
  // "sealed, but the guest already has one" — see that gate's own comment.
  // bonus_amount and photo_bonus (issue #756) are selected here alongside the
  // rest so the success-card block below can read the BANKED on-day bonus and
  // any admin photo bonus straight off this same row — the row that was just
  // written by the 'created' submit this page is rendering the redirect for.
  // The one-shot reward cookie (res.locals.taskCompleteReward, cleared by
  // attachGuest) can be consumed on a LATER page load than the submit itself
  // — the guest can reopen the task page after the redirect already fired —
  // so a host may have assigned photo_bonus in the gap; reading it off this
  // row rather than assuming the DB's own 0 default keeps the card accurate
  // in that case. These are submissions columns, not tasks columns: they must
  // NOT move onto the tasks SELECT above (that one has no bonus_amount or
  // photo_bonus and would throw "no such column").
  // taken_down_by (issue #886) is selected alongside taken_down so
  // task.ejs can branch on WHO hid the row, not just whether it is hidden —
  // see that view's own comment for the guest-self-delete shape this feeds.
  const submission = db
    .prepare(
      `SELECT id, photo_path, thumb_path, caption, created_at, taken_down, taken_down_by, bonus_amount, photo_bonus
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
  // EXCEPT (#754) when
  // the guest already holds ANY submission for it — visible or taken down —
  // e.g. a host re-dated the task's special_date to a future day after the
  // guest already completed it. #755's refusal rule (blocking that re-date
  // while submissions exist) is the PRIMARY guard against this ever
  // happening; this fall-through is defence in depth so the guest's own
  // already-completed photo can never itself 404 if that guard is ever
  // bypassed. A HOST-taken-down submission (or an unattributed one — issue
  // #886's Attribution convention) also grants this fall-through (not just a
  // visible one) — task.ejs renders the #190 "your photo is with the hosts"
  // state for that row on this same page, and submitPhoto's matching gate
  // (src/services/submissions.js) accepts a resubmit from either state, so
  // this render-side gate must let the guest reach the page in both.
  //
  // hasSubmission counts ANY existing row, including a guest-attributed
  // self-delete (#886). The premise for excluding it was that
  // submitPhoto's own isSealed gate would then refuse the upload the guest
  // reached this page to make — but that premise is false: submitPhoto's
  // gate is `tasks.isSealed(task, todayIso) && !existing` (src/services/
  // submissions.js), and `existing` is truthy for a self-deleted row (the
  // row and both files still exist — issue #886's non-goals list — only the
  // GUEST no longer sees evidence of it), so the submit is accepted and
  // returns 'replaced'. Excluding the row here therefore only 404s a guest
  // off a task their own upload would have worked on — strictly worse than
  // the pre-#886 behavior. In short: a guest who already submitted keeps
  // access to a sealed task's detail page, and a self-deleted row still
  // counts as "already submitted" for that purpose, exactly like a
  // host-taken-down row does.
  const hasSubmission = !!submission;
  if (tasks.isSealed(task, todayIso) && !hasSubmission) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // This task's own badge (issue #488 follow-up) — always resolvable, shown
  // and linked whether or not the guest has completed the task yet.
  const taskBadge = taskBadges.resolveTaskBadge(taskId);

  // Success card (issue #255): resolve the one-shot taskComplete reward
  // (read and cleared by attachGuest, src/middleware/session.js) into what
  // task.ejs needs. taskComplete carries BOTH numbers the card prints:
  // `points` is the guest's grand total after this submission, `earned`
  // (issue #756) is what THIS submission actually banked (task.worth + any
  // admin photo_bonus + any on-day challenge bonus), computed through
  // scoring.photoPoints — the single authority for how a photo's base
  // combines with its bonuses — rather than typing that formula out here as
  // a second copy of it. The badge celebration is a SEPARATE trigger from
  // this cookie now (issue #644 plan step 4 — see withBadgeMoment above): a
  // badge granted by this very submission is "owed" (celebrated_at NULL)
  // exactly like one granted anywhere else, so it needs no special-casing
  // here off reward.newBadgeIds. Which ONE of several newly-earned badges
  // gets the modal, when more than one is owed at once, is
  // scoring.rankBadgeCandidates's rule to state (issue #714, widened by
  // #902) — resolved by render-locals.js's resolveBadgeMoment, not
  // re-decided here.
  let taskComplete = null;
  if (res.locals.taskCompleteReward) {
    const reward = res.locals.taskCompleteReward;
    taskComplete = {
      points: reward.points,
      earned: scoring.photoPoints(
        submission ? submission.photo_bonus : 0,
        task.worth,
        submission ? submission.bonus_amount : 0
      ),
      // luckyBonus (issue #650) — carried straight off what submitPhoto
      // ACTUALLY banked (src/services/submissions.js), never re-derived here
      // from "is today lucky" or "is this the lucky task": the card follows
      // the bank, not the calendar (see the issue's "Settled design"). `undefined`
      // for every ordinary completion — task.ejs's frozen, approved markup
      // already reads exactly this field and treats a falsy value as "not
      // lucky".
      luckyBonus: reward.luckyBonus,
    };
  }

  // Issue #886: resolve the guest-clean-slate rule
  // HERE, once, through photos.hiddenByOwningGuest — the single owner of
  // "is this row hidden by the guest who owns it" — instead of handing
  // task.ejs the raw row and letting it re-derive `taken_down_by === 'guest'`
  // itself. A guest
  // who deleted their own photo gets the clean slate back (issue #886's
  // approved design): the task page reads exactly as it did before they ever
  // uploaded. A host takedown (or an unattributed row) still renders the
  // "with the hosts" state task.ejs owns for a non-null submission.
  const guestFacingSubmission =
    submission && photos.hiddenByOwningGuest(submission) ? null : submission;

  // The task-badge hero's state (issue #611 AC3), resolved HERE rather than
  // in the view so task.ejs branches on nothing: taskBadges.guestBadgeRank
  // reads this guest's own award row for this task's badge (undefined = no
  // row, null or 1-5 = a row with that rank). Rank 1 is gold ("won-first");
  // any other rank, including a possession-only NULL, is an ordinary win
  // ("won-place"); no row at all falls back to the pre-#611 earned/locked
  // split (`submission ? 'earned' : 'locked'`, decided here rather than in
  // the template) — guestFacingSubmission is that same
  // signal, unaffected by a host takedown (issue #190) since only a guest's
  // own self-delete nulls it.
  const guestBadgeRank = taskBadges.guestBadgeRank(taskBadge.id, guest.id);
  let taskBadgeState;
  if (guestBadgeRank === undefined) {
    taskBadgeState = guestFacingSubmission ? 'earned' : 'locked';
  } else if (taskBadges.isFirstPlaceRank(guestBadgeRank)) {
    // What the number 1 MEANS is task-badges.js's to own (it writes the
    // column), not this route's to re-test — see isFirstPlaceRank's comment.
    taskBadgeState = 'won-first';
  } else {
    // Every other award row — ranks 2-5, and a possession-only row whose rank
    // is NULL — is an ordinary win (issue #611 AC3). The NULL case is
    // unreachable today: awardTaskBadge, the only writer that leaves rank
    // unset, has no route callers, so no guest can currently be shown the
    // "top 5" line without a real placement behind it. Parked on #588 rather
    // than pre-solved here, since resolving it means deciding what a
    // placement-less award should say — a question that only becomes real if
    // that write path is ever wired up.
    taskBadgeState = 'won-place';
  }

  res.render(
    'task',
    withBadgeMoment(req, res, {
      title: task.title,
      task: task,
      taskBadge: taskBadge, // this task's badge — always present, unlike badgeMoment
      taskBadgeState: taskBadgeState, // one of locked/earned/won-first/won-place (issue #611 AC3)
      submission: guestFacingSubmission, // null if none yet, OR the guest hid it themselves
      taskComplete: taskComplete, // null unless a 'created' submit OR a guest-clean-slate replace (issue #886) just redirected here; carries both .points and .earned
      pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
    })
  );
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
// Issue #311 AC1/AC3: the submitPhoto call is wrapped in try/catch — its
// synchronous better-sqlite3 writes are unguarded, so an unexpected throw
// (a constraint violation, disk-full mid-write, a future regression) would
// otherwise escape this async multer callback as an unhandled rejection and
// crash the whole process, since no process-level guard exists anywhere
// else in src/ — and run through withUploadSlot, which bounds how many of
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

    // CSRF check (issue #284): now that multer has parsed the body,
    // req.body._csrf (the hidden field partials/csrf-field.ejs renders as
    // the FIRST field in task.ejs's form) is available as a second chance
    // for a no-JS native multipart submit, alongside the header
    // csrfMiddleware may already have verified. Runs before submitPhoto's
    // DB write. photos.upload's disk storage has already written req.file to
    // UPLOADS_DIR by this point (unlike memory-storage uploadAvatar), so a
    // rejection here must also delete that orphaned original — mirroring
    // cleanupBatchOriginals in src/routes/guest/memories.js (POST /memories),
    // the sibling route with the same "multer already wrote a file to disk
    // before we could reject" shape.
    if (!assertCsrf(req)) {
      photos.deleteOriginalFile(req.file.filename);
      rejectCsrf(res);
      return;
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
    // guestCleanSlateReplace (#886): a replace
    // that landed on a row the owning guest had hidden themselves gets the
    // SAME success-card reward path as 'created', reusing setTaskCompleteReward
    // and task.ejs's existing "Task complete!" copy verbatim — no new flash
    // string. The task page just showed this guest the never-submitted shape
    // (submission nulled per issue #886's approved design — see the
    // guestFacingSubmission local above), so "Photo replaced!" would tell them
    // they replaced a photo they were just shown no evidence of; the
    // first-time-completion experience is the one that actually matches what
    // they saw.
    //
    // replaced_hidden (issue #190): the resubmit landed on a still-taken-down
    // row, so it does not go live — tell the guest that plainly rather than
    // claiming "Photo replaced!" for something that isn't visible yet.
    //
    // Any other 'replaced' (the row was already visible before this submit)
    // keeps the plain flash (issue #255's AC4 — a different criterion from
    // issue #886's own AC4, the no-downgrade guard in
    // src/routes/community.js; qualified here so the two aren't conflated).
    if (result.status === 'created' || result.guestCleanSlateReplace) {
      setTaskCompleteReward(res, {
        points: result.pointsTotal,
        newBadgeIds: result.newBadgeIds,
        // luckyBonus (issue #650) — undefined for an ordinary completion,
        // which JSON.stringify simply omits from the cookie payload rather
        // than writing a literal "undefined" (so an ordinary card round-trips
        // through the SAME two-key shape session.js's JSDoc already pinned).
        // Always undefined for guestCleanSlateReplace too (lucky never banks
        // on any replace — submissions.js's own banksOnReplace rule), so this
        // reads no differently than an ordinary card.
        luckyBonus: result.luckyBonus,
      });
    } else if (result.status === 'replaced_hidden') {
      setFlash(res, 'success', 'Photo received — it will appear once the hosts approve it.');
    } else {
      // status === 'replaced', and NOT a guest clean-slate replace.
      setFlash(res, 'success', 'Photo replaced!');
    }
    return res.redirect('/tasks/' + taskId);
  });
});

module.exports = router;
