---
name: agent-writer
description: >
  How to author an agent file in this repo. Use when asked to "write an agent",
  "create an agent", or "add an agent" — and when the output is an `agents/*.md` file
  that the orchestrator will spawn.
---

# Authoring an agent

**Standard:** `standards/agent-standards.md` — read it before writing; do not restate it here. It defines single-responsibility, least-privilege tools, I/O contract requirements, model-tier selection, reviewer-bias rules, and the reviewer checklist.

## Procedure

1. Read `standards/agent-standards.md`.
2. Draft frontmatter: `name`, `model` (correct tier from the standard's table), `tools` (minimal — least-privilege).
3. Write `## When to invoke` — ≥2 bullets naming the conditions under which the orchestrator should spawn this agent.
4. Write the I/O contract: explicit statement of what arrives and what is produced.
5. Write the body: single job only; no "and" in the responsibility statement.
6. Run the reviewer checklist from `standards/agent-standards.md` before committing.
