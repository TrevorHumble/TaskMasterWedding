// tests/governance-report-defects.test.js
// Vitest test for issue #417 AC4: tools/governance-report.ps1 tabulates a
// populated `defects` object from a fixture ledger.ndjson row.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const SCRIPT = path.resolve(__dirname, '..', 'tools', 'governance-report.ps1');

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping governance-report tests`)
  : describe;

function runReport(ledgerPath) {
  const r = spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Ledger', ledgerPath],
    { encoding: 'utf8' }
  );
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

maybeDescribe('governance-report.ps1 (#417 AC4)', () => {
  it('AC4: populated defects object -> pr role line reports major 1, minor 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-report-defects-'));
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const row = {
      schema: 'gl1',
      pr: 42,
      issue: 417,
      merged_sha: 'deadbeef',
      ts: '2026-07-10T00:00:00Z',
      reviews: [
        {
          role: 'pr',
          model: 'opus',
          verdict: 'PASS',
          defects: { blocker: 0, major: 1, minor: 2, nit: 0 },
          round: 1,
        },
      ],
      labels: [],
      freeze: false,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(row) + '\n');

    const r = runReport(ledgerPath);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /pr: total 1, PASS 1, FAIL 0, defects: blocker 0, major 1, minor 2, nit 0/
    );
  });

  // Companion to AC4: a role:"issue" entry (no defects sub-object per
  // DESIGN.md:271) must not crash the aggregator and reports all-zero buckets.
  it('issue-role entry with no defects object -> zero buckets, no crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-report-issuerole-'));
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const row = {
      schema: 'gl1',
      pr: 43,
      issue: 418,
      merged_sha: 'cafef00d',
      ts: '2026-07-10T00:00:00Z',
      reviews: [{ role: 'issue', model: 'opus', verdict: 'PASS', round: 1 }],
      labels: [],
      freeze: false,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(row) + '\n');

    const r = runReport(ledgerPath);

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /issue: total 1, PASS 1, FAIL 0, defects: blocker 0, major 0, minor 0, nit 0/
    );
  });

  // AC-Cat4 (#517): populated `categories` objects across two reviewer roles
  // -> "by category:" section tabulates each bucket's true, summed value.
  it('AC-Cat4: populated categories objects -> by-category output values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-report-cats-'));
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const row = {
      schema: 'gl1',
      pr: 44,
      issue: 517,
      merged_sha: 'c0ffee00',
      ts: '2026-07-14T00:00:00Z',
      reviews: [
        {
          role: 'pr',
          model: 'opus',
          verdict: 'FAIL',
          defects: { blocker: 1, major: 1, minor: 0, nit: 0 },
          categories: {
            correctness: 1,
            security: 0,
            'test-coverage': 1,
            docs: 0,
            design: 0,
            simplification: 0,
            style: 0,
          },
          round: 1,
        },
        {
          role: 'design-philosophy',
          model: 'opus',
          verdict: 'FAIL',
          defects: { blocker: 0, major: 1, minor: 0, nit: 0 },
          categories: {
            correctness: 0,
            security: 0,
            'test-coverage': 0,
            docs: 0,
            design: 1,
            simplification: 0,
            style: 0,
          },
          round: 1,
        },
      ],
      labels: [],
      freeze: false,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(row) + '\n');

    const r = runReport(ledgerPath);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('by category:');
    expect(r.stdout).toMatch(/correctness: 1/);
    expect(r.stdout).toMatch(/security: 0/);
    expect(r.stdout).toMatch(/test-coverage: 1/);
    expect(r.stdout).toMatch(/docs: 0/);
    expect(r.stdout).toMatch(/design: 1/);
    expect(r.stdout).toMatch(/simplification: 0/);
    expect(r.stdout).toMatch(/style: 0/);
  });

  // AC-Cat4 (#517): a `reviews: []` historical row must contribute zeros to
  // every category, never a fabricated bucket, and must not crash.
  it('AC-Cat4: reviews: [] historical row -> by-category zeros, no crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-report-cats-empty-'));
    const ledgerPath = path.join(dir, 'ledger.ndjson');
    const row = {
      schema: 'gl1',
      pr: 45,
      issue: 518,
      merged_sha: 'deadc0de',
      ts: '2026-07-14T00:00:00Z',
      reviews: [],
      labels: [],
      freeze: false,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(row) + '\n');

    const r = runReport(ledgerPath);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('by category:');
    expect(r.stdout).toMatch(/correctness: 0/);
    expect(r.stdout).toMatch(/security: 0/);
    expect(r.stdout).toMatch(/test-coverage: 0/);
    expect(r.stdout).toMatch(/docs: 0/);
    expect(r.stdout).toMatch(/design: 0/);
    expect(r.stdout).toMatch(/simplification: 0/);
    expect(r.stdout).toMatch(/style: 0/);
  });
});
