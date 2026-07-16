// tests/heic-pixel-gate.test.js
// Issue #281 (round 8): verify the HEIC pixel-bomb defense against the claimed
// "non-standard-size ispe bypass", and prove the AUTHORITATIVE gate.
//
// STEP-1 finding (see the first test): libheif does NOT size its raw-frame
// allocation from the ISO-BMFF `ispe` box — patching a HEIC's `ispe` to huge
// dimensions leaves libheif's decoded get_width()/get_height() unchanged, and a
// non-standard-size `ispe` makes libheif reject the file. So the claimed
// "24-byte ispe declaring huge dims -> huge allocation" is a FALSE POSITIVE:
// the ispe cannot drive the allocation. The real allocation is sized from
// libheif's decoded dimensions, so the worker gates on THOSE (heic-worker.js)
// BEFORE the raster is allocated.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const request = require('supertest');
const sharp = require('sharp');
const decode = require('heic-decode');
const { loadApp, signInGuest } = require('./helpers/testApp');

const HEIC_FIXTURE = fs.readFileSync(
  path.join(__dirname, '../fixtures/sample-photos/sample-heic-01.heic')
);
const WORKER_PATH = path.join(__dirname, '..', 'src', 'services', 'heic-worker.js');
// The real fixture's primary-image ispe box: 'ispe' type at offset 1038 (size
// field at 1034, width at 1046, height at 1050).
const ISPE = 1038;

let app;
let db;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
});

// Spawn the real worker once and resolve its first message.
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_PATH, { workerData });
    w.once('message', (m) => {
      w.terminate();
      resolve(m);
    });
    w.once('error', (e) => {
      w.terminate();
      reject(e);
    });
  });
}

describe('STEP-1 evidence: libheif ignores the ispe box for allocation sizing', () => {
  it('patching the ispe to huge dimensions leaves libheif get_width/height unchanged', async () => {
    const base = await decode.all({ buffer: HEIC_FIXTURE });
    const patched = Buffer.from(HEIC_FIXTURE);
    patched.writeUInt32BE(4000, ISPE + 8); // ispe width -> 4000
    patched.writeUInt32BE(4000, ISPE + 12); // ispe height -> 4000
    const after = await decode.all({ buffer: patched });
    // The decoded dims libheif reports (and sizes the allocation from) do NOT
    // change — proving the ispe is not the allocation source (false positive).
    expect(after[0].width).toBe(base[0].width);
    expect(after[0].height).toBe(base[0].height);
    expect(base[0].width * base[0].height).toBeLessThan(4000 * 4000);
  });

  it('declaring a non-standard-size ispe (the claimed vector) makes libheif reject the file', async () => {
    const patched = Buffer.from(HEIC_FIXTURE);
    patched.writeUInt32BE(24, ISPE - 4); // ispe box size -> 24 (non-standard)
    patched.writeUInt32BE(16000, ISPE + 8);
    patched.writeUInt32BE(16000, ISPE + 12);
    await expect(decode.all({ buffer: patched })).rejects.toBeInstanceOf(Error);
  });
});

describe('authoritative worker gate on libheif dimensions (before the raster)', () => {
  it('rejects an image whose real decoded dims exceed maxPixels, signalling oversize', async () => {
    // The real fixture is 451x461 (~208k px); a maxPixels of 1000 forces the
    // gate. The worker must signal oversize WITHOUT converting.
    const msg = await runWorker({ buffer: HEIC_FIXTURE, maxPixels: 1000 });
    expect(msg.ok).toBe(false);
    expect(msg.oversize).toBe(true);
    expect(msg.width * msg.height).toBeGreaterThan(1000);
    // Fails if the gate is removed: without it the worker would decode+encode
    // and post { ok: true, buffer } instead.
  });

  it('converts an image within maxPixels to a valid JPEG', async () => {
    const msg = await runWorker({ buffer: HEIC_FIXTURE, maxPixels: 100 * 1000 * 1000 });
    expect(msg.ok).toBe(true);
    const meta = await sharp(Buffer.from(msg.buffer)).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(451);
    expect(meta.height).toBe(461);
  });
});

describe('end-to-end: the crafted "ispe bypass" upload is safely rejected', () => {
  it('a HEIC with a non-standard-size ispe declaring huge dims is rejected, no row, no OOM', async () => {
    const token = `gate-${crypto.randomUUID()}`;
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Gate Guest').lastInsertRowid;
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Gate task').lastInsertRowid;
    const agent = request.agent(app);
    signInGuest(app, token, agent);

    const evil = Buffer.from(HEIC_FIXTURE);
    evil.writeUInt32BE(24, ISPE - 4); // non-standard ispe size
    evil.writeUInt32BE(16000, ISPE + 8); // huge width
    evil.writeUInt32BE(16000, ISPE + 12); // huge height

    const uploadsBefore = fs.readdirSync(require('../config').UPLOADS_DIR).sort();

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', evil, { filename: 'evil.heic', contentType: 'image/heic' });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);
    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined(); // safely rejected, no giant allocation
    // No orphan file left behind.
    expect(fs.readdirSync(require('../config').UPLOADS_DIR).sort()).toEqual(uploadsBefore);
  });
});
