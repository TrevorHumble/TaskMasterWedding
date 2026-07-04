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

## How work flows: the orchestrator pipeline

All changes go through an enforced pipeline. Do not commit code straight to the default branch and do not skip steps.

1. **Issue** — file the work as a GitHub issue meeting `standards/issue-standards.md` (user story, Given/When/Then acceptance criteria, implementation plan, dependency map).
2. **Adversarial review of the issue** — independent reviewers attack the issue against the standard before any code is written. See `standards/adversarial-review-protocol.md`.
3. **Implement** — an implementer agent writes the change to satisfy the issue's acceptance criteria.
4. **Adversarial review of the PR** — independent reviewers attack the implementation against the issue and the standards.
5. **Commit / PR** — only after review passes. Push the branch, open a pull request (`gh pr create`), watch CI to green, then merge — every change type, including visual / product-direction, merges once adversarial review has passed and CI is green. The `.githooks/pre-commit` hook and the scripts in `tools/` enforce the gates locally.

Standards live in `standards/`. Agent definitions live in `agents/`. Both are ported in separately; treat them as the source of truth and point to them rather than restating them.

## Model policy

Every spawned agent sets its `model` explicitly. Never rely on a default that may escalate silently.

| Role         | Model                                            |
| ------------ | ------------------------------------------------ |
| Orchestrator | Opus                                             |
| Implementer  | Sonnet                                           |
| Reviewers    | Opus, and a different model from the implementer |

Reviewers run on a different model than the implementer so they do not inherit the implementer's correlated blind spots. A reviewer must never review its own output.

**Fable review patterns (owner-decided 2026-07-04, #207 — narrows the #203 full exception).** Fable-authored work follows two patterns, each capped at **one review round** (report → fix → same-reviewer confirm; an unresolved consequential defect halts and surfaces to the owner): (1) **routine** (non-system-level, non-security-flagged) work is self-certified via a **fresh-context self-review applying the design-philosophy charter** (`standards/design-philosophy.md`) run in a clean context with none of the implementing conversation; (2) **system-level, security-flagged, and self-modification** work takes exactly **one independent reviewer** (Opus, clean prompt) — self-certification alone can never satisfy those trees (`tools/persist-self-certification.ps1` caps tree-mode evidence at one record; the system-level bar needs two distinct PASSes). CI (`npm run lint`, `npm run format:check`, `npm run test:coverage`) and the smoke job (#197) apply to Fable's work as to everyone's. Every other implementer is unaffected and goes through independent adversarial review per the table above. Full policy: `standards/adversarial-review-protocol.md` § "Fable review patterns (#203, narrowed by #207)".

## Adversarial review, in brief

- Assume total failure. Every artifact enters review as broken until proven otherwise.
- Every finding cites real evidence (`file:line`, command output, issue/PR number). Every best-practice claim cites a current dated source.
- The spawner gives the goal, not the implementation. No positive framing, no planted suspicions, full scope.
- Final verdict is a single `PASS`/`FAIL` token with a numbered defect list. A PASS with open blockers or majors is not a PASS.
- **Issues and plans: 1 Opus reviewer** (`reviewer-issue`). Never a panel of issue-reviewers.
- **Code review, round 1: panel up to 5, judged unanimous-PASS** (risk-scaled; routine code).
- **Code review, rounds 2+: 1 fresh reviewer** each round (except system-level changes — those need two independent PASSes on the final tree).

Full protocol, including the risk-tier precedence order, the high-stakes 3-reviewer rule, the system-level-change bar, the bias gate, and the soft-cap severity gate: `standards/adversarial-review-protocol.md`.

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
- **Config is central.** Read paths, port, and badge thresholds from `config.js`. Do not hard-code a path or port elsewhere.
- **This documentation pass does not touch source code, `standards/`, `agents/`, `skills/`, or config.** Another process owns those.
- **One working tree = one driver.** Any file-mutating agent or concurrent session operates in its own git worktree, created via `tools/new-agent-worktree.ps1 -Branch <name>` — never share the primary checkout with another running session. This is what stops concurrent sessions from stashing, reverting, or switch-branch-under-ing each other's uncommitted work.

## Dependency updates (Dependabot)

Dependabot PRs are classified into two tiers by `tools/classify-dep-pr.ps1`:

- **auto** — may merge on green CI with no separate review. Applies to: all GitHub Actions bumps; all npm dev-dependency bumps (any semver — a dev bump cannot break the running app, and CI catches a broken build); npm prod minor/patch bumps to non-wedding-critical packages.
- **review** — held for a tracked decision before merge. Applies to: any npm prod major bump; any bump (even patch or minor) to a wedding-critical prod dependency.

**Wedding-critical prod dependencies** (a bad bump breaks a core guest path):
`multer`, `sharp`, `ejs`, `better-sqlite3`, `bcryptjs`, `archiver`

The authoritative tier logic lives in `tools/classify-dep-pr.ps1`; the summary here is a human-readable restatement, and the wedding-critical list is drift-guarded by `tests/classify-dep-pr.test.js`.

Run the classifier against a PR's metadata to determine its tier:

```powershell
powershell -File tools/classify-dep-pr.ps1 -Ecosystem npm -DepName multer -SemverBump minor -DepType prod
```

Output is the single token `auto` or `review`, exit 0.

## What needs extra rigor

A system-level change uses the stricter two-independent-reviewer, both-must-PASS bar in `standards/adversarial-review-protocol.md`. Its definition — the governing-artifact surface — lives in `DESIGN.md` and is enforced by the same list in `tools/verdict-core.ps1`.

**Issue-review gate:** every code commit must name a reviewed GitHub issue. After an issue-review PASS, record it with `powershell -File tools/persist-issue-review.ps1 -IssueNumber <N> -ReviewerId <id> -Verdict PASS` — the `.githooks/commit-msg` gate blocks any code commit whose named issue lacks that record. Full rationale and the honest bar in `DESIGN.md` § "Issue-review gate".

**Issue lifecycle marker:** new issues are born carrying the `needs-issue-review` label (applied at `gh issue create` time). The label is cleared only by a recorded issue-review PASS, via `powershell -File tools/clear-issue-marker.ps1 -IssueNumber <N>`.
