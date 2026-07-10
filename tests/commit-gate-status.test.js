// tests/commit-gate-status.test.js
// Vitest tests for tools/commit-gate-status.ps1 (#376): single-owner
// Test-CommitGateActive truth table (AC5), and behavioral proof that
// session-greeting.ps1 delegates to it instead of its old pre-commit-only
// inline composition (AC3/AC4). Windows PowerShell 5.1 is the launcher on
// win32; pwsh on other platforms. Mirrors the git-scratch-repo pattern used
// by tests/check-freshness.test.js.
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

const REPO_ROOT = path.join(__dirname, '..');
const HELPER_SCRIPT = path.join(REPO_ROOT, 'tools', 'commit-gate-status.ps1');
const GREETING_SCRIPT = path.join(REPO_ROOT, '.claude', 'hooks', 'session-greeting.ps1');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  }
  return r.stdout;
}

// A throwaway scratch repo -- never the worktree under test. hooksPath and
// .githooks/* files are set up per-scenario so the real repo's git config
// and .githooks are never touched.
function makeScratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitgate-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  // session-greeting.ps1 dot-sources tools/commit-gate-status.ps1 relative to
  // its own repo top, so the scratch repo needs its own copy of the helper.
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.copyFileSync(HELPER_SCRIPT, path.join(dir, 'tools', 'commit-gate-status.ps1'));
  return dir;
}

function setHooksPath(dir, value) {
  if (value === null) {
    spawnSync('git', ['-C', dir, 'config', '--unset', 'core.hooksPath'], { encoding: 'utf8' });
  } else {
    git(dir, ['config', 'core.hooksPath', value]);
  }
}

function writeHookFiles(dir, { preCommit, commitMsg }) {
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  if (preCommit) {
    fs.writeFileSync(path.join(dir, '.githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  } else {
    const p = path.join(dir, '.githooks', 'pre-commit');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (commitMsg) {
    fs.writeFileSync(path.join(dir, '.githooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
  } else {
    const p = path.join(dir, '.githooks', 'commit-msg');
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function callTestCommitGateActive(top) {
  const cmd = `. '${HELPER_SCRIPT}'; if (Test-CommitGateActive '${top}') { 'true' } else { 'false' }`;
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

// The pre-#376 composition (pre-commit only) -- used to prove the new test
// would actually catch the regression this issue fixes.
function oldPreCommitOnlyComposition(top) {
  const cmd = `$hp = "$(& git -C '${top}' config --get core.hooksPath)".Trim(); ($hp -eq '.githooks') -and (Test-Path (Join-Path '${top}' '.githooks/pre-commit'))`;
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
  });
  return (r.stdout || '').trim();
}

function runGreeting(cwd) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GREETING_SCRIPT], {
    cwd,
    encoding: 'utf8',
  });
  let systemMessage;
  try {
    systemMessage = JSON.parse((r.stdout || '').trim() || '{}').systemMessage || '';
  } catch {
    systemMessage = '';
  }
  return { status: r.status, stdout: r.stdout || '', systemMessage };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping commit-gate-status tests`)
  : describe;

maybeDescribe('Test-CommitGateActive (AC5 truth table)', () => {
  it('hooksPath=.githooks, both hooks present -> true', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, '.githooks');
    writeHookFiles(dir, { preCommit: true, commitMsg: true });
    expect(callTestCommitGateActive(dir)).toBe('true');
  });

  it('hooksPath=.githooks, commit-msg absent -> false (the AC5 regression case)', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, '.githooks');
    writeHookFiles(dir, { preCommit: true, commitMsg: false });
    expect(callTestCommitGateActive(dir)).toBe('false');
    // Prove the test would have FAILED under the old pre-commit-only logic:
    // that composition reports 'true' for this exact state, which is the
    // false-reassurance defect #376 fixes.
    expect(oldPreCommitOnlyComposition(dir)).toBe('True');
  });

  it('hooksPath=other, both hooks present -> false', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, 'other-path');
    writeHookFiles(dir, { preCommit: true, commitMsg: true });
    expect(callTestCommitGateActive(dir)).toBe('false');
  });

  it('hooksPath=other, commit-msg absent -> false', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, 'other-path');
    writeHookFiles(dir, { preCommit: true, commitMsg: false });
    expect(callTestCommitGateActive(dir)).toBe('false');
  });

  it('hooksPath=.githooks, pre-commit absent, commit-msg present -> false', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, '.githooks');
    writeHookFiles(dir, { preCommit: false, commitMsg: true });
    expect(callTestCommitGateActive(dir)).toBe('false');
  });
});

maybeDescribe('session-greeting.ps1 delegation (AC3/AC4)', () => {
  it('AC4: both hooks present -> greeting reports commit gate active / protected', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, '.githooks');
    writeHookFiles(dir, { preCommit: true, commitMsg: true });
    const r = runGreeting(dir);
    expect(r.systemMessage).toContain('commit gate active');
    expect(r.systemMessage).toContain("You're protected");
  });

  it('AC3: pre-commit present, commit-msg absent -> greeting does NOT report active/protected', () => {
    const dir = makeScratchRepo();
    setHooksPath(dir, '.githooks');
    writeHookFiles(dir, { preCommit: true, commitMsg: false });
    const r = runGreeting(dir);
    expect(r.systemMessage).not.toContain('commit gate active');
    expect(r.systemMessage).not.toContain("You're protected");
  });
});

describe('single-owner composition (AC1/AC2)', () => {
  it('the pre-commit AND commit-msg composition appears only in commit-gate-status.ps1', () => {
    const helperSrc = fs.readFileSync(HELPER_SCRIPT, 'utf8');
    expect(helperSrc).toMatch(/function Test-CommitGateActive/);
    expect(helperSrc).toContain('.githooks/pre-commit');
    expect(helperSrc).toContain('.githooks/commit-msg');
  });

  it('session-greeting.ps1 no longer composes the condition inline', () => {
    const src = fs.readFileSync(GREETING_SCRIPT, 'utf8');
    expect(src).not.toMatch(/Test-Path.*\.githooks\/pre-commit.*-and/);
    expect(src).toMatch(/Test-CommitGateActive/);
  });

  it('check-enforcement.ps1 no longer composes the condition inline', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'check-enforcement.ps1'), 'utf8');
    expect(src).not.toMatch(
      /-and \(Test-Path '\.githooks\/pre-commit'\) -and \(Test-Path '\.githooks\/commit-msg'\)/
    );
    expect(src).toMatch(/Test-CommitGateActive/);
  });
});
