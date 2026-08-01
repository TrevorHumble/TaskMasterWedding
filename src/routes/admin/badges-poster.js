// src/routes/admin/badges-poster.js
// Custom badge creation + the shared entry-link poster — seam table area
// "badges + poster" (issue #969).

const express = require('express');
const config = require('../../../config');
const scoring = require('../../services/scoring');
const qr = require('../../services/qr');
const { redirectWithMsg } = require('./shared');

const router = express.Router();

// POST /admin/badges  — create a new host-defined CUSTOM badge.
// Body: name (required), art_path (required, non-empty — an image path or an
// emoji string), description (optional).
// Always creates type = 'custom' — this route can never be used to create a
// 'metric'/'transferable' catalog row (those are seeded by scripts/seed.js
// only, keyed to a registry function in src/services/badges.js). The code is
// derived from the name (uppercased, non-alnum stripped) so the admin never
// has to invent a machine code by hand; scoring.createCustomBadge's UNIQUE
// constraint on `code` still guards against a collision.
router.post('/badges', (req, res) => {
  const name = (req.body.name || '').trim();
  const artPath = (req.body.art_path || '').trim();
  const description = (req.body.description || '').trim();

  if (!name) {
    return redirectWithMsg(res, '/admin/guests', 'A custom badge needs a name.');
  }
  if (!artPath) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'A custom badge needs art (an image path or emoji).'
    );
  }

  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 40);
  if (!code) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'That name has no usable characters for a badge code.'
    );
  }

  try {
    const badge = scoring.createCustomBadge({ code, name, type: 'custom', artPath, description });
    if (!badge) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'Refused: custom badges cannot be metric/transferable.'
      );
    }
    redirectWithMsg(res, '/admin/guests', 'Created custom badge "' + badge.name + '".');
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(res, '/admin/guests', 'A badge with that code already exists.');
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /admin/poster  — the one shared entry-link poster (issue #244). One QR
// pointing at GET /join, printed once instead of a hundred personal
// place-cards — every guest scans the SAME code, then signs themselves up.
// ---------------------------------------------------------------------------
router.get('/poster', async (req, res, next) => {
  try {
    const base = config.BASE_URL.replace(/\/+$/, '');
    const joinUrl = base + '/join';
    // qr.qrDataUrl returns a PNG data-URI string we can drop into <img src>.
    const dataUri = await qr.qrDataUrl(joinUrl);

    res.render('admin-poster', {
      title: 'Entry Poster',
      joinUrl,
      qr: dataUri,
      isAdmin: true,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
