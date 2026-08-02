// tests/compression.test.js
// Issue #1012: the server never compressed a response. app.js now runs
// compression() ahead of every static mount and router (see its own comment
// there for the AC4/AC5 filter-table reasoning, the brotli-quality-6 choice,
// and the accepted BREACH tradeoff). This file proves the measured savings
// hold against a real full-event dataset (AC1/AC2), that a plain request is
// unaffected (AC3), that the two binary response shapes this app serves are
// never recompressed for nothing (AC4/AC5), and — separately from any AC,
// added in the review fix pass that found every test above pinned
// Accept-Encoding to the single token 'gzip' — that a real browser's
// multi-value Accept-Encoding header negotiates to the brotli encoding
// production actually serves, not gzip.
//
// REQUIRE ORDER: config / tests/helpers/event-fixture are required only
// AFTER loadApp() sets DATA_DIR/DB_PATH — event-fixture requires
// src/services/scoring, which requires src/db at module scope, so requiring
// it first would seed 60 guests into this WORKTREE'S OWN live data/app.db
// instead of the isolated temp dir. tests/seed-story.test.js's header
// comment documents the same trap; this file copies its pattern.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const request = require('supertest');
const { loadApp, signInGuest, makeAdminAgent } = require('./helpers/testApp');

let config;
let app;
let EVENT_GUEST_TOKEN_PREFIX;

/**
 * superagent gunzips a gzip response BEFORE handing it to a custom .parse()
 * callback, no matter what that callback does — the request's own
 * `'response'` event handler calls `decompress(req, res)` (guarded by
 * `this._shouldDecompress(res)`) before it selects a parser for the body.
 * `lib/node/unzip.js` rewrites the response's own
 * 'data'/'end' events to emit the already-inflated chunks, so even a
 * from-scratch parser that does `res.on('data', ...)` never sees the wire
 * bytes. Verified while writing this test: without the override below, a
 * gzip and an identity request both measured the SAME byte length (the
 * decompressed one) against a server response that was genuinely 61 vs
 * 4,400 bytes on the wire — a silent 0% "saving" that would pass AC1/AC2 by
 * accident on a server that compresses nothing at all.
 *
 * `req.buffer(true)` disables superagent's own text/JSON auto-parsing so
 * the callback controls the whole response body, and the manual
 * concat-then-callback shape is superagent's documented custom-parser
 * contract (a `(res, cb) => void` that calls `cb(err, body)`).
 *
 * @param {import('supertest').Test} req - a supertest request, already
 *   built with .get()/.set() etc. Mutated in place and returned so the
 *   caller can `await raw(request(app).get(...).set(...))`.
 * @returns {import('supertest').Test}
 */
function raw(req) {
  req._shouldDecompress = () => false; // superagent Request.prototype override
  return req.buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (d) => chunks.push(d));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

/**
 * List entry names from a ZIP buffer by walking its End Of Central
 * Directory record and Central Directory File Headers directly — the
 * documented ZIP format (PKWARE APPNOTE.TXT), not a third-party unzip
 * library. No zip-reading package is a declared dependency of this repo
 * (archiver, the prod dependency src/services/export.js uses, only WRITES
 * zips), so this mirrors tests/helpers/testApp.js's signCookieValue: a
 * small, well-documented binary format is reproduced locally instead of
 * reaching into another package's node_modules for a transitive copy that
 * could vanish on the next `npm install`.
 *
 * @param {Buffer} buf
 * @returns {string[]} entry (file) names recorded in the central directory.
 */
function listZipEntries(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  // The EOCD record's fixed portion is 22 bytes; scan backward from the end
  // for its signature. archiver never appends a zip comment for this export
  // (streamExportZip sets none), so the record sits in the final 22 bytes —
  // scanning the whole buffer is simplest and still cheap for a test-sized
  // archive.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('listZipEntries: no End Of Central Directory record found — not a valid zip');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const CDFH_SIG = 0x02014b50;
  const names = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CDFH_SIG) {
      throw new Error(
        `listZipEntries: central directory header signature mismatch at byte ${offset}`
      );
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  config = require('../config');

  // AC1's 80% floor is a property of a full event's worth of markup, not of
  // any page — against the repo's ordinary one-guest seed() fixture,
  // /gallery?view=user compresses only ~68% and AC1 fails on a correct
  // implementation. STORIES.extreme (scripts/seed-story.js:39) is the exact
  // dataset the issue measured its table against.
  const { seedEvent, EVENT_GUEST_TOKEN_PREFIX: prefix } = require('./helpers/event-fixture');
  EVENT_GUEST_TOKEN_PREFIX = prefix;
  seedEvent(loaded.db, { guests: 60, seed: 2, social: 'extreme', topTie: true, bugReports: true });
});

describe('#1012 AC1: /gallery?view=user is gzip-encoded and >= 80% smaller than its own uncompressed body', () => {
  it('saves at least 80% of the wire bytes', async () => {
    const agent = signInGuest(app, `${EVENT_GUEST_TOKEN_PREFIX}0`);

    const gzipRes = await raw(agent.get('/gallery?view=user').set('Accept-Encoding', 'gzip'));
    const identityRes = await raw(
      agent.get('/gallery?view=user').set('Accept-Encoding', 'identity')
    );

    expect(gzipRes.headers['content-encoding']).toBe('gzip');
    expect(identityRes.headers['content-encoding']).toBeUndefined();

    // The saving is measured on gzipRes's OWN bytes (its compressed length
    // vs its own decompressed length) rather than against identityRes above.
    // /gallery's withBadgeMoment (src/services/render-locals.js) pays one
    // owed badge celebration per render and mutates guest_badges as it
    // does, so two real requests to this route can legitimately render
    // different-length HTML (confirmed while writing this test — a second
    // identity-only fetch of the same URL, same agent, differed at the
    // celebrated badge's name). Decompressing gzipRes itself sidesteps that:
    // both numbers come from the one render that was actually gzip-encoded.
    // identityRes above is kept only to prove the identity path on this
    // route is genuinely uncompressed; AC2's static-asset test and AC3's
    // dedicated test are what prove gzip preserves content exactly.
    const decompressed = zlib.gunzipSync(gzipRes.body);
    const saving = 1 - gzipRes.body.length / decompressed.length;
    expect(saving).toBeGreaterThanOrEqual(0.8);
  });
});

describe('#1012 AC2: /css/base.css is gzip-encoded and >= 40% smaller than identity', () => {
  it('saves at least 40% of the wire bytes and decompresses to the identity body', async () => {
    const gzipRes = await raw(request(app).get('/css/base.css').set('Accept-Encoding', 'gzip'));
    const identityRes = await raw(
      request(app).get('/css/base.css').set('Accept-Encoding', 'identity')
    );

    expect(gzipRes.headers['content-encoding']).toBe('gzip');
    expect(identityRes.headers['content-encoding']).toBeUndefined();

    const saving = 1 - gzipRes.body.length / identityRes.body.length;
    expect(saving).toBeGreaterThanOrEqual(0.4);

    expect(zlib.gunzipSync(gzipRes.body).equals(identityRes.body)).toBe(true);
  });
});

describe('#1012 AC3: a plain (Accept-Encoding: identity) request is unaffected', () => {
  it('/login carries no Content-Encoding header and is byte-identical to the gzip response, decompressed', async () => {
    // /login (unlike AC1's /gallery) renders no per-guest, render-mutating
    // state — no badge-moment celebration to pay down, nothing to make two
    // requests diverge — so a real gzip-vs-identity byte comparison is sound
    // here, on a page neither AC1 nor AC2 touches. One agent for both calls
    // so the CSRF cookie minted on the first request is reused on the
    // second (csrf.js: "a returning guest/admin keeps the SAME token for
    // their whole session") — two different agents would each mint their
    // own token and legitimately render different bytes for a reason that
    // has nothing to do with compression.
    const agent = request.agent(app);
    const gzipRes = await raw(agent.get('/login').set('Accept-Encoding', 'gzip'));
    const identityRes = await raw(agent.get('/login').set('Accept-Encoding', 'identity'));

    expect(gzipRes.headers['content-encoding']).toBe('gzip');
    expect(identityRes.headers['content-encoding']).toBeUndefined();
    expect(identityRes.status).toBe(200);
    expect(identityRes.body.length).toBeGreaterThan(0);
    expect(zlib.gunzipSync(gzipRes.body).equals(identityRes.body)).toBe(true);
  });
});

describe('#1012: a real browser Accept-Encoding negotiates to brotli, not gzip', () => {
  it('GET /login with "gzip, deflate, br, zstd" gets Content-Encoding: br and round-trips to the identity body', async () => {
    // Every test above pins Accept-Encoding to the single token 'gzip', so
    // none of them exercise the branch a real request actually takes.
    // compression 1.8.1 prefers brotli over gzip whenever the node running
    // it has brotli support (node_modules/compression/index.js's
    // PREFERRED_ENCODING, true for every node version this repo targets —
    // see src/app.js section 3b), so a real browser's own multi-value
    // Accept-Encoding header (this exact string, from a real Chrome
    // request) negotiates to 'br', never 'gzip'. This is the encoding
    // production actually serves guests.
    const agent = request.agent(app);
    const brRes = await raw(agent.get('/login').set('Accept-Encoding', 'gzip, deflate, br, zstd'));
    const identityRes = await raw(agent.get('/login').set('Accept-Encoding', 'identity'));

    expect(brRes.headers['content-encoding']).toBe('br');
    expect(identityRes.headers['content-encoding']).toBeUndefined();
    expect(zlib.brotliDecompressSync(brRes.body).equals(identityRes.body)).toBe(true);
  });

  it('brotli beats gzip on css/base.css, which the library default quality would not', async () => {
    // Guards the one tunable src/app.js section 3b introduces. compression's
    // own brotli default is QUALITY 4, and at 4 this exact file ships 15,597
    // bytes against gzip level 6's 14,955 — i.e. deleting the explicit
    // quality from src/app.js makes a real browser's response LARGER than
    // the gzip figures this change was justified with, silently, with every
    // other test in this file still passing. At quality 6 it is 14,418.
    // Asserting br < gzip rather than an absolute size keeps this stable
    // across zlib builds while still failing the moment the quality is
    // dropped back to the default.
    const brRes = await raw(request(app).get('/css/base.css').set('Accept-Encoding', 'br'));
    const gzipRes = await raw(request(app).get('/css/base.css').set('Accept-Encoding', 'gzip'));

    expect(brRes.headers['content-encoding']).toBe('br');
    expect(gzipRes.headers['content-encoding']).toBe('gzip');
    expect(brRes.body.length).toBeLessThan(gzipRes.body.length);
  });
});

describe('#1012 AC4: an uploaded photo is served as-is, never gzip-encoded', () => {
  it('200s a real JPEG under UPLOADS_DIR with no Content-Encoding header', async () => {
    // seedEvent only writes database rows (its own header comment); the
    // photo bytes it references never land on disk. Requesting one of its
    // filenames unmodified gets a 404, whose absent Content-Encoding would
    // satisfy this assertion for the wrong reason — proving nothing about
    // AC4. A real file, under a name that passes photos/naming.js's
    // ORIGINAL_RE allowlist (blockTakenDownOriginal's stage-1 gate,
    // src/services/photos/moderation.js), is required so the request
    // actually reaches express.static and returns 200.
    const filename = 'abcdef0123456789-1800000000000.jpg';
    const sourceBytes = fs.readFileSync(
      path.join(config.ROOT, 'fixtures', 'sample-photos', 'sample-01.jpg')
    );
    fs.writeFileSync(path.join(config.UPLOADS_DIR, filename), sourceBytes);

    const res = await raw(
      request(app).get(`${config.UPLOADS_URL_BASE}/${filename}`).set('Accept-Encoding', 'gzip')
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('#1012 AC5: the keepsake ZIP export is not gzip-encoded and still opens', () => {
  it('GET /admin/export 200s an unencoded, readable ZIP', async () => {
    const adminAgent = await makeAdminAgent(app);

    const res = await raw(adminAgent.get('/admin/export').set('Accept-Encoding', 'gzip'));

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/zip');

    const entries = listZipEntries(res.body);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).toContain('summary.xlsx');
  }, 30000);
});
