---
name: update-claude-md
description: >-
  What to refresh in CLAUDE.md after project state changes. Triggers: "after
  creating an issue", "after committing to main", "update the project doc",
  "record this in CLAUDE.md", any task that adds or changes an agent, skill,
  standard, or convention.
---

# update-claude-md

CLAUDE.md is the orchestrator's operating doc. It carries the project's rosters
(the `agents/`, `skills/`, `standards/` inventories under "Where things live")
and its conventions — not a task list. **Issue status lives on the GitHub board,
not in CLAUDE.md**; the board is the single source of truth for state, so there
is no issue table to maintain here.

## What to refresh

After an issue is committed to `main`, check whether the change altered anything
CLAUDE.md describes, and bring it current in the same pass:

1. **Rosters** — if the commit added, removed, or renamed an agent, skill, or
   standard, update the matching list under "Where things live" (one terse line:
   filename + one-line purpose, matching the existing entries).
2. **Conventions / policy** — if it changed a convention, a model-policy rule, a
   pipeline step, or an authoritative-source pointer, edit that line so the doc
   matches how the system now behaves.

Touch nothing that did not change. Keep every entry terse — a filename and a
one-line purpose, no prose summaries. Match the surrounding format.

## Where

The repo-root `CLAUDE.md` — the project-level operating doc. Do **not** touch the
global user config at `~/.claude/CLAUDE.md`.

## When NOT to update

- Draft issues not yet created, or commits not yet on `main` — state changes only.
- A change that touches no roster entry, convention, or policy line. A stale
  roster degrades every later decision, but inventing entries for nothing degrades
  it just as much.
