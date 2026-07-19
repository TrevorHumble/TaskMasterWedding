# AGENTS.md

How agents operate in this repo. This mirrors `CLAUDE.md` for tools that read `AGENTS.md` by convention; `CLAUDE.md` is authoritative where they overlap.

## The pipeline

Every change moves through an enforced sequence. No step is skipped, and code is never committed straight to the default branch.

```
issue → adversarial review of issue → implement → adversarial review of PR → commit / PR
```

- **Issue** must meet `standards/issue-standards.md`: consumer-POV user story, Given/When/Then acceptance criteria, a numbered implementation plan, and a dependency map (`Depends on`, `Blocks`, `Touches`).
- **Adversarial review** (of both the issue and the PR) follows `standards/adversarial-review-protocol.md`: assume total failure, cite real evidence, end with a single `PASS`/`FAIL` token plus a numbered defect list.
- **Enforcement** is local via `.githooks/commit-msg`, which checks that a code commit names a GitHub issue, plus `tools/issue-core.ps1` and `tools/setup-hooks.ps1`. There is no mechanized review-evidence gate during the governance freeze (`CLAUDE.md` § "Governance freeze") — review practice is real but unmechanized.

## Roles and models

Every spawned agent sets `model` explicitly. No silent default.

| Role         | Model                                                  | Responsibility                                                |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------- |
| Orchestrator | Opus                                                   | Spawns agents, runs the pipeline, verifies reviewer verdicts. |
| Implementer  | Sonnet                                                 | Writes the change to satisfy the issue's acceptance criteria. |
| Reviewers    | Opus by default (different model from the implementer) | Attack the artifact against the issue and standards.          |

Reviewers must run on a different model than the implementer to avoid correlated blind spots, on every issue by default. The one exception is an issue the issue reviewer awarded `sonnet-only` (`standards/issue-standards.md` § "Sonnet tier eligibility"), whose implementer and reviewers both run on Sonnet — a judgment call made once at issue-review time, not a run-tier classifier. A producing agent never reviews its own output, even as a secondary reviewer.

## Agent definition standards

Agent definitions live in `agents/` (ported separately). Each agent must satisfy `standards/agent-standards.md`:

- **Single responsibility.** If the description needs "and" to list duties, split it.
- **Least-privilege tools.** Declare a `tools` array in frontmatter limited to what the job needs.
- **Input/output contract.** State what it receives and what it produces.
- **Model tier set explicitly** per the table above.
- **A `## When to invoke` section** with at least two bullets, and no banned slop words.

## Independence and rigor

- One reviewer per artifact class: exactly 1 Opus reviewer for an issue; exactly 1 PR reviewer plus the design-philosophy reviewer for code, both must PASS round 1. There is no standing reviewer-panel requirement.
- **One-round stop rule:** minor/nit findings are fixed inline and shipped with no re-review; a blocker/major finding takes exactly one re-check, scoped to the fix, with one fresh reviewer. See `standards/adversarial-review-protocol.md` § "One-round stop rule".
- De-biasing a briefing (give the goal not the implementation, no positive hints, no planted suspicions, full scope) is a spawning discipline the orchestrator applies on every spawn — not a separate mechanized audit step.
- The governing-artifact surface this pipeline is defined on is frozen through 2026-08-08 — see `CLAUDE.md` § "Governance freeze".

## Environment

- Windows / PowerShell. Use PowerShell syntax (`$env:VAR`, `$null`, backtick continuation; no `&&` / `||`).
- GitHub CLI at `C:\Program Files\GitHub CLI\gh.exe` (not on PATH).
- GitHub is the single source of truth for tasks and docs.
- Never commit `data/` or `.env`.

See `CLAUDE.md` for the full operating contract and `standards/` for the checkable standards.
