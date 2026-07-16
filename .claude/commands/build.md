---
description: Run the full issue-to-PR pipeline on a goal. Usage: /build <goal>
---

You are the orchestrator defined in `agents/orchestrator.md`. Follow all rules in `CLAUDE.md` and `standards/`.

## Model check — do this first

This pipeline requires the orchestrator to run on **Opus**. If the current session is not Opus, type `/model` and switch before continuing. Running the orchestrator below Opus degrades every decision in the loop.

Model policy (by reference — authoritative text is in `agents/orchestrator.md` and `CLAUDE.md`):

| Role                                           | Model                                             |
| ---------------------------------------------- | ------------------------------------------------- |
| Orchestrator                                   | Opus                                              |
| Implementation agent                           | Sonnet                                            |
| All reviewers (including severity adjudicator) | Opus — and a different model from the implementer |

Set `model:` explicitly on every spawn call. Never rely on defaults.

## Goal

Run goal: $ARGUMENTS

## Pipeline

Execute the steps below in order. Do not skip or reorder.

**0 — Isolate.** Before any research or file mutation, run `powershell -File tools/assert-worktree.ps1`. If it exits non-zero (the session is running in the shared primary checkout, not an isolated worktree), run `powershell -File tools/new-agent-worktree.ps1 -Branch <session-branch>` — this fetches `origin/main` first and cuts the new branch from it, never from local HEAD, so the worktree starts 0 commits behind regardless of how stale the primary checkout's local `main` is (#357) — then `cd` into the returned worktree path and run every remaining step of this pipeline from inside it. If it exits `0`, the session is already isolated — continue in place.

Either way, once inside the worktree, run `powershell -File tools/check-freshness.ps1` **against this worktree** before proceeding to step 1 — expect `0 commits behind origin/main` for a freshly-cut one. **This bypasses the primary checkout's own behind-count entirely: the primary checkout being stale never aborts the build**, because the worktree was cut straight from `origin/main`, not from the primary checkout's local `main`. If the check instead reports drift (its output names the count with the literal phrase `commits behind`), resync per its instructions before continuing.

**1 — Research.** Before drafting anything, check local prior art: the codebase itself, `standards/`, `agents/`, `skills/`, `docs/`, `DESIGN.md`. For Node/Express/EJS/better-sqlite3/vitest questions, consult the installed package docs and existing tests in `tests/`. Web search is a last resort when local sources do not answer the question — delegate through `agents/researcher.md` / `skills/research-prior-art.md`.

**2 — Issue.** Create the GitHub issue first — `"C:\Program Files\GitHub CLI\gh.exe" issue create --label needs-issue-review`, labelled by tier — and capture the assigned number `N`. Then write the draft as `data/wip-issues/<N>-slug.md` using `skills/issue-create.md`. GitHub is the single source of truth — the board reflects the task from creation.

**3 — Issue review.** Spawn `agents/reviewer-issue.md` (Opus) via `skills/spawn-adversarial-review.md`. A FAIL is fixed, never overridden. Re-review with a fresh instance. If the issue is a system-level change or adds a new component, also spawn `agents/reviewer-architecture.md` (Opus) — both gates must pass before implementation begins.

**4 — Implement.** Spawn `agents/implementation-agent.md` (Sonnet) with the passing issue and all prior-art file paths.

**4a — Visual-approval loop (visual changes only) precedes criteria and step 4.** If the work touches — or will touch — `views/**/*.ejs`, `src/public/**`, badge art, or guest-/admin-facing rendered copy, the visual-approval loop runs **before** step 4's implementer is spawned for that surface and before its acceptance criteria are finalized, per `agents/orchestrator.md` § "Visual-approval loop" (the authoritative description: `npm run preview` gives the owner a seeded localhost link, the orchestrator edits the real front end directly against it, nothing commits during this phase, the owner approves live by refreshing, `tools/persist-visual-approval.ps1` freezes the pixels, and the two-doors rule governs any later change). Only once the owner has explicitly approved does step 2 (issue review) run against the now-transcribed criteria and step 4 spawn an implementer for the remaining wiring/tests, per `standards/issue-standards.md` § "the approved screen is the acceptance criterion". A non-visual change skips this step entirely.

**5 — Artifact review.** Spawn the appropriate `agents/reviewer-*.md` (Opus) against the artifact. Reviewer receives only the artifact and the relevant standard — no framing, no positive hints, no planted suspicions. For every implementation artifact (code, agent spec, skill, or standard — not a doc-only or typo-only change), after `reviewer-pr` returns PASS, also spawn `agents/reviewer-design-philosophy.md` (Opus). Both gates must pass before commit.

**6 — Create branch, then commit through the gate.** Confirm isolation is still in effect before cutting the per-issue branch — per-issue branches are always cut inside the worktree, never in the primary checkout: `powershell -File tools/assert-worktree.ps1` (if it fails, this session did not properly complete step 0 — return to step 0 before proceeding). Then create the descriptive branch — this ensures the commit lands on the new branch, not on main:

```powershell
git switch -c <descriptive-branch-name>
```

Then confirm the gate is live: `powershell -File tools/check-gate.ps1` (if it errors, run `tools/setup-hooks.ps1` first). Record the reviewers' verdict: `powershell -File tools/review_verdict.ps1 -Verdict PASS -Reviewers "<who>"`. This binds the verdict to the exact staged tree. For each reviewer also write its evidence file: `powershell -File tools/persist-review.ps1 -TreeOid <T> -ReviewerId <id> -Verdict PASS`.

After the issue review PASSes (step 3), record the issue-review evidence so the `commit-msg` gate allows the code commit:

```powershell
powershell -File tools/persist-issue-review.ps1 -IssueNumber <N> -ReviewerId <id> -Verdict PASS
```

Then `git commit -F data/commitmsg-*.txt` with `(#N)` in the message. **Two gates run:** `pre-commit` checks the staged tree has a PASS review; `commit-msg` checks the issue has a recorded review PASS. Both must pass. If `commit-msg` blocks with "issue N has no recorded review PASS", the fix is to record the issue review above — never to forge a verdict.

**7 — Ship: push → PR → CI → merge on green.** Push the branch and open a pull request:

Then push and open the PR: `"C:\Program Files\GitHub CLI\gh.exe" pr create --body-file data/<body-file>`. Watch CI to green. Before merging, post the pre-merge `<!-- buildlog-entry -->` PR comment (the entry narrative this change would previously have hand-appended to `BUILDLOG.md`) alongside the `<!-- governance-ledger -->` comment — see `agents/orchestrator.md` § step 7 for the exact mechanics (marker, last-comment-wins refresh, and how `scripts/ledger-harvest.js` harvests it post-merge into the rendered `BUILDLOG.md` on the `ledger` branch). Then:

- **Non-visual change types — bug fix, security fix, refactor, correctness, tests:** merge once the adversarial review has passed and CI is green. The owner does not perform merges; owner control is upstream (issue-speccing) and downstream (revert via git history).
- **Visual and product-direction changes:** merge once the step-4a visual-approval loop has reached explicit owner approval AND the adversarial review has passed and CI is green. The visual-approval loop is the owner's pre-merge control for this change type; issue-speccing and revert remain available as well.

`main` is never knowingly left red. If CI goes red, fix the cause or revert the commit before proceeding. Then close the GitHub issue referencing the commit and spawn `agents/reviewer-tracker-sync.md` (Opus) to confirm the board is in sync.

## Stop condition

A FAIL is fixed by the implementation agent and re-reviewed with a fresh reviewer instance — never overridden by the author. After 3 rounds without PASS, the orchestrator first declares whether it **concedes** — judges at least one open defect warrants a fix. **Concede: no dispute, no referee** — the adjudicator does not fire; the implementation agent rewrites against all open feedback and a fresh reviewer re-reviews, and the orchestrator records the concession (naming the defect) in the run output. **Contest** — the orchestrator seeks to exit with defects open — spawns `agents/severity-adjudicator.md` (Opus, clean prompt, no context from prior rounds) exactly as before. The adjudicator classifies every remaining open defect as `consequential` or `inconsequential` and cites a basis for each. Exit is authorized only when every remaining defect is inconsequential, on the contest path — a concession never authorizes exit. On a consequential defect the loop continues. The impasse halt is keyed to **6 total rounds without PASS**, whether or not an adjudicator ran (today's 3-to-trigger plus 3-post-gate ceiling, unchanged) — log it in `BUILDLOG.md` and continue with independent segments. A halt is not an acceptance. Full rule: `standards/adversarial-review-protocol.md` § "Stop condition — soft cap and severity gate".
