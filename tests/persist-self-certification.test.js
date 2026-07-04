// tests/persist-self-certification.test.js
// Vitest tests for issue #203 — Fable full self-certification path.
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
const PERSIST_SELF_CERT = path.join(TOOLS_DIR, 'persist-self-certification.ps1');
const PERSIST_BIAS_GATE = path.join(TOOLS_DIR, 'persist-bias-gate.ps1');
const CHECK_ISSUE_REVIEWED = path.join(TOOLS_DIR, 'check-issue-reviewed.ps1');
const VALIDATE = path.join(TOOLS_DIR, 'validate-verdict.ps1');

const ISSUE_N = 203;

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping persist-self-certification tests`)
  : describe;

function runInDir(cwd, args) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
    cwd: cwd,
    encoding: 'utf8',
  });
  return {
    status: r.status === null ? 1 : r.status,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

function runPersistSelfCert(cwd, extraArgs) {
  return runInDir(cwd, [PERSIST_SELF_CERT].concat(extraArgs || []));
}

function runCheckIssueReviewed(cwd, issueReviewsRoot, required) {
  return runInDir(cwd, [
    CHECK_ISSUE_REVIEWED,
    '-IssueNumber',
    String(ISSUE_N),
    '-Required',
    String(required),
    '-IssueReviewsRoot',
    issueReviewsRoot,
  ]);
}

// Init a bare temp git repo (persist-self-certification.ps1 requires being
// inside a git repo to resolve its default roots via `git rev-parse --show-toplevel`).
function makeTempRepo(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  return tmp;
}

// Build a temp git repo with a staged system-level path (standards/), so
// Get-RequiredBar resolves to 2 without needing a -Required override.
function makeSystemLevelTree(prefix) {
  const tmp = makeTempRepo(prefix);
  fs.mkdirSync(path.join(tmp, 'standards'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'standards', 'adversarial-review-protocol.md'),
    '# system-level change\n'
  );
  execFileSync('git', ['-C', tmp, 'add', '-A'], { encoding: 'utf8' });
  const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();
  return { tmp, treeOid };
}

maybeDescribe('persist-self-certification (issue #203)', () => {
  // AC3/AC5 (issue mode): Count=2 writes fable-self-1..fable-self-2 with role
  // 'self-cert', verdict PASS, schema irev1 -- and satisfies Required=2 via the
  // existing Reduce-Verdicts distinct-id count.
  it('issue mode: Count=2 writes fable-self-1/2 and check-issue-reviewed -Required 2 exits 0', () => {
    const tmp = makeTempRepo('sc-issue2-');
    const issueReviewsRoot = path.join(tmp, '.review_state', 'issue-reviews');

    const result = runPersistSelfCert(tmp, [
      '-IssueNumber',
      String(ISSUE_N),
      '-Model',
      'fable',
      '-Count',
      '2',
      '-IssueReviewsRoot',
      issueReviewsRoot,
    ]);
    expect(result.status).toBe(0);

    const dir = path.join(issueReviewsRoot, String(ISSUE_N));
    const f1 = JSON.parse(fs.readFileSync(path.join(dir, 'fable-self-1.json'), 'utf8'));
    const f2 = JSON.parse(fs.readFileSync(path.join(dir, 'fable-self-2.json'), 'utf8'));
    expect(f1.schema).toBe('irev1');
    expect(f1.reviewer_id).toBe('fable-self-1');
    expect(f1.role).toBe('self-cert');
    expect(f1.verdict).toBe('PASS');
    expect(f1.issue_number).toBe(ISSUE_N);
    expect(f2.reviewer_id).toBe('fable-self-2');

    const checked = runCheckIssueReviewed(tmp, issueReviewsRoot, 2);
    expect(checked.status).toBe(0);
  });

  // Companion (from AC5 in the issue): Count=1 does NOT satisfy Required=2 -- this
  // is what makes the criterion able to catch a wrong (under-counting) implementation
  // (e.g. a bug that wrote all records under the same reviewer_id).
  it('issue mode: Count=1 does not satisfy check-issue-reviewed -Required 2 (exits 1)', () => {
    const tmp = makeTempRepo('sc-issue1-');
    const issueReviewsRoot = path.join(tmp, '.review_state', 'issue-reviews');

    const result = runPersistSelfCert(tmp, [
      '-IssueNumber',
      String(ISSUE_N),
      '-Model',
      'fable',
      '-Count',
      '1',
      '-IssueReviewsRoot',
      issueReviewsRoot,
    ]);
    expect(result.status).toBe(0);

    const checked = runCheckIssueReviewed(tmp, issueReviewsRoot, 2);
    expect(checked.status).toBe(1);
  });

  // Mutually exclusive mode guard: neither -IssueNumber nor -TreeOid -> exit 1.
  it('neither -IssueNumber nor -TreeOid given -> exits non-zero', () => {
    const tmp = makeTempRepo('sc-neither-');
    const result = runPersistSelfCert(tmp, ['-Count', '1']);
    expect(result.status).not.toBe(0);
  });

  // Mutually exclusive mode guard: both -IssueNumber and -TreeOid -> exit 1.
  it('both -IssueNumber and -TreeOid given -> exits non-zero', () => {
    const tmp = makeTempRepo('sc-both-');
    const result = runPersistSelfCert(tmp, [
      '-IssueNumber',
      String(ISSUE_N),
      '-TreeOid',
      'a'.repeat(40),
      '-Count',
      '1',
    ]);
    expect(result.status).not.toBe(0);
  });

  // Tree mode field-set check: schema rev1, role self-cert, verdict PASS,
  // reviewer_id fable-self-<i>, tree_oid bound.
  it('tree mode: writes rev1 evidence with role self-cert and PASS verdict', () => {
    const { tmp, treeOid } = makeSystemLevelTree('sc-tree-fields-');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const result = runPersistSelfCert(tmp, [
      '-TreeOid',
      treeOid,
      '-Model',
      'fable',
      '-Count',
      '2',
      '-ReviewsRoot',
      reviewsRoot,
    ]);
    expect(result.status).toBe(0);

    const dir = path.join(reviewsRoot, treeOid);
    const f1 = JSON.parse(fs.readFileSync(path.join(dir, 'fable-self-1.json'), 'utf8'));
    expect(f1.schema).toBe('rev1');
    expect(f1.role).toBe('self-cert');
    expect(f1.verdict).toBe('PASS');
    expect(f1.tree_oid).toBe(treeOid);
  });

  // AC4 (full flow): real git scratch repo, system-level path staged, no
  // -Tree/-Required override passed to validate-verdict.ps1 -- so the auto-bar
  // path runs (Get-RequiredBar derives Required=2 from the staged standards/ path)
  // and the bias gate auto-enforces. Self-cert records + a -SelfCertify bias-gate
  // artifact for that exact tree must make it exit 0.
  it('tree mode + auto-bar validate-verdict: self-cert records + -SelfCertify bias gate -> exit 0', () => {
    const { tmp, treeOid } = makeSystemLevelTree('sc-autobar-');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate');

    const certResult = runPersistSelfCert(tmp, [
      '-TreeOid',
      treeOid,
      '-Model',
      'fable',
      '-Count',
      '2',
      '-ReviewsRoot',
      reviewsRoot,
    ]);
    expect(certResult.status).toBe(0);

    const gateResult = runInDir(tmp, [
      PERSIST_BIAS_GATE,
      '-TreeOid',
      treeOid,
      '-SelfCertify',
      '-BiasGateRoot',
      biasGateRoot,
    ]);
    expect(gateResult.status).toBe(0);

    // No -Tree / -Required override: validate-verdict.ps1 reads the ambient
    // staged tree via `git diff --cached` from cwd=tmp, auto-derives Required=2,
    // and auto-enforces the bias gate since actualBar >= 2.
    const validateResult = runInDir(tmp, [
      VALIDATE,
      '-ReviewsRoot',
      reviewsRoot,
      '-BiasGateRoot',
      biasGateRoot,
    ]);
    expect(validateResult.status).toBe(0);
  });

  // Regression guard: without the -SelfCertify bias-gate artifact, self-cert
  // review records alone are not enough on a system-level tree under the
  // auto-bar path -- the bias gate must still fail closed.
  it('tree mode + auto-bar validate-verdict: self-cert reviews without bias-gate artifact -> blocked', () => {
    const { tmp, treeOid } = makeSystemLevelTree('sc-autobar-noBG-');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate'); // never created

    const certResult = runPersistSelfCert(tmp, [
      '-TreeOid',
      treeOid,
      '-Model',
      'fable',
      '-Count',
      '2',
      '-ReviewsRoot',
      reviewsRoot,
    ]);
    expect(certResult.status).toBe(0);

    const validateResult = runInDir(tmp, [
      VALIDATE,
      '-ReviewsRoot',
      reviewsRoot,
      '-BiasGateRoot',
      biasGateRoot,
    ]);
    expect(validateResult.status).not.toBe(0);
    expect(validateResult.stderr).toContain('bias-gate');
  });

  // -Model is locked to 'fable' via ValidateSet -- any other value must be rejected.
  it('-Model other than fable is rejected', () => {
    const tmp = makeTempRepo('sc-badmodel-');
    const r = spawnSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PERSIST_SELF_CERT,
        '-IssueNumber',
        String(ISSUE_N),
        '-Model',
        'opus',
        '-Count',
        '1',
      ],
      { cwd: tmp, encoding: 'utf8' }
    );
    const status = r.status === null ? 1 : r.status;
    expect(status).not.toBe(0);
  });
});

// persist-bias-gate.ps1 -SelfCertify field-set check, independent of validate-verdict.
describe('persist-bias-gate -SelfCertify (issue #203)', () => {
  const maybeIt = launcherMissing ? it.skip : it;

  maybeIt('writes a PASS bg1 artifact attributed to fable-self', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-biasgate-'));
    const treeOid = 'c'.repeat(40);
    const biasGateRoot = path.join(tmp, '.review_state', 'bias-gate');

    const r = spawnSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PERSIST_BIAS_GATE,
        '-TreeOid',
        treeOid,
        '-SelfCertify',
        '-BiasGateRoot',
        biasGateRoot,
      ],
      { encoding: 'utf8' }
    );
    expect(r.status).toBe(0);

    const f = JSON.parse(
      fs.readFileSync(path.join(biasGateRoot, treeOid, 'fable-self.json'), 'utf8')
    );
    expect(f.schema).toBe('bg1');
    expect(f.gate_id).toBe('fable-self');
    expect(f.verdict).toBe('PASS');
    expect(f.tree_oid).toBe(treeOid);
  });

  maybeIt('-SelfCertify combined with -GateId is rejected', () => {
    const treeOid = 'd'.repeat(40);
    const r = spawnSync(
      PS,
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PERSIST_BIAS_GATE,
        '-TreeOid',
        treeOid,
        '-SelfCertify',
        '-GateId',
        'g1',
      ],
      { encoding: 'utf8' }
    );
    const status = r.status === null ? 1 : r.status;
    expect(status).not.toBe(0);
  });
});
