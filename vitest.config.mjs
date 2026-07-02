import { defineConfig } from 'vitest/config';

// Coverage thresholds are intentionally NOT enforced yet: the real test suite
// lands in its own PR (see the test plan), which raises lines/functions/branches
// to 80%. Until then CI reports coverage as an artifact without gating on it.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Bounded retry absorbs transient pwsh-spawn flakes on CI (cold-start
    // contention can push a launcher past the default timeout) without
    // masking a genuine regression, which still fails every attempt. See #68.
    retry: 2,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js', 'config.js', 'scripts/**/*.js'],
      exclude: ['src/views/**', 'src/public/**', 'tests/**'],
      // thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
