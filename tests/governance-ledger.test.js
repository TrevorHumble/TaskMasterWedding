// tests/governance-ledger.test.js
// Vitest tests for issue #219 — governance ledger: report script (AC1),
// harvest pure functions (AC3), and the commit-msg sanctioned-appender
// exemption. Windows PowerShell 5.1 is the launcher on win32; pwsh elsewhere.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractLedgerComment,
  resolveIssueNumber,
  buildRow,
  buildGovernanceRow,
  buildReversalRow,
  touchesKernelSurface,
  appendRows,
} = require('../scripts/ledger-harvest.js');

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
const REPORT = path.join(REPO_ROOT, 'tools', 'governance-report.ps1');
const AC1_FIXTURE = path.join(REPO_ROOT, 'fixtures', 'governance', 'ledger-ac1.ndjson');

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
  ? describe.skip.bind(describe, `${PS} not found — skipping governance-report tests`)
  : describe;

maybeDescribe('governance-report.ps1 (AC1)', () => {
  it('AC1: three-row fixture -> design-philosophy total 2 / FAIL 1, pr total 1, exit 0', () => {
    const r = runReport(AC1_FIXTURE);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/design-philosophy: total 2, PASS 1, FAIL 1/);
    expect(r.stdout).toMatch(/pr: total 1, PASS 1, FAIL 0/);
  });

  it('AC1: defect severities are summed per role', () => {
    const r = runReport(AC1_FIXTURE);
    expect(r.stdout).toMatch(/design-philosophy: .*defects: blocker 1, major 2, minor 1, nit 2/);
  });

  it('AC1: rounds per issue reflect review counts and max round', () => {
    const r = runReport(AC1_FIXTURE);
    expect(r.stdout).toMatch(/issue 50: reviews 2, max round 2/);
    expect(r.stdout).toMatch(/issue 51: reviews 1, max round 1/);
  });

  it('reversal rows are counted', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'govrep-')), 'ledger.ndjson');
    const rows = [
      fs.readFileSync(AC1_FIXTURE, 'utf8').trim(),
      JSON.stringify({
        schema: 'gl1-reversal',
        pr: 101,
        ts: '2026-07-03T11:00:00Z',
        label: 'design-reversed',
      }),
    ];
    fs.writeFileSync(tmp, rows.join('\n') + '\n');
    const r = runReport(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/reversals: 1/);
  });

  it('empty ledger file -> literal "no ledger rows", exit 0', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'govrep-')), 'empty.ndjson');
    fs.writeFileSync(tmp, '');
    const r = runReport(tmp);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('no ledger rows');
  });

  it('absent ledger file -> literal "no ledger rows", exit 0', () => {
    const r = runReport(path.join(os.tmpdir(), 'does-not-exist-gl.ndjson'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('no ledger rows');
  });
});

describe('ledger-harvest pure functions (AC3)', () => {
  const pr = {
    number: 210,
    title: 'fix(photos): reject HEIC at intake (#188)',
    body: '',
    merged_at: '2026-07-04T01:02:03Z',
    merge_commit_sha: 'deadbeef',
    labels: [{ name: 'fable' }],
    head: { ref: 'issue-188-heic-rejection' },
  };

  const reviews = [
    {
      role: 'design-philosophy',
      model: 'opus',
      verdict: 'PASS',
      defects: { blocker: 0, major: 0, minor: 2, nit: 1 },
      round: 1,
    },
  ];

  function ledgerComment(obj) {
    return {
      body: '<!-- governance-ledger -->\n```json\n' + JSON.stringify(obj) + '\n```\n',
    };
  }

  it('AC3: governance-ledger comment present -> reviews array verbatim', () => {
    const row = buildRow(pr, [{ body: 'lgtm' }, ledgerComment({ reviews })]);
    expect(row.reviews).toEqual(reviews);
    expect(row.schema).toBe('gl1');
    expect(row.pr).toBe(210);
    expect(row.issue).toBe(188);
    expect(row.merged_sha).toBe('deadbeef');
    expect(row.ts).toBe('2026-07-04T01:02:03Z');
    expect(row.labels).toEqual(['fable']);
    expect(row.freeze).toBe(false);
  });

  it('AC3: no governance-ledger comment -> reviews is []', () => {
    const row = buildRow(pr, [{ body: 'just chatting' }]);
    expect(row.reviews).toEqual([]);
  });

  it('malformed json in the tagged comment -> reviews [] (no fabricated entry)', () => {
    const row = buildRow(pr, [{ body: 'governance-ledger\n```json\n{not json}\n```' }]);
    expect(row.reviews).toEqual([]);
  });

  it('last governance-ledger comment wins', () => {
    const older = ledgerComment({ reviews: [] });
    const newer = ledgerComment({ reviews });
    expect(extractLedgerComment([older, newer]).reviews).toEqual(reviews);
  });

  // #48: the comment's reviews array is copied verbatim into the gl1 row
  // regardless of shape, so the tree_oid/reviewer_id/issue_number binding
  // fields tools/emit-ledger-comment.ps1 now emits pass through additively
  // -- buildRow does not know or care about them -- and a row from before
  // #48 (lacking those fields) is equally valid, an honest historical gap
  // rather than a validation failure. Same posture as `buildlog: null`.
  it('#48: reviews entries carrying the new binding fields (tree_oid/reviewer_id/issue_number) pass through verbatim', () => {
    const widenedReviews = [
      { role: 'issue', model: 'opus', verdict: 'PASS', issue_number: 188, round: 1 },
      {
        role: 'pr',
        model: 'opus',
        verdict: 'PASS',
        tree_oid: 'deadbeefT',
        reviewer_id: 'reviewer-pr-1',
        defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
        round: 1,
      },
    ];
    const row = buildRow(pr, [ledgerComment({ reviews: widenedReviews })]);
    expect(row.reviews).toEqual(widenedReviews);
  });

  it('resolveIssueNumber: title (#N), Closes #N, branch fallback, none -> null', () => {
    expect(resolveIssueNumber({ title: 'x (#42)', body: '', head: { ref: 'z' } })).toBe(42);
    expect(resolveIssueNumber({ title: 'x', body: 'Closes #7', head: { ref: 'z' } })).toBe(7);
    expect(resolveIssueNumber({ title: 'x', body: '', head: { ref: 'feat/issue-46' } })).toBe(46);
    expect(resolveIssueNumber({ title: 'x', body: '', head: { ref: 'enforce/v4-s1' } })).toBe(null);
  });

  it('touchesKernelSurface mirrors verdict-core: kernel paths yes, charter carve-out no', () => {
    expect(touchesKernelSurface(['tools/foo.ps1'])).toBe(true);
    expect(touchesKernelSurface(['.github/workflows/ci.yml'])).toBe(true);
    expect(touchesKernelSurface(['DESIGN.md'])).toBe(true);
    expect(touchesKernelSurface(['agents/reviewer-lens.md'])).toBe(false);
    expect(touchesKernelSurface(['src/app.js', 'tests/x.test.js'])).toBe(false);
    expect(touchesKernelSurface([])).toBe(false);
  });

  it('buildGovernanceRow keeps only kernel-surface files', () => {
    const row = buildGovernanceRow(pr, ['tools/foo.ps1', 'src/app.js']);
    expect(row.schema).toBe('gl1-governance');
    expect(row.files).toEqual(['tools/foo.ps1']);
  });

  it('buildReversalRow carries the design-reversed label', () => {
    const row = buildReversalRow(pr, '2026-07-05T00:00:00Z');
    expect(row).toEqual({
      schema: 'gl1-reversal',
      pr: 210,
      ts: '2026-07-05T00:00:00Z',
      label: 'design-reversed',
    });
  });

  it('appendRows appends new rows and skips duplicates (same schema+pr)', () => {
    const row = buildRow(pr, []);
    const first = appendRows('', [row]);
    expect(first.appended).toHaveLength(1);
    const second = appendRows(first.text, [row, buildReversalRow(pr, 't')]);
    expect(second.appended).toHaveLength(1);
    expect(second.appended[0].schema).toBe('gl1-reversal');
    const lines = second.text.trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

// The sanctioned-appender exemption in .githooks/commit-msg: a commit whose
// ONLY staged path is governance/ledger.ndjson AND whose message starts
// "ledger: " passes without any review evidence; anything else takes the gate.
describe('commit-msg ledger exemption', () => {
  function makeRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-hook-'));
    const run = (args, opts) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', ...opts });
      return {
        status: r.status === null ? 1 : r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
      };
    };
    run(['init', '-q']);
    run(['config', 'user.name', 'test']);
    run(['config', 'user.email', 'test@example.invalid']);
    run(['config', 'core.hooksPath', '.githooks']);
    fs.mkdirSync(path.join(dir, '.githooks'));
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.mkdirSync(path.join(dir, 'governance'));
    // Byte-for-byte copies keep the LF-only hook intact. gate-core.sh rides
    // along because commit-msg sources it (event mode, #220).
    fs.copyFileSync(
      path.join(REPO_ROOT, '.githooks', 'commit-msg'),
      path.join(dir, '.githooks', 'commit-msg')
    );
    fs.copyFileSync(
      path.join(REPO_ROOT, '.githooks', 'gate-core.sh'),
      path.join(dir, '.githooks', 'gate-core.sh')
    );
    for (const t of [
      'issue-core.ps1',
      'verdict-core.ps1',
      'check-issue-reviewed.ps1',
      'event-mode-core.ps1',
    ]) {
      fs.copyFileSync(path.join(REPO_ROOT, 'tools', t), path.join(dir, 'tools', t));
    }
    fs.chmodSync(path.join(dir, '.githooks', 'commit-msg'), 0o755);
    return { dir, run };
  }

  it('ledger-only commit with "ledger: " message passes without evidence', () => {
    const { dir, run } = makeRepo();
    fs.writeFileSync(path.join(dir, 'governance', 'ledger.ndjson'), '{"schema":"gl1","pr":1}\n');
    run(['add', 'governance/ledger.ndjson']);
    const r = run(['commit', '-m', 'ledger: append harvested rows']);
    expect(r.status).toBe(0);
  }, 60000);

  it('ledger-only commit with a non-ledger message is blocked', () => {
    const { dir, run } = makeRepo();
    fs.writeFileSync(path.join(dir, 'governance', 'ledger.ndjson'), '{"schema":"gl1","pr":2}\n');
    run(['add', 'governance/ledger.ndjson']);
    const r = run(['commit', '-m', 'chore: hand-edit the ledger']);
    expect(r.status).not.toBe(0);
  }, 60000);

  it('"ledger: " message with an extra staged file is blocked', () => {
    const { dir, run } = makeRepo();
    fs.writeFileSync(path.join(dir, 'governance', 'ledger.ndjson'), '{"schema":"gl1","pr":3}\n');
    fs.writeFileSync(path.join(dir, 'evil.js'), '// smuggled\n');
    run(['add', 'governance/ledger.ndjson', 'evil.js']);
    const r = run(['commit', '-m', 'ledger: sneak in code']);
    expect(r.status).not.toBe(0);
  }, 60000);
});
