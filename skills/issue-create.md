---
name: issue-create
description: >
  How to draft an issue in this repo. Use when asked to "create an issue", "write a ticket",
  "draft an issue for X", or "spec out a feature" — and when the output is an `issues/*.md` file
  that an implementation agent will act on.
---

# Drafting an issue

**Standard:** `standards/issue-standards.md` — read it; do not restate it here.

## Required sections

### User story

`As a [consumer], I need… so that….` Name the end-consumer (agent, human, or system). If you cannot name one, the issue has no purpose.

### Acceptance criteria

Each criterion in Given/When/Then form. Each must resolve to a literal string or structural check — an agent verifies it by reading the produced artifact with no semantic interpretation. No criterion of the form "an agent can understand X" (unfalsifiable). Use: "the file contains the phrase `X`" or "section Y exists."

### Implementation plan

≥3 numbered steps, each naming a file path or concrete deliverable. Clear enough that a Sonnet agent following it does not go off the rails.

### Dependency map

All three fields required:

```
Depends on: <issue number(s) or "none">
Blocks: <issue number(s) or "none">
Touches: <file paths or artifacts modified>
```

## Haiku bar

The plan must be unambiguous at the level of a weak model. If a step says "do the thing," rewrite it. Each step names what to create, read, or write and where.

## Naming

Issue files: `NNNN-slug.md` — four-digit zero-padded number, lowercase hyphenated slug. No FINAL/LAST.
