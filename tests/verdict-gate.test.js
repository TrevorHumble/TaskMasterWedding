// tests/verdict-gate.test.js
// Vitest tests for S2 evidence-gate ACs 1-8.
// Windows PowerShell 5.1 is the launcher on win32; pwsh on other platforms.
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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

const TOOLS_DIR = path.resolve(__dirname, '..', 'tools');
const VALIDATE = path.join(TOOLS_DIR, 'validate-verdict.ps1');
const CORE = path.join(TOOLS_DIR, 'verdict-core.ps1');
const PRE_COMMIT = path.resolve(__dirname, '..', '.githooks', 'pre-commit');

// Fixed tree OID used in fixtures (40 hex chars, no git needed for AC1-AC6)
const T = 'a'.repeat(40);

function makeEvidence(overrides) {
  return Object.assign(
    {
      schema: 'rev1',
      reviewer_id: 'reviewer-a',
      model: 'opus',
      role: 'pr',
      verdict: 'PASS',
      findings_count: 0,
      tree_oid: T,
      ts: new Date().toISOString(),
    },
    overrides
  );
}

function writeEvidence(dir, filename, obj) {
  const treeDir = path.join(dir, T);
  fs.mkdirSync(treeDir, { recursive: true });
  fs.writeFileSync(path.join(treeDir, filename), JSON.stringify(obj));
}

// Run validate-verdict.ps1 via -File and capture both exit code and stderr.
function runValidate(tmp, extraArgs) {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    VALIDATE,
    '-Tree',
    T,
    '-ReviewsRoot',
    tmp,
  ].concat(extraArgs || []);
  const r = spawnSync(PS, args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stderr: r.stderr || '',
    stdout: r.stdout || '',
  };
}

// Run Get-RequiredBar via inline -Command using dot-source
function runGetRequiredBar(stagedPaths) {
  // Build a comma-separated list for PowerShell array literal
  const listExpr = stagedPaths.map((p) => `'${p.replace(/'/g, "''")}'`).join(',');
  const cmd = `. '${CORE}'; Get-RequiredBar -StagedPaths @(${listExpr})`;
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  return {
    status: r.status === null ? 1 : r.status,
    value: parseInt(out, 10),
    raw: out,
  };
}

const maybeDescribe = launcherMissing
  ? describe.skip.bind(describe, `${PS} not found — skipping verdict-gate tests`)
  : describe;

// AC7 drives a real `git commit` through the hook, which shells out to Windows-only
// `powershell` (.githooks/pre-commit). On a non-win32 runner that binary is absent, so
// the hook would block the "should pass" commit too. Gate AC7 to win32 to keep CI green.
const maybeIt = launcherMissing || process.platform !== 'win32' ? it.skip : it;

maybeDescribe('verdict-gate (evidence gate)', () => {
  // AC1: regression of S1 — no evidence dir -> non-zero exit, correct message
  it('AC1: no evidence dir -> blocked with correct message', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac1-'));
    const result = runValidate(tmp);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`blocked: no review evidence for tree ${T}`);
  });

  // AC2: non-system staged path -> Get-RequiredBar returns 1
  it('AC2: non-system staged path -> required bar is 1', () => {
    const result = runGetRequiredBar(['src/app.js', 'README.md']);
    expect(result.status).toBe(0);
    expect(result.value).toBe(1);
  });

  // AC3: system-level staged path -> Get-RequiredBar returns 2
  it('AC3: system path (skills/run-segment.md) -> required bar is 2', () => {
    const result = runGetRequiredBar(['skills/run-segment.md']);
    expect(result.status).toBe(0);
    expect(result.value).toBe(2);
  });

  // AC3b: tools/ also counts as system
  it('AC3b: tools/ staged path -> required bar is 2', () => {
    const result = runGetRequiredBar(['tools/validate-verdict.ps1']);
    expect(result.status).toBe(0);
    expect(result.value).toBe(2);
  });

  // #218 AC1: reviewer charters are the experimental governance surface -> bar 1
  it('#218 AC1a: agents/reviewer-*.md only -> required bar is 1', () => {
    const result = runGetRequiredBar(['agents/reviewer-design-philosophy.md']);
    expect(result.status).toBe(0);
    expect(result.value).toBe(1);
  });

  // #218 AC1: everything else on the system-level surface stays kernel -> bar 2
  it('#218 AC1b: kernel paths (verdict-core, protocol, orchestrator) -> required bar is 2', () => {
    for (const p of [
      'tools/verdict-core.ps1',
      'standards/adversarial-review-protocol.md',
      'agents/orchestrator.md',
    ]) {
      const result = runGetRequiredBar([p]);
      expect(result.status).toBe(0);
      expect(result.value).toBe(2);
    }
  });

  // #218: a tree mixing a reviewer charter with a kernel path takes the kernel bar
  it('#218: reviewer charter + kernel path staged together -> required bar is 2', () => {
    const result = runGetRequiredBar([
      'agents/reviewer-pr.md',
      'standards/adversarial-review-protocol.md',
    ]);
    expect(result.status).toBe(0);
    expect(result.value).toBe(2);
  });

  // #218: non-charter agents/ files and nested lookalikes are NOT carved out
  it('#218: agents/severity-adjudicator.md and nested reviewer-*.md stay bar 2', () => {
    for (const p of ['agents/severity-adjudicator.md', 'agents/sub/reviewer-x.md']) {
      const result = runGetRequiredBar([p]);
      expect(result.status).toBe(0);
      expect(result.value).toBe(2);
    }
  });

  // AC4: required=2, only one distinct PASS -> blocked with correct count message
  it('AC4: required=2, only 1 distinct PASS reviewer -> blocked', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac4-'));
    writeEvidence(tmp, 'a.json', makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }));
    const result = runValidate(tmp, ['-Required', '2']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`blocked: 1/2 distinct PASS reviewers for tree ${T}`);
  });

  // AC5: required=2, two distinct PASS reviewers -> exit 0
  it('AC5: required=2, 2 distinct PASS reviewers -> exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac5-'));
    writeEvidence(tmp, 'a.json', makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }));
    writeEvidence(tmp, 'b.json', makeEvidence({ reviewer_id: 'reviewer-b', verdict: 'PASS' }));
    const result = runValidate(tmp, ['-Required', '2']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(`ok: 2 distinct PASS reviewer(s) for tree ${T}`);
  });

  // AC6: S1-minor fix — same reviewer_id with both PASS and FAIL -> FAIL (not masked)
  it('AC6: reviewer with both PASS and FAIL files -> blocked as FAIL', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac6-'));
    const treeDir = path.join(tmp, T);
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(
      path.join(treeDir, 'r-pass.json'),
      JSON.stringify(makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }))
    );
    fs.writeFileSync(
      path.join(treeDir, 'r-fail.json'),
      JSON.stringify(makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'FAIL' }))
    );
    const result = runValidate(tmp, ['-Required', '1']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`blocked: a FAIL review is present for tree ${T}`);
  });

  // AC7: integration — temp git repo with new pre-commit hook active
  // Evidence-less typed PASS -> rejected; with evidence -> succeeds
  maybeIt(
    'AC7: gate rejects evidence-less commit; succeeds after evidence written',
    () => {
      // Create a temp git repo — never use the real repo
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac7-'));

      // git init
      execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
      execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], {
        encoding: 'utf8',
      });
      execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });

      // Copy the pre-commit hook into the temp repo
      const hooksDir = path.join(tmp, '.githooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const hookSrc = fs.readFileSync(PRE_COMMIT, 'utf8');
      const hookDest = path.join(hooksDir, 'pre-commit');
      fs.writeFileSync(hookDest, hookSrc);
      // Make hook executable (needed on non-Windows; on Windows git respects the bit via Git for Windows)
      try {
        fs.chmodSync(hookDest, 0o755);
      } catch {
        /* chmod is best-effort; git respects the bit on win32 */
      }

      // Point core.hooksPath to our hooks dir
      execFileSync('git', ['-C', tmp, 'config', 'core.hooksPath', '.githooks'], {
        encoding: 'utf8',
      });

      // Stage a file
      const dummyFile = path.join(tmp, 'hello.txt');
      fs.writeFileSync(dummyFile, 'hello');
      execFileSync('git', ['-C', tmp, 'add', 'hello.txt'], { encoding: 'utf8' });

      // Compute the current tree oid
      const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();

      // Write a verdict.json that says PASS for this exact tree (no evidence files)
      const reviewStateDir = path.join(tmp, '.review_state');
      fs.mkdirSync(reviewStateDir, { recursive: true });
      const verdictObj = {
        schema: 'rev1',
        verdict: 'PASS',
        tree_oid: treeOid,
        reviewers: ['reviewer-a'],
        models: ['opus'],
        role: 'pr',
        ts: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(reviewStateDir, 'verdict.json'), JSON.stringify(verdictObj));

      // Stage the verdict.json so it is part of the tree
      // (re-stage dummy file only so hook can re-check)
      // Actually we DON'T stage .review_state (gitignored) — the verdict.json check
      // in the hook reads from the working tree path. Let's check the hook carefully.
      // The hook reads $root/.review_state/verdict.json and $root/tools/validate-verdict.ps1.
      // The tools/ dir is in the real repo, not the temp one. We need to copy tools/ too.

      // Copy tools/ to the temp repo so the hook can find validate-verdict.ps1
      const toolsDestDir = path.join(tmp, 'tools');
      fs.mkdirSync(toolsDestDir, { recursive: true });
      const toolsFiles = fs.readdirSync(TOOLS_DIR);
      for (const tf of toolsFiles) {
        if (tf.endsWith('.ps1')) {
          fs.copyFileSync(path.join(TOOLS_DIR, tf), path.join(toolsDestDir, tf));
        }
      }

      // Re-compute tree after staging changes (tree does not include untracked .review_state)
      // Only hello.txt is staged, so treeOid stays the same. Verify:
      const treeOid2 = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();
      // Update verdict.json tree_oid if it changed
      if (treeOid2 !== treeOid) {
        verdictObj.tree_oid = treeOid2;
        fs.writeFileSync(path.join(reviewStateDir, 'verdict.json'), JSON.stringify(verdictObj));
      }
      const finalTree = treeOid2;

      // Attempt commit WITHOUT evidence files -> should fail
      const commitFail = spawnSync('git', ['-C', tmp, 'commit', '-m', 'should fail'], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        }),
      });
      expect(commitFail.status).not.toBe(0);
      // Bind the rejection to the evidence gate specifically, not just any block path.
      expect(commitFail.stderr).toContain('blocked: no review evidence for tree');

      // Now write the evidence file
      const evidenceDir = path.join(reviewStateDir, 'reviews', finalTree);
      fs.mkdirSync(evidenceDir, { recursive: true });
      const evidenceObj = {
        schema: 'rev1',
        reviewer_id: 'reviewer-a',
        model: 'opus',
        role: 'pr',
        verdict: 'PASS',
        findings_count: 0,
        tree_oid: finalTree,
        ts: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(evidenceDir, 'reviewer-a.json'), JSON.stringify(evidenceObj));

      // Attempt commit WITH evidence file -> should succeed
      const commitPass = spawnSync('git', ['-C', tmp, 'commit', '-m', 'should pass'], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, {
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        }),
      });
      expect(commitPass.status).toBe(0);
    },
    30000
  );

  // AC8: pre-commit first line is still #!/bin/sh
  it('AC8: pre-commit first line is #!/bin/sh', () => {
    const content = fs.readFileSync(PRE_COMMIT, 'utf8');
    const firstLine = content.split('\n')[0];
    expect(firstLine).toBe('#!/bin/sh');
  });

  // AC9: a non-ASCII staged path under a system dir must still force required=2.
  // git core.quotepath must be disarmed in validate-verdict, or the leading quote
  // git adds to a non-ASCII path would dodge the ^tools/ anchor and silently drop
  // the system-level change to the 1-reviewer bar.
  maybeIt(
    'AC9: non-ASCII system-level path still forces required=2',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-s2ac9-'));
      execFileSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
      execFileSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.com'], {
        encoding: 'utf8',
      });
      execFileSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
      // A new file INSIDE tools/ (system-level) named with a non-ASCII character.
      fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tools', 'évil.ps1'), '# x');
      execFileSync('git', ['-C', tmp, 'add', '-A'], { encoding: 'utf8' });
      const treeOid = execFileSync('git', ['-C', tmp, 'write-tree'], { encoding: 'utf8' }).trim();
      // One PASS evidence for the tree. If required were wrongly derived as 1 this would
      // pass (ok); with required=2 correctly derived it must report "1/2".
      const reviewsRoot = path.join(tmp, '.review_state', 'reviews');
      const evDir = path.join(reviewsRoot, treeOid);
      fs.mkdirSync(evDir, { recursive: true });
      fs.writeFileSync(
        path.join(evDir, 'reviewer-a.json'),
        JSON.stringify(
          makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS', tree_oid: treeOid })
        )
      );
      // Run validate-verdict from inside the temp repo so its `git diff --cached` sees the staged path.
      const r = spawnSync(
        PS,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          VALIDATE,
          '-Tree',
          treeOid,
          '-ReviewsRoot',
          reviewsRoot,
        ],
        { cwd: tmp, encoding: 'utf8' }
      );
      expect(r.stderr).toContain(`blocked: 1/2 distinct PASS reviewers for tree ${treeOid}`);
      expect(r.status).not.toBe(0);
    },
    30000
  );

  // AC10: two PASS files with the SAME reviewer_id count as ONE distinct reviewer.
  // Guards the anti-self-attestation core of the two-reviewer bar: one actor cannot
  // satisfy required=2 by writing two evidence files under one id.
  it('AC10: two same-reviewer_id PASS files -> still blocked at required=2', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ac10-'));
    writeEvidence(tmp, 'a1.json', makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }));
    writeEvidence(tmp, 'a2.json', makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS' }));
    const result = runValidate(tmp, ['-Required', '2']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`blocked: 1/2 distinct PASS reviewers for tree ${T}`);
  });

  // AC11: evidence whose inner tree_oid != its directory is ignored (replay protection,
  // #45 DoD — a PASS recorded for one tree cannot authorize a different tree).
  it('AC11: evidence with mismatched inner tree_oid is ignored', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ac11-'));
    writeEvidence(
      tmp,
      'a.json',
      makeEvidence({ reviewer_id: 'reviewer-a', verdict: 'PASS', tree_oid: 'b'.repeat(40) })
    );
    const result = runValidate(tmp, ['-Required', '1']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`blocked: no review evidence for tree ${T}`);
  });
});
