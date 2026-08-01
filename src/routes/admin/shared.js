// src/routes/admin/shared.js
// Helpers used by more than one admin area module: redirectWithMsg (every
// area) and renderNotFound (the retired guest-creation/qrsheet/comments/
// photo-badge/photo-points paths — see src/routes/admin.js's area map).
// Single owner of both, per issue #969 AC1b.

// Build a redirect target with a human message in the ?msg= query. An
// optional anchor lands the admin back at the element they acted on
// (fragment goes after the query, per URL syntax).
function redirectWithMsg(res, path, msg, anchor) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  const hash = anchor ? '#' + anchor : '';
  res.redirect(303, path + sep + 'msg=' + encodeURIComponent(msg) + hash);
}

// ---------------------------------------------------------------------------
// Retired routes (issue #244 AC2/AC3): guest-creation (POST /guests, POST
// /guests/bulk) and the per-guest QR sheet (GET /qrsheet) must respond 404,
// not just fall out of this router unhandled. That distinction matters here:
// app.js mounts guest.js (at '/') right after this router, and guest.js runs
// `router.use(requireGuest)` unconditionally for every path it sees — so a
// path this router doesn't recognize does NOT reach app.js's real 404
// handler, it falls through into guest.js and comes back as a 302 to /join
// instead (requireGuest has no guest session to check for an admin-only
// visitor). These three retired paths are the only ones on this router that
// need the explicit 404 render; every other guest-reachable path has its
// own route and never reaches this block.
// ---------------------------------------------------------------------------
function renderNotFound(req, res) {
  res.status(404).render('404', { url: req.originalUrl });
}

module.exports = { redirectWithMsg, renderNotFound };
