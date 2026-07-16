// tests/visual-approval.test.js
// Issue #378 AC3 — the freeze holds and is honest: tools/visual-surface.ps1,
// tools/persist-visual-approval.ps1, tools/check-visual-approval.ps1, plus a
// drift guard between the glob set and the documented visual-change surface.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms —
// same launcher-detection pattern as tests/classify-dep-pr.test.js.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
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
const VISUAL_SURFACE_SCRIPT = path.join(REPO_ROOT, 'tools', 'visual-surface.ps1');
const PERSIST_SCRIPT = path.join(REPO_ROOT, 'tools', 'persist-visual-approval.ps1');
const CHECK_SCRIPT = path.join(REPO_ROOT, 'tools', 'check-visual-approval.ps1');
// A small, low-risk tracked file inside the visual surface to flip during the
// drift test. robots.txt is plain text and trivial to restore byte-for-byte.
const PROBE_FILE = path.join(REPO_ROOT, 'src', 'public', 'robots.txt');

function runPs(scriptPath, args = []) {
  return spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// APPROVAL_PATH is derived by calling tools/visual-surface.ps1's own
// Get-VisualApprovalRecordPath function rather than re-typing the literal
// here a second time — that function is the single owner of the record path
// (issue #378 design-philosophy fix). Deriving it this way means relocating
// the record in visual-surface.ps1 updates this test automatically instead
// of leaving it to hardcode a now-stale path and silently report "no
// recorded approval". Falls back to the historical literal only when the
// PS launcher itself is missing, in which case the whole suite is skipped
// below anyway.
const APPROVAL_PATH = launcherMissing
  ? path.join(REPO_ROOT, '.review_state', 'visual-approval', 'approval.json')
  : (() => {
      const res = spawnSync(
        PS,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `. '${VISUAL_SURFACE_SCRIPT}'; Get-VisualApprovalRecordPath -RepoRoot '${REPO_ROOT}'`,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' }
      );
      return res.stdout.trim();
    })();

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping visual-approval tests`)
  : describe;

maybeDescribe('visual-approval freeze (AC3)', () => {
  let savedApprovalBytes = null;
  let hadApprovalFile = false;
  let savedProbeBytes = null;

  beforeEach(() => {
    // This suite writes real evidence into the (gitignored) .review_state/
    // tree of THIS worktree — save/restore whatever was there before so a
    // real in-flight approval in this worktree is never clobbered by the test.
    hadApprovalFile = fs.existsSync(APPROVAL_PATH);
    if (hadApprovalFile) {
      savedApprovalBytes = fs.readFileSync(APPROVAL_PATH);
    }
  });

  afterEach(() => {
    // Restore the probe file unconditionally in case a test failed mid-mutation.
    if (savedProbeBytes) {
      fs.writeFileSync(PROBE_FILE, savedProbeBytes);
      savedProbeBytes = null;
    }
    if (hadApprovalFile) {
      fs.writeFileSync(APPROVAL_PATH, savedApprovalBytes);
    } else if (fs.existsSync(APPROVAL_PATH)) {
      fs.rmSync(APPROVAL_PATH);
    }
  });

  it('check-visual-approval exits non-zero when no approval has been recorded', () => {
    if (fs.existsSync(APPROVAL_PATH)) fs.rmSync(APPROVAL_PATH);
    const res = runPs(CHECK_SCRIPT);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('no recorded approval');
  });

  it('persist then check: exits 0 when nothing has changed since approval', () => {
    const persistRes = runPs(PERSIST_SCRIPT, ['-Approver', 'test-suite']);
    expect(persistRes.status).toBe(0);
    expect(fs.existsSync(APPROVAL_PATH)).toBe(true);

    const checkRes = runPs(CHECK_SCRIPT);
    expect(checkRes.status).toBe(0);
    expect(checkRes.stdout).toContain('OK');
  });

  it('names the changed file and exits non-zero after a visual-surface file is edited', () => {
    const persistRes = runPs(PERSIST_SCRIPT, ['-Approver', 'test-suite']);
    expect(persistRes.status).toBe(0);

    savedProbeBytes = fs.readFileSync(PROBE_FILE);
    fs.writeFileSync(
      PROBE_FILE,
      Buffer.concat([savedProbeBytes, Buffer.from('\n# drift-probe\n')])
    );

    const checkRes = runPs(CHECK_SCRIPT);
    expect(checkRes.status).not.toBe(0);
    expect(checkRes.stderr).toContain('src/public/robots.txt');

    fs.writeFileSync(PROBE_FILE, savedProbeBytes);
    savedProbeBytes = null;

    // Restored: the same check now passes again against the same approval.
    const recheckRes = runPs(CHECK_SCRIPT);
    expect(recheckRes.status).toBe(0);
  });

  it('the approval record lives outside the hashed visual surface', () => {
    const persistRes = runPs(PERSIST_SCRIPT, ['-Approver', 'test-suite']);
    expect(persistRes.status).toBe(0);
    const relRecordPath = path.relative(REPO_ROOT, APPROVAL_PATH).split(path.sep).join('/');
    // The record's own path must not fall under either surface root, or
    // recording an approval would change the very hash it just recorded.
    expect(relRecordPath.startsWith('src/views/')).toBe(false);
    expect(relRecordPath.startsWith('src/public/')).toBe(false);
    expect(relRecordPath.startsWith('.review_state/')).toBe(true);
  });
});

describe('visual-surface.ps1 glob set — drift guard against the documented surface', () => {
  it('$VISUAL_SURFACE_GLOBS matches the "Views/CSS/badge assets/guest-or-admin-facing copy" row', () => {
    const scriptSrc = fs.readFileSync(VISUAL_SURFACE_SCRIPT, 'utf8');
    const arrayMatch = scriptSrc.match(/\$VISUAL_SURFACE_GLOBS\s*=\s*@\(([\s\S]*?)\)/);
    expect(arrayMatch).not.toBeNull();
    const globs = [];
    const tokenRe = /'([^']+)'/g;
    let m;
    while ((m = tokenRe.exec(arrayMatch[1])) !== null) globs.push(m[1]);
    expect(globs.sort()).toEqual(['src/public', 'src/views']);

    // The mirrored row itself must still exist verbatim in the standard this
    // script's header cites — if that row's text changes without updating
    // this comment/glob set, this assertion is the tripwire.
    const protocolPath = path.join(REPO_ROOT, 'standards', 'adversarial-review-protocol.md');
    const protocolSrc = fs.readFileSync(protocolPath, 'utf8');
    expect(protocolSrc).toContain('Views/CSS/badge assets/guest-or-admin-facing copy');

    // Same surface as the orchestrator's visual-change trigger definition.
    const orchestratorPath = path.join(REPO_ROOT, 'agents', 'orchestrator.md');
    const orchestratorSrc = fs.readFileSync(orchestratorPath, 'utf8');
    expect(orchestratorSrc).toContain('views/**/*.ejs');
    expect(orchestratorSrc).toContain('src/public/**');
  });
});
