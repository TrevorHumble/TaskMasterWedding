// src/routes/admin/moderation.js
// Photo moderation wall (issue #259/#748/#953) + comment moderation
// (issue #684) — seam table area "photos + comments (moderation)".

const express = require('express');
const { db } = require('../../db');
const photos = require('../../services/photos');
const favoritesSvc = require('../../services/favorites');
const feed = require('../../services/feed');
const { redirectWithMsg, renderNotFound } = require('./shared');

const router = express.Router();

// Redirect back to GET /admin/photos after a favorite/badge/moderation
// mutation, preserving the admin's current view/q (issue #259 AC7: "a
// restore/takedown POST returns to the same view") instead of resetting to
// Recent. Every mutating admin-photos form carries hidden `view`/`q`/`panel`/
// `task` fields (src/views/admin-photos.ejs) so a POST from a filtered/grouped
// view, from inside the inline feed, or from a scoped view=task&task=<id>
// request (issue #748), lands back exactly there. `panel=feed` additionally
// anchors the redirect at the acted-on photo's feed card (#feed-photo-<id>)
// so the give-a-badge/favorite dialog's own JS can detect the fragment on
// load and re-open the feed scrolled to it (see the bottom-of-page <script>
// in admin-photos.ejs).
//
// Reuses redirectWithMsg's own encodeURIComponent scheme for `msg` (query
// string is built manually here, not via URLSearchParams, specifically so the
// two helpers can never disagree on how a message is escaped —
// tests/admin-moderation-guards.test.js's `toContain(encodeURIComponent(...))`
// check depends on the exact %20-style escaping encodeURIComponent produces,
// not URLSearchParams' '+'-for-space form). When no view/q was submitted
// (e.g. the existing not-found-guard tests, which POST an empty body) this
// degrades to the exact same '/admin/photos?msg=...' redirectWithMsg already
// produced before this issue, so that pre-existing coverage is unaffected.
function redirectToPhotos(req, res, msg, submissionId) {
  const view = typeof req.body.view === 'string' ? req.body.view.trim() : '';
  const q = typeof req.body.q === 'string' ? req.body.q.trim() : '';
  const panel = typeof req.body.panel === 'string' ? req.body.panel.trim() : '';
  // Task scope (issue #748) — read the same way view/q/panel are read, and
  // carried through only when posted and non-empty, so a pre-#748 POST (no
  // `task` field at all — e.g. the not-found-guard fixtures in
  // tests/admin-photos-ui.test.js and tests/admin-moderation-guards.test.js)
  // produces the exact same URL it produced before this issue.
  const task = typeof req.body.task === 'string' ? req.body.task.trim() : '';

  const parts = [];
  if (view) parts.push('view=' + encodeURIComponent(view));
  if (q) parts.push('q=' + encodeURIComponent(q));
  if (task) parts.push('task=' + encodeURIComponent(task));
  const path = '/admin/photos' + (parts.length ? '?' + parts.join('&') : '');

  const anchor = panel === 'feed' && submissionId ? 'feed-photo-' + submissionId : undefined;
  redirectWithMsg(res, path, msg, anchor);
}

// ---------------------------------------------------------------------------
// GET /admin/photos  — the full guest-gallery-parity screen (issue #259).
//
// view=recent (default): every submission (including taken-down — an admin
//              wall shows everything, moderation state is a visual overlay,
//              not a filter; the guest gallery's own taken-down EXCLUSION does
//              not apply here). No search box (AC3).
// view=fav:    every FAVORITED submission, same "show everything" rule as
//              recent (a photo favorited before a later takedown still shows,
//              marked taken-down, rather than silently vanishing). No search
//              box (AC3).
// view=task:   LIVE (taken-down excluded) submissions grouped by task,
//              q-filtered by heading. Search box shown (AC3). EXCEPTION
//              (issue #748): when `task=<id>` also names a real task row,
//              the request is SCOPED to that one task instead of the whole
//              wall — the single resulting group includes taken-down
//              submissions too (a host scoping to one task is moderating
//              it, and a taken-down photo they can't see is one they can't
//              restore — DESIGN.md), and `q` is ignored entirely rather than
//              filtering the (single) group's heading. An absent,
//              non-numeric, or unknown `task` leaves the request unscoped,
//              rendering the ordinary by-task wall exactly as before.
// view=user:   LIVE submissions grouped by guest, q-filtered by heading.
//              Search box shown (AC3).
// Anything else falls back to recent (HTTP 200, no error) — same contract as
// GET /gallery (src/routes/community.js).
//
// The inline feed panel (src/views/admin-photos.ejs; no separate route per
// the issue's Touches list) renders whatever `photos` holds below: the FULL
// submission set (including taken-down, matching Recent) on every unscoped
// request, or — on a scoped view=task&task=<id> request (issue #748) — that
// one task's submissions only, so tapping any tile still lands on that same
// photo's card.
// ---------------------------------------------------------------------------
const VALID_PHOTO_VIEWS = new Set(['recent', 'task', 'user', 'fav']);

// Partition `list` into groups by `keyFn`, in first-seen order. `list` is
// already newest-first (the caller's SQL ORDER BY), so a group's first-seen
// position is exactly its newest photo's position — no separate "order
// groups by recency" pass is needed, unlike feed.js's grouped() (which also
// caps each group at 6 preview tiles for the guest gallery; the admin wall
// intentionally shows every photo in a group, uncapped, so a host can act on
// any of them).
//
// `avatarFn` (optional, issue #1011) mirrors feed.js's grouped() stamping
// `group.avatar_path` from the partition's first (newest) row: when passed,
// each group is stamped with `avatar_path = avatarFn(<that group's first
// row>)` once, at group creation, the same "compute it from the first row
// you see" rule grouped() already uses — not re-read per photo. Omitted
// entirely for the By-task grouping, which has no single guest to show an
// avatar for.
function groupPhotos(list, keyFn, headingFn, avatarFn) {
  const byKey = new Map();
  const order = [];
  for (const p of list) {
    const key = keyFn(p);
    if (!byKey.has(key)) {
      const group = { heading: headingFn(p), photos: [] };
      if (avatarFn) group.avatar_path = avatarFn(p);
      byKey.set(key, group);
      order.push(key);
    }
    byKey.get(key).photos.push(p);
  }
  return order.map((key) => byKey.get(key));
}

// The ONE owner of "which section does this photo belong to" (issue #953).
// Before this helper, section membership was computed twice: once
// here in the route (as the grouping key below) and once more, independently,
// by the view's inline script (which re-derived the same 'g'+guest_id /
// 't'+task_id / 'memory' shape from data-guest-id/data-task-id and the
// current VIEW axis). GET /admin/photos now calls this once per row and
// stamps the result onto the row as p._scope_key (below), so both the
// grouping and the rendered data-scope-key attribute the feed script reads
// come from the same computation — a future third grouping axis is one
// branch here, not one branch in two files.
//
// Returns null for a view with no section axis (recent, fav) — those
// contexts are unscoped, matching the pre-existing openFeedAt behavior of
// only scoping when VIEW was 'user' or 'task'.
function scopeKey(p, view) {
  if (view === 'user') return 'g' + p.guest_id;
  if (view === 'task') return p.task_id == null ? 'memory' : 't' + p.task_id;
  return null;
}

// The ONE owner of a photo's displayed guest label (issue #953).
// Before this fix, `p.guest_name || 'Guest #' + p.guest_id` was hand-typed
// in four places — the person-view grouping heading below, and three sites
// in admin-photos.ejs (the tile aria-label, .admin-feed-name, and the
// data-lightbox-by attribute) — four chances to drift on what a missing
// guest name falls back to.
function guestLabel(p) {
  return p.guest_name || 'Guest #' + p.guest_id;
}

// The ONE owner of a photo's displayed task-line text (issue #953).
// Before this fix, this string was hand-typed twice — here and in
// admin-photos.ejs's .feed-task-line — and the two copies branched on
// DIFFERENT predicates (this file checked `p.task_id == null`; the template
// checked `p.task_title` truthiness). Unified on the template's predicate,
// the one that actually reached guests: it treats any falsy title —
// including an empty string, not just null/undefined — as "a shared
// memory," so a photo never renders with an empty quoted title.
function taskLine(p) {
  return p.task_title ? 'for “' + p.task_title + '”' : 'a shared memory';
}

// The ONE owner of the scope note's label text (issue #953). Before
// this helper, the admin-photos inline script derived the label itself by
// decoding scopeKey()'s own grammar (`feedScope.charAt(0) === 'g'`) and then
// reading it off whichever DOM element happened to hold it (.admin-feed-name
// or .feed-task-line) — the route's internal key shape leaking into the
// view. Built from guestLabel()/taskLine() above (issue #953) — the
// same single-owner values the template itself renders — so the scope note
// stays byte-identical to what shipped in phase 1. Returns null alongside
// scopeKey()'s null for an unscoped view.
function scopeLabel(p, view) {
  if (view === 'user') return guestLabel(p);
  if (view === 'task') return taskLine(p);
  return null;
}

// Attach every comment on each loaded photo, hidden ones included — the admin
// judges a hidden comment in place (struck-through, with Restore). This is NOT
// community.js:attachComments, which is private to that file, filters to
// visible-only (c.taken_down = 0), and is keyed on submission_id rather than
// this route's `id` alias. One grouped query (not one per photo). Oldest-first
// (mirrors community.js:228's ORDER BY) so the view's `_cmts.slice(-2)` surfaces
// the 2 MOST-recent comments, not the 2 oldest. `guest_id`/`name` are carried
// raw so the view links the author to /u/<id> with the same 'Guest' fallback as
// the guest feed.
function attachAdminComments(photoRows) {
  if (photoRows.length === 0) return;
  const placeholders = photoRows.map(() => '?').join(', ');
  const commentRows = db
    .prepare(
      `SELECT c.submission_id AS submission_id,
              c.id            AS id,
              c.body          AS body,
              c.taken_down    AS taken_down,
              g.id            AS guest_id,
              g.name          AS name
         FROM comments c
         JOIN guests g ON g.id = c.guest_id
        WHERE c.submission_id IN (${placeholders})
        ORDER BY c.created_at ASC, c.id ASC`
    )
    .all(...photoRows.map((p) => p.id));

  const bySubmission = new Map();
  for (const row of commentRows) {
    if (!bySubmission.has(row.submission_id)) bySubmission.set(row.submission_id, []);
    bySubmission.get(row.submission_id).push({
      id: row.id,
      guest_id: row.guest_id,
      name: row.name,
      body: row.body,
      hidden: Boolean(row.taken_down),
    });
  }
  for (const p of photoRows) {
    p.comments = bySubmission.get(p.id) || [];
  }
}

router.get('/photos', (req, res) => {
  const view = VALID_PHOTO_VIEWS.has(req.query.view) ? req.query.view : 'recent';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  // Optional task scope (issue #748) — only on view=task, and only when
  // `req.query.task` is a string of digits only. The regex test runs BEFORE
  // any parseInt: a repeated `?task=1&task=2` hands Express back an ARRAY
  // (fails the `typeof ... === 'string'` check below), and a value like
  // '12abc' fails `/^\d+$/` outright — neither is silently coerced to a
  // number. The id must also name a real row (the row supplies the group
  // heading below); anything else leaves the request unscoped (AC3).
  let taskScope = null;
  if (view === 'task' && typeof req.query.task === 'string' && /^\d+$/.test(req.query.task)) {
    const scopeRow = db
      .prepare('SELECT id, title FROM tasks WHERE id = ?')
      .get(parseInt(req.query.task, 10));
    if (scopeRow) taskScope = scopeRow;
  }

  // LEFT JOIN tasks (not JOIN): a memory (issue #247, s.task_id IS NULL) has
  // no task row to join — it must still appear here, with task_title coming
  // back NULL; taskLine() below falls back to "a shared memory", and the
  // By-task heading closure further down falls back to "Memories".
  //
  // Scoped (issue #748): narrow this SAME query with `WHERE s.task_id = ?`
  // rather than running a second query — `photoRows` (and everything derived
  // from it below: the H1 count, the group, the inline feed panel) is then
  // already the scoped set, with no extra bookkeeping needed to keep them
  // in sync.
  // like_count (issue #953) rides along as feed.LIKE_COUNT_COLUMN — the same
  // correlated-subquery fragment src/services/feed.js's GALLERY_COLUMNS
  // composes for the identical count (idx_likes_submission, src/db.js, makes
  // it an index lookup), imported here rather than a third hand-typed copy
  // (src/services/scoring.js keeps its own pre-existing copy, out of this
  // issue's scope) — one query attaches the real guest-like count to every
  // row instead of a per-photo follow-up.
  const photosSelect = `SELECT s.id          AS id,
              s.task_id      AS task_id,
              s.photo_path   AS photo_path,
              s.thumb_path   AS thumb_path,
              s.caption      AS caption,
              s.taken_down   AS taken_down,
              s.resubmitted  AS resubmitted,
              s.photo_bonus  AS photo_bonus,
              s.created_at   AS created_at,
              g.id           AS guest_id,
              g.name         AS guest_name,
              g.avatar_path  AS guest_avatar_path,
              t.title        AS task_title,
              ${feed.LIKE_COUNT_COLUMN}
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         LEFT JOIN tasks  t ON t.id = s.task_id`;
  // Written once, appended to both branches — the scoped view and the
  // unscoped wall must never disagree on photo order, and two copies of the
  // clause is how that drift starts.
  const photosOrder = ` ORDER BY s.created_at DESC, s.id DESC`;
  const photoRows = taskScope
    ? db.prepare(photosSelect + ` WHERE s.task_id = ?` + photosOrder).all(taskScope.id)
    : db.prepare(photosSelect + photosOrder).all();

  // Real favorite state, attached once so every derived view below (and the
  // inline feed) shares the same row objects — no view can disagree with
  // another about a given photo's state within one request. The give-a-badge
  // winner state (_winnerCodes/_badged) is retired along with the rest of
  // photo-badges.js — task-photo ranking/award state now lives on GET
  // /admin/tasks/:id/rank instead (#661).
  const favIds = favoritesSvc.favoriteIdSet();
  for (const p of photoRows) {
    p._fav = favIds.has(p.id);
    // The single scope-membership computation (issue #953) — see
    // scopeKey's own comment. Stamped on every row (null/'' for the unscoped
    // recent/fav views) so the feed template can render it as
    // data-scope-key without re-deriving the rule itself. p._scope_label
    // (see scopeLabel's own comment, same issue) rides alongside it so the
    // scope note's text is stamped here too, not decoded back out of
    // data-scope-key by the view.
    p._scope_key = scopeKey(p, view);
    p._scope_label = scopeLabel(p, view);
    // p._guest_label / p._task_line (issue #953) — the single-owner
    // guestLabel()/taskLine() values, stamped here so the template renders
    // them instead of re-deriving the same fallback text itself.
    p._guest_label = guestLabel(p);
    p._task_line = taskLine(p);
  }

  // Attach every comment (hidden ones included) to each photo — the admin
  // judges a hidden comment in place. See attachAdminComments above.
  attachAdminComments(photoRows);

  const favorites = photoRows.filter((p) => p._fav);

  let groups = [];
  if (taskScope) {
    // Scoped (issue #748): one group only, built directly from the already-
    // scoped `photoRows` — NOT the taken_down filter the unscoped view=task
    // branch below applies (a host scoping to one task is moderating it, and
    // a taken-down photo they can't see is one they can't restore —
    // DESIGN.md), and no `q` heading filter at all (AC6: the scope wins, `q`
    // is ignored outright). Zero submissions emits NO group (`groups` stays
    // `[]`) rather than an empty-photo group — a zero-photo group heading
    // would render in place of the empty-state message below and fail AC2.
    if (photoRows.length > 0) {
      groups = [{ heading: taskScope.title, photos: photoRows }];
    }
  } else if (view === 'task' || view === 'user') {
    const livePhotos = photoRows.filter((p) => !p.taken_down);
    // Both branches group by the same scopeKey(); only the heading differs
    // per axis (issue #953) — write the keyFn once rather than pass an
    // identical closure down each arm of the ternary.
    const keyFn = (p) => scopeKey(p, view);
    groups =
      view === 'task'
        ? groupPhotos(livePhotos, keyFn, (p) => p.task_title || 'Memories')
        : groupPhotos(livePhotos, keyFn, guestLabel, (p) => p.guest_avatar_path);
    if (q !== '') {
      const needle = q.toLowerCase();
      groups = groups.filter((g) => g.heading.toLowerCase().includes(needle));
    }
  }

  res.render('admin-photos', {
    title: 'Photos',
    photos: photoRows,
    favorites,
    groups,
    view,
    q,
    // The scoped task's { id, title } row, or null when unscoped (issue
    // #748) — the view picks the empty-state branch when it is set but
    // `groups` came back empty (AC2).
    taskScope,
    // The same scope, already reduced to what a hidden input needs: the bare
    // id, or '' when unscoped. Resolving the null here rather than in the
    // template is what lets every mutating form write `task` as flatly as it
    // writes `view`/`q` (so the scope survives a POST, AC4) — a template that
    // had to re-derive it at each of a dozen sites is one `taskScope.id` away
    // from a TypeError on the default, unscoped page.
    taskScopeId: taskScope ? taskScope.id : '',
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/photos/:id/takedown  — hide a photo. photos.hideSubmission is the
// single writer of taken_down for moderation: it flips the flag and recomputes
// the guest's auto-badges in one transaction, so a hidden photo can never keep
// counting toward points or auto-badges even for an instant. Reachable from
// the give-a-badge dialog's moderate control (issue #259 AC7). Passes 'admin'
// explicitly (issue #886) — a host takedown is always attributed to 'admin',
// never left to the default, so this route reads the same regardless of
// whether hideSubmission's default ever changes.
router.post('/photos/:id/takedown', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.hideSubmission(id, 'admin');
  if (guestId === undefined) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  redirectToPhotos(req, res, 'Photo taken down.', id);
});

// POST /admin/photos/:id/restore  — unhide a photo. photos.restoreSubmission
// flips the flag and recomputes the guest's auto-badges in one transaction —
// see the takedown route above. Reachable from the same give-a-badge dialog
// control (issue #259 AC7).
router.post('/photos/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.restoreSubmission(id);
  if (guestId === undefined) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  redirectToPhotos(req, res, 'Photo restored.', id);
});

// POST /admin/photos/:id/favorite  — toggle the host-scoped favorite flag on
// a photo (issue #259 AC4). Reachable from a tile's heart or the inline
// feed's heart, both real form posts (favorites.js persists it, so it survives
// a reload — no client-only state).
router.post('/photos/:id/favorite', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const submission = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!submission) {
    return redirectToPhotos(req, res, 'Submission not found.', id);
  }
  const nowFavorited = favoritesSvc.toggleFavorite(id);
  redirectToPhotos(req, res, nowFavorited ? 'Added to favorites.' : 'Removed from favorites.', id);
});

// POST /admin/photos/:id/badge  — RETIRED (issue #661). The five-code
// give-a-badge photo-winner picker (src/services/photo-badges.js,
// badge_winners) is deleted outright by the one-badge-system consolidation —
// registered to renderNotFound (not merely unregistered) so a stale
// form/bookmark gets a real 404, same idiom as the other retired routes in
// this file (see renderNotFound's own doc comment above). Ranking and
// awarding a task's photos now happens on GET/POST /admin/tasks/:id/rank.
router.post('/photos/:id/badge', renderNotFound);

// POST /admin/photos/:id/points  — RETIRED (issue #684). The owner called the
// freeform per-photo points override "unfair" — this write path is gone, not
// merely unlinked: registered to renderNotFound so a stale form/bookmark gets
// a real 404, not a fall-through 302 to /join (see renderNotFound's own doc
// comment above). submissions.photo_bonus itself, and any value a host
// already set through this route before it retired, are untouched and still
// count in scoring (src/services/scoring.js still reads the column) — only
// the write path is gone.
router.post('/photos/:id/points', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin/comments  — RETIRED (issue #684). Comment moderation now happens
// in context, under each photo in GET /admin/photos (real per-photo comments
// attached above, hidden ones included), not on a separate all-comments page.
// Registered to renderNotFound, not merely left unregistered, so this path
// returns a real 404 instead of falling through into guest.js's requireGuest
// and coming back a 302 to /join (see renderNotFound's own doc comment
// above).
// ---------------------------------------------------------------------------
router.get('/comments', renderNotFound);

// POST /admin/comments/:id/hide  — hide a comment (taken_down = 1).
//
// Comment moderation uses "hide", not the "takedown" verb the photo routes
// use, because the two actions are not the same operation. A photo takedown
// removes a SCORED submission: it must recompute the guest's auto-badges in a
// transaction (photos.hideSubmission), because a hidden photo can no longer
// count toward points or badges. A comment carries no score and no badge, so
// hiding one is lighter, text-only moderation — a plain taken_down flag flip
// with no scoring side effect. The different verb marks the different weight.
//
// Redirects via redirectToPhotos (issue #684), not the removed /admin/comments
// page: reads back the comment's own submission_id so the host lands on the
// photos feed at that photo's card (#feed-photo-<id>) when the form's hidden
// panel field is "feed" — never a dead page.
router.post('/comments/:id/hide', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id, submission_id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectToPhotos(req, res, 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 1 WHERE id = ?').run(id);
  redirectToPhotos(req, res, 'Comment hidden.', comment.submission_id);
});

// POST /admin/comments/:id/restore  — restore a hidden comment (taken_down = 0).
// Same redirect-to-the-feed-card shape as hide, above (issue #684).
router.post('/comments/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id, submission_id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectToPhotos(req, res, 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 0 WHERE id = ?').run(id);
  redirectToPhotos(req, res, 'Comment restored.', comment.submission_id);
});

module.exports = router;
