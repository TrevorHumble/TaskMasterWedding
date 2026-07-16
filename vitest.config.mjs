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
    // Default testTimeout (#552). vitest's 5000ms default reddened the full
    // suite (tests/check-freshness.test.js: "Test timed out in 5000ms")
    // because a .ps1-spawning test's measured duration under the same
    // parallel load is ~5.1s (5137ms) against that 5000ms budget -- missed
    // by a hair, not by an order of magnitude. Set to 30000 rather than to
    // something nearer that measurement because Linux CI's `pwsh` cold start
    // is much slower than this Windows one (tests/review-runner.test.js:19-21),
    // so 5137ms is a lower bound on CI, not an estimate of it; 30000 is also
    // the smallest value the .ps1-spawning tests already chose for this same
    // cold-start problem, so it is this tree's settled answer rather than a
    // new guess. This is a DEFAULT, not a floor: any per-test third-argument
    // timeout still wins, whether larger (tests/event-mode.test.js: 120000)
    // or smaller (tests/login-lockout-releases.test.js:51: 10000).
    testTimeout: 30000,
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
        // heic-worker.js runs in a worker_threads thread (#281). The main-process
        // v8 coverage provider cannot instrument another thread's execution, so
        // it always reports 0% here even though the HEIC conversion tests drive
        // real decodes through it end-to-end. Same rationale as the process-level
        // scripts above — exclude from the coverage denominator rather than pad
        // with fake tests; the worker's behavior is gated by the integration tests.
        'src/services/heic-worker.js',
        // check-review-artifact.js (#48) is a CI status-check CLI: its tests spawn
        // it as a real `node` subprocess (tests/check-review-artifact.test.js drives
        // every AC1–AC4 path plus the governing-artifact drift-guard through
        // spawnSync), which the main-process v8 provider cannot instrument, so it
        // always reports 0% here. Same rationale as heic-worker and the process-
        // level scripts above — exclude from the coverage denominator rather than
        // pad with fake in-process tests; its behavior is gated end-to-end by those
        // subprocess tests and by the live `review-artifact-present` CI job.
        'scripts/check-review-artifact.js',
        // scripts/preview.js (#378) spawns the app as a CHILD process (by
        // design — see its own file header — so it never shares this test
        // process's config/db module cache with the app it boots). Its
        // pure helpers (parseArgs, getFreePort) run in-process and ARE
        // covered by tests/preview.test.js's assertions on startPreview()'s
        // return value; the child-process boot path itself cannot be
        // instrumented by the main-process v8 coverage provider, so the
        // whole file is excluded from the denominator rather than padded —
        // same rationale as heic-worker.js and the process-level scripts
        // above. Its behavior is gated end-to-end by tests/preview.test.js,
        // which drives it both via startPreview() and as a real subprocess.
        'scripts/preview.js',
      ],
      thresholds: { lines: 80, functions: 84, branches: 79, statements: 80 },
    },
  },
});
