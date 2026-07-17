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
const PROBE_RELATIVE_PATH = path.relative(REPO_ROOT, PROBE_FILE).split(path.sep).join('/');

function runPs(scriptPath, args = []) {
  return spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

// Pure predicate: given the git-cleanliness result for the probe file (from
// `git diff --quiet HEAD`, computed by isProbeCleanRelativeToHead below) and
// its repo-relative path, says whether the drift test may safely mutate the
// probe. Kept separate from the spawnSync call so it is unit-testable
// without touching the real tracked file (issue #555 — polluting
// robots.txt to test the guard would reintroduce the exact hazard this
// issue closes).
function checkProbeCleanliness(isClean, relPath) {
  if (isClean) return { ok: true };
  return {
    ok: false,
    reason:
      `visual-approval probe: ${relPath} differs from HEAD. Restore it ` +
      `(git checkout -- ${relPath}) or commit your edit before running this suite.`,
  };
}

// Issue #555 design constraint 3: "unmodified" means `git diff --quiet
// HEAD`, NOT a byte comparison against `git show`. core.autocrlf=true and
// src/public/** is not pinned to eol=lf, so a byte comparison goes red on a
// pristine Windows checkout while staying green on Linux CI — git's own
// diff check already accounts for autocrlf and is the only
// platform-consistent probe.
function isProbeCleanRelativeToHead() {
  const res = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', PROBE_RELATIVE_PATH], {
    cwd: REPO_ROOT,
  });
  // Distinguish "git could not run" from "the probe is dirty". `git diff
  // --quiet` answers the question with 0 (clean) or 1 (differs); anything
  // else — a spawn failure (null), or git's own error exit 128 (not a git
  // repository, unborn HEAD, bad revision) — is git failing to answer, not
  // an answer of "dirty". Without this, those cases would fall through to
  // the dirty branch and tell the operator to `git checkout` a file that is
  // not the problem.
  if (res.error || (res.status !== 0 && res.status !== 1)) {
    const why = res.error ? res.error.message : `git exited ${res.status}`;
    throw new Error(`visual-approval probe: could not run git diff — ${why}`);
  }
  return res.status === 0;
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

    // Precondition guard (issue #555 AC1/AC2): refuse to mutate a probe
    // file that has already drifted from HEAD, rather than snapshotting
    // whatever is currently on disk (possibly pollution left by an
    // interrupted prior run) as the restore baseline. This runs before
    // savedProbeBytes is ever assigned, so a guard failure leaves nothing
    // for afterEach to restore.
    const precheck = checkProbeCleanliness(isProbeCleanRelativeToHead(), PROBE_RELATIVE_PATH);
    if (!precheck.ok) {
      throw new Error(precheck.reason);
    }

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

describe('probe-cleanliness guard predicate (issue #555)', () => {
  // AC1 (a polluted probe) and AC2 (a legitimate uncommitted edit) intentionally
  // collapse to the same `isClean === false` branch here: per the issue's Design
  // constraint 2 the guard must NOT inspect the bytes to decide which kind of
  // drift it has found — it refuses either way and leaves the operator to decide
  // which bytes are garbage. So there is deliberately no AC2-specific case below.
  // These test the extracted predicate directly with synthetic booleans,
  // not the real git state — proving the guard's own logic without ever
  // writing a probe marker into the tracked src/public/robots.txt (which
  // would reintroduce the pollution hazard this issue closes). The
  // suite-level promise (a real drift on disk makes the drift test fail
  // loudly, and a real uncommitted edit survives byte-for-byte) is not
  // provable here without polluting the tracked file; it was demonstrated by
  // a one-time manual drill whose output is recorded in this change's PR
  // description (issue #555), per the implementation plan.

  it('is ok when the probe is clean relative to HEAD (AC3 — clean path unaffected)', () => {
    expect(checkProbeCleanliness(true, PROBE_RELATIVE_PATH)).toEqual({ ok: true });
  });

  it('fails and names the file when the probe has drifted from HEAD (AC1)', () => {
    const result = checkProbeCleanliness(false, PROBE_RELATIVE_PATH);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain(PROBE_RELATIVE_PATH);
    expect(result.reason).toContain(`git checkout -- ${PROBE_RELATIVE_PATH}`);
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
