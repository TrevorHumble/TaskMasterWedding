// src/services/tasks.js
//
// The ONE active-task owner (issue #727): the single definition of "live for
// guests" every reader in the app consults, plus the worth constants a task
// row carries. Dependency-free (no `db` require) — a pure module of constants
// and predicates over an already-loaded task row or a caller-supplied SQL
// alias, so requiring this file can never introduce a require cycle.
//
// special_mode replaces the old is_active (0/1) column (#727): 'none' is an
// ordinary live task, 'hidden' is what the admin toggle now writes instead of
// is_active = 0. The enum is forward-compatible with a future mode because
// liveness is defined as "not hidden" (`<> 'hidden'`) rather than "= none" —
// a future mode is live automatically, with no reader needing an update.
// 'oneday' (#753) already extended it this way. Flash (#761) and lucky
// (#650) deliberately do NOT — see the MODES comment below for the
// reasoning — so a reader hitting this paragraph first should not expect a
// matching flash or lucky mode further down; both are read-time state
// instead (see SPECIAL_RULES below), never a stored special_mode member.
//
// Mirrors feed.js's VISIBLE_WHERE ownership pattern: liveTaskWhere() returns a
// SQL fragment string a caller interpolates into its own prepared statement
// (a trusted internal constant, never user input), and isTaskLive() is the
// JS-level equivalent for a caller that already holds a loaded row rather
// than running a query. This is the ONLY place the 'hidden' liveness literal
// lives — every converted reader (guest.js, admin.js, badges.js,
// submissions.js) consumes one of these two instead of re-deriving it.

'use strict';

const MODE_NONE = 'none';
const MODE_HIDDEN = 'hidden';
const MODE_ONEDAY = 'oneday';

// Every mode this build's JS layer recognizes (#682 — the
// WRITE-side counterpart to liveTaskWhere/isTaskLive's READ-side ownership).
// normalizeMode/isValidMode below are the two consumers of THIS list, and
// they pick up a new value automatically once it is added here — but this
// array is NOT the only place a new mode must be registered.
//
// 'oneday' (issue #753) is registered here and its CHECK widened in src/db.js
// (ensureTaskSpecialDayColumns). #755 wired the host-facing screen: both
// task-create-dialog.ejs and task-edit-dialog.ejs include the shared
// special-oneday-option.ejs partial, offering a "One day only" radio that
// opens a day/bonus accordion, and src/routes/admin.js's create/edit
// handlers accept, validate and persist special_date/special_bonus alongside
// special_mode. A host reaches 'oneday' through that UI now, and every save
// that sets special_date does so through the paired write those handlers
// share with the guard below.
//
// special_mode='oneday' with special_date left NULL is reachable,
// deliberately not closed off by #755's validation (architecture review
// note): a hand-crafted EDIT POST that carries special_mode=oneday
// while omitting/blanking special_date on a task ALREADY stored with a NULL
// pair (an ordinary task) posts a pair equal to what is already stored, so
// resolveSpecialPairWrite's pairChanged is false and its validation never
// runs (src/routes/admin.js). The row this produces is still harmless: not
// sealed (isSealed requires special_date), not excluded from Completionist
// (that exclusion also keys on special_date), never a crash — same as
// before this issue.
//
// Flash (issue #761) deliberately does NOT extend this list, and needs
// NEITHER by-hand update below. The owner's rule is that a flash task
// reverts to no-special automatically the instant its window ends, with no
// stale state; a stored
// enum value cannot expire on its own without either a scheduler (this app
// has none) or a write on every read, so flash is read-time-evaluated state
// instead (flashState()/whatSpecial() below), decorated onto an
// already-loaded row exactly the way isSealed()/isOnDay() already are for
// one-day-only. The host-facing "Flash" radio option (#763) is likewise
// derived render state, never a written special_mode value.
//
// Lucky (issue #650) landed the same way, for a different reason: the owner
// wants the task's Special radio to POST special_mode=lucky, but the row
// never actually stores that value — tasks.normalizeMode below coerces the
// posted 'lucky' to the handler's fallback ('none', or 'hidden' if the host
// also hides it), while tasks.lucky_date (src/db.js) carries the "this task
// is lucky" fact instead. So lucky needs NEITHER of the two by-hand updates
// below either, for the SAME two reasons flash didn't:
//   - src/db.js: no CHECK widen needed, because no MODES/special_mode value
//     is ever written for lucky in the first place.
//   - the two dialog partials: lucky already has its own radio
//     (src/views/partials/special-lucky-option.ejs, included by both), so
//     there is no missing <label> to add.
const MODES = [MODE_NONE, MODE_HIDDEN, MODE_ONEDAY];

const MIN_WORTH = 3;
const MAX_WORTH = 5;
const DEFAULT_WORTH = 3;

/**
 * The SQL fragment for "this task is live" — `<alias>.special_mode <>
 * 'hidden'`, or the bare column name when no alias is given. A caller
 * interpolates this into its own WHERE clause; it is never itself a
 * prepared statement.
 *
 * @param {string} alias - the table alias the query uses for `tasks` (e.g.
 *   't'), or '' for an unaliased single-table query.
 * @returns {string}
 */
function liveTaskWhere(alias) {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}special_mode <> '${MODE_HIDDEN}'`;
}

// A YYYY-MM-DD-shaped string. sealedTaskWhere below defensively validates
// against this before interpolating a caller-supplied `todayIso` into SQL
// text — `todayIso` is always module-computed (src/services/event-days.js's
// eventLocalDateString), never user input, but the check catches a future
// caller passing something else by mistake rather than silently building a
// malformed (or, in the worst case, injectable) WHERE clause.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ONE owner of "is this one-day-only challenge sealed" (issue #753):
 * `taskRow` is sealed exactly when it carries a `special_date` strictly
 * AFTER `todayIso` — a task dated tomorrow is sealed, a task dated TODAY is
 * OPEN (the whole point of the feature: it unseals on the day itself, not
 * the day after), and a task dated yesterday (or any earlier day) is also
 * open, same as an ordinary task. An ordinary task (`special_date` NULL or
 * undefined) is never sealed. Plain string comparison is correct here
 * because both sides are always `YYYY-MM-DD` — that format sorts
 * lexicographically identically to sorting by actual calendar date.
 *
 * `todayIso` is a parameter, not read from a clock in here, so this stays a
 * pure function of its inputs — the caller (src/services/submissions.js)
 * derives "today" from event-days.js's eventLocalDateString(), never server
 * UTC, and a test can pin any `todayIso` it likes without mocking a clock.
 *
 * @param {{special_date?: string|null}} taskRow
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {boolean}
 */
function isSealed(taskRow, todayIso) {
  // Validate todayIso the same way sealedTaskWhere() below does, and fail
  // the same way (#753): two owners of one rule must not disagree
  // about invalid input; both now throw.
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(`isSealed: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  }
  return !!(taskRow && taskRow.special_date && taskRow.special_date > todayIso);
}

/**
 * The ONE owner of "is taskRow's day today" (#754):
 * true exactly when `taskRow.special_date` equals `todayIso`. Two callers
 * need this identical calendar fact — src/services/submissions.js's on-day
 * bonus banking (does the bonus actually get banked) and
 * src/routes/guest.js's "+N pts Today Only" flag (is the gold flag shown) —
 * and before this function existed each independently wrote
 * `special_date === todayIso` inline, so widening the on-day window would
 * have needed the same edit made twice, with nothing forcing the two to
 * agree. Validates `todayIso` the same way isSealed() does, for the same
 * reason: two owners of one rule must not disagree about invalid input.
 *
 * @param {{special_date?: string|null}} taskRow
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {boolean}
 */
function isOnDay(taskRow, todayIso) {
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(`isOnDay: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  }
  return !!(taskRow && taskRow.special_date === todayIso);
}

/**
 * The ONE owner of "is taskRow's day strictly in the past" (#662): true exactly
 * when `taskRow.special_date` is a REAL calendar date (isRealDateString
 * below, not the shape-only isValidDateString — special_date is a free-form
 * TEXT column that can hold a regex-shaped-but-impossible value like
 * '2026-13-45', same as isSealed's doc comment already warns) strictly
 * BEFORE `todayIso`. The third sibling of isSealed (`>`) and isOnDay (`=`)
 * over this same `special_date` fact.
 *
 * Before this function existed, the `<` comparison lived ONLY inside
 * SPECIAL_RULES' daily `missed` predicate below, and a second caller
 * (src/services/host-checklist.js's rank-and-award row, issue #662) had
 * independently re-derived the identical comparison a second time rather
 * than reusing it — exactly the two-owners-of-one-rule drift isSealed's own
 * doc comment warns against. The daily `missed` predicate below now calls
 * this function instead of carrying its own inline copy, and
 * host-checklist.js's dated arm calls it too.
 *
 * Validates `todayIso` the same way isSealed()/isOnDay() do, and fails the
 * same way: two owners of adjacent rules over the same column must not
 * disagree about invalid input.
 *
 * @param {{special_date?: string|null}} taskRow
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {boolean}
 */
function isPastDay(taskRow, todayIso) {
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(`isPastDay: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`);
  }
  return !!(taskRow && isRealDateString(taskRow.special_date) && taskRow.special_date < todayIso);
}

/**
 * True for a value shaped like a real YYYY-MM-DD date string (#754) — the
 * same shape ISO_DATE_RE already validates `todayIso` against above.
 * Exported so a caller holding a task row's OWN `special_date` (a
 * free-form TEXT column with no shape constraint — see isSealed's doc
 * comment) can defensively check it before doing date math that would
 * otherwise throw on a malformed value, e.g. eventDays.dayOpensAt()'s
 * Intl.DateTimeFormat calls, which throw a RangeError on an instant built
 * from an unparseable date.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidDateString(value) {
  return typeof value === 'string' && ISO_DATE_RE.test(value);
}

/**
 * True for a value that is BOTH shaped like a date (isValidDateString above)
 * AND names a real calendar date — `isValidDateString('2026-13-45')` is
 * true (it matches the shape) while this is false. `special_date` is
 * free-form TEXT with no CHECK constraint tying it to a real calendar day
 * (see isSealed's doc comment), so a caller that needs to know "can I safely
 * do date math / render a label from this value" needs the stronger check,
 * not just the shape one.
 *
 * The ONE owner of this combined check (#755): `src/routes/admin.js` calls
 * `tasks.isRealDateString()` here rather than keeping its own local
 * `isRealDate()` (round-tripping the parsed y/m/d through `Date.UTC()`),
 * so this module owns every piece of this logic, not a duplicate.
 * `src/routes/guest.js:176`/`:398` still
 * check shape ONLY (`isValidDateString`), not reality — a value that passes
 * shape but fails reality (e.g. `'2026-13-45'`) is not on guest.js's Touches
 * list for this issue and is left exactly as it was, deliberately not
 * upgraded to this stronger check here.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isRealDateString(value) {
  if (!isValidDateString(value)) {
    return false;
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * The SQL fragment mirroring isSealed() above, for a caller running a query
 * instead of testing an already-loaded row (e.g. a future list query that
 * must exclude a sealed challenge — #754). Same alias convention as
 * liveTaskWhere(). `todayIso` is validated against ISO_DATE_RE before being
 * interpolated (see that constant's comment) rather than bound as a `?`
 * parameter, matching liveTaskWhere's own "trusted internal constant"
 * interpolation style one line up.
 *
 * @param {string} alias - the table alias the query uses for `tasks`, or ''
 *   for an unaliased single-table query.
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {string}
 */
function sealedTaskWhere(alias, todayIso) {
  if (!ISO_DATE_RE.test(todayIso)) {
    throw new Error(
      `sealedTaskWhere: todayIso must be YYYY-MM-DD, got ${JSON.stringify(todayIso)}`
    );
  }
  const prefix = alias ? `${alias}.` : '';
  // Parenthesized as one atom (#753): liveTaskWhere()
  // returns a single atom, but this fragment is two ANDed conditions. A
  // caller building `WHERE ... AND NOT ${sealedTaskWhere(...)}` (the
  // exclusion shape this function's own consumers use, e.g. #754's guest
  // task list) would otherwise get `NOT` binding to only the FIRST
  // condition -- `NOT (special_date IS NOT NULL) AND special_date > '...'`
  // -- which matches zero rows, since a row failing the first half can never
  // satisfy the second. Wrapping the whole fragment makes NOT apply to the
  // fragment as a unit, matching how a caller reading this as "one
  // predicate" expects it to compose.
  return `(${prefix}special_date IS NOT NULL AND ${prefix}special_date > '${todayIso}')`;
}

/**
 * The ONE owner of "is this task a one-day-only challenge" (#753): true
 * whenever `taskRow` carries a `special_date`, regardless
 * of whether it is presently sealed. `special_date` is the single
 * authoritative "this is a challenge" fact (see the doc comment on the
 * `tasks.special_date` column, `src/db.js`) -- `special_mode`'s `'oneday'`
 * value is a lockstep marker, never read here. Before this function existed,
 * `src/services/badges.js`'s Completionist query hand-wrote
 * `t.special_date IS NULL` inline even though this module is the declared
 * owner of every other task-state predicate; #754 and #756 both need this
 * same fact and would otherwise each re-write it a third and fourth time.
 *
 * @param {{special_date?: string|null}} taskRow
 * @returns {boolean}
 */
function isChallenge(taskRow) {
  return !!(taskRow && taskRow.special_date != null);
}

/**
 * The SQL fragment mirroring isChallenge() above, for a caller running a
 * query instead of testing an already-loaded row. Same alias convention as
 * liveTaskWhere/sealedTaskWhere, and parenthesized as one atom for the same
 * reason sealedTaskWhere is (see that function's comment) -- a caller is
 * expected to compose this behind a `NOT`.
 *
 * @param {string} alias - the table alias the query uses for `tasks`, or ''
 *   for an unaliased single-table query.
 * @returns {string}
 */
function challengeTaskWhere(alias) {
  const prefix = alias ? `${alias}.` : '';
  return `(${prefix}special_date IS NOT NULL)`;
}

// The pinned flash-instant shape (issue #761 Design — "the serialization
// form is part of the contract, not an implementation detail"): exactly what
// Date.prototype.toISOString() emits. parseFlashInstant() below is the ONE
// owner of both halves of "is this instant usable" — it uses these capture
// groups both to check the shape and to reconstruct the instant for the
// strict real-date check, and flashState() and the exported
// isValidFlashInstant() both delegate to it rather than each carrying their
// own shape-then-reality pair (#761).
const FLASH_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

// Exported (#761) for the identical reason
// isValidFlashInstant is exported: #763 is the flash_bonus write path and
// its own Touches cannot reach this file, so #763's host-facing 1-3 bonus
// picker validates against THESE two constants rather than hand-copying the
// range flashState() enforces below — one owner of "what bonus range is
// legal," consulted by the writer and the reader alike.
const FLASH_MIN_BONUS = 1;
const FLASH_MAX_BONUS = 3;

// The lucky-bonus range (issue #650 plan step 2), exported for the identical
// reason FLASH_MIN_BONUS/FLASH_MAX_BONUS are: src/routes/admin.js's lucky
// setter validates a posted lucky_bonus against THESE two constants rather
// than hand-copying the range the lucky SPECIAL_RULES entry's `paying`
// predicate enforces below — one owner of "what bonus range is legal,"
// consulted by the writer and the reader alike.
const LUCKY_MIN_BONUS = 1;
const LUCKY_MAX_BONUS = 3;

const FLASH_NONE = 'none';
const FLASH_SCHEDULED = 'scheduled';
const FLASH_ACTIVE = 'active';
const FLASH_EXPIRED = 'expired';

// The two SPECIAL_RULES `kind` literals (#761),
// exported alongside the four FLASH_* window-state constants above for the
// same reason: MODE_* and BONUS_REASON_* are both exported so a consumer
// compares against a named constant rather than hand-writing the bare
// string, and 'daily'/'flash' were the one pair in this module still
// written inline at every comparison site. #762/#763/#650 compare against
// these instead of re-typing 'daily'/'flash'; #650's 'lucky' extension adds
// a third constant the same way.
const SPECIAL_DAILY = 'daily';
const SPECIAL_FLASH = 'flash';
const SPECIAL_LUCKY = 'lucky';

// The bonus_reason literals SPECIAL_RULES' `reason` fields write into
// submissions.bonus_reason (#761).
// THIS file is the single owner: SPECIAL_RULES' entries below reference
// these two constants instead of hand-writing the strings a second time, and
// src/services/submissions.js re-exports them (destructured from this
// module, not redeclared) rather than carrying its own copy that could drift
// silently out of step with what bonusForTask() actually writes. Before this
// fix, submissions.js declared its own `const BONUS_REASON_ONEDAY = 'oneday'`
// / `const BONUS_REASON_FLASH = 'flash'` holding the identical two strings,
// dead inside their own module (bonusForTask() never read them), with
// nothing enforcing the two copies agreed — a future rule (#650's 'lucky')
// added to SPECIAL_RULES alone would leave submissions.js's exported
// constant set one entry short, so #611's receipt and #644's bell (the named
// future readers of this column) would compare a submission's reason against
// an export that simply doesn't exist, matching nothing, silently.
//
// Deliberately NOT the same string as the matching `kind` above: 'daily'
// (SPECIAL_DAILY, the SPECIAL_RULES `kind`) and 'oneday' (BONUS_REASON_ONEDAY,
// the literal actually stored in submissions.bonus_reason) name the same
// rule but are two distinct vocabularies for two distinct purposes — `kind`
// identifies a SPECIAL_RULES entry in memory, `reason` is a frozen value
// already persisted in existing rows. Do not "simplify" bonus_reason to
// reuse `kind`'s spelling; that would silently change what every existing
// 'oneday' row means without a migration.
const BONUS_REASON_ONEDAY = 'oneday';
const BONUS_REASON_FLASH = 'flash';
// Deliberately the SAME spelling as SPECIAL_LUCKY ('lucky') above, unlike the
// daily/oneday and flash/flash pairs — there is no pre-existing 'lucky'
// vocabulary anywhere this issue's rows predate, so there was never a reason
// to invent a second spelling for the same rule the way 'daily'/'oneday'
// diverged for historical reasons (see that pair's own comment above).
const BONUS_REASON_LUCKY = 'lucky';

/**
 * True for a value that is BOTH shaped like the pinned flash-instant form,
 * `YYYY-MM-DDTHH:MM:SS.sssZ` (issue #761 Design — the serialization form is
 * part of the contract), AND names a real calendar instant (#761). A
 * shape-only check would accept an impossible-but-pinned-shape instant like
 * `2026-02-31T00:00:00.000Z` — #763, the exported owner's sole consumer,
 * would then store that value and flashState() below would read it as
 * 'none' forever (parseFlashInstant() rejects it), silently never firing
 * with no error anywhere. Delegating to parseFlashInstant() (below —
 * hoisted, so declaration order here doesn't matter) means this exported
 * validator and flashState()'s own read-side check can never drift apart on
 * what counts as "valid": both are the same one function.
 *
 * Exported (issue #761 plan step 2) so #763, the only writer of
 * flash_start_at, consults THIS whole check rather than hand-deriving its
 * own — its own Touches cannot reach this file, so without an exported owner
 * a drift to any other valid ISO-8601 form, or a real-date check #763 forgot
 * to add, would make flashState() read 'none' forever.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidFlashInstant(value) {
  return typeof value === 'string' && parseFlashInstant(value) !== null;
}

/**
 * Parse a pinned-shape flash instant into epoch milliseconds, returning null
 * unless it names a REAL calendar instant.
 *
 * `Date.parse` / `new Date(string)` do NOT reliably reject an impossible
 * date the way "just check for NaN" suggests: on this runtime,
 * `new Date('2026-02-31T00:00:00.000Z')` silently rolls over to
 * `2026-03-03T00:00:00.000Z` instead of producing NaN (verified directly —
 * V8 treats an out-of-range calendar component as ordinary arithmetic
 * overflow, not a parse failure). So this instead reconstructs the instant
 * from the parsed components with `Date.UTC()` and checks that every UTC
 * component round-trips back to what was parsed; any mismatch means a
 * rollover occurred and the date was never real.
 *
 * This is the ONE owner of both halves of "is this instant usable" — shape
 * (the leading regex match below) and reality (the round-trip check) — so
 * isValidFlashInstant() above and flashState() below both delegate to this
 * single function rather than each layering their own shape-then-reality
 * pair and risking the two disagreeing (#761).
 * Safe to call on any value, well-formed or not: an unmatched shape returns
 * null exactly like an impossible date does, so a caller never needs to
 * shape-check before calling this.
 *
 * @param {string} value - any value; shape is checked internally.
 * @returns {number|null} epoch milliseconds, or null if not a real instant
 *   in the pinned shape.
 */
function parseFlashInstant(value) {
  const match = FLASH_INSTANT_RE.exec(value);
  if (!match) {
    return null;
  }
  const [, yStr, moStr, dStr, hStr, miStr, sStr, msStr] = match;
  const year = Number(yStr);
  const monthIndex = Number(moStr) - 1;
  const day = Number(dStr);
  const hours = Number(hStr);
  const minutes = Number(miStr);
  const seconds = Number(sStr);
  const ms = Number(msStr);

  const utcMs = Date.UTC(year, monthIndex, day, hours, minutes, seconds, ms);
  const roundTrip = new Date(utcMs);
  const isReal =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === monthIndex &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hours &&
    roundTrip.getUTCMinutes() === minutes &&
    roundTrip.getUTCSeconds() === seconds &&
    roundTrip.getUTCMilliseconds() === ms;

  return isReal ? utcMs : null;
}

/**
 * The ONE owner of a flash task's window arithmetic (issue #762 plan step
 * 2): `{startMs, endMs, totalMs}` for any row that is a well-formed flash,
 * or `null` for any row flashState() below would call 'none' for.
 *
 * flashState() calls this rather than repeating the arithmetic a few lines
 * below it — one copy of the window rule in one function, not two copies in
 * one file. src/routes/guest.js consults it too, for the same reason: the
 * guest's countdown targets `endMs` and the drain fill divides by `totalMs`,
 * and hand-rolling either of those a second time in the route (against
 * `flash_start_at` directly) would let the clock and the fill disagree the
 * moment the window's shape changes — a grace period, different rounding —
 * because only one of the two copies would have moved.
 *
 * Malformed-row handling is identical to flashState()'s own list (see that
 * function's doc comment for the full enumeration): any of the three
 * columns missing, `flash_minutes` not a positive integer, `flash_bonus`
 * outside `[FLASH_MIN_BONUS, FLASH_MAX_BONUS]`, or `flash_start_at` failing
 * parseFlashInstant()'s combined shape-and-real-date check. `taskRow` itself
 * is NOT validated the way `nowMs` is validated elsewhere in this file —
 * this function takes no clock, so there is no caller-supplied parameter to
 * distrust here; the row is the only input, and every shape it can take is
 * already enumerated above.
 *
 * @param {{flash_start_at?: string|null, flash_minutes?: number|null, flash_bonus?: number|null}} taskRow
 * @returns {{startMs: number, endMs: number, totalMs: number}|null}
 */
function flashWindow(taskRow) {
  if (!taskRow) {
    return null;
  }
  const startAt = taskRow.flash_start_at;
  const minutes = taskRow.flash_minutes;
  const bonus = taskRow.flash_bonus;

  if (startAt == null || minutes == null || bonus == null) {
    return null;
  }
  if (!Number.isInteger(minutes) || minutes < 1) {
    return null;
  }
  if (!Number.isInteger(bonus) || bonus < FLASH_MIN_BONUS || bonus > FLASH_MAX_BONUS) {
    return null;
  }
  const startMs = parseFlashInstant(startAt);
  if (startMs === null) {
    return null;
  }

  const totalMs = minutes * 60000;
  return { startMs: startMs, endMs: startMs + totalMs, totalMs: totalMs };
}

/**
 * The ONE owner of a flash task's window state (issue #761): whether
 * `taskRow`'s flash is scheduled, presently active, expired, or not armed at
 * all (or not well-formed), as of `nowMs`.
 *
 * The window is HALF-OPEN `[S, S+D)`, S = flash_start_at, D =
 * flash_minutes: 'scheduled' strictly before S, 'active' from S up to but
 * NOT including S + D, 'expired' from that end instant onward — a submit one
 * millisecond before the end banks, a submit at the end instant itself does
 * not (criterion 2).
 *
 * The window itself — S and S+D — comes from flashWindow() above (issue
 * #762 plan step 2) rather than being recomputed here: this function reads
 * `taskRow` only to hand it to flashWindow(), and does no arithmetic of its
 * own against `flash_start_at`/`flash_minutes` beyond that call. Returns
 * 'none' — never a throw, never 'expired' inferred from a comparison against
 * NaN — for any row flashWindow() answers null for (see that function's doc
 * comment for the full enumeration of malformed shapes this guards
 * against): step 1 leaves the flash trio with no CHECK/pairing constraint,
 * so a partially-populated row is a legal database state this function must
 * survive.
 *
 * `nowMs` IS validated (#761), unlike `taskRow`'s fields above: it is a
 * caller-supplied clock, not row data, so an invalid one is a caller bug,
 * not a legitimately malformed database row — this function throws rather
 * than silently answering 'expired' for a genuinely ACTIVE flash (the exact
 * double-booking whatSpecial()'s exclusivity guard exists to prevent) or
 * 'scheduled' for a `null` clock coerced to 0. This mirrors the discipline
 * isSealed()/isOnDay() already apply to their own clock parameter
 * (`todayIso`): "two owners of one rule must not disagree about invalid
 * input" applies just as much to a single owner's own single clock
 * parameter — silently answering *something* for a broken clock is worse
 * than refusing to answer at all.
 *
 * `nowMs` is otherwise a parameter, never a clock read inside this function,
 * following the `todayIso`-as-a-parameter discipline isSealed()'s doc
 * comment sets out — a caller passes `Date.now()` (or a pinned test instant)
 * so this stays a pure function of its inputs and a test never has to mock a
 * clock.
 *
 * No SQL-fragment counterpart ships beside this function (issue #761
 * Design): every consumer holds an already-loaded row, never a query that
 * must filter or suppress on window state the way sealedTaskWhere()'s
 * consumers do — this omission is deliberate, not a gap matching
 * liveTaskWhere/sealedTaskWhere's JS+SQL pairing convention.
 *
 * @param {{flash_start_at?: string|null, flash_minutes?: number|null, flash_bonus?: number|null}} taskRow
 * @param {number} nowMs - epoch milliseconds. Must be a finite number —
 *   throws otherwise.
 * @returns {'none'|'scheduled'|'active'|'expired'}
 */
function flashState(taskRow, nowMs) {
  if (!Number.isFinite(nowMs)) {
    throw new Error(`flashState: nowMs must be epoch milliseconds, got ${JSON.stringify(nowMs)}`);
  }
  const flashWindowVal = flashWindow(taskRow);
  if (flashWindowVal === null) {
    return FLASH_NONE;
  }
  if (nowMs < flashWindowVal.startMs) {
    return FLASH_SCHEDULED;
  }
  if (nowMs < flashWindowVal.endMs) {
    return FLASH_ACTIVE;
  }
  return FLASH_EXPIRED;
}

/**
 * The ONE ordered list a task's special state is derived from (#761).
 * "Who is this task spoken for by" (whatSpecial, the exclusivity guard) and
 * "who is paying right now" (submissions.js's banking decision) both walk
 * this ONE list (via findSpecialRule below) so they can never independently
 * drift apart; #650 adds 'lucky' as one more entry here, not a hand-edit
 * kept in step by discipline alone.
 *
 * The two questions stay genuinely different, though, and both must remain
 * answerable per-rule:
 *   - `spokenFor` — does this rule presently OWN the task for exclusivity
 *     purposes? (daily: sealed OR on-day; flash: scheduled OR active). A
 *     rule that is merely spokenFor still blocks every OTHER rule from
 *     claiming the task, even while it is not yet paying anything.
 *   - `paying` — is this rule ACTUALLY banking a bonus on this exact
 *     instant? (daily: on-day only, not merely sealed; flash: active only,
 *     not merely scheduled). Always a subset of `spokenFor` for the same
 *     rule.
 *
 * Order is precedence: 'daily' is listed first, so a task the list marks as
 * spoken-for by 'daily' can only ever be paid by 'daily' — 'flash''s
 * `paying` is never even consulted once 'daily' owns the row, whether or
 * not 'daily' itself is presently paying. That is what makes the divergent
 * case above impossible now: a task sealed for tomorrow is spoken-for by
 * 'daily', so findSpecialRule stops there; 'daily'.paying (isOnDay) is
 * false because the date is in the future, so bonusForTask answers null —
 * no bonus of ANY kind banks, matching whatSpecial's 'daily' answer instead
 * of silently falling through to flash.
 *
 * Each entry ALSO carries `bonusColumn` and `reason` (#761): the task-row
 * column this rule pays from and the bonus_reason literal it writes. This
 * keeps "who is spoken for / who is paying" and "what does paying actually
 * bank" wired from the SAME entry, so a rule can never drift out of step
 * with its own banking logic in submissions.js. bonusForTask() below reads
 * `bonusColumn`/`reason` off whichever rule is presently paying — adding a
 * new rule to this list is the single edit that wires both its exclusivity
 * and its banking; #650's 'lucky' entry is a live example of this staying
 * one entry, not one entry plus a second hand-edit elsewhere.
 */
const SPECIAL_RULES = [
  {
    kind: SPECIAL_DAILY,
    // special_bonus pairs with special_date under the chk_special_pairing
    // CHECK for every row created after that constraint landed (issue
    // #753), but cannot retroactively fix a row written before it existed,
    // or one edited by hand straight in the DB file — coalesceNullAmount
    // tells bonusForTask() below to read a NULL special_bonus on such a
    // legacy row as 0 rather than binding NULL into submissions.bonus_amount
    // (a NOT NULL column) and throwing.
    bonusColumn: 'special_bonus',
    reason: BONUS_REASON_ONEDAY,
    coalesceNullAmount: true,
    spokenFor: (row, clock) => isSealed(row, clock.todayIso) || isOnDay(row, clock.todayIso),
    paying: (row, clock) => isOnDay(row, clock.todayIso),
    // The window has CLOSED and can never pay again: this challenge's day is
    // strictly in the past. Delegates to isPastDay (#662): before isPastDay
    // existed, this predicate carried its own inline isRealDateString-guarded
    // `<` comparison — the isRealDateString guard matters because
    // special_date is a free-form column that can hold anything, including a
    // regex-shaped-but-impossible date like '2026-13-45', which
    // isSealed/isOnDay's own plain string compare would not reject either —
    // and it was the ONLY place that exact comparison lived, until a second
    // caller (src/services/host-checklist.js's rank-and-award row) needed the
    // identical fact and re-derived it a second time instead of reusing it.
    // isPastDay validates its own `todayIso` argument on every call, the same
    // convention isSealed/isOnDay already follow above, so this callsite
    // needs no defensive re-check of its own.
    missed: (row, clock) => isPastDay(row, clock.todayIso),
  },
  {
    kind: SPECIAL_FLASH,
    // flash_bonus carries no CHECK/pairing constraint at all (see
    // ensureTaskFlashColumns's comment, src/db.js) — but flashState()
    // already refuses to answer 'active' unless flash_bonus is an integer in
    // [1, 3], and `paying` below only fires when flashState() says 'active',
    // so this column can never be null or undefined by the time
    // bonusForTask() reads it. No coalesceNullAmount needed here (#761).
    bonusColumn: 'flash_bonus',
    reason: BONUS_REASON_FLASH,
    spokenFor: (row, clock) => {
      const state = flashState(row, clock.nowMs);
      return state === FLASH_SCHEDULED || state === FLASH_ACTIVE;
    },
    paying: (row, clock) => flashState(row, clock.nowMs) === FLASH_ACTIVE,
    // The window has CLOSED and can never pay again. FLASH_EXPIRED implies
    // flashWindow() answered non-null, which in turn implies flash_bonus is an
    // integer in [FLASH_MIN_BONUS, FLASH_MAX_BONUS] — so missedBonusForTask
    // can read the column below without a further range guard.
    missed: (row, clock) => flashState(row, clock.nowMs) === FLASH_EXPIRED,
  },
  {
    kind: SPECIAL_LUCKY,
    // lucky_bonus carries no CHECK/pairing constraint at all (see
    // tasks.lucky_date's own column comment, src/db.js) -- the bonus-range
    // check inside `paying` below is the read-side half of the pairing
    // enforcement the schema no longer provides, exactly mirroring flash's
    // own comment one entry up: a row with lucky_date set and lucky_bonus
    // NULL (or out of range) must not pay.
    bonusColumn: 'lucky_bonus',
    reason: BONUS_REASON_LUCKY,
    // The one special that does NOT bank on a replace (issue #650's canon
    // rule 11 amendment): a guest whose OWN prior submission on this task
    // survives (as a soft takedown, photos.hideSubmission) and re-uploads on
    // the lucky day must not win the bonus -- only a guest's FIRST-ever
    // completion of the task can. Daily and flash omit this key entirely
    // (their return grows an undefined third key bonusForTask's `toEqual`
    // callers ignore, issue #650 plan step 2) -- banksOnReplace: false is
    // the one explicit override, read by submissions.js's replace branch,
    // never defaulted to true anywhere in THIS file.
    banksOnReplace: false,
    // Appended LAST (issue #650 plan step 2): daily and flash each wear a
    // guest-visible marker advertising what will bank ("Today Only" / the
    // flash countdown pill); lucky wears none. Landing lucky ahead of either
    // would let a task display one of those markers while the submission
    // actually banked the lucky amount instead -- defensive ordering for a
    // legacy/raced row matching two rules, unreachable through the UI once
    // the setter guard (src/routes/admin.js) refuses the pair, but the safe
    // slot regardless.
    // Deliberately NO `missed` predicate (unlike daily and flash above): lucky
    // wears no guest-visible marker while it is live, so it must not grow one
    // after the fact either — a "you missed +N" mark on a passed lucky day
    // would retroactively reveal which task was the lucky one, which is exactly
    // the secrecy #650's AC2 exists to protect. missedBonusForTask() treats a
    // rule with no `missed` as never-missed.
    spokenFor: (row, clock) => !!(row && row.lucky_date && row.lucky_date >= clock.todayIso),
    paying: (row, clock) =>
      !!(
        row &&
        row.lucky_date === clock.todayIso &&
        Number.isInteger(row.lucky_bonus) &&
        row.lucky_bonus >= LUCKY_MIN_BONUS &&
        row.lucky_bonus <= LUCKY_MAX_BONUS
      ),
  },
];

/**
 * Validate a clock's `nowMs` up front, before any SPECIAL_RULES walk. Extracted
 * so findSpecialRule() and missedBonusForTask() — the two functions that walk
 * that list — cannot drift apart on what a valid clock is. Deliberately checks
 * `nowMs` ONLY: `todayIso` is validated by isSealed()/isOnDay() at the point of
 * use, and hoisting that check here would start throwing for flash-only callers
 * that legitimately pass no todayIso.
 *
 * @param {{nowMs: number}} clock
 * @param {string} caller - name used in the thrown message.
 */
function assertClock(clock, caller) {
  if (!clock || !Number.isFinite(clock.nowMs)) {
    throw new Error(
      `${caller}: clock.nowMs must be epoch milliseconds, got ${JSON.stringify(clock && clock.nowMs)}`
    );
  }
}

/**
 * The first rule in SPECIAL_RULES that currently owns `taskRow`, or null if
 * none does. Internal — whatSpecial and bonusForTask below both derive
 * their answer from this single ordered walk, which is what makes it
 * impossible for either question to disagree about which rule owns a given
 * row.
 *
 * `clock.nowMs` is validated here, up front, before the walk (#761) — not
 * left to flashState() to catch lazily partway through. Left unvalidated,
 * an invalid `nowMs` would only surface as a throw when the walk actually
 * reached 'flash''s `spokenFor` (the only rule that reads `clock.nowMs`;
 * 'daily''s `spokenFor` reads only `clock.todayIso`), so the SAME caller
 * mistake — a clock object built with `todayIso` but no `nowMs` — would
 * silently pass for a sealed or on-day row (findSpecialRule stops at
 * 'daily' and never reaches 'flash') while throwing for an ordinary or
 * flash-armed row. Two callers of one function must not get a different
 * outcome for an identical bug decided only by which row they happened to
 * pass; validating once here, before either rule runs, closes that gap for
 * whatSpecial and bonusForTask alike.
 *
 * @param {object} taskRow
 * @param {{todayIso: string, nowMs: number}} clock
 * @returns {{kind: string, bonusColumn: string, reason: string, spokenFor: Function, paying: Function}|null}
 */
function findSpecialRule(taskRow, clock) {
  assertClock(clock, 'findSpecialRule');
  return SPECIAL_RULES.find((rule) => rule.spokenFor(taskRow, clock)) || null;
}

/**
 * The ONE owner of task exclusivity (issue #649's amendment, 2026-07-19):
 * what `taskRow` is presently spoken for as — so a guard call site and
 * submissions.js's banking decision (bonusForTask below) can never disagree
 * about which rule owns a given task, because both are derived from the
 * same SPECIAL_RULES list via the same ordered walk (findSpecialRule). An
 * expired flash and a past-dated challenge are both free again and answer
 * null, same as an ordinary task.
 *
 * This function ships with NO production caller, deliberately (issue #761
 * plan step 2): every consumer (#763's two setters, #650's 'lucky'
 * extension) is outside this issue's Touches. #649's ownership amendment
 * says whichever of the three special types lands second owns this guard;
 * landing it here means the rule exists, exported and tested, before either
 * writer exists to invent it a different way.
 *
 * @param {object} taskRow
 * @param {{todayIso: string, nowMs: number}} clock - todayIso: YYYY-MM-DD,
 *   the event-local "today" (see isSealed/isOnDay); nowMs: epoch
 *   milliseconds (see flashState).
 * @returns {'daily'|'flash'|'lucky'|null}
 */
function whatSpecial(taskRow, clock) {
  const rule = findSpecialRule(taskRow, clock);
  return rule ? rule.kind : null;
}

/**
 * The ONE owner of "how much does `rule` bank on `taskRow`, and what reason
 * goes beside it" (#926) — the {reason, amount}
 * shaping bonusForTask() and missedBonusForTask() both need once they have
 * already decided WHICH rule applies (this helper does not decide that; it
 * takes the already-matched `rule` as a parameter). `reason` is null whenever
 * `amount` coalesces to 0: a legacy 'daily' row (special_date set,
 * special_bonus still NULL — see coalesceNullAmount above) coalesces to
 * amount 0, and a reason sitting next to that 0 would tell a later reader
 * (bonus_reason has no reader anywhere in the tree yet, but is read by
 * literal, not derived) that a rule paid out when nothing was banked.
 *
 * bonusForTask() and missedBonusForTask() below both call this helper
 * instead of each carrying its own copy of this shaping.
 *
 * @param {{bonusColumn: string, reason: string, coalesceNullAmount?: boolean}} rule
 * @param {object} taskRow
 * @returns {{reason: string|null, amount: number}}
 */
function bonusAmountFor(rule, taskRow) {
  const raw = taskRow[rule.bonusColumn];
  const amount = rule.coalesceNullAmount ? (raw ?? 0) : raw;
  return { reason: amount > 0 ? rule.reason : null, amount };
}

/**
 * The banking descriptor for whichever rule is presently paying on
 * `taskRow` (#761) — the single place that maps a paying
 * rule to the column it pays from and the bonus_reason literal it writes,
 * derived from the same findSpecialRule walk whatSpecial uses. Before this
 * function existed, submissions.js hand-wrote `if (paying === 'daily') ...
 * else if (paying === 'flash') ...` to do this same mapping a second time,
 * in a second file — a rule added to SPECIAL_RULES alone (as #650's 'lucky'
 * will be) would make the paying rule resolve to the new kind while both
 * arms of that switch missed it, banking nothing for a task whatSpecial
 * reported as spoken-for. Now the payout lives on the same rule object the
 * exclusivity guard walks, so a new rule needs exactly one new
 * SPECIAL_RULES entry to be fully wired for exclusivity, paying, AND
 * banking.
 *
 * This is the ONE owner of "is anything paying, and if so what" — a caller
 * that needs only a yes/no answer (is `findSpecialRule`'s rule presently in
 * its paying state) checks `bonusForTask(...) !== null` rather than a
 * separate function, so "who is spoken for" (whatSpecial) and "who is
 * paying, and what does it bank" (this function) stay exactly two
 * questions, not three.
 *
 * Returns null when nothing is presently paying: an ordinary submission,
 * one that is off-day and out-of-window, or one that is sealed/scheduled
 * but not yet in its own paying instant.
 *
 * The {reason, amount} shaping is bonusAmountFor()'s job (#926 — see that
 * helper's doc comment above), not this function's own or any caller's:
 * src/services/submissions.js's insert and replace branches and
 * missedBonusForTask() below both consume bonusAmountFor() rather than
 * each re-applying their own `amount > 0 ? rule.reason : null` guard
 * around this return value — one rule, one owner, so a future consumer
 * can never independently drift into writing the reason-beside-zero state
 * bonusAmountFor() forbids.
 *
 * `banksOnReplace` is passed through UNCHANGED from the matched rule (issue
 * #650 plan step 2) -- never defaulted here. Daily and flash omit the key
 * entirely, so their returned object grows an `undefined` third key, which
 * `toEqual` ignores in every existing caller's assertions; only lucky sets it
 * to the literal `false`. The "anything other than `false` banks" default is
 * applied by the CONSUMER (src/services/submissions.js's replace branch), not
 * baked into this return shape -- defaulting it here to `true` would add a
 * DEFINED key to daily/flash's returns and turn several existing assertions
 * red (see tests/flash-engine.test.js's `toEqual` checks on this function).
 *
 * @param {object} taskRow
 * @param {{todayIso: string, nowMs: number}} clock - see whatSpecial above.
 * @returns {{reason: string|null, amount: number, banksOnReplace?: boolean}|null}
 */
function bonusForTask(taskRow, clock) {
  const rule = findSpecialRule(taskRow, clock);
  if (!rule || !rule.paying(taskRow, clock)) {
    return null;
  }
  return { ...bonusAmountFor(rule, taskRow), banksOnReplace: rule.banksOnReplace };
}

/**
 * The bonus a guest can no longer earn on `taskRow`: the descriptor for a rule
 * whose window has CLOSED, or null if none has. The read-side counterpart to
 * bonusForTask() above, and the ONE owner of "did a bonus slip away here, and
 * how much was it" — the guest surface renders a struck-through figure from
 * this rather than each caller re-deriving "expired" per special type.
 *
 * Deliberately NOT routed through findSpecialRule: that walk stops at the first
 * rule which is spoken for, and a rule whose window has closed is by definition
 * no longer spoken for (an expired flash's `spokenFor` is false; a past-dated
 * challenge is neither sealed nor on-day), so findSpecialRule returns null for
 * exactly the rows this function exists to answer for. It walks SPECIAL_RULES
 * in the same declared order instead, which keeps the precedence identical to
 * the live path's: a row matching both a passed challenge day and an expired
 * flash reports the DAILY miss, the same way 'daily' wins the live tie.
 *
 * A rule with no `missed` predicate is never missed — see the lucky entry's own
 * comment for why it declines one.
 *
 * Amount handling is IDENTICAL to bonusForTask's, not merely similar —
 * both call the shared bonusAmountFor() helper (#926; see bonusForTask's
 * own doc comment above for the defect class this collapses) rather than
 * each carrying its own copy of the raw-column-read / coalesceNullAmount /
 * reason-beside-zero shaping. `reason` is null beside a zero amount so a
 * caller can never render "you missed +0". A caller wanting a yes/no
 * answer checks `missedBonusForTask(...) !== null` — but should gate its
 * MARKER on `amount > 0`, since a legacy row with a date and no bonus
 * never had anything to miss.
 *
 * `clock.todayIso` is validated here too (issue #926 plan step 1), unlike
 * bonusForTask/whatSpecial above: a missing or malformed `todayIso` here
 * would let every passed daily challenge quietly lose its marker with no
 * error anywhere —
 * the caller would never learn its clock was built wrong. The sibling live
 * walk already refuses to guess here: isSealed()/isOnDay() both throw on an
 * invalid `todayIso` rather than silently reporting "not sealed" — two
 * owners of adjacent rules must not disagree about invalid input. Checked
 * only in THIS function, not hoisted into assertClock(): assertClock is also
 * findSpecialRule's guard, and findSpecialRule's flash-only callers
 * legitimately pass no `todayIso` at all (flash's own spokenFor/paying never
 * read it) — forcing it there would start throwing for a caller that was
 * never wrong.
 *
 * @param {object} taskRow
 * @param {{todayIso: string, nowMs: number}} clock - see whatSpecial above.
 * @returns {{reason: string|null, amount: number}|null}
 */
function missedBonusForTask(taskRow, clock) {
  assertClock(clock, 'missedBonusForTask');
  if (!isValidDateString(clock && clock.todayIso)) {
    throw new Error(
      `missedBonusForTask: clock.todayIso must be YYYY-MM-DD, got ${JSON.stringify(clock && clock.todayIso)}`
    );
  }
  for (const rule of SPECIAL_RULES) {
    if (typeof rule.missed !== 'function' || !rule.missed(taskRow, clock)) {
      continue;
    }
    return bonusAmountFor(rule, taskRow);
  }
  return null;
}

/**
 * Whether an already-loaded task row is live for guests. Mirrors
 * liveTaskWhere's predicate for the two call sites (task-detail 404, submit
 * gate) that hold a row rather than a query.
 *
 * @param {{special_mode: string}} taskRow
 * @returns {boolean}
 */
function isTaskLive(taskRow) {
  return taskRow.special_mode !== MODE_HIDDEN;
}

/**
 * True only for a value that is one of MODES exactly. The single validity
 * test normalizeMode below (and any future direct caller) consults, so
 * "what counts as a real mode" can never be re-derived a second way.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidMode(value) {
  return typeof value === 'string' && MODES.includes(value);
}

/**
 * The WRITE-side owner of "what special_mode value does a posted field
 * become" (#682): a valid MODES member passes through
 * unchanged; anything else (missing, empty, unrecognized, a future mode this
 * build doesn't know yet) falls back to `fallback`. src/routes/admin.js's
 * create and edit handlers BOTH route their posted `special_mode` through
 * this instead of each hand-coding their own "unknown -> ?" rule — before this
 * fix, create silently mapped unknown to MODE_NONE while edit silently kept
 * the task's CURRENT mode, an inconsistency a caller had to know about rather
 * than one shared rule enforcing it. Each caller supplies its own fallback
 * (create: tasks.MODE_NONE; edit: the task's current special_mode), so this
 * function stays fallback-agnostic rather than assuming either policy.
 *
 * DELIBERATELY forgiving, unlike the sibling badge_icon field in the same
 * POST /admin/tasks/:id/edit handler: an unrecognized badge_icon refuses the
 * WHOLE edit, while an unrecognized special_mode is silently coerced to
 * `fallback` instead. That is not an oversight — the two fields come from
 * different sources of truth. special_mode is a closed, host-picked RADIO
 * (the create wizard's step 2 / the edit popup's Special group): the only
 * way its value is ever anything but a MODES member is a stale client (an
 * older tab open across a deploy that adds a mode, or a hand-crafted
 * request), and coercing to a safe default degrades gracefully with no
 * confusing error for an ordinary host. badge_icon, by contrast, is chosen
 * from a live, still-open catalog (src/services/badge-icons.js) at the exact
 * moment of submit — an invalid pick there is far more likely to indicate a
 * real bug (a stale catalog id, a broken picker) worth refusing loudly
 * rather than silently papering over.
 *
 * @param {unknown} value - the posted special_mode field.
 * @param {string} fallback - what to return when value is not a valid mode.
 * @returns {string}
 */
function normalizeMode(value, fallback) {
  return isValidMode(value) ? value : fallback;
}

/**
 * The WRITE-side owner of "what worth value does a posted field become"
 * (#682), mirroring normalizeMode's shape: parses `raw` as
 * an integer and returns it only when it falls within [MIN_WORTH,
 * MAX_WORTH]; anything else (missing, non-numeric, out of range) falls back
 * to `fallback`. src/routes/admin.js's create (fallback DEFAULT_WORTH) and
 * edit (fallback the task's CURRENT worth) both call this instead of each
 * re-implementing the same parseInt-and-clamp check.
 *
 * @param {unknown} raw - the posted worth field.
 * @param {number} fallback - what to return when raw doesn't parse to a
 *   valid 3-5 worth.
 * @returns {number}
 */
function normalizeWorth(raw, fallback) {
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= MIN_WORTH && parsed <= MAX_WORTH ? parsed : fallback;
}

module.exports = {
  MODE_NONE,
  MODE_HIDDEN,
  MODE_ONEDAY,
  MODES,
  MIN_WORTH,
  MAX_WORTH,
  DEFAULT_WORTH,
  liveTaskWhere,
  isTaskLive,
  isSealed,
  isOnDay,
  isPastDay,
  isValidDateString,
  isRealDateString,
  sealedTaskWhere,
  isChallenge,
  challengeTaskWhere,
  isValidMode,
  normalizeMode,
  normalizeWorth,
  FLASH_MIN_BONUS,
  FLASH_MAX_BONUS,
  FLASH_NONE,
  FLASH_SCHEDULED,
  FLASH_ACTIVE,
  FLASH_EXPIRED,
  LUCKY_MIN_BONUS,
  LUCKY_MAX_BONUS,
  SPECIAL_DAILY,
  SPECIAL_FLASH,
  SPECIAL_LUCKY,
  BONUS_REASON_ONEDAY,
  BONUS_REASON_FLASH,
  BONUS_REASON_LUCKY,
  isValidFlashInstant,
  flashWindow,
  flashState,
  missedBonusForTask,
  whatSpecial,
  bonusForTask,
};
