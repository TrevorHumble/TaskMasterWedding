// tests/apply-branch-protection.test.js
// Vitest tests for apply-branch-protection.ps1: ACs 1-2 of #321, exercised via the
// -EmitPayload offline seam (no network call, no gh authentication needed).
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
  // AC1: base invocation emits five checks, each {context, app_id: -1}, under `checks`
  // (not `contexts`), with strict = true.
  it('AC1: -EmitPayload -> five checks, exact contexts, app_id -1, strict true, no "contexts" key', () => {
    const r = run();
    expect(r.status).toBe(0);

    const body = JSON.parse(r.stdout);
    const checks = body.required_status_checks.checks;
    expect(checks).toHaveLength(5);

    const sortedContexts = checks.map((c) => c.context).sort();
    expect(sortedContexts).toEqual([
      'Analyze (javascript)',
      'commit-gate-integrity',
      'lint',
      'merge-association',
      'test',
    ]);

    for (const check of checks) {
      expect(check.app_id).toBe(-1);
    }

    expect(body.required_status_checks.strict).toBe(true);
    expect(r.stdout).not.toContain('"contexts"');
  });

  // AC2: -RequireSmoke adds the sixth check, `smoke`, alongside the base five.
  it('AC2: -RequireSmoke -EmitPayload -> six checks including smoke', () => {
    const r = run(['-RequireSmoke']);
    expect(r.status).toBe(0);

    const body = JSON.parse(r.stdout);
    const checks = body.required_status_checks.checks;
    expect(checks).toHaveLength(6);

    const sortedContexts = checks.map((c) => c.context).sort();
    expect(sortedContexts).toEqual([
      'Analyze (javascript)',
      'commit-gate-integrity',
      'lint',
      'merge-association',
      'smoke',
      'test',
    ]);
  });
});
