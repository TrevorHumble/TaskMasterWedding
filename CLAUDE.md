# CLAUDE.md — Operating rules for this repo

Behavioral rules for any AI agent working in this repository. This file is the repo's own operating contract. It is not the user's global `CLAUDE.md`.

## North Star

Every change serves the goals in [`docs/north-star.md`](docs/north-star.md). Orient your work to them; if a change moves none of them, question whether it belongs in this build.

**The shift we design for:** a wedding guest goes from passive spectator to active, _steered_ participant — engaging with what the hosts highlight, mingling beyond their own circle, and adding to a shared record of the weekend, because the game rewards it — engaged in the celebration, not the screen. The end user is the **guest**; it pays off for the couple (Lilly & Axel) and their planners. Live for guests by **Friday, Aug 7, 2026**.

The four goals (full text and outcomes in [`docs/north-star.md`](docs/north-star.md)):

- **A — Easy in, solid throughout:** any guest playing in seconds, fast under the whole party at once, no one sidelined by the tech.
- **B — A game worth playing:** instant rewards, badges and standings, prizes on display — guests active in the celebration, not spectators or screen-bound.
- **C — The hosts run the show:** the couple and planners steer tasks, set prizes, and moderate (hide / move / delete) — choreographing the weekend they planned.
- **D — One shared record, kept:** a hundred phones pooled into one gallery, a favorites slideshow at the end, a keepsake export after.

## Governance freeze (2026-07-17 – 2026-08-08)

**Frozen surface.** `.githooks/`, `tools/`, `standards/`, `agents/`, `skills/`, `.github/`, `.claude/`,
`CLAUDE.md`, `AGENTS.md`, and `docs/north-star.md` are frozen until **2026-08-08**. This
pipeline's whole capacity goes to guest-facing work for the three weeks before the wedding, not to
reviewing, repairing, and re-reviewing its own enforcement machinery. `DESIGN.md` is documentation, not
enforcement machinery, and is carved out of the freeze (owner-authorized, #707): it stays editable
through the normal pipeline for the freeze's duration.

**Filing rule.** A defect found on the frozen surface is filed as a GitHub issue carrying the
`post-wedding` label and is **not built** — unless it blocks a guest-facing path or CI, in which case it
is built as an ordinary issue with recorded owner approval. A deferred review finding follows the same
rule: during the freeze it is one line commented on the single parking issue, **#588**, never a new
GitHub issue — see `standards/adversarial-review-protocol.md` § "Finding disposition".

**Approval to change the frozen surface.** A change to the frozen surface before 2026-08-08 requires
explicit owner approval, recorded in the issue that carries it. This issue (#587) is itself such a
change, and the owner authorized it on 2026-07-17.

Rationale and the measured evidence behind the freeze (merge-throughput cliff, governance-machinery
growth, zero app-code blocker/major defects since 07-11, the proof layer's own failures) are recorded in
`DESIGN.md`'s teardown ADR — this section states the rule, not the case for it.

## How work flows: the orchestrator pipeline

All changes go through an enforced pipeline. Do not commit code straight to the default branch and do not skip steps.

1. **Issue** — file the work as a GitHub issue meeting `standards/issue-standards.md` (user story, Given/When/Then acceptance criteria, implementation plan, dependency map).
2. **Adversarial review of the issue** — an independent reviewer attacks the issue against the standard before any code is written. See `standards/adversarial-review-protocol.md`.
3. **Implement** — an implementer agent writes the change to satisfy the issue's acceptance criteria.
4. **Adversarial review of the PR** — a PR reviewer plus the design-philosophy reviewer attack the implementation against the issue and the standards; a blocker/major finding takes one re-check, scoped to the fix.
5. **Commit / PR** — only after review passes. Push the branch, open a pull request (`gh pr create`), watch CI to green, then merge. Non-visual changes merge once adversarial review has passed and CI is green. **Visual / product-direction changes** are different in shape, not just gated later: the owner settles the look **live**, first — `npm run preview` gives him a seeded localhost link, the orchestrator edits the real `views/**`/`src/public/**` directly against it while nothing commits, and only once he says approved does `tools/persist-visual-approval.ps1` freeze the pixels and the normal pipeline (criteria, issue review, implementation, PR review) run on the transcribed result — see `agents/orchestrator.md` § "Visual-approval loop" and `DESIGN.md` § "Visual-approval loop reinstated (#294) -- superseded by #378". `.githooks/commit-msg` (a code commit must name a GitHub issue) is the only local hook; CI is the rest of the gate.

**Wave boundary — owner-invoked review, not a gate.** After a wave's planned batch of issues merges, the owner may run `/post-wave-review` — a cross-PR regression, seam, and docs-vs-code drift check plus a lived-data drill. This is **owner-invoked**: it never runs automatically and is never a precondition for starting the next wave. Full mechanics: `standards/adversarial-review-protocol.md` § "Wave governance"; orchestrator-side nudge: `agents/orchestrator.md` § "Wave boundary".

Standards live in `standards/`. Agent definitions live in `agents/`. Both are ported in separately; treat them as the source of truth and point to them rather than restating them.

## Model policy

Every spawned agent sets its `model` explicitly. Never rely on a default that may escalate silently.

| Role         | Model                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| Orchestrator | Opus                                                                    |
| Implementer  | Sonnet                                                                  |
| Reviewers    | Opus by default, a different model from the implementer — see exception |

Reviewers run on a different model than the implementer, on every issue by default, so they do not inherit the implementer's correlated blind spots. A reviewer must never review its own output.

**The one exception is the `sonnet-only` tier (#680).** An issue the issue reviewer (`reviewer-issue`) awarded `AWARD sonnet-only` — per `standards/issue-standards.md` § "Sonnet tier eligibility" — runs its implementer and reviewers both on Sonnet; the orchestrator itself still runs Opus. This is a judgment call the issue reviewer makes once, at issue-review time, reading the issue's own touched paths — not a run-tier classifier script, and not a standing carve-out for any issue that merely looks routine. Every issue without that award keeps the default Opus-reviewer bar in the table above. Full mechanics, including the coverage-first instruction appended to sonnet-tier reviewer spawns and manual mid-run escalation: `agents/orchestrator.md` § "Model policy".

**Phase-1 visual edits are one carve-out (#378).** During the live-preview loop (`agents/orchestrator.md` § "Visual-approval loop"), the orchestrator (Opus) edits `views/**/*.ejs` and `src/public/**` directly instead of spawning the Sonnet implementer for each owner-requested tweak — the implementer has no memory of the phase-1 conversation, so it cannot know what the owner already rejected two refreshes ago, and spawning it per five-second edit would re-litigate settled taste calls for no benefit. This holds only while nothing commits. The **phase-2 tree** — once the owner has approved, the pixels are frozen, and the criteria are transcribed — is not exempted: it goes through the normal implementer-then-reviewer bar in the table above, unchanged.

**Fable (#453).** Fable is an available model, used only on the owner's explicit per-use signal. Absent that signal, every implementer — Fable included — goes through the standard independent adversarial review per the table above; there is no standing Fable-specific review handling until the owner specifies one.

## Adversarial review, in brief

- Assume total failure. Every artifact enters review as broken until proven otherwise.
- Every finding cites real evidence (`file:line`, command output, issue/PR number). Every best-practice claim cites a current dated source.
- The spawner gives the goal, not the implementation. No positive framing, no planted suspicions, full scope.
- Final verdict is a single `PASS`/`FAIL` token with a numbered defect list. A PASS with open blockers or majors is not a PASS.
- **Issues and plans: 1 Opus reviewer** (`reviewer-issue`). Never a panel of issue-reviewers.
- **Code review, round 1: exactly 1 PR reviewer plus the design-philosophy reviewer, both must PASS.**
- **One-round stop rule:** minor and nit findings are fixed inline and shipped with no re-review; only a blocker or major finding triggers a re-check, scoped to that fix, with one fresh reviewer. No severity adjudicator, no reviewer panels.
- The security lens (`agents/reviewer-security.md`) and the architecture lens (`agents/reviewer-architecture.md`, on-request only) are advisory — a finding from either is fixed, dropped, or deferred like any other finding.

Full protocol, including the review-dispatch checklist ("Which reviews does this change need?"), the advisory-lens lifecycle, and finding disposition: `standards/adversarial-review-protocol.md`.

## Documentation split

Keep these separate (per `standards/documentation-standards.md`):

| File        | Contains                                               |
| ----------- | ------------------------------------------------------ |
| `README.md` | Getting started and reference for humans.              |
| `CLAUDE.md` | Behavioral rules for the agent operating in this repo. |
| `DESIGN.md` | Architecture decisions, rationale, tradeoffs.          |

Do not mix them. No FINAL / LAST / TRULY_FINAL in filenames or headers. No AI-slop filler (`elegantly`, `robustly`, `seamlessly`, `comprehensively`, `leverages`, `powerful`, and the rest of the banned list in the standards).

## Repo conventions

- **GitHub is the single source of truth** for tasks (issues) and docs. Status is canonical on the board.
- **GitHub CLI** is at `C:\Program Files\GitHub CLI\gh.exe` and is not on PATH. Use the full path in PowerShell.
- **Environment is Windows / PowerShell.** Use PowerShell syntax (`$env:VAR`, `$null`, backtick line continuation; no `&&` / `||`).
- **Secrets and runtime state are gitignored:** `data/` (database, uploads, thumbnails, exports, `admin.hash`) and `.env`. Never commit them.
- **Config is central.** Read paths and port from `config.js`. Do not hard-code a path or port elsewhere.
- **This documentation pass does not touch source code, `standards/`, `agents/`, `skills/`, or config.** Another process owns those.
- **One working tree = one driver.** Any file-mutating agent or concurrent session operates in its own git worktree, created via `tools/new-agent-worktree.ps1 -Branch <name>` — never share the primary checkout with another running session. This is what stops concurrent sessions from stashing, reverting, or switch-branch-under-ing each other's uncommitted work.

## Dependency updates (Dependabot)

Dependabot PRs are classified into two tiers by `tools/classify-dep-pr.ps1`:

- **auto** — may merge on green CI with no separate review. Applies to: all GitHub Actions bumps; all npm dev-dependency bumps (any semver — a dev bump cannot break the running app, and CI catches a broken build); npm prod minor/patch bumps to non-wedding-critical packages.
- **review** — held for a tracked decision before merge. Applies to: any npm prod major bump; any bump (even patch or minor) to a wedding-critical prod dependency.

**Wedding-critical prod dependencies** (a bad bump breaks a core guest path):
`multer`, `sharp`, `ejs`, `better-sqlite3`, `bcryptjs`, `archiver`

The authoritative tier logic lives in `tools/classify-dep-pr.ps1`; the summary here is a human-readable restatement, and the wedding-critical list is drift-guarded by `tests/classify-dep-pr.test.js`.

**Native-binary members need an on-host smoke test before merge (#304).** Of the wedding-critical list, `sharp` and `better-sqlite3` ship a prebuilt native binary (a `.node` file) per platform. A `review`-tier bump to either must pass an on-host `npm ci` followed by `node -e "require('<dep>')"` (exit 0) on the Windows event laptop before merge — not just green CI. Why: Windows Smart App Control can block a new/unknown unsigned native binary by cloud reputation until its hash accrues one (see `DESIGN.md` § "sharp 0.35.2 SAC block was a reputation-lag, now cleared"), and CI runs on Linux, which cannot reproduce or catch this Windows-only failure mode.

Run the classifier against a PR's metadata to determine its tier:

```powershell
powershell -File tools/classify-dep-pr.ps1 -Ecosystem npm -DepName multer -SemverBump minor -DepType prod
```

Output is the single token `auto` or `review`, exit 0.

## What needs extra rigor

A change to the frozen governing-artifact surface needs owner approval before it merges — see
"Governance freeze" above. That freeze is the extra-rigor bar for that surface during the freeze
window; there is no separate system-level reviewer-count bar layered on top of it.

**Issue-reference gate:** every code commit must name a GitHub issue — `.githooks/commit-msg` blocks a
commit that stages a non-`.md` file and names none (`(#N)`, a closing keyword, or an `issue-N` branch).
This is a cheap, mechanical check; it does not itself verify that a review happened — see
`WHAT-IT-CHECKS.md` for the honest description of what review coverage actually is right now.

**Issue lifecycle marker:** new issues are born carrying the `needs-issue-review` label (applied at `gh issue create` time). The label is cleared after a PASS on the issue review, via `gh issue edit <N> --remove-label needs-issue-review`.
