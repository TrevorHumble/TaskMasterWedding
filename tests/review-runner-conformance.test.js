// tests/review-runner-conformance.test.js
// Issue #474 AC4: proves the JSON verdict block the PR-path reviewer charters
// (agents/reviewer-pr.md, agents/reviewer-design-philosophy.md) now instruct
// reviewers to emit is the exact shape tools/review-runner.ps1 consumes --
// the #474<->#455 seam. This does not invoke a reviewer agent; it writes a
// verdict object of exactly the shape the charters' example blocks show
// (reviewerId + verdict + a defects[] entry with severity/text/file/line)
// and drives it through the real runner script, same as
// tests/review-runner.test.js, which this file is modeled on.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// Same rationale as tests/review-runner.test.js: the runner spawns
// persist-review.ps1 and review_verdict.ps1 as nested launcher processes, and
// pwsh cold-start on Linux CI is slow enough to blow past the default 5000ms
// per-test timeout even on a correct run.
vi.setConfig({ testTimeout: 30000 });

// One-time guard: if the launcher doesn't exist, skip all tests.
let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const SCRIPT = path.join(__dirname, '..', 'tools', 'review-runner.ps1');

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping review-runner-conformance tests`)
  : describe;

// Builds an isolated temp git repo with a fixture source file of a known line
// count (src/db.js), staged, and returns { tmp, treeOid }.
function makeFixtureRepo(prefix, lineCount) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  const lines = [];
  for (let i = 1; i <= lineCount; i++) lines.push(`// line ${i}`);
  fs.writeFileSync(path.join(tmp, 'src', 'db.js'), lines.join('\n') + '\n');
  execFileSync('git', ['-C', tmp, 'add', '-A'], { encoding: 'utf8' });
  const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();
  return { tmp, treeOid };
}

function writeVerdict(runDir, filename, obj) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, filename), JSON.stringify(obj));
}

function runRunner(tmp, runDir, treeOid, mode, reviewsRoot) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    SCRIPT,
    '-RunDir',
    runDir,
    '-TreeOid',
    treeOid,
    '-Mode',
    mode,
    '-ReviewsRoot',
    reviewsRoot,
  ];
  const r = spawnSync(PS, args, { cwd: tmp, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// A verdict object of exactly the shape agents/reviewer-pr.md and
// agents/reviewer-design-philosophy.md instruct a reviewer to emit: a
// complete tools/review-verdict.schema.md object with reviewerId set, one
// defects[] entry carrying severity + text + a valid file/in-range line
// citation (mirrors each charter's own worked example, adjusted to point at
// this test's fixture file). `verdict` is overridden per test.
function charterShapedVerdict(verdict) {
  return {
    reviewerId: 'reviewer-pr-1',
    verdict,
    defects: [{ severity: 'blocker', text: 'unhandled null deref', file: 'src/db.js', line: 42 }],
  };
}

maybeDescribe('review-runner conformance with charter-emitted shape (issue #474 AC4)', () => {
  it('PASS: charter-shaped verdict -> exit 0, evidence + verdict.json written', () => {
    const { tmp, treeOid } = makeFixtureRepo('rrc-pass-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-pr-1.json', charterShapedVerdict('PASS'));

    const r = runRunner(tmp, runDir, treeOid, 'unanimous', reviewsRoot);

    expect(r.status).toBe(0);
    const evPath = path.join(reviewsRoot, treeOid, 'reviewer-pr-1.json');
    expect(fs.existsSync(evPath)).toBe(true);
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    expect(ev.verdict).toBe('PASS');
    expect(ev.tree_oid).toBe(treeOid);

    const verdictPath = path.join(tmp, '.review_state', 'verdict.json');
    expect(fs.existsSync(verdictPath)).toBe(true);
    const verdictObj = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
    expect(verdictObj.verdict).toBe('PASS');
    expect(verdictObj.tree_oid).toBe(treeOid);
  });

  // Would fail to catch the runner treating the charter shape as always
  // passing regardless of the `verdict` field's actual value.
  it('FAIL: same charter-shaped verdict with verdict=FAIL -> exit 1, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rrc-fail-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-pr-1.json', charterShapedVerdict('FAIL'));

    const r = runRunner(tmp, runDir, treeOid, 'unanimous', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FAIL');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });
});
