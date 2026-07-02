# AGENTS.md

How agents operate in this repo. This mirrors `CLAUDE.md` for tools that read `AGENTS.md` by convention; `CLAUDE.md` is authoritative where they overlap.

## The pipeline

Every change moves through an enforced sequence. No step is skipped, and code is never committed straight to the default branch.

```
issue → adversarial review of issue → implement → adversarial review of PR → commit / PR
```

- **Issue** must meet `standards/issue-standards.md`: consumer-POV user story, Given/When/Then acceptance criteria, a numbered implementation plan, and a dependency map (`Depends on`, `Blocks`, `Touches`).
- **Adversarial review** (of both the issue and the PR) follows `standards/adversarial-review-protocol.md`: assume total failure, cite real evidence, end with a single `PASS`/`FAIL` token plus a numbered defect list.
- **Enforcement** is local via `.githooks/pre-commit` and the scripts in `tools/` — the review-evidence gate (`verdict-core.ps1`, `validate-verdict.ps1`, `persist-review.ps1`, `review_verdict.ps1`) plus `check-gate.ps1`, `check-enforcement.ps1`, `start-run.ps1`, `stop-run.ps1`, `setup-hooks.ps1`.

## Roles and models

Every spawned agent sets `model` explicitly. No silent default.

| Role         | Model                                       | Responsibility                                                |
| ------------ | ------------------------------------------- | ------------------------------------------------------------- |
| Orchestrator | Opus                                        | Spawns agents, runs the pipeline, verifies reviewer verdicts. |
| Implementer  | Sonnet                                      | Writes the change to satisfy the issue's acceptance criteria. |
| Reviewers    | Opus (different model from the implementer) | Attack the artifact against the issue and standards.          |

Reviewers must run on a different model than the implementer to avoid correlated blind spots. A producing agent never reviews its own output, even as a secondary reviewer.

## Agent definition standards

Agent definitions live in `agents/` (ported separately). Each agent must satisfy `standards/agent-standards.md`:

- **Single responsibility.** If the description needs "and" to list duties, split it.
- **Least-privilege tools.** Declare a `tools` array in frontmatter limited to what the job needs.
- **Input/output contract.** State what it receives and what it produces.
- **Model tier set explicitly** per the table above.
- **A `## When to invoke` section** with at least two bullets, and no banned slop words.

## Independence and rigor

- High-stakes review uses at least three independent adversaries; a finding or a clean verdict needs two of three to agree.
- A **system-level change** (the governing-artifact surface defined in `DESIGN.md`, enforced by the same list in `tools/verdict-core.ps1`) uses two independent reviewers who must **both** reach PASS; disagreement is FAIL.
- A **bias gate** audits the briefing before fan-out: the only allowed bias is anti-builder.

## Environment

- Windows / PowerShell. Use PowerShell syntax (`$env:VAR`, `$null`, backtick continuation; no `&&` / `||`).
- GitHub CLI at `C:\Program Files\GitHub CLI\gh.exe` (not on PATH).
- GitHub is the single source of truth for tasks and docs.
- Never commit `data/` or `.env`.

See `CLAUDE.md` for the full operating contract and `standards/` for the checkable standards.
