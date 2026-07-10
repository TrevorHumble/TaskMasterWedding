import { defineConfig } from 'vitest/config';

// Coverage floors below are a RATCHET (#198): set at the measured values on
// main @ 485886a (2026-07-05) so the suite passes today and any regression
// fails the required CI `test` check. The 80/80 lines/statements target of
// #181 is reached (measured 2026-07-08: statements 83.06%, lines 84%,
// branches 71.55%, functions 84.79%); branches/functions are set to that
// measurement rounded down. Floors only move up from here.
//
// #305 (2026-07-10): branch-coverage pass on guest-facing fallback arms
// (config.js, src/services/photos.js, src/routes/community.js,
// src/routes/guest.js) raised summary branches to 79.24% (802/1012),
// measured in this branch's own worktree before rebasing onto the other
// concurrently-landing coverage lanes. Floor set to floor(79.24) = 79 per
// AC3 — safe because the merged (post-rebase) summary can only be >= this
// branch's own measurement, never lower.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Mechanical guard (#313): fails the run if any test touches the live
    // data/app.db* files instead of an isolated temp DATA_DIR. No-ops
    // cleanly when those files don't exist yet (fresh checkout / CI).
    globalSetup: ['./tests/helpers/global-setup.js'],
    // Bounded retry absorbs transient pwsh-spawn flakes on CI (cold-start
    // contention can push a launcher past the default timeout) without
    // masking a genuine regression, which still fails every attempt. See #68.
    retry: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js', 'config.js', 'scripts/**/*.js'],
      // The four scripts below are process-level one-shot entrypoints: they
      // spawn/supervise a server, push to a git remote, or drive HTTP load
      // against a running instance. Unit tests would mock away everything
      // they actually do, so they are excluded from the coverage denominator
      // instead of padded with fake tests (#181). scripts/smoke.js still runs
      // in CI as its own gate — this only removes it from unit-coverage math.
      exclude: [
        'src/views/**',
        'src/public/**',
        'tests/**',
        'scripts/serve-resilient.js',
        'scripts/ledger-push.js',
        'scripts/loadtest.js',
        'scripts/smoke.js',
      ],
      thresholds: { lines: 80, functions: 84, branches: 79, statements: 80 },
    },
  },
});
