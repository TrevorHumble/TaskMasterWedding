// src/routes/guest/profile.js
// GET/POST /me/edit, POST /me/avatar/delete — the guest's own profile-edit
// routes (issue #991 split, seam table area "profile.js").

'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined.
const { db } = require('../../db');

// setFlash is the shared one-shot flash writer, the single owner of the
// signed `flash` cookie's shape.
const { setFlash } = require('../../middleware/session');

// CSRF (issue #284): POST /me/edit runs multer manually, so req.body is not
// parsed until inside that callback — assertCsrf is the shared post-multer
// verifier every multer-driven route in this app calls immediately before
// any state change; rejectCsrf is the one shared 403 response, same literal
// as csrfMiddleware's own rejection.
const { assertCsrf, rejectCsrf } = require('../../middleware/csrf');

// isValidPin (issue #243) — the SAME 4-digit-shape rule signup (routes/auth.js)
// and the admin identity route (routes/admin.js) already share from
// services/identity.js. POST /me/edit below calls this single owner rather
// than re-encoding the shape rule a third time.
const { isValidPin } = require('../../services/identity');

// Photos service (section 05) — REAL exports only.
// `uploadAvatar` is the multer MEMORY-storage middleware ALREADY BOUND to
// single('avatar') (issue #122) — call it directly as
// `photos.uploadAvatar(req, res, cb)`. After it runs, req.file.buffer holds
// the raw bytes (no req.file.path on this path). saveAvatar(buffer, guestId)
// is ASYNC, writes the avatar file, sets guests.avatar_path, and returns the
// filename. deleteOriginalFile() removes files from disk.
const photos = require('../../services/photos');

const { withBadgeMoment } = require('../../services/render-locals');

// scoring.recomputeThresholdBadges (issue #1060): the profile photo now
// counts toward the BLOOM/BOUQUET/GARDEN thresholds, so both avatar-write
// routes below must recompute after their own UPDATE. Neither route
// imported the scoring service before this issue.
const scoring = require('../../services/scoring');

// uploadRateLimiter (shared with POST /tasks/:id/submit, and with POST
// /me/avatar/delete below — see src/routes/guest/shared.js) — one combined
// per-guest budget, config.RATE_LIMIT_UPLOAD_MAX.
const { uploadRateLimiter } = require('./shared');

// ---------------------------------------------------------------------------
// GET /me/edit  — edit own display name, avatar, and social links.
// social_links is stored as a JSON object string in guests.social_links.
// ---------------------------------------------------------------------------
router.get('/me/edit', function (req, res) {
  const guest = res.locals.guest;

  // Parse social_links JSON safely into an object for the form.
  let social;
  try {
    social = JSON.parse(guest.social_links || '{}');
    if (social === null || typeof social !== 'object') {
      social = {};
    }
  } catch {
    social = {};
  }

  res.render(
    'me-edit',
    withBadgeMoment(req, res, {
      title: 'Edit My Profile',
      social: social,
      pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
    })
  );
});

// ---------------------------------------------------------------------------
// POST /me/edit  — save name, optional new avatar, and social links.
// Avatar uses the SAME memory-storage `uploadAvatar` middleware (field name
// "avatar") as onboarding (issue #122), so req.file.buffer is already the raw
// bytes — no disk read-back/unlink needed. We call photos.saveAvatar(buffer,
// guestId) (async; it sets avatar_path) and remove a replaced avatar with
// deleteOriginalFile. No thumbnail, no submission row.
// ---------------------------------------------------------------------------
router.post('/me/edit', uploadRateLimiter, function (req, res) {
  // photos.uploadAvatar is the ALREADY-BOUND single('avatar') MEMORY-storage
  // middleware (section 05). The callback is async because saveAvatar() is async.
  photos.uploadAvatar(req, res, async function (err) {
    const guest = res.locals.guest;

    if (err) {
      setFlash(res, 'error', 'That avatar could not be uploaded: ' + err.message);
      return res.redirect('/me/edit');
    }

    // CSRF check (issue #284): now that multer has parsed the body,
    // req.body._csrf (the hidden field partials/csrf-field.ejs renders as
    // the FIRST field in me-edit.ejs's form) is available as a second chance
    // for a no-JS native multipart submit, alongside the header
    // csrfMiddleware may already have verified. Runs before any state
    // change — uploadAvatar is MEMORY storage (issue #122), so unlike the
    // disk-storage routes in src/routes/guest/tasks.js and
    // src/routes/guest/memories.js there is no orphaned file on disk to
    // clean up on rejection.
    if (!assertCsrf(req)) {
      rejectCsrf(res);
      return;
    }

    // Optional new re-entry code (issue #243 AC3/AC4). Empty/absent means
    // "leave the existing pin unchanged" — a guest correcting only their name
    // or avatar must never accidentally wipe a working code. Validated with
    // isValidPin (see the require at top of this file), checked FIRST before
    // any other field is touched, so an invalid pin short-circuits the whole
    // save — nothing (name, avatar, socials, pin) is written — rather than
    // silently saving the rest alongside a rejected pin.
    const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
    if (rawPin && !isValidPin(rawPin)) {
      setFlash(res, 'error', 'Please choose a 4-digit PIN (numbers only).');
      return res.redirect('/me/edit');
    }
    const newPin = rawPin ? rawPin : guest.pin; // blank submitted -> keep existing

    // Name: required-ish. If blank, keep the old name rather than wiping it.
    let name = '';
    if (typeof req.body.name === 'string') {
      name = req.body.name.trim().slice(0, 80);
    }
    if (name.length === 0) {
      name = guest.name; // keep existing
    }

    // Build the social_links JSON. Start from the EXISTING object so keys we
    // don't render here (e.g. facebook entered at onboarding) are PRESERVED
    // rather than wiped. We only overwrite the keys this form edits:
    // instagram, facebook, website. Empty values remove that key.
    let social = {};
    try {
      const parsed = JSON.parse(guest.social_links || '{}');
      if (parsed && typeof parsed === 'object') {
        social = parsed;
      }
    } catch {
      social = {};
    }

    const editableKeys = ['instagram', 'facebook', 'website'];
    editableKeys.forEach(function (key) {
      const val = (req.body[key] || '').toString().trim().slice(0, 200);
      if (val) {
        social[key] = val;
      } else {
        delete social[key];
      }
    });
    const socialJson = JSON.stringify(social);

    // Optional new avatar. photos.uploadAvatar (memory storage, field "avatar")
    // already gives us req.file.buffer directly — hand it straight to
    // saveAvatar(buffer, guestId), which writes the stored avatar file, sets
    // guests.avatar_path, and returns the filename. No temp file to read back
    // or clean up.
    let newAvatarPath = guest.avatar_path; // keep existing unless replaced
    // Issue #929: a gate rejection (photos.saveAvatar resolving
    // null, never thrown for AVATAR_QUEUE_BUSY/AVATAR_SLOT_TIMEOUT — see that
    // function's own doc comment) must not cost the guest their name/PIN/
    // social edits from this same POST. This flag is what keeps that case
    // from falling into the ordinary success flash/redirect below.
    let avatarGateRejected = false;
    if (req.file) {
      let savedAvatar;
      try {
        savedAvatar = await photos.saveAvatar(req.file.buffer, guest.id); // stored filename, or null on a gate rejection
      } catch {
        // A genuine save failure (corrupt image, HEIC decode error, etc.) —
        // unchanged behavior: flash and bail before anything is written.
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        return res.redirect('/me/edit');
      }

      if (savedAvatar === null) {
        // The concurrency gate skipped this avatar (busy or timed out).
        // avatar_path stays unchanged (newAvatarPath was already seeded from
        // guest.avatar_path above) — but unlike the throw above, the rest of
        // this save (name/PIN/socials) still proceeds and persists below.
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        avatarGateRejected = true;
      } else {
        const oldAvatar = guest.avatar_path;
        newAvatarPath = savedAvatar;

        // Issue #716: no separate award step needed here — the starter point
        // is derived from guests.avatar_path (scoring.starterTaskContribution),
        // and the UPDATE below sets that column.

        // Delete the previous avatar file if it changed. Avatars live in the
        // uploads dir (no thumbnail), so deleteOriginalFile removes them.
        try {
          if (oldAvatar && oldAvatar !== newAvatarPath) {
            photos.deleteOriginalFile(oldAvatar);
          }
        } catch {
          // Non-fatal.
        }
      }
    }

    db.prepare(
      'UPDATE guests SET name = ?, avatar_path = ?, social_links = ?, pin = ? WHERE id = ?'
    ).run(name, newAvatarPath, socialJson, newPin, guest.id);

    // Issue #1060: the profile photo now counts toward the
    // BLOOM/BOUQUET/GARDEN thresholds (scoring.thresholdCompletedCount), so
    // a save that sets the FIRST avatar can cross one on this same request,
    // not only on the guest's next submission. Runs outside the
    // `if (req.file)` branch above (which closes well before this point) so
    // it fires once on the settled row regardless of which path wrote the
    // avatar, and runs the narrow threshold-only recompute, never the full
    // recomputeBadges, so this route can never grant COMPLETIONIST off an
    // avatar write (see recomputeThresholdBadges' own doc comment). Wrapped
    // and swallowed exactly the way src/services/submissions.js:615-619
    // wraps its own recompute: a failure here must not turn a save that
    // already committed into a 500 for the guest.
    try {
      scoring.recomputeThresholdBadges(guest.id);
    } catch (err) {
      console.error('recomputeThresholdBadges failed (POST /me/edit):', err);
    }

    // A gate-rejected avatar already set its own error flash above — leave it
    // as the one the guest sees rather than clobbering it with the success
    // message below (setFlash writes a single one-shot cookie; see
    // src/middleware/session.js). Everything else this save touched (name,
    // PIN, socials) is still in the UPDATE that just ran either way.
    if (avatarGateRejected) {
      return res.redirect('/me/edit');
    }

    setFlash(res, 'success', 'Profile updated!');
    return res.redirect('/');
  });
});

// ---------------------------------------------------------------------------
// POST /me/avatar/delete  — issue #528: clear the signed-in guest's own
// profile photo. A STANDALONE form on me-edit.ejs (deliberately not a submit
// button of the profile-edit form — see that view's comment), so it reads no
// request body: the target guest comes ONLY from res.locals.guest (set by
// src/routes/guest.js's router.use(requireGuest), from the signed gsid
// cookie), never from req.body/query
// (AC2 — no cross-guest removal via a manipulated field).
//
// Clearing avatar_path is the only write needed for the #409/#716 interplay
// (AC4): starterTaskContribution/getPoints derive BOTH "done" and the point
// itself from `!!avatar_path` alone (issue #716 — the point is no longer a
// one-time banked award), so the starter tile reverts to to-do AND the +1
// leaves the guest's total automatically once this runs, with no separate
// point-clawback write needed. A later re-upload sets avatar_path again and
// the point simply returns (mirrors POST /me/edit's replace path).
//
// Issue #1060 adds ONE more required write below: clearing the avatar can
// also drop the guest below a BLOOM/BOUQUET/GARDEN threshold, which
// starterTaskContribution's automatic point derivation does not cover on
// its own, so recomputeThresholdBadges runs right after the UPDATE.
//
// No-op-but-safe when the guest has no avatar (idempotent redirect) — same
// "nothing to delete" shape as POST /me/edit's replace-avatar branch, which
// also only calls deleteOriginalFile when an old avatar actually exists.
//
// The file unlink is wrapped non-fatal, and the avatar_path UPDATE runs
// regardless — the same ordering POST /me/edit's replace branch above in this
// file uses. deleteOriginalFile swallows ENOENT but rethrows a non-ENOENT failure
// (e.g. a transient Windows lock while express.static serves the file); letting
// that throw would 500 the request and leave avatar_path set, so "Remove photo"
// would silently fail as to state. Clearing the column is the user-visible
// contract; a rare orphaned file on disk is the lesser evil.
// ---------------------------------------------------------------------------
// uploadRateLimiter (shared with POST /me/edit, the sibling avatar-write path):
// this handler does filesystem + DB work, so it gets the same per-guest budget
// its sibling does rather than being an unthrottled fs/db endpoint.
router.post('/me/avatar/delete', uploadRateLimiter, function (req, res) {
  const guest = res.locals.guest;

  if (guest.avatar_path) {
    try {
      photos.deleteOriginalFile(guest.avatar_path);
    } catch {
      // Non-fatal — the column clear below is the contract, not the unlink.
    }
    db.prepare('UPDATE guests SET avatar_path = NULL WHERE id = ?').run(guest.id);

    // Issue #1060: recompute right after the UPDATE, wrapped and swallowed
    // the same way the POST /me/edit call above is (see that call's own
    // comment): a failure here must not turn a delete that already
    // committed into a 500 for the guest. Passes 'badge_revoked_photo' (not
    // the default 'badge_revoked') so a threshold badge lost here reads in
    // the recap as left with the profile photo (AC3), not the generic "the
    // hosts added a task" copy, which would be false for a guest who just
    // removed their own photo.
    try {
      scoring.recomputeThresholdBadges(guest.id, 'badge_revoked_photo');
    } catch (err) {
      console.error('recomputeThresholdBadges failed (POST /me/avatar/delete):', err);
    }

    setFlash(res, 'success', 'Photo removed.');
  }

  return res.redirect('/me/edit');
});

module.exports = router;
