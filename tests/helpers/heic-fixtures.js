// tests/helpers/heic-fixtures.js
//
// Shared HEIC test-fixture builders. SINGLE OWNER of craftHeicHeader (the
// crafted ISO-BMFF ftyp+ispe header used by the pixel-bomb, worker-fail, and
// decode-timeout suites) and of HANG_MARKER (the sentinel the test-only worker
// looks for), so those two suites and the hanging worker cannot drift.
'use strict';

// Sentinel bytes that tests/fixtures/hanging-heic-worker.js watches for: an
// input containing this marker makes that worker hang forever, exercising
// photos.js's decode timeout. Appended AFTER a valid HEIC header so the input
// still passes looksLikeHeic + the pixel cap and actually reaches the worker.
const HANG_MARKER = 'HANGME';

/**
 * Build a minimal ISO-BMFF header that (a) passes photos.looksLikeHeic (ftyp
 * major brand 'heic') and (b) declares width x height in a well-formed 20-byte
 * `ispe` box. No HEVC payload — used to exercise the header-only code paths
 * (pixel-dimension extraction/cap, and — with a HANG_MARKER suffix — the decode
 * timeout) without a real multi-KB HEIC.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function craftHeicHeader(width, height) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0); // box size
  ftyp.write('ftyp', 4, 'ascii'); // box type
  ftyp.write('heic', 8, 'ascii'); // major brand -> looksLikeHeic true
  ftyp.write('heic', 12, 'ascii'); // a compatible brand (filler)

  const ispe = Buffer.alloc(20);
  ispe.writeUInt32BE(20, 0); // ispe box size MUST be 20 (the parser checks this)
  ispe.write('ispe', 4, 'ascii'); // box type
  ispe.writeUInt32BE(0, 8); // version + flags
  ispe.writeUInt32BE(width, 12); // declared width
  ispe.writeUInt32BE(height, 16); // declared height

  return Buffer.concat([ftyp, ispe]);
}

module.exports = { craftHeicHeader, HANG_MARKER };
