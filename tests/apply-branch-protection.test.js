// tests/apply-branch-protection.test.js
// Vitest tests for apply-branch-protection.ps1, exercised via the -EmitPayload
// offline seam (no network call, no gh authentication needed).
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// One-time guard: if the launcher doesn't exist, skip all tests.
let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const SCRIPT = path.join(__dirname, '..', 'tools', 'apply-branch-protection.ps1');

function run(extraArgs) {
  return spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-EmitPayload'].concat(
      extraArgs || []
    ),
    { encoding: 'utf8' }
  );
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping apply-branch-protection tests`)
  : describe;

maybeDescribe('apply-branch-protection -EmitPayload', () => {
  // The baked-in required-check set is exactly lint, test, smoke,
  // Analyze (javascript) -- no switches, no proof-layer checks. The checks
  // that used to appear here are all retired; see CLAUDE.md § "Governance
  // freeze".
  it('-EmitPayload -> four checks, exact contexts, app_id -1, strict false, no "contexts" key', () => {
    const r = run();
    expect(r.status).toBe(0);

    const body = JSON.parse(r.stdout);
    const checks = body.required_status_checks.checks;
    expect(checks).toHaveLength(4);

    const sortedContexts = checks.map((c) => c.context).sort();
    expect(sortedContexts).toEqual(['Analyze (javascript)', 'lint', 'smoke', 'test']);

    for (const check of checks) {
      expect(check.app_id).toBe(-1);
    }

    expect(body.required_status_checks.strict).toBe(false);
    expect(r.stdout).not.toContain('"contexts"');
  });

  it('-EmitPayload -> required_approving_review_count 0, enforce_admins true, restrictions null', () => {
    const r = run();
    expect(r.status).toBe(0);

    const body = JSON.parse(r.stdout);
    expect(body.required_pull_request_reviews.required_approving_review_count).toBe(0);
    expect(body.enforce_admins).toBe(true);
    expect(r.stdout).toMatch(/"restrictions"\s*:\s*null/);
  });

  // The payload is stable across repeated invocations -- no switches means no
  // hidden state, so two runs must emit byte-identical checks.
  it('-EmitPayload is idempotent: two runs emit the same checks', () => {
    const first = run();
    const second = run();
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual(JSON.parse(second.stdout));
  });
});
