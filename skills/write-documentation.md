---
name: write-documentation
description: >
  How to write or update a doc in this repo. Use when asked to "write a doc",
  "update the README", "write a DESIGN.md", or "document X" — and when the output
  is a Markdown file a human or agent will read and act on.
---

# Writing a doc

**Standard:** `standards/documentation-standards.md` — read it; do not restate it here.

## Consumer POV

Name the consumer before writing a word. Format: `As a [consumer], I need… so that….` If you cannot name a consumer, the doc has no purpose. Write for that consumer, not for the author.

## File routing

| File        | Contains                                           |
| ----------- | -------------------------------------------------- |
| `DESIGN.md` | Architecture decisions, rationale, tradeoffs       |
| `CLAUDE.md` | Behavioral rules for the AI operating in this repo |
| `README.md` | Getting-started and reference for human users      |

Do not mix. Wrong file = wrong reader.

## Acceptance criteria

What an AC for a doc must be is defined in `issue-standards.md` § "Acceptance criteria" — read it; do not restate it here.

## Anti-bloat

- No preamble ("This document aims to…").
- No restatement of the section header in the opening sentence.
- If a section can be one line, make it one line.
- Bloat is a defect only when a reviewer can quote the specific sentence removable without loss of meaning.

## Naming

No FINAL, LAST, TRULY_FINAL in filenames or section headers. Use versions (`v1`, `v2`), timestamps (`2026-06-15`), or descriptive deltas.

## Currency

Update the doc when any interface it describes changes, any decision is reversed, or any downstream artifact contradicts a claim it makes. Stale docs produce false confidence.
