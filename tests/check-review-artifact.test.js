// tests/check-review-artifact.test.js
// Vitest tests for scripts/check-review-artifact.js (#48): the server-side
// review-authenticity check wired as the `review-artifact-present` required
// status check. AC1-AC4 run the real CLI process against injected fixture
// files (the --fixture offline seam) — no network call — and assert on the
// actual exit code and stdout, matching the acceptance criteria's own
// behavioral language ("the checker exits non-zero and its output contains").
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { touchesKernelSurface } = require('../scripts/ledger-harvest');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(REPO_ROOT, 'scripts', 'check-review-artifact.js');

function writeFixture(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-review-artifact-'));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

function ledgerComment(reviews) {
  return {
    body: '<!-- governance-ledger -->\n```json\n' + JSON.stringify({ reviews }) + '\n```\n',
  };
}

function runChecker(fixture) {
  const file = writeFixture(fixture);
  const r = spawnSync('node', [CHECKER, '--fixture', file], { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

describe('check-review-artifact.js (#48)', () => {
  it('AC1: no governance-ledger comment -> exits non-zero, output names it', () => {
    const r = runChecker({
      comments: [{ body: 'just chatting, no marker here' }],
      headTreeOid: 'T1',
      headCommitSubject: 'fix(x): something (#5)',
      changedPaths: ['src/app.js'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain('no governance-ledger comment');
  });

  it('AC2: issue PASS for #N + PR-review PASS bound to head tree T -> exits 0, "review evidence OK"', () => {
    const reviews = [
      { role: 'issue', model: 'opus', verdict: 'PASS', issue_number: 5, round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'T2',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const r = runChecker({
      comments: [ledgerComment(reviews)],
      headTreeOid: 'T2',
      headCommitSubject: 'fix(x): something (#5)',
      changedPaths: ['src/app.js'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('review evidence OK');
  });

  it('AC3: PR-review entry bound to a different tree than the PR head tree -> exits non-zero, names the mismatch (contains "tree")', () => {
    const reviews = [
      { role: 'issue', model: 'opus', verdict: 'PASS', issue_number: 5, round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'STALE-TREE',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const r = runChecker({
      comments: [ledgerComment(reviews)],
      headTreeOid: 'T3',
      headCommitSubject: 'fix(x): something (#5)',
      changedPaths: ['src/app.js'],
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/tree/);
  });

  it('AC4: system-level changed path + exactly one PR-review PASS for the head tree -> exits non-zero', () => {
    const reviews = [
      { role: 'issue', model: 'opus', verdict: 'PASS', issue_number: 6, round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'T4',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const r = runChecker({
      comments: [ledgerComment(reviews)],
      headTreeOid: 'T4',
      headCommitSubject: 'fix(x): something (#6)',
      changedPaths: ['tools/some-governance-tool.ps1'],
    });
    expect(r.status).not.toBe(0);
  });

  it('AC4: system-level changed path + two PR-review PASSes from distinct reviewer_ids -> exits 0', () => {
    const reviews = [
      { role: 'issue', model: 'opus', verdict: 'PASS', issue_number: 6, round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'T5',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'T5',
        reviewer_id: 'reviewer-pr-2',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const r = runChecker({
      comments: [ledgerComment(reviews)],
      headTreeOid: 'T5',
      headCommitSubject: 'fix(x): something (#6)',
      changedPaths: ['tools/some-governance-tool.ps1'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('review evidence OK');
  });

  it('no issue-review PASS for the referenced issue -> exits non-zero', () => {
    const reviews = [
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'T6',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const r = runChecker({
      comments: [ledgerComment(reviews)],
      headTreeOid: 'T6',
      headCommitSubject: 'fix(x): something (#7)',
      changedPaths: [],
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/issue/);
  });
});

// Drift-guard (#48): scripts/check-review-artifact.js reuses
// scripts/ledger-harvest.js's touchesKernelSurface for the system-level test
// rather than declaring a third copy of the governing-artifact regex
// (tools/verdict-core.ps1 owns the definition, scripts/ledger-harvest.js
// already mirrors it once). This test proves that single JS mirror still
// agrees with the PS source of truth for a representative path list, run
// through PowerShell's actual $SYSTEM_PATH_REGEX / $EXPERIMENTAL_PATH_REGEX
// via a dot-source rather than a brittle string-literal diff (PS and JS
// escape `/` differently in a regex literal, which a text diff would have to
// account for; a behavioral comparison sidesteps that entirely).
describe('review-artifact-present system-level drift guard (tools/verdict-core.ps1)', () => {
  const { execFileSync, spawnSync: psSpawnSync } = require('child_process');
  const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

  let launcherMissing = false;
  try {
    execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
  } catch (e) {
    if (e.code === 'ENOENT') launcherMissing = true;
  }

  const CANDIDATE_PATHS = [
    'tools/foo.ps1',
    '.github/workflows/ci.yml',
    'DESIGN.md',
    'CLAUDE.md',
    'AGENTS.md',
    'docs/north-star.md',
    'agents/orchestrator.md',
    'agents/reviewer-pr.md',
    'skills/foo.md',
    '.githooks/pre-commit',
    '.claude/settings.json',
    'standards/issue-standards.md',
    'src/app.js',
    'tests/foo.test.js',
    'views/index.ejs',
    'README.md',
  ];

  const maybeIt = launcherMissing ? it.skip : it;

  maybeIt(
    'JS touchesKernelSurface agrees with PS $SYSTEM_PATH_REGEX/$EXPERIMENTAL_PATH_REGEX for every candidate path',
    () => {
      const verdictCore = path.join(REPO_ROOT, 'tools', 'verdict-core.ps1');
      const psPaths = CANDIDATE_PATHS.map((p) => `'${p}'`).join(',');
      const script =
        `. '${verdictCore}'; $paths = @(${psPaths}); ` +
        `($paths | ForEach-Object { if ($_ -match $SYSTEM_PATH_REGEX -and $_ -notmatch $EXPERIMENTAL_PATH_REGEX) { 'Y' } else { 'N' } }) -join ','`;
      const r = psSpawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      const psFlags = r.stdout.trim().split(',');
      expect(psFlags).toHaveLength(CANDIDATE_PATHS.length);

      const jsFlags = CANDIDATE_PATHS.map((p) => (touchesKernelSurface([p]) ? 'Y' : 'N'));
      expect(jsFlags).toEqual(psFlags);
    }
  );
});
