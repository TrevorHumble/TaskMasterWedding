---
name: skill-writer
description: >
  How to author or update a skill file in this repo. Use when asked to "write a skill",
  "create a skill", "update a skill", or "fix a skill" — and when the output is a
  `skills/*.md` file that another agent will pull.
---

# Authoring a skill

**Standard:** `standards/skill-standards.md` — read it before writing; do not restate it here. It defines anti-bloat rules, the description/trigger contract, progressive-disclosure limits, and the reviewer checklist.

## Intent-not-words discipline

When updating an existing skill, apply the author's _intent_, not their literal words. The user describes a symptom or desired outcome; the skill change must fix the underlying behavior. If the user says "add a bullet about X," ask whether the bullet fixes a behavior gap — if it duplicates existing prose, cut the prose instead.

**Example** — user request: "add a bullet to github-write saying to check `git status` before committing."

- Before (literal transcription): a new bullet `- Check git status before committing.` appended under Conventions — while the Committing section already tells the agent to run `git status` before staging. The skill now says it twice; the second copy drifts when the first is edited.
- After (intent applied): no new bullet. The request revealed the user missed the existing line, so the fix is placement — move the `git status` sentence into the fenced Committing block where it reads before the `git add` command.

## Procedure

1. Read `standards/skill-standards.md`.
2. Read the existing skill file (if updating).
3. Draft frontmatter: `name` + `description` only; ≥2 quoted/backticked trigger strings in the description.
4. Write the body: short procedure and pointers; push detail to `references/`, scripts to `scripts/`, templates to `assets/`.
5. Run the reviewer checklist from `standards/skill-standards.md` before committing.
