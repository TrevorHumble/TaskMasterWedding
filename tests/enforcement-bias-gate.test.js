// tests/enforcement-bias-gate.test.js
// Vitest tests for issue #47 AC2, AC3, AC5 — the bias-gate fail-closed behavior
// on system-level trees. Modeled on tests/verdict-gate.test.js.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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

const TOOLS_DIR = path.resolve(__dirname, '..', 'tools');
const VALIDATE = path.join(TOOLS_DIR, 'validate-verdict.ps1');

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping enforcement-bias-gate tests`)
  : describe;

function makeReviewEvidence(overrides, tree) {
  return Object.assign(
    {
      schema: 'rev1',
      reviewer_id: 'reviewer-a',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 0,
      tree_oid: tree,
      ts: new Date().toISOString(),
    },
    overrides
  );
}

function makeBiasGateEvidence(overrides, tree) {
  return Object.assign(
    {
      schema: 'bg1',
      gate_id: 'g1',
      verdict: 'PASS',
      tree_oid: tree,
      ts: new Date().toISOString(),
    },
    overrides
  );
}

// Build a temp git repo with a staged system-level path (tools/), so
// Get-RequiredBar resolves to 2 without needing a -Required override — this
// exercises the real end-to-end resolution path, not just the override.
function makeSystemLevelTree(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tools', 'new-gate.ps1'), '# system-level change\n');
  execFileSync('git', ['-C', tmp, 'add', '-A'], { encoding: 'utf8' });
  const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();
  return { tmp, treeOid };
}

function writeTwoPassReviews(tmp, treeOid) {
  const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
  const evDir = path.join(reviewsRoot, treeOid);
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(
    path.join(evDir, 'reviewer-a.json'),
    JSON.stringify(makeReviewEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }, treeOid))
  );
  fs.writeFileSync(
    path.join(evDir, 'reviewer-b.json'),
    JSON.stringify(makeReviewEvidence({ reviewer_id: 'reviewer-b', verdict: 'PASS' }, treeOid))
  );
  return reviewsRoot;
}

function writeBiasGate(tmp, treeOid, verdict) {
  const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate');
  const dir = path.join(biasGateRoot, treeOid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'g1.json'),
    JSON.stringify(makeBiasGateEvidence({ verdict: verdict }, treeOid))
  );
  return biasGateRoot;
}

function runValidate(tmp, treeOid, reviewsRoot, biasGateRoot) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    VALIDATE,
    '-Tree',
    treeOid,
    '-ReviewsRoot',
    reviewsRoot,
    '-BiasGateRoot',
    biasGateRoot,
  ];
  // Run from inside the temp repo so `git diff --cached` / Get-RequiredBar sees
  // the staged tools/ path and resolves Required = 2 on its own.
  const r = spawnSync(PS, args, { cwd: tmp, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

maybeDescribe('enforcement-bias-gate (issue #47)', () => {
  // AC2: system-level tree, two distinct PASS reviews, no bias-gate artifact
  // -> blocked, stderr contains "bias-gate". This would FAIL to catch a bug where
  // the bias-gate check is skipped or its message doesn't name the gate.
  it('AC2: system-level tree with reviews but no bias-gate -> blocked with "bias-gate" in stderr', () => {
    const { tmp, treeOid } = makeSystemLevelTree('bg-ac2-');
    const reviewsRoot = writeTwoPassReviews(tmp, treeOid);
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate'); // never created
    const result = runValidate(tmp, treeOid, reviewsRoot, biasGateRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bias-gate');
  });

  // AC3: same tree plus a PASS bias-gate artifact -> exit 0. This would FAIL if
  // adding the artifact did not unblock the tree (e.g. reader looking in the wrong dir).
  it('AC3: adding a PASS bias-gate artifact unblocks the same tree -> exit 0', () => {
    const { tmp, treeOid } = makeSystemLevelTree('bg-ac3-');
    const reviewsRoot = writeTwoPassReviews(tmp, treeOid);
    const biasGateRoot = writeBiasGate(tmp, treeOid, 'PASS');
    const result = runValidate(tmp, treeOid, reviewsRoot, biasGateRoot);
    expect(result.status).toBe(0);
  });

  // AC5: same tree but the bias-gate artifact is FAIL -> blocked (fail-wins), stderr
  // contains "bias-gate". This would FAIL if a FAIL bias-gate artifact were treated
  // as satisfying the gate (inverted logic).
  it('AC5: a FAIL bias-gate artifact blocks (fail-wins) -> non-zero exit with "bias-gate" in stderr', () => {
    const { tmp, treeOid } = makeSystemLevelTree('bg-ac5-');
    const reviewsRoot = writeTwoPassReviews(tmp, treeOid);
    const biasGateRoot = writeBiasGate(tmp, treeOid, 'FAIL');
    const result = runValidate(tmp, treeOid, reviewsRoot, biasGateRoot);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bias-gate');
  });

  // Regression guard: an explicit -Required override must skip the bias-gate check
  // entirely, even when the ambient cwd has a system-level path staged (which would
  // resolve Get-RequiredBar to 2 on the auto-bar path). Self-contained temp repo so
  // it is deterministic in CI (no reliance on what happens to be staged in the real
  // repo). Models makeSystemLevelTree, but drives validate-verdict with -Required 2
  // and writes NO bias-gate artifact -- if the override path still consulted ambient
  // staging and enforced the bias-gate, this would block (non-zero exit).
  it('explicit -Required override skips the bias-gate check -> exit 0', () => {
    const { tmp, treeOid } = makeSystemLevelTree('bg-override-');
    const reviewsRoot = writeTwoPassReviews(tmp, treeOid);
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate'); // never created
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      VALIDATE,
      '-Tree',
      treeOid,
      '-ReviewsRoot',
      reviewsRoot,
      '-BiasGateRoot',
      biasGateRoot,
      '-Required',
      '2',
    ];
    // cwd=tmp so the ambient staged index (if consulted) would resolve bar=2 --
    // proving the override path does NOT consult it.
    const result = spawnSync(PS, args, { cwd: tmp, encoding: 'utf8' });
    const status = result.status === null ? 1 : result.status;
    expect(status).toBe(0);
  });

  // AC4 regression check: a routine (non-system-level) tree with one PASS review and
  // no bias-gate artifact still passes -- the bias-gate check must not fire when
  // Get-RequiredBar resolves to 1.
  it('AC4: routine tree with 1 PASS review and no bias-gate artifact -> exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-ac4-'));
    execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
    execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], {
      encoding: 'utf8',
    });
    execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(tmp, 'app.js'), '// routine, non-system-level file\n');
    execFileSync('git', ['-C', tmp, 'add', '-A'], { encoding: 'utf8' });
    const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();

    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    const evDir = path.join(reviewsRoot, treeOid);
    fs.mkdirSync(evDir, { recursive: true });
    fs.writeFileSync(
      path.join(evDir, 'reviewer-a.json'),
      JSON.stringify(makeReviewEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }, treeOid))
    );
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate'); // never created

    const result = runValidate(tmp, treeOid, reviewsRoot, biasGateRoot);
    expect(result.status).toBe(0);
  });
});
