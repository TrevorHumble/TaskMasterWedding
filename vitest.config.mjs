import { defineConfig } from 'vitest/config';

// Coverage floors below are a RATCHET (#198): set at the measured values on
// main @ 485886a (2026-07-05) so the suite passes today and any regression
// fails the required CI `test` check. Raise them toward 80/80/80/80 as tests
// are added (tracked by #181). Never lower them.
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
      exclude: ['src/views/**', 'src/public/**', 'tests/**'],
      thresholds: { lines: 62, functions: 65, branches: 53, statements: 62 },
    },
  },
});
