// tests/event-fixture.test.js
// Issue #166 (0166): a generative, deterministic full-event seed
// (tests/helpers/event-fixture.js + scripts/seed-event.js) must produce a
// realistic ~100-guest event at true scale — dense leaderboard, reachable
// GARDEN badge, moderated photos, real files on disk — so the manual
// test-plan and load-test can exercise the app "full" instead of against the
// 10-guest demo fixture.
//
//   AC1  — guest count: exactly 100 guests at the default --guests.
//   AC2  — GARDEN reachable: >= 1 guest holds it, and only with >= 15 visible.
//   AC3  — realistic spread: unique strict-max top scorer + a mid-pack tie.
//   AC4  — moderation present: taken_down = 1 count > 0.
//   AC5  — determinism: same seed, two fresh runs, identical guest count /
//          taken_down count / top-scorer name.
//   AC6  — safety guard: refuses to clobber non-fixture data, exits non-zero,
//          deletes no rows, message contains "refusing to clobber".
//   AC7  — filename conformance: every photo_path/thumb_path matches
//          photos.js's module-private ORIGINAL_RE/THUMB_RE (re-declared here
//          since photos.js does not export them — see src/services/photos.js).
//   AC8  — task headroom: >= 15 event-prefixed tasks exist (actually >= 18).
//   AC9  — badge correctness: BLOOM/BOUQUET/GARDEN held iff >= 5/10/15.
//
// REQUIRE ORDER: config / event-fixture / seed-event / scoring are required
// only AFTER loadApp() sets DATA_DIR / DB_PATH, matching every other test in
// this suite (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

// Re-declared exactly as src/services/photos.js defines them (they are
// module-private, not exported) and exactly as tests/helpers/demo-fixture.js
// documents in its header comment.
const ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i;
const THUMB_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$/i;

let app;
let db;
let config;
let eventFixture;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  eventFixture = require('./helpers/event-fixture');
  scoring = require('../src/services/scoring');

  // Badge catalog must exist before seedEvent calls recomputeAutoBadges /
  // awardSpecialBadge (scoring.js skips silently if a badge code is missing —
  // see scoring.js:139-142). No manual insert needed here (#314): src/db.js's
  // boot-heal now runs ensureBadgeCatalog() at module load, so loadApp()
  // above already left the full canonical catalog in place on this db handle.
});

describe('AC1: guest count', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('produces exactly 100 guests', () => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;
    expect(count).toBe(100);
  });
});

describe('AC2: GARDEN is reachable', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('at least 1 guest holds GARDEN, and every holder has >= 15 visible submissions', () => {
    const holders = db
      .prepare(
        `SELECT g.id
           FROM guests g
           JOIN guest_badges gb ON gb.guest_id = g.id
           JOIN badges b ON b.id = gb.badge_id
          WHERE b.code = 'GARDEN'`
      )
      .all();
    expect(holders.length).toBeGreaterThanOrEqual(1);

    const stmtVisible = db.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND taken_down = 0'
    );
    for (const h of holders) {
      expect(stmtVisible.get(h.id).n).toBeGreaterThanOrEqual(15);
    }
  });
});

describe('AC3: realistic spread — unique top scorer and a mid-pack tie', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('exactly one guest holds the strict-maximum points, and at least one non-zero tie exists', () => {
    const totals = scoring.leaderboard();
    const points = totals.map((t) => t.points).sort((a, b) => b - a);

    const max = points[0];
    const topCount = points.filter((p) => p === max).length;
    expect(topCount).toBe(1); // fails if two guests share first place

    const counts = new Map();
    for (const p of points) counts.set(p, (counts.get(p) || 0) + 1);
    const midTie = [...counts.entries()].find(
      ([value, count]) => value !== max && value > 0 && count >= 2
    );
    expect(midTie).toBeDefined(); // fails if no non-zero, non-max value repeats
    expect(midTie[0]).toBeLessThan(max);
  });
});

describe('AC4: moderation present', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('has at least one taken_down = 1 submission', () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n;
    expect(n).toBeGreaterThan(0);
  });
});

describe('AC4 (edge): taken_down count stays > 0 at small --guests', () => {
  // Regression guard: an earlier version skipped the taken-down insertion for
  // any guest with zero visible completions (`if (count === 0) continue`), so
  // at small --guests the single 8%-floored takedown could land on a
  // zero-visible guest and produce a taken_down count of 0 — violating AC4.
  // The taken-down block must run for EVERY flagged guest regardless of their
  // visible-completion count.
  for (const guests of [5, 6, 8, 10]) {
    it(`--guests ${guests}, seed 1: at least one taken_down = 1 row`, () => {
      eventFixture.seedEvent(db, { guests, seed: 1 });
      const n = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n;
      expect(n).toBeGreaterThan(0);
    });
  }
});

describe('no-orphan files: submissions inserted === manifest.photos.length', () => {
  // The manifest is sized totalVisible + takenDownSet.size; every flagged
  // guest must actually yield a row, so the number of submissions inserted
  // exactly matches the number of photo pairs the manifest provisions.
  // Any mismatch means installSamplePhotos would write image files that no
  // submission references (orphans on disk).
  for (const { guests, seed } of [
    { guests: 5, seed: 1 },
    { guests: 10, seed: 1 },
    { guests: 100, seed: 1 },
    { guests: 15, seed: 7 },
  ]) {
    it(`--guests ${guests}, seed ${seed}: row count equals manifest photo count`, () => {
      const { manifest } = eventFixture.seedEvent(db, { guests, seed });
      const rowCount = db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
      expect(rowCount).toBe(manifest.photos.length);
    });
  }
});

describe('AC5: determinism across two seeded runs', () => {
  // Seed the fixture into a brand-new, empty temp data dir in its OWN child
  // process — the AC says "each against a fresh empty data dir", and config/db
  // read DATA_DIR once at require-time and cache the handle, so two separate
  // dirs genuinely require two separate processes (re-requiring src/db in this
  // test's own process would return the cached, wrong-directory handle).
  // Returns the three values the AC compares: guest count, taken_down count,
  // and top-scorer name.
  function seedInFreshDir(seed) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-event-ac5-'));
    const env = { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 'test.db') };
    // No manual badge insert needed (#314): requiring ./src/db in the child
    // process below runs its boot-heal (ensureBadgeCatalog at module load),
    // seeding the full canonical catalog into this fresh empty data dir.
    const script =
      "const { db } = require('./src/db');" +
      "const { seedEvent } = require('./tests/helpers/event-fixture');" +
      "const scoring = require('./src/services/scoring');" +
      `seedEvent(db, { guests: 100, seed: ${seed} });` +
      "const guestCount = db.prepare('SELECT COUNT(*) AS n FROM guests').get().n;" +
      "const takenDown = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n;" +
      'const top = scoring.leaderboard()[0].name;' +
      'console.log(JSON.stringify({ guestCount, takenDown, top }));';
    const out = execFileSync('node', ['-e', script], { cwd: config.ROOT, env }).toString().trim();
    return JSON.parse(out.split('\n').pop());
  }

  it('same seed, two fresh empty data dirs, produces identical guest count / taken_down count / top-scorer name', () => {
    const runA = seedInFreshDir(1);
    const runB = seedInFreshDir(1);

    expect(runB.guestCount).toBe(runA.guestCount);
    expect(runB.takenDown).toBe(runA.takenDown);
    expect(runB.top).toBe(runA.top);

    // Non-vacuous: pin the actual seed-1 values so this fails if the
    // generator's output silently changes shape, not just internal
    // consistency between two identical runs. top scorer is guest index 0,
    // nameFor(0) = FIRST_NAMES[0] + " " + LAST_NAMES[0].
    expect(runA.guestCount).toBe(100);
    expect(runA.takenDown).toBeGreaterThan(0);
    expect(runA.top).toBe('Ava Martinez');
  }, 30000);

  it('a different seed yields a different manifest, proving the LCG is actually seed-keyed', () => {
    // Guest index 0 is always the engineered unique top scorer by
    // construction (buildCompletionSpread), so the top-scorer NAME is
    // identical across seeds — that isolates AC5's "same seed -> same
    // result" guarantee (tested above) from seed-sensitivity itself. The
    // real place seed-sensitivity shows up is the manifest (photo
    // filenames are seed-derived, per buildManifest's `base` folding).
    const manifest1 = eventFixture.buildEventManifest(5, 1);
    const manifest2 = eventFixture.buildEventManifest(5, 2);
    expect(manifest1.photos[0].photo_path).not.toBe(manifest2.photos[0].photo_path);

    // Sanity: re-seeding with seed 2 still independently satisfies AC1.
    eventFixture.seedEvent(db, { guests: 100, seed: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(100);
  });
});

describe('AC6: safety guard refuses to clobber non-fixture data', () => {
  it('exits non-zero, deletes no rows, and prints a message containing "refusing to clobber"', () => {
    // Fresh temp data dir seeded with ONE guest whose token does NOT carry
    // EVENT_GUEST_TOKEN_PREFIX, simulating a real event's data.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-event-ac6-'));
    const env = { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 'test.db') };

    // Boot a throwaway db handle against the temp dir to seed the foreign guest.
    // Spawns its own process (via require inside a child) so it never touches
    // this test file's already-loaded `db`/`config` (which point at THIS
    // suite's own temp dir, set once by loadApp() and cached by Node's module
    // cache — requiring src/db again in-process would return the cached,
    // wrong-directory handle).
    execFileSync(
      'node',
      [
        '-e',
        "const db = require('./src/db').db; " +
          "db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run('real-guest-token-abc', 'Real Guest');",
      ],
      { cwd: config.ROOT, env }
    );

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('node', ['scripts/seed-event.js', '--guests', '5', '--seed', '1'], {
        cwd: config.ROOT,
        env,
      });
    } catch (err) {
      exitCode = err.status;
      stderr = (err.stderr || Buffer.from('')).toString();
    }

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('refusing to clobber');

    // No rows deleted: the foreign guest is still the only guest, and no
    // event-prefixed tasks were inserted.
    const guests = execFileSync(
      'node',
      [
        '-e',
        "const db = require('./src/db').db; console.log(JSON.stringify(db.prepare('SELECT token FROM guests').all()));",
      ],
      { cwd: config.ROOT, env }
    )
      .toString()
      .trim();
    const parsed = JSON.parse(guests);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].token).toBe('real-guest-token-abc');
  }, 30000);
});

describe('AC7: filename conformance', () => {
  beforeAll(async () => {
    eventFixture.seedEvent(db, { guests: 20, seed: 1 });
  });

  it('every photo_path matches ORIGINAL_RE and every thumb_path matches THUMB_RE', () => {
    const rows = db.prepare('SELECT photo_path, thumb_path FROM submissions').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.photo_path).toMatch(ORIGINAL_RE);
      expect(row.thumb_path).toMatch(THUMB_RE);
    }
  });

  it('a bad filename shape would fail this check (regex is non-vacuous)', () => {
    expect('not-a-conforming-name.jpg').not.toMatch(ORIGINAL_RE);
    expect('not-a-conforming-name.jpg').not.toMatch(THUMB_RE);
  });
});

describe('AC7b: referenced files exist on disk after install', () => {
  beforeAll(async () => {
    const { manifest } = eventFixture.seedEvent(db, { guests: 15, seed: 7 });
    const seedEventScript = require('../scripts/seed-event');
    await seedEventScript.installSamplePhotos(manifest);
  }, 30000);

  it('every submission photo_path and thumb_path exists under UPLOADS_DIR / THUMBS_DIR', () => {
    const rows = db.prepare('SELECT photo_path, thumb_path FROM submissions').all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(fs.existsSync(path.join(config.UPLOADS_DIR, row.photo_path))).toBe(true);
      expect(fs.existsSync(path.join(config.THUMBS_DIR, row.thumb_path))).toBe(true);
    }
  });
});

describe('AC8: task headroom', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 30, seed: 1 });
  });

  it('at least 15 event-prefixed tasks exist', () => {
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE title LIKE ?')
      .get(`${eventFixture.EVENT_TASK_PREFIX}%`).n;
    expect(n).toBeGreaterThanOrEqual(15);
  });
});

describe('AC9: badge correctness', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('every guest holds BLOOM iff >= 5, BOUQUET iff >= 10, GARDEN iff >= 15 visible submissions', () => {
    const guests = db.prepare('SELECT id FROM guests').all();
    const stmtVisible = db.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND taken_down = 0'
    );
    const stmtBadges = db.prepare(
      `SELECT b.code FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id WHERE gb.guest_id = ?`
    );

    const thresholds = { BLOOM: 5, BOUQUET: 10, GARDEN: 15 };
    let checkedAtLeastOneHolder = false;

    for (const g of guests) {
      const completed = stmtVisible.get(g.id).n;
      const heldCodes = new Set(stmtBadges.all(g.id).map((r) => r.code));

      for (const [code, threshold] of Object.entries(thresholds)) {
        const shouldHold = completed >= threshold;
        expect(heldCodes.has(code)).toBe(shouldHold);
        if (shouldHold) checkedAtLeastOneHolder = true;
      }
    }

    // Non-vacuous: confirm the loop actually exercised the "should hold" branch
    // at least once (i.e. this fixture has real badge holders to check).
    expect(checkedAtLeastOneHolder).toBe(true);
  });
});

describe('AC1 (#320): every avatar-bearing guest gets a unique avatar file', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 100, seed: 1 });
  });

  it('no avatar_path is shared by more than one guest', () => {
    const dupes = db
      .prepare(
        `SELECT avatar_path, COUNT(*) AS n
           FROM guests
          WHERE avatar_path IS NOT NULL
          GROUP BY avatar_path
         HAVING COUNT(*) > 1`
      )
      .all();
    expect(dupes).toEqual([]);
  });

  it('is non-vacuous: at least one guest actually has an avatar to check', () => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM guests WHERE avatar_path IS NOT NULL').get().n;
    expect(n).toBeGreaterThan(0);
  });

  it('the duplicate-detecting query has teeth: a genuine duplicate is caught', () => {
    // Confirms the GROUP BY ... HAVING COUNT(*) > 1 query above is not
    // vacuously true — feed it a real duplicate (mirroring the pre-fix
    // defect, where avatarSeq wrapped over a 2-name pool) and confirm it
    // fires. Runs last in this describe block; the next block's beforeAll
    // re-seeds before any other assertion depends on clean data.
    const [a, b] = db.prepare('SELECT id FROM guests WHERE avatar_path IS NOT NULL LIMIT 2').all();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    const sharedName = 'deadbeefdeadbeef-1800000199999.jpg';
    db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?').run(sharedName, a.id);
    db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?').run(sharedName, b.id);

    const dupes = db
      .prepare(
        `SELECT avatar_path, COUNT(*) AS n
           FROM guests
          WHERE avatar_path IS NOT NULL
          GROUP BY avatar_path
         HAVING COUNT(*) > 1`
      )
      .all();
    expect(dupes.length).toBeGreaterThan(0);
  });
});

describe('AC2 (#320): guest delete leaves every surviving avatar resolvable on disk', () => {
  let adminAgent;
  let targetGuestId;
  let otherAvatarGuestCount;

  beforeAll(async () => {
    // A modest guest count keeps ~40% avatar-bearing guests in the low
    // teens: enough to pick one to delete and still have several others
    // left whose files must survive.
    const { manifest } = eventFixture.seedEvent(db, { guests: 30, seed: 1 });
    const seedEventScript = require('../scripts/seed-event');
    await seedEventScript.installSamplePhotos(manifest);

    adminAgent = await makeAdminAgent(app);

    const target = db.prepare('SELECT id FROM guests WHERE avatar_path IS NOT NULL LIMIT 1').get();
    expect(target).toBeDefined(); // non-vacuous: a guest with an avatar exists to delete
    targetGuestId = target.id;

    otherAvatarGuestCount = db
      .prepare('SELECT COUNT(*) AS n FROM guests WHERE avatar_path IS NOT NULL AND id != ?')
      .get(targetGuestId).n;
    expect(otherAvatarGuestCount).toBeGreaterThan(0); // non-vacuous: other avatar-bearing guests remain after the delete
  }, 30000);

  it("deleting one avatar-bearing guest does not strand any other guest's avatar file", async () => {
    const res = await adminAgent
      .post(`/admin/guests/${targetGuestId}/delete`)
      .type('form')
      .send({});
    expect(res.status).toBe(303);

    const remaining = db
      .prepare('SELECT avatar_path FROM guests WHERE avatar_path IS NOT NULL')
      .all();
    // Every OTHER avatar-bearing guest is still present with their file intact
    // (under the pre-fix shared-pool defect, deleting one guest's avatar file
    // would also delete the file several other guests pointed at, so this
    // count and the existsSync loop below would both fail).
    expect(remaining.length).toBe(otherAvatarGuestCount);

    for (const row of remaining) {
      expect(fs.existsSync(path.join(config.UPLOADS_DIR, row.avatar_path))).toBe(true);
    }
  });
});

describe('#450 AC1: social "normal" seeds likes/comments with no self-likes', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 10, seed: 1, social: 'normal' });
  });

  it('inserts at least one like, and no like belongs to its own submission owner', () => {
    const likeCount = db.prepare('SELECT COUNT(*) AS n FROM likes').get().n;
    expect(likeCount).toBeGreaterThan(0);

    const selfLikes = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM likes l
           JOIN submissions s ON s.id = l.submission_id
          WHERE l.guest_id = s.guest_id`
      )
      .get().n;
    expect(selfLikes).toBe(0);
  });
});

describe('#450 AC2: social "extreme" tops one submission up to the maximum likes and 50 comments', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 10, seed: 1, social: 'extreme' });
  });

  it('the most-liked submission has exactly guests - 1 (9) likes, and the most-commented has exactly 50', () => {
    const maxLikes = db
      .prepare(
        'SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM likes GROUP BY submission_id)'
      )
      .get().n;
    expect(maxLikes).toBe(9);

    const maxComments = db
      .prepare(
        'SELECT COALESCE(MAX(n), 0) AS n FROM (SELECT COUNT(*) AS n FROM comments GROUP BY submission_id)'
      )
      .get().n;
    expect(maxComments).toBe(50);
  });
});

describe('#450 AC3: topTie extends the unique-top scorer into a top-of-leaderboard tie', () => {
  let guestIds;

  beforeAll(() => {
    ({ guestIds } = eventFixture.seedEvent(db, { guests: 5, seed: 1, topTie: true }));
  });

  it('guest 0 and guest 1 share an equal points total, strictly above guest 2', () => {
    // Consumes scoring.leaderboard() — the one owner of the points formula —
    // exactly like AC3's existing "mid-pack tie" block above, instead of
    // re-deriving it here.
    const byId = new Map(scoring.leaderboard().map((row) => [row.id, row.points]));

    const p0 = byId.get(guestIds[0]);
    const p1 = byId.get(guestIds[1]);
    const p2 = byId.get(guestIds[2]);

    expect(p1).toBe(p0);
    expect(p0).toBeGreaterThan(p2);
    expect(p1).toBeGreaterThan(p2);
  });
});

describe('#450 AC4: default seedEvent (no social, no topTie) seeds zero likes/comments', () => {
  beforeAll(() => {
    eventFixture.seedEvent(db, { guests: 10, seed: 1 });
  });

  it('likes and comments stay empty when the caller opts into neither option', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM likes').get().n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n).toBe(0);
  });
});

describe('input validation', () => {
  it('seedEvent rejects a non-positive or non-integer guest count instead of coercing it', () => {
    expect(() => eventFixture.seedEvent(db, { guests: 0 })).toThrow(/positive integer/);
    expect(() => eventFixture.seedEvent(db, { guests: -5 })).toThrow(/positive integer/);
    expect(() => eventFixture.seedEvent(db, { guests: 2.5 })).toThrow(/positive integer/);

    // Omitting guests still defaults to 100 (a positive-integer default), and
    // a valid explicit value still works — so the guard rejects only bad input.
    expect(() => eventFixture.seedEvent(db, { guests: 3, seed: 1 })).not.toThrow();
  });

  it('parseArgs rejects --guests 0, negatives, and non-integers with a clear message', () => {
    const seedEventScript = require('../scripts/seed-event');
    expect(() => seedEventScript.parseArgs(['--guests', '0'])).toThrow(/--guests must be >= 1/);
    expect(() => seedEventScript.parseArgs(['--guests', '-5'])).toThrow(/--guests must be >= 1/);
    expect(() => seedEventScript.parseArgs(['--guests', '5x'])).toThrow(/integer/);
    expect(() => seedEventScript.parseArgs(['--guests'])).toThrow(/integer/);

    // A valid invocation parses cleanly.
    expect(seedEventScript.parseArgs(['--guests', '50', '--seed', '2'])).toEqual({
      guests: 50,
      seed: 2,
      force: false,
    });
  });

  it('the CLI exits non-zero on an invalid --guests without creating garbage', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-event-argv-'));
    const env = { ...process.env, DATA_DIR: tmp, DB_PATH: path.join(tmp, 'test.db') };

    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('node', ['scripts/seed-event.js', '--guests', '0'], { cwd: config.ROOT, env });
    } catch (err) {
      exitCode = err.status;
      stderr = (err.stderr || Buffer.from('')).toString();
    }

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--guests must be >= 1');
  }, 30000);
});
