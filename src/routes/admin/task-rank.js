// src/routes/admin/task-rank.js
// Rank & award (issue #661/#892) — seam table area "rank & award".

const express = require('express');
const { db } = require('../../db');
const taskBadges = require('../../services/task-badges');
const { redirectWithMsg, renderNotFound } = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET/POST /admin/tasks/:id/rank  — rank & award (issue #661).
//
// The host picks task T's 1-5 best photos, drags them into placing order,
// and releases T's own badge + 5/4/3/2/1 points in one confirm. Superseds the
// five-code give-a-badge photo-winner picker (photo-badges.js, deleted) —
// this is the ONLY place a task's photos win a badge now.
//
// GET renders the page: T's title/description/badge, every one of T's
// CURRENTLY VISIBLE photos (pick-grid candidates in the editor, a browsable
// lightbox wall on the results view), and the badge's current ranked winners
// (empty before the first release). `released` (the settings marker,
// task-badges.isTaskBadgeAwarded) tells the client whether to open in the
// read-only Results view or the live editor — see
// src/public/js/admin-badge-rank.js for the editing/baseline state machine
// (issue #892 redesign; the only way back into editing is the explicit
// Edit-ranking button, never a stray tap — that superseded AC6's old
// "a tap on any photo exits Awarded" behavior).
//
// POST releases: body `winners` is a comma-separated, ORDERED list of
// submission ids (1st place first), built client-side from the picked/
// dragged DOM order — there is no separate persistence endpoint per drop
// (see admin-badge-rank.js), only this one confirm. task-badges.releaseRanking
// does the real validation (every id must be a currently-visible submission
// of THIS task, 0-5 entries, no duplicates — issue #892 widened the floor
// from 1 to 0: an empty, PRESENT `winners` field is a deliberate clear-all)
// and the atomic whole-set write; this route parses the posted string,
// distinguishes a deliberate clear from a stale/tampered post (issue #892
// AC6), and redirects with the outcome.
// ---------------------------------------------------------------------------
const stmtTaskForRank = db.prepare('SELECT id, title, description FROM tasks WHERE id = ?');
const stmtVisibleTaskPhotosForRank = db.prepare(`
  SELECT s.id AS id, s.thumb_path AS thumb_path, s.photo_path AS photo_path,
         g.id AS guest_id, g.name AS guest_name
    FROM submissions s
    JOIN guests g ON g.id = s.guest_id
   WHERE s.task_id = ? AND s.taken_down = 0
   ORDER BY s.created_at DESC, s.id DESC
`);

router.get('/tasks/:id/rank', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = stmtTaskForRank.get(id);
  if (!task) {
    return renderNotFound(req, res);
  }

  const badge = taskBadges.resolveTaskBadge(id);

  res.render('admin-badge-rank', {
    title: 'Rank & award',
    task,
    badge: taskBadges.toTaskBadgeView(badge),
    photos: stmtVisibleTaskPhotosForRank.all(id),
    winners: taskBadges.currentRanking(id),
    released: taskBadges.isTaskBadgeAwarded(id),
    maxWinners: taskBadges.MAX_RANKED_WINNERS,
    // Serialized down to the client the same way maxWinners is (issue #661
    // PR review, major): task-badges.js's POINTS_BY_RANK stays the ONE
    // place this mapping is declared — admin-badge-rank.js reads it off
    // this local instead of keeping its own hand-synced copy.
    pointsByRank: taskBadges.POINTS_BY_RANK,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

const RANK_REFUSAL_MSG = 'Could not release — the picks changed. Pick winners again and retry.';

// A single comma-separated entry, and NOTHING ELSE — whitespace-padded
// digits only (issue #892 PR review + design-philosophy review, both
// flagged the same gap: a length-compare against parseInt's own output lets
// parseInt's coercion through, e.g. '12.9' parses to 12 and 'abc' parses to
// NaN but '12abc' parses to 12 — all three would have passed a
// parsed-count-vs-entry-count check even though none of them is a clean
// integer). Every entry must match this whole-string shape before any of
// them is parsed.
const RANK_WINNER_ENTRY_RE = /^\s*\d+\s*$/;

router.post('/tasks/:id/rank', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = stmtTaskForRank.get(id);
  if (!task) {
    return renderNotFound(req, res);
  }

  // Issue #892 AC6's parse rule — a plain form field (not JSON), position =
  // placement, same as before, but the ABSENT/EMPTY distinction now matters:
  //   - `winners` absent entirely (not a string): refused, same as pre-#892
  //     — an absent field is never a deliberate clear.
  //   - `winners` present, trimmed to '': a DELIBERATE clear-all (releases
  //     the badge to zero winners).
  //   - `winners` present, non-empty: every comma-separated entry must match
  //     RANK_WINNER_ENTRY_RE (digits only) BEFORE any of them is parsed — a
  //     single entry that fails refuses the WHOLE post (issue #892 review:
  //     the old behavior silently DROPPED the bad entry and released the
  //     short list, shifting every following rank/points value out from
  //     under the host with no warning). A non-digit or coercible entry
  //     ('12.9', '12abc') signals a stale or tampered post, exactly like
  //     releaseRanking's own no-silent-drop rule for a bad submission id.
  if (typeof req.body.winners !== 'string') {
    return redirectWithMsg(res, '/admin/tasks/' + id + '/rank', RANK_REFUSAL_MSG);
  }
  const raw = req.body.winners.trim();
  let submissionIds;
  if (raw === '') {
    submissionIds = [];
  } else {
    const entries = raw.split(',');
    if (!entries.every((v) => RANK_WINNER_ENTRY_RE.test(v))) {
      return redirectWithMsg(res, '/admin/tasks/' + id + '/rank', RANK_REFUSAL_MSG);
    }
    submissionIds = entries.map((v) => parseInt(v, 10));
  }

  const result = taskBadges.releaseRanking(id, submissionIds);
  if (!result) {
    return redirectWithMsg(res, '/admin/tasks/' + id + '/rank', RANK_REFUSAL_MSG);
  }

  const msg =
    result.winners === 0
      ? 'No winners released.'
      : 'Badge released to ' + result.winners + (result.winners === 1 ? ' winner.' : ' winners.');
  redirectWithMsg(res, '/admin/tasks/' + id + '/rank', msg);
});

module.exports = router;
