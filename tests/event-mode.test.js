// tests/event-mode.test.js
// Vitest tests for issue #220 — event mode (wedding-day freeze): hook behavior
// under the flag (AC1, AC2), the expiry-race seam (commit-msg gates on flag
// presence, not ACTIVE state), set-event-mode.ps1 create/clear with the
// retro-review refusal (AC3), the CI expiry check (AC4 logic, via the single
// PowerShell reader), and the harvest freeze marking. Windows PowerShell 5.1
// is the launcher on win32; pwsh elsewhere. Hook-driving tests are
// win32-gated like verdict-gate AC7.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildRow, hasFreezeCommit } = require('../scripts/ledger-harvest.js');

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
const CORE = path.join(REPO_ROOT, 'tools', 'event-mode-core.ps1');
const SET_TOOL = path.join(REPO_ROOT, 'tools', 'set-event-mode.ps1');
const EXPIRY_TOOL = path.join(REPO_ROOT, 'tools', 'check-event-mode-expiry.ps1');

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

function flagJson(overrides) {
  return JSON.stringify(
    Object.assign(
      { schema: 'em1', expires: FUTURE, reason: 'test', created: '2026-07-01T00:00:00Z' },
      overrides
    )
  );
}

function runPs(args, opts) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass'].concat(args), {
    encoding: 'utf8',
    ...opts,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping event-mode PowerShell tests`)
  : describe;

// Hook-driving tests shell out to Windows-only `powershell` from inside the
// hooks; gate to win32 exactly like verdict-gate AC7.
const hookDescribe = launcherMissing || process.platform !== 'win32' ? describe.skip : describe;

describe('ledger-harvest freeze marking (#220)', () => {
  const pr = {
    number: 300,
    title: 'hotfix batch (#220)',
    body: '',
    merged_at: '2026-08-07T20:00:00Z',
    merge_commit_sha: 'cafebabe',
    labels: [],
    head: { ref: 'hotfix-branch' },
  };

  it('hasFreezeCommit: only a "hotfix: "-prefixed subject counts', () => {
    expect(hasFreezeCommit(['hotfix: unstick uploads'])).toBe(true);
    expect(hasFreezeCommit(['fix: normal', 'docs: x'])).toBe(false);
    expect(hasFreezeCommit(['prefix hotfix: not at start'])).toBe(false);
    expect(hasFreezeCommit([])).toBe(false);
    expect(hasFreezeCommit(undefined)).toBe(false);
  });

  it('buildRow marks freeze:true when any PR commit is a hotfix', () => {
    const row = buildRow(pr, [], ['chore: prep', 'hotfix: unstick uploads']);
    expect(row.freeze).toBe(true);
  });

  it('buildRow keeps freeze:false without hotfix commits (and with the legacy 2-arg call)', () => {
    expect(buildRow(pr, [], ['fix: reviewed change']).freeze).toBe(false);
    expect(buildRow(pr, []).freeze).toBe(false);
  });
});

maybeDescribe('Get-EventModeState (tools/event-mode-core.ps1)', () => {
  function stateOf(flagPath, nowUtc) {
    const nowArg = nowUtc ? ` -NowUtc '${nowUtc}'` : '';
    const r = runPs([
      '-Command',
      `. '${CORE}'; Get-EventModeState -FlagPath '${flagPath}'${nowArg}`,
    ]);
    return { status: r.status, state: r.stdout.trim() };
  }

  it('missing file -> NONE', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-state-'));
    expect(stateOf(path.join(tmp, 'absent.json')).state).toBe('NONE');
  });

  it('valid future flag -> ACTIVE', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-state-'));
    const p = path.join(tmp, 'f.json');
    fs.writeFileSync(p, flagJson({}));
    expect(stateOf(p).state).toBe('ACTIVE');
  });

  it('valid past flag -> EXPIRED', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-state-'));
    const p = path.join(tmp, 'f.json');
    fs.writeFileSync(p, flagJson({ expires: PAST }));
    expect(stateOf(p).state).toBe('EXPIRED');
  });

  it('expiry exactly now -> EXPIRED (boundary is closed)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-state-'));
    const p = path.join(tmp, 'f.json');
    fs.writeFileSync(p, flagJson({ expires: '2026-08-08T00:00:00Z' }));
    expect(stateOf(p, '2026-08-08T00:00:00Z').state).toBe('EXPIRED');
  });

  it('garbage / wrong schema / bad expires -> INVALID', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-state-'));
    const cases = ['{oops', flagJson({ schema: 'nope' }), flagJson({ expires: 'someday' })];
    cases.forEach((content, i) => {
      const p = path.join(tmp, `f${i}.json`);
      fs.writeFileSync(p, content);
      expect(stateOf(p).state).toBe('INVALID');
    });
  });
});

maybeDescribe('check-event-mode-expiry.ps1 (AC4 — CI backstop over the single reader)', () => {
  function runExpiry(flagPath) {
    return runPs(['-File', EXPIRY_TOOL, '-FlagPath', flagPath]);
  }

  it('absent flag -> exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-expiry-'));
    const r = runExpiry(path.join(tmp, 'nope.json'));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no event-mode flag present');
  });

  it('valid future flag -> exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-expiry-'));
    const p = path.join(tmp, 'f.json');
    fs.writeFileSync(p, flagJson({}));
    const r = runExpiry(p);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('active until');
  });

  it('expired flag -> exit 1 and points at -Clear', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-expiry-'));
    const p = path.join(tmp, 'f.json');
    fs.writeFileSync(p, flagJson({ expires: PAST }));
    const r = runExpiry(p);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('-Clear');
  });

  it('invalid flag (garbage / wrong schema) -> exit 1 (fail closed)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-expiry-'));
    const cases = ['{not json', flagJson({ schema: 'em2' })];
    cases.forEach((content, i) => {
      const p = path.join(tmp, `f${i}.json`);
      fs.writeFileSync(p, content);
      expect(runExpiry(p).status).toBe(1);
    });
  });
});

// A scratch git repo for tool/hook tests. `hooks` is the list of hook files to
// install (empty = no hooks); gate-core.sh always rides along when any hook is
// installed because both hooks source it. tools/*.ps1 are always copied
// (set-event-mode resolves paths via git rev-parse --show-toplevel of its cwd).
function makeRepo(hooks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-repo-'));
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
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.mkdirSync(path.join(dir, 'governance'));
  for (const t of fs.readdirSync(path.join(REPO_ROOT, 'tools'))) {
    if (t.endsWith('.ps1')) {
      fs.copyFileSync(path.join(REPO_ROOT, 'tools', t), path.join(dir, 'tools', t));
    }
  }
  if (hooks && hooks.length > 0) {
    fs.mkdirSync(path.join(dir, '.githooks'));
    for (const h of hooks.concat(['gate-core.sh'])) {
      const dest = path.join(dir, '.githooks', h);
      fs.copyFileSync(path.join(REPO_ROOT, '.githooks', h), dest);
      try {
        fs.chmodSync(dest, 0o755);
      } catch {
        /* git respects the bit on win32 */
      }
    }
    run(['config', 'core.hooksPath', '.githooks']);
  }
  return { dir, run };
}

const BOTH_HOOKS = ['pre-commit', 'commit-msg'];

function commitAttempt(repo, filename, message) {
  fs.writeFileSync(path.join(repo.dir, filename), `// ${filename}\n`);
  repo.run(['add', '-A']);
  return repo.run(['commit', '-m', message]);
}

hookDescribe('event-mode hook behavior (AC1, AC2)', () => {
  it('AC1a: valid flag + "hotfix: test" + NO evidence -> hooks exit 0', () => {
    const repo = makeRepo(BOTH_HOOKS);
    fs.writeFileSync(path.join(repo.dir, 'governance', 'event-mode.json'), flagJson({}));
    const r = commitAttempt(repo, 'fix1.js', 'hotfix: test');
    expect(r.stderr).toContain('event mode ACTIVE');
    expect(r.status).toBe(0);
  }, 60000);

  it('AC1b: valid flag + "fix: test" (no prefix) -> blocked exactly as without the flag', () => {
    const repo = makeRepo(BOTH_HOOKS);
    fs.writeFileSync(path.join(repo.dir, 'governance', 'event-mode.json'), flagJson({}));
    const r = commitAttempt(repo, 'fix2.js', 'fix: test');
    expect(r.status).not.toBe(0);
    // Same fail-closed evidence-gate message the no-flag path emits.
    expect(r.stderr).toContain('commit-gate (BLOCKED): no review verdict exists');
  }, 60000);

  it('AC2: EXPIRED flag + "hotfix: test" -> blocked (prefix grants nothing)', () => {
    const repo = makeRepo(BOTH_HOOKS);
    fs.writeFileSync(
      path.join(repo.dir, 'governance', 'event-mode.json'),
      flagJson({ expires: PAST })
    );
    const r = commitAttempt(repo, 'fix3.js', 'hotfix: test');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('commit-gate (BLOCKED): no review verdict exists');
  }, 60000);

  it('no flag + "hotfix: test" -> blocked (prefix grants nothing outside a window)', () => {
    const repo = makeRepo(BOTH_HOOKS);
    const r = commitAttempt(repo, 'fix4.js', 'hotfix: test');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('commit-gate (BLOCKED): no review verdict exists');
  }, 60000);

  it('INVALID flag (garbage json) + "hotfix: test" -> blocked (fail closed)', () => {
    const repo = makeRepo(BOTH_HOOKS);
    fs.writeFileSync(path.join(repo.dir, 'governance', 'event-mode.json'), '{broken');
    const r = commitAttempt(repo, 'fix5.js', 'hotfix: test');
    expect(r.status).not.toBe(0);
  }, 60000);
});

// The expiry-race seam: pre-commit can defer on a then-ACTIVE flag that is
// EXPIRED by the time commit-msg runs. commit-msg must therefore gate on flag
// PRESENCE, not ACTIVE state — otherwise neither hook runs the evidence gate.
// Simulated by installing commit-msg WITHOUT pre-commit (exactly the deferred
// world) and committing under a non-ACTIVE flag.
hookDescribe('event-mode expiry race (commit-msg gates on flag presence)', () => {
  it('commit-msg alone + EXPIRED flag + "hotfix: test" -> evidence gate still blocks', () => {
    const repo = makeRepo(['commit-msg']);
    fs.writeFileSync(
      path.join(repo.dir, 'governance', 'event-mode.json'),
      flagJson({ expires: PAST })
    );
    const r = commitAttempt(repo, 'race1.js', 'hotfix: test');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('commit-gate (BLOCKED): no review verdict exists');
  }, 60000);

  it('commit-msg alone + EXPIRED flag + "fix: test" -> evidence gate still blocks', () => {
    const repo = makeRepo(['commit-msg']);
    fs.writeFileSync(
      path.join(repo.dir, 'governance', 'event-mode.json'),
      flagJson({ expires: PAST })
    );
    const r = commitAttempt(repo, 'race2.js', 'fix: test');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('commit-gate (BLOCKED): no review verdict exists');
  }, 60000);

  it('commit-msg alone + ACTIVE flag + "hotfix: test" -> exit 0 (bypass intact)', () => {
    const repo = makeRepo(['commit-msg']);
    fs.writeFileSync(path.join(repo.dir, 'governance', 'event-mode.json'), flagJson({}));
    const r = commitAttempt(repo, 'race3.js', 'hotfix: test');
    expect(r.status).toBe(0);
  }, 60000);
});

maybeDescribe('set-event-mode.ps1 create/clear (AC3)', () => {
  function runTool(repoDir, args) {
    return runPs(['-File', SET_TOOL].concat(args), { cwd: repoDir });
  }

  it('create writes a valid em1 flag; a second create refuses', () => {
    const repo = makeRepo([]);
    const r = runTool(repo.dir, ['-ExpiresUtc', FUTURE, '-Reason', 'wedding weekend']);
    expect(r.status).toBe(0);
    const flag = JSON.parse(
      fs.readFileSync(path.join(repo.dir, 'governance', 'event-mode.json'), 'utf8')
    );
    expect(flag.schema).toBe('em1');
    expect(flag.reason).toBe('wedding weekend');
    expect(Date.parse(flag.expires)).toBeGreaterThan(Date.now());
    expect(Date.parse(flag.created)).not.toBeNaN();
    const again = runTool(repo.dir, ['-ExpiresUtc', FUTURE, '-Reason', 'again']);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toContain('already exists');
  }, 60000);

  it('create refuses a past expiry and a missing reason', () => {
    const repo = makeRepo([]);
    const past = runTool(repo.dir, ['-ExpiresUtc', PAST, '-Reason', 'oops']);
    expect(past.status).not.toBe(0);
    expect(past.stderr).toContain('already-expired');
    const noReason = runTool(repo.dir, ['-ExpiresUtc', FUTURE]);
    expect(noReason.status).not.toBe(0);
  }, 60000);

  it('AC3: -Clear refuses (naming the commit) without a retro-review, then succeeds with one', () => {
    const repo = makeRepo([]);
    // A real commit to be the "freeze commit" the ledger row points at.
    fs.writeFileSync(path.join(repo.dir, 'hot.js'), '// hotfix payload\n');
    repo.run(['add', '-A']);
    repo.run(['commit', '-m', 'hotfix: payload']);
    const sha = repo.run(['rev-parse', 'HEAD']).stdout.trim();
    const tree = repo.run(['rev-parse', `${sha}^{tree}`]).stdout.trim();

    const created = runTool(repo.dir, ['-ExpiresUtc', FUTURE, '-Reason', 'freeze test']);
    expect(created.status).toBe(0);

    // Freeze row timestamped after the flag's creation.
    const ledgerPath = path.join(repo.dir, 'test-ledger.ndjson');
    const rowTs = new Date(Date.now() + 60_000).toISOString();
    const row = {
      schema: 'gl1',
      pr: 999,
      issue: null,
      merged_sha: sha,
      ts: rowTs,
      reviews: [],
      labels: [],
      freeze: true,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(row) + '\n');

    const refused = runTool(repo.dir, ['-Clear', '-LedgerPath', ledgerPath]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(sha);
    expect(fs.existsSync(path.join(repo.dir, 'governance', 'event-mode.json'))).toBe(true);

    // Record the retro-review PASS bound to the freeze commit's tree.
    const persisted = runPs(
      [
        '-File',
        path.join(repo.dir, 'tools', 'persist-review.ps1'),
        '-TreeOid',
        tree,
        '-ReviewerId',
        'retro-reviewer-1',
        '-Verdict',
        'PASS',
      ],
      { cwd: repo.dir }
    );
    expect(persisted.status).toBe(0);

    const cleared = runTool(repo.dir, ['-Clear', '-LedgerPath', ledgerPath]);
    expect(cleared.status).toBe(0);
    expect(fs.existsSync(path.join(repo.dir, 'governance', 'event-mode.json'))).toBe(false);
  }, 120000);

  it('-Clear ignores freeze rows recorded BEFORE the flag was created', () => {
    const repo = makeRepo([]);
    const created = runTool(repo.dir, ['-ExpiresUtc', FUTURE, '-Reason', 'window scoping']);
    expect(created.status).toBe(0);
    const ledgerPath = path.join(repo.dir, 'test-ledger.ndjson');
    const oldRow = {
      schema: 'gl1',
      pr: 1,
      issue: null,
      merged_sha: 'f'.repeat(40),
      ts: '2020-01-01T00:00:00Z',
      reviews: [],
      labels: [],
      freeze: true,
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(oldRow) + '\n');
    const cleared = runTool(repo.dir, ['-Clear', '-LedgerPath', ledgerPath]);
    expect(cleared.status).toBe(0);
    expect(fs.existsSync(path.join(repo.dir, 'governance', 'event-mode.json'))).toBe(false);
  }, 60000);

  it('-Clear with no flag present refuses', () => {
    const repo = makeRepo([]);
    const r = runTool(repo.dir, ['-Clear', '-LedgerPath', path.join(repo.dir, 'none.ndjson')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no flag');
  }, 60000);
});
