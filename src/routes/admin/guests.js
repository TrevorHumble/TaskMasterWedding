// src/routes/admin/guests.js
// Guest table and the single-popup edit (name/contact/PIN/couple/blocked,
// issue #1093), delete, plus the two retired guest-creation paths, seam
// table area "guests" (issue #969).
//
// /identity, /points and /badge below have no UI on the admin Guests screen
// anymore (issue #1093 moved contact/PIN into the single edit popup below,
// and cut bonus points and badge award/remove from the screen entirely), but
// none is retired: /identity still answers exactly as before for any direct
// caller, /points is the only way to undo a wrong bonus already counting in
// the leaderboard total (#1099 tracks giving it a home), and /badge is the
// only way to remove a badge already granted (#1097 tracks the same for
// badges generally).

const express = require('express');
const { db, getGuestByContact } = require('../../db');
const scoring = require('../../services/scoring');
const photos = require('../../services/photos');
const { normalizeContact, isValidPin } = require('../../services/identity');
const { redirectWithMsg, renderNotFound } = require('./shared');

const router = express.Router();

// The sentinel formField returns for a submitted value that is not a string
// at all. Declared before resolveGuestIdentity, which reads it.
const NON_STRING_FIELD = Symbol('non-string field');

/**
 * Read a form field as one of three states, because on POST /guests/:id/edit
 * they mean three different things and collapsing any two of them destroys
 * stored credentials:
 *
 *   undefined - the key was not submitted at all. "Leave this alone."
 *   ''        - the key was submitted empty. On /edit that is a real value
 *               (the popup pre-fills, so an empty box means the host cleared
 *               it); on /identity it means "leave this alone".
 *   string    - a value to validate.
 *
 * Returns the symbol NON_STRING_FIELD for a submitted value that is not a
 * string at all. Express hands back an ARRAY for a repeated key
 * (`?contact=a&contact=b`), and treating that as '' would silently null out a
 * guest's contact on a malformed submit. The caller rejects it instead.
 */
function formField(body, key) {
  if (!body || !(key in body)) return undefined;
  const value = body[key];
  if (typeof value !== 'string') return NON_STRING_FIELD;
  return value.trim();
}

// The one owner of "is this submitted contact/PIN pair acceptable for guest
// :id, and what should the host be told if not" (issue #1093).
//
// Two routes below write a guest's re-entry identity: the popup's single Save
// (POST /guests/:id/edit) and the older POST /guests/:id/identity, which the
// popup replaced but which stays live for direct callers. They differ only in
// what a BLANK field means: Save treats the popup as the whole truth, so a
// blank box stores NULL, while /identity treats a blank field as "leave this
// one alone". Everything else is identical, and that is what lives here:
// which field is validated first, the collision rule, and the exact wording
// each failure gets. Duplicating those across the two handlers would leave
// the collision rule and its three messages with no owner and free to drift.
//
// Returns either { error } (the caller redirects with that message and writes
// nothing) or { pin, contact }, where each is one of three states matching
// formField's three states below: `undefined` for "not submitted, leave it
// alone", `null` for "submitted empty", or a value. The caller decides what
// an empty submission means for it, which is the one thing the two routes
// disagree about.
//
// The UNIQUE-index catch is deliberately NOT here: it belongs around each
// caller's own UPDATE, since the pre-check below is a check, not a lock.
// CONTACT_TAKEN_MESSAGE is shared so both callers answer a lost race with
// the same wording the pre-check uses.
const CONTACT_TAKEN_MESSAGE = 'That contact is already in use by another guest.';
const BAD_CONTACT_MESSAGE = 'Please enter a valid email or phone number.';
const BAD_PIN_MESSAGE = 'Please choose a 4-digit PIN (numbers only).';

function resolveGuestIdentity({ id, rawPin, rawContact }) {
  // A repeated or otherwise non-string key is a malformed submission, never a
  // request to clear the field. Rejecting it here is what stops a stray
  // `?contact=a&contact=b` from nulling a guest's only way back in.
  if (rawPin === NON_STRING_FIELD) {
    return { error: BAD_PIN_MESSAGE };
  }
  if (rawContact === NON_STRING_FIELD) {
    return { error: BAD_CONTACT_MESSAGE };
  }

  // PIN first: a bad PIN must reject the whole submission before any contact
  // work, so a caller can never half-apply one field of a rejected pair.
  if (rawPin && !isValidPin(rawPin)) {
    return { error: BAD_PIN_MESSAGE };
  }

  let contact;
  if (rawContact === undefined) {
    contact = undefined;
  } else if (rawContact === '') {
    contact = null;
  } else {
    const normalized = normalizeContact(rawContact);
    if (!normalized) {
      return { error: BAD_CONTACT_MESSAGE };
    }
    // One guest per normalized contact. Only a DIFFERENT guest already
    // holding it is a conflict: re-submitting this guest's own current
    // contact, unchanged or merely re-cased, must be allowed.
    const existing = getGuestByContact(normalized.value);
    if (existing && existing.id !== id) {
      return { error: CONTACT_TAKEN_MESSAGE };
    }
    contact = { value: normalized.value, type: normalized.type };
  }

  let pin;
  if (rawPin === undefined) pin = undefined;
  else if (rawPin === '') pin = null;
  else pin = rawPin;

  return { pin, contact };
}

// POST /admin/guests, POST /admin/guests/bulk — RETIRED (issue #244 AC2/AC3),
// see shared.js's renderNotFound doc comment.
router.post('/guests', renderNotFound);
router.post('/guests/bulk', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin/guests  — table of guests
// ---------------------------------------------------------------------------
router.get('/guests', (req, res) => {
  const guests = db.prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC').all();

  // Issue #1093 dropped the per-row badge-award control from this screen, so
  // the badge list and each guest's held-badge codes no longer feed anything
  // rendered here: querying them was a cost per page load with no reader.
  const rows = guests.map((g) => {
    return {
      id: g.id,
      name: g.name || '',
      // avatar_path (issue #1093) so the row can render the same avatar
      // partial the guest-facing surfaces use, instead of the disposable
      // phase-1 placeholder.
      avatar_path: g.avatar_path || null,
      // is_couple (issue #647) — the admin-guests view reads g.is_couple to
      // render the "The couple" checkbox checked/unchecked; without exposing
      // it here the checkbox would always render unchecked with no error.
      is_couple: g.is_couple,
      // blocked (issue #1092): the host-set moderation flag the row's dimmed
      // state and Blocked chip read. Passed raw, like is_couple above: both
      // are `INTEGER NOT NULL DEFAULT 0` flags on the same table that the
      // view treats the same way, so one of them coercing and the other not
      // would be a difference with no reason behind it.
      blocked: g.blocked,
      points: scoring.getPoints(g.id),
      completed: scoring.getCompletedCount(g.id),
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
    totalTasks,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/guests/:id/edit: the admin Guests popup's single Save
// (issue #1093). Rename a guest, replace their contact and re-entry PIN,
// and flag them as the couple and/or blocked, all in one request.
//
// Two rules govern this handler, and both are argued in DESIGN.md
// § "Guests screen rebuilt onto the Tasks card/dialog shape" rather than
// re-argued here. Stated once, as the traps they are:
//
//   1. An empty box is a real value and writes NULL; a field that was not
//      submitted at all is left alone. Collapsing those two destroys a
//      guest's only way back in, for every caller that is not the popup.
//   2. guests.pinned is absent from the UPDATE on purpose. The approved
//      popup has no pinned control, and the old statement wrote pinned from
//      the same absent-key-is-false rule as is_couple, so carrying it
//      forward would silently unpin every guest on every Save.
router.post('/guests/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Does this guest exist? First, so a request that names nobody answers
  // "Guest not found." rather than whichever field happened to be malformed.
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  // Read `name` through the same three-state helper the identity fields use.
  // A bare `(req.body.name || '').trim()` throws on a repeated `name` key,
  // because Express hands back an array and arrays have no .trim: a malformed
  // submission became a 500 rather than a refusal. An absent `name` also has
  // to mean "leave it alone" here, for the same reason it does for contact:
  // only a non-popup caller omits it.
  const rawName = formField(req.body, 'name');

  // Checkboxes take the opposite absent-key rule from the text fields above:
  // an unchecked box sends NOTHING, so absent is its only "off" signal and
  // must write 0. A repeated key is still refused, though. It arrives as an
  // array, `Boolean([])` is true, and that would read a malformed submit as
  // "check this box" -- which for `blocked` means silently un-blocking or
  // blocking a guest on a request that was never valid.
  const rawCouple = formField(req.body, 'is_couple');
  const rawBlocked = formField(req.body, 'blocked');
  if (
    rawName === NON_STRING_FIELD ||
    rawCouple === NON_STRING_FIELD ||
    rawBlocked === NON_STRING_FIELD
  ) {
    return redirectWithMsg(res, '/admin/guests', 'That form could not be read. Please try again.');
  }
  // Truthiness, not presence: this is the rule the route already had, and an
  // empty value has to keep meaning "off". A browser never sends `is_couple=`
  // for an unchecked box, but a direct caller can, and it meant off before
  // this issue touched the route. Only the array case changes.
  const isCouple = rawCouple ? 1 : 0;
  const blocked = rawBlocked ? 1 : 0;

  const resolved = resolveGuestIdentity({
    id,
    rawPin: formField(req.body, 'pin'),
    rawContact: formField(req.body, 'contact'),
  });
  if (resolved.error) {
    return redirectWithMsg(res, '/admin/guests', resolved.error);
  }

  // Where this route parts company with /identity: a field SUBMITTED EMPTY
  // (null) is a real value here and stores NULL, because the popup pre-fills
  // every box, so an empty one means the guest has nothing stored or the
  // host cleared it deliberately.
  //
  // A field NOT SUBMITTED AT ALL (undefined) is a different thing, and the
  // difference matters: the popup always sends both keys, so only a caller
  // that is not the popup omits one, and for that caller "I did not mention
  // contact" must never mean "delete their contact". Such a column is left
  // out of the statement entirely rather than written as NULL.
  const sets = ['is_couple = ?', 'blocked = ?'];
  const values = [isCouple, blocked];
  if (rawName !== undefined) {
    sets.push('name = ?');
    values.push(rawName);
  }
  if (resolved.contact !== undefined) {
    sets.push('contact = ?', 'contact_type = ?');
    values.push(
      resolved.contact ? resolved.contact.value : null,
      resolved.contact ? resolved.contact.type : null
    );
  }
  if (resolved.pin !== undefined) {
    sets.push('pin = ?');
    values.push(resolved.pin);
  }
  values.push(id);

  // The collision check inside resolveGuestIdentity is a pre-check, not a
  // lock: a concurrent request could still slip a colliding contact past it
  // and into the idx_guests_contact UNIQUE index before this UPDATE runs.
  // Guard the write itself and answer with the same wording the pre-check
  // uses, instead of a bare 500.
  try {
    db.prepare(`UPDATE guests SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(res, '/admin/guests', CONTACT_TAKEN_MESSAGE);
    }
    throw err;
  }

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

  // /identity predates formField and never saw a non-string field as an
  // error: a repeated key simply fell through as "not submitted", which on
  // this route already means "leave it alone" and writes nothing. Mapping
  // it back to undefined here keeps that answer byte-exact, so widening
  // /edit did not quietly change a route this issue promised to leave
  // alone. /edit rejects the same input instead, because there an
  // unrecognised field would otherwise read as a cleared box.
  const asOptional = (v) => (v === NON_STRING_FIELD ? undefined : v);
  const resolved = resolveGuestIdentity({
    id,
    rawPin: asOptional(formField(req.body, 'pin')),
    rawContact: asOptional(formField(req.body, 'contact')),
  });
  if (resolved.error) {
    return redirectWithMsg(res, '/admin/guests', resolved.error);
  }

  // This route collapses resolveGuestIdentity's two "nothing to write" states
  // into one: absent and submitted-empty both mean "leave this alone" here,
  // which is exactly the rule /edit does not follow.
  const rawPin = resolved.pin || null;
  const normalized = resolved.contact || null;

  if (!rawPin && !normalized) {
    // Where this route parts company with /edit: a null here means the field
    // was not submitted, and on THIS route that means "leave it alone" rather
    // than "store NULL". Both null therefore means nothing was asked for.
    return redirectWithMsg(res, '/admin/guests', 'Nothing to update.');
  }

  // The collision check inside resolveGuestIdentity is a pre-check, not a
  // lock: a concurrent request could still slip a colliding contact past it
  // and into the idx_guests_contact UNIQUE index before this UPDATE runs.
  // Guard the write itself the same way POST /admin/badges guards
  // createCustomBadge's insert above: catch the constraint violation and
  // answer with the same wording as the pre-check, instead of a bare 500.
  // Three hand-written branches rather than /edit's assembled statement,
  // deliberately: this route is held byte-exact by #1093 criterion 7, and
  // rewriting its write path to match /edit's shape would be a behavior
  // change dressed as a tidy-up. The two routes share their VALIDATION
  // (resolveGuestIdentity above); they do not share a write policy, because
  // they do not have the same one.
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
      return redirectWithMsg(res, '/admin/guests', CONTACT_TAKEN_MESSAGE);
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
