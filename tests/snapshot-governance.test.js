// tests/snapshot-governance.test.js
// Vitest tests for issue #224 — snapshot-governance.ps1 behavioral ACs 1-3.
// Runs the real tool (from this repo's tools/) inside a scratch git repo so no
// tag or export ever touches the real repository.
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

const SCRIPT = path.resolve(__dirname, '..', 'tools', 'snapshot-governance.ps1');

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// Scratch repo carrying a minimal governance surface, fully committed.
function makeRepo(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-snap-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(dir, 'standards'));
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'standards', 'a.md'), '# a\n');
  fs.writeFileSync(path.join(dir, 'agents', 'b.md'), '# b\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
  fs.writeFileSync(path.join(dir, 'DESIGN.md'), '# design\n');
  fs.writeFileSync(path.join(dir, 'docs', 'north-star.md'), '# goals\n');
  if (opts && typeof opts.ledger === 'string') {
    fs.mkdirSync(path.join(dir, 'governance'));
    fs.writeFileSync(path.join(dir, 'governance', 'ledger.ndjson'), opts.ledger);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function runSnapshot(dir, version, exportDir) {
  const r = spawnSync(
    PS,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT,
      '-Version',
      String(version),
      '-ExportDir',
      exportDir,
    ],
    { cwd: dir, encoding: 'utf8' }
  );
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping snapshot-governance tests`)
  : describe;

maybeDescribe('snapshot-governance.ps1', () => {
  it('AC1: clean tree -> tag created and export contains surface + stats.txt', () => {
    const dir = makeRepo();
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-exp-'));
    const r = runSnapshot(dir, 1, exportDir);
    expect(r.status).toBe(0);

    const tags = git(dir, ['tag', '-l', 'governance-v1']);
    expect(tags.stdout.trim()).toBe('governance-v1');

    const dest = path.join(exportDir, 'governance-v1');
    expect(fs.existsSync(path.join(dest, 'standards', 'a.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'agents', 'b.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'stats.txt'))).toBe(true);
    // No ledger committed in this fixture -> the literal fallback line.
    expect(fs.readFileSync(path.join(dest, 'stats.txt'), 'utf8').trim()).toBe('no ledger rows');
    expect(r.stdout).toContain('governance-v1');
  }, 60000);

  it('AC2: existing tag -> exits non-zero naming the collision', () => {
    const dir = makeRepo();
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-exp-'));
    expect(runSnapshot(dir, 1, exportDir).status).toBe(0);
    const again = runSnapshot(dir, 1, exportDir);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('governance-v1');
  }, 60000);

  it('AC3: dirty tree -> exits non-zero and creates no tag', () => {
    const dir = makeRepo();
    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), 'uncommitted\n');
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-exp-'));
    const r = runSnapshot(dir, 9, exportDir);
    expect(r.status).not.toBe(0);
    const tags = git(dir, ['tag', '-l', 'governance-v9']);
    expect(tags.stdout.trim()).toBe('');
  }, 60000);

  // #228 AC4: rows live on the ledger branch; origin/ledger wins over HEAD's seed.
  it('origin/ledger with rows and empty HEAD copy -> stats.txt carries the report', () => {
    const ledgerRow =
      JSON.stringify({
        schema: 'gl1',
        pr: 3,
        issue: 8,
        merged_sha: 'def',
        ts: '2026-07-02T00:00:00Z',
        reviews: [
          {
            role: 'design-philosophy',
            model: 'opus',
            verdict: 'PASS',
            defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
            round: 1,
          },
        ],
        labels: [],
        freeze: false,
      }) + '\n';
    // HEAD carries an EMPTY seed ledger; the rows exist only on origin/ledger.
    const dir = makeRepo({ ledger: '' });
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-bare-'));
    git(base, ['init', '--bare', '-q']);
    git(dir, ['remote', 'add', 'origin', base]);
    // Build the ledger branch: one commit on top of main with the real rows.
    git(dir, ['switch', '-q', '-c', 'ledger']);
    fs.writeFileSync(path.join(dir, 'governance', 'ledger.ndjson'), ledgerRow);
    git(dir, ['add', 'governance/ledger.ndjson']);
    git(dir, ['commit', '-q', '-m', 'ledger: append harvested rows']);
    git(dir, ['push', '-q', 'origin', 'ledger']);
    git(dir, ['switch', '-q', '-']);
    git(dir, ['fetch', '-q', 'origin']);

    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-exp-'));
    const r = runSnapshot(dir, 3, exportDir);
    expect(r.status).toBe(0);
    const stats = fs.readFileSync(path.join(exportDir, 'governance-v3', 'stats.txt'), 'utf8');
    expect(stats).toMatch(/design-philosophy: total 1, PASS 1, FAIL 0/);
  }, 60000);

  it('committed ledger with rows -> stats.txt carries the report', () => {
    const ledger =
      JSON.stringify({
        schema: 'gl1',
        pr: 1,
        issue: 5,
        merged_sha: 'abc',
        ts: '2026-07-01T00:00:00Z',
        reviews: [
          {
            role: 'pr',
            model: 'opus',
            verdict: 'PASS',
            defects: { blocker: 0, major: 0, minor: 0, nit: 0 },
            round: 1,
          },
        ],
        labels: [],
        freeze: false,
      }) + '\n';
    const dir = makeRepo({ ledger });
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-exp-'));
    const r = runSnapshot(dir, 2, exportDir);
    expect(r.status).toBe(0);
    const stats = fs.readFileSync(path.join(exportDir, 'governance-v2', 'stats.txt'), 'utf8');
    expect(stats).toMatch(/pr: total 1, PASS 1, FAIL 0/);
  }, 60000);
});
