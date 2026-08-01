// src/db/event-config.js
// Event timezone + wedding dates (issue #681), stored in the generic
// `settings` key/value table ensureSettingsTable (migrations-ops.js) creates.
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

/**
 * The event's configured timezone and wedding date range. Defaults
 * (America/Boise, 2026-08-07..2026-08-09) are the venue's real values, so a
 * fresh DB -- or an existing DB from before this issue, which has never
 * written these keys -- reads sensible values with no backfill migration.
 * @returns {{ timezone: string, startDate: string, endDate: string }}
 */
function getEventConfig(db) {
  return {
    timezone: readSetting(db, KEY_EVENT_TIMEZONE, 'America/Boise'),
    startDate: readSetting(db, KEY_EVENT_START_DATE, '2026-08-07'),
    endDate: readSetting(db, KEY_EVENT_END_DATE, '2026-08-09'),
  };
}

/**
 * Persist the event's timezone and wedding date range. This function trusts
 * its caller -- POST /admin/config (src/routes/admin.js) is the single
 * validator (known IANA name, start <= end) and only calls this once every
 * field has already passed.
 * @param {{ timezone: string, startDate: string, endDate: string }} cfg
 */
function setEventConfig(db, { timezone, startDate, endDate }) {
  writeSetting(db, KEY_EVENT_TIMEZONE, timezone);
  writeSetting(db, KEY_EVENT_START_DATE, startDate);
  writeSetting(db, KEY_EVENT_END_DATE, endDate);
}

module.exports = { getEventConfig, setEventConfig };
