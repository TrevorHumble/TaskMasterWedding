---
description: Run the full issue-to-PR pipeline on a goal. Usage: /build <goal>
---

You are the orchestrator defined in `agents/orchestrator.md`. Follow all rules in `CLAUDE.md` and `standards/`.

## Governance freeze (2026-07-17 – 2026-08-08)

The governing-artifact surface (`.githooks/`, `tools/`, `standards/`, `agents/`, `skills/`, `.github/`,
`.claude/`, `DESIGN.md`, `CLAUDE.md`, `AGENTS.md`, `docs/north-star.md`) is frozen. Do not open an issue
that touches it without recorded owner approval — file it with the `post-wedding` label instead. Full
rule: `CLAUDE.md` § "Governance freeze".

## Model check — do this first

This pipeline requires the orchestrator to run on **Opus**. If the current session is not Opus, type `/model` and switch before continuing. Running the orchestrator below Opus degrades every decision in the loop.

Model policy (by reference — authoritative text is in `agents/orchestrator.md` and `CLAUDE.md`):

| Role                 | Model                                                          |
| -------------------- | --------------------------------------------------------------- |
| Orchestrator         | Opus                                                            |
| Implementation agent | Sonnet                                                          |
| All reviewers        | Opus by default — and a different model from the implementer   |

Set `model:` explicitly on every spawn call. Never rely on defaults.

**Exception — the `sonnet-only` award (#680).** An issue the issue reviewer awarded `AWARD
sonnet-only` (`standards/issue-standards.md` § "Sonnet tier eligibility") runs its implementer and
reviewers both on Sonnet; the orchestrator still runs Opus. Full mechanics: `agents/orchestrator.md` §
"Model policy".

## Goal

Run goal: $ARGUMENTS

## Pipeline

Execute the steps below in order. Do not skip or reorder.

**0 — Isolate.** Before any research or file mutation, run `powershell -File tools/assert-worktree.ps1`. If it exits non-zero (the session is running in the shared primary checkout, not an isolated worktree), run `powershell -File tools/new-agent-worktree.ps1 -Branch <session-branch>` — this fetches `origin/main` first and cuts the new branch from it, never from local HEAD, so the worktree starts 0 commits behind regardless of how stale the primary checkout's local `main` is (#357) — then `cd` into the returned worktree path and run every remaining step of this pipeline from inside it. If it exits `0`, the session is already isolated — continue in place.

Either way, once inside the worktree, run `powershell -File tools/check-freshness.ps1` **against this worktree** before proceeding to step 1 — expect `0 commits behind origin/main` for a freshly-cut one. **This bypasses the primary checkout's own behind-count entirely: the primary checkout being stale never aborts the build**, because the worktree was cut straight from `origin/main`, not from the primary checkout's local `main`. If the check instead reports drift (its output names the count with the literal phrase `commits behind`), resync per its instructions before continuing.

**1 — Research.** Before drafting anything, check local prior art: the codebase itself, `standards/`, `agents/`, `skills/`, `docs/`, `DESIGN.md`. For Node/Express/EJS/better-sqlite3/vitest questions, consult the installed package docs and existing tests in `tests/`. Web search is a last resort when local sources do not answer the question — delegate through `agents/researcher.md` / `skills/research-prior-art.md`.

**2 — Visual-approval loop (visual changes only).** If the work touches — or will touch — `views/**/*.ejs`, `src/public/**`, badge art, or guest-/admin-facing rendered copy, this step runs **before** the issue is drafted, before it is reviewed, and before an implementer is spawned for that surface, per `agents/orchestrator.md` § "Visual-approval loop" (the authoritative description: `npm run preview` gives the owner a seeded localhost link, the orchestrator edits the real front end directly against it, nothing commits during this phase, the owner approves live by refreshing, `tools/persist-visual-approval.ps1` freezes the pixels, and the two-doors rule governs any later change).

Before the owner approves the look, **only `views/**` and `src/public/**` may be edited** — routes, services, and tests must not be written. Rendering realistic data does not authorize production logic: fake it in the view, because phase-1 backing is disposable and gets thrown away once the look is approved.

Only once the owner has explicitly approved does step 3 (issue) draft the now-transcribed criteria and step 5 (implement) spawn an implementer for the remaining wiring/tests, per `standards/issue-standards.md` § "the approved screen is the acceptance criterion". A non-visual change skips this step entirely.

**3 — Issue.** Create the GitHub issue first — `"C:\Program Files\GitHub CLI\gh.exe" issue create --label needs-issue-review`, labelled by tier — and capture the assigned number `N`. Then write the draft as `data/wip-issues/<N>-slug.md` using `skills/issue-create.md`. GitHub is the single source of truth — the board reflects the task from creation.

**4 — Issue review.** Spawn `agents/reviewer-issue.md` (Opus) via `skills/spawn-adversarial-review.md`. A FAIL is fixed, never overridden. Re-review with a fresh instance. `agents/reviewer-architecture.md` is an on-request lens, not part of this step — spawn it separately only if the orchestrator or owner explicitly wants an architectural opinion.

**5 — Implement.** Spawn `agents/implementation-agent.md` (Sonnet) with the passing issue and all prior-art file paths.

**6 — Artifact review.** Spawn the appropriate `agents/reviewer-*.md` (Opus) against the artifact. Reviewer receives only the artifact and the relevant standard — no framing, no positive hints, no planted suspicions. For every implementation artifact (code, agent spec, skill, or standard — not a doc-only or typo-only change), after `reviewer-pr` returns PASS, also spawn `agents/reviewer-design-philosophy.md` (Opus). Both must PASS before commit. A blocker/major finding on a later round takes exactly one re-check with one fresh reviewer, scoped to the fix — `standards/adversarial-review-protocol.md` § "One-round stop rule".

**7 — Create branch, then commit.** Confirm isolation is still in effect before cutting the per-issue branch — per-issue branches are always cut inside the worktree, never in the primary checkout: `powershell -File tools/assert-worktree.ps1` (if it fails, this session did not properly complete step 0 — return to step 0 before proceeding). Then create the descriptive branch — this ensures the commit lands on the new branch, not on main:

```powershell
git switch -c <descriptive-branch-name>
```

Then confirm the hooks are live: `git config core.hooksPath` should print `.githooks` (if not, run `tools/setup-hooks.ps1` first). Then `git commit -F data/commitmsg-*.txt` with `(#N)` in the message. **One hook runs at commit time:** `commit-msg` checks that a code commit's message names a GitHub issue (`(#N)`, a closing keyword, or an `issue-N` branch); a doc-only commit is exempt. If it blocks, add the missing reference — there is no review-evidence file to record during the freeze (`CLAUDE.md` § "Governance freeze").

**8 — Ship: push → PR → CI → merge on green.** Push the branch and open a pull request:

`"C:\Program Files\GitHub CLI\gh.exe" pr create --body-file data/<body-file>`. Watch CI to green. Then:

- **Non-visual change types — bug fix, security fix, refactor, correctness, tests:** merge once the adversarial review has passed and CI is green. The owner does not perform merges; owner control is upstream (issue-speccing) and downstream (revert via git history).
- **Visual and product-direction changes:** merge once the step-2 visual-approval loop has reached explicit owner approval AND the adversarial review has passed and CI is green. The visual-approval loop is the owner's pre-merge control for this change type; issue-speccing and revert remain available as well.

`main` is never knowingly left red. If CI goes red, fix the cause or revert the commit before proceeding. Then close the GitHub issue referencing the commit and append a one-line entry to `BUILDLOG.md`.

## Stop condition

A FAIL is fixed by the implementation agent and re-reviewed with a fresh reviewer instance — never overridden by the author, and never routed to a new issue or a `spawn_task` chip merely to end the round (`standards/adversarial-review-protocol.md` § "Finding disposition"). Minor and nit findings are fixed inline and shipped with no re-review; a blocker or major finding takes exactly one re-check, scoped to the fix, with one fresh reviewer. If a segment cannot reach PASS after two full re-review rounds on the same blocker/major finding, halt the segment, log it in `BUILDLOG.md`, and continue with independent segments — a halt is not an acceptance. Full rule: `standards/adversarial-review-protocol.md` § "One-round stop rule".
