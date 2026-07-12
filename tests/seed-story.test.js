// tests/seed-story.test.js
// Issue #450: scripts/seed-story.js seeds one of two named story datasets
// into a caller-chosen DATA_DIR.
//   AC5 — `--story normal` completes, prints "Story: normal", exit code 0.
//   AC6 — `--story extreme` completes, prints "Story: extreme", and every
//         submissions.photo_path/thumb_path exists under UPLOADS_DIR/THUMBS_DIR.
//   AC7 — .gitignore contains a data-stor*/ line and a data-demo/ line.
//
// REQUIRE ORDER: config / scripts/seed-story are required only AFTER
// loadApp() sets DATA_DIR / DB_PATH (see tests/helpers/testApp.js) —
// scripts/seed-story requires tests/helpers/event-fixture, which requires
// src/services/scoring, which requires src/db at module scope. Requiring it
// before DATA_DIR is set would open/create the WORKTREE'S OWN live
// data/app.db instead of an isolated temp dir (issue #313's guard catches
// exactly this).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadApp } = require('./helpers/testApp');

let config;
let seedStoryScript;
let Database;

beforeAll(() => {
  loadApp();
  config = require('../config');
  seedStoryScript = require('../scripts/seed-story');
  Database = require('better-sqlite3'); // driver only, never touches src/db
});

/**
 * Run `node scripts/seed-story.js --story <story>` in its own process against
 * a fresh temp DATA_DIR (same pattern tests/event-fixture.test.js's AC5/AC6
 * blocks use — DATA_DIR/DB_PATH are read once at require-time and cached, so
 * a genuinely separate directory needs a genuinely separate process).
 * @param {string} story
 * @returns {{ tmp: string, stdout: string }}
 */
function runStory(story) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `gpp-seed-story-${story}-`));
  const env = { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 'test.db') };
  const stdout = execFileSync('node', ['scripts/seed-story.js', '--story', story], {
    cwd: config.ROOT,
    env,
  }).toString();
  return { tmp, stdout };
}

describe('#450 AC5: --story normal completes and reports itself', () => {
  it('prints "Story: normal" (execFileSync throws on a non-zero exit)', () => {
    const { stdout } = runStory('normal');
    expect(stdout).toContain('Story: normal');
  }, 90000);
});

describe('#450 AC6: --story extreme installs every referenced photo/thumb on disk', () => {
  it('prints "Story: extreme" and every submissions row resolves to a real file', () => {
    const { tmp, stdout } = runStory('extreme');
    expect(stdout).toContain('Story: extreme');

    const dbPath = path.join(tmp, 'test.db');
    const storyDb = new Database(dbPath, { readonly: true });
    try {
      const rows = storyDb.prepare('SELECT photo_path, thumb_path FROM submissions').all();
      expect(rows.length).toBeGreaterThan(0);
      const uploadsDir = path.join(tmp, 'uploads');
      const thumbsDir = path.join(tmp, 'thumbs');
      for (const row of rows) {
        expect(fs.existsSync(path.join(uploadsDir, row.photo_path))).toBe(true);
        expect(fs.existsSync(path.join(thumbsDir, row.thumb_path))).toBe(true);
      }
    } finally {
      storyDb.close();
    }
  }, 120000);
});

describe('#450 AC7: .gitignore covers the story/demo data directories', () => {
  it('contains a data-stor*/ line and a data-demo/ line', () => {
    const text = fs.readFileSync(path.join(config.ROOT, '.gitignore'), 'utf8');
    expect(text).toMatch(/^data-stor\*\/$/m);
    expect(text).toMatch(/^data-demo\/$/m);
  });
});

describe('input validation', () => {
  it('parseArgs requires --story to be a known STORIES key', () => {
    expect(() => seedStoryScript.parseArgs([])).toThrow(/--story is required/);
    expect(() => seedStoryScript.parseArgs(['--story', 'nope'])).toThrow(/--story is required/);
    expect(seedStoryScript.parseArgs(['--story', 'normal'])).toEqual({
      story: 'normal',
      force: false,
    });
    expect(seedStoryScript.parseArgs(['--story', 'extreme', '--force'])).toEqual({
      story: 'extreme',
      force: true,
    });
  });

  it('the CLI exits non-zero on a missing --story without creating garbage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-seed-story-argv-'));
    const env = { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 'test.db') };

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('node', ['scripts/seed-story.js'], { cwd: config.ROOT, env });
    } catch (err) {
      exitCode = err.status;
      stderr = (err.stderr || Buffer.from('')).toString();
    }

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--story is required');
  }, 30000);
});
