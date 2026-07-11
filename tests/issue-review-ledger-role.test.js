// tests/issue-review-ledger-role.test.js
// Vitest tests for issue #359 — issue-review PASS evidence made durable through
// the CI-written ledger (role:"issue" in the gl1 reviews array).
// Windows PowerShell 5.1 is the launcher on win32; pwsh elsewhere.
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

const REPO_ROOT = path.resolve(__dirname, '..');
const PERSIST = path.join(REPO_ROOT, 'tools', 'persist-issue-review.ps1');
const REPORT = path.join(REPO_ROOT, 'tools', 'governance-report.ps1');

function runPersist(root, extraArgs) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    PERSIST,
    '-IssueNumber',
    '9999',
    '-ReviewerId',
    'reviewer-issue-opus',
    '-Verdict',
    'PASS',
    '-IssueReviewsRoot',
    root,
  ].concat(extraArgs || []);
  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function runReport(ledgerPath) {
  const r = spawnSync(
    PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', REPORT, '-Ledger', ledgerPath],
    { encoding: 'utf8' }
  );
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping issue-review-ledger-role tests`)
  : describe;

maybeDescribe('persist-issue-review.ps1 ledger bridge (#359 AC1)', () => {
  it('emits the exact ledger-review-entry line, writes evidence, exits 0', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irev-ledger-'));
    const result = runPersist(root, ['-Round', '2']);

    expect(result.status).toBe(0);
    // Real-value assertion: the literal line, not a loose substring match on
    // "ledger-review-entry" alone -- inverting round or omitting a key would fail this.
    expect(result.stdout).toContain(
      'ledger-review-entry: {"role":"issue","model":"opus","verdict":"PASS","round":2}'
    );

    const evPath = path.join(root, '9999', 'reviewer-issue-opus.json');
    expect(fs.existsSync(evPath)).toBe(true);
    const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
    expect(ev.verdict).toBe('PASS');
    expect(ev.issue_number).toBe(9999);
  });

  it('sibling .ledger-entry.txt carries no issue_number (commit-msg gate must ignore it)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irev-ledger-'));
    runPersist(root, ['-Round', '2']);
    const entryPath = path.join(root, '9999', 'reviewer-issue-opus.ledger-entry.txt');
    expect(fs.existsSync(entryPath)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    // The real behavioral guard from tools/issue-core.ps1 Read-IssueEvidence: a file
    // is kept only when its inner issue_number equals the directory. This object
    // must NOT have that field, or it would silently inflate the commit-msg gate's
    // evidence count -- inverting this (adding issue_number) would fail the assertion.
    expect(entry.issue_number).toBeUndefined();
    expect(entry).toEqual({ role: 'issue', model: 'opus', verdict: 'PASS', round: 2 });
  });

  it('the *.json glob under the issue dir matches only the real evidence file (#412)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irev-ledger-'));
    runPersist(root, ['-Round', '2']);
    const dir = path.join(root, '9999');
    // This is the exact glob tools/issue-core.ps1 Read-IssueEvidence uses
    // (Get-ChildItem -Filter '*.json'). If the sibling were still named
    // .ledger-entry.json, this would return two files instead of one --
    // inverting the sibling's extension back to .json would fail this assertion.
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(jsonFiles).toEqual(['reviewer-issue-opus.json']);
  });

  it('defaults -Round to 1 when omitted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irev-ledger-'));
    const result = runPersist(root, []);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'ledger-review-entry: {"role":"issue","model":"opus","verdict":"PASS","round":1}'
    );
  });
});

maybeDescribe('governance-report.ps1 role:"issue" totals (#359 AC2)', () => {
  it('one gl1 row with a role:"issue" review -> issue role-totals and per-issue rounds', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'govrep-irev-')), 'ledger.ndjson');
    const row = {
      schema: 'gl1',
      pr: 1,
      issue: 9999,
      reviews: [{ role: 'issue', model: 'opus', verdict: 'PASS', round: 2 }],
    };
    fs.writeFileSync(tmp, JSON.stringify(row) + '\n');

    const r = runReport(tmp);
    expect(r.status).toBe(0);
    // Exact substrings named in the acceptance criteria -- an inverted PASS/FAIL
    // count or a wrong max-round would fail these.
    expect(r.stdout).toContain('issue: total 1, PASS 1, FAIL 0');
    expect(r.stdout).toContain('issue 9999: reviews 1, max round 2');
  });
});
