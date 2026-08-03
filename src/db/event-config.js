// src/db/event-config.js
// Event timezone + wedding dates (issue #681) and the hosts' prizes blurb
// (issue #469), stored in the generic `settings` key/value table
// ensureSettingsTable (migrations-ops.js) creates.
// Every function takes the open `db` handle as its first parameter — see
// src/db/connection.js's own comment on why an internal never captures it at
// module load.
'use strict';

function readSetting(db, key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function writeSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/**
 * Reader/writer pair owning the settings-table keys that hold the event's
 * timezone and wedding date range, so every date-aware consumer (day chips,
 * daily challenges, the dashboard checklist) reads the same facts from one
 * place instead of each hard-coding its own copy. Same settings table +
 * INSERT...ON CONFLICT shape as src/services/lockout.js's readInt/writeInt,
 * just for strings instead of parsed integers -- no separate migration
 * needed, ensureSettingsTable() (migrations-ops.js) already guarantees the
 * table exists.
 */
const KEY_EVENT_TIMEZONE = 'event_timezone';
const KEY_EVENT_START_DATE = 'event_start_date';
const KEY_EVENT_END_DATE = 'event_end_date';

// Issue #1042: the ceremony photo-notice toggle + date, same settings table,
// same constant-name-mirrors-its-value convention as the pair above.
// Stored as '1'/'0' (writeSetting only ever writes strings — see
// setEventConfig's own comment for why the boolean/string conversion is
// stated explicitly at both boundaries).
const KEY_CEREMONY_NOTICE_ENABLED = 'ceremony_notice_enabled';
const KEY_CEREMONY_NOTICE_DATE = 'ceremony_notice_date';

/**
 * The event's configured timezone, wedding date range, and ceremony
 * photo-notice setting. Defaults (America/Boise, 2026-08-07..2026-08-09,
 * notice off, ceremony date 2026-08-07) are the venue's real values, so a
 * fresh DB -- or an existing DB from before this issue, which has never
 * written these keys -- reads sensible values with no backfill migration.
 * `ceremonyNotice` is read back as a real boolean here ('1' -> true,
 * anything else -> false) even though it is stored as a string -- see
 * setEventConfig's own comment for the matching write-side conversion.
 * @returns {{ timezone: string, startDate: string, endDate: string, ceremonyNotice: boolean, ceremonyDate: string }}
 */
function getEventConfig(db) {
  return {
    timezone: readSetting(db, KEY_EVENT_TIMEZONE, 'America/Boise'),
    startDate: readSetting(db, KEY_EVENT_START_DATE, '2026-08-07'),
    endDate: readSetting(db, KEY_EVENT_END_DATE, '2026-08-09'),
    ceremonyNotice: readSetting(db, KEY_CEREMONY_NOTICE_ENABLED, '0') === '1',
    ceremonyDate: readSetting(db, KEY_CEREMONY_NOTICE_DATE, '2026-08-07'),
  };
}

/**
 * Persist the event's timezone, wedding date range, and (issue #1042,
 * optionally) the ceremony photo-notice setting. This function trusts its
 * caller -- POST /admin/config (src/routes/admin/config.js) is the single
 * validator (known IANA name, start <= end, and — for the two new fields —
 * a real date inside the submitted start/end range) and only calls this
 * once every field has already passed.
 *
 * `ceremonyNotice`/`ceremonyDate` are OPTIONAL: this function is called
 * today with a bare `{ timezone, startDate, endDate }` object from five
 * existing test call sites (tests/memory-day-bonus.test.js,
 * tests/oneday-guest-surface.test.js) that destructure exactly those three
 * fields off getEventConfig()'s own return shape (the round trip at
 * tests/oneday-guest-surface.test.js:328, `setEventConfig(getEventConfig())`).
 * Each new key is written ONLY when its field is `!== undefined`, leaving
 * the stored value untouched otherwise -- better-sqlite3 refuses to bind a
 * JS `undefined` (or a raw boolean), so a caller that never mentions these
 * two fields must not attempt to write them at all.
 * @param {{ timezone: string, startDate: string, endDate: string, ceremonyNotice?: boolean, ceremonyDate?: string }} cfg
 */
function setEventConfig(db, { timezone, startDate, endDate, ceremonyNotice, ceremonyDate }) {
  writeSetting(db, KEY_EVENT_TIMEZONE, timezone);
  writeSetting(db, KEY_EVENT_START_DATE, startDate);
  writeSetting(db, KEY_EVENT_END_DATE, endDate);
  if (ceremonyNotice !== undefined) {
    writeSetting(db, KEY_CEREMONY_NOTICE_ENABLED, ceremonyNotice ? '1' : '0');
  }
  if (ceremonyDate !== undefined) {
    writeSetting(db, KEY_CEREMONY_NOTICE_DATE, ceremonyDate);
  }
}

// A YYYY-MM-DD-shaped string, the same guard src/services/tasks.js's
// isOnDay applies to its own `todayIso` before comparing against a stored
// date column, mirrored here (review fix, M-a) rather than trusting a
// caller-supplied `todayIso` unchecked.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is the ceremony notice LIVE right now: enabled AND `todayIso` is the
 * configured ceremony date, the ONE place BOTH facts are combined (issue
 * #1042; review fix, M-a: previously only the date-equality half lived here,
 * and every caller re-ANDed `.enabled` on top of it itself). Two independent
 * consumers need it: src/middleware/session.js's attachGuest (to gate the
 * day-of band/onboarding-row local) and src/services/notifications.js's
 * qualifyingAnnounceFacts (to gate the recap row), neither of which can call
 * the other — attachGuest's res.locals are not reachable from the recap
 * service, which also runs from plain test calls with a synthetic clock. A
 * shared pure predicate here, instead of each site re-typing the AND, is
 * what keeps the two from silently drifting apart.
 * @param {{ ceremonyNotice: boolean, ceremonyDate: string }} eventConfig
 * @param {string} todayIso - YYYY-MM-DD, the event-local "today".
 * @returns {boolean}
 */
function isCeremonyNoticeLive(eventConfig, todayIso) {
  return (
    Boolean(eventConfig.ceremonyNotice) &&
    ISO_DATE_RE.test(todayIso) &&
    eventConfig.ceremonyDate === todayIso
  );
}

/**
 * Reader/writer pair owning the settings-table key that holds the hosts'
 * free-text prizes blurb (issue #469, Goal B's "visible stakes" outcome). A
 * DELIBERATELY separate pair from getEventConfig/setEventConfig above, not
 * folded into that cfg object: prizes has nothing to do with the date-consumer
 * contract (day chips, daily challenges, the dashboard checklist) those two
 * functions serve, so widening their return/param shape for an unrelated field
 * would leak a second concern into every existing caller. Same settings table
 * + INSERT...ON CONFLICT shape as the pair above; still no separate migration
 * needed, ensureSettingsTable() (migrations-ops.js) already guarantees the
 * table exists.
 */
const KEY_PRIZES = 'prizes';

// The one owner of the prizes length cap (issue #469 design-philosophy
// review): src/routes/admin/config.js's server-side clamp and
// src/views/admin-config.ejs's textarea maxlength both read this constant
// (the route via normalizePrizes below, the view via the prizesMaxLength
// render local the route passes through) instead of each hand-typing the
// literal 500 and drifting out of step.
const PRIZES_MAX_LENGTH = 500;

/**
 * The hosts' prizes text, verbatim as last saved. Empty string when never
 * set (a fresh DB, or one from before this issue) or when the admin saved a
 * blank value on purpose — both read the same way, and both mean "render
 * nothing" to every consumer (issue #469 AC3).
 * @returns {string}
 */
function getPrizes(db) {
  return readSetting(db, KEY_PRIZES, '');
}

/**
 * Persist the hosts' prizes text. This function trusts its caller — POST
 * /admin/config (src/routes/admin/config.js) normalizes the text up front
 * (see normalizePrizes below) and calls this only once the rest of that
 * form's fields have already passed validation.
 * @param {string} text
 */
function setPrizes(db, text) {
  writeSetting(db, KEY_PRIZES, text);
}

/**
 * Trim, cap at PRIZES_MAX_LENGTH, and repair a caller-supplied prizes string
 * for storage — the single owner of "what counts as valid prizes text",
 * mirroring normalizeCaption (src/services/submissions.js). No db handle is
 * needed; this is pure string normalization, called before setPrizes.
 * The length cut can land mid-emoji (between a UTF-16 surrogate pair's two
 * halves) — a dangling lead surrogate left at the end is dropped rather than
 * stored as a broken character.
 * @param {string} text
 * @returns {string}
 */
function normalizePrizes(text) {
  const cut = text.trim().slice(0, PRIZES_MAX_LENGTH);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

module.exports = {
  getEventConfig,
  setEventConfig,
  isCeremonyNoticeLive,
  getPrizes,
  setPrizes,
  normalizePrizes,
  PRIZES_MAX_LENGTH,
};
