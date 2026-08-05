// src/routes/admin/tasks.js
// Task list + create + edit (issue #682 wizard/edit-popup) — seam table area
// "tasks core (list/create/edit)". The mandated route-boundary cut (issue
// #969): this file ends at POST /tasks/:id/edit; badge/delete/active/reorder
// live in tasks-manage.js, since the 943-line original span :1352-:2294
// carries no top-level helper to cut on internally.

const express = require('express');
const { db, getEventConfig } = require('../../db');
const scoring = require('../../services/scoring');
const tasks = require('../../services/tasks');
const badgeIcons = require('../../services/badge-icons');
const taskBadges = require('../../services/task-badges');
const { eventDays: computeEventDays, singleDayLabel } = require('../../services/event-days');
const hostChecklist = require('../../services/host-checklist');
const { redirectWithMsg } = require('./shared');
const {
  resolveBadgeIcon,
  resolveSpecialPairWrite,
  describeCreatePairRefusal,
  describeEditPairRefusal,
  resolveLuckyPairWrite,
  describeCreateLuckyRefusal,
  describeEditLuckyRefusal,
  resolveFlashWrite,
  describeCreateFlashRefusal,
  describeEditFlashRefusal,
  checkExclusivity,
  specialKindBeingSet,
  describeExclusivityRefusal,
  currentClock,
} = require('./task-form');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/tasks  — list + add form
// ---------------------------------------------------------------------------
router.get('/tasks', (req, res) => {
  // Named `taskRows` (not `tasks`) so it never shadows the tasks.js service
  // module required at the top of this file.
  const taskRows = db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, id ASC').all();

  // This route's one clock (#650) — hoisted
  // above the row-building map so every row's specialKind (below) is
  // evaluated against the same instant, the same discipline currentClock()
  // itself documents.
  const clock = currentClock();

  // Hoisted above the row-building map (issue #763 plan step 4) — the flash
  // projection below needs the configured timezone for formatFlashWhen(),
  // and the day-chip catalog further down needs the same config object; one
  // read, not two.
  const eventConfig = getEventConfig();

  // Attach how many live submissions each task has (informational).
  const subStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND taken_down = 0'
  );
  const rows = taskRows.map((t, idx) => {
    // resolveTaskBadge lazily inserts the task's own badge row (default
    // ribbon art) the first time a task's card is rendered (issue #483) —
    // every task always has a badge to show, never a missing-badge branch.
    const badge = taskBadges.resolveTaskBadge(t.id);
    // Hoisted (#755) so `oneday`/`dayLabel` below
    // never evaluate the same guard twice per row.
    const hasDate = tasks.isRealDateString(t.special_date);

    // The flash projection (issue #763 plan step 4): flashState plus the
    // derived remaining-time/when labels the board chip AND the edit
    // popup's status strip both read (data-flash-* attributes, admin-
    // tasks.ejs / admin-tasks.js). The remaining-time arithmetic comes from
    // tasks.flashWindow() — its own doc comment says it exists so a second
    // caller does not hand-roll `flash_start_at + minutes` again and let the
    // clock and the fill disagree — never computed inline here.
    const flashState = tasks.flashState(t, clock.nowMs);
    const flashWindowVal = tasks.flashWindow(t);
    let flashMinutesLeft = null;
    if (flashState === tasks.FLASH_ACTIVE && flashWindowVal) {
      // Ceiling, floored at 1: an active flash with real time left never
      // reads "0 min left" on the board just because it is inside its last
      // minute.
      flashMinutesLeft = Math.max(1, Math.ceil((flashWindowVal.endMs - clock.nowMs) / 60000));
    }
    let flashWhenLabel = '';
    if (flashState === tasks.FLASH_SCHEDULED && t.flash_start_at) {
      flashWhenLabel = hostChecklist.formatFlashWhen(t.flash_start_at, eventConfig.timezone, {
        style: 'timeOnly',
      });
    }
    // The status strip's own ready-made sentence (issue #763 criteria 1/2/6)
    // — the edit popup is ONE shared dialog reused for every card, so its
    // strip cannot be server-rendered per task; admin-tasks.js's openEdit()
    // reads this back verbatim off the tapped card's data-flash-strip-label
    // attribute rather than re-assembling the sentence client-side from
    // flashMinutesLeft/flashWhenLabel, so the wording has exactly one owner.
    let flashStripLabel = '';
    if (flashState === tasks.FLASH_ACTIVE) {
      flashStripLabel = `Live now — ${flashMinutesLeft} min left`;
    } else if (flashState === tasks.FLASH_SCHEDULED) {
      flashStripLabel = `Starts at ${flashWhenLabel}`;
    }

    return {
      id: t.id,
      title: t.title,
      description: t.description || '',
      sort_order: t.sort_order,
      // Real worth/special_mode (issue #682/#727) — the admin card's "+N pts"
      // and Hidden chip render these directly now; no more (id % 3) + 1
      // placeholder.
      worth: t.worth,
      special_mode: t.special_mode,
      // Derived compat field so admin-tasks.ejs's is-hidden class check keeps
      // reading a plain boolean, sourced from the one active-task owner
      // instead of a real is_active column (which no longer exists).
      is_active: tasks.isTaskLive(t) ? 1 : 0,
      // Raw pair (issue #755) — admin-tasks.ejs emits these as the card's
      // data-special-date/data-special-bonus attributes, which
      // admin-tasks.js's openEdit() reads back to drive the edit popup's
      // day/bonus chips (and the hidden stale-date input for criterion 3b).
      // Raw, not gated by the reality check — the popup needs the true
      // stored value even when it is stale/invalid.
      special_date: t.special_date,
      special_bonus: t.special_bonus,
      // Derived pair for the board chip (criterion 5): `hasDate` guards BOTH
      // shape and reality (tasks.isRealDateString). special_date is a
      // free-form TEXT column with no shape constraint (src/db.js), and
      // singleDayLabel() throws a RangeError on a regex-shaped-but-impossible
      // value like '2026-13-45' — this guard is what keeps GET /admin/tasks
      // from 500ing on that value; a task failing it renders no chip rather
      // than crashing the whole board.
      oneday: hasDate,
      dayLabel: hasDate ? singleDayLabel(t.special_date) : '',
      // Raw pair (issue #650 plan step 6) — emitted as data-lucky-date/
      // data-lucky-bonus so admin-tasks.js's openEdit() can restore a stored
      // lucky pick (and check the Lucky radio off it, since a lucky task
      // never stores special_mode='oneday' to derive that from). No board
      // chip for this pair (unlike special_date/special_bonus's oneday chip
      // above) — deliberate, recorded in the issue's "Deliberate omissions"
      // section: the edit popup is the host's way to see the current pick.
      lucky_date: t.lucky_date,
      lucky_bonus: t.lucky_bonus,
      // Raw trio (issue #763 plan step 4/6/7) — emitted as data-flash-bonus/
      // data-flash-minutes so admin-tasks.js's openEdit() can prefill the
      // bonus chip and duration field on an armed task. flash_start_at is
      // deliberately NOT emitted raw: the write path never needs the client
      // to echo it back (resolveFlashWrite reads the CURRENT stored row
      // straight off the DB for its no-op comparison), so there is nothing
      // for the client to carry.
      flash_bonus: t.flash_bonus,
      flash_minutes: t.flash_minutes,
      // Derived flash state/labels for the board chip (admin-tasks.ejs) AND
      // the edit popup's status strip (admin-tasks.js's openEdit(), via the
      // data-flash-state/data-flash-strip-label attributes below).
      flashState: flashState,
      flashMinutesLeft: flashMinutesLeft,
      flashWhenLabel: flashWhenLabel,
      flashStripLabel: flashStripLabel,
      // The server-derived answer to "which Special radio does this task's
      // edit popup open on" (#650). Before
      // this field existed, admin-tasks.js hand-copied the daily rule's
      // spokenFor predicate (isSealed||isOnDay) client-side to decide whether
      // a stored special_date should win the Lucky radio over a lucky_date —
      // a second owner of a rule tasks.js's whatSpecial() already owns, and
      // one that could not see a live flash window at all. Emitting
      // tasks.whatSpecial()'s own answer here (as data-special-kind, read by
      // openEdit()) makes the popup's radio precedence consult the SAME
      // single ordered SPECIAL_RULES walk every other exclusivity decision
      // in this app already goes through, instead of a browser-side re-guess
      // that drifts the moment the rule set changes.
      specialKind: tasks.whatSpecial(t, clock),
      submissions: subStmt.get(t.id).n,
      isFirst: idx === 0,
      isLast: idx === taskRows.length - 1,
      badge: Object.assign({}, taskBadges.toTaskBadgeView(badge), {
        // "Still the default" drives whether the upload control shows
        // (AC10) — compared by path, not by a separate stored flag, so it
        // can never desync from what art_path actually renders.
        isDefault: badge.art_path === taskBadges.DEFAULT_RIBBON_ART_PATH,
      }),
    };
  });

  // The day-chip catalog both dialog partials render (issue #755) — EJS
  // merges this local into partials/task-create-dialog.ejs and
  // partials/task-edit-dialog.ejs (and, through them, special-oneday-
  // option.ejs) since `include()` shares the calling template's scope by
  // default. `eventConfig` was already read above, before the row map.
  const eventDaysList = computeEventDays(eventConfig.startDate, eventConfig.endDate);

  res.render('admin-tasks', {
    title: 'Tasks',
    tasks: rows,
    badgeIcons: badgeIcons.listIcons().map((ic) => ({
      id: ic.id,
      name: ic.name,
      artPath: badgeIcons.iconArtPath(ic.id),
    })),
    eventDays: eventDaysList,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/tasks  — create a task (issue #682: the 3-step wizard —
// Details/Special/Badge — collapses to one POST). Bottom of the order by
// default; an `add_to_top` field (issue #258; no longer exposed by the
// wizard's own UI, but still honored so a direct POST can still ask for it)
// puts it at position 1 so a mid-event task can be featured without a
// click-reload reorder marathon.
//
// Body: title (required), description (optional), worth (3-5, falls back to
// tasks.DEFAULT_WORTH if missing/out of range — tasks.normalizeWorth), and
// special_mode ('none'/'hidden'/'oneday', falls back to tasks.MODE_NONE for
// anything else — tasks.normalizeMode; the SAME write-side owner POST
// /admin/tasks/:id/edit routes through below, so the two can never disagree
// on what an unrecognized mode becomes), special_date/special_bonus (issue
// #755 — required and validated only when special_mode is 'oneday' and
// differs from the (nonexistent) stored pair; see resolveSpecialPairWrite),
// badge_icon (a src/services/badge-icons.js catalog id — REQUIRED, AC-A: no
// valid icon means no task row is written at all), badge_name (optional —
// falls back to the icon's own catalog display name).
//
// The special_mode is part of the single INSERT below, not a follow-up
// UPDATE — a task created as Hidden is hidden from its very first row, never
// briefly live between create and a later edit (owner-flagged gap, the
// "Owner-approved design" section of #682).
router.post('/tasks', (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }

  const worth = tasks.normalizeWorth(req.body.worth, tasks.DEFAULT_WORTH);
  const rawSpecialMode = req.body.special_mode;
  const specialMode = tasks.normalizeMode(rawSpecialMode, tasks.MODE_NONE);

  // special_date/special_bonus (issue #755) — validated BEFORE any write, same
  // discipline as the badge check just below: a bad pair on CREATE means NO
  // task row is written at all (criterion 3), the same shape an invalid badge
  // already takes. storedDate/storedBonus are `undefined` (no stored task
  // yet, so every posted 'oneday' pair "differs from stored" — see
  // resolveSpecialPairWrite's own comment) and submissionCount is 0 (a
  // brand-new task can have no submissions, so the lock never fires here).
  const pairResolved = resolveSpecialPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: undefined,
    storedBonus: undefined,
    submissionCount: 0,
  });
  if (!pairResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', describeCreatePairRefusal(pairResolved.reason));
  }

  // Lucky pair (issue #650) — same "validated BEFORE any write" discipline,
  // storedDate/storedBonus undefined for the identical CREATE reason as the
  // one-day pair above.
  const luckyPairResolved = resolveLuckyPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.lucky_date,
    rawBonus: req.body.lucky_bonus,
    storedDate: undefined,
    storedBonus: undefined,
  });
  if (!luckyPairResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeCreateLuckyRefusal(luckyPairResolved.reason)
    );
  }

  // One clock for this request (issue #763 PR review, minor 5 — matches
  // currentClock()'s own comment intent and what the GET handler already
  // does): both the flash resolver and the exclusivity guard below need "the
  // same instant", so this is called once, not once per use.
  const clock = currentClock();

  // The flash trio (issue #763) — same "validated BEFORE any write"
  // discipline. storedRow is `undefined` (no stored task yet, so the no-op
  // rule never fires on CREATE — see resolveFlashWrite's own comment) and
  // resolvedSpecialMode is the ALREADY-normalized `specialMode` this save is
  // about to write (never 'flash' itself — see tasks.js's MODES comment —
  // so `not_live` here is vacuous by construction on CREATE, same as the
  // exclusivity guard below).
  const flashResolved = resolveFlashWrite({
    rawMode: rawSpecialMode,
    rawCancel: req.body.flash_cancel,
    rawBonus: req.body.flash_bonus,
    rawMinutes: req.body.flash_minutes,
    rawStartMode: req.body.flash_start_mode,
    rawDate: req.body.flash_date,
    rawTime: req.body.flash_time,
    storedRow: undefined,
    resolvedSpecialMode: specialMode,
    clock,
    timezone: getEventConfig().timezone,
  });
  if (!flashResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', describeCreateFlashRefusal(flashResolved.reason));
  }

  // Exclusivity (issue #650 plan step 3) — CREATE has no stored row, so `{}`;
  // the guard is vacuous by construction here, kept anyway so create and edit
  // share one shape. specialKindBeingSet() (#650) is the one place a posted
  // raw special_mode maps to the SPECIAL_* kind this guard checks — a
  // future setter (e.g. flash gaining a settable pick) has that one
  // function to extend, not this ternary duplicated a third time.
  const settingKind = specialKindBeingSet(rawSpecialMode);
  if (settingKind) {
    const exclusivity = checkExclusivity({}, clock, settingKind);
    if (!exclusivity.ok) {
      return redirectWithMsg(
        res,
        '/admin/tasks',
        describeExclusivityRefusal(exclusivity.existingKind)
      );
    }
  }

  // Badge is REQUIRED (AC-A) — the wizard's own step 3 already disables its
  // submit button until a badge is chosen, but the server is the real gate:
  // a POST with no valid catalog icon id creates NO task row. Validated
  // BEFORE any write below — resolveBadgeIcon performs no DB write itself.
  const badgeResolved = resolveBadgeIcon(req.body.badge_icon, req.body.badge_name, {
    required: true,
  });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'Choose a badge before creating the task.');
  }
  // A brand-new task has no prior badge name to preserve, unlike edit — a
  // blank name falls back to the icon's own catalog display name here only.
  const badgeName = badgeResolved.name || badgeIcons.iconName(req.body.badge_icon);

  let order;
  if (req.body.add_to_top) {
    const minRow = db.prepare('SELECT MIN(sort_order) AS m FROM tasks').get();
    order = (minRow.m == null ? 1 : minRow.m) - 1;
  } else {
    const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get();
    order = (maxRow.m == null ? -1 : maxRow.m) + 1;
  }

  // Atomic: the task INSERT and its badge write are one
  // transaction — if setTaskBadge threw, a bare sequential pair could commit
  // the task row alone, leaving a task with no badge despite badge being
  // supposedly required. better-sqlite3 nests transaction functions via
  // SAVEPOINTs, so calling setTaskBadge (itself a db.transaction) from inside
  // this one is safe.
  // live_since (issue #778) — set at INSERT time exactly when the row this
  // save is about to write is live (tasks.isTaskLive, the single liveness
  // owner), never NULL-then-backfilled: a task created live has no PRIOR
  // not-live state to transition FROM, so its "went live" instant is its own
  // creation instant. Written as a raw SQL literal (CASE WHEN ... THEN
  // datetime('now') ELSE NULL END), not a bound JS Date, so it lands in the
  // exact same UTC datetime('now') form every other timestamp in this app
  // uses (including guests.recap_checked_at, the value it is compared
  // against) — matching liveTaskWhere's own "trusted internal constant,
  // never user input" interpolation style, since the only two possible
  // values are the two literals below, chosen from an already-validated JS
  // boolean.
  const createIsLive = tasks.isTaskLive({ special_mode: specialMode });
  const createTask = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tasks (title, description, sort_order, worth, special_mode, special_date, special_bonus, lucky_date, lucky_bonus, flash_bonus, flash_minutes, flash_start_at, live_since)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${createIsLive ? "datetime('now')" : 'NULL'})`
      )
      .run(
        title,
        description,
        order,
        worth,
        specialMode,
        pairResolved.writeDate,
        pairResolved.writeBonus,
        luckyPairResolved.writeDate,
        luckyPairResolved.writeBonus,
        flashResolved.writeBonus,
        flashResolved.writeMinutes,
        flashResolved.writeStartAt
      );
    const taskId = info.lastInsertRowid;

    // One lucky task per day (issue #650) — writing lucky_date = D first
    // clears lucky_date/lucky_bonus on any OTHER task already holding that
    // day, in the SAME transaction as the insert. Touches only the two lucky
    // columns — never special_mode (see the edit route's identical clear,
    // below, for why that matters).
    if (luckyPairResolved.writeDate) {
      db.prepare(
        `UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE lucky_date = ? AND id != ?`
      ).run(luckyPairResolved.writeDate, taskId);
    }

    // One task, one badge (issue #483) — resolveTaskBadge would otherwise
    // lazily insert the shared default-ribbon row the first time this task's
    // card renders; the wizard always supplies a real chosen badge up front,
    // so write it now through the same single writer POST /admin/tasks/:id/badge
    // uses below.
    taskBadges.setTaskBadge(taskId, { name: badgeName, artPath: badgeResolved.artPath });
    return taskId;
  });
  createTask();

  // A newly created LIVE task can make an existing COMPLETIONIST holder
  // stale (issue #701 AC1) by growing the active set; a task created Hidden
  // does not change the active set at all, so this stays conditional
  // instead of firing unconditionally on every create. Reuses
  // createIsLive (computed above for live_since) rather than calling
  // tasks.isTaskLive a second time against the same specialMode value.
  if (createIsLive) {
    scoring.recomputeAfterTaskChange();
  }
  redirectWithMsg(res, '/admin/tasks', 'Task added.');
});

// POST /admin/tasks/:id/edit  — the single edit-popup save (issue #682):
// title, description, worth, badge, and special_mode together in one submit.
//
// Body: title (required), description (optional), worth (3-5 — falls back to
// the task's CURRENT worth if missing/out of range via tasks.normalizeWorth,
// so a direct partial POST — e.g. the pre-#682 title/description-only tests —
// leaves it untouched), special_mode ('none'/'hidden'/'oneday' — same "keep
// current on anything else" guard, via tasks.normalizeMode — the SAME
// write-side owner POST /admin/tasks routes through above, so the two can
// never disagree on what an unrecognized mode becomes), special_date/
// special_bonus (issue #755 — cleared on 'none', untouched on 'hidden' or an
// absent special_mode, validated and written on 'oneday' only when the pair
// differs from what is stored, refused if that changed pair is invalid OR
// this task already carries a submission; see resolveSpecialPairWrite),
// badge_icon (optional — a catalog id; when present it MUST be valid, or the
// whole edit is refused, mirroring POST /admin/tasks/:id/badge's own
// validation), badge_name (optional — a name-only submit with no icon still
// updates just the name, same contract that route already offered).
router.post('/tasks/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }

  const worth = tasks.normalizeWorth(req.body.worth, task.worth);
  const rawSpecialMode = req.body.special_mode;
  const specialMode = tasks.normalizeMode(rawSpecialMode, task.special_mode);

  // special_date/special_bonus (issue #755) — validated BEFORE any write,
  // same discipline as the badge check just below. submissionCount feeds
  // criterion 4's lock: a submission on THIS task (visible or taken down)
  // refuses any save that would change the pair, no matter which of the
  // three doors (ordinary->oneday, day/bonus move, oneday->none) it comes
  // through — resolveSpecialPairWrite is the one place all three are refused
  // by the same rule.
  const submissionCount = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE task_id = ?')
    .get(id).n;
  const pairResolved = resolveSpecialPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.special_date,
    rawBonus: req.body.special_bonus,
    storedDate: task.special_date,
    storedBonus: task.special_bonus,
    submissionCount,
  });

  // The lucky pair (issue #650) — resolved BEFORE the one-day refusal check
  // below, and never locked (a lucky bonus is banked on the submission row
  // at submit time, canon rule 11, so clearing/changing lucky_date/
  // lucky_bonus can never re-score a photo already posted).
  const luckyPairResolved = resolveLuckyPairWrite({
    rawMode: rawSpecialMode,
    rawDate: req.body.lucky_date,
    rawBonus: req.body.lucky_bonus,
    storedDate: task.lucky_date,
    storedBonus: task.lucky_bonus,
  });

  // One clock for this request (issue #763 PR review, minor 5 — matches
  // currentClock()'s own comment intent and what the GET handler already
  // does): both the flash resolver and the exclusivity guard further down
  // need "the same instant", so this is called once, not once per use.
  const clock = currentClock();

  // The flash trio (issue #763) — resolved BEFORE the one-day refusal check
  // below, same "validate everything first" discipline the lucky pair just
  // above follows. `task` is the row's CURRENT flash trio (resolveFlashWrite
  // reads it for both the no-op comparison and tasks.flashState()), and
  // `specialMode` is the ALREADY-normalized value this save is about to
  // write — never 'flash' itself (tasks.js's MODES comment), so `not_live`
  // checks liveness against whatever real mode (none/hidden/oneday) this
  // save resolves to.
  const flashResolved = resolveFlashWrite({
    rawMode: rawSpecialMode,
    rawCancel: req.body.flash_cancel,
    rawBonus: req.body.flash_bonus,
    rawMinutes: req.body.flash_minutes,
    rawStartMode: req.body.flash_start_mode,
    rawDate: req.body.flash_date,
    rawTime: req.body.flash_time,
    storedRow: task,
    resolvedSpecialMode: specialMode,
    clock,
    timezone: getEventConfig().timezone,
  });

  if (!pairResolved.ok) {
    // The one-day refusal still discards the whole rest of the edit exactly
    // as before (title/description/worth/badge/the one-day pair) — EXCEPT a
    // Special=None cancel of an EXISTING lucky pick, which must always land
    // (issue #650 plan step 3's "trap": a task can carry both a past
    // special_date and a lucky_date, and cancelling lucky via Special=None
    // also makes the one-day pair "changed", which the lock above refuses
    // whenever submissions exist — stranding lucky_date with no door left to
    // cancel it through, unless this clear runs regardless of that refusal).
    // Touches only the two lucky columns — never special_mode/special_date,
    // which stay refused and unchanged exactly as describeEditPairRefusal
    // already says.
    let msg = describeEditPairRefusal(pairResolved.reason);
    // Gate on the LUCKY resolver's OWN result (#650), not a re-derived
    // `rawSpecialMode === tasks.MODE_NONE` check — resolveLuckyPairWrite
    // already decided the resolved lucky pair above, and a resolved-to-null
    // pair on a task that WAS lucky is exactly and only "this save cancels
    // the lucky pick," across every reachable rawSpecialMode that can land
    // in this branch (see resolveLuckyPairWrite: the pair only resolves to
    // null when the raw mode is 'none', or when there was never a stored
    // pick to preserve).
    if (luckyPairResolved.writeDate === null && task.lucky_date != null) {
      db.prepare(`UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE id = ?`).run(id);
      // Composed from the SAME describer that built `msg` above, rather than
      // a hand-typed sentence duplicating describeEditPairRefusal's own
      // PAIR_REASON_LOCKED wording — this branch is only reachable with
      // reason LOCKED (see the comment above), so this reads as "Lucky task
      // cancelled." plus that one owner's locked-pair wording.
      msg = 'Lucky task cancelled. ' + describeEditPairRefusal(pairResolved.reason);
    }
    return redirectWithMsg(res, '/admin/tasks', msg, 'task-' + id);
  }

  if (!luckyPairResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeEditLuckyRefusal(luckyPairResolved.reason),
      'task-' + id
    );
  }

  if (!flashResolved.ok) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      describeEditFlashRefusal(flashResolved.reason),
      'task-' + id
    );
  }

  // The resolved pairs ARE what get written — each resolver already decided
  // whether that means the stored pair unchanged (a `hidden` write or an
  // absent field, criterion 6's partial-POST contract) or the validated
  // posted pair (possibly `(null, null)` for a `none` clear).
  const nextSpecialDate = pairResolved.writeDate;
  const nextSpecialBonus = pairResolved.writeBonus;
  const nextLuckyDate = luckyPairResolved.writeDate;
  const nextLuckyBonus = luckyPairResolved.writeBonus;
  const nextFlashBonus = flashResolved.writeBonus;
  const nextFlashMinutes = flashResolved.writeMinutes;
  const nextFlashStartAt = flashResolved.writeStartAt;

  // live_since (issue #778) — bump ONLY on a genuine not-live -> live
  // transition, decided by comparing tasks.isTaskLive against `task` (the
  // row's state BEFORE this save, already loaded above) and `specialMode`
  // (the value THIS save is about to write) — the same before/after
  // liveness comparison the toggle route below already makes as `wasLive`.
  // A title/worth/badge-only edit, a special_date move to a non-today day
  // (AC2), or any edit that leaves liveness unchanged never bumps it — only
  // this one boolean gates the write, so a host correcting a typo can never
  // accidentally re-announce an already-live task.
  const bumpLiveSince = !tasks.isTaskLive(task) && tasks.isTaskLive({ special_mode: specialMode });

  // Exclusivity (issue #650 plan step 3) — only when the posted mode itself
  // names a special kind; SKIPPED for 'none'/'hidden' (the host's own
  // cancel/hide paths must never be refused by this guard). `task` (the
  // row's CURRENT data, before this save) is what whatSpecial reads, so a
  // task re-saving the SAME kind it already is never trips this — it can
  // only disagree when a DIFFERENT rule already owns the row (AC7(c)'s
  // "reverse" case: a task already lucky that the host tries to date as One
  // day only). specialKindBeingSet() (Finding C) is the SAME raw-mode-to-kind
  // mapping the create handler above uses.
  const settingKind = specialKindBeingSet(rawSpecialMode);
  if (settingKind) {
    const exclusivity = checkExclusivity(task, clock, settingKind);
    if (!exclusivity.ok) {
      return redirectWithMsg(
        res,
        '/admin/tasks',
        describeExclusivityRefusal(exclusivity.existingKind),
        'task-' + id
      );
    }
  }

  // A posted icon must resolve, or the WHOLE edit is refused (AC1-style
  // validation from POST /admin/tasks/:id/badge) — never silently drop just
  // the badge half of a combined submit. No DB write happens here yet.
  const badgeResolved = resolveBadgeIcon(req.body.badge_icon, req.body.badge_name, {
    required: false,
  });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'That badge icon is not recognized.', 'task-' + id);
  }

  // Atomic: the task UPDATE and its conditional badge write are
  // one transaction — if setTaskBadge threw, a bare sequential pair could
  // commit the title/worth/mode change alone while leaving the badge half
  // silently un-applied. better-sqlite3 nests transaction functions via
  // SAVEPOINTs, so calling setTaskBadge (itself a db.transaction) from inside
  // this one is safe.
  const saveEdit = db.transaction(() => {
    // live_since (issue #778): CASE WHEN bumpLiveSince THEN datetime('now')
    // ELSE live_since END — bound as an ordinary `?` (0/1) rather than
    // interpolated like the create route's literal, since here the ELSE arm
    // must read back the column's OWN current value (preserve, not clear) —
    // a raw-literal SET clause has no way to express "leave unchanged"
    // without a second query to read the prior value back first.
    db.prepare(
      `UPDATE tasks
          SET title = ?, description = ?, worth = ?, special_mode = ?,
              special_date = ?, special_bonus = ?, lucky_date = ?, lucky_bonus = ?,
              flash_bonus = ?, flash_minutes = ?, flash_start_at = ?,
              live_since = CASE WHEN ? THEN datetime('now') ELSE live_since END
        WHERE id = ?`
    ).run(
      title,
      description,
      worth,
      specialMode,
      nextSpecialDate,
      nextSpecialBonus,
      nextLuckyDate,
      nextLuckyBonus,
      nextFlashBonus,
      nextFlashMinutes,
      nextFlashStartAt,
      bumpLiveSince ? 1 : 0,
      id
    );

    // One lucky task per day (issue #650) — writing lucky_date = D here
    // first clears lucky_date/lucky_bonus on any OTHER task already holding
    // that day, in the SAME transaction. Touches only the two lucky columns
    // — in particular it must NOT write special_mode: a lucky task can be
    // hidden (special_mode='hidden' with lucky_date intact), and
    // liveTaskWhere is `special_mode <> 'hidden'`, so a clear that also
    // reset the mode would republish a task the host deliberately hid, to
    // every guest, with no host action and no message.
    if (nextLuckyDate) {
      db.prepare(
        `UPDATE tasks SET lucky_date = NULL, lucky_bonus = NULL WHERE lucky_date = ? AND id != ?`
      ).run(nextLuckyDate, id);
    }

    // No icon AND no name submitted (the common "didn't touch the badge
    // step" case) leaves the badge row completely untouched — same as
    // POST /admin/tasks/:id/badge's own contract for a body carrying neither.
    if (badgeResolved.name || badgeResolved.artPath) {
      taskBadges.setTaskBadge(id, { name: badgeResolved.name, artPath: badgeResolved.artPath });
    }
  });
  saveEdit();

  // A special_mode change can move the active-task set (issue #701 parity).
  // #755: a special_date CHANGE must trigger the same
  // recompute even when the mode string itself is unchanged (e.g. a
  // stale-date repair, or an ordinary/oneday task's date narrowing/widening
  // without a mode flip is not actually possible today, but the pairing rule
  // does not guarantee it never will be) — badges.js's COMPLETIONIST
  // denominator excludes tasks by `special_date IS NULL`, so a date that
  // starts or stops being set can move who holds it even with special_mode
  // untouched. A worth or badge-only edit still never does, so this call
  // stays conditional rather than firing on every save.
  if (specialMode !== task.special_mode || nextSpecialDate !== task.special_date) {
    scoring.recomputeAfterTaskChange();
  }

  // A hidden task can still hold a live lucky pick (issue #650's "Deliberate
  // omissions, recorded": special_mode='hidden' with lucky_date intact is a
  // supported state, reachable by picking the Hidden radio on an
  // already-lucky task — resolveLuckyPairWrite leaves the pair untouched for
  // any raw mode other than 'lucky'/'none'). Left silent, that parks the
  // day's only lucky slot where no guest can reach it, with no chip and no
  // checklist row to notice from (#650) — one
  // extra sentence on the save's own success message is the cheapest place
  // to surface it.
  let successMsg = 'Task updated.';
  if (specialMode === tasks.MODE_HIDDEN && nextLuckyDate != null) {
    successMsg += " This task is hidden, so guests can't win the lucky bonus on it.";
  }
  redirectWithMsg(res, '/admin/tasks', successMsg, 'task-' + id);
});

module.exports = router;
