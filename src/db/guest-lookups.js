// src/db/guest-lookups.js
// Guest lookup/write helpers used across the app (scoring, profiles,
// gallery, etc.) plus the one-time self-like cleanup app.js's composition
// root runs after every router loads. Every function takes the open `db`
// handle as its first parameter — see src/db/connection.js's own comment on
// why an internal never captures it at module load.
'use strict';

/**
 * Load a single guest row by its sign-in token, or undefined if none.
 * Used by the auth/session middleware.
 * @param {string} token
 * @returns {object|undefined}
 */
function getGuestByToken(db, token) {
  return db.prepare(`SELECT * FROM guests WHERE token = ?`).get(token);
}

/**
 * Load a single guest row by numeric id, or undefined if none.
 * @param {number} guestId
 * @returns {object|undefined}
 */
function getGuestById(db, guestId) {
  return db.prepare(`SELECT * FROM guests WHERE id = ?`).get(guestId);
}

/**
 * Load a single guest row by its normalized contact key (email or phone), or
 * undefined if none. Used by the signup (#240) and re-entry (#241) routes to
 * look up an existing account before creating a new one.
 * @param {string} contact
 * @returns {object|undefined}
 */
function getGuestByContact(db, contact) {
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
/**
 * Mark a guest as having seen the how-to-play rules. No-ops (no statement
 * run, no statement even prepared) if `guestId` is falsy rather than letting
 * a bad id reach the prepared statement.
 * @param {number} guestId
 */
function markGuestOnboarded(db, guestId) {
  if (!guestId) {
    return;
  }
  // Prepared inside the function body, not as a module-load const (issue
  // #969 AC2) — this internal is never co-evicted with connection.js, so a
  // module-load-captured statement would keep querying a stale boot's handle
  // across the class-4 tests' second boot. Prepared AFTER the guard above
  // (HEAD's own call order, restored by the #969 PR review) rather than
  // before it, so the falsy-id no-op path never pays for a statement it
  // never runs.
  const stmtMarkGuestOnboarded = db.prepare('UPDATE guests SET onboarded = 1 WHERE id = ?');
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
// Deliberately NOT called from this module or from src/db.js's own
// module-load boot sequence (contrast every one of the 27 guarded
// migrations, EVERY ONE of which is called from src/db.js's boot sequence —
// see src/db.js:~30-56 — none of them self-invokes): src/db.js runs its
// migrations at module load and never requires scoring, so a call to
// scoring.recomputeTransferableBadges() made from inside db.js (or one of
// its own internals, this file included) would re-enter the db -> scoring ->
// db require cycle before src/db.js finishes evaluating and exporting.
// Instead, src/app.js's composition root calls this export
// (cleanupSelfLikes()) AFTER every router — and therefore scoring, which
// every router requires — is already required, and only recomputes
// transferable badges if this returns > 0 (see src/app.js's own "One-time
// self-like data correction" comment for the call site). Once the
// route-level fix above stops new self-likes, this DELETE is naturally
// idempotent: a later boot always removes zero rows. Exported so tests bind
// to this real guard rather than an inline copy, per the repo's migration
// idiom.
//
// @returns {number} the number of self-like rows removed.
function cleanupSelfLikes(db) {
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
  getGuestByToken,
  getGuestById,
  getGuestByContact,
  markGuestOnboarded,
  cleanupSelfLikes,
};
