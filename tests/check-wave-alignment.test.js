// tests/check-wave-alignment.test.js
// Vitest tests for tools/check-wave-alignment.ps1 (#357 Component B): pre-wave
// intra-wave collision detection, and the drift guard proving it consumes the
// SAME carve-out list as tools/check-freshness.ps1 rather than a private
// copy (the #357 architecture-review finding this issue folds in). Windows
// PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
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

const REPO_TOOLS = path.join(__dirname, '..', 'tools');
const FRESHNESS_SCRIPT = path.join(REPO_TOOLS, 'check-freshness.ps1');
const ALIGNMENT_SCRIPT = path.join(REPO_TOOLS, 'check-wave-alignment.ps1');

// A scratch fixture: a copy of the two real tools under tools/, plus fake
// data/wip-issues/ drafts. check-wave-alignment.ps1 resolves both its sibling
// tool and the issue-draft directory relative to its OWN location
// ($PSScriptRoot), so the fixture has to reproduce that relative shape rather
// than pointing the real repo's tools at an arbitrary issue directory.
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wavealign-'));
  const toolsDir = path.join(root, 'tools');
  fs.mkdirSync(toolsDir);
  fs.copyFileSync(FRESHNESS_SCRIPT, path.join(toolsDir, 'check-freshness.ps1'));
  fs.copyFileSync(ALIGNMENT_SCRIPT, path.join(toolsDir, 'check-wave-alignment.ps1'));
  fs.mkdirSync(path.join(root, 'data', 'wip-issues'), { recursive: true });
  return root;
}

function writeIssueDraft(root, n, slug, touchesLine) {
  const p = path.join(root, 'data', 'wip-issues', `${n}-${slug}.md`);
  const body = [
    `# ${n} — test issue`,
    '',
    '## Dependency map',
    '',
    '```',
    'Depends on: none',
    'Blocks: none',
    touchesLine,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(p, body);
}

function run(root, issueNumbersCsv) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'tools', 'check-wave-alignment.ps1'),
    '-IssueNumbers',
    issueNumbersCsv,
  ];
  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping check-wave-alignment tests`)
  : describe;

maybeDescribe('check-wave-alignment.ps1', () => {
  it('AC8: two issues sharing a non-carve-out file -> names the file and both issue numbers, exit 1', () => {
    const root = makeFixture();
    writeIssueDraft(root, 501, 'alpha', 'Touches: tools/foo.ps1, src/views/feed.ejs, BUILDLOG.md');
    writeIssueDraft(root, 502, 'beta', 'Touches: src/views/feed.ejs (new), BUILDLOG.md');
    const r = run(root, '501,502');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/views/feed.ejs');
    expect(r.stdout).toContain('#501');
    expect(r.stdout).toContain('#502');
  });

  it('AC8: disjoint Touches (ignoring the shared carve-out file) -> clear, exit 0', () => {
    const root = makeFixture();
    writeIssueDraft(root, 501, 'alpha', 'Touches: tools/foo.ps1, src/views/feed.ejs, BUILDLOG.md');
    writeIssueDraft(root, 503, 'gamma', 'Touches: src/routes/admin.js, BUILDLOG.md');
    const r = run(root, '501,503');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clear');
    expect(r.stdout).not.toContain('COLLISION');
  });

  it('three-way wave: reports every colliding pair, not just the first', () => {
    const root = makeFixture();
    writeIssueDraft(root, 601, 'a', 'Touches: src/routes/admin.js');
    writeIssueDraft(root, 602, 'b', 'Touches: src/routes/admin.js');
    writeIssueDraft(root, 603, 'c', 'Touches: src/routes/admin.js');
    const r = run(root, '601,602,603');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('#601');
    expect(r.stdout).toContain('#602');
    expect(r.stdout).toContain('#603');
    // Three pairs: (601,602) (601,603) (602,603).
    const collisionLines = r.stdout.split('\n').filter((l) => l.includes('COLLISION'));
    expect(collisionLines).toHaveLength(3);
  });

  it('an issue with no draft and no Touches contributes no collision (safe default)', () => {
    const root = makeFixture();
    writeIssueDraft(root, 501, 'alpha', 'Touches: tools/foo.ps1');
    // 999 has no draft on disk and `gh` is not available/authenticated in this
    // fixture, so Get-IssueTouches falls through to an empty array.
    const r = run(root, '501,999');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clear');
  });

  it('a " (new)" annotation on a Touches path does not prevent it from colliding', () => {
    const root = makeFixture();
    writeIssueDraft(root, 701, 'x', 'Touches: tools/check-wave-alignment.ps1 (new)');
    writeIssueDraft(root, 702, 'y', 'Touches: tools/check-wave-alignment.ps1');
    const r = run(root, '701,702');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('tools/check-wave-alignment.ps1');
    expect(r.stdout).not.toContain('tools/check-wave-alignment.ps1 (new)');
  });

  // AC4: drafts are zero-padded on disk (e.g. "0048-slug.md"), but the
  // IssueNumbers CLI arg and Get-IssueTouches's -N param are plain ints
  // (48). A collision between a zero-padded draft and a plain-named draft
  // must still be found -- and a draft for a DIFFERENT issue number that
  // merely contains the same digits as a substring (e.g. "0148-..." for
  // issue 48) must NOT be mistaken for it.
  it('AC4: a zero-padded draft filename (0901-slug.md) is resolved for issue 901', () => {
    const root = makeFixture();
    writeIssueDraft(root, '0901', 'padded', 'Touches: src/routes/admin.js');
    writeIssueDraft(root, 902, 'plain', 'Touches: src/routes/admin.js');
    const r = run(root, '901,902');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/routes/admin.js');
    expect(r.stdout).toContain('#901');
    expect(r.stdout).toContain('#902');
  });

  it('AC4: a zero-padded draft does not cross-match an unrelated issue number sharing its digits', () => {
    const root = makeFixture();
    // Issue 48's draft is zero-padded; 148 and 480 both contain "48" as a
    // substring and must not resolve to issue 48's Touches.
    writeIssueDraft(root, '0048', 'target', 'Touches: src/routes/admin.js');
    writeIssueDraft(root, 148, 'decoy-prefix', 'Touches: src/routes/admin.js');
    const r = run(root, '48,148');
    // Both issues independently declare the same real path, so this SHOULD
    // still collide -- the point is that it collides because issue 48's own
    // draft was found (proven by the next assertion's isolation case), not
    // because 148's draft was mistakenly read for 48.
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('#48');
    expect(r.stdout).toContain('#148');
  });

  it('AC4: resolving issue 48 does not pick up a decoy draft named 148-*.md when 48 has no draft of its own', () => {
    const root = makeFixture();
    // No draft for 48 at all; only a same-digit-substring decoy for 148
    // exists. If the glob cross-matched, issue 48 would wrongly inherit
    // 148's Touches and collide; the safe-default behavior (no draft, no gh
    // access in this fixture) is an empty Touches list -> no collision.
    writeIssueDraft(root, 148, 'decoy', 'Touches: src/routes/admin.js');
    writeIssueDraft(root, 149, 'real', 'Touches: src/routes/admin.js');
    const r = run(root, '48,149');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clear');
  });
});

// AC1/AC3: the gh-fallback path is only reachable when no local draft
// exists. These tests stub out `gh` itself (a tiny script on PATH) so the
// newline-safe capture can be exercised without real network/auth access --
// matching the issue's AC5 requirement that the regression pin not need
// network access to real issues.
describe('check-wave-alignment.ps1 gh-fallback body capture (AC1/AC3)', () => {
  function makeGhStub(root, bodiesByIssue) {
    // A fake `gh` that only understands `gh issue view <N> --json body -q .body`
    // and prints the configured multi-line body for that issue number, exactly
    // as the real `gh` would -- one physical line per Write-Output call, so
    // PowerShell captures it as an array of lines (the condition AC1/AC3 care
    // about), not a pre-joined single string.
    const binDir = path.join(root, 'ghbin');
    fs.mkdirSync(binDir, { recursive: true });
    const ps1Path = path.join(binDir, 'gh.ps1');
    // check-wave-alignment.ps1 invokes `gh issue view $N --json body -q .body`,
    // so argv is [issue, view, N, --json, body, -q, .body] -- the issue
    // number is $args[2], not $args[0] or $args[1].
    const cases = Object.entries(bodiesByIssue)
      .map(([n, body]) => {
        const lines = body
          .split('\n')
          .map((l) => `'${l.replace(/'/g, "''")}'`)
          .join(',\n      ');
        return `  if ($args[2] -eq '${n}') {\n    @(\n      ${lines}\n    ) | ForEach-Object { Write-Output $_ }\n    exit 0\n  }`;
      })
      .join('\n');
    const script = `param()\n${cases}\nexit 1\n`;
    fs.writeFileSync(ps1Path, script);

    // A .cmd shim so `gh` (no extension) resolves on PATH the same way the
    // real gh.exe would when PowerShell's `&` call operator invokes it.
    const cmdPath = path.join(binDir, 'gh.cmd');
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\npowershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gh.ps1" %*\r\n`
    );
    return binDir;
  }

  function runWithGhStub(root, issueNumbersCsv, binDir) {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'tools', 'check-wave-alignment.ps1'),
      '-IssueNumbers',
      issueNumbersCsv,
    ];
    const r = spawnSync(PS, args, {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
    });
    return {
      status: r.status === null ? 1 : r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    };
  }

  it('AC1/AC3: a multi-line gh issue body still yields a matched Touches line, and two such issues collide', () => {
    const root = makeFixture();
    // No local drafts for these numbers -- forces the gh fallback.
    const body1 = [
      '# 910 -- test issue via gh',
      '',
      'Some prose describing the change across several lines.',
      '',
      '## Dependency map',
      '',
      '```',
      'Depends on: none',
      'Blocks: none',
      'Touches: src/services/photos.js, BUILDLOG.md',
      '```',
      '',
    ].join('\n');
    const body2 = [
      '# 911 -- another test issue via gh',
      '',
      '## Dependency map',
      '',
      '```',
      'Touches: src/services/photos.js',
      '```',
      '',
    ].join('\n');
    const binDir = makeGhStub(root, { 910: body1, 911: body2 });
    const r = runWithGhStub(root, '910,911', binDir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('COLLISION');
    expect(r.stdout).toContain('src/services/photos.js');
    expect(r.stdout).toContain('#910');
    expect(r.stdout).toContain('#911');
  });
});

// Drift guard (#357 architecture-review finding 1): check-wave-alignment.ps1
// must dot-source check-freshness.ps1's carve-out list rather than keep its
// own copy. This test would FAIL if the two tools disagreed -- it seeds a
// drift range where BOTH issues touch a carve-out-list file (BUILDLOG.md)
// and nothing else, and asserts check-wave-alignment.ps1 treats it exactly
// as check-freshness.ps1 does (not a collision), proving the same list
// governs both call sites, not a copy that could quietly drift apart.
describe('carve-out list agreement between check-freshness.ps1 and check-wave-alignment.ps1', () => {
  it('BUILDLOG.md-only overlap across two issues is not flagged as a collision', () => {
    const root = makeFixture();
    writeIssueDraft(root, 801, 'p', 'Touches: BUILDLOG.md');
    writeIssueDraft(root, 802, 'q', 'Touches: BUILDLOG.md');
    const r = run(root, '801,802');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('clear');
  });

  it('check-wave-alignment.ps1 defines no carve-out list of its own', () => {
    const src = fs.readFileSync(ALIGNMENT_SCRIPT, 'utf8');
    expect(src).not.toMatch(/\$CARVE_OUT_PATHS\s*=/);
    expect(src).toMatch(/\.\s+\$freshnessScript/);
  });
});
