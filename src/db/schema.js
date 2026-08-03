// src/db/schema.js
// Table DDL (issue #969 AC2's "schema-DDL function wrapping"). Exported as a
// function so the entry (src/db.js) controls exactly when it runs, relative
// to the guarded migrations that follow it in the boot sequence — this file
// has no module-load side effect of its own.
'use strict';

// Create every table if it does not already exist. exec() runs multiple
// statements in one call. Running this repeatedly is safe because of the
// "IF NOT EXISTS" guards.
function applySchema(db) {
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
    -- the task is live. The exclusivity guard that shipped in #761,
    -- src/services/tasks.js's whatSpecial(), reads special_date directly, and
    -- the flash columns below, never special_mode. Neither special_date
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
    -- Lucky task fields (issue #650). lucky_date (YYYY-MM-DD) is the
    -- AUTHORITATIVE "this task is lucky" fact -- there is deliberately NO
    -- special_mode member for it (following #761's flash decision verbatim:
    -- gaining one means widening the special_mode CHECK, which SQLite can
    -- only do by rebuilding the table, re-entering the FK-cascade hazard
    -- ensureTaskSpecialDayColumns() documents at length, for no behavioural
    -- gain). A lucky task's radio posts special_mode=lucky but
    -- tasks.normalizeMode coerces that unknown value to the handler's
    -- fallback, so the row actually stores special_mode='none' (or 'hidden'
    -- if the host also hides it) while lucky_date carries the fact --
    -- read-time state, exactly like the flash trio above. lucky_bonus is the
    -- host-chosen secret bonus (1-3). Like the flash trio, this pair carries
    -- NO CHECK/pairing constraint -- the all-or-none pairing is enforced by
    -- the validated write path (src/routes/admin.js) and, on the read side,
    -- by src/services/tasks.js's SPECIAL_RULES lucky entry refusing to pay a
    -- row whose bonus is not an integer in [1, 3].
    lucky_date     TEXT,
    lucky_bonus    INTEGER,
    -- The instant this task last flipped not-live -> live (issue #778),
    -- bumped ONLY at that transition by src/routes/admin.js's create/edit
    -- /active seams (via tasks.isTaskLive, the single liveness owner) -- an
    -- edit that leaves liveness unchanged (a title/worth/date tweak, a
    -- special_date moved to today) never touches it. NULL means "never live"
    -- -- a pre-existing live task on a migrated app.db keeps it NULL rather
    -- than being backfilled, so it can never spuriously announce: the
    -- read-time rule src/services/notifications.js applies is live_since >
    -- checkpoint, and NULL > x is never true in SQL or in JS. UTC
    -- datetime('now') form, matching every other timestamp column in this
    -- file -- deliberately NOT "event-local" despite some of this codebase's
    -- own commentary elsewhere using that phrase loosely, because it must
    -- stay directly string-comparable to guests.recap_checked_at/created_at,
    -- which are the same UTC datetime('now') form.
    live_since     TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    -- Pairing constraint (#753): special_date and
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
    -- resolved is retired (issue #686) but kept in place rather than dropped:
    -- nothing reads it any more (status below is the single lifecycle fact),
    -- and dropping it would be a table rebuild for no behavioural gain. status
    -- is the three-state lifecycle (open -> tracked -> closed) that replaces
    -- it; see ensureBugReportStatusColumn() below for the backfill on an
    -- existing pre-#686 database.
    resolved    INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','tracked','closed')),
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

  -- "Photo is a winner of badge X" — the give-a-badge screen's own worksheet
  -- table (issue #259) — RETIRED by issue #661's one-badge-system
  -- consolidation. It never gained a fresh-DB CREATE TABLE past that issue:
  -- the real ranking model lives entirely on badges/guest_badges (this
  -- table's own doc comment always said so: "points/ranking are issue #661,
  -- which reads this table" — #661 reads the real award rows instead, and a
  -- pre-#661 database's leftover rows/table are dropped by the guarded
  -- ensureBadgeWinnersTableDropped() migration below). See that function's
  -- doc comment for why this was retired outright rather than repointed.

  -- idx_bug_reports_resolved was retired by issue #686 (superseded by
  -- idx_bug_reports_status, created by ensureBugReportStatusColumn() below,
  -- which also drops this index by name on an existing database that already
  -- has it). Deliberately not recreated here: a fresh DB already has the
  -- status column from the CREATE TABLE above, so it goes straight to the
  -- new index and never has this old one at all.

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
  -- Rule 4). kind is the eight-value STORED vocabulary
  -- (badge_granted/badge_revoked/badge_removed/badge_revoked_photo/
  -- photo_takedown/photo_restore/comment_hidden/comment_restored),
  -- deliberately NOT the view-treatment
  -- vocabulary (announce/gold/photo/badge/loss) notifications.js maps it to;
  -- the two must never share a name (see that module's KIND_VIEW map).
  -- badge_revoked is the engine revoking a badge the guest no longer
  -- qualifies for; badge_removed is a host un-awarding one by hand; and
  -- badge_revoked_photo (issue #1060) is the same engine revoking a
  -- threshold badge specifically because the guest removed their own profile
  -- photo, so the recap can name the photo instead of the generic reason.
  -- The three revoke/remove kinds read differently to the guest, so they
  -- stay separate. Only the three original badge_* kinds were emitted by
  -- issue #644; #1060 adds the fourth, badge_revoked_photo. #783 owns the
  -- moderation emitters, which DO belong here (a moderation action, like a
  -- badge grant/revoke, is a fact about one specific guest with no other
  -- place to reconstruct it from). #778 (host announcements — a task going
  -- live, a challenge unsealing, a flash window opening) does NOT add a row
  -- or a column here at all: an announcement is a BROADCAST, not a
  -- per-guest fact, so it is read-time DERIVED from tasks.live_since/
  -- special_date/flash_start_at instead — see
  -- src/services/notifications.js's "Announcements" section and DESIGN.md's
  -- "Recap" ADR for why this table's guest_id-keyed NOT NULL shape is
  -- exactly why a broadcast was never stored here. submission_id/badge_id
  -- are nullable siblings — a badge event sets badge_id only, a moderation
  -- event (future) sets submission_id only — both cascade on delete so an
  -- event never outlives the row it describes turning into a dangling
  -- reference.
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
}

module.exports = { applySchema };
