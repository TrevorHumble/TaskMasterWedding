// tests/commit-gate-trivial-dep-bump.test.js
// Vitest tests for the trivial dep-bump commit-gate exemption (#448 AC6-9):
// a staged manifest-only bump that classifies 'trivial' under
// tools/classify-trivial-commit.ps1, plus a 'chore(deps): '-prefixed commit
// subject, passes both hooks with no review evidence and no reviewed issue
// -- matching the Dependabot auto-merge path. Any other condition takes the
// full gate, unchanged (regression guard). Mirrors the scratch-git-repo
// hook-integration pattern in tests/governance-ledger.test.js's "commit-msg
// ledger exemption" describe block.
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

// Cross-platform hook harness bridge.
//
// The real hooks resolve PowerShell via `command -v powershell` (they target
// the Windows commit environment on purpose). GitHub's Linux runners ship
// PowerShell only as `pwsh` -- there is NO `powershell` command there -- so a
// spawned hook cannot launch PowerShell on CI and fails closed to "block",
// which breaks the two hook-integration assertions that expect a commit to
// SUCCEED. Making the hooks themselves cross-platform is a separate issue;
// here we fix only the TEST HARNESS: on non-win32 we create a shim directory
// holding an executable named `powershell` that forwards every arg to `pwsh`,
// and prepend that directory to the PATH of every hook-invoking child in this
// file. So the spawned hook exercises the genuine PowerShell path identically
// on Windows (native `powershell`) and Linux (`powershell` -> `pwsh`). The
// forwarded flags (-NoProfile -ExecutionPolicy Bypass -File/-Command) are the
// exact flags other test files (e.g. classify-dep-pr.test.js) already run
// against `pwsh` green on Linux CI, so the forwarding target is proven-good.
// If PowerShell is absent entirely, `launcherMissing` above already skips the
// whole suite, so no shim is ever needed in that case.
function buildHookEnv() {
  if (process.platform === 'win32' || launcherMissing) {
    return process.env; // native `powershell` exists (win32), or suite is skipped
  }
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-shim-'));
  const shimPath = path.join(shimDir, 'powershell');
  fs.writeFileSync(shimPath, '#!/bin/sh\nexec pwsh "$@"\n');
  fs.chmodSync(shimPath, 0o755);
  return { ...process.env, PATH: shimDir + path.delimiter + process.env.PATH };
}

const HOOK_ENV = buildHookEnv();

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivial-gate-'));
  const run = (args, opts) => {
    // env: HOOK_ENV is applied to EVERY spawn in this repo helper (not just the
    // two success-path tests) so the block-path and success-path assertions run
    // the identical hook environment on both platforms.
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: HOOK_ENV, ...opts });
    return {
      status: r.status === null ? 1 : r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    };
  };
  run(['init', '-q']);
  run(['config', 'user.name', 'test']);
  run(['config', 'user.email', 'test@example.invalid']);
  // core.hooksPath is set AFTER the seed commit below, not before: the seed
  // commit establishes HEAD:package.json for the classifier to diff against,
  // and it must not itself be gated (this test exercises the gate on the
  // commit that follows the seed, not on the seed's own creation).
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.mkdirSync(path.join(dir, 'governance'));
  fs.copyFileSync(
    path.join(REPO_ROOT, '.githooks', 'pre-commit'),
    path.join(dir, '.githooks', 'pre-commit')
  );
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
    'classify-trivial-commit.ps1',
    'classify-dep-pr-core.ps1',
  ]) {
    fs.copyFileSync(path.join(REPO_ROOT, 'tools', t), path.join(dir, 'tools', t));
  }
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  fs.chmodSync(path.join(dir, '.githooks', 'commit-msg'), 0o755);

  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: { express: '^4.21.2' },
    devDependencies: {},
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), makeLockfileForExpress('4.21.2'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  run(['add', '-A']);
  const seed = run(['commit', '-q', '-m', 'seed']);
  if (seed.status !== 0) {
    throw new Error(`seed commit failed:\n${seed.stderr}`);
  }
  run(['config', 'core.hooksPath', '.githooks']);
  return { dir, run };
}

// A real npm lockfileVersion-3 `packages` map, confined to a single express
// entry -- #467's classify-trivial-commit.ps1 now examines the lockfile's
// CONTENT (not just its staged path), so the seed/staged fixture pair must be
// a real, mutually-consistent lockfile shape for the AC6/hotfix-bypass cases
// below to still classify 'trivial': the placeholder '{}' / '{"changed":true}'
// pair this file used before #467 has no `packages` object, which condition 4
// now (correctly) fails closed on.
function makeLockfileForExpress(version) {
  return (
    JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'fixture', version: '1.0.0', dependencies: { express: `^${version}` } },
          'node_modules/express': {
            version,
            resolved: `https://registry.npmjs.org/express/-/express-${version}.tgz`,
            integrity: `sha512-fixture-${version}`,
          },
        },
      },
      null,
      2
    ) + '\n'
  );
}

function stageTrivialBump(dir, run) {
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: { express: '^4.22.2' },
    devDependencies: {},
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), makeLockfileForExpress('4.22.2'));
  run(['add', 'package.json', 'package-lock.json']);
}

function stageStandardBump(dir, run) {
  // A major bump is never 'auto' under the tier rules -- classifies standard.
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: { express: '^5.0.0' },
    devDependencies: {},
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"changed":true}\n');
  run(['add', 'package.json', 'package-lock.json']);
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping commit-gate-trivial-dep-bump tests`)
  : describe;

maybeDescribe('trivial dep-bump commit-gate exemption (#448 AC6-9)', () => {
  it('AC6: trivial-classified state + "chore(deps): " subject -> commit succeeds with no evidence, no issue', () => {
    const { dir, run } = makeRepo();
    stageTrivialBump(dir, run);
    const r = run(['commit', '-m', 'chore(deps): bump express 4.21.2 -> 4.22.2']);
    expect(r.status).toBe(0);
  }, 60000);

  it('AC7: trivial-classified state but subject lacks the "chore(deps): " prefix -> blocked', () => {
    const { dir, run } = makeRepo();
    stageTrivialBump(dir, run);
    const r = run(['commit', '-m', 'bump express 4.21.2 -> 4.22.2']);
    expect(r.status).not.toBe(0);
  }, 60000);

  it('AC8: standard-classified state (major bump) with no review evidence -> blocked (regression guard)', () => {
    const { dir, run } = makeRepo();
    stageStandardBump(dir, run);
    const r = run(['commit', '-m', 'chore(deps): bump express to 5.0.0']);
    expect(r.status).not.toBe(0);
  }, 60000);

  it('AC9: classifier script missing -> fails closed, full gate applies (blocked)', () => {
    const { dir, run } = makeRepo();
    // Remove the classifier so classifier_says_trivial cannot find it.
    fs.unlinkSync(path.join(dir, 'tools', 'classify-trivial-commit.ps1'));
    stageTrivialBump(dir, run);
    const r = run(['commit', '-m', 'chore(deps): bump express 4.21.2 -> 4.22.2']);
    expect(r.status).not.toBe(0);
  }, 60000);

  it('a non-dep-bump code commit with no evidence is still blocked (baseline, unaffected by #448)', () => {
    const { dir, run } = makeRepo();
    fs.writeFileSync(path.join(dir, 'src.js'), '// x\n');
    run(['add', 'src.js']);
    const r = run(['commit', '-m', 'feat: add a file (#1)']);
    expect(r.status).not.toBe(0);
  }, 60000);

  // Ordering seam (round-1 review): during an ACTIVE event-mode window a
  // 'hotfix: ' commit whose staged tree happens to be a manifest-only trivial
  // bump must still reach the event-mode 'hotfix: ' bypass -- the trivial
  // block must NOT run its fall-through evidence_gate and block it first
  // (which would silently narrow the documented event-mode exemption). The
  // event-mode-core.ps1 the hook needs is already copied by makeRepo().
  it('ACTIVE event mode + "hotfix: " subject + manifest-only trivial bump -> succeeds via the hotfix bypass', () => {
    const { dir, run } = makeRepo();
    // ACTIVE flag: a valid em1 with a far-future expiry, written to the
    // working tree but NOT staged (so the staged tree stays manifest-only
    // and the classifier still returns 'trivial').
    fs.writeFileSync(
      path.join(dir, 'governance', 'event-mode.json'),
      JSON.stringify({
        schema: 'em1',
        expires: '2099-01-01T00:00:00Z',
        reason: 'test',
        created: '2026-07-01T00:00:00Z',
      })
    );
    stageTrivialBump(dir, run);
    const r = run(['commit', '-m', 'hotfix: patch express during the event']);
    expect(r.status).toBe(0);
  }, 60000);

  // Fail-closed complement: same ACTIVE-event-mode + trivial-bump staged tree
  // but a subject that is neither 'chore(deps): ' nor 'hotfix: ' -> still
  // blocked. The gate is relocated to the event-mode block, never skipped.
  it('ACTIVE event mode + non-hotfix/non-chore(deps) subject + trivial bump -> still blocked (gate relocated, not skipped)', () => {
    const { dir, run } = makeRepo();
    fs.writeFileSync(
      path.join(dir, 'governance', 'event-mode.json'),
      JSON.stringify({
        schema: 'em1',
        expires: '2099-01-01T00:00:00Z',
        reason: 'test',
        created: '2026-07-01T00:00:00Z',
      })
    );
    stageTrivialBump(dir, run);
    const r = run(['commit', '-m', 'bump express during the event']);
    expect(r.status).not.toBe(0);
  }, 60000);
});
