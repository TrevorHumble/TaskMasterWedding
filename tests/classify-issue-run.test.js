// tests/classify-issue-run.test.js
// Vitest tests for classify-issue-run.ps1: the classifier ACs from #427, one test
// per precedence branch (including the mixed-path and reviewer-charter cases), plus
// drift guards (script structure, CLAUDE.md mirror, guest-critical anchor paths).
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS = process.platform === 'win32' ? 'powershell' : 'pwsh';

// One-time guard: if the launcher doesn't exist, skip all tests.
let launcherMissing = false;
try {
  execFileSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'exit 0']);
} catch (e) {
  if (e.code === 'ENOENT') {
    launcherMissing = true;
  }
}

const SCRIPT = path.join(__dirname, '..', 'tools', 'classify-issue-run.ps1');

function run(touchesPaths, flags) {
  flags = flags || {};
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
  if (touchesPaths && touchesPaths.length > 0) {
    args.push('-TouchesPaths', touchesPaths.join(','));
  }
  if (flags.securityFlagged) args.push('-SecurityFlagged');
  if (flags.escalated) args.push('-Escalated');
  if (flags.schemaOrDataMigration) args.push('-SchemaOrDataMigration');
  return spawnSync(PS, args, { encoding: 'utf8' });
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping classify-issue-run tests`)
  : describe;

maybeDescribe('classify-issue-run', () => {
  // AC: routine, non-system, off-guest-path, no schema change -> sonnet-only.
  it('AC: src/services/scoring.js, no flags -> sonnet-only, exit 0', () => {
    const r = run(['src/services/scoring.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('sonnet-only');
  });

  // AC: gate (a) - system-level governing-artifact surface -> opus.
  it('AC: standards/issue-standards.md -> opus (gate a)', () => {
    const r = run(['standards/issue-standards.md']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (a) - a reviewer charter matches $SYSTEM_PATH_REGEX directly; the
  // Get-RequiredBar reviewer-count carve-out does not apply to run-tier eligibility.
  it('AC: agents/reviewer-pr.md -> opus (gate a, reviewer charter is not carved out)', () => {
    const r = run(['agents/reviewer-pr.md']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (a) - security-flagged -> opus.
  it('AC: src/services/scoring.js -SecurityFlagged -> opus (gate a)', () => {
    const r = run(['src/services/scoring.js'], { securityFlagged: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (a) - orchestrator-escalated -> opus.
  it('AC: src/services/scoring.js -Escalated -> opus (gate a)', () => {
    const r = run(['src/services/scoring.js'], { escalated: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (b) - the upload service, a wedding-critical guest path.
  it('AC: src/services/photos.js -> opus (gate b, upload)', () => {
    const r = run(['src/services/photos.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (b) - join/auth.
  it('AC: src/routes/auth.js -> opus (gate b, join/auth)', () => {
    const r = run(['src/routes/auth.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (b) - gallery/export core.
  it('AC: src/services/export.js -> opus (gate b, gallery/export core)', () => {
    const r = run(['src/services/export.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: gate (c) - schema or data migration.
  it('AC: src/services/scoring.js -SchemaOrDataMigration -> opus (gate c)', () => {
    const r = run(['src/services/scoring.js'], { schemaOrDataMigration: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // AC: precedence - a system-level path mixed with an eligible one still trips gate (a).
  it('AC: standards/x.md + src/services/scoring.js -> opus (system-level wins)', () => {
    const r = run(['standards/x.md', 'src/services/scoring.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // Mutation-coverage: the remaining moderation and identity/session/qr guest-critical
  // anchors each independently trip gate (b), isolating each regex alternative.
  it('edge: src/routes/admin.js -> opus (gate b, moderation)', () => {
    const r = run(['src/routes/admin.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/middleware/session.js -> opus (gate b, join/auth)', () => {
    const r = run(['src/middleware/session.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/services/identity.js -> opus (gate b, join/auth)', () => {
    const r = run(['src/services/identity.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/services/qr.js -> opus (gate b, join/auth)', () => {
    const r = run(['src/services/qr.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/services/heic-worker.js -> opus (gate b, upload)', () => {
    const r = run(['src/services/heic-worker.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/services/submissions.js -> opus (gate b, upload)', () => {
    const r = run(['src/services/submissions.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  it('edge: src/services/feed.js -> opus (gate b, gallery/export core)', () => {
    const r = run(['src/services/feed.js']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('opus');
  });

  // Mutation-coverage: precedence order - gate (b) beats gate (c). A mutant that
  // reordered schema-check-before-guest-critical would pass the isolated gate-c
  // test above but fail here (both flags set on a guest-critical path still opus,
  // which is not distinguishing -- the real isolation is that a routine path with
  // schema migration alone is opus purely from gate c, proven above; this case
  // confirms gate (b) fires with no flags needed on a guest-critical path, which
  // the photos.js/auth.js/export.js cases above already isolate independently of
  // gate (c)). Precedence between (b) and (c) is additionally covered by: a
  // guest-critical path with SchemaOrDataMigration unset still returns opus (proven
  // by the photos.js case), and a non-guest-critical path with the flag set still
  // returns opus (proven by the gate-c case) -- so no combination of the two gates
  // can produce a false sonnet-only.
  it('edge: no TouchesPaths, no flags -> sonnet-only (empty input is not system/guest-critical)', () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('sonnet-only');
  });
});

// Drift-guard: the classifier must dot-source tools/verdict-core.ps1 for
// $SYSTEM_PATH_REGEX and must declare no system-path regex literal of its own --
// so gate (a) has no second copy to drift from the commit gate's definition.
describe('classify-issue-run structural drift guard', () => {
  const scriptPath = path.join(__dirname, '..', 'tools', 'classify-issue-run.ps1');
  const src = fs.readFileSync(scriptPath, 'utf8');

  it('dot-sources tools/verdict-core.ps1', () => {
    expect(src).toMatch(/\.\s*\(Join-Path\s+\$scriptDir\s+'verdict-core\.ps1'\)/);
  });

  it('declares no system-path regex literal of its own (uses the dot-sourced $SYSTEM_PATH_REGEX)', () => {
    // The literal system-level path prefixes (.githooks/, standards/, agents/, etc.)
    // must not appear as a hand-written regex/array in this script -- only the
    // dot-sourced $SYSTEM_PATH_REGEX variable reference is permitted.
    expect(src).not.toMatch(/SYSTEM_PATH_REGEX\s*=\s*['"]/);
    expect(src).toMatch(/\$SYSTEM_PATH_REGEX/);
  });

  it('does not call Get-RequiredBar (the reviewer-count carve-out does not apply here)', () => {
    // The name may appear in an explanatory comment (why it is deliberately not
    // used); what must never appear is an actual invocation of the function.
    expect(src).not.toMatch(/Get-RequiredBar\s+-/);
    expect(src).not.toMatch(/=\s*Get-RequiredBar/);
  });
});

// Drift-guard: CLAUDE.md documents the same guest-critical surfaces the classifier's
// $GuestCriticalPathRegex protects -- both the four category words AND each of the
// ten concrete anchor paths. The concrete-path check is what forces a CLAUDE.md
// update when a new path is added to $GuestCriticalPathRegex; the category-word
// check alone would let a new path drift silently. Mirrors the concrete-list
// posture tests/classify-dep-pr.test.js uses on $WeddingCritical.
describe('guest-critical surface drift guard', () => {
  const claudePath = path.join(__dirname, '..', 'CLAUDE.md');
  const doc = fs.readFileSync(claudePath, 'utf8');
  const scriptPath = path.join(__dirname, '..', 'tools', 'classify-issue-run.ps1');

  // Parse the concrete anchor paths out of the $GuestCriticalPaths array in the
  // classifier source (each token is single-quoted with the dot regex-escaped as
  // `\.`); un-escape the dot to recover the real path. Mirrors how the dep-pr test
  // parses $WeddingCritical.
  function parseScriptAnchors() {
    const src = fs.readFileSync(scriptPath, 'utf8');
    const arrayMatch = src.match(/\$GuestCriticalPaths\s*=\s*@\(([\s\S]*?)\)/);
    if (!arrayMatch)
      throw new Error('Could not locate $GuestCriticalPaths array in classify-issue-run.ps1');
    const arrayLiteral = arrayMatch[1];
    const paths = [];
    const tokenRe = /'([^']+)'/g;
    let m;
    while ((m = tokenRe.exec(arrayLiteral)) !== null) {
      // Recover the real path from the regex-escaped literal: '\.' -> '.'
      paths.push(m[1].replace(/\\\./g, '.'));
    }
    return paths;
  }

  it('script $GuestCriticalPaths array is parseable and has ten entries', () => {
    const anchors = parseScriptAnchors();
    expect(anchors).toHaveLength(10);
  });

  it('CLAUDE.md documents the join/auth, upload, moderation, and gallery/export surfaces', () => {
    expect(doc).toMatch(/sonnet-only/);
    expect(doc).toMatch(/join\/auth/);
    expect(doc).toMatch(/upload/i);
    expect(doc).toMatch(/moderation/i);
    expect(doc).toMatch(/gallery\/export/);
  });

  it('CLAUDE.md guest-critical list names every concrete anchor path from $GuestCriticalPaths', () => {
    const anchors = parseScriptAnchors();
    // Restrict to the § "Sonnet-only run tier" section so the check is against the
    // intended mirror, not an incidental mention elsewhere.
    const sectionMatch = doc.match(/##\s+Sonnet-only run tier[\s\S]*?(?=\n##\s|$)/);
    if (!sectionMatch)
      throw new Error('Could not locate "## Sonnet-only run tier" section in CLAUDE.md');
    const section = sectionMatch[0];
    for (const anchor of anchors) {
      expect(section).toContain(anchor);
    }
  });
});

// Drift-guard: every concrete source path named as an anchor in $GuestCriticalPaths
// resolves to an existing file -- a silent rename must fail CI, not misclassify a
// change as sonnet-only.
describe('guest-critical anchor paths exist', () => {
  const scriptPath = path.join(__dirname, '..', 'tools', 'classify-issue-run.ps1');
  const src = fs.readFileSync(scriptPath, 'utf8');
  const repoRoot = path.join(__dirname, '..');

  const anchors = [
    'src/routes/auth.js',
    'src/middleware/session.js',
    'src/services/identity.js',
    'src/services/qr.js',
    'src/services/photos.js',
    'src/services/heic-worker.js',
    'src/services/submissions.js',
    'src/routes/admin.js',
    'src/services/export.js',
    'src/services/feed.js',
  ];

  it('script names all ten anchor paths', () => {
    // Parse the anchors the script actually declares (each dot regex-escaped as
    // `\.`) and un-escape to recover the real path -- same un-escape as the
    // $GuestCriticalPaths parse above -- then assert the hardcoded list matches
    // exactly. This drift-guards both directions: a path added to or removed from
    // the script that is not mirrored in this list fails here.
    const arrayMatch = src.match(/\$GuestCriticalPaths\s*=\s*@\(([\s\S]*?)\)/);
    if (!arrayMatch)
      throw new Error('Could not locate $GuestCriticalPaths array in classify-issue-run.ps1');
    const declared = [...arrayMatch[1].matchAll(/'([^']+)'/g)].map((m) =>
      m[1].replace(/\\\./g, '.')
    );
    expect(declared.slice().sort()).toEqual(anchors.slice().sort());
  });

  it.each(anchors)('anchor path %s resolves to an existing file', (anchor) => {
    expect(fs.existsSync(path.join(repoRoot, anchor))).toBe(true);
  });
});
