// tests/deploy-script.test.js
// Issue #562 AC3 (refuses a dirty tree), AC4 (verifies itself and reports
// the landed commit), and AC6 (the deploy workflow's trigger is an
// allowlist of exactly workflow_dispatch). Never stands up a real host, a
// real `ssh` connection, or a real Docker daemon — tools/deploy.sh's git
// calls run against a throwaway temp repo, `docker` is a stub script placed
// earlier on PATH, and the healthz probe is a local HTTP server. AC1/AC2 are
// covered instead by tests/healthz-commit.test.js.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const config = require('../config');

const DEPLOY_SCRIPT = path.join(config.ROOT, 'tools', 'deploy.sh');

// Locate a bash interpreter to run tools/deploy.sh under. On Linux CI, `bash`
// on PATH is always there. On this Windows dev host, Git for Windows ships
// bash.exe under its own install root but does NOT put it on the PATH that
// npm/vitest's child process inherits (only Git\cmd and Git\mingw64\bin are
// on it) -- so `bash` alone resolves for an interactive Git Bash shell but
// not for a plain `npm run test:coverage` invocation. Resolved once, at
// import time, from wherever git.exe itself is (a sibling `bin/bash.exe`),
// so this does not depend on a specific username's install path.
function resolveBash() {
  const direct = spawnSync('bash', ['-c', 'exit 0']);
  if (!direct.error) return 'bash';
  if (process.platform === 'win32') {
    try {
      const gitExe = execFileSync('where', ['git.exe'], { encoding: 'utf8' })
        .split(/\r?\n/)[0]
        .trim();
      if (gitExe) {
        // gitExe is typically .../Git/cmd/git.exe; bash.exe lives at .../Git/bin/bash.exe.
        const candidate = path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // fall through to the fixed fallback below
    }
    const fallback = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(fallback)) return fallback;
  }
  throw new Error(
    'tests/deploy-script.test.js: could not locate a bash interpreter to run tools/deploy.sh under test.'
  );
}

const BASH = resolveBash();

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * A throwaway "origin" (bare repo) plus a working clone tracking `main`,
 * with one commit already pushed. Deploy.sh's unconditional `git fetch` and
 * `git checkout <target>` both need a real remote to resolve `origin/main`
 * against, so the fixture wires one up locally (no network involved).
 */
function makeGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-script-git-'));
  const originDir = path.join(root, 'origin.git');
  const repoDir = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', originDir]);
  execFileSync('git', ['clone', '-q', originDir, repoDir]);
  git(repoDir, ['config', 'user.email', 'test@example.invalid']);
  git(repoDir, ['config', 'user.name', 'Deploy Script Test']);
  git(repoDir, ['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'file.txt'), 'hello\n');
  git(repoDir, ['add', 'file.txt']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
  git(repoDir, ['push', '-q', '-u', 'origin', 'main']);
  const sha = git(repoDir, ['rev-parse', 'HEAD']).trim();
  return { root, repoDir, sha };
}

/** A stub `docker` on PATH that always succeeds and does nothing real. */
function makeDockerStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-script-dockerstub-'));
  const callLog = path.join(dir, 'docker.calls.log');
  const scriptPath = path.join(dir, 'docker');
  fs.writeFileSync(
    scriptPath,
    ['#!/usr/bin/env bash', `echo "$@" >> "${callLog.replace(/\\/g, '/')}"`, 'exit 0', ''].join(
      '\n'
    )
  );
  fs.chmodSync(scriptPath, 0o755);
  return { dir, callLog };
}

function pathWithStubFirst(stubDir) {
  return `${stubDir}${path.delimiter}${process.env.PATH}`;
}

/**
 * Runs tools/deploy.sh via bash (portable across the Windows dev host and
 * Linux CI). Deliberately ASYNC (spawn, not spawnSync): several of these
 * tests need a local HTTP server, running in THIS SAME Node process, to
 * answer a request while deploy.sh's `curl` polls it. spawnSync blocks
 * Node's single event loop for the whole child's lifetime, which would
 * starve that in-process server of the chance to ever accept the
 * connection — the poll would hang until deploy.sh's own bounded timeout,
 * or (if that were ever misconfigured) indefinitely. spawn() keeps the
 * event loop free the whole time, exactly like a real deploy talking to a
 * server in a different process.
 */
function runDeploy(cwd, args, envOverrides) {
  return new Promise((resolve) => {
    const child = spawn(BASH, [DEPLOY_SCRIPT, ...args], {
      cwd,
      env: Object.assign({}, process.env, envOverrides),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('close', (status) => {
      clearTimeout(killTimer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** A local HTTP server standing in for the app's /healthz during AC4 tests. */
function startHealthzServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/healthz') return handler(req, res);
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ url: `http://127.0.0.1:${port}/healthz`, close: () => srv.close() });
    });
  });
}

function healthyJsonHandler(commit) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, commit }));
  };
}

describe('AC3: tools/deploy.sh refuses a dirty tree, before any fetch/build', () => {
  it('exits non-zero, names the offending path, and never invokes docker', async () => {
    const { repoDir } = makeGitRepo();
    const { dir: dockerStubDir, callLog } = makeDockerStub();
    fs.appendFileSync(path.join(repoDir, 'file.txt'), 'a local, uncommitted edit\n');

    const result = await runDeploy(repoDir, [], { PATH: pathWithStubFirst(dockerStubDir) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('file.txt');
    expect(result.stderr.toLowerCase()).toContain('uncommitted');
    // The whole point of AC3: a dirty tree must fail BEFORE any build/pull —
    // confirm no docker command ever ran, not just that the exit was non-zero.
    expect(fs.existsSync(callLog)).toBe(false);
  });

  it('a clean tree is not rejected by this check (control case)', async () => {
    const { repoDir, sha } = makeGitRepo();
    const { dir: dockerStubDir } = makeDockerStub();
    // No dirty-tree message this time (may still fail later at healthz —
    // this test only asserts the dirty-tree gate does not fire).
    const result = await runDeploy(repoDir, ['main'], {
      PATH: pathWithStubFirst(dockerStubDir),
      DEPLOY_HEALTHZ_URL: 'http://127.0.0.1:1/healthz', // nothing listens here
      DEPLOY_HEALTHZ_TIMEOUT_SECS: '1',
      DEPLOY_HEALTHZ_POLL_INTERVAL_SECS: '1',
    });
    expect(result.stderr).not.toContain('uncommitted changes');
    expect(sha).toHaveLength(40);
  });
});

describe('AC4: tools/deploy.sh verifies itself and reports the landed commit', () => {
  it('exits 0 and prints the commit when the live app reports the resolved target SHA', async () => {
    const { repoDir, sha } = makeGitRepo();
    const { dir: dockerStubDir, callLog } = makeDockerStub();
    const server = await startHealthzServer(healthyJsonHandler(sha));
    try {
      const result = await runDeploy(repoDir, ['main'], {
        PATH: pathWithStubFirst(dockerStubDir),
        DEPLOY_HEALTHZ_URL: server.url,
        DEPLOY_HEALTHZ_TIMEOUT_SECS: '5',
        DEPLOY_HEALTHZ_POLL_INTERVAL_SECS: '1',
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(sha);
      // Confirm the build actually ran, and carried the resolved SHA as the
      // build-arg — a deploy that skipped building would be a false pass.
      const calls = fs.readFileSync(callLog, 'utf8');
      expect(calls).toContain(`GIT_SHA=${sha}`);
      expect(calls).toContain('up -d');
    } finally {
      server.close();
    }
  });

  it('exits non-zero when the live commit does NOT match the requested target', async () => {
    const { repoDir } = makeGitRepo();
    const { dir: dockerStubDir } = makeDockerStub();
    const server = await startHealthzServer(
      healthyJsonHandler('0000000000000000000000000000000000dead')
    );
    try {
      const result = await runDeploy(repoDir, ['main'], {
        PATH: pathWithStubFirst(dockerStubDir),
        DEPLOY_HEALTHZ_URL: server.url,
        DEPLOY_HEALTHZ_TIMEOUT_SECS: '5',
        DEPLOY_HEALTHZ_POLL_INTERVAL_SECS: '1',
      });
      // This is the whole point of AC4: a deploy that lands the wrong
      // commit must fail loudly, not print a mismatch and exit 0.
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('does not match');
    } finally {
      server.close();
    }
  });

  it('exits non-zero when /healthz never reports healthy (bounded timeout path)', async () => {
    const { repoDir } = makeGitRepo();
    const { dir: dockerStubDir } = makeDockerStub();
    // Port 1 is a privileged, never-listened-on port -- nothing answers here,
    // every attempt fails to connect, so the loop must exhaust its timeout.
    const start = Date.now();
    const result = await runDeploy(repoDir, ['main'], {
      PATH: pathWithStubFirst(dockerStubDir),
      DEPLOY_HEALTHZ_URL: 'http://127.0.0.1:1/healthz',
      DEPLOY_HEALTHZ_TIMEOUT_SECS: '2',
      DEPLOY_HEALTHZ_POLL_INTERVAL_SECS: '1',
    });
    const elapsedMs = Date.now() - start;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('never reported healthy');
    // Bounded: the timeout is what ends the loop, not an unbounded hang.
    expect(elapsedMs).toBeLessThan(15000);
  });

  it('exits non-zero for a target that does not exist, with a clear message', async () => {
    const { repoDir } = makeGitRepo();
    const { dir: dockerStubDir, callLog } = makeDockerStub();
    const result = await runDeploy(repoDir, ['refs/does-not-exist-anywhere'], {
      PATH: pathWithStubFirst(dockerStubDir),
    });
    expect(result.status).not.toBe(0);
    // Fails at `git checkout` (via `set -e`), before ever reaching docker.
    expect(fs.existsSync(callLog)).toBe(false);
  });
});

describe('AC6: .github/workflows/deploy.yml — on: is workflow_dispatch and nothing else', () => {
  // A narrow, purpose-built reader (no YAML dependency — package.json has
  // none, and tests/compose-port-binding.test.js is the established
  // precedent for this shape of check). Finds the top-level "on:" key by
  // exact line match at column 0, then collects the keys at the FIRST child
  // indentation level under it, ignoring anything nested deeper (e.g.
  // workflow_dispatch's own "inputs:" block) so those never get mistaken for
  // sibling triggers.
  function readOnTriggerKeys(workflowYaml) {
    const lines = workflowYaml.split('\n');
    let onIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const indent = lines[i].length - lines[i].trimStart().length;
      if (indent === 0 && lines[i].trim() === 'on:') {
        onIdx = i;
        break;
      }
    }
    if (onIdx === -1) return [];

    let childIndent = null;
    const keys = [];
    for (let i = onIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) break; // left the on: block entirely
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue; // nested under a trigger key, not itself one
      const match = line.trim().match(/^([A-Za-z_][\w-]*)\s*:/);
      if (match) keys.push(match[1]);
    }
    return keys;
  }

  it('control: reads exactly ["workflow_dispatch"] from a single-trigger fixture', () => {
    const fixture = [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      commit:',
      '        default: origin/main',
      '',
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    expect(readOnTriggerKeys(fixture)).toEqual(['workflow_dispatch']);
  });

  it('proves the reader is NOT blind to an added trigger — the YAML-1.1 "on:" boolean trap', () => {
    // A real YAML-1.1 parser reads the bare key `on` as the boolean `true`,
    // not the string "on" -- doc.on comes back undefined, an allowlist check
    // over its (nonexistent) keys sees an empty set, and passes even though
    // this fixture carries a second, unattended `push:` trigger. That false
    // green is exactly why this file uses a hand-written reader instead of a
    // YAML library. Before trusting the reader above, prove it does NOT
    // exhibit that blindness: fed this hazardous fixture, it must report
    // BOTH keys, which makes the allowlist assertion fail on it, as it
    // should.
    const hazardFixture = [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      commit:',
      '        default: origin/main',
      '  push:',
      '    branches: [main]',
      '',
      'jobs:',
      '  deploy:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    const keys = readOnTriggerKeys(hazardFixture);
    expect(keys).toEqual(['workflow_dispatch', 'push']);
    // The actual allowlist assertion the real-file test below applies would
    // fail on this fixture, exactly as it must.
    expect(keys.length === 1 && keys[0] === 'workflow_dispatch').toBe(false);
  });

  it('the real .github/workflows/deploy.yml carries workflow_dispatch and no other trigger', () => {
    const workflowYaml = fs.readFileSync(
      path.join(config.ROOT, '.github', 'workflows', 'deploy.yml'),
      'utf8'
    );
    const keys = readOnTriggerKeys(workflowYaml);
    expect(keys).toEqual(['workflow_dispatch']);
  });
});
