// src/services/host-checklist.js
//
// The single owner of the admin dashboard's "Today" checklist (issue #646):
// row definitions, evaluation against real state, bucket ordering, the bug
// pin, and the tips gate. src/routes/admin.js consumes buildRows() and hands
// its output straight to src/views/admin-dashboard.ejs — neither the route
// nor the view re-derives any of this ordering or gating logic.
//
// Row shape: { id, kind, state, label, sub, href, urgent }
//   kind  — 'auto' | 'manual' | 'tip'
//   state — 'open' | 'manual' | 'done' | 'tip' (drives the view's
//           `check-<state>` class, unchanged from the phase-1 approved mock)
//   href  — optional; absent means a non-link row (a manual checkbox row, or
//           a tip)
//   urgent — optional boolean; only the bug-pin row sets it today
//
// Row order (owner-approved, 2026-07-21): bugs pinned (if any) -> open auto
// rows, config first -> manual rows -> tips (only when nothing else open or
// manual) -> done rows.
//
// Feature detection (AC7): several auto rows are backed by columns/tables
// that other, not-yet-merged issues own (lucky tasks #650, per-task photo
// ranking #661/#662). This module checks PRAGMA table_info before reading a
// column it does not itself own, and simply omits the row when the backing
// feature has not shipped — it never throws and never hard-depends on merge
// order. See DESIGN.md for the rationale.
//
// buildRows() also returns `stats` (guests / activeTasks / openBugs): this
// module already walks every one of those tables to build the checklist
// rows, so it is the single owner of those counts too — src/routes/admin.js
// consumes `stats` for the top stat grid rather than re-querying the same
// tables a second time. `openCount` (below) is a DIFFERENT thing from the
// per-row `state: 'open'` value — see buildRows()'s own doc comment for the
// distinction.

'use strict';

const { db, getEventConfig } = require('../db');
const tasks = require('./tasks');
const { eventLocalDateString, singleDayLabel } = require('./event-days');

// settings-table keys the Configuration page (issue #681) writes — read
// directly here (not through db.getEventConfig(), which returns DEFAULTS
// for an unset key) because this module needs to distinguish "never
// configured" from "configured to the same value as the default".
const KEY_EVENT_TIMEZONE = 'event_timezone';
const KEY_EVENT_START_DATE = 'event_start_date';
const KEY_EVENT_END_DATE = 'event_end_date';

// Manual checklist items (issue #646): the only rows with a tappable
// checkbox, because the app cannot see a physical room. Persisted in the
// `settings` table under key `checklist.<id>`, same table + upsert shape as
// src/services/lockout.js's readInt/writeInt. This array is the one place a
// manual item's id/label/sub live — the route's toggle handler validates a
// posted id against MANUAL_ITEM_IDS (derived below) rather than trusting it.
const MANUAL_ITEMS = [
  {
    id: 'placecards',
    label: 'Place-cards printed and on the tables',
    sub: 'The app cannot see the tables, so this one is on you',
  },
  {
    id: 'slideshow-live',
    label: 'Slideshow up on the venue screen',
    sub: 'Reception, once dinner starts',
  },
];

const MANUAL_ITEM_IDS = new Set(MANUAL_ITEMS.map((item) => item.id));

// Curated host tips: advice, not work. Never counted toward the nudge;
// rendered only once nothing open or manual remains (see buildRows below).
const TIPS = [
  {
    label: 'Mix trivial tasks with hard ones',
    sub: 'Easy wins keep the shy guests playing',
  },
  {
    label: 'Write tasks that push people to mingle',
    sub: 'A photo with someone you just met beats a selfie',
  },
];

const SETTING_KEY_PREFIX = 'checklist.';

/**
 * Whether `table` carries a column named `column`, without throwing on a
 * table that does not exist. The one presence check every feature-gated auto
 * row below runs before it reads a column owned by a different, possibly
 * unmerged issue (AC7).
 * @param {string} table
 * @param {string} column
 * @returns {boolean}
 */
function hasColumn(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((col) => col.name === column);
}

/**
 * A raw settings-table value, or null if the key has never been written.
 * Distinct from db.js's readSetting (not exported, and defaults rather than
 * signaling "unset") — this module needs the null case itself to tell
 * "never configured" apart from "configured to a value that equals the
 * default".
 * @param {string} key
 * @returns {string|null}
 */
function settingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function writeSettingRaw(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/**
 * Whether `id` is a real manual checklist item id (AC5's write-side guard —
 * the route refuses a toggle POST for anything else).
 * @param {string} id
 * @returns {boolean}
 */
function isValidManualId(id) {
  return MANUAL_ITEM_IDS.has(id);
}

/**
 * Current checked state of manual item `id`, read from `settings`.
 * @param {string} id
 * @returns {boolean}
 */
function isManualChecked(id) {
  return settingRaw(SETTING_KEY_PREFIX + id) === '1';
}

/**
 * Persist manual item `id`'s checked state. The route's toggle handler
 * always passes the OPPOSITE of the current isManualChecked() reading — this
 * function itself performs no read-then-decide, it just writes what it is
 * told (mirrors lockout.js's writeInt: dumb writer, smart caller).
 * @param {string} id
 * @param {boolean} checked
 */
function setManualChecked(id, checked) {
  writeSettingRaw(SETTING_KEY_PREFIX + id, checked ? '1' : '0');
}

/**
 * The next calendar day after `dateIso` (YYYY-MM-DD), computed in UTC so the
 * server's own local timezone can never shift the answer — the same
 * UTC-anchoring discipline event-days.js's eventDays() uses.
 * @param {string} dateIso
 * @returns {string}
 */
function nextDay(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Whether any task carries `dateIso` as its daily-challenge date. Reads
 * tasks.special_date directly (not tasks.isChallenge, which only tests an
 * already-loaded row) since this is a presence query across the whole table.
 * @param {string} dateIso
 * @returns {boolean}
 */
function hasChallengeOn(dateIso) {
  return !!db.prepare('SELECT 1 FROM tasks WHERE special_date = ?').get(dateIso);
}

/**
 * Format a flash_start_at instant (see src/services/tasks.js's
 * FLASH_INSTANT_RE doc comment for its exact stored shape) as a short,
 * host-readable "Aug 8, 7:30 pm" string in the event's configured timezone.
 * @param {string} isoInstant
 * @param {string} timezone
 * @returns {string}
 */
function formatFlashWhen(isoInstant, timezone) {
  const when = new Date(isoInstant);
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
  }).format(when);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
    .format(when)
    .toLowerCase()
    .replace(/\s/g, '');
  return `${datePart}, ${timePart}`;
}

/**
 * Build the flat, ordered checklist plus the counts both the stat grid and
 * its full-width nudge row read.
 *
 * @param {Date} [now] - injectable clock for deterministic tests; defaults
 *   to the real current instant.
 * @returns {{ rows: object[], openCount: number, urgentCount: number,
 *   stats: { guests: number, activeTasks: number, openBugs: number } }}
 *   `openCount` is the nudge total (pinned + open + manual ROWS) — a
 *   different thing from a single row's own `state: 'open'` value; do not
 *   confuse the two when reading this function.
 */
function buildRows(now = new Date()) {
  const openRows = [];
  const doneRows = [];
  let pinnedRow = null;

  // --- Bugs, pinned (AC3). Also the "Open bugs" stat-grid count (issue
  // #646 review fix) — this module already runs this exact query for the
  // checklist row, so src/routes/admin.js reads it from `stats` below
  // instead of re-querying bug_reports a second time. ---
  const openBugs = db.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE resolved = 0').get().n;
  if (openBugs > 0) {
    pinnedRow = {
      id: 'bugs',
      kind: 'auto',
      state: 'open',
      label: `Look at ${openBugs} new bug report${openBugs === 1 ? '' : 's'}`,
      sub: 'Reported by your guests',
      href: '/admin/bugs',
      urgent: true,
    };
  }

  // --- Configuration, first among the open auto rows (design table) ---
  const configSet =
    settingRaw(KEY_EVENT_TIMEZONE) != null &&
    settingRaw(KEY_EVENT_START_DATE) != null &&
    settingRaw(KEY_EVENT_END_DATE) != null;
  if (!configSet) {
    openRows.push({
      id: 'config',
      kind: 'auto',
      state: 'open',
      label: 'Set the event timezone and wedding dates',
      sub: 'Every countdown and daily bonus depends on it',
      href: '/admin/config',
    });
  }

  // Read once (issue #646 review fix): both the daily-challenge and flash
  // sections below need the configured timezone, and getEventConfig() is a
  // settings-table read — one lookup per buildRows() call, not one per
  // section. Harmless to compute even when config is unset (it degrades to
  // its own hard-coded defaults); only actually consulted once configSet is
  // true (daily challenge) or a flash row is being rendered.
  const timezone = getEventConfig().timezone;

  // --- Daily challenge roll-forward (AC4) — only once config is set, and
  // only if the daily-challenge columns exist (they do as of #753/#754, but
  // this module still checks rather than assuming). ---
  if (configSet && hasColumn('tasks', 'special_date')) {
    const todayIso = eventLocalDateString(timezone, now);

    if (!hasChallengeOn(todayIso)) {
      openRows.push({
        id: 'daily-today',
        kind: 'auto',
        state: 'open',
        label: "Set today's daily challenge",
        sub: `${singleDayLabel(todayIso)}, nothing set yet`,
        href: '/admin/tasks',
      });
    } else {
      doneRows.push({
        id: 'daily-today-done',
        kind: 'auto',
        state: 'done',
        label: "Today's daily challenge is set",
        sub: singleDayLabel(todayIso),
      });

      // Rolls forward: today's is covered, so surface tomorrow's — the host
      // is never left with nothing queued for the next morning.
      const tomorrowIso = nextDay(todayIso);
      if (!hasChallengeOn(tomorrowIso)) {
        openRows.push({
          id: 'daily-tomorrow',
          kind: 'auto',
          state: 'open',
          label: "Set tomorrow's daily challenge",
          sub: `${singleDayLabel(tomorrowIso)}, nothing set yet`,
          href: '/admin/tasks',
        });
      } else {
        doneRows.push({
          id: 'daily-tomorrow-done',
          kind: 'auto',
          state: 'done',
          label: "Tomorrow's daily challenge is set",
          sub: singleDayLabel(tomorrowIso),
        });
      }
    }
  }

  // --- Flash task scheduling (AC7 covers the ABSENT case; #761 has already
  // merged the columns this reads, so this row is live in this build). ---
  if (hasColumn('tasks', 'flash_start_at')) {
    const flashRow = db
      .prepare(
        `SELECT flash_start_at FROM tasks
          WHERE flash_start_at IS NOT NULL
          ORDER BY flash_start_at ASC LIMIT 1`
      )
      .get();
    if (!flashRow) {
      openRows.push({
        id: 'flash',
        kind: 'auto',
        state: 'open',
        label: 'Schedule your first flash task',
        sub: 'A surprise window worth bonus points. Try the reception.',
        href: '/admin/tasks',
      });
    } else {
      doneRows.push({
        id: 'flash-done',
        kind: 'auto',
        state: 'done',
        label: 'Flash task scheduled',
        sub: formatFlashWhen(flashRow.flash_start_at, timezone),
      });
    }
  }

  // --- Lucky task (#650) and rank-and-award (#661/#662) — neither has any
  // backing column or table in this schema yet, so both row types are
  // omitted entirely (AC7): there is nothing to feature-detect a column FOR.
  // Speculative structure for either belongs in its own issue, not stubbed
  // here ahead of time. ---

  // --- Resubmitted photo re-review (submissions.resubmitted, present since
  // issue #190) ---
  if (hasColumn('submissions', 'resubmitted')) {
    const resub = db
      .prepare(
        `SELECT g.name AS name
           FROM submissions s
           JOIN guests g ON g.id = s.guest_id
          WHERE s.resubmitted = 1
          ORDER BY s.created_at DESC LIMIT 1`
      )
      .get();
    if (resub) {
      openRows.push({
        id: 'resubmitted',
        kind: 'auto',
        state: 'open',
        label: 'Re-review a resubmitted photo',
        sub: `${resub.name || 'A guest'} replaced a photo you took down`,
        href: '/admin/photos',
      });
    }
  }

  // --- Informational done rows, always true once true (design table) ---
  const activeTaskCount = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${tasks.liveTaskWhere('')}`)
    .get().n;
  if (activeTaskCount > 0) {
    doneRows.push({
      id: 'tasks-live',
      kind: 'auto',
      state: 'done',
      label: 'Tasks are live',
      sub: `${activeTaskCount} task${activeTaskCount === 1 ? '' : 's'}, worth 1 to 3 points each`,
    });
  }
  const guestCount = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
  if (guestCount > 0) {
    doneRows.push({
      id: 'guests-invited',
      kind: 'auto',
      state: 'done',
      label: 'Guests invited',
      sub: `${guestCount} joined so far`,
    });
  }

  // --- Manual rows (AC5). `checked` rides on the row so the view can post
  // it back as the toggle form's hidden "as-rendered state" field (issue
  // #646 review fix — see POST /admin/checklist/:id/toggle's own comment for
  // why: the route computes its write from THIS value, not from a fresh DB
  // read, so two rapid double-taps of the same rendered button both target
  // the same next state instead of racing each other back and forth). ---
  const manualRows = [];
  MANUAL_ITEMS.forEach((item) => {
    const checked = isManualChecked(item.id);
    if (checked) {
      doneRows.push({
        id: item.id,
        kind: 'manual',
        state: 'done',
        label: item.label,
        sub: item.sub,
        checked: true,
      });
    } else {
      manualRows.push({
        id: item.id,
        kind: 'manual',
        state: 'manual',
        label: item.label,
        sub: item.sub,
        checked: false,
      });
    }
  });

  // --- Tips (AC6): only when nothing open or manual remains; never counted
  // toward the nudge. ---
  const hasOpenOrManual = openRows.length > 0 || manualRows.length > 0 || pinnedRow !== null;
  const tipRows = hasOpenOrManual
    ? []
    : TIPS.map((tip, idx) => ({
        id: 'tip-' + idx,
        kind: 'tip',
        state: 'tip',
        label: tip.label,
        sub: tip.sub,
      }));

  const rows = [];
  if (pinnedRow) rows.push(pinnedRow);
  rows.push(...openRows);
  rows.push(...manualRows);
  rows.push(...tipRows);
  rows.push(...doneRows);

  const openCount = (pinnedRow ? 1 : 0) + openRows.length + manualRows.length;
  const urgentCount = pinnedRow && pinnedRow.urgent ? 1 : 0;

  return {
    rows,
    openCount,
    urgentCount,
    stats: { guests: guestCount, activeTasks: activeTaskCount, openBugs },
  };
}

module.exports = {
  buildRows,
  isValidManualId,
  isManualChecked,
  setManualChecked,
  MANUAL_ITEMS,
};
