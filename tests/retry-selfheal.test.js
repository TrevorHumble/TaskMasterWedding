// tests/retry-selfheal.test.js
// Proof that vitest.config.mjs's test.retry (#68) actually self-heals a
// transient first-attempt failure instead of just being present but inert.
//
// Vitest retries re-invoke the test callback without reloading the module,
// so a module-scoped counter persists across retries within one run and
// resets on the next `npm test` invocation (fresh module load). That makes
// this test deterministic: attempt 1 always fails, attempt 2 always passes,
// on every run, with no shared state leaking across runs.
'use strict';

let attempts = 0;

describe('retry self-heal proof (#68)', () => {
  it('self-heals: fails first attempt, passes on retry', () => {
    attempts += 1;
    expect(
      attempts,
      'first attempt is expected to fail so retry can prove it self-heals'
    ).toBeGreaterThan(1);
  });
});
