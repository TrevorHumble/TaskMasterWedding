// tests/fixtures/hanging-heic-worker.js
//
// TEST-ONLY worker used to exercise photos.js's HEIC decode timeout
// deterministically. photos.js points HEIC_WORKER_PATH here (via the
// HEIC_WORKER_PATH env var — a documented test seam) for the timeout test.
//
// Behavior: if the input buffer contains the ASCII marker HANGME, this worker
// HANGS FOREVER (never posts a message, never exits) — simulating a
// pathological HEVC bitstream that drives libheif into a non-terminating
// decode. For any OTHER input it delegates to the real heic-convert exactly
// like the production worker, so a normal HEIC still converts through it. That
// lets one test prove: a hanging decode is force-failed by the timeout AND the
// NEXT (normal) HEIC still converts (heicDecodeChain recovered, not wedged).

'use strict';

const { parentPort, workerData } = require('worker_threads');
const heicConvert = require('heic-convert');
const { HANG_MARKER } = require('../helpers/heic-fixtures');

const buffer = Buffer.from(workerData.buffer);

if (buffer.includes(HANG_MARKER)) {
  // Keep the worker's event loop alive indefinitely without posting a result,
  // so photos.js's timer is the only thing that can settle the decode.
  setInterval(() => {}, 1 << 30);
} else {
  (async () => {
    const output = await heicConvert({ buffer: buffer, format: 'JPEG', quality: 0.9 });
    const buf = Buffer.from(output);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    parentPort.postMessage({ ok: true, buffer: ab }, [ab]);
  })().catch((err) => {
    parentPort.postMessage({ ok: false, message: String((err && err.message) || err) });
  });
}
