// tests/review-runner.test.js
// Vitest tests for tools/review-runner.ps1: issue #128 AC1-AC5.
// Runs the script against an isolated temp git repo per test (fixture source
// files + fixture verdict JSON), so these tests never touch the real repo's
// .review_state or verdict.json. Modeled on tests/enforcement-bias-gate.test.js.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// These tests spawn the launcher once for the runner itself, then again per
// reviewer inside persist-review.ps1, then again for review_verdict.ps1 --
// up to ~4 nested spawns for the two-reviewer clean-pass cases. `pwsh`
// cold-start on Linux CI is much slower than `powershell` on Windows, so the
// default 5000ms per-test timeout is too tight there even though the runner
// itself is correct. Raise it file-wide rather than per assertion.
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
  ? describe.skip.bind(describe, `${PS} not found — skipping review-runner tests`)
  : describe;

// Builds an isolated temp git repo with a fixture source file of a known line
// count (`src/db.js`, 131 lines) and stages it, returning { tmp, treeOid }.
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
  // cwd = the temp repo, so persist-review.ps1 / review_verdict.ps1's internal
  // `git rev-parse --show-toplevel` / `git write-tree` resolve against the
  // fixture repo, never the real one.
  const r = spawnSync(PS, args, { cwd: tmp, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

maybeDescribe('review-runner (issue #128)', () => {
  // AC1: out-of-range citation (line 99999 against a 131-line file) fails
  // closed. Would fail to catch an inverted bound-check (>= vs >).
  it('AC1: out-of-range citation -> exit 1, reports out-of-range, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-ac1-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'major', text: 'oob', file: 'src/db.js', line: 99999 }],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('out-of-range');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });

  // Fix (round 4): line: 0 is a fail-open in PowerShell if the outer guard
  // uses `$line -ne ''`, since `0 -ne ''` coerces to false and skips the
  // range check entirely. line is documented as 1-based, so 0 must be
  // rejected as out-of-range like any other out-of-bounds value.
  it('line 0 citation -> exit 1, reports out-of-range, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-line0-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'major', text: 'zero line', file: 'src/db.js', line: 0 }],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('out-of-range');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });

  // Boundary companion to AC1: line == count is VALID (not out-of-range).
  // This is the case that would fail if the boundary were off-by-one (e.g. `>=`).
  it('boundary: line exactly equal to file line count is valid, not out-of-range', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-boundary-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'minor', text: 'last line', file: 'src/db.js', line: 131 }],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('out-of-range');
  });

  // Round-5 fix: a cited path resolving into a SIBLING directory whose name
  // starts with the repo's basename (e.g. "<repo>-evil" next to "<repo>")
  // must be rejected. A bare StartsWith(rootFull) prefix check wrongly
  // admits this, since "C:\repo-evil\..." starts with the string "C:\repo".
  // Would fail to catch the prefix-boundary hole reintroducing itself.
  it('sibling-escape citation resolving outside repo root -> exit 1, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-sibling-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const siblingDir = `${tmp}-evil`;
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'top secret\n');

    try {
      const basename = path.basename(tmp);
      writeVerdict(runDir, 'reviewer-a.json', {
        reviewerId: 'reviewer-a',
        verdict: 'PASS',
        defects: [
          {
            severity: 'major',
            text: 'escapes to sibling dir',
            file: `../${basename}-evil/secret.txt`,
            line: 1,
          },
        ],
      });
      writeVerdict(runDir, 'reviewer-b.json', {
        reviewerId: 'reviewer-b',
        verdict: 'PASS',
        defects: [],
      });

      const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('file-not-found');
      expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
      expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });

  // AC2: nonexistent file citation fails closed. Would fail to catch a
  // missing-file check being skipped entirely.
  it('AC2: nonexistent file citation -> exit 1, reports file-not-found, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-ac2-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [
        { severity: 'blocker', text: 'ghost file', file: 'src/does-not-exist.js', line: 1 },
      ],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('file-not-found');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
  });

  // AC3: clean unanimous PASS is recorded -- both persist-review evidence
  // files exist and verdict.json is bound PASS for the tree, exit 0.
  it('AC3: clean two-reviewer PASS -> exit 0, evidence + verdict.json written', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-ac3-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'minor', text: 'style', file: 'src/db.js', line: 5 }],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
    const evA = path.join(reviewsRoot, treeOid, 'reviewer-a.json');
    const evB = path.join(reviewsRoot, treeOid, 'reviewer-b.json');
    expect(fs.existsSync(evA)).toBe(true);
    expect(fs.existsSync(evB)).toBe(true);
    const evObjA = JSON.parse(fs.readFileSync(evA, 'utf8'));
    expect(evObjA.verdict).toBe('PASS');
    expect(evObjA.tree_oid).toBe(treeOid);

    const verdictPath = path.join(tmp, '.review_state', 'verdict.json');
    expect(fs.existsSync(verdictPath)).toBe(true);
    const verdictObj = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
    expect(verdictObj.verdict).toBe('PASS');
    expect(verdictObj.tree_oid).toBe(treeOid);
  });

  // AC4: any FAIL blocks the whole panel even with a clean citation.
  // Would fail to catch a mutant that only checked the first reviewer's verdict.
  it('AC4: one FAIL among two reviewers -> exit 1, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-ac4-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'FAIL',
      defects: [{ severity: 'blocker', text: 'broken', file: 'src/db.js', line: 1 }],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FAIL');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });

  // AC5: insufficient panel (only one verdict file present in both-pass mode)
  // blocks. Would fail to catch a missing panel-size check.
  it('AC5: only one reviewer verdict present -> exit 1, reports incomplete panel, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-ac5-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('insufficient-panel');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
  });

  // Edge: empty RunDir blocks (no verdict files at all).
  it('edge: empty RunDir -> exit 1, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-empty-', 131);
    const runDir = path.join(tmp, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
  });

  // Edge: malformed JSON in one verdict file blocks the whole run.
  it('edge: malformed JSON verdict file -> exit 1, no verdict.json', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-malformed-', 131);
    const runDir = path.join(tmp, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'reviewer-a.json'), '{ not valid json');
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
  });

  // Mode: unanimous with a single PASS reviewer + valid citation is
  // sufficient (the protocol's routine rounds-2+ single-reviewer bar).
  // Would fail to catch -Mode being inert (hardcoded to require 2).
  it('unanimous: one PASS reviewer with valid citation -> exit 0, evidence + verdict.json written', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-una-pass-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'minor', text: 'style', file: 'src/db.js', line: 5 }],
    });

    const r = runRunner(tmp, runDir, treeOid, 'unanimous', reviewsRoot);

    expect(r.status).toBe(0);
    const evA = path.join(reviewsRoot, treeOid, 'reviewer-a.json');
    expect(fs.existsSync(evA)).toBe(true);
    const verdictPath = path.join(tmp, '.review_state', 'verdict.json');
    expect(fs.existsSync(verdictPath)).toBe(true);
    const verdictObj = JSON.parse(fs.readFileSync(verdictPath, 'utf8'));
    expect(verdictObj.verdict).toBe('PASS');
    expect(verdictObj.tree_oid).toBe(treeOid);
  });

  // Mode: unanimous with a single FAIL reviewer still blocks -- a lone
  // reviewer doesn't bypass the FAIL-blocks rule.
  it('unanimous: one FAIL reviewer -> exit 1, no PASS recorded', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-una-fail-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'FAIL',
      defects: [{ severity: 'blocker', text: 'broken', file: 'src/db.js', line: 1 }],
    });

    const r = runRunner(tmp, runDir, treeOid, 'unanimous', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('FAIL');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
  });

  // Guard: -TreeOid that does not match the fixture's live staged tree must
  // block before any writer runs. Would fail to catch the guard being
  // absent or a no-op.
  it('guard: -TreeOid mismatched with live staged tree -> exit 1, no PASS artifact', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-treemismatch-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const bogusOid = treeOid.replace(/^./, treeOid[0] === '0' ? '1' : '0');
    const r = runRunner(tmp, runDir, bogusOid, 'both-pass', reviewsRoot);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('tree-mismatch');
    expect(fs.existsSync(path.join(tmp, '.review_state', 'verdict.json'))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, treeOid))).toBe(false);
    expect(fs.existsSync(path.join(reviewsRoot, bogusOid))).toBe(false);
  });

  // AC1 (#417): mixed severities tally correctly into the persisted evidence's
  // `defects` object, and findings_count reflects the total. Would fail to
  // catch a bucket miscount or a severity/count mismatch.
  it('AC1 (#417): mixed severities -> evidence defects tallied, findings_count 4', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-sev-ac1-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [
        { severity: 'blocker', text: 'b1' },
        { severity: 'major', text: 'm1' },
        { severity: 'major', text: 'm2' },
        { severity: 'nit', text: 'n1' },
      ],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
    const evA = JSON.parse(
      fs.readFileSync(path.join(reviewsRoot, treeOid, 'reviewer-a.json'), 'utf8')
    );
    expect(evA.defects).toEqual({ blocker: 1, major: 2, minor: 0, nit: 1 });
    expect(evA.findings_count).toBe(4);
  });

  // AC2 (#417): an unrecognized severity value still counts toward the
  // total but is bucketed nowhere. Would fail to catch either a crash on
  // unknown severity or a wrong bucket absorbing it.
  it('AC2 (#417): unknown severity -> counted in total, bucketed nowhere, exit 0', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-sev-ac2-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [
        { severity: 'blocker', text: 'b1' },
        { severity: 'typo', text: 'unrecognized severity' },
      ],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
    const evA = JSON.parse(
      fs.readFileSync(path.join(reviewsRoot, treeOid, 'reviewer-a.json'), 'utf8')
    );
    expect(evA.defects).toEqual({ blocker: 1, major: 0, minor: 0, nit: 0 });
    expect(evA.findings_count).toBe(2);
  });

  // Edge: a defect with no `file` is never citation-validated, so a clean
  // panel with a file-less defect still passes.
  it('edge: defect with no file citation does not block a clean panel', () => {
    const { tmp, treeOid } = makeFixtureRepo('rr-nofile-', 131);
    const runDir = path.join(tmp, 'run');
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    writeVerdict(runDir, 'reviewer-a.json', {
      reviewerId: 'reviewer-a',
      verdict: 'PASS',
      defects: [{ severity: 'nit', text: 'process note, no file' }],
    });
    writeVerdict(runDir, 'reviewer-b.json', {
      reviewerId: 'reviewer-b',
      verdict: 'PASS',
      defects: [],
    });

    const r = runRunner(tmp, runDir, treeOid, 'both-pass', reviewsRoot);

    expect(r.status).toBe(0);
  });
});

// AC3 (#417): tools/persist-review.ps1 called directly (not via the runner)
// with only -Blocker/-Minor and no -FindingsCount must derive findings_count
// from the severity buckets, and emit them as the `defects` object.
const PERSIST_REVIEW = path.join(__dirname, '..', 'tools', 'persist-review.ps1');

maybeDescribe('persist-review.ps1 (#417 AC3)', () => {
  it('AC3: -Blocker 2 -Minor 1, no -FindingsCount -> defects object + findings_count 3', () => {
    const { tmp, treeOid } = makeFixtureRepo('pr-ac3-', 5);
    const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PERSIST_REVIEW,
      '-TreeOid',
      treeOid,
      '-ReviewerId',
      'r1',
      '-Verdict',
      'PASS',
      '-Blocker',
      '2',
      '-Minor',
      '1',
      '-ReviewsRoot',
      reviewsRoot,
    ];
    const r = spawnSync(PS, args, { cwd: tmp, encoding: 'utf8' });
    expect(r.status).toBe(0);

    const evPath = path.join(reviewsRoot, treeOid, 'r1.json');
    expect(fs.existsSync(evPath)).toBe(true);
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    expect(ev.defects).toEqual({ blocker: 2, major: 0, minor: 1, nit: 0 });
    expect(ev.findings_count).toBe(3);
  });
});
