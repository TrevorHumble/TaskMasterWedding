// src/routes/admin/guests.js
// Guest table, edit, identity (contact/PIN), delete, points, special-badge
// award/remove, plus the two retired guest-creation paths — seam table area
// "guests" (issue #969).

const express = require('express');
const { db, getGuestByContact } = require('../../db');
const scoring = require('../../services/scoring');
const photos = require('../../services/photos');
const { normalizeContact, isValidPin } = require('../../services/identity');
const { redirectWithMsg, renderNotFound } = require('./shared');

const router = express.Router();

// POST /admin/guests, POST /admin/guests/bulk — RETIRED (issue #244 AC2/AC3),
// see shared.js's renderNotFound doc comment.
router.post('/guests', renderNotFound);
router.post('/guests/bulk', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin/guests  — table of guests
// ---------------------------------------------------------------------------
router.get('/guests', (req, res) => {
  const guests = db.prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC').all();

  // List of admin-awardable badges (special + custom, issue #80 AC5) so the
  // per-guest award control can offer them. 'metric'/'transferable' are
  // system-owned and never appear here.
  const specialBadges = db
    .prepare("SELECT * FROM badges WHERE type IN ('special', 'custom') ORDER BY type ASC, name ASC")
    .all();

  // For each guest, attach link, points, completed count, and held badge codes.
  const heldStmt = db.prepare(
    `SELECT b.code FROM guest_badges gb
       JOIN badges b ON b.id = gb.badge_id
      WHERE gb.guest_id = ?`
  );
  const rows = guests.map((g) => {
    const held = heldStmt.all(g.id).map((r) => r.code);
    return {
      id: g.id,
      name: g.name || '',
      bonus_points: g.bonus_points,
      pinned: g.pinned,
      points: scoring.getPoints(g.id),
      completed: scoring.getCompletedCount(g.id),
      heldCodes: held,
      // contact/pin (issue #243) so the admin can view and edit a guest's
      // re-entry identity — recovery on the spot at the reception, no reset
      // flow. '' rather than null so the EJS text-input `value=` never
      // renders the literal string "null".
      contact: g.contact || '',
      pin: g.pin || '',
    };
  });

  // Denominator for each card's "done/total tasks" meta line. ALL tasks, not
  // just active ones: the completed numerator (scoring.getCompletedCount)
  // counts visible submissions on hidden tasks too, and UNIQUE(guest_id,
  // task_id) + ON DELETE CASCADE bound it by the number of existing tasks —
  // so this denominator can never show "4/3 tasks". (Guest home clamps a
  // percentage instead; here the raw pair is displayed, so the denominator
  // must dominate.)
  const totalTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

  res.render('admin-guests', {
    title: 'Guests',
    guests: rows,
    specialBadges,
    totalTasks,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/guests/:id/edit  — rename a guest and set their gallery pin.
// The pin (guests.pinned, issue #251) hoists this guest's section to the top
// of the gallery's By-person view — meant for the couple's own rows. An
// unchecked checkbox posts no `pinned` field at all, which is exactly the
// "unpin" signal.
router.post('/guests/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const pinned = req.body.pinned ? 1 : 0;
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  db.prepare('UPDATE guests SET name = ?, pinned = ? WHERE id = ?').run(name, pinned, id);
  redirectWithMsg(res, '/admin/guests', 'Guest updated.');
});

// POST /admin/guests/:id/identity  — admin sets a guest's contact and/or
// re-entry PIN (issue #243). Goal C: the host can read a locked-out guest's
// PIN back to them on the spot, or fix a mistyped contact, with no reset
// flow. Both fields are optional and independent — an empty/absent field
// means "leave this one alone" (a host correcting only the PIN should not be
// forced to retype a correct contact, and vice versa).
//
// Validation is the SAME rule signup uses (normalizeContact / isValidPin
// from services/identity.js) — this route does not re-encode either rule,
// it calls the single owner both places already share.
router.post('/guests/:id/identity', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, contact, pin FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  const rawContact = typeof req.body.contact === 'string' ? req.body.contact.trim() : '';

  // Validate PIN first (matches the plan's ordering) so a bad PIN never lets
  // a valid contact half-apply — either everything submitted is valid, or
  // nothing is written.
  if (rawPin) {
    if (!isValidPin(rawPin)) {
      return redirectWithMsg(res, '/admin/guests', 'Please choose a 4-digit PIN (numbers only).');
    }
  }

  let normalized = null;
  if (rawContact) {
    normalized = normalizeContact(rawContact);
    if (!normalized) {
      return redirectWithMsg(res, '/admin/guests', 'Please enter a valid email or phone number.');
    }
    // Collision check: one guest per normalized contact. Only a DIFFERENT
    // guest already holding this contact is a conflict — re-submitting the
    // guest's own current contact (unchanged, or just re-cased/reformatted)
    // must be allowed.
    const existing = getGuestByContact(normalized.value);
    if (existing && existing.id !== id) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
  }

  if (!rawPin && !normalized) {
    // Neither field submitted (or both blank) — nothing to change.
    return redirectWithMsg(res, '/admin/guests', 'Nothing to update.');
  }

  // The collision check above is a pre-check, not a lock — a concurrent
  // request could still slip a colliding contact past it and into the
  // idx_guests_contact UNIQUE index before this UPDATE runs. Guard the write
  // itself the same way POST /admin/badges guards createCustomBadge's insert
  // above: catch the constraint violation and answer with the same friendly
  // "already in use" wording as the pre-check, instead of a bare 500.
  try {
    if (rawPin && normalized) {
      db.prepare('UPDATE guests SET pin = ?, contact = ?, contact_type = ? WHERE id = ?').run(
        rawPin,
        normalized.value,
        normalized.type,
        id
      );
    } else if (rawPin) {
      db.prepare('UPDATE guests SET pin = ? WHERE id = ?').run(rawPin, id);
    } else {
      db.prepare('UPDATE guests SET contact = ?, contact_type = ? WHERE id = ?').run(
        normalized.value,
        normalized.type,
        id
      );
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
    throw err;
  }

  redirectWithMsg(res, '/admin/guests', 'Guest contact/PIN updated.');
});

// POST /admin/guests/:id/delete  — delete a guest. The FK cascade removes their
// submission rows and badge rows, but it does NOT touch the image files on disk.
// To keep disk and DB in sync (and avoid orphaned originals + thumbs that no
// export will ever pick up), we hard-delete each of the guest's photo files AND
// their avatar file (issue #196 — the avatar was the one file class this pass
// missed, leaving a deleted guest's portrait still fetchable at /uploads/<file>)
// BEFORE deleting the guest. This is irreversible — the confirm dialog in the
// view warns the operator.
router.post('/guests/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, avatar_path FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  // Collect this guest's submissions so we can remove their files from disk.
  const subs = db.prepare('SELECT id FROM submissions WHERE guest_id = ?').all(id);
  for (const sub of subs) {
    try {
      // Removes the original photo file AND its thumbnail from disk (section 05).
      // If your photos service names this differently (e.g. deleteOriginalFile +
      // deleteThumbFile), call those instead.
      photos.hardDelete(sub.id);
    } catch (err) {
      // Don't abort the whole delete just because one stray file was already
      // gone; log and continue so the DB row still gets removed.
      console.error('Failed to delete files for submission', sub.id, err);
    }
  }

  // Remove the guest's avatar file, if any. deleteOriginalFile no-ops on a
  // null/empty path and already ignores ENOENT (a file already gone from disk
  // does not abort the delete — same policy as the submission files above).
  try {
    photos.deleteOriginalFile(guest.avatar_path);
  } catch (err) {
    console.error('Failed to delete avatar for guest', id, err);
  }

  // Now remove the guest; FK cascade clears submissions + guest_badges rows.
  db.prepare('DELETE FROM guests WHERE id = ?').run(id);

  // The deleted guest's own per-guest badges died with the FK cascade above,
  // and no OTHER guest's per-guest badge (COMPLETIONIST, the BLOOM/BOUQUET/
  // GARDEN auto badges) depends on a different guest's existence — only a
  // registered transferable badge's relative standings would (registry
  // currently empty, #711). If the deleted guest was a sole holder, the
  // next-qualifying guest never got a chance to
  // pick it up until some later, unrelated event triggered a recompute
  // (issue #715 — the one mutation #701's recompute seam did not cover).
  scoring.recomputeTransferableBadges();

  redirectWithMsg(res, '/admin/guests', 'Guest and their photos deleted.');
});

// POST /admin/guests/:id/points  — add (or subtract) bonus points
router.post('/guests/:id/points', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const delta = parseInt(req.body.delta, 10);
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  if (isNaN(delta) || delta === 0) {
    return redirectWithMsg(res, '/admin/guests', 'Enter a non-zero point amount.');
  }
  // scoring.addBonusPoints is additive (bonus_points = bonus_points + delta).
  // It IS floor-clamped at 0: the UPDATE's MAX(0, ...) (scoring.js's
  // stmtAddBonus) means a large negative delta can never drive a guest's
  // bonus below zero. The admin sees the running total in the UI.
  scoring.addBonusPoints(id, delta);
  redirectWithMsg(
    res,
    '/admin/guests',
    (delta > 0 ? 'Awarded ' : 'Removed ') + Math.abs(delta) + ' bonus point(s).'
  );
});

// POST /admin/guests/:id/badge  — award OR remove a special OR custom badge.
// Body: code = badge code (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE, or any
//       admin-created custom code), action = "award", "remove", or "toggle"
//       ("toggle" resolves against the guest's current held state server-side,
//       so the badge-select form stays correct with JavaScript disabled).
// 'metric'/'transferable' codes are refused (issue #80 AC5) — those types are
// system-owned by scoring.recomputeBadges/recomputeTransferableBadges, and an
// admin award/remove attempt on one must not create or delete a guest_badges
// row.
router.post('/guests/:id/badge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = (req.body.code || '').trim().toUpperCase();
  const action = (req.body.action || 'award').trim();

  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  const badge = db
    .prepare("SELECT * FROM badges WHERE code = ? AND type IN ('special', 'custom')")
    .get(code);
  if (!badge) {
    return redirectWithMsg(res, '/admin/guests', 'Unknown special or custom badge.');
  }

  let effective = action;
  if (action === 'toggle') {
    const held = db
      .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(id, badge.id);
    effective = held ? 'remove' : 'award';
  }

  if (effective === 'remove') {
    scoring.removeSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Removed badge "' + badge.name + '".');
  } else {
    scoring.awardSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Awarded badge "' + badge.name + '".');
  }
});

module.exports = router;
