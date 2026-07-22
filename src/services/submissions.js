// src/services/submissions.js
//
// The submit-or-replace sequence for "a guest turns in a photo for a task".
//
// submitPhoto() is the one function that knows this whole sequence: validate
// the task is live, build the thumbnail, normalize the caption, upsert the
// submissions row (UNIQUE(guest_id, task_id) means at most one row per task,
// so a second submission REPLACES the first rather than erroring), clean up
// superseded files, and recompute the guest's auto-badges. Before this module
// existed, that ordering knowledge was inlined in the HTTP handler
// (src/routes/guest.js); here it is callable directly with a plain file
// descriptor, so a test — or a future non-HTTP caller — never has to drive a
// multipart request just to record a submission.
//
// submitPhoto() takes an already-parsed file descriptor `{ filename, path }`
// (multer's shape after disk storage runs) and returns a plain status object.
// It never touches req/res/Express/multer — parsing the upload and validating
// its size/type stays the route's job, same as before this module existed.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.
// makeThumb (src/services/photos.js) is the one async step in the sequence.

'use strict';

const { db, getEventConfig } = require('../db');
const photos = require('./photos');
const scoring = require('./scoring');
// tasks.js is the ONE active-task owner (issue #727) — isTaskLive(task)
// consumes it here instead of a hand-written is_active/special_mode check.
// isSealed(task, todayIso) is the ONE one-day-only-challenge seal owner
// (issue #753) — this is the only place a submit gate can live, since the
// route (src/routes/guest.js) never loads the task itself.
const tasks = require('./tasks');
// eventLocalDateString is the ONE "what day is it for the event" owner
// (issue #753) — always the event's configured timezone, never server UTC.
const eventDays = require('./event-days');

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call).
// ---------------------------------------------------------------------------

// special_date/special_bonus (issue #753) are read alongside special_mode so
// a single row load serves both the live/seal gates AND the on-day bonus
// decision below — without special_date the seal predicate would read
// `undefined` and report "not sealed" for every one-day-only task, and
// without special_bonus the banking write would bind `undefined` into
// submissions.bonus_amount, a NOT NULL column, throwing inside submitPhoto.
// flash_start_at/flash_minutes/flash_bonus (issue #761) are read for the
// identical reason, one row load serving the in-window bonus decision below
// too — the same undefined-binds-into-a-NOT-NULL-column failure the #753
// comment warns about would recur for flash_bonus if this select skipped it.
// lucky_date/lucky_bonus (issue #650) are read for the SAME reason, a third
// time: without them, tasks.bonusForTask() reads task.lucky_date as
// `undefined`, the lucky rule's `spokenFor` answers false, and a lucky task
// banks NOTHING — the exact trap this file's own comment at :42-51 already
// names twice.
const stmtActiveTask = db.prepare(
  `SELECT id, special_mode, special_date, special_bonus,
          flash_start_at, flash_minutes, flash_bonus,
          lucky_date, lucky_bonus
     FROM tasks WHERE id = ?`
);

// bonus_amount (issue #753) is read alongside the existing three columns so
// the replace branch below can tell "already banked a bonus on this row"
// (bonus_amount !== 0) apart from "never banked one" (=== 0) WITHOUT a
// second query — a strict `=== 0` check against a SELECT that omitted this
// column would read `undefined` and never bank on a replace (undefined !==
// 0 is always true, but undefined is also never a safe value to reason
// "already banked" from).
const stmtExistingSubmission = db.prepare(
  'SELECT id, photo_path, thumb_path, taken_down, bonus_amount FROM submissions WHERE guest_id = ? AND task_id = ?'
);

// Sticky-takedown replace (issue #190): deliberately does NOT touch
// taken_down. Forcing taken_down = 0 here (as this statement used to) is
// exactly the bug #190 fixed — it let any resubmit silently reverse an
// admin's takedown. Whatever taken_down was before the replace, it still is
// after; only resubmitted (set by stmtMarkResubmitted below, conditionally)
// records that a new photo is waiting behind a still-hidden row.
const stmtReplaceSubmission = db.prepare(
  `UPDATE submissions
      SET photo_path = ?, thumb_path = ?, caption = ?,
          created_at = datetime('now')
    WHERE id = ?`
);

// Flip resubmitted on only when the replace landed on an already-taken-down
// row (issue #190 AC1/AC3). Never flips it off here — restoreSubmission
// (src/services/photos.js) is the single place that clears it, in the same
// transaction as the taken_down flag flip back to 0.
const stmtMarkResubmitted = db.prepare(`UPDATE submissions SET resubmitted = 1 WHERE id = ?`);

// Bank the one-day-only on-day bonus (issue #753) onto an EXISTING row —
// the replace branch's counterpart to stmtInsertSubmission's own
// bonus_amount/bonus_reason columns below. Deliberately its own statement
// rather than folded into stmtReplaceSubmission: it must run ONLY when the
// row has not already banked a bonus (see the `bonus_amount === 0` guard at
// the call site) so a resubmit on a later, off-day date can never overwrite
// an already-banked amount back to 0 — stmtReplaceSubmission itself never
// touches bonus_amount/bonus_reason at all, for exactly that reason.
const stmtBankBonus = db.prepare(
  `UPDATE submissions SET bonus_amount = ?, bonus_reason = ? WHERE id = ?`
);

// Replace + (conditional) bank + (conditional) resubmitted-mark as ONE
// atomic unit (issue #753 review fix). Before this, stmtReplaceSubmission
// ran and committed the new photo_path on its own, uncoordinated with
// stmtBankBonus a few lines later -- if stmtBankBonus threw (e.g. a legacy
// row whose special_bonus was NULL despite its special_date being set,
// binding NULL into bonus_amount's NOT NULL column), the guest was told the
// save failed while the DB already held the new photo, and the superseded-
// file cleanup below (which runs only after this whole block) never ran, so
// the OLD file also leaked. Wrapping all three writes in one
// db.transaction() means a throw from any of them rolls the DB back to the
// old photo_path/thumb_path/bonus_amount/resubmitted values, so "told
// failed" and "the database row is unchanged" stay consistent with each
// other. That guarantee is DB-only, though: the NEW original + thumbnail
// were already written to disk (by multer / makeThumb) before this
// transaction ever runs, and a SQL rollback has no way to touch them -- the
// call site below is responsible for deleting THOSE two files on a throw
// from here, so a rolled-back DB and a pair of leaked orphan files can never
// happen together. better-sqlite3 transactions are synchronous and nest
// fine inside the async submitPhoto function below -- nothing here awaits.
const replaceAndBank = db.transaction((photoPath, thumbPath, cap, existing, bankArgs) => {
  stmtReplaceSubmission.run(photoPath, thumbPath, cap, existing.id);
  if (bankArgs) {
    stmtBankBonus.run(bankArgs.bonusAmount, bankArgs.bonusReason, existing.id);
  }
  if (existing.taken_down === 1) {
    stmtMarkResubmitted.run(existing.id);
  }
});

const stmtInsertSubmission = db.prepare(
  `INSERT INTO submissions
     (guest_id, task_id, photo_path, thumb_path, caption, taken_down, bonus_amount, bonus_reason)
   VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
);

// A "memory" row (issue #247): task_id is explicitly NULL, marking it as not
// tied to any task. UNIQUE(guest_id, task_id) does not block multiple memory
// rows per guest — SQLite treats every NULL as distinct under UNIQUE.
const stmtInsertMemory = db.prepare(
  `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down)
   VALUES (?, NULL, ?, ?, ?, 0)`
);

// The single owner of the caption length cap. Exported (issue #387) so the
// edit-caption view's textarea maxlength reads THIS value instead of a
// hand-copied literal that could drift from the server rule — the same
// single-source shape COMMENT_MAX_LENGTH uses for the comment composer.
const CAPTION_MAX_LENGTH = 500;

// The bonus_reason literals the 'daily' and 'flash' rules bank (issue #753's
// design: "#649 and #650 write their own literals into this same shared
// column, so the vocabulary starts here"). tasks.js is the single OWNER of
// these two literals (issue #761 review fix — all three reviewers): its
// SPECIAL_RULES entries' `reason` fields are what bonusForTask() actually
// writes into submissions.bonus_reason, so this file re-exports the same two
// constants tasks.js declares rather than carrying its own independent
// `const` copy of the identical strings. Before this fix, this module
// declared and exported its own `BONUS_REASON_ONEDAY`/`BONUS_REASON_FLASH`,
// dead inside their own module (nothing here read them — bonusForTask() was
// the write path), with a comment conceding "the two must always hold the
// identical value" and nothing enforcing that; a rule added to tasks.js's
// SPECIAL_RULES alone (as #650's 'lucky' was) would leave this file's
// exported constant set silently one entry short of what actually gets
// written, and #611's receipt / #644's bell (the named future readers of
// this column) would compare a submission's reason against an export that
// simply doesn't exist. Exported here unchanged (re-exported, not renamed)
// so every current importer is unaffected. BONUS_REASON_LUCKY (issue #650)
// re-exported the same way, closing the exact gap this comment warned about.
const { BONUS_REASON_ONEDAY, BONUS_REASON_FLASH, BONUS_REASON_LUCKY } = tasks;

/**
 * Trim and cap a caption to the stored column's limit. A missing or non-string
 * caption (the field is optional in the upload form) becomes '' rather than
 * throwing, mirroring the defensive read the route used to do inline.
 * @param {*} caption - req.body.caption, or any caller-supplied value
 * @returns {string} the value to store, always a string of length <= CAPTION_MAX_LENGTH
 */
function normalizeCaption(caption) {
  return typeof caption === 'string' ? caption.trim().slice(0, CAPTION_MAX_LENGTH) : '';
}

/**
 * Record a guest's photo submission for a task, replacing any prior
 * submission for the same (guestId, taskId) pair.
 *
 * Sequence (each step's failure mode is folded into the returned status so
 * the caller never has to catch — see the read-me at the top of this file):
 *   1. The task must exist and be active. If it is (issue #753) a sealed
 *      one-day-only challenge for the event-local "today" AND the guest holds
 *      no existing (guestId, taskId) row (issue #754 review fix — a guest who
 *      already has a submission, e.g. a task re-dated into the future after
 *      they completed it, may still replace their own photo), the passed-in
 *      original file is deleted and the call returns 'task_inactive',
 *      exactly the same outcome as a hidden task, so a guessed task URL
 *      cannot bank an early submission before its date. Checking this here
 *      (not before the file is written) is what closes the orphan-file leak
 *      the route used to have: multer writes the original to disk BEFORE
 *      this function is ever called, so this is the first point that knows
 *      enough to say the upload was pointless and clean it up.
 *   2. A thumbnail is generated from the original. If that throws, the
 *      original is deleted and the call returns 'thumb_failed'.
 *   3. The caption is normalized (see normalizeCaption).
 *   4. An existing (guestId, taskId) row is replaced in place — preserving
 *      its id AND its current taken_down value (issue #190: a host takedown
 *      is sticky across a resubmit; it no longer self-restores) — or a new
 *      row is inserted. When the replaced row was taken_down, resubmitted is
 *      also set so /admin/photos can flag it for a moderation decision.
 *      Old files are deleted only once the DB write has committed, and only
 *      when their filename actually changed; deletion failures are logged
 *      and ignored, because a leftover file is harmless but losing the new
 *      submission is not.
 *
 *      Issue #753's on-day bonus is BANKED here, never derived at read time
 *      (a replace resets created_at, so a derived bonus would silently
 *      vanish the moment a guest swapped in a better photo the next day): a
 *      brand-new row banks `task.special_bonus` when the task's
 *      `special_date` equals today, else 0. A REPLACED row banks the same
 *      way, but ONLY when it has not already banked a bonus
 *      (`existing.bonus_amount === 0`) — a resubmit on a later, off-day date
 *      must never overwrite (or zero out) a bonus already banked on the day
 *      itself. Issue #761's flash bonus is banked the identical way, from
 *      the identical single decision (see the `bonusDecision` computation
 *      below) — on-day wins when a task is somehow both on-day and
 *      in-window, so the two bonuses never stack (#649's exclusivity rule).
 *   5. Auto-badges are recomputed for the guest. A failure here is logged and
 *      swallowed — the submission the guest just made must never be lost
 *      because a badge recount had a problem.
 *
 * After the recompute (successful or swallowed), the guest's held-badge set is
 * snapshotted again and diffed against the snapshot taken immediately before
 * the recompute (issue #255): `newBadgeIds` is the set of badge codes present
 * after but not before, and `pointsTotal` is the guest's fresh points total.
 * A swallowed recompute failure leaves the after-snapshot identical to the
 * before-snapshot, so `newBadgeIds` comes out empty — never a throw. Everything
 * from the submission upsert through this diff runs with no `await` in
 * between, so on Node's single-threaded event loop no other request's JS can
 * interleave mid-span; a concurrent submit by the same guest cannot corrupt
 * this diff (the only `await` in this function, makeThumb, already completed
 * by this point).
 *
 * @param {object} params
 * @param {number} params.guestId
 * @param {number} params.taskId
 * @param {{filename: string, path: string}} params.file - multer's disk-storage
 *        descriptor: filename is the stored original's relative filename,
 *        path is its absolute path on disk (what makeThumb reads from).
 * @param {*} params.caption - raw caption input; normalized internally.
 * @param {number} [params.nowMs] - epoch milliseconds used for the flash
 *        window decision (tasks.flashState, issue #761). OPTIONAL and
 *        defaulting to the real current time when absent (`undefined`) or
 *        `null` — load-bearing, not incidental: the sole production caller
 *        (src/routes/guest.js's POST /tasks/:id/submit handler, outside this
 *        issue's Touches) passes no `nowMs` key, so a required parameter
 *        would arrive `undefined` there and no flash would ever bank for a
 *        real guest. Explicitly falling back on `null` too (issue #761
 *        review fix), not merely `undefined`: a default parameter
 *        (`nowMs = Date.now()`) only fires for `undefined`, so a caller that
 *        passes `nowMs: null` would otherwise reach tasks.flashState() with
 *        a `null` clock, which that function now deliberately throws on
 *        rather than silently misreading the window state. Treating `null`
 *        the same as "not passed" keeps this an optional seam in practice,
 *        not merely in the destructuring default, and is a deliberate
 *        choice: this parameter's only job is an optional test/future-caller
 *        override, so a caller handing it an explicit non-value is read as
 *        "no override," not as a request to crash.
 *
 *        A `NaN` `nowMs`, by contrast, is NOT treated as "not passed" (issue
 *        #761 review fix): it means the caller computed a clock and
 *        got garbage, and silently substituting the real clock would bank
 *        (or fail to bank) against an instant the caller never asked for.
 *        `NaN` falls through unchanged to tasks.flashState()'s own
 *        `Number.isFinite` guard, which throws — reporting the caller's bug
 *        instead of masking it. `nowMs: 0` (falsy but not nullish) is a real
 *        clock value and is honored as-is, never replaced.
 *
 *        A test injects a genuine fixed instant instead, which is also what
 *        makes a scheduled-then-armed flash testable with no real `sleep`
 *        and no write between the two submits (criterion 7) — either of
 *        those would itself be the "action in between" the criterion
 *        requires there to be none of. The event-local DAY clock (`todayIso`
 *        below) is a separate, pre-existing seam — derived internally from
 *        `eventDays.eventLocalDateString(...)`, not reachable through this
 *        parameter, and unaffected by it.
 * @returns {Promise<{status: 'created'|'replaced'|'replaced_hidden'|'task_inactive'|'thumb_failed', submissionId?: number, newBadgeIds?: string[], pointsTotal?: number, luckyBonus?: number}>}
 *   luckyBonus (issue #650) is the banked lucky amount, present only when
 *   status is 'created' AND the presently-paying rule is lucky — `undefined`
 *   for every ordinary completion and for any replace (lucky never banks on
 *   a replace; see banksOnReplace on tasks.js's SPECIAL_RULES lucky entry).
 */
async function submitPhoto({ guestId, taskId, file, caption, nowMs }) {
  // Only nullish (absent/undefined, or explicit null) means "use the real
  // clock" — see the nowMs param doc above for why this is not simply a
  // `nowMs = Date.now()` destructuring default (issue #761 review fix). A
  // NaN nowMs is deliberately NOT caught here (issue #761 review fix): it
  // falls through unchanged to tasks.flashState()'s own
  // Number.isFinite guard, which throws — a caller-computed garbage clock is
  // a caller bug to report, not a "not passed" signal to mask with the real
  // clock. `nowMs: 0` is likewise passed through unchanged: it is a real
  // (falsy but not nullish) clock value, not a "not passed" signal.
  const clockMs = nowMs == null ? Date.now() : nowMs;
  const task = stmtActiveTask.get(taskId);
  if (!task || !tasks.isTaskLive(task)) {
    photos.deleteOriginalFile(file.filename);
    return { status: 'task_inactive' };
  }

  // Event-local "today" (issue #753) — never server UTC. Computed once per
  // call and reused below for both the seal check and the on-day bonus
  // decision, so the two can never disagree about what day it is.
  const todayIso = eventDays.eventLocalDateString(getEventConfig().timezone);

  // Looked up BEFORE the seal check (issue #754 review fix) so the seal gate
  // can fall through for a guest who already holds a row for this task —
  // mirrors the GET /tasks/:id gate in src/routes/guest.js, which lets that
  // same guest reach the detail page (and its "Replace your photo" form) for
  // a task later re-dated into the future. Without this fall-through the
  // page renders a form whose own submit 404s: the guest taps Replace,
  // uploads, and loses the file for nothing. Any existing row counts, taken
  // down or not — task.ejs offers the Replace form in both variants (see its
  // own "existing-submission" section), so the submit gate must accept
  // whatever the render gate already let through.
  const existing = stmtExistingSubmission.get(guestId, taskId);
  if (tasks.isSealed(task, todayIso) && !existing) {
    // Sealed one-day-only challenge, no existing submission to fall back on:
    // identical outcome to a hidden task — a guessed URL cannot bank an
    // early submission before its date.
    photos.deleteOriginalFile(file.filename);
    return { status: 'task_inactive' };
  }

  const photoPath = file.filename;
  let thumbPath;
  try {
    thumbPath = await photos.makeThumb(file.path);
  } catch (_err) {
    photos.deleteOriginalFile(photoPath);
    return { status: 'thumb_failed' };
  }

  const cap = normalizeCaption(caption);

  // The single banking decision (issue #761 plan step 3; review fix):
  // tasks.bonusForTask() derives
  // {amount, reason} directly from the SAME SPECIAL_RULES list and the same
  // ordered findSpecialRule walk tasks.whatSpecial() (the exclusivity guard)
  // uses, reading the column/reason straight off whichever rule is
  // presently paying — so this banking decision and the guard can never
  // independently drift out of step the way a hand-restated precedence here
  // once did, AND a new rule (#650's 'lucky') is fully wired for banking by
  // adding ONE SPECIAL_RULES entry in tasks.js, not a second hand-written
  // mapping here. Concretely: a task with special_date set to a FUTURE day
  // (sealed) whose flash window is simultaneously active, submitted by a
  // guest who already holds a row on this task (the only way to reach the
  // seal gate's existing-row fall-through above), used to bank 'flash' here
  // under the old isOnDay-then-flashActive hand fork — isOnDay was false
  // (the date is in the future) so it fell straight to flashActive (true) —
  // while tasks.whatSpecial() answered 'daily' for the identical row and
  // instant. bonusForTask() closes that gap: 'daily' owns the row (it is
  // sealed), so 'flash''s paying condition is never even consulted, and
  // 'daily' itself isn't paying yet (isOnDay is false), so bonusForTask()
  // returns null and nothing banks — matching the guard instead of silently
  // disagreeing with it. `null` means neither rule is presently paying — an
  // ordinary submission, one that is off-day and out-of-window, or one that
  // is sealed/scheduled but not yet in its own paying instant.
  const bonusDecision = tasks.bonusForTask(task, { todayIso, nowMs: clockMs });

  // The lucky-win flag (issue #650 plan step 4, DESIGN.md's exact prescribed
  // expression): true only when the presently-paying rule IS lucky. Both
  // halves are load-bearing. Without the reason test, the gold clover would
  // fire on an ordinary daily/flash payout too. Without the `!== null` guard,
  // `bonusDecision.reason` throws a TypeError for every ordinary submission
  // (bonusForTask() returns bare `null`, not an object, when nothing is
  // paying) — 500ing POST /tasks/:id/submit, the app's most-travelled write
  // path. Only ever surfaced to the caller for a 'created' status below (see
  // the returned object) — a replace can never actually bank lucky
  // (banksOnReplace: false above), so there is nothing for a replace to
  // report here even though `luckyActive` itself does not know that.
  const luckyActive = bonusDecision !== null && bonusDecision.reason === tasks.BONUS_REASON_LUCKY;

  let status;
  let submissionId;
  if (existing) {
    submissionId = existing.id;

    // coalescedBonus decides whether THIS replace should also bank a bonus:
    // only when bonusDecision names one (the task is presently paying) AND
    // the existing row has not already banked one (existing.bonus_amount ===
    // 0) -- a resubmit on a later, off-day/out-of-window date must never
    // overwrite (or zero out) a bonus already banked (issue #753 review fix,
    // generalized by #761 plan step 3 to whichever rule bonusDecision
    // names). bonusDecision.amount itself is always a plain number here,
    // never null/undefined -- tasks.bonusForTask() (src/services/tasks.js)
    // is the owner of that guarantee now (issue #761 review fix): it
    // coalesces the 'daily' rule's special_bonus column to 0 for a
    // legacy pre-chk_special_pairing row (special_date set, special_bonus
    // still NULL), and needs no such coalesce for 'flash' because
    // tasks.flashState() -- and so tasks.bonusForTask() -- already
    // refuse to pay 'flash' unless flash_bonus is an integer in [1, 3]
    // (issue #761 review fix). See SPECIAL_RULES' two entries in
    // tasks.js for the full reasoning; this file no longer carries its own
    // copy.
    //
    // bonusReason comes straight off bonusDecision.reason (issue #761 review
    // fix) -- tasks.bonusForTask() is now the single owner of "no
    // reason beside a zero amount" (see its own doc comment), already
    // returning `reason: null` whenever `amount` coalesced to 0 on that same
    // legacy-row shape. This branch no longer re-applies its own `> 0` guard
    // around that same rule a second time.
    // banksOnThisReplace also requires bonusDecision.banksOnReplace !== false
    // (issue #650 plan step 4) — lucky's SPECIAL_RULES entry is the one rule
    // that sets this to the literal `false` (daily/flash leave it
    // `undefined`, which is "anything other than false", so their existing
    // behaviour is unchanged). Without this half of the guard, a guest whose
    // OWN prior (still-existing, soft-taken-down) submission on a task that
    // becomes lucky today would bank the lucky bonus on their re-upload —
    // exactly the gaming path the owner named and criterion 3 refuses.
    const banksOnThisReplace =
      bonusDecision && bonusDecision.banksOnReplace !== false && existing.bonus_amount === 0;
    const coalescedBonus = banksOnThisReplace ? bonusDecision.amount : null;
    const bankArgs =
      coalescedBonus !== null
        ? {
            bonusAmount: coalescedBonus,
            bonusReason: bonusDecision.reason,
          }
        : null;

    // One atomic write (see replaceAndBank's own comment above): the photo
    // swap, the bonus bank, and the resubmitted-mark either all land or none
    // do, so a throw here can never leave the guest told "failed" while the
    // DB already holds the new photo. The DB rollback does not reach disk,
    // though: photoPath/thumbPath were already written by multer/makeThumb
    // before this call, so a throw here must also delete THOSE two (not
    // existing.photo_path/thumb_path -- the superseded-file cleanup below
    // still owns cleaning up the OLD files once a replace actually commits)
    // before rethrowing, or a failed replace would leak the new upload to
    // DATA_DIR forever with nothing left pointing at it.
    try {
      replaceAndBank(photoPath, thumbPath, cap, existing, bankArgs);
    } catch (err) {
      photos.deleteOriginalFile(photoPath);
      photos.deleteThumbFile(thumbPath);
      throw err;
    }

    if (existing.taken_down === 1) {
      // Sticky takedown (issue #190): the row stays hidden. Mark it
      // resubmitted so the host sees a decision waiting on /admin/photos.
      status = 'replaced_hidden';
    } else {
      status = 'replaced';
    }

    // Delete the superseded files only after the DB write committed, and only
    // when the filename actually changed. Failures are logged and ignored: a
    // leftover file on disk is harmless, but this must never undo the write
    // above.
    try {
      if (existing.photo_path && existing.photo_path !== photoPath) {
        photos.deleteOriginalFile(existing.photo_path);
      }
      if (existing.thumb_path && existing.thumb_path !== thumbPath) {
        photos.deleteThumbFile(existing.thumb_path);
      }
    } catch (err) {
      console.error('superseded-file cleanup failed:', err);
    }
  } else {
    // Coalesce the same way the replace branch above does — see that
    // branch's comment. This DELIBERATELY TIGHTENS the insert branch (issue
    // #761 plan step 3): before this issue it wrote bonus_reason
    // unconditionally (`isOnDay ? BONUS_REASON_ONEDAY : null`) beside an
    // amount that coalesces to 0 on a legacy row whose special_bonus is
    // NULL — exactly the reason-beside-zero state tasks.bonusForTask() now
    // forbids by construction (issue #761 review fix: see that
    // function's own doc comment). bonusReason comes straight off
    // bonusDecision.reason, with no `> 0` guard re-applied here — both
    // branches now defer to the SAME producer-owned rule instead of each
    // carrying their own copy that could drift.
    const bonusAmount = bonusDecision ? bonusDecision.amount : 0;
    const bonusReason = bonusDecision ? bonusDecision.reason : null;
    const info = stmtInsertSubmission.run(
      guestId,
      taskId,
      photoPath,
      thumbPath,
      cap,
      bonusAmount,
      bonusReason
    );
    submissionId = info.lastInsertRowid;
    status = 'created';
  }

  // Snapshot the guest's held-badge codes immediately before the recompute
  // (issue #255) so the diff below can tell which badges this submission
  // newly earned, as opposed to badges the guest already held.
  const beforeBadgeCodes = new Set(scoring.getGuestBadges(guestId).map((b) => b.code));

  // Recompute points + badges now that completion may have changed: one seam
  // that runs the per-guest auto/metric pass and the global transferable pass
  // in order (issue #80 — a new submission can both grant this guest a metric
  // badge AND change who holds a registered transferable one). A failure
  // here must not lose the photo just recorded above, so it is logged and
  // swallowed rather than propagated.
  try {
    scoring.recomputeAfterSubmissionChange(guestId);
  } catch (err) {
    console.error('recomputeAfterSubmissionChange failed:', err);
  }

  // Diff against the before-snapshot. When the recompute above threw and was
  // swallowed, the guest's badge set never changed, so this naturally comes
  // out empty rather than throwing.
  const newBadgeIds = scoring
    .getGuestBadges(guestId)
    .map((b) => b.code)
    .filter((code) => !beforeBadgeCodes.has(code));

  // Points are driven by completed-task count / bonuses, not by the badges
  // table, so this total is correct regardless of whether the recompute above
  // succeeded.
  const pointsTotal = scoring.getPoints(guestId);

  // luckyBonus (issue #650 plan step 4) is surfaced only for a genuine
  // 'created' completion — the only status src/routes/guest.js ever turns
  // into a one-shot success-card reward (setTaskCompleteReward is called for
  // 'created' alone). Gating on status here, not just on luckyActive, matters
  // because luckyActive alone would read true on a REPLACE too whenever
  // lucky is presently paying (banksOnReplace: false only stops the actual
  // bank, not `paying` itself from answering true) — this field must report
  // what was ACTUALLY banked, never what bonusForTask() merely says is
  // theoretically active right now.
  const luckyBonus = status === 'created' && luckyActive ? bonusDecision.amount : undefined;

  return { status, submissionId, newBadgeIds, pointsTotal, luckyBonus };
}

/**
 * Record a batch of "memory" photos for a guest — visible submissions with
 * task_id = NULL (issue #247): photos that don't correspond to any task, so a
 * guest's camera roll can still end up in the shared gallery.
 *
 * Unlike submitPhoto(), this:
 *   - never replaces an existing row (a guest may share any number of
 *     memories; there is no (guestId, NULL) row to collide with — SQLite's
 *     UNIQUE(guest_id, task_id) treats every NULL as distinct);
 *   - never calls scoring.recomputeAfterSubmissionChange. Since issue #656
 *     memories are NOT excluded from points — the first memory of an
 *     event-local day contributes the memory-day term
 *     (scoring.memoryDayCount) to the guest's total — but that term is
 *     DERIVED on every read from `created_at`, never banked into a stored
 *     column, so there is still nothing here for a recompute to WRITE. Badges are
 *     unaffected either way: no metric/auto badge rule reads a memory row
 *     (scoring.getCompletedCount's task_id IS NOT NULL filter excludes
 *     memories from the completed-task count every auto badge threshold and
 *     COMPLETIONIST read), so a recompute here would still be a no-op for
 *     badges specifically. The absent call is a decision, not an omission.
 *
 * Each file gets the same photos.makeThumb() step submitPhoto uses. Thumbnail
 * generation is async (sharp) and must complete before the row insert, so it
 * runs first, file by file; only the (synchronous) inserts run inside one
 * db.transaction. A file whose thumbnail fails (e.g. a corrupt upload that
 * slipped past fileFilter — same failure mode submitPhoto's 'thumb_failed'
 * status covers) is skipped: its original is deleted from disk and it
 * contributes no row, but the rest of the batch still proceeds — one bad file
 * among ten should not cost the guest the other nine.
 *
 * @param {object} params
 * @param {number} params.guestId
 * @param {{filename: string, path: string}[]} params.files - multer disk-storage
 *        descriptors (photos.uploadMemoryBatch's req.files).
 * @param {*} params.caption - raw caption input; normalized and applied to
 *        every photo in the batch (the form has one caption field, not
 *        per-photo captions).
 * @returns {Promise<{status: 'created', submissionIds: number[]}>}
 */
async function submitMemoryBatch({ guestId, files, caption }) {
  const cap = normalizeCaption(caption);

  const prepared = [];
  for (const file of files) {
    let thumbPath;
    try {
      thumbPath = await photos.makeThumb(file.path);
    } catch (_err) {
      photos.deleteOriginalFile(file.filename);
      continue; // skip this one file; the rest of the batch still proceeds
    }
    prepared.push({ photoPath: file.filename, thumbPath });
  }

  const submissionIds = [];
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const info = stmtInsertMemory.run(guestId, row.photoPath, row.thumbPath, cap);
      submissionIds.push(info.lastInsertRowid);
    }
  });
  insertMany(prepared);

  return { status: 'created', submissionIds };
}

module.exports = {
  submitPhoto,
  submitMemoryBatch,
  normalizeCaption,
  CAPTION_MAX_LENGTH,
  BONUS_REASON_ONEDAY,
  BONUS_REASON_FLASH,
  BONUS_REASON_LUCKY,
};
