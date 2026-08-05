// src/db/migrations-tasks.js
// Guarded schema migrations for `tasks` only (issue #969 PR review fix,
// domain regroup): worth (3-5, default 3), special_mode, special_date/
// special_bonus + widened CHECK, the flash trio, the lucky pair, live_since,
// and the worth-range rescale. Each function takes the open `db` handle as
// its first parameter (never a module-load capture of its own — see
// src/db/connection.js's own comment on why) and is invoked, in this exact
// source order, from the entry's (src/db.js) load-bearing boot sequence.
'use strict';

// --- Guarded migration: tasks.worth / tasks.special_mode (issue #727) ---
/**
 * Rebuild `tasks` from the old is_active-only shape to the new shape carrying
 * `worth` (3-5, default 3 as of #1103 — this rebuild itself still writes the
 * historical 1 below, since ensureTaskWorthRange() further down rescales it)
 * and `special_mode` ('none'/'hidden', default 'none'), dropping `is_active`
 * entirely.
 *
 * is_active (0/1) cannot encode the one_day/lucky/flash states the
 * special_mode enum must extend to (#624/#649/#650), so it is dead vocabulary
 * once special_mode exists — keeping it around as an unread column would be a
 * second source of truth for "is this task live" (the same kind of drift
 * ensureBadgeTypeCheckWidened's widen-in-place limitation guards against) and
 * would silently mis-classify any fixture that still sets is_active = 0. SQLite
 * cannot drop a column or add a CHECK constraint in place, so on an old-shape
 * table we rebuild it — same recipe as ensureTaskIdNullable above: create a
 * new table with the new shape, copy every row across (preserving id so
 * submissions.task_id and badges.task_id — both REFERENCE tasks(id) — stay
 * valid), drop the old table, rename the new one into place, all inside one
 * transaction so a mid-migration crash cannot leave the database
 * half-migrated.
 *
 * Backfill: worth = 1 for every existing row (no worth-writer existed before
 * #727, so every task in production is worth 1 already); special_mode =
 * 'hidden' for a row whose is_active was 0, else 'none'.
 *
 * Detection: PRAGMA table_info(tasks) — special_mode already present means a
 * fresh DB (the CREATE TABLE above already declares the new shape) or an
 * already-migrated DB, either way a no-op. is_active present means the old
 * shape, so the rebuild runs.
 *
 * Runs right after the CREATE TABLE block above (not after the later guards
 * below): it depends only on tasks/submissions/badges existing, which the top
 * CREATE TABLE block already guarantees, and no later migration in this file
 * depends on it running first. Exported so tests bind to this real guard
 * rather than an inline copy.
 */
function ensureTaskWorthAndMode(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all();
  if (cols.some((col) => col.name === 'special_mode')) {
    // Fresh DB (CREATE TABLE above already has the new shape), or an
    // already-migrated DB — nothing to do.
    return;
  }
  if (!cols.some((col) => col.name === 'is_active')) {
    // No tasks table at all yet (should not happen — the CREATE TABLE block
    // above always runs first) — defensive no-op.
    return;
  }

  // submissions.task_id and badges.task_id both REFERENCE tasks(id) ON DELETE
  // CASCADE: dropping `tasks` mid-rebuild trips FK enforcement even though the
  // replacement table restores the same ids, so foreign_keys is turned off
  // for the duration of the rebuild only (SQLite's documented 12-step
  // ALTER-TABLE recipe), and turned back on immediately after.
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          title        TEXT    NOT NULL,
          description  TEXT    NOT NULL DEFAULT '',
          sort_order   INTEGER NOT NULL DEFAULT 0,
          worth        INTEGER NOT NULL DEFAULT 1 CHECK (worth BETWEEN 1 AND 3),
          special_mode TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden')),
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO tasks_new (id, sort_order, title, description, created_at, worth, special_mode)
          SELECT id, sort_order, title, description, created_at, 1,
                 CASE WHEN is_active = 0 THEN 'hidden' ELSE 'none' END
            FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// --- Guarded migration: tasks.special_date/special_bonus + widened CHECK (issue #753) ---
/**
 * Rebuild `tasks` to add `special_date`/`special_bonus` and widen the
 * `special_mode` CHECK to accept 'oneday' alongside 'none'/'hidden', if it
 * does not already.
 *
 * Detection CANNOT be column-presence the way ensureTaskWorthAndMode() above
 * detects its own old shape: that function returns early the instant
 * `special_mode` exists, which is true of EVERY database that has already
 * run #727 — so on the deployed app.db (post-#727, pre-#753) that guard
 * would never fire, the narrow CHECK IN ('none','hidden') would survive, and
 * a 'oneday' insert would throw SQLITE_CONSTRAINT_CHECK the first time a
 * host saved a one-day-only challenge, even though every fresh test database
 * (whose CREATE TABLE above already has the widened CHECK) would pass green.
 * Instead this detects the way ensureBadgeTypeCheckWidened() does: read the
 * stored CREATE TABLE text out of sqlite_master and rebuild unless it
 * already names 'oneday'. A fresh DB's CREATE TABLE IF NOT EXISTS above
 * already carries the widened CHECK and both new columns, so this is a
 * no-op there too, and a no-op on every later boot of an already-migrated
 * DB.
 *
 * SQLite cannot alter a CHECK constraint in place, so on an old-vocabulary
 * table we rebuild it — same recipe as ensureTaskWorthAndMode/
 * ensureBadgeTypeCheckWidened above: create a new table with the widened
 * shape, copy every existing column across by explicit column list
 * (preserving id so submissions.task_id and badges.task_id — both REFERENCE
 * tasks(id) — stay valid; special_date/special_bonus are simply absent from
 * that list, so every pre-existing row gets NULL in both, exactly right for
 * an ordinary task), drop the old table, rename the new one into place, all
 * inside one transaction so a mid-migration crash cannot leave the database
 * half-migrated.
 *
 * Same two rebuild hazards ensureTaskWorthAndMode above already solves,
 * copied verbatim: (a) submissions.task_id and badges.task_id both
 * REFERENCE tasks(id) ON DELETE CASCADE, and foreign_keys is ON, so a DROP
 * TABLE tasks mid-rebuild would cascade-delete every task submission and
 * every task badge (which cascades again into guest_badges) unless
 * foreign_keys is turned off for the duration of the rebuild and restored
 * immediately after. (b) This function runs right after
 * ensureTaskWorthAndMode() above — before any later migration in this file
 * — so it never races a rebuild that could drop a column it needs to carry
 * forward.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTaskSpecialDayColumns(db) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get();
  // Match the CHECK constraint's own text, not a bare "'oneday'" substring
  // (#753): the CREATE TABLE above also carries a doc
  // comment mentioning 'oneday' in prose, and sqlite_master.sql preserves
  // that comment verbatim alongside the constraint -- a bare substring match
  // would (harmlessly, today, since both always appear together) leave a
  // reader unable to tell which occurrence the guard actually depends on.
  if (!row || row.sql.includes("IN ('none','hidden','oneday')")) {
    // No tasks table yet, or already widened — nothing to do.
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          title          TEXT    NOT NULL,
          description    TEXT    NOT NULL DEFAULT '',
          sort_order     INTEGER NOT NULL DEFAULT 0,
          worth          INTEGER NOT NULL DEFAULT 1 CHECK (worth BETWEEN 1 AND 3),
          special_mode   TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden','oneday')),
          special_date   TEXT,
          special_bonus  INTEGER CHECK (special_bonus IS NULL OR special_bonus BETWEEN 1 AND 3),
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT chk_special_pairing CHECK ((special_date IS NULL) = (special_bonus IS NULL))
        );

        INSERT INTO tasks_new (id, title, description, sort_order, worth, special_mode, created_at)
          SELECT id, title, description, sort_order, worth, special_mode, created_at
            FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// --- Guarded migration: tasks.flash_start_at/flash_minutes/flash_bonus (issue #761) ---
/**
 * Add tasks.flash_start_at/flash_minutes/flash_bonus if any is not already
 * present.
 *
 * Same guard shape as ensurePhotoBonusColumn (src/db/migrations-submissions.js):
 * the tasks CREATE TABLE above already declares all three (a fresh DB gets
 * them directly), so this is a no-op there; on an existing pre-#761 app.db none
 * of the three exist yet, so PRAGMA table_info detects each absence and the
 * ALTER TABLE runs once per column, gated so a repeat call (or a later boot)
 * is a no-op and never throws "duplicate column". No DEFAULT is given for any
 * of the three (NULL for every pre-existing row is exactly right: "no flash
 * armed").
 *
 * MUST run immediately after ensureTaskSpecialDayColumns() above, and its
 * columns must NOT be added to that function's `tasks_new` rebuild list
 * (issue #761 plan step 1). ensureTaskSpecialDayColumns() only rebuilds
 * `tasks` on a pre-#753 database, which by definition has no flash columns
 * yet -- running this guard after it means the rebuild (if any) finishes
 * first and these ALTERs land on the settled table. `tasks` is rebuilt in
 * three places in this file: ensureTaskWorthAndMode and
 * ensureTaskSpecialDayColumns immediately above this comment, both earlier
 * than this call site, plus ensureTaskWorthRange (issue #1103), which runs
 * after every ALTER-based tasks guard in src/db.js's boot order, including
 * this one. The resulting rule: a future tasks column takes exactly one of
 * two homes, never both: either its guard is registered after the
 * ensureTaskWorthRange call in src/db.js (the usual choice), or the column
 * is added to ensureTaskWorthRange's tasks_new CREATE TABLE plus both sides
 * of its INSERT/SELECT list. Doing both would make the SELECT reference a
 * column a legacy database does not have yet and throw at boot.
 *
 * A fresh database and a migrated one end up with the three flash columns in
 * different physical positions: the CREATE TABLE above places them before
 * created_at, while this guard's ALTER TABLE always appends a new column
 * after every existing one, landing them after created_at (and after
 * whatever else a prior migration already appended) on a migrated app.db.
 * That divergence is safe and deliberately left uncorrected: every INSERT
 * into tasks in this codebase names its columns explicitly, and every read
 * of a task row goes through a property name (row.flash_start_at, etc.),
 * never a positional index, so column order carries no behavioral meaning
 * anywhere it is read.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTaskFlashColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('flash_start_at')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN flash_start_at TEXT`);
  }
  if (!names.has('flash_minutes')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN flash_minutes INTEGER`);
  }
  if (!names.has('flash_bonus')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN flash_bonus INTEGER`);
  }
}

// --- Guarded migration: tasks.lucky_date/lucky_bonus (issue #650) ---
/**
 * Add tasks.lucky_date/lucky_bonus if either is not already present.
 *
 * Same guard shape as ensureTaskFlashColumns() immediately above, modelled on
 * it exactly: the tasks CREATE TABLE above already declares both columns (a
 * fresh DB gets them directly), so this is a no-op there; on an existing
 * pre-#650 app.db neither exists yet, so PRAGMA table_info detects each
 * absence and the ALTER TABLE runs once per column, gated so a repeat call
 * (or a later boot) is a no-op and never throws "duplicate column". No
 * DEFAULT is given for either (NULL for every pre-existing row is exactly
 * right: "no lucky pick").
 *
 * Deliberately a plain ALTER TABLE ADD COLUMN pair, NOT a table rebuild, and
 * the special_mode CHECK is NOT widened to accept a 'lucky' member (issue
 * #650 plan step 1 -- see the tasks.lucky_date column's own comment above for
 * the full reasoning, copied from #761's identical flash decision). Rebuilding
 * `tasks` here would re-enter the FK-cascade hazard
 * ensureTaskSpecialDayColumns() documents at length, widen the #753 guard's
 * closed-list substring match, and turn red the three existing tests that
 * assert 'lucky' is not an accepted special_mode
 * (tests/oneday-challenge-migration.test.js, tests/task-worth-mode-migration
 * .test.js, tests/tasks-normalize.test.js) -- for no behavioural gain, since
 * lucky_date is the single authoritative "this task is lucky" fact and
 * nothing reads special_mode to learn it.
 *
 * MUST run immediately after ensureTaskFlashColumns() above (mirroring that
 * function's own call-order note relative to ensureTaskSpecialDayColumns()):
 * `tasks` is rebuilt in three places in this file, ensureTaskWorthAndMode and
 * ensureTaskSpecialDayColumns, both earlier than this call site, plus
 * ensureTaskWorthRange (issue #1103), which runs after every ALTER-based
 * tasks guard in src/db.js's boot order, including this one. The resulting
 * rule: a future tasks column takes exactly one of two homes, never both:
 * either its guard is registered after the ensureTaskWorthRange call in
 * src/db.js (the usual choice), or the column is added to
 * ensureTaskWorthRange's tasks_new CREATE TABLE plus both sides of its
 * INSERT/SELECT list. Doing both would make the SELECT reference a column a
 * legacy database does not have yet and throw at boot.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTaskLuckyColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('lucky_date')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN lucky_date TEXT`);
  }
  if (!names.has('lucky_bonus')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN lucky_bonus INTEGER`);
  }
}

// --- Guarded migration: tasks.live_since (issue #778) ---
/**
 * Add tasks.live_since if it is not already present.
 *
 * Same guard shape as ensureTaskFlashColumns()/ensureTaskLuckyColumns()
 * immediately above: the tasks CREATE TABLE above already declares it (a
 * fresh DB gets it directly, so this is a no-op there); on an existing
 * pre-#778 app.db it does not exist yet, so PRAGMA table_info detects its
 * absence and the ALTER TABLE runs once, gated so a repeat call (or a later
 * boot) is a no-op and never throws "duplicate column".
 *
 * No DEFAULT is given -- NULL for every pre-existing row is exactly right
 * (issue #778 plan step 1): a pre-existing live task keeps live_since NULL
 * rather than being backfilled to "now", so it never spuriously announces --
 * the read-time rule (src/services/notifications.js) is `live_since >
 * checkpoint`, and `NULL > x` is never true, in SQL or in JS.
 *
 * MUST run after ensureTaskSpecialDayColumns()/ensureTaskWorthAndMode(), two
 * of the three places `tasks` is rebuilt in this file (the third is
 * ensureTaskWorthRange, issue #1103, which runs after every ALTER-based
 * tasks guard in src/db.js's boot order, including this one), for the same
 * reason ensureTaskFlashColumns() documents above: a rebuild, if any,
 * finishes first, so this ALTER always lands on the settled table. The
 * resulting rule: a future tasks column takes exactly one of two homes,
 * never both: either its guard is registered after the ensureTaskWorthRange
 * call in src/db.js (the usual choice), or the column is added to
 * ensureTaskWorthRange's tasks_new CREATE TABLE plus both sides of its
 * INSERT/SELECT list. Doing both would make the SELECT reference a column a
 * legacy database does not have yet and throw at boot.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTaskLiveSinceColumn(db) {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all();
  if (!cols.some((col) => col.name === 'live_since')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN live_since TEXT`);
  }
}

// --- Guarded migration: tasks.worth range 3-5 (issue #1103) ---
/**
 * Rebuild `tasks` to widen the `worth` CHECK from `BETWEEN 1 AND 3` to
 * `BETWEEN 3 AND 5` and remap every existing worth: 1 -> 3, 2 -> 4, 3 -> 5.
 *
 * Detection mirrors ensureTaskSpecialDayColumns() above rather than
 * ensureTaskWorthAndMode()'s column-presence check: `worth` already exists
 * on every database this function will ever see (it is added by
 * ensureTaskWorthAndMode(), which always runs first), so presence alone
 * cannot distinguish an old CHECK from a widened one. Instead this reads the
 * stored CREATE TABLE text out of sqlite_master and rebuilds only when it
 * still names the old range — a fresh DB's CREATE TABLE IF NOT EXISTS above
 * already carries the widened CHECK, so this is a no-op there, and a no-op
 * on every later boot of an already-migrated DB (idempotent: a second boot
 * finds `worth BETWEEN 3 AND 5` in sqlite_master.sql and returns early
 * without touching the table or its data again — a row already remapped to
 * 3/4/5 is never remapped a second time).
 *
 * SQLite cannot alter a CHECK constraint in place, so on an old-range table
 * we rebuild it — same recipe as ensureTaskSpecialDayColumns() above, with
 * one difference: the copy is by EXPLICIT column list naming every current
 * `tasks` column, never `SELECT *` or a positional copy, because by the time
 * this migration runs a database that reached this shape via the ALTER TABLE
 * guards above (ensureTaskFlashColumns/ensureTaskLuckyColumns/
 * ensureTaskLiveSinceColumn) holds flash_start_at/flash_minutes/flash_bonus/
 * lucky_date/lucky_bonus/live_since in DIFFERENT physical positions than a
 * fresh database's CREATE TABLE order (those guards each append after
 * created_at; see ensureTaskFlashColumns's own doc comment) — `SELECT *`
 * would copy the right VALUES into the wrong NAMED columns the moment the
 * physical order diverges from tasks_new's declared order. Naming every
 * column on both sides of the INSERT makes the copy immune to that
 * divergence. `worth` is the only column whose VALUE is transformed in
 * transit (`worth + 2`, which maps 1/2/3 to 3/4/5 exactly); every other
 * column, flash/lucky/live_since included, is copied unchanged.
 *
 * Same two rebuild hazards ensureTaskWorthAndMode/ensureTaskSpecialDayColumns
 * above already solve, copied verbatim: (a) submissions.task_id and
 * badges.task_id both REFERENCE tasks(id) ON DELETE CASCADE, so foreign_keys
 * is turned off for the duration of the rebuild and restored immediately
 * after. (b) This runs last of this file's tasks migrations, after
 * ensureTaskLiveSinceColumn(), which is itself required to run after every
 * earlier rebuild/column-add in this file, so every column this function's
 * explicit list names is guaranteed to already exist on the table it reads
 * from. A column added by an earlier guard must be added to both sides of
 * this migration's INSERT list.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureTaskWorthRange(db) {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get();
  if (!row || row.sql.includes('worth BETWEEN 3 AND 5')) {
    // No tasks table yet, or already widened — nothing to do.
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE tasks_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          title          TEXT    NOT NULL,
          description    TEXT    NOT NULL DEFAULT '',
          sort_order     INTEGER NOT NULL DEFAULT 0,
          worth          INTEGER NOT NULL DEFAULT 3 CHECK (worth BETWEEN 3 AND 5),
          special_mode   TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden','oneday')),
          special_date   TEXT,
          special_bonus  INTEGER CHECK (special_bonus IS NULL OR special_bonus BETWEEN 1 AND 3),
          flash_start_at TEXT,
          flash_minutes  INTEGER,
          flash_bonus    INTEGER,
          lucky_date     TEXT,
          lucky_bonus    INTEGER,
          live_since     TEXT,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT chk_special_pairing CHECK ((special_date IS NULL) = (special_bonus IS NULL))
        );

        INSERT INTO tasks_new (
          id, title, description, sort_order, worth, special_mode,
          special_date, special_bonus, flash_start_at, flash_minutes,
          flash_bonus, lucky_date, lucky_bonus, live_since, created_at
        )
          SELECT
            id, title, description, sort_order, worth + 2, special_mode,
            special_date, special_bonus, flash_start_at, flash_minutes,
            flash_bonus, lucky_date, lucky_bonus, live_since, created_at
            FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

module.exports = {
  ensureTaskWorthAndMode,
  ensureTaskSpecialDayColumns,
  ensureTaskFlashColumns,
  ensureTaskLuckyColumns,
  ensureTaskLiveSinceColumn,
  ensureTaskWorthRange,
};
