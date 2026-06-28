# CLAUDE.md — Operating rules for this repo

Behavioral rules for any AI agent working in this repository. This file is the repo's own operating contract. It is not the user's global `CLAUDE.md`.

<!-- CUSTOMIZE: North Star pending — owner defines goals in an upcoming session; do not fill in autonomously -->

**North Star / goals:** pending. The owner defines the North Star, goals, and success outcomes in an upcoming session. Until then, do not invent goals, a vision statement, KPIs, or a roadmap.

Stand-in description (neutral, not a goal): Garden Party Pastels is a self-hosted wedding scavenger-hunt web app where about 100 guests sign in by per-guest QR link, complete photo tasks for points and badges, share a gallery, and appear on a leaderboard, with an admin who manages the event and exports the results.

## How work flows: the orchestrator pipeline

All changes go through an enforced pipeline. Do not commit code straight to the default branch and do not skip steps.

1. **Issue** — file the work as a GitHub issue meeting `standards/issue-standards.md` (user story, Given/When/Then acceptance criteria, implementation plan, dependency map).
2. **Adversarial review of the issue** — independent reviewers attack the issue against the standard before any code is written. See `standards/adversarial-review-protocol.md`.
3. **Implement** — an implementer agent writes the change to satisfy the issue's acceptance criteria.
4. **Adversarial review of the PR** — independent reviewers attack the implementation against the issue and the standards.
5. **Commit / PR** — only after review passes. The `.githooks/pre-commit` hook and the scripts in `tools/` enforce the gates locally.

Standards live in `standards/`. Agent definitions live in `agents/`. Both are ported in separately; treat them as the source of truth and point to them rather than restating them.

## Model policy

Every spawned agent sets its `model` explicitly. Never rely on a default that may escalate silently.

| Role         | Model                                            |
| ------------ | ------------------------------------------------ |
| Orchestrator | Opus                                             |
| Implementer  | Sonnet                                           |
| Reviewers    | Opus, and a different model from the implementer |

Reviewers run on a different model than the implementer so they do not inherit the implementer's correlated blind spots. A reviewer must never review its own output.

## Adversarial review, in brief

- Assume total failure. Every artifact enters review as broken until proven otherwise.
- Every finding cites real evidence (`file:line`, command output, issue/PR number). Every best-practice claim cites a current dated source.
- The spawner gives the goal, not the implementation. No positive framing, no planted suspicions, full scope.
- Final verdict is a single `PASS`/`FAIL` token with a numbered defect list. A PASS with open blockers or majors is not a PASS.

Full protocol, including the high-stakes 3-reviewer rule, the system-level-change bar, the bias gate, and the soft-cap severity gate: `standards/adversarial-review-protocol.md`.

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

## What needs extra rigor

A system-level change (one that alters the pipeline, the enforcement hooks in `.githooks/` or `tools/`, the standards, or the agent definitions) uses the stricter two-independent-reviewer, both-must-PASS bar in `standards/adversarial-review-protocol.md`. See `DESIGN.md` for the definition of a system-level change.
