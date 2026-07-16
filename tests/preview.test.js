// tests/preview.test.js
// Issue #378 AC1/AC2 — scripts/preview.js: the seeded preview link works with
// real data, and it is throwaway/isolated (never touches a real DB or the
// default port).
//
// REQUIRE ORDER MATTERS (same rule as tests/helpers/testApp.js's loadApp()):
// requiring scripts/preview.js transitively requires ../config (via
// scripts/seed-story.js's unconditional top-level require), so DATA_DIR must
// be set BEFORE the first require in this file, or config.DATA_DIR/DB_PATH
// resolve to this worktree's real default data/ dir — exactly what AC2's
// "given a real database already at config.js's DATA_DIR" scenario needs to
// simulate with a throwaway stand-in instead.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const REAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-preview-realdir-'));
process.env.DATA_DIR = REAL_DIR;
process.env.DB_PATH = path.join(REAL_DIR, 'app.db');

const config = require('../config');
const { startPreview } = require('../scripts/preview');

const REPO_ROOT = path.join(__dirname, '..');
const PREVIEW_SCRIPT = path.join(REPO_ROOT, 'scripts', 'preview.js');

/** Sign in a fresh guest against a running preview and return its cookie header value. */
async function signIn(url) {
  const res = await fetch(`${url}/join`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({
      name: 'Preview Test Guest',
      contact: `preview-test-${Date.now()}@example.com`,
      pin: '1234',
    }),
  });
  const setCookie = res.headers.getSetCookie();
  return (setCookie || [])
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

describe('scripts/preview.js — AC1: the link works, with real data', () => {
  let preview;

  afterAll(async () => {
    if (preview) {
      await preview.stop();
      fs.rmSync(preview.dataDir, { recursive: true, force: true });
    }
  });

  it(
    'boots on a scratch dir, GET / returns 200, and /leaderboard shows >=2 distinct seeded ' +
      'guest names with a non-zero score',
    async () => {
      preview = await startPreview({ story: 'normal' });

      expect(preview.url).toMatch(/^http:\/\/localhost:\d+$/);

      // "an HTTP GET of it returns 200" — default fetch follows the
      // requireGuest redirect to /join for an anonymous visitor, landing on
      // a real 200 page either way.
      const rootRes = await fetch(preview.url);
      expect(rootRes.status).toBe(200);

      const cookie = await signIn(preview.url);
      expect(cookie).toContain('gsid=');

      const lbRes = await fetch(`${preview.url}/leaderboard`, { headers: { cookie } });
      expect(lbRes.status).toBe(200);
      const html = await lbRes.text();

      const names = new Set();
      for (const m of html.matchAll(/class="lb-name">([^<]+)</g)) {
        names.add(m[1].trim());
      }
      expect(names.size).toBeGreaterThanOrEqual(2);

      const points = [...html.matchAll(/<strong>(\d+)<\/strong>/g)].map((m) => Number(m[1]));
      expect(points.some((p) => p > 0)).toBe(true);
    },
    30000
  );
});

describe('scripts/preview.js — AC2: throwaway, isolated, no collision', () => {
  it(
    'uses a scratch dir and a different port than a real DB/PORT already in use, and never ' +
      "touches the real DB file's mtime or size",
    async () => {
      // "a real database already at config.js's DATA_DIR" — simulated with
      // REAL_DIR (this test file's own config resolution, set up above
      // before any require). Create it via the real schema-creating module,
      // the same way any real boot would.
      const { db: realDb } = require('../src/db');
      realDb.close();

      const before = fs.statSync(config.DB_PATH);

      // "the app already bound to its default PORT" — actually bind it so a
      // collision would be observable, not merely assumed.
      const dummy = net.createServer();
      await new Promise((resolve, reject) => {
        dummy.on('error', reject);
        dummy.listen(config.PORT, resolve);
      });

      let preview;
      try {
        preview = await startPreview({ story: 'normal' });

        expect(preview.dataDir).not.toBe(config.DATA_DIR);
        expect(preview.port).not.toBe(config.PORT);

        const res = await fetch(preview.url);
        expect(res.status).toBe(200);

        const after = fs.statSync(config.DB_PATH);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.size).toBe(before.size);
      } finally {
        if (preview) {
          await preview.stop();
          fs.rmSync(preview.dataDir, { recursive: true, force: true });
        }
        await new Promise((resolve) => dummy.close(resolve));
      }
    },
    30000
  );
});

describe('scripts/preview.js — AC1 CLI: prints exactly one URL line', () => {
  it('stdout carries exactly one http://localhost:<port> line and nothing else', async () => {
    const child = spawn(process.execPath, [PREVIEW_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const urlLine = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 25000;
      const check = () => {
        const m = stdout.match(/^http:\/\/localhost:\d+$/m);
        if (m) return resolve(m[0]);
        if (child.exitCode !== null) {
          return reject(new Error(`preview.js exited early (code=${child.exitCode}): ${stderr}`));
        }
        if (Date.now() > deadline)
          return reject(new Error(`timed out waiting for URL line: ${stderr}`));
        setTimeout(check, 200);
      };
      check();
    });
    expect(urlLine).toMatch(/^http:\/\/localhost:\d+$/);

    // Give any stray second line a moment to appear before asserting there
    // is exactly one.
    await new Promise((r) => setTimeout(r, 500));
    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines).toEqual([urlLine]);

    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }, 30000);
});
