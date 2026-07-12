// tests/capture-reviewer-verdict.test.js
// Vitest tests for tools/capture-reviewer-verdict.ps1 (issue #455) AC1/AC2.
// Modeled on tests/review-runner.test.js: isolated temp fixture repos, spawnSync
// against the real launcher (`powershell` on Windows, `pwsh` elsewhere), so these
// tests drive the real scripts rather than reimplementing their logic.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// Two nested spawns per AC2 case (capture x2, then the runner, which itself
// spawns persist-review.ps1 per reviewer plus review_verdict.ps1) -- same
// slow-cold-start-on-Linux-CI rationale as tests/review-runner.test.js.
vi.setConfig({ testTimeout: 30000 });

let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const CAPTURE = path.join(__dirname, '..', 'tools', 'capture-reviewer-verdict.ps1');
const RUNNER = path.join(__dirname, '..', 'tools', 'review-runner.ps1');

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping capture-reviewer-verdict tests`)
  : describe;

// Builds an isolated temp git repo with a fixture source file of a known line
// count (src/db.js), stages it, returns { tmp, treeOid }. Mirrors
// tests/review-runner.test.js's makeFixtureRepo exactly.
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

function writeRawReturn(dir, filename, text) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, filename);
  fs.writeFileSync(p, text);
  return p;
}

function runCapture(rawReturnFile, runDir) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CAPTURE,
    '-RawReturnFile',
    rawReturnFile,
    '-RunDir',
    runDir,
  ];
  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function runRunner(tmp, runDir, treeOid, mode, reviewsRoot) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    RUNNER,
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

function runDirIsEmptyOrAbsent(runDir) {
  if (!fs.existsSync(runDir)) return true;
  return fs.readdirSync(runDir).length === 0;
}

maybeDescribe('capture-reviewer-verdict (issue #455)', () => {
  // AC1: a well-formed trailing block is captured verbatim under the
  // reviewerId's filename, exit 0. Would fail to catch the fence regex
  // matching the wrong span or the write re-serializing instead of copying.
  it('AC1: trailing fenced json block is captured verbatim, exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-ac1-'));
    const raw = [
      'This PR looks fine. AC1: verified by src/db.js:5.',
      '',
      '```json',
      JSON.stringify({ reviewerId: 'reviewer-pr-1', verdict: 'PASS', defects: [] }),
      '```',
      '',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).toBe(0);
    const outPath = path.join(runDir, 'reviewer-pr-1.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(parsed).toEqual({ reviewerId: 'reviewer-pr-1', verdict: 'PASS', defects: [] });
  });

  // AC1: a return quoting the schema example earlier, then its real trailing
  // verdict, must capture the LAST block, not the first. Would fail to catch
  // "first match" being used instead of "last match."
  it('AC1: two fenced json blocks (schema example quoted, then trailing verdict) -> captures the LAST one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-two-'));
    const raw = [
      'Reviewing per the schema, e.g.:',
      '```json',
      JSON.stringify({ reviewerId: 'example-only', verdict: 'FAIL', defects: [] }),
      '```',
      'Prose review follows... AC1: verified by src/db.js:5.',
      '```json',
      JSON.stringify({ reviewerId: 'reviewer-pr-2', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(runDir, 'example-only.json'))).toBe(false);
    const outPath = path.join(runDir, 'reviewer-pr-2.json');
    expect(fs.existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(parsed.reviewerId).toBe('reviewer-pr-2');
    expect(parsed.verdict).toBe('PASS');
  });

  // AC1 fail-closed: no fenced json block anywhere in the return.
  it('AC1: no fenced json block -> exit non-zero, writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-noblock-'));
    const rawFile = writeRawReturn(tmp, 'raw.txt', 'Just prose, no verdict block at all.');
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(runDirIsEmptyOrAbsent(runDir)).toBe(true);
  });

  // AC1 fail-closed: the trailing block exists but is not parseable JSON.
  it('AC1: unparseable trailing json block -> exit non-zero, writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-badjson-'));
    const raw = ['Prose review.', '```json', '{ this is not valid json', '```'].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).not.toBe(0);
    expect(runDirIsEmptyOrAbsent(runDir)).toBe(true);
  });

  // AC1 fail-closed: valid JSON, but no reviewerId field at all.
  it('AC1: block missing reviewerId -> exit non-zero, writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-noid-'));
    const raw = [
      'Prose review.',
      '```json',
      JSON.stringify({ verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).not.toBe(0);
    expect(runDirIsEmptyOrAbsent(runDir)).toBe(true);
  });

  // AC1 fail-closed: reviewerId present but blank/whitespace-only.
  it('AC1: blank reviewerId -> exit non-zero, writes nothing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-blankid-'));
    const raw = [
      'Prose review.',
      '```json',
      JSON.stringify({ reviewerId: '   ', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).not.toBe(0);
    expect(runDirIsEmptyOrAbsent(runDir)).toBe(true);
  });

  // Security edge: reviewerId is used to build the output filename
  // (<RunDir>/<reviewerId>.json) -- a path-traversal payload must be
  // rejected rather than let Join-Path write outside -RunDir. Mirrors the
  // sibling-escape citation guard already required of tools/review-runner.ps1.
  it('edge: reviewerId containing a path-traversal payload -> exit non-zero, no escape write', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-traversal-'));
    const raw = [
      'Prose review.',
      '```json',
      JSON.stringify({ reviewerId: '../evil', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'run');

    const r = runCapture(rawFile, runDir);

    expect(r.status).not.toBe(0);
    expect(runDirIsEmptyOrAbsent(runDir)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'evil.json'))).toBe(false);
  });

  // Edge: -RawReturnFile itself does not exist.
  it('edge: missing raw return file -> exit non-zero, no RunDir created', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-missing-'));
    const runDir = path.join(tmp, 'run');

    const r = runCapture(path.join(tmp, 'does-not-exist.txt'), runDir);

    expect(r.status).not.toBe(0);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  // Edge: -RunDir does not exist yet -- must be created on a successful capture.
  it('edge: creates -RunDir when absent, on a successful capture', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crv-mkdir-'));
    const raw = [
      'Prose.',
      '```json',
      JSON.stringify({ reviewerId: 'reviewer-x', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawFile = writeRawReturn(tmp, 'raw.txt', raw);
    const runDir = path.join(tmp, 'brand-new-dir');
    expect(fs.existsSync(runDir)).toBe(false);

    const r = runCapture(rawFile, runDir);

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(runDir, 'reviewer-x.json'))).toBe(true);
  });

  // AC2: end-to-end -- two synthetic reviewer raw returns, each captured via
  // AC1's tool into one -RunDir, then fed to the real runner. Would fail to
  // catch the capture output being in a shape the runner cannot ingest.
  it('AC2: two captured PASS returns -> runner records evidence + verdict, exit 0', () => {
    const { tmp, treeOid } = makeFixtureRepo('crv-ac2-pass-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const rawA = [
      'AC1: verified by src/db.js:5. No issues found.',
      '```json',
      JSON.stringify({
        reviewerId: 'reviewer-pr-1',
        verdict: 'PASS',
        defects: [{ severity: 'minor', text: 'style', file: 'src/db.js', line: 5 }],
      }),
      '```',
    ].join('\n');
    const rawB = [
      'Design-philosophy pass: no complexity concerns.',
      '```json',
      JSON.stringify({ reviewerId: 'reviewer-design-philosophy-1', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');

    const fileA = writeRawReturn(tmp, 'raw-a.txt', rawA);
    const fileB = writeRawReturn(tmp, 'raw-b.txt', rawB);

    expect(runCapture(fileA, runDir).status).toBe(0);
    expect(runCapture(fileB, runDir).status).toBe(0);

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid, 'reviewer-pr-1.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(reviewsRoot, treeOid, 'reviewer-design-philosophy-1.json'))
    ).toBe(true);
    const verdictPath = path.join(tmp, '.review_state', 'verdict.json');
    expect(fs.existsSync(verdictPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(verdictPath, 'utf8')).verdict).toBe('PASS');
  });

  // AC2: a captured FAIL among the panel still blocks the runner -- the
  // capture step does not launder a FAIL into anything else.
  it('AC2: one captured FAIL return among two -> runner writes nothing, exit non-zero', () => {
    const { tmp, treeOid } = makeFixtureRepo('crv-ac2-fail-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const rawA = [
      'AC1: verified by src/db.js:5.',
      '```json',
      JSON.stringify({ reviewerId: 'reviewer-pr-1', verdict: 'PASS', defects: [] }),
      '```',
    ].join('\n');
    const rawB = [
      'Found a blocker.',
      '```json',
      JSON.stringify({
        reviewerId: 'reviewer-design-philosophy-1',
        verdict: 'FAIL',
        defects: [{ severity: 'blocker', text: 'God object', file: 'src/db.js', line: 1 }],
      }),
      '```',
    ].join('\n');

    const fileA = writeRawReturn(tmp, 'raw-a.txt', rawA);
    const fileB = writeRawReturn(tmp, 'raw-b.txt', rawB);

    expect(runCapture(fileA, runDir).status).toBe(0);
    expect(runCapture(fileB, runDir).status).toBe(0);

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FAIL');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });
});
