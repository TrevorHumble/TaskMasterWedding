// tests/config-branches.test.js
// Issue #305 — branch coverage for config.js's env-override fallback arms:
// the .env loader loop, the COOKIE_SECRET "already set" arm, and
// resolveTrustProxy's four outcomes. Every other test file in this suite
// supplies COOKIE_SECRET/TRUST_PROXY indirectly (or not at all), so these
// arms sit untaken until exercised directly here.
//
// CACHE EVICTION, NOT vi.resetModules(): this project is CommonJS
// ("type": "commonjs" in package.json) and config.js is loaded via plain
// require(), not an ESM import. Empirically (see tests/hosting-lifecycle.test.js's
// reloadAppWithFreshConfig comment, and confirmed again for this file), vi.resetModules()
// resets vitest's own module graph but does NOT evict Node's require.cache for a
// plain require() — a second `require('../config')` after only vi.resetModules()
// still returns the SAME cached module object. The only reliable way to force a
// real re-execution of config.js (so it re-reads process.env) is to delete it
// from require.cache directly.
//
// Similarly, vi.doMock('fs', ...) does not intercept config.js's own
// `require('fs')` here (same CJS-vs-vite-node boundary), and a blanket
// vi.spyOn(fs, 'readFileSync').mockReturnValue(...) is actively dangerous: vite-node
// itself calls the real fs.readFileSync to read config.js's OWN source text before
// evaluating it, so a non-discriminating mock replaces config.js's source with the
// fake .env content and corrupts the entire module load (verified empirically —
// the resulting config object exports nothing sensible). The fix is to make the
// spy discriminate on the exact envPath argument and delegate every other call to
// the real implementation.
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = require.resolve('../config');
const ENV_PATH = path.join(path.resolve(__dirname, '..'), '.env');

/** Force the next `require('../config')` to re-execute the module from scratch. */
function reloadConfig() {
  delete require.cache[CONFIG_PATH];
  return require('../config');
}

describe('config.js env-override arms (issue #305)', () => {
  const savedEnv = {};
  const TRACKED_KEYS = ['COOKIE_SECRET', 'TRUST_PROXY'];

  beforeEach(() => {
    for (const key of TRACKED_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TRACKED_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    // Leave require.cache clean so the next test file's require('../config')
    // (or require('../src/app'), which requires config) sees the restored env.
    delete require.cache[CONFIG_PATH];
  });

  describe('COOKIE_SECRET (line 47 — "already set" arm)', () => {
    it('a non-empty COOKIE_SECRET env value is used verbatim, not the random-generate fallback', () => {
      process.env.COOKIE_SECRET = 'fixed-secret-value';
      const config = reloadConfig();
      // Real expected VALUE — if the fallback branch ran regardless (the
      // "already set" arm inverted), this would be a 64-char random hex string,
      // never equal to our literal.
      expect(config.COOKIE_SECRET).toBe('fixed-secret-value');
    });
  });

  describe('resolveTrustProxy (lines 81/82/84)', () => {
    it("TRUST_PROXY='true' -> 1 (the literal-string special case, never boolean true)", () => {
      process.env.TRUST_PROXY = 'true';
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(1);
    });

    it("TRUST_PROXY='3' -> 3 (parsed positive integer hop count)", () => {
      process.env.TRUST_PROXY = '3';
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(3);
    });

    it("TRUST_PROXY='0' -> false (parses to a non-positive integer)", () => {
      process.env.TRUST_PROXY = '0';
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(false);
    });

    it("TRUST_PROXY='garbage' -> false (not an integer)", () => {
      process.env.TRUST_PROXY = 'garbage';
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(false);
    });

    it("TRUST_PROXY='' (defined but empty/whitespace) -> false", () => {
      process.env.TRUST_PROXY = '   ';
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(false);
    });

    it('TRUST_PROXY unset -> false', () => {
      delete process.env.TRUST_PROXY;
      const config = reloadConfig();
      expect(config.TRUST_PROXY).toBe(false);
    });
  });
});

describe('config.js .env loader loop (lines 17-41, issue #305)', () => {
  // Real fs.existsSync / fs.readFileSync, captured before spying so the
  // discriminating mock can delegate every non-.env call back to them —
  // vite-node itself reads config.js's own source via the real fs.readFileSync,
  // so a blanket mock (no delegation) corrupts the module load entirely.
  const realExistsSync = fs.existsSync.bind(fs);
  const realReadFileSync = fs.readFileSync.bind(fs);

  // A single synthetic .env body exercising every arm in one pass:
  //   - a comment line (skipped, line 23's startsWith('#') arm)
  //   - a blank line (skipped, line 23's falsy-line arm)
  //   - a line with no '=' (skipped, line 25's eq === -1 arm)
  //   - a double-quoted value (quote-stripped, line 29/30's first disjunct)
  //   - a single-quoted value (quote-stripped, line 29/30's second disjunct)
  //   - an unquoted value (left as-is, both disjuncts false)
  //   - a key already present in process.env (line 35's guard: NOT overwritten)
  const SYNTHETIC_ENV = [
    '# a comment line, ignored',
    '',
    'NO_EQUALS_SIGN_ON_THIS_LINE',
    'CONFIG_TEST_DOUBLE_QUOTED="double quoted value"',
    "CONFIG_TEST_SINGLE_QUOTED='single quoted value'",
    'CONFIG_TEST_UNQUOTED=plain-value',
    'CONFIG_TEST_ALREADY_SET=value-from-dotenv',
  ].join('\n');

  const SYNTHETIC_KEYS = [
    'CONFIG_TEST_DOUBLE_QUOTED',
    'CONFIG_TEST_SINGLE_QUOTED',
    'CONFIG_TEST_UNQUOTED',
    'CONFIG_TEST_ALREADY_SET',
    'NO_EQUALS_SIGN_ON_THIS_LINE',
  ];

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[CONFIG_PATH];
    for (const key of SYNTHETIC_KEYS) {
      delete process.env[key];
    }
  });

  it('parses comments/blank/no-eq lines, strips quotes, and preserves an already-set key', () => {
    for (const key of SYNTHETIC_KEYS) delete process.env[key];
    // Line 35's guard ("!(key in process.env)") only skips a key that is
    // ALREADY present — set it here so the loop's copy is the thing under test.
    process.env.CONFIG_TEST_ALREADY_SET = 'original-value';

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
      if (p === ENV_PATH) return true;
      return realExistsSync(p);
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, enc) => {
      if (p === ENV_PATH) return SYNTHETIC_ENV;
      return realReadFileSync(p, enc);
    });

    reloadConfig();

    // Quote-stripping (both quote styles) — real observable VALUE, not just
    // "some string was set". Inverting the strip (e.g. leaving the quotes in)
    // would fail these two.
    expect(process.env.CONFIG_TEST_DOUBLE_QUOTED).toBe('double quoted value');
    expect(process.env.CONFIG_TEST_SINGLE_QUOTED).toBe('single quoted value');
    // Unquoted value copied verbatim (no stripping attempted).
    expect(process.env.CONFIG_TEST_UNQUOTED).toBe('plain-value');
    // The no-'=' line was skipped entirely: never became an env var.
    expect(process.env.NO_EQUALS_SIGN_ON_THIS_LINE).toBeUndefined();
    // The already-set key's ORIGINAL value survives — if the guard were
    // inverted (always overwrite), this would read 'value-from-dotenv'.
    expect(process.env.CONFIG_TEST_ALREADY_SET).toBe('original-value');
  });

  it('a missing .env file short-circuits the loop (real fs, no file on disk)', () => {
    // No spy at all here: the real envPath does not exist in this worktree,
    // so loadDotEnv's `if (!fs.existsSync(envPath)) return;` returns immediately
    // and none of the synthetic keys leak in. This is the inversion guard for
    // the test above: if the exists-check were removed, readFileSync would
    // throw ENOENT and config.js would crash on require.
    expect(realExistsSync(ENV_PATH)).toBe(false);
    expect(() => reloadConfig()).not.toThrow();
  });
});
