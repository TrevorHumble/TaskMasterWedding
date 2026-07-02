// tests/issue-review-marker.test.js
// Vitest tests for issue #62 -- issue lifecycle marker ACs 5, 6, 7, 8.
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
const CLEAR_MARKER = path.join(TOOLS_DIR, 'clear-issue-marker.ps1');
const AUDIT_MARKERS = path.join(TOOLS_DIR, 'audit-issue-markers.ps1');

const ISSUE_N = 99;

// Write a valid irev1 evidence file for issue N into root/<N>/<id>.json.
function writeIssueEvidence(root, n, reviewerId, verdict) {
  const dir = path.join(root, String(n));
  fs.mkdirSync(dir, { recursive: true });
  const ev = {
    schema: 'irev1',
    issue_number: n,
    reviewer_id: reviewerId,
    model: 'opus',
    role: 'issue',
    verdict: verdict,
    findings_count: 0,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, `${reviewerId}.json`), JSON.stringify(ev));
}

// Write a temp .ps1 remover script that appends a sentinel line and exits removerExitCode.
// sentinelDir: directory the sentinel file is written into (<N>.txt).
// removerExitCode: what the script exits with.
// The sentinel line is "<IssueNumber>|<Label>" so both args are verifiable.
// Append (not overwrite) so a double-invocation produces two lines and fails the once-only check.
function writeRemoverScript(sentinelDir, removerExitCode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-rem-'));
  const scriptPath = path.join(tmp, 'remover.ps1');
  const rc = removerExitCode === undefined ? 0 : removerExitCode;
  // Build the exact path Node will read back, using the host separator,
  // then escape it for a PS single-quoted literal (\ -> \\, ' -> '').
  const sentinelFile = path.join(sentinelDir, `${ISSUE_N}.txt`);
  const escaped = sentinelFile.split('\\').join('\\\\').split("'").join("''");
  const body =
    'param([int]$IssueNumber,[string]$Label)\r\n' +
    "$sentinel = '" +
    escaped +
    "'\r\n" +
    '[IO.File]::AppendAllText($sentinel, "$IssueNumber|$Label`r`n")\r\n' +
    'exit ' +
    rc;
  fs.writeFileSync(scriptPath, body);
  return scriptPath;
}

// Run clear-issue-marker.ps1 with an injected remover script path via CLI param.
function runClearMarker(reviewsRoot, removerScriptPath) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CLEAR_MARKER,
    '-IssueNumber',
    String(ISSUE_N),
    '-IssueReviewsRoot',
    reviewsRoot,
  ];

  if (removerScriptPath) {
    args.push('-LabelRemoverScript', removerScriptPath);
  }

  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

// Run audit-issue-markers.ps1 with an injected issue list via CLI param.
function runAuditMarkers(issues, strict) {
  const listJson = JSON.stringify(issues);

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    AUDIT_MARKERS,
    '-IssueListJson',
    listJson,
  ];

  if (strict) {
    args.push('-Strict');
  }

  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found -- skipping issue-review-marker tests`)
  : describe;

maybeDescribe('issue-review-marker', () => {
  // AC5: recorded PASS present -> remover invoked EXACTLY ONCE with IssueNumber AND label, exit 0
  it('AC5: PASS evidence present -> remover invoked and script exits 0', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac5-'));
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac5s-'));
    writeIssueEvidence(reviewsRoot, ISSUE_N, 'reviewer-a', 'PASS');
    const removerScript = writeRemoverScript(sentinelDir, 0);

    const result = runClearMarker(reviewsRoot, removerScript);

    expect(result.status).toBe(0);
    // Sentinel file appended by the remover: <sentinelDir>/<N>.txt
    const sentinelFile = path.join(sentinelDir, `${ISSUE_N}.txt`);
    expect(fs.existsSync(sentinelFile)).toBe(true);
    const raw = fs.readFileSync(sentinelFile, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    // Invoked exactly once (double-invocation would produce two lines).
    expect(lines).toHaveLength(1);
    // Both IssueNumber and the label are passed correctly.
    expect(lines[0]).toBe(`${ISSUE_N}|needs-issue-review`);
  });

  // AC6a: no evidence -> remover NOT invoked, exit non-zero
  it('AC6a: no evidence -> remover not invoked, exits non-zero', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac6a-'));
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac6as-'));
    const removerScript = writeRemoverScript(sentinelDir, 0);

    const result = runClearMarker(reviewsRoot, removerScript);

    expect(result.status).not.toBe(0);
    const sentinelFile = path.join(sentinelDir, `${ISSUE_N}.txt`);
    expect(fs.existsSync(sentinelFile)).toBe(false);
  });

  // AC6b: only FAIL evidence -> remover NOT invoked, exit non-zero
  it('AC6b: only FAIL evidence -> remover not invoked, exits non-zero', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac6b-'));
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac6bs-'));
    writeIssueEvidence(reviewsRoot, ISSUE_N, 'reviewer-a', 'FAIL');
    const removerScript = writeRemoverScript(sentinelDir, 0);

    const result = runClearMarker(reviewsRoot, removerScript);

    expect(result.status).not.toBe(0);
    const sentinelFile = path.join(sentinelDir, `${ISSUE_N}.txt`);
    expect(fs.existsSync(sentinelFile)).toBe(false);
  });

  // AC7: PASS evidence but remover exits non-zero -> script exits non-zero, warns stderr
  it('AC7: PASS evidence but remover fails -> script exits non-zero with stderr warning', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac7-'));
    const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-ac7s-'));
    writeIssueEvidence(reviewsRoot, ISSUE_N, 'reviewer-a', 'PASS');
    const removerScript = writeRemoverScript(sentinelDir, 42);

    const result = runClearMarker(reviewsRoot, removerScript);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('clear-issue-marker');
  });

  // AC8a: two issues, -Strict -> exit 1 and both numbers printed
  it('AC8a: two issues with -Strict -> exits 1 and prints both', () => {
    const issues = [
      { number: 10, title: 'First unreviewed issue' },
      { number: 20, title: 'Second unreviewed issue' },
    ];
    const result = runAuditMarkers(issues, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('#10');
    expect(result.stdout).toContain('#20');
  });

  // AC8b: zero issues -> exit 0
  it('AC8b: zero issues -> exits 0', () => {
    const result = runAuditMarkers([], true);
    expect(result.status).toBe(0);
  });

  // Defect 3 lock: single issue (non-array JSON) with -Strict -> exit 1 and number printed.
  // Before the fix, $parsed.Count was $null for a single object and the issue was silently missed.
  it('single issue with -Strict -> exits 1 and prints number', () => {
    const result = runAuditMarkers([{ number: 7, title: 'only one' }], true);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('#7');
  });
});
