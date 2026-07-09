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
