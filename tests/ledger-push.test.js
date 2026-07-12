// tests/ledger-push.test.js
// Vitest tests for issue #228 — scripts/ledger-push.js ACs 2-3: the CI
// appender's materialize/commit/push mechanics against a local bare remote.
// No network, no GitHub: the "remote" is a bare repo on disk.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ledger-push.js');
const LEDGER_REL = path.join('governance', 'ledger.ndjson');

const ROW1 = JSON.stringify({ schema: 'gl1', pr: 1, issue: 10, reviews: [] });
const ROW2 = JSON.stringify({ schema: 'gl1', pr: 2, issue: 11, reviews: [] });

function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function runCli(repoDir, mode) {
  const r = spawnSync(process.execPath, [SCRIPT, mode], {
    encoding: 'utf8',
    env: { ...process.env, LEDGER_REPO_DIR: repoDir, LEDGER_REMOTE: 'origin' },
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

// Work repo (seeded main with an empty ledger) + bare origin.
function makeRepos() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-push-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(bare);
  fs.mkdirSync(work);
  git(bare, ['init', '--bare', '-q']);
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.name', 'test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(work, 'governance'));
  fs.writeFileSync(path.join(work, LEDGER_REL), '');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'seed']);
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', 'origin', 'main']);
  return { bare, work };
}

function bareShow(bare, ref) {
  return git(bare, ['show', `${ref}:governance/ledger.ndjson`]);
}

function bareShowFile(bare, ref, filePath) {
  return git(bare, ['show', `${ref}:${filePath}`]);
}

describe('ledger-push (AC2, AC3)', () => {
  it('AC2: materialize + append + push -> ledger branch has both rows, main untouched', () => {
    const { bare, work } = makeRepos();

    // First harvest run: no ledger branch yet; --materialize keeps the seed.
    const m1 = runCli(work, '--materialize');
    expect(m1.status).toBe(0);
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    expect(runCli(work, '--push').status).toBe(0);
    expect(bareShow(bare, 'ledger')).toBe(ROW1 + '\n');

    const mainBefore = git(bare, ['rev-parse', 'main']).trim();

    // Second harvest run: fresh main checkout state (seed is empty again).
    fs.writeFileSync(path.join(work, LEDGER_REL), '');
    const m2 = runCli(work, '--materialize');
    expect(m2.status).toBe(0);
    // The branch's current row is materialized into the working copy...
    expect(fs.readFileSync(path.join(work, LEDGER_REL), 'utf8')).toBe(ROW1 + '\n');
    // ...the harvester appends a new row...
    fs.appendFileSync(path.join(work, LEDGER_REL), ROW2 + '\n');
    // ...and --push lands BOTH rows on the remote ledger branch.
    expect(runCli(work, '--push').status).toBe(0);
    expect(bareShow(bare, 'ledger')).toBe(ROW1 + '\n' + ROW2 + '\n');

    // main is untouched.
    expect(git(bare, ['rev-parse', 'main']).trim()).toBe(mainBefore);
  }, 60000);

  it('AC3: no new rows after materialize -> --push exits 0 with no new commit', () => {
    const { bare, work } = makeRepos();
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    expect(runCli(work, '--push').status).toBe(0);
    const tipBefore = git(bare, ['rev-parse', 'ledger']).trim();

    fs.writeFileSync(path.join(work, LEDGER_REL), '');
    expect(runCli(work, '--materialize').status).toBe(0);
    const r = runCli(work, '--push');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to commit');
    expect(git(bare, ['rev-parse', 'ledger']).trim()).toBe(tipBefore);
  }, 60000);

  it('ledger commits are parented on the branch tip, not on main', () => {
    const { bare, work } = makeRepos();
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    expect(runCli(work, '--push').status).toBe(0);
    const firstTip = git(bare, ['rev-parse', 'ledger']).trim();

    fs.writeFileSync(path.join(work, LEDGER_REL), '');
    expect(runCli(work, '--materialize').status).toBe(0);
    fs.appendFileSync(path.join(work, LEDGER_REL), ROW2 + '\n');
    expect(runCli(work, '--push').status).toBe(0);

    const parent = git(bare, ['rev-parse', 'ledger^']).trim();
    expect(parent).toBe(firstTip);
  }, 60000);

  it('unknown mode -> exit 1 with usage', () => {
    const { work } = makeRepos();
    const r = runCli(work, '--bogus');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage');
  }, 60000);
});

// #447 AC5: the rendered BUILDLOG.md, when present in the working copy,
// commits alongside governance/ledger.ndjson in the SAME commit.
describe('ledger-push + rendered BUILDLOG.md (#447 AC5)', () => {
  it('BUILDLOG.md present -> one commit carries both files', () => {
    const { bare, work } = makeRepos();
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    fs.writeFileSync(path.join(work, 'BUILDLOG.md'), '# Build Log\n\n- rendered entry\n');

    expect(runCli(work, '--push').status).toBe(0);
    // Both files are readable at the SAME tip commit -- one commit, both
    // files, never a ledger commit followed by a separate BUILDLOG commit.
    expect(bareShow(bare, 'ledger')).toBe(ROW1 + '\n');
    expect(bareShowFile(bare, 'ledger', 'BUILDLOG.md')).toBe('# Build Log\n\n- rendered entry\n');
    const filesAtTip = git(bare, ['ls-tree', '-r', '--name-only', 'ledger'])
      .trim()
      .split('\n')
      .sort();
    expect(filesAtTip).toEqual(['BUILDLOG.md', 'governance/ledger.ndjson']);
  }, 60000);

  it('no BUILDLOG.md in working copy -> ledger-only commit, unchanged pre-#447 behavior', () => {
    const { bare, work } = makeRepos();
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    expect(runCli(work, '--push').status).toBe(0);
    expect(bareShow(bare, 'ledger')).toBe(ROW1 + '\n');
    const r = git(bare, ['ls-tree', '-r', '--name-only', 'ledger']);
    expect(r.split('\n').filter(Boolean)).toEqual(['governance/ledger.ndjson']);
  }, 60000);

  it('ledger unchanged but BUILDLOG.md content changed -> still commits (not a pure ledger-diff no-op)', () => {
    const { bare, work } = makeRepos();
    fs.writeFileSync(path.join(work, LEDGER_REL), ROW1 + '\n');
    fs.writeFileSync(path.join(work, 'BUILDLOG.md'), 'v1\n');
    expect(runCli(work, '--push').status).toBe(0);
    const tipBefore = git(bare, ['rev-parse', 'ledger']).trim();

    // Materialize re-seeds the ledger to the branch's current content
    // (unchanged), but the rendered file changed (e.g. re-rendered wording).
    fs.writeFileSync(path.join(work, LEDGER_REL), '');
    expect(runCli(work, '--materialize').status).toBe(0);
    fs.writeFileSync(path.join(work, 'BUILDLOG.md'), 'v2\n');
    const r = runCli(work, '--push');
    expect(r.status).toBe(0);
    expect(bareShowFile(bare, 'ledger', 'BUILDLOG.md')).toBe('v2\n');
    expect(git(bare, ['rev-parse', 'ledger']).trim()).not.toBe(tipBefore);
  }, 60000);
});
