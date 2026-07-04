// tests/helpers/event-fixture.js
//
// A generative, deterministic "full event" fixture: ~100 guests, >= 18 tasks,
// and a realistic completion spread (unique top scorer, mid-pack tie, many
// low scorers, some zero, one guest deep enough to reach GARDEN). Sibling of
// tests/helpers/demo-fixture.js (10 fixed guests / 6 tasks) but generated at
// wedding scale instead of hand-listed, so the manual test plan and the
// load-test can exercise the app "full" instead of against a 10-guest demo.
//
// Scope: this module writes ONLY database rows, exactly like demo-fixture.js.
// Installing real files on disk under the manifest's conforming names is
// scripts/seed-event.js's job (mirrors scripts/seed-demo.js's installOne /
// photos.makeThumb pattern).
//
// Determinism: every "random" choice in this file is drawn from a small
// linear congruential generator (LCG) seeded by the caller's `seed` option —
// never Math.random. The same {guests, seed} therefore always produces the
// same guest set, the same completion spread, and the same manifest.
//
// Filename convention: identical contract to demo-fixture.js (see its header
// comment) — submissions.photo_path / thumb_path (and guests.avatar_path)
// must match src/services/photos.js's module-private storage-filename
// allowlist:
//   ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i
//   THUMB_RE    = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$/i
// The MANIFEST below uses fixed (seed-derived, not random) 16-hex-char +
// numeric-stamp names so re-seeding with the same seed is idempotent and
// always matches whatever scripts/seed-event.js's installer wrote to disk.
'use strict';

const scoring = require('../../src/services/scoring');

// Event tasks carry this title prefix so seedEvent can find-and-delete
// exactly its own rows on every run without touching scripts/seed.js's real
// tasks (mirrors demo-fixture.js's DEMO_TASK_PREFIX).
const EVENT_TASK_PREFIX = 'Event: ';

// Guest tokens carry this prefix so scripts/seed-event.js's AC6 safety guard
// can tell "this looks like our own fixture data" apart from a real event's
// guests before it deletes anything (mirrors demo-fixture.js's per-guest
// `demo-guest-token-${index}` pattern, promoted to a named constant because
// seed-event.js's guard keys on it directly).
const EVENT_GUEST_TOKEN_PREFIX = 'event-guest-token-';

// >= 18 keeps margin above GARDEN's 15-task threshold (AC8) so a guest who
// completes nearly everything still clears it with room to spare.
const EVENT_TASKS = [
  `${EVENT_TASK_PREFIX}Snap the getaway car`,
  `${EVENT_TASK_PREFIX}Find the guestbook`,
  `${EVENT_TASK_PREFIX}Toast the newlyweds`,
  `${EVENT_TASK_PREFIX}Spot a pastel bowtie`,
  `${EVENT_TASK_PREFIX}Catch the bouquet toss`,
  `${EVENT_TASK_PREFIX}Photograph the dessert table`,
  `${EVENT_TASK_PREFIX}Find the flower crown`,
  `${EVENT_TASK_PREFIX}Photograph the string lights`,
  `${EVENT_TASK_PREFIX}Catch a slow dance`,
  `${EVENT_TASK_PREFIX}Spot the best man's toast`,
  `${EVENT_TASK_PREFIX}Photograph the cake cutting`,
  `${EVENT_TASK_PREFIX}Find a guest in heels on grass`,
  `${EVENT_TASK_PREFIX}Snap the ring exchange`,
  `${EVENT_TASK_PREFIX}Photograph the seating chart`,
  `${EVENT_TASK_PREFIX}Catch the first look`,
  `${EVENT_TASK_PREFIX}Find the oldest guest dancing`,
  `${EVENT_TASK_PREFIX}Photograph a candid laugh`,
  `${EVENT_TASK_PREFIX}Spot the wedding party group shot`,
  `${EVENT_TASK_PREFIX}Find the gift table`,
  `${EVENT_TASK_PREFIX}Photograph the sparkler send-off`,
];

// Bundled first/last name lists, combined deterministically by index so the
// generator never needs Math.random to produce a name. 25 x 25 = 625 unique
// combinations, comfortably above any realistic --guests value.
const FIRST_NAMES = [
  'Ava',
  'Liam',
  'Priya',
  'Noah',
  'Sofia',
  'Ethan',
  'Maya',
  'Jacob',
  'Isabella',
  'Owen',
  'Grace',
  'Mateo',
  'Chloe',
  'Elijah',
  'Zoe',
  'Lucas',
  'Harper',
  'Mason',
  'Layla',
  'Aiden',
  'Nora',
  'Caleb',
  'Aria',
  'Julian',
  'Ellie',
];
const LAST_NAMES = [
  'Martinez',
  'Chen',
  'Patel',
  'Thompson',
  'Rossi',
  'Wright',
  'Johnson',
  'Lee',
  'Garcia',
  'Bennett',
  'Nguyen',
  'Kowalski',
  'Osei',
  'Ferreira',
  'Haddad',
  'Kim',
  'Novak',
  'Ibrahim',
  'Sato',
  'Reyes',
  'Larsen',
  'Adeyemi',
  'Petrov',
  'Dubois',
  'Singh',
];

// ---------------------------------------------------------------------------
// Deterministic LCG (linear congruential generator). Numerical Recipes
// constants — a common, well-tested choice for a small non-cryptographic PRNG.
// Never Math.random: the same seed must always produce the same sequence.
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let state = seed >>> 0 || 1; // avoid a zero state, which would stick at 0
  return function next() {
    // 32-bit LCG: state = (a*state + c) mod 2^32, normalized to [0, 1).
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Integer in [0, n). */
function rngInt(rng, n) {
  return Math.floor(rng() * n);
}

/** Pick a fractional slice's worth of items from [0, n) without repeats, via Fisher-Yates. */
function shuffledIndices(rng, n) {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function nameFor(index) {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  // Advance the last-name index by the number of times we've wrapped through
  // FIRST_NAMES so e.g. index 25 (wrap 1) doesn't repeat "Ava Martinez".
  const wrap = Math.floor(index / FIRST_NAMES.length);
  const last = LAST_NAMES[(index + wrap) % LAST_NAMES.length];
  return `${first} ${last}`;
}

// ---------------------------------------------------------------------------
// Manifest: deterministic {photo_path, thumb_path} pairs and avatar filenames,
// seed-derived so a re-run with the same seed always asks for the exact same
// filenames (idempotent), while a different seed produces a disjoint set.
// Same shape as demo-fixture.js's MANIFEST/thumbNameFor.
// ---------------------------------------------------------------------------
function thumbNameFor(originalName) {
  return `${originalName}.jpg`;
}

/**
 * Build a manifest of `count` conforming {photo_path, thumb_path} pairs plus
 * a small pool of avatar filenames, all derived from `seed` so the same seed
 * always yields the same filenames.
 *
 * @param {number} count - number of photo pairs needed (one per submission).
 * @param {number} seed
 * @returns {{ photos: Array<{photo_path: string, thumb_path: string}>, avatars: string[] }}
 */
function buildManifest(count, seed) {
  // 16 hex chars: seed and index folded together so different seeds produce
  // disjoint filenames (no cross-seed collisions when tests run seed 1 and
  // seed 2 back to back against the same disk).
  const base = (seed >>> 0).toString(16).padStart(8, '0');
  const photos = [];
  for (let i = 0; i < count; i++) {
    const hex = (base + i.toString(16).padStart(8, '0')).slice(0, 16);
    const stamp = 1800000000000 + i;
    const photo_path = `${hex}-${stamp}.jpg`;
    photos.push({ photo_path, thumb_path: thumbNameFor(photo_path) });
  }

  // A handful of avatar filenames, cycled across avatar-bearing guests
  // exactly like demo-fixture.js does with MANIFEST.avatars.
  const avatarBase = (seed >>> 0).toString(16).padStart(8, '0').split('').reverse().join('');
  const avatars = [0, 1].map((i) => {
    const hex = (avatarBase + i.toString(16).padStart(8, '0')).slice(0, 16);
    const stamp = 1800000100000 + i;
    return `${hex}-${stamp}.jpg`;
  });

  return { photos, avatars };
}

/**
 * Given N guests, build the per-guest engineered completion-count spread that
 * satisfies AC2/AC3/AC9:
 *   - guest 0 holds the unique strict-maximum completion count, >= 15 (so
 *     GARDEN — 15 completed — is reachable and unambiguous: AC2, AC9).
 *   - guests 1 and 2 share an equal, non-zero, non-max count (a mid-pack tie:
 *     AC3).
 *   - a run of guests (roughly the next third) get "many low" counts (1-4).
 *   - a run of guests get exactly 0 (some zero).
 *   - the remainder get varied counts, each strictly below guest 0's max so
 *     the unique-top property in AC3/AC5 always holds regardless of --guests.
 *
 * All counts are capped at `taskCount` (can't complete more tasks than exist).
 *
 * @param {number} n - guest count.
 * @param {number} taskCount - number of available event tasks.
 * @param {() => number} rng
 * @returns {number[]} counts[i] = how many visible submissions guest i gets.
 */
function buildCompletionSpread(n, taskCount, rng) {
  const counts = new Array(n).fill(0);
  if (n === 0) return counts;

  // Unique top: as many tasks as possible short of all of them, floored at 15
  // so GARDEN's threshold is cleared with margin even if taskCount is exactly 18.
  const topCount = Math.min(taskCount, Math.max(15, taskCount - 1));
  counts[0] = topCount;

  // Mid-pack tie: a fixed value well under the top and well above zero,
  // shared by guests 1 and 2 (if n is that small, the loop below still
  // leaves them tied since neither is touched again).
  const tieValue = Math.min(8, Math.max(1, topCount - 1));
  if (n > 1) counts[1] = tieValue;
  if (n > 2) counts[2] = tieValue;

  // Remaining guests (index 3..n-1): split into "many low" (1-4), "some
  // zero", and "varied but below top", in roughly a 45/20/35 split so the
  // leaderboard reads like a real party rather than a uniform grid.
  for (let i = 3; i < n; i++) {
    const bucket = rng();
    let count;
    if (bucket < 0.45) {
      count = 1 + rngInt(rng, 4); // 1-4
    } else if (bucket < 0.65) {
      count = 0;
    } else {
      // Varied, but strictly below topCount so guest 0 stays the unique max
      // no matter how the dice land.
      const ceiling = Math.max(1, topCount - 1);
      count = rngInt(rng, ceiling) + 1;
      if (count >= topCount) count = topCount - 1;
    }
    counts[i] = Math.min(count, taskCount);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Seeding.
// ---------------------------------------------------------------------------

/**
 * Clean-then-seed a realistic ~event-scale data set into `db`.
 *
 * Deletes (in order, inside one transaction): all submissions, all guests,
 * and any task whose title starts with EVENT_TASK_PREFIX — so scripts/seed.js's
 * real tasks/badges are left untouched, but re-running this against the same
 * {guests, seed} always produces the exact same rows.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ guests?: number, seed?: number }} [options]
 * @returns {{ taskIds: number[], guestIds: number[], manifest: object, guestNames: string[] }}
 */
function seedEvent(db, options = {}) {
  // Default when omitted/undefined, but a caller-supplied value must be a
  // positive integer: reject 0, negatives, and non-integers loudly rather
  // than silently coercing (e.g. `guests: 0` must NOT fall back to 100, and
  // `guests: -5` must NOT reach shuffledIndices and throw a raw RangeError).
  const guestCount = options.guests === undefined ? 100 : options.guests;
  if (!Number.isInteger(guestCount) || guestCount < 1) {
    throw new Error(
      `seedEvent: guests must be a positive integer, got ${JSON.stringify(options.guests)}`
    );
  }
  const seed = options.seed === undefined ? 1 : options.seed;
  if (!Number.isInteger(seed)) {
    throw new Error(`seedEvent: seed must be an integer, got ${JSON.stringify(options.seed)}`);
  }
  const rng = makeRng(seed);

  const completionCounts = buildCompletionSpread(guestCount, EVENT_TASKS.length, rng);
  const totalVisible = completionCounts.reduce((a, b) => a + b, 0);

  // A fraction of guests also get one extra taken-down submission, on a task
  // they have no visible submission for (mirrors demo-fixture.js's TAKEN_DOWN
  // modeling: a taken-down row never inflates a guest's visible/score count).
  // ~8% of guests, floored at 1 so AC4 (count > 0) holds even at small --guests.
  const takenDownGuestIdx = shuffledIndices(rng, guestCount).slice(
    0,
    Math.max(1, Math.round(guestCount * 0.08))
  );
  const takenDownSet = new Set(takenDownGuestIdx);

  const totalSubmissions = totalVisible + takenDownSet.size;
  const manifest = buildManifest(totalSubmissions, seed);

  // ~40% of guests get an avatar (AC-adjacent realism from the issue, not a
  // numbered AC): deterministic via rng, not index parity, so it interacts
  // with the shuffle above instead of always landing on the same guests.
  const avatarGuestIdx = new Set(
    shuffledIndices(rng, guestCount).slice(0, Math.round(guestCount * 0.4))
  );

  // A smaller fraction get non-empty social_links JSON.
  const socialGuestIdx = new Set(
    shuffledIndices(rng, guestCount).slice(0, Math.round(guestCount * 0.25))
  );
  const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok'];

  const run = db.transaction(() => {
    // --- Clean: submissions first (FK), then guests, then event-prefixed tasks. ---
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM guests').run();
    db.prepare(`DELETE FROM tasks WHERE title LIKE ?`).run(`${EVENT_TASK_PREFIX}%`);

    // --- Seed tasks. ---
    const insertTask = db.prepare(
      `INSERT INTO tasks (title, description, sort_order, is_active) VALUES (?, ?, ?, 1)`
    );
    const taskIds = EVENT_TASKS.map(
      (title, index) => insertTask.run(title, '', index).lastInsertRowid
    );

    // --- Seed guests. ---
    const insertGuest = db.prepare(
      `INSERT INTO guests (token, name, avatar_path, social_links, bonus_points, onboarded)
       VALUES (?, ?, ?, ?, ?, 1)`
    );
    let avatarSeq = 0;
    const guestNames = [];
    const guestIds = [];
    for (let i = 0; i < guestCount; i++) {
      const token = `${EVENT_GUEST_TOKEN_PREFIX}${i}`;
      const name = nameFor(i);
      guestNames.push(name);

      const avatarPath = avatarGuestIdx.has(i)
        ? manifest.avatars[avatarSeq++ % manifest.avatars.length]
        : null;

      const socialLinks = socialGuestIdx.has(i)
        ? JSON.stringify({
            [SOCIAL_PLATFORMS[i % SOCIAL_PLATFORMS.length]]: `@${name.split(' ')[0].toLowerCase()}`,
          })
        : '{}';

      // Varied bonus_points: 0 for most, a small admin-style nudge (1-3) for
      // roughly one in six guests, biased toward the front of the pack.
      // Guests 0-2 (the engineered unique top scorer and the mid-pack tie
      // pair) never get bonus points: a bonus on guest 0 could push another
      // guest's total POINTS past it (breaking AC3's unique-max guarantee
      // even though completion COUNTS were engineered correctly), and an
      // uneven bonus between guests 1 and 2 would break their engineered tie.
      // Every other guest's bonus is capped so completed + bonus stays
      // strictly below guest 0's completed count.
      let bonusPoints = 0;
      if (i > 2) {
        const wantsBonus = rng() < 0.17;
        if (wantsBonus) {
          // completionCounts[0] === topCount by construction (buildCompletionSpread
          // always sets the first guest's count to the engineered top value).
          const headroom = completionCounts[0] - 1 - completionCounts[i];
          if (headroom > 0) {
            bonusPoints = 1 + rngInt(rng, Math.min(3, headroom));
          }
        }
      }

      const id = insertGuest.run(token, name, avatarPath, socialLinks, bonusPoints).lastInsertRowid;
      guestIds.push(id);
    }

    // --- Seed submissions: for each guest, their engineered visible count of
    //     distinct tasks (in task order, wrapping is impossible since counts
    //     are capped at taskCount), then any taken-down extra on a task they
    //     have no visible submission for. Distinct created_at per row so
    //     ordering is deterministic. ---
    const insertSubmission = db.prepare(
      `INSERT INTO submissions
         (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`
    );

    let manifestIndex = 0;
    const baseTime = new Date('2026-08-07T18:00:00Z').getTime();
    function nextCreatedAt() {
      const ts = new Date(baseTime + manifestIndex * 60000); // +1 min per row
      return ts
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, '');
    }

    function insertOne(guestId, taskId, takenDown) {
      const pair = manifest.photos[manifestIndex];
      insertSubmission.run(
        guestId,
        taskId,
        pair.photo_path,
        pair.thumb_path,
        takenDown,
        nextCreatedAt()
      );
      manifestIndex += 1;
    }

    // Shuffle which tasks each guest's visible completions land on so the
    // gallery/leaderboard don't just show "everyone did tasks 0..k-1".
    // NOTE: the taken-down block runs for EVERY flagged guest, including
    // zero-visible ones — mirroring demo-fixture.js, where Owen (no visible
    // submissions) carries the taken-down rows. Skipping it for count === 0
    // would let AC4 (taken_down count > 0) fail at small --guests, since the
    // one guest the 8%-floored takedown lands on can easily be a zero-visible
    // guest.
    for (let i = 0; i < guestCount; i++) {
      const count = completionCounts[i];
      const taskOrder = count > 0 ? shuffledIndices(rng, EVENT_TASKS.length).slice(0, count) : [];
      for (const taskIndex of taskOrder) {
        insertOne(guestIds[i], taskIds[taskIndex], 0);
      }

      if (takenDownSet.has(i)) {
        // Pick a task this guest has no visible submission for, so the
        // taken-down row never collides with UNIQUE(guest_id, task_id) and
        // never inflates their visible/score count. A zero-visible guest has
        // every task available here, so `remaining` is never empty for them.
        const usedTasks = new Set(taskOrder);
        const remaining = EVENT_TASKS.map((_, idx) => idx).filter((idx) => !usedTasks.has(idx));
        if (remaining.length > 0) {
          const pick = remaining[rngInt(rng, remaining.length)];
          insertOne(guestIds[i], taskIds[pick], 1);
        }
      }
    }

    return { taskIds, guestIds, manifest, guestNames };
  });

  const result = run();

  // Recompute badges per guest from their actual visible-submission count,
  // exactly like a real submit/takedown would: the per-guest auto/metric pass
  // for each guest, then a single global transferable pass once all guests
  // exist (MOSTPHOTOS is a whole-population comparison, so it only needs to
  // run once at the end, not per guest). NEVER hand-insert guest_badges —
  // scoring.js owns that write path. (Callers that only seed the auto/special
  // catalog rows simply get the auto badges; the metric/transferable passes
  // skip any code whose catalog row is absent.)
  for (const guestId of result.guestIds) {
    scoring.recomputeBadges(guestId);
  }
  scoring.recomputeTransferableBadges();

  // Hand-award a handful of special badges (admin-style), spread deterministically.
  const SPECIAL_CODES = ['EARLYBIRD', 'SHUTTERBUG', 'CROWDFAV', 'CHOICE'];
  const specialRecipients = shuffledIndices(rng, guestCount).slice(
    0,
    Math.min(guestCount, SPECIAL_CODES.length * 2)
  );
  specialRecipients.forEach((guestIdx, i) => {
    const code = SPECIAL_CODES[i % SPECIAL_CODES.length];
    scoring.awardSpecialBadge(result.guestIds[guestIdx], code);
  });

  return result;
}

module.exports = {
  seedEvent,
  buildEventManifest: buildManifest,
  thumbNameFor,
  EVENT_TASK_PREFIX,
  EVENT_GUEST_TOKEN_PREFIX,
  EVENT_TASKS,
};
