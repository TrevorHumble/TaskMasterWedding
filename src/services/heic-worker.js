// src/services/heic-worker.js
//
// worker_threads worker that decodes ONE HEIC/HEIF buffer to JPEG off the main
// event loop, then exits.
//
// Why this exists: heic-convert -> heic-decode -> libheif-js/wasm-bundle has no
// worker offload of its own (there is no worker_threads use inside libheif-js),
// so the decode runs synchronously and would block the ENTIRE Node event loop
// for its full duration. Unlike the jpeg/png/webp path (sharp runs off-thread
// natively), a HEIC decode on the main thread would freeze every route for
// every guest while it runs — and HEIC is the iPhone default, so a
// reception-night burst of uploads is the expected load, not an edge (North
// Star Goal A). Running the decode here keeps the main process responsive.
//
// AUTHORITATIVE pixel-bomb gate (issue #281): the raw-frame allocation
// (`new Uint8ClampedArray(width*height*4)` in node_modules/heic-decode/lib.js)
// is sized from libheif's DECODED-image get_width()/get_height() — NOT from the
// ISO-BMFF `ispe` box. Verified empirically: patching a HEIC's `ispe` to huge
// dimensions leaves get_width()/get_height() unchanged, and a non-standard-size
// `ispe` makes libheif reject the file outright. So the main thread's cheap
// `ispe` pre-check (photos.js assertHeicPixelsWithinCap) is a first-line filter
// only; the ACTUAL bound is enforced HERE, using heic-decode's `.all()` which
// exposes libheif's authoritative dimensions AFTER the container parse but
// BEFORE the raster is allocated (measured: `.all()` costs ~0.2 MB, the raster
// only materializes at `.decode()`). Over `workerData.maxPixels` we abort and
// signal oversize, so the giant allocation never happens. This decode also runs
// in a short-lived worker that exits when done, but note that worker_threads
// share the process address space — the isolation reclaims memory per decode,
// it does NOT let an unbounded frame avoid OOMing the process; the pixel gate is
// what prevents the OOM.
//
// Protocol: HEIC bytes arrive via workerData.buffer, the cap via
// workerData.maxPixels. On success this posts { ok: true, buffer: <ArrayBuffer> }
// (the JPEG bytes, transferred, not copied); on an over-cap image it posts
// { ok: false, oversize: true, width, height }; on any other failure it posts
// { ok: false, message: <string> }. photos.js (decodeHeicInWorker) spawns one
// of these per decode, serialized behind heicDecodeChain so at most one runs at
// a time, and always terminates it.
//
// JPEG encoding matches heic-convert exactly (jpeg-js at Math.floor(quality*100)
// — see node_modules/heic-convert/formats-node.js), so the stored output is
// byte-identical to the previous heic-convert path.

'use strict';

const { parentPort, workerData } = require('worker_threads');
const decode = require('heic-decode');
const jpegJs = require('jpeg-js');

const JPEG_QUALITY = 90; // heic-convert uses Math.floor(0.9 * 100) = 90

async function run() {
  // `.all()` parses the container and exposes libheif's authoritative
  // dimensions WITHOUT allocating the raster (that is deferred to `.decode()`).
  const images = await decode.all({ buffer: workerData.buffer });
  if (!images.length) {
    parentPort.postMessage({ ok: false, message: 'HEIF image not found' });
    return;
  }

  const { width, height } = images[0];

  // AUTHORITATIVE gate: reject BEFORE the width*height*4 raster is allocated.
  if (width * height > workerData.maxPixels) {
    if (images.dispose) images.dispose();
    parentPort.postMessage({ ok: false, oversize: true, width: width, height: height });
    return;
  }

  // Within cap — now materialize the raster and encode to JPEG.
  const raw = await images[0].decode();
  const output = jpegJs.encode(
    { data: raw.data, width: raw.width, height: raw.height },
    JPEG_QUALITY
  ).data;
  if (images.dispose) images.dispose();

  const buf = Buffer.from(output);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  parentPort.postMessage({ ok: true, buffer: ab }, [ab]);
}

run().catch((err) => {
  parentPort.postMessage({ ok: false, message: String((err && err.message) || err) });
});
