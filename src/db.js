// src/db.js
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');
const { ensureBadgeCatalog: ensureBadgeCatalogRows } = require('../scripts/badge-catalog');

// --- Make sure the data directory exists before we try to open the DB file. ---
// (Section 01-setup also does this on boot, but we do it here too so that
//  running scripts/seed.js or this file directly never fails on a fresh clone.)
fs.mkdirSync(config.DATA_DIR, { recursive: true });

// --- Open the single SQLite database file (created automatically if missing). ---
const db = new Database(config.DB_PATH);

// --- Pragmas: safety + speed settings, applied every time the DB is opened. ---
// WAL = Write-Ahead Logging: better read/write concurrency and durability.
db.pragma('journal_mode = WAL');
// Foreign keys are OFF by default in SQLite; turn them ON so the
// REFERENCES ... ON DELETE CASCADE constraints below are enforced.
db.pragma('foreign_keys = ON');

// --- Schema: create every table if it does not already exist. ---
// exec() runs multiple statements in one call. Running this repeatedly is safe
// because of the "IF NOT EXISTS" guards.
db.exec(`
  CREATE TABLE IF NOT EXISTS guests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL DEFAULT '',
    avatar_path   TEXT,
    social_links  TEXT    NOT NULL DEFAULT '{}',
    bonus_points  INTEGER NOT NULL DEFAULT 0,
    onboarded     INTEGER NOT NULL DEFAULT 0,
    contact       TEXT,
    contact_type  TEXT,
    pin           TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    title          TEXT    NOT NULL,
    description    TEXT    NOT NULL DEFAULT '',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    worth          INTEGER NOT NULL DEFAULT 1 CHECK (worth BETWEEN 1 AND 3),
    special_mode   TEXT    NOT NULL DEFAULT 'none' CHECK (special_mode IN ('none','hidden','oneday')),
    -- One-day-only challenge fields (issue #753). special_date (YYYY-MM-DD,
    -- NULL = ordinary task) is the AUTHORITATIVE "this task is a challenge"
    -- fact — the seal predicate, the on-day bonus, and the Completionist
    -- exclusion all read IT, not special_mode = 'oneday'. special_mode's
    -- 'oneday' value is the marker written in lockstep alongside it, there
    -- only so the existing mode machinery (liveTaskWhere/isTaskLive) can see
    -- the task is live. (Corrected, issue #761 review fix: this comment used
    -- to also say a future exclusivity guard would read special_mode to see
    -- the task is spoken for. It doesn't — the guard that shipped in #761,
    -- src/services/tasks.js's whatSpecial(), reads special_date directly,
    -- and the flash columns below, never special_mode.) Neither special_date
    -- nor special_bonus is ever written without the other.
    special_date   TEXT,
    special_bonus  INTEGER CHECK (special_bonus IS NULL OR special_bonus BETWEEN 1 AND 3),
    -- Flash task fields (issue #761). flash_start_at is an absolute UTC
    -- instant in exactly YYYY-MM-DDTHH:MM:SS.sssZ form (Date.prototype.
    -- toISOString()'s own output shape), flash_minutes is a whole-minute
    -- duration (>= 1), flash_bonus is 1-3; NULL flash_start_at means no
    -- flash armed. Unlike special_date/special_bonus above, this trio
    -- carries NO CHECK/pairing constraint -- SQLite cannot add a CHECK to an
    -- existing table, and a rebuild to gain one would re-enter the
    -- FK-cascade rebuild hazard ensureTaskSpecialDayColumns() documents at
    -- length for no behavioural gain (issue #761 plan step 1). The
    -- all-three-or-none pairing is instead enforced by #763's validated
    -- write path and, on the read side, by src/services/tasks.js's
    -- flashState() treating a partially-populated row as 'none' rather than
    -- trusting the schema to have refused it.
    flash_start_at TEXT,
    flash_minutes  INTEGER,
    flash_bonus    INTEGER,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    -- Pairing constraint (issue #753 review fix): special_date and
    -- special_bonus are either BOTH NULL (an ordinary task) or BOTH set (a
    -- one-day-only challenge) -- never one without the other. Without this,
    -- special_date='2026-08-07', special_bonus=NULL is a legal row, and
    -- submissions.js's banking write binds that NULL bonus straight into
    -- submissions.bonus_amount (NOT NULL), throwing SQLITE_CONSTRAINT_NOTNULL
    -- inside submitPhoto for every guest submitting that task. The write
    -- sites also coalesce defensively (belt-and-suspenders for a row that
    -- predates this constraint or was hand-edited), but this CHECK is what
    -- stops the bad row from ever being written in the first place.
    CONSTRAINT chk_special_pairing CHECK ((special_date IS NULL) = (special_bonus IS NULL))
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    -- task_id is nullable (issue #247): a NULL task_id marks a "memory" — a
    -- guest photo shared straight to the gallery with no matching task. A
    -- fresh DB gets the nullable column directly here; ensureTaskIdNullable()
    -- below is the guarded rebuild that widens an existing pre-#247 app.db
    -- (which has task_id NOT NULL) to match.
    task_id     INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
    photo_path  TEXT    NOT NULL,
    thumb_path  TEXT    NOT NULL,
    caption     TEXT    NOT NULL DEFAULT '',
    taken_down  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    -- UNIQUE(guest_id, task_id) still holds: SQLite treats every NULL as
    -- distinct from every other value (including other NULLs) under a UNIQUE
    -- constraint, so a guest may have any number of task_id=NULL memory rows
    -- alongside at most one row per real task — do not "fix" this constraint.
    CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
  );

  CREATE TABLE IF NOT EXISTS badges (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
    threshold    INTEGER,
    art_path     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS guest_badges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    badge_id    INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
    awarded_by  TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    guest_id      INTEGER NOT NULL REFERENCES guests(id)      ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (submission_id, guest_id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    guest_id      INTEGER NOT NULL REFERENCES guests(id)      ON DELETE CASCADE,
    body          TEXT    NOT NULL,
    taken_down    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bug_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    page        TEXT,
    user_agent  TEXT,
    resolved    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- Host-scoped favorite marker on a submission (issue #259). This app has
  -- exactly one shared admin login (no per-admin identity — requireAdmin
  -- checks a single signed cookie, see src/middleware/session.js), so "host-
  -- scoped" means one shared flag per photo, not one row per admin user.
  -- Presence of a row IS the favorite (no boolean column needed); the UNIQUE
  -- constraint on submission_id makes a repeat favorite a plain INSERT OR
  -- IGNORE no-op (see src/services/favorites.js).
  CREATE TABLE IF NOT EXISTS admin_favorites (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- "Photo is a winner of badge X" records for the give-a-badge screen (issue
  -- #259). Distinct from the guest-award badges/guest_badges tables (a
  -- DIFFERENT concept: those hand a badge to a GUEST via POST
  -- /admin/guests/:id/badge; these mark a PHOTO as a category winner). badge_code
  -- is one of the five fixed codes in src/services/photo-badges.js — not a
  -- foreign key, since that catalog is a code constant, not a DB table (no
  -- host-facing CRUD for it in this issue). UNIQUE(badge_code, submission_id)
  -- makes a repeat award idempotent (INSERT OR IGNORE, src/services/photo-badges.js)
  -- and is what a badge's "N/5" count derives from (COUNT of rows per code).
  -- No points column: points/ranking are issue #661, which reads this table.
  CREATE TABLE IF NOT EXISTS badge_winners (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_code    TEXT    NOT NULL,
    submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    CONSTRAINT uq_badge_winner UNIQUE (badge_code, submission_id)
  );

  CREATE INDEX IF NOT EXISTS idx_badge_winners_code
    ON badge_winners(badge_code);

  CREATE INDEX IF NOT EXISTS idx_bug_reports_resolved
    ON bug_reports(resolved, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_submissions_photo_path
    ON submissions(photo_path COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_submissions_thumb_path
    ON submissions(thumb_path COLLATE NOCASE);

  CREATE INDEX IF NOT EXISTS idx_likes_submission
    ON likes(submission_id);

  CREATE INDEX IF NOT EXISTS idx_comments_submission
    ON comments(submission_id, taken_down);

  -- "What happened to me" recap events (issue #644) — the STORED half of the
  -- recap. Only facts a later query cannot reconstruct are written here: a
  -- badge grant/revoke row (guest_badges' own row is either overwritten by a
  -- later grant or deleted outright on revoke, so without this table a
  -- revoked badge would leave no trace to notify from). Likes and comments
  -- are NOT stored here — they are DERIVED live by src/services/notifications.js
  -- from the likes/comments tables themselves, the same "derive over store"
  -- rule the rest of the scoring economy follows (economy-architecture.md
  -- Rule 4). kind is the seven-value STORED vocabulary
  -- (badge_granted/badge_revoked/badge_removed/photo_takedown/photo_restore/
  -- comment_hidden/comment_restored) — deliberately NOT the view-treatment
  -- vocabulary (announce/gold/photo/badge/loss) notifications.js maps it to;
  -- the two must never share a name (see that module's KIND_VIEW map).
  -- badge_revoked is the engine revoking a badge the guest no longer
  -- qualifies for; badge_removed is a host un-awarding one by hand — they
  -- read differently to the guest, so they are separate kinds. Only the
  -- three badge_* kinds are emitted by this issue; #783 owns the
  -- moderation emitters and #778 owns announcements (adding its own task_id
  -- column later). submission_id/badge_id are nullable siblings — a badge
  -- event sets badge_id only, a moderation event (future) sets submission_id
  -- only — both cascade on delete so an event never outlives the row it
  -- describes turning into a dangling reference.
  CREATE TABLE IF NOT EXISTS notification_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL,
    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
    badge_id      INTEGER REFERENCES badges(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_notification_events_guest_created
    ON notification_events(guest_id, created_at);

  -- The recap service's unread-count query (src/services/notifications.js)
  -- counts a guest's liked/commented-on photos by guest_id; this index (no
  -- guarded migration needed — CREATE INDEX IF NOT EXISTS is always safe on a
  -- pre-existing populated table) is what keeps that a lookup instead of a
  -- full submissions scan on every request (issue #644 plan step 5).
  CREATE INDEX IF NOT EXISTS idx_submissions_guest_id
    ON submissions(guest_id);
`);

// --- Guarded migration: tasks.worth / tasks.special_mode (issue #727) ---
/**
 * Rebuild `tasks` from the old is_active-only shape to the new shape carrying
 * `worth` (1-3, default 1) and `special_mode` ('none'/'hidden', default
 * 'none'), dropping `is_active` entirely.
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
 * rather than an inline copy of it.
 */
function ensureTaskWorthAndMode() {
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

ensureTaskWorthAndMode();

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
function ensureTaskSpecialDayColumns() {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get();
  // Match the CHECK constraint's own text, not a bare "'oneday'" substring
  // (issue #753 review fix): the CREATE TABLE above also carries a doc
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

ensureTaskSpecialDayColumns();

// --- Guarded migration: tasks.flash_start_at/flash_minutes/flash_bonus (issue #761) ---
/**
 * Add tasks.flash_start_at/flash_minutes/flash_bonus if any is not already
 * present.
 *
 * Same guard shape as ensurePhotoBonusColumn below: the tasks CREATE TABLE
 * above already declares all three (a fresh DB gets them directly), so this
 * is a no-op there; on an existing pre-#761 app.db none of the three exist
 * yet, so PRAGMA table_info detects each absence and the ALTER TABLE runs
 * once per column, gated so a repeat call (or a later boot) is a no-op and
 * never throws "duplicate column". No DEFAULT is given for any of the three
 * (NULL for every pre-existing row is exactly right: "no flash armed").
 *
 * MUST run immediately after ensureTaskSpecialDayColumns() above, and its
 * columns must NOT be added to that function's `tasks_new` rebuild list
 * (issue #761 plan step 1). ensureTaskSpecialDayColumns() only rebuilds
 * `tasks` on a pre-#753 database, which by definition has no flash columns
 * yet -- running this guard after it means the rebuild (if any) finishes
 * first and these ALTERs land on the settled table. `tasks` is rebuilt in
 * exactly two places in this file (ensureTaskWorthAndMode, above that, and
 * ensureTaskSpecialDayColumns immediately above this comment), both earlier
 * than this call site, so no later migration in this file can drop these
 * columns once added.
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
function ensureTaskFlashColumns() {
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

ensureTaskFlashColumns();

// --- Guarded migration: submissions.photo_bonus (issue #89) ---
/**
 * Add submissions.photo_bonus if it is not already present.
 *
 * The submissions CREATE TABLE above deliberately omits photo_bonus, so the
 * column is absent on BOTH a fresh DB and an existing pre-change app.db; on
 * either, the ALTER TABLE ... ADD COLUMN adds it on the first boot. PRAGMA
 * table_info lists the table's current columns; we run ADD COLUMN only when
 * photo_bonus is absent, so every later boot (or a repeat call) is a no-op and
 * never throws "duplicate column" (AC1). Exported so tests bind to this real
 * guard rather than an inline copy of it.
 */
function ensurePhotoBonusColumn() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'photo_bonus')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN photo_bonus INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run once at module load, before scoring.js prepares any statement that reads
// photo_bonus — db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensurePhotoBonusColumn();

// --- Guarded migration: widen badges.type CHECK (issue #80) ---
/**
 * Widen the `badges.type` CHECK to accept 'metric'/'transferable'/'custom'
 * alongside the existing 'auto'/'special', if it does not already.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so on an old-vocabulary
 * table we rebuild it: create a new table with the widened CHECK, copy every
 * row across (preserving id via INSERT ... SELECT with explicit columns so
 * guest_badges.badge_id foreign keys stay valid), drop the old table, and
 * rename the new one into place — all inside one transaction so a mid-migration
 * crash cannot leave the database half-migrated.
 *
 * Detection: read sqlite_master's stored CREATE TABLE SQL for `badges` and
 * check whether it mentions 'metric'. A fresh DB's CREATE TABLE IF NOT EXISTS
 * above already carries the widened CHECK, so this is a no-op there too.
 * Exported so tests can bind to this real guard rather than an inline copy.
 */
function ensureBadgeTypeCheckWidened() {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'badges'`)
    .get();
  if (!row || row.sql.includes("'metric'")) {
    // No badges table yet, or already widened — nothing to do.
    return;
  }

  // guest_badges.badge_id REFERENCES badges(id): dropping `badges` mid-rebuild
  // trips FK enforcement even though the replacement table restores the same
  // ids, so foreign_keys is turned off for the duration of the rebuild only,
  // exactly as SQLite's own documented "12 steps" ALTER-TABLE recipe requires,
  // and turned back on immediately after (this is NOT the app's steady-state
  // pragma, which stays ON at every other point in this file).
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE badges_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          code         TEXT    NOT NULL UNIQUE,
          name         TEXT    NOT NULL,
          type         TEXT    NOT NULL CHECK (type IN ('auto','special','metric','transferable','custom')),
          threshold    INTEGER,
          art_path     TEXT    NOT NULL,
          description  TEXT    NOT NULL DEFAULT ''
        );

        INSERT INTO badges_new (id, code, name, type, threshold, art_path, description)
          SELECT id, code, name, type, threshold, art_path, description FROM badges;

        DROP TABLE badges;
        ALTER TABLE badges_new RENAME TO badges;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureBadgeTypeCheckWidened();

// --- Guarded migration: badges.task_id (issue #483) ---
/**
 * Add badges.task_id if it is not already present, then (re)create the
 * partial unique index that gives a task at most one badge row.
 *
 * Same guard shape as ensurePhotoBonusColumn above: the badges CREATE TABLE
 * above deliberately omits task_id, so the column is absent on BOTH a fresh
 * DB and an existing pre-#483 app.db; the ALTER TABLE ... ADD COLUMN adds it
 * on the first boot, gated on PRAGMA table_info so a repeat call (or a later
 * boot) is a no-op and never throws "duplicate column" (AC9). No DEFAULT is
 * given, so the column is NULL for every pre-existing row — SQLite's ALTER
 * TABLE ADD COLUMN refuses a REFERENCES clause unless the new column's
 * default is NULL, which this satisfies.
 *
 * MUST run AFTER ensureBadgeTypeCheckWidened() above: that function REBUILDS
 * the whole `badges` table on an old-vocabulary DB (drop + recreate + copy),
 * and if task_id already existed by then the rebuild's explicit column list
 * would silently drop it. The call order below (widen-check, then this) is
 * load-bearing, not incidental.
 *
 * The index is partial (WHERE task_id IS NOT NULL) so the many system rows
 * (task_id NULL: auto/special/metric/transferable, plus any custom badge not
 * tied to a task) never collide with each other or with a NULL under a plain
 * UNIQUE constraint — only two badges rows naming the SAME task collide,
 * enforcing "a task has at most one badge row" (issue #483's foundation
 * rule) at the schema layer rather than in application code.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureBadgeTaskIdColumn() {
  const cols = db.prepare(`PRAGMA table_info(badges)`).all();
  if (!cols.some((col) => col.name === 'task_id')) {
    db.exec(`ALTER TABLE badges ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_badges_task_id ON badges(task_id) WHERE task_id IS NOT NULL`
  );
}

ensureBadgeTaskIdColumn();

// --- Guarded migration: guest_badges award columns (issue #483) ---
/**
 * Add guest_badges.points/note/submission_id if any is not already present.
 *
 * Same guard shape as ensureGuestIdentityColumns above: the guest_badges
 * CREATE TABLE deliberately omits all three, so they are absent on BOTH a
 * fresh DB and an existing pre-#483 app.db; each ALTER TABLE runs once per
 * column, gated on PRAGMA table_info, so a repeat call (or a later boot) is a
 * no-op and never throws "duplicate column" (AC9).
 *
 * points defaults to 0 and note/submission_id default to NULL — the ADD
 * COLUMN itself is what gives every PRE-EXISTING row (every system/auto/
 * metric/transferable/special grant ever written through stmtGrantBadge)
 * exactly those defaults, with no separate backfill UPDATE needed (AC7).
 * stmtGrantBadge never sets note/submission_id (those stay NULL for every
 * grant it writes; only task-badges.awardTaskBadge sets them). It DOES set
 * points as of issue #709 — AUTO_METRIC_BADGE_POINTS for an auto/metric
 * grant, 0 for a transferable/admin-special grant — which is exactly why a
 * SEPARATE one-time backfill (ensureAutoMetricBadgePointsBackfilled, below)
 * exists: to catch up a row a PRE-#709 database already granted under the
 * old points = 0 default, which this ADD COLUMN's default cannot reach.
 *
 * submission_id's FK is ON DELETE CASCADE (issue #713) — a fresh DB gets
 * this action directly here, so ensureGuestBadgeSubmissionCascade() below
 * (which rebuilds an existing pre-#713 table whose FK was ON DELETE SET
 * NULL) is a no-op on a fresh DB.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeAwardColumns() {
  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('points')) {
    db.exec(`ALTER TABLE guest_badges ADD COLUMN points INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('note')) {
    db.exec(`ALTER TABLE guest_badges ADD COLUMN note TEXT`);
  }
  if (!names.has('submission_id')) {
    db.exec(
      `ALTER TABLE guest_badges ADD COLUMN submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE`
    );
  }
}

ensureGuestBadgeAwardColumns();

// --- Guarded migration: guest_badges.submission_id ON DELETE CASCADE (issue #713) ---
/**
 * Rebuild guest_badges so submission_id's FK action is ON DELETE CASCADE
 * instead of the original ON DELETE SET NULL, so a hard-deleted photo takes
 * its award row (and points) with it instead of surviving as a NULL-linked
 * row that stmtAwardPointsSum (src/services/scoring.js) always counts.
 *
 * Detection: PRAGMA foreign_key_list(guest_badges), reading the submission_id
 * FK's on_delete action directly rather than re-deriving it from column
 * shape. No-op if guest_badges doesn't exist yet (fresh DB not yet booted),
 * if submission_id carries no FK at all, or if the FK's on_delete is already
 * CASCADE — which covers a fresh DB, since ensureGuestBadgeAwardColumns above
 * now creates submission_id with ON DELETE CASCADE directly, and covers every
 * later boot of an already-migrated DB.
 *
 * SQLite cannot ALTER a foreign key's ON DELETE action in place, so on an
 * old-shape table (pre-#713) we rebuild it — same recipe as
 * ensureTaskIdNullable above: create a new table with the corrected FK, copy
 * every row across by explicit column list (preserving id so nothing that
 * might reference guest_badges elsewhere goes stale, and preserving every
 * other column byte-for-byte, including a NULL submission_id for a
 * system/auto/special grant), drop the old table, rename the new one into
 * place, all inside one transaction so a mid-migration crash cannot leave the
 * database half-migrated. guest_badges has no inbound foreign keys and no
 * secondary indexes beyond the uq_gb UNIQUE constraint, so the rebuild only
 * needs to restore that constraint.
 *
 * Runs AFTER ensureGuestBadgeAwardColumns() above so points/note/
 * submission_id are already guaranteed to exist on the source table before
 * this migration reads and copies them.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeSubmissionCascade() {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'guest_badges'`)
    .all();
  if (tables.length === 0) {
    // No guest_badges table yet — nothing to migrate.
    return;
  }

  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  if (!cols.some((col) => col.name === 'submission_id')) {
    // Pre-#483 shape, submission_id doesn't exist yet — nothing to do; the
    // ensureGuestBadgeAwardColumns() guard above always runs first and would
    // have already added it with ON DELETE CASCADE, so this branch is
    // unreachable in practice but kept as a defensive no-op.
    return;
  }

  const fks = db.prepare(`PRAGMA foreign_key_list(guest_badges)`).all();
  const submissionFk = fks.find((fk) => fk.from === 'submission_id');
  if (!submissionFk || submissionFk.on_delete === 'CASCADE') {
    // Already CASCADE (fresh DB, or a previously-migrated DB), or
    // submission_id somehow carries no FK — nothing to do.
    return;
  }

  // Same reasoning as ensureTaskIdNullable above: dropping guest_badges
  // mid-rebuild would trip FK enforcement on any inbound reference, so
  // foreign_keys is turned off for the duration of the rebuild only, and
  // turned back on immediately after.
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE guest_badges_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          badge_id      INTEGER NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
          awarded_by    TEXT    NOT NULL CHECK (awarded_by IN ('system','admin')),
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          points        INTEGER NOT NULL DEFAULT 0,
          note          TEXT,
          submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
          CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)
        );

        INSERT INTO guest_badges_new
          (id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id)
          SELECT id, guest_id, badge_id, awarded_by, created_at, points, note, submission_id
            FROM guest_badges;

        DROP TABLE guest_badges;
        ALTER TABLE guest_badges_new RENAME TO guest_badges;
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureGuestBadgeSubmissionCascade();

// --- Guarded migration: guest_badges.celebrated_at (issue #644) ---
/**
 * Add guest_badges.celebrated_at if it is not already present, then backfill
 * every PRE-EXISTING row to celebrated_at = created_at.
 *
 * celebrated_at marks the moment a badge's #255 celebration dialog was shown
 * to the guest — NULL means "owed": src/services/render-locals.js's shared
 * resolveBadgeMoment() helper auto-opens the dialog for the guest's oldest
 * owed badge on the next page render and stamps this column the instant it
 * does, so a badge is celebrated exactly once no matter which page happens
 * to render first (plan step 4). Going forward, every NEW grant — recompute-
 * driven (scoring.js's recomputeBadges/recomputeTransferableBadges) or
 * host-awarded (awardSpecialBadge) — leaves this column NULL by simply never
 * naming it in the INSERT, so a freshly granted badge is owed by
 * construction; nothing here writes it non-NULL at grant time.
 *
 * The backfill is what keeps AC8 honest: without it, EVERY badge a guest
 * already held before this migration ran would read celebrated_at = NULL
 * and the very next page load would auto-open a "celebration" for a badge
 * they may have earned days ago — a flood of stale popups, not a recap.
 * Backfilling to the row's own created_at (not to 'now') is deliberate: it
 * keeps each pre-existing award's own timestamp for the recap list's
 * ordering, while still marking it "already celebrated" (non-NULL) so no
 * dialog fires for it.
 *
 * Same guard shape as ensurePhotoBonusColumn above: the guest_badges CREATE
 * TABLE deliberately omits celebrated_at, so it is absent on BOTH a fresh DB
 * and an existing pre-#644 app.db; the ALTER TABLE + backfill run together,
 * gated on column-absence, so a repeat call (or a later boot) is a no-op —
 * critically, the backfill does NOT re-run on every boot, which would
 * otherwise stamp a genuinely-still-owed badge (celebrated_at NULL on a row
 * granted after this migration already ran) back to non-NULL and silently
 * swallow its celebration.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureGuestBadgeCelebratedAtColumn() {
  const cols = db.prepare(`PRAGMA table_info(guest_badges)`).all();
  if (cols.some((col) => col.name === 'celebrated_at')) {
    // Fresh DB, or an already-migrated DB — nothing to do (see the file
    // comment above for why the backfill must NOT re-run here).
    return;
  }
  db.exec(`ALTER TABLE guest_badges ADD COLUMN celebrated_at TEXT`);
  db.exec(`UPDATE guest_badges SET celebrated_at = created_at WHERE celebrated_at IS NULL`);
}

ensureGuestBadgeCelebratedAtColumn();

// --- Guarded migration: guests.pinned (issue #251) ---
/**
 * Add guests.pinned if it is not already present.
 *
 * pinned = 1 hoists a guest's section to the top of the gallery's By-person
 * view regardless of recency (the hosts' own section leads). Same pattern as
 * ensurePhotoBonusColumn above: the guests CREATE TABLE deliberately omits
 * the column, PRAGMA table_info detects absence, and the ALTER TABLE runs at
 * most once — so both a fresh DB and an existing pre-change app.db gain the
 * column on first boot, and every later boot is a no-op. Exported so tests
 * bind to this real guard rather than an inline copy of it.
 */
function ensurePinnedColumn() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'pinned')) {
    db.exec(`ALTER TABLE guests ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run at module load, before feed.js prepares any statement that reads
// g.pinned — db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensurePinnedColumn();

// --- Guarded migration: guests.contact / contact_type / pin (issue #239) ---
/**
 * Add guests.contact, guests.contact_type, and guests.pin if any is not
 * already present, then (re)create the partial unique index on contact.
 *
 * Same pattern as ensurePhotoBonusColumn/ensurePinnedColumn above: the guests
 * CREATE TABLE above already carries all three columns, so this is a no-op on
 * a fresh DB. On an existing pre-#239 app.db none of the three columns exist
 * yet, so PRAGMA table_info detects each absence and the ALTER TABLE runs
 * once per column; every later boot (or repeat call) is a no-op and never
 * throws "duplicate column" (AC1).
 *
 * The unique index is created here — AFTER the columns are guaranteed to
 * exist — rather than in the top-level CREATE TABLE/INDEX block above,
 * because on a pre-#239 DB that block runs BEFORE this migration and
 * `guests.contact` would not exist yet for CREATE INDEX to reference. The
 * index is partial (WHERE contact IS NOT NULL) so the many contact-less rows
 * a legacy or seeded DB carries don't collide with each other under a
 * plain UNIQUE constraint — only two rows that both set a real contact value
 * can collide (AC6).
 *
 * Exported so tests bind to this real guard rather than an inline copy of it.
 */
function ensureGuestIdentityColumns() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('contact')) {
    db.exec(`ALTER TABLE guests ADD COLUMN contact TEXT`);
  }
  if (!names.has('contact_type')) {
    db.exec(`ALTER TABLE guests ADD COLUMN contact_type TEXT`);
  }
  if (!names.has('pin')) {
    db.exec(`ALTER TABLE guests ADD COLUMN pin TEXT`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_contact ON guests(contact) WHERE contact IS NOT NULL`
  );
}

// Run at module load, before any signup/re-entry route (#240, #241) prepares
// a statement that reads or writes contact/contact_type/pin — db.js fully
// evaluates this module-load code before any other module's
// `require('../db')` call returns.
ensureGuestIdentityColumns();

// --- Guarded migration: submissions.task_id nullable (issue #247) ---
/**
 * Widen submissions.task_id from NOT NULL to nullable, if it is not already,
 * so a "memory" (a guest photo with no matching task) can be stored as a
 * submissions row with task_id = NULL instead of needing a second table.
 *
 * SQLite cannot ALTER a column's NOT NULL constraint in place, so on an
 * old-shape table (pre-#247) we rebuild it — same recipe as
 * ensureBadgeTypeCheckWidened above: create a new table with the widened
 * column, copy every row across (explicit column list, preserving id so
 * likes/comments foreign keys on submission_id stay valid), drop the old
 * table, rename the new one into place, all inside one transaction so a
 * mid-migration crash cannot leave the database half-migrated. Runs AFTER
 * ensurePhotoBonusColumn() above so photo_bonus already exists on the source
 * table and is carried across by the copy.
 *
 * Detection: PRAGMA table_info's `notnull` flag for the task_id column. A
 * fresh DB's CREATE TABLE IF NOT EXISTS above already declares task_id
 * nullable, so this is a no-op there (and a no-op on every later boot once an
 * existing DB has been migrated once). Exported so tests can bind to this
 * real guard rather than an inline copy of it.
 */
function ensureTaskIdNullable() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  const taskCol = cols.find((col) => col.name === 'task_id');
  if (!taskCol || taskCol.notnull === 0) {
    // No submissions table yet, or task_id is already nullable — nothing to do.
    return;
  }

  // likes/comments both REFERENCE submissions(id) ON DELETE CASCADE: dropping
  // `submissions` mid-rebuild trips FK enforcement even though the
  // replacement table restores the same ids, so foreign_keys is turned off
  // for the duration of the rebuild only (SQLite's documented 12-step
  // ALTER-TABLE recipe), and turned back on immediately after.
  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE submissions_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          guest_id    INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
          task_id     INTEGER REFERENCES tasks(id)  ON DELETE CASCADE,
          photo_path  TEXT    NOT NULL,
          thumb_path  TEXT    NOT NULL,
          caption     TEXT    NOT NULL DEFAULT '',
          taken_down  INTEGER NOT NULL DEFAULT 0,
          photo_bonus INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT uq_sub UNIQUE (guest_id, task_id)
        );

        INSERT INTO submissions_new
          (id, guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus, created_at)
          SELECT id, guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus, created_at
            FROM submissions;

        DROP TABLE submissions;
        ALTER TABLE submissions_new RENAME TO submissions;

        CREATE INDEX IF NOT EXISTS idx_submissions_photo_path
          ON submissions(photo_path COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_submissions_thumb_path
          ON submissions(thumb_path COLLATE NOCASE);
      `);
    });
    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

ensureTaskIdNullable();

// --- Guarded migration: submissions.bonus_amount/bonus_reason (issue #753) ---
/**
 * Add submissions.bonus_amount/bonus_reason if either is not already
 * present.
 *
 * Same guard shape as ensurePhotoBonusColumn/ensureResubmittedColumn above:
 * the submissions CREATE TABLE deliberately omits both, so they are absent
 * on BOTH a fresh DB and an existing pre-#753 app.db; each ALTER TABLE runs
 * once per column, gated on PRAGMA table_info, so a repeat call (or a later
 * boot) is a no-op and never throws "duplicate column".
 *
 * bonus_amount banks the one-day-only on-day bonus AT SUBMIT TIME (never
 * derived at read time — a photo replace resets created_at, so a derived
 * bonus would silently vanish when a guest swapped in a better photo the
 * next day); it defaults to 0, meaning "no banked bonus", which is exactly
 * right for every pre-existing row (none of them could have banked one) and
 * for an ordinary/off-day submission going forward. bonus_reason records
 * which rule banked it ('oneday' for this issue; #649/#650 will write their
 * own literals into this same shared column) and defaults to NULL. Deliberately
 * a NEW pair of columns, not a reuse of submissions.photo_bonus — that
 * column's write path was retired by #684 and it carries unrelated legacy
 * admin-set values.
 *
 * MUST run AFTER ensureTaskIdNullable() above: that function rebuilds
 * `submissions` from an explicit nine-column list, so a bonus_amount column
 * added before it runs would be silently dropped on any database still
 * needing that migration. ensureResubmittedColumn() below sits after
 * ensureTaskIdNullable() for the identical reason; this migration follows
 * the same call-order rule.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureSubmissionsBonusColumns() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has('bonus_amount')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN bonus_amount INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has('bonus_reason')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN bonus_reason TEXT`);
  }
}

ensureSubmissionsBonusColumns();

// --- Guarded migration: badge catalog boot-heal (issue #314) ---
/**
 * Heal the badges table with any catalog rows added since this database was
 * first seeded (e.g. #193's COMPLETIONIST), and re-sync any
 * existing catalog row's display fields to the current catalog (e.g. #354's
 * "Wedding Master's Choice" rename reaching a database seeded before that
 * merge, #655) — the boot path that already owns "make an old database
 * current". Delegates to the one shared catalog + upsert function in
 * scripts/badge-catalog.js (consolidated #314) so scripts/seed.js,
 * scripts/seed-event.js, and this boot path can never drift into separate
 * catalogs (#193 AC4's guarantee).
 *
 * Upsert keyed on badges.code (#655): a catalog code's `name`, `description`,
 * and `art_path` re-sync to the module every boot; a non-catalog row (a
 * task badge or admin-created custom badge) is never touched, because no
 * admin route can rename a catalog code (see badge-catalog.js's
 * ensureBadgeCatalog doc comment). Runs AFTER ensureBadgeTypeCheckWidened()
 * (badges' CHECK already accepts every type the catalog uses) and after
 * ensureTaskIdNullable() (the last of the guarded shape migrations),
 * following the same define-call-export pattern as every migration above.
 * Exported so tests can bind to this real guard rather than an inline copy
 * of it.
 *
 * @returns {{ inserted: number, updated: number, unchanged: number }}
 */
function ensureBadgeCatalog() {
  return ensureBadgeCatalogRows(db);
}

ensureBadgeCatalog();

// --- Guarded migration: retire MOSTPHOTOS/MOSTLIKED (issue #711) ---
/**
 * Delete the MOSTPHOTOS and MOSTLIKED catalog rows and any held guest_badges
 * rows for them. Both codes were removed from the engine registry
 * (src/services/badges.js's TRANSFERABLE_BADGES) and from
 * scripts/badge-catalog.js's BADGES, but ensureBadgeCatalog() above only
 * upserts codes still present in that list — it never deletes a row for a
 * code that's gone, so an existing database needs this explicit DELETE to
 * catch up. Deletes guest_badges first (its badge_id foreign-keys to
 * badges.id), then the two catalog rows themselves. Safe on a database that
 * never had either code: both DELETEs simply match zero rows. Runs after
 * ensureBadgeCatalog() above, same PRAGMA-guarded-migration idiom (defined,
 * called once at module load, exported for tests) as every other migration
 * in this file, though this one is unconditional rather than PRAGMA-gated
 * since a DELETE ... WHERE is already naturally idempotent.
 */
function ensureRetiredBadgesRemoved() {
  const retiredCodes = ['MOSTPHOTOS', 'MOSTLIKED'];
  const deleteHeld = db.prepare(
    `DELETE FROM guest_badges WHERE badge_id IN (SELECT id FROM badges WHERE code = ?)`
  );
  const deleteCatalogRow = db.prepare(`DELETE FROM badges WHERE code = ?`);
  for (const code of retiredCodes) {
    deleteHeld.run(code);
    deleteCatalogRow.run(code);
  }
}

ensureRetiredBadgesRemoved();

// --- Points value + guarded one-time backfill: auto/metric badges (issue #709) ---

/**
 * The single owner of "how many points a held auto/metric badge is worth"
 * (issue #709 — a badge is a point event, not just wall art). BOTH this
 * file's backfill immediately below AND src/services/scoring.js's
 * recomputeBadges grant call sites need this number, and scoring.js already
 * imports `db` from here — db.js cannot import scoring.js back (that would
 * re-enter the db -> scoring -> db require cycle before this module finishes
 * evaluating; see cleanupSelfLikes' comment above for the same hazard) — so
 * this file, the lowest module both reach, is where it has to live. It is
 * also the paid counterpart to `guest_badges.points`'s own `DEFAULT 0`
 * (ensureGuestBadgeAwardColumns above), a fact this file already owns.
 *
 * scoring.js imports this constant rather than re-declaring it; nowhere else
 * writes a bare `1` for this purpose.
 */
const AUTO_METRIC_BADGE_POINTS = 1;

/**
 * Set guest_badges.points = AUTO_METRIC_BADGE_POINTS for every currently-held
 * row whose badge is type IN ('auto','metric') and still carries the
 * pre-#709 default of 0 — BLOOM/BOUQUET/GARDEN (auto) and COMPLETIONIST
 * (metric) now pay a point for as long as a guest holds them, through the
 * existing award-points sum (stmtAwardPointsSum / the leaderboard subquery,
 * src/services/scoring.js) with no new scoring term. Going forward,
 * scoring.js's recomputeBadges grant call sites write
 * AUTO_METRIC_BADGE_POINTS on a NEW auto/metric grant directly; this
 * backfill exists only to catch up a row a pre-#709 database already
 * granted under the old points = 0 default.
 *
 * The filter joins badges.type IN ('auto','metric') — NOT awarded_by =
 * 'system'. A transferable grant (recomputeTransferableBadges) is also
 * awarded_by = 'system', so filtering on awarded_by alone would mis-pay it;
 * joining on the badge's own type is what correctly excludes it (and
 * excludes an admin-special/custom grant too) regardless of whether
 * issue #711's transferable-badge retirement has landed on this database.
 *
 * The WHERE also requires the row's CURRENT points = 0 — this is a
 * different concept from AUTO_METRIC_BADGE_POINTS above (it's the "still at
 * the old default" sentinel, not the paid value), so it stays a literal: a
 * re-run (or a row some other future writer already set a non-zero value on)
 * is never clobbered back — this only advances a row still sitting at the
 * old default.
 *
 * Runs AFTER ensureGuestBadgeAwardColumns() above (the points column must
 * exist before this UPDATE can reference it) and after the badge-catalog
 * migrations including ensureRetiredBadgesRemoved() immediately above (so
 * `badges.type` reflects the settled catalog this backfill joins against,
 * not a mid-migration shape). Naturally idempotent: once every held
 * auto/metric row already carries the paid value, a later boot's UPDATE
 * matches zero rows. Exported so tests bind to this real guard rather than
 * an inline copy.
 *
 * @returns {number} the number of guest_badges rows updated.
 */
function ensureAutoMetricBadgePointsBackfilled() {
  return db
    .prepare(
      `UPDATE guest_badges
          SET points = ?
        WHERE points = 0
          AND badge_id IN (SELECT id FROM badges WHERE type IN ('auto', 'metric'))`
    )
    .run(AUTO_METRIC_BADGE_POINTS).changes;
}

ensureAutoMetricBadgePointsBackfilled();

// --- Guarded migration: submissions.resubmitted (issue #190) ---
/**
 * Add submissions.resubmitted if it is not already present.
 *
 * Same guard shape as ensurePhotoBonusColumn above: the submissions CREATE
 * TABLE deliberately omits resubmitted, so the column is absent on BOTH a
 * fresh DB and an existing pre-change app.db; ALTER TABLE ... ADD COLUMN adds
 * it on the first boot, gated on PRAGMA table_info so a repeat call (or a
 * later boot) is a no-op and never throws "duplicate column".
 *
 * Meaning of the flag: set to 1 when a guest replaces a submission that is
 * currently taken_down (submissions.js's sticky-takedown replace path,
 * issue #190) — the host takedown stays sticky, but this flag tells
 * /admin/photos a new photo is waiting behind it. Cleared back to 0 only by
 * photos.restoreSubmission, in the same transaction as the taken_down flip.
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureResubmittedColumn() {
  const cols = db.prepare(`PRAGMA table_info(submissions)`).all();
  if (!cols.some((col) => col.name === 'resubmitted')) {
    db.exec(`ALTER TABLE submissions ADD COLUMN resubmitted INTEGER NOT NULL DEFAULT 0`);
  }
}

// Run once at module load, before submissions.js/admin.js prepare any
// statement that reads/writes resubmitted — db.js fully evaluates this
// module-load code before any other module's `require('../db')` call returns.
ensureResubmittedColumn();

// --- Guarded migration: retire guests.avatar_point_awarded (issue #716) ---
/**
 * Fold the one-time banked starter point back into the derived rule, then
 * drop the now-dead `avatar_point_awarded` flag column.
 *
 * Issue #716 supersedes #409's design: the "Upload your profile photo"
 * starter point is no longer a one-time banked award, it is DERIVED live
 * from `guests.avatar_path IS NOT NULL` (scoring.js's
 * starterTaskContribution/getPoints/leaderboard). A pre-#716 database may
 * still carry `avatar_point_awarded = 1` rows whose point was banked into
 * `bonus_points` by the now-retired `scoring.awardProfilePhotoPoint` — left
 * alone, that guest would double-count once the derived term also starts
 * paying. This migration moves the point from the banked term to the
 * derived one with NO NET CHANGE for a guest who still has an avatar:
 *
 *   1. UPDATE guests SET bonus_points = MAX(0, bonus_points - 1)
 *        WHERE avatar_point_awarded = 1
 *      — MAX(0, ...) matches the floor stmtAddBonus already enforces on
 *      every other bonus_points write, so this can't drive the column
 *      negative. A flagged guest who currently has an avatar loses the
 *      banked +1 here and immediately regains it from the derived term
 *      (getPoints/leaderboard), net zero. A flagged guest with NO avatar
 *      (they banked the point, then removed their photo) loses the banked
 *      point and gains nothing back — the "ghost point" the design
 *      explicitly calls out as intended to go away.
 *   2. ALTER TABLE guests DROP COLUMN avatar_point_awarded
 *      — the flag has no reader left once step 1 runs; keeping a dead
 *      column around would be a second (unread, and therefore silently
 *      driftable) source of truth for "did this guest ever have an
 *      avatar." Supported by the bundled SQLite (3.53, better-sqlite3
 *      12.11.1) with no full-table rebuild needed.
 *
 * Both steps run in one transaction so a mid-migration crash can't leave a
 * database with the point subtracted but the column still present (or vice
 * versa). Detection is column-presence, the same PRAGMA table_info guard
 * every other migration in this file uses: the guests CREATE TABLE above no
 * longer declares avatar_point_awarded, so a fresh DB never has the column
 * and this is a no-op there; an existing pre-#716 database has it exactly
 * once, so the migration (and therefore the bonus_points subtraction) runs
 * exactly once, ever, per guest row that had the flag set.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureAvatarPointAwardedRetired() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (!cols.some((col) => col.name === 'avatar_point_awarded')) {
    // Fresh DB (CREATE TABLE above already omits the column), or an
    // already-migrated DB — nothing to do.
    return;
  }

  const migrate = db.transaction(() => {
    db.exec(
      `UPDATE guests SET bonus_points = MAX(0, bonus_points - 1) WHERE avatar_point_awarded = 1`
    );
    db.exec(`ALTER TABLE guests DROP COLUMN avatar_point_awarded`);
  });
  migrate();
}

// Run once at module load, before scoring.js prepares any statement against
// guests.bonus_points — db.js fully evaluates this module-load code before
// any other module's `require('../db')` call returns.
ensureAvatarPointAwardedRetired();

// --- Guarded migration: guests.recap_checked_at (issue #644) ---
/**
 * Add guests.recap_checked_at if it is not already present, then backfill
 * every PRE-EXISTING guest to recap_checked_at = datetime('now').
 *
 * recap_checked_at is the guest's recap checkpoint (src/services/
 * notifications.js): NULL means "never checked" — every read in that module
 * guards with COALESCE(g.recap_checked_at, g.created_at) so a NULL checkpoint
 * never reaches a comparison directly (SQLite yields NULL, not true, so an
 * unguarded `created_at > recap_checked_at` would silently read as "nothing
 * is new" forever for that guest). POST /recap/seen (src/routes/guest.js) is
 * the only writer once this migration has run.
 *
 * MUST be added NULLABLE with NO DEFAULT, and the backfill MUST be a
 * separate UPDATE, not `ADD COLUMN ... NOT NULL DEFAULT (datetime('now'))`:
 * verified on this tree (better-sqlite3, SQLite 3.53.2) — that single-step
 * form succeeds on an empty table but throws "Cannot add a column with
 * non-constant default" the instant one guest row already exists, which
 * would crash the deployed app on boot (src/db.js runs its migrations at
 * module load) while CI stayed green (every test builds a fresh empty DB).
 *
 * The backfill is what satisfies AC8's "existing guest" half: without it, a
 * guest who already has months of likes/comments/badges would see their
 * ENTIRE history as "new since I last checked" the moment this migration
 * lands — a flood, not a recap. Backfilling to 'now' (not to some earlier
 * timestamp) makes every pre-existing guest's unread count exactly 0 right
 * after the upgrade, deliberately erring toward under- rather than
 * over-reporting on the one-time cutover.
 *
 * The backfill must NOT re-run on every boot — same reasoning as
 * ensureGuestBadgeCelebratedAtColumn's own doc comment: a guest who joins
 * (or whose recap_checked_at is legitimately still NULL) AFTER this
 * migration already ran must stay NULL, so their unread count is derived
 * from their own created_at (AC8's "never-checked guest is never treated as
 * having no checkpoint"), not silently pinned to some later server-restart
 * instant. Column-absence gating (this function returns before either
 * statement runs once the column exists) is what keeps the backfill
 * one-shot.
 *
 * Exported so tests bind to this real guard rather than an inline copy.
 */
function ensureRecapCheckedAtColumn() {
  const cols = db.prepare(`PRAGMA table_info(guests)`).all();
  if (cols.some((col) => col.name === 'recap_checked_at')) {
    // Fresh DB, or an already-migrated DB — nothing to do (see the file
    // comment above for why the backfill must NOT re-run here).
    return;
  }
  db.exec(`ALTER TABLE guests ADD COLUMN recap_checked_at TEXT`);
  db.exec(`UPDATE guests SET recap_checked_at = datetime('now') WHERE recap_checked_at IS NULL`);
}

// Run once at module load, before notifications.js prepares any statement
// against guests.recap_checked_at — db.js fully evaluates this module-load
// code before any other module's `require('../db')` call returns.
ensureRecapCheckedAtColumn();

// --- Guarded migration: settings table (issue #283) ---
/**
 * Create the `settings` key/value table if it does not already exist.
 *
 * Shape coordinated with #253's planned settings table (two columns,
 * IF NOT EXISTS) — whichever change lands first wins and the other's
 * migration is a no-op. src/services/lockout.js uses this table to persist
 * admin-lockout state (failedAttempts / lockedUntil) across a process
 * restart, replacing the module-scoped scalars src/routes/auth.js used to
 * carry before #283. Exported so tests bind to this real guard rather than
 * an inline copy.
 */
function ensureSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

// Run at module load, before lockout.js prepares any statement against
// settings -- db.js fully evaluates this module-load code before any other
// module's `require('../db')` call returns.
ensureSettingsTable();

// --- Event configuration: timezone + wedding dates (issue #681) ---
/**
 * Reader/writer pair owning the settings-table keys that hold the event's
 * timezone and wedding date range, so every date-aware consumer (day chips,
 * daily challenges, the dashboard checklist) reads the same facts from one
 * place instead of each hard-coding its own copy. Same settings table +
 * INSERT...ON CONFLICT shape as src/services/lockout.js's readInt/writeInt,
 * just for strings instead of parsed integers -- no separate migration
 * needed, ensureSettingsTable() above already guarantees the table exists.
 */
const KEY_EVENT_TIMEZONE = 'event_timezone';
const KEY_EVENT_START_DATE = 'event_start_date';
const KEY_EVENT_END_DATE = 'event_end_date';

function readSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

function writeSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/**
 * The event's configured timezone and wedding date range. Defaults
 * (America/Boise, 2026-08-07..2026-08-09) are the venue's real values, so a
 * fresh DB -- or an existing DB from before this issue, which has never
 * written these keys -- reads sensible values with no backfill migration.
 * @returns {{ timezone: string, startDate: string, endDate: string }}
 */
function getEventConfig() {
  return {
    timezone: readSetting(KEY_EVENT_TIMEZONE, 'America/Boise'),
    startDate: readSetting(KEY_EVENT_START_DATE, '2026-08-07'),
    endDate: readSetting(KEY_EVENT_END_DATE, '2026-08-09'),
  };
}

/**
 * Persist the event's timezone and wedding date range. This function trusts
 * its caller -- POST /admin/config (src/routes/admin.js) is the single
 * validator (known IANA name, start <= end) and only calls this once every
 * field has already passed.
 * @param {{ timezone: string, startDate: string, endDate: string }} cfg
 */
function setEventConfig({ timezone, startDate, endDate }) {
  writeSetting(KEY_EVENT_TIMEZONE, timezone);
  writeSetting(KEY_EVENT_START_DATE, startDate);
  writeSetting(KEY_EVENT_END_DATE, endDate);
}

// --- Shared helpers used by other sections (scoring, profiles, gallery, etc.). ---

/**
 * Load a single guest row by its sign-in token, or undefined if none.
 * Used by the auth/session middleware in section 03.
 * @param {string} token
 * @returns {object|undefined}
 */
function getGuestByToken(token) {
  return db.prepare(`SELECT * FROM guests WHERE token = ?`).get(token);
}

/**
 * Load a single guest row by numeric id, or undefined if none.
 * @param {number} guestId
 * @returns {object|undefined}
 */
function getGuestById(guestId) {
  return db.prepare(`SELECT * FROM guests WHERE id = ?`).get(guestId);
}

/**
 * Load a single guest row by its normalized contact key (email or phone), or
 * undefined if none. Used by the signup (#240) and re-entry (#241) routes to
 * look up an existing account before creating a new one.
 * @param {string} contact
 * @returns {object|undefined}
 */
function getGuestByContact(contact) {
  return db.prepare(`SELECT * FROM guests WHERE contact = ?`).get(contact);
}

// Flip a guest's onboarded flag to 1 (issue #564). The single writer of this
// column outside its own schema default — GET /how-to-play (src/routes/
// guest.js) is the only caller, invoked on the RENDER of the rules card, not
// on arrival at the route, so a guest who never actually sees the page keeps
// onboarded = 0 and is shown the rules again next login/signup (the intended
// "shown once ever, only after they've actually seen it" behavior).
//
// `UPDATE ... SET onboarded = 1 WHERE id = ?` is naturally idempotent — a
// guest refreshing the rules page twice writes the same value twice, not an
// error — so no read-before-write guard is needed for correctness. The
// falsy-id guard below is defensive only: GET /how-to-play runs behind
// requireGuest, so res.locals.guest is never null there in practice, but a
// no-op on a bad id is cheap insurance against ever handing this a stray
// undefined instead of throwing.
const stmtMarkGuestOnboarded = db.prepare('UPDATE guests SET onboarded = 1 WHERE id = ?');

/**
 * Mark a guest as having seen the how-to-play rules. No-ops (no statement
 * run) if `guestId` is falsy rather than letting a bad id reach the prepared
 * statement.
 * @param {number} guestId
 */
function markGuestOnboarded(guestId) {
  if (!guestId) {
    return;
  }
  stmtMarkGuestOnboarded.run(guestId);
}

// One-time data correction (issue #712): POST /p/:id/like had no ownership
// check before this issue's route fix, so a guest could like their own
// photo and inflate their own like counts / today's-likes standing. This
// deletes every existing self-like row — a like whose guest_id equals the
// owner (submissions.guest_id) of the submission it targets — so the route
// fix and this cleanup close both the going-forward and the already-in-the-
// database halves of the same bug. (This originally also protected the
// MOSTLIKED badge, retired by issue #711; the cleanup still matters for like
// counts and any future like-driven feature such as crowd favorites.)
//
// Deliberately NOT self-invoked here (contrast every other guarded migration
// above, which calls itself immediately after its definition): db.js runs
// its migrations at module load and never requires scoring, so an
// in-db.js call to scoring.recomputeTransferableBadges() would re-enter the
// db -> scoring -> db require cycle before this module finishes evaluating
// (module.exports below) and crash the app at boot — scoring.js's
// `const { db } = require('../db')` would see `undefined`. src/app.js's
// composition root calls this AFTER every router (and therefore scoring) is
// already required, and only recomputes badges if this returns > 0. Once
// the route-level fix above stops new self-likes, this DELETE is naturally
// idempotent: a later boot always removes zero rows. Exported so tests bind
// to this real guard rather than an inline copy, per the repo's migration
// idiom.
//
// @returns {number} the number of self-like rows removed.
function cleanupSelfLikes() {
  return db
    .prepare(
      `DELETE FROM likes
        WHERE guest_id = (
          SELECT submissions.guest_id FROM submissions
           WHERE submissions.id = likes.submission_id
        )`
    )
    .run().changes;
}

module.exports = {
  db,
  ensureTaskWorthAndMode,
  ensureTaskSpecialDayColumns,
  ensureTaskFlashColumns,
  ensurePhotoBonusColumn,
  ensureBadgeTypeCheckWidened,
  ensureBadgeTaskIdColumn,
  ensureGuestBadgeAwardColumns,
  ensureGuestBadgeSubmissionCascade,
  ensurePinnedColumn,
  ensureGuestIdentityColumns,
  ensureTaskIdNullable,
  ensureSubmissionsBonusColumns,
  ensureBadgeCatalog,
  ensureRetiredBadgesRemoved,
  AUTO_METRIC_BADGE_POINTS,
  ensureAutoMetricBadgePointsBackfilled,
  ensureResubmittedColumn,
  ensureAvatarPointAwardedRetired,
  ensureGuestBadgeCelebratedAtColumn,
  ensureRecapCheckedAtColumn,
  ensureSettingsTable,
  getEventConfig,
  setEventConfig,
  getGuestByToken,
  getGuestById,
  getGuestByContact,
  markGuestOnboarded,
  cleanupSelfLikes,
};
