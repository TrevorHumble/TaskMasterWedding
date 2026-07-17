// tests/check-freshness.test.js
// Vitest tests for tools/check-freshness.ps1 (#357 Component A): behind-count
// reporting, the MAX_DRIFT_COMMITS boundary, and overlap detection including
// the append-only carve-out. Windows PowerShell 5.1 is the launcher on win32;
// pwsh on other platforms. Mirrors the git-scratch-repo (makeRepo) and
// -File/-Command split pattern used by tests/classify-dep-pr.test.js.
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

const SCRIPT = path.join(__dirname, '..', 'tools', 'check-freshness.ps1');
const CONFIG_JS = path.join(__dirname, '..', 'config.js');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  }
  return r.stdout;
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// A bare "origin" plus two independent clones: "clone" (the branch under
// test -- stands in for a build session's own branch) and "sibling" (used to
// advance origin/main the way a merging wave-sibling would, independent of
// the clone under test).
function makeOriginAndClones() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const cloneDir = path.join(root, 'clone');
  const siblingDir = path.join(root, 'sibling');

  fs.mkdirSync(originDir);
  git(originDir, ['init', '--bare', '-q']);

  fs.mkdirSync(seedDir);
  git(seedDir, ['init', '-q']);
  git(seedDir, ['config', 'user.name', 'test']);
  git(seedDir, ['config', 'user.email', 'test@example.invalid']);
  writeFile(seedDir, 'README.md', 'seed\n');
  writeFile(seedDir, 'BUILDLOG.md', 'seed log\n');
  writeFile(seedDir, 'src/app.js', 'console.log("v1");\n');
  git(seedDir, ['add', '-A']);
  git(seedDir, ['commit', '-q', '-m', 'seed']);
  git(seedDir, ['branch', '-M', 'main']);
  git(seedDir, ['remote', 'add', 'origin', originDir]);
  git(seedDir, ['push', '-q', 'origin', 'main']);

  git(root, ['clone', '-q', originDir, cloneDir]);
  git(cloneDir, ['checkout', '-q', '-B', 'main', 'origin/main']);
  git(cloneDir, ['config', 'user.name', 'test']);
  git(cloneDir, ['config', 'user.email', 'test@example.invalid']);

  git(root, ['clone', '-q', originDir, siblingDir]);
  git(siblingDir, ['checkout', '-q', '-B', 'main', 'origin/main']);
  git(siblingDir, ['config', 'user.name', 'test']);
  git(siblingDir, ['config', 'user.email', 'test@example.invalid']);

  return { root, originDir, cloneDir, siblingDir };
}

// Push N empty (content-free) commits from the sibling clone, advancing
// origin/main by exactly N commits with no file-level changes -- used for
// pure behind-count assertions where overlap must not fire.
function pushEmptyCommits(siblingDir, n, label) {
  for (let i = 0; i < n; i++) {
    git(siblingDir, ['commit', '-q', '--allow-empty', '-m', `${label} ${i}`]);
  }
  git(siblingDir, ['push', '-q', 'origin', 'main']);
}

function pushFileChange(siblingDir, relPath, content, message) {
  writeFile(siblingDir, relPath, content);
  git(siblingDir, ['add', '-A']);
  git(siblingDir, ['commit', '-q', '-m', message]);
  git(siblingDir, ['push', '-q', 'origin', 'main']);
}

function runCheck(cwd, touches) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
  if (touches) {
    args.push('-Touches', touches);
  }
  const r = spawnSync(PS, args, { cwd, encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping check-freshness tests`)
  : describe;

maybeDescribe('check-freshness.ps1', () => {
  it('up to date: freshly cloned branch at origin/main tip -> 0 behind, exit 0', () => {
    const { cloneDir } = makeOriginAndClones();
    const r = runCheck(cloneDir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('up to date');
  });

  it('behind, no overlap: reports the real commit count and exits 1', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushEmptyCommits(siblingDir, 3, 'unrelated filler');
    const r = runCheck(cloneDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('3 commits behind origin/main');
    expect(r.stdout).not.toContain('OVERLAP');
  });

  it('MAX_DRIFT_COMMITS boundary: exactly at the threshold does not escalate', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushEmptyCommits(siblingDir, 10, 'filler');
    const r = runCheck(cloneDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('10 commits behind origin/main');
    expect(r.stdout).not.toContain('exceeds MAX_DRIFT_COMMITS');
  });

  it('MAX_DRIFT_COMMITS boundary: one past the threshold escalates the message', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushEmptyCommits(siblingDir, 11, 'filler');
    const r = runCheck(cloneDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('11 commits behind origin/main');
    expect(r.stdout).toContain('11 exceeds MAX_DRIFT_COMMITS (10)');
  });

  it('overlap (AC6): a non-carve-out file changed upstream AND touched here is a hard trigger naming the path', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushFileChange(
      siblingDir,
      'src/app.js',
      'console.log("v2 from sibling");\n',
      'sibling rewrites app.js'
    );
    const r = runCheck(cloneDir, 'src/app.js');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OVERLAP: src/app.js');
    expect(r.stdout).toContain('regardless of commit count');
  });

  it('overlap is a hard trigger even at a single commit of drift (regardless of commit count)', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    // Exactly one commit of drift, and it is the overlapping one -- proves
    // the overlap trigger does not depend on crossing MAX_DRIFT_COMMITS.
    pushFileChange(siblingDir, 'src/app.js', 'console.log("v2");\n', 'one-commit rewrite');
    const r = runCheck(cloneDir, 'src/app.js');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OVERLAP: src/app.js');
  });

  it('carve-out (AC6): BUILDLOG.md-only overlap is NOT raised as a hard trigger', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushFileChange(
      siblingDir,
      'BUILDLOG.md',
      'seed log\nsibling appended a line\n',
      'buildlog append'
    );
    const r = runCheck(cloneDir, 'BUILDLOG.md');
    expect(r.status).toBe(1); // still exits 1: behind-count alone still triggers a resync
    expect(r.stdout).not.toContain('OVERLAP');
    expect(r.stdout).toContain('1 commits behind origin/main');
  });

  it('mixed overlap: a real file collides even when BUILDLOG.md also collides alongside it', () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    writeFile(siblingDir, 'src/app.js', 'console.log("v2");\n');
    writeFile(siblingDir, 'BUILDLOG.md', 'seed log\nsibling entry\n');
    git(siblingDir, ['add', '-A']);
    git(siblingDir, ['commit', '-q', '-m', 'app.js + buildlog together']);
    git(siblingDir, ['push', '-q', 'origin', 'main']);
    const r = runCheck(cloneDir, 'src/app.js,BUILDLOG.md');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OVERLAP: src/app.js');
    expect(r.stdout).not.toContain('OVERLAP: BUILDLOG.md');
  });

  it('fetch failure fails loud, never falls back to a stale "up to date"', () => {
    const { cloneDir } = makeOriginAndClones();
    git(cloneDir, ['remote', 'set-url', 'origin', path.join(cloneDir, 'does-not-exist.git')]);
    const r = runCheck(cloneDir);
    expect(r.status).toBe(1);
    expect(r.stdout.toLowerCase()).toContain('fetch failed');
    expect(r.stdout).not.toContain('up to date');
  });

  it("empty -Touches value falls back to the branch's own diff, not a crash", () => {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushEmptyCommits(siblingDir, 1, 'filler');
    const r = runCheck(cloneDir, '');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('1 commits behind origin/main');
  });
});

// Regression guard for /realign step ordering (AC9c). `.claude/commands/realign.md`
// must run the next-batch overlap report BEFORE fast-forwarding local `main` to
// `origin/main`. This test proves WHY: check-freshness.ps1 derives its drift range
// from merge-base(origin/main, HEAD)..origin/main, and in the primary checkout on
// `main`, HEAD == main. While `main` still trails, that range is exactly the
// just-merged commits, so a next-batch file that a sibling just rewrote is caught;
// once `main` is fast-forwarded, the range collapses to empty and the same check
// goes silent. The scenario the review reproduced: a wave merged a feed.ejs
// rewrite and the next batch also touches feed.ejs.
maybeDescribe('realign ordering (AC9c): overlap must be read before fast-forward', () => {
  // A primary-checkout-on-main fixture: `clone` is checked out on `main`, and a
  // sibling has merged a feed.ejs rewrite to origin/main, so `clone`'s local
  // `main` now trails origin/main by exactly that one commit.
  function makePrimaryTrailingMain() {
    const { cloneDir, siblingDir } = makeOriginAndClones();
    pushFileChange(
      siblingDir,
      'src/views/feed.ejs',
      '<div>feed v2 rewritten</div>\n',
      'wave rewrote feed.ejs'
    );
    return { cloneDir };
  }

  it('BEFORE fast-forward (correct realign order): the next-batch overlap fires', () => {
    const { cloneDir } = makePrimaryTrailingMain();
    // realign step 2, run while local `main` still trails origin/main.
    const r = runCheck(cloneDir, 'src/views/feed.ejs');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('OVERLAP: src/views/feed.ejs');
  });

  it('AFTER fast-forward (the dead-code order the defect described): the check goes silent', () => {
    const { cloneDir } = makePrimaryTrailingMain();
    // Fast-forward local `main` first (the reversed order), then run the check:
    // the drift range is now empty, so no -Touches value can ever overlap it.
    // The fetch mirrors realign's own step 1 (without it, the clone's local
    // origin/main ref is still stale and the ff-only merge is a no-op, which
    // would mask the point of the test).
    git(cloneDir, ['fetch', 'origin']);
    git(cloneDir, ['merge', '--ff-only', 'origin/main']);
    const r = runCheck(cloneDir, 'src/views/feed.ejs');
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('OVERLAP');
    expect(r.stdout).toContain('up to date');
  });
});

// AC7: MAX_DRIFT_COMMITS is defined exactly once, in check-freshness.ps1, and
// config.js does not duplicate it (single-homed fact, one owner).
describe('MAX_DRIFT_COMMITS single-homing (AC7)', () => {
  it('is assigned exactly once in check-freshness.ps1', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const assignments = src.match(/\$MAX_DRIFT_COMMITS\s*=\s*10/g) || [];
    expect(assignments).toHaveLength(1);
  });

  it('config.js does not define MAX_DRIFT_COMMITS', () => {
    const src = fs.readFileSync(CONFIG_JS, 'utf8');
    expect(src).not.toMatch(/MAX_DRIFT_COMMITS/);
  });
});

// Pure-function tests for the shared Test-CarvedOut / Get-OverlapFiles helpers
// via dot-source -- fast, no git repo needed.
function runOverlapHelper(driftFiles, touchFiles) {
  const driftExpr = driftFiles.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const touchExpr = touchFiles.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const cmd = `. '${SCRIPT}'; (Get-OverlapFiles -DriftFiles @(${driftExpr}) -TouchFiles @(${touchExpr})) -join '|'`;
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

const maybeDescribeHelpers = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping Get-OverlapFiles tests`)
  : describe;

maybeDescribeHelpers('Get-OverlapFiles / Test-CarvedOut (dot-sourced)', () => {
  it('empty drift list -> no overlap regardless of touch list', () => {
    expect(runOverlapHelper([], ['src/app.js'])).toBe('');
  });

  it('duplicate entries in the touch list are not double-reported', () => {
    const out = runOverlapHelper(['src/app.js'], ['src/app.js', 'src/app.js']);
    expect(out.split('|')).toEqual(['src/app.js']);
  });

  it('BUILDLOG.md is excluded even when it is in both lists', () => {
    expect(runOverlapHelper(['BUILDLOG.md', 'src/app.js'], ['BUILDLOG.md', 'src/app.js'])).toBe(
      'src/app.js'
    );
  });
});
