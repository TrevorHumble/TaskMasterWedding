---
name: research-prior-art
description: >
  How to run a quick prior-art and topic check before building something new. Use when
  asked to "check prior art", "research whether X exists", "look up how X is done",
  or "before I write this, what already exists" — and when the output is a short
  findings doc the caller acts on.
---

# Running a prior-art check

Delegate to `agents/researcher.md`. Do not improvise the research inline.

## What to pass to the researcher

- The topic or question (one sentence; do not pad).
- Any known local paths to check (skills, agents, standards, issues directories).
- Any formula/filter/rule the plan names — so the researcher can search for its existing owner.
- Whether a domain-specific reference (project docs, dependency/framework docs) is relevant.
- The output path for the findings doc.

## Search order (researcher must follow this)

1. Local repo (`skills/`, `agents/`, `standards/`, `data/wip-issues/`, `references/`) — glob and grep first.
2. Domain reference — the project's own documentation and the docs for any dependency in play (if relevant).
3. Web search — only after local + domain references are exhausted or clearly insufficient.

## Time box

The researcher runs a bounded check (≤5 minutes of real wall-clock). It is not a deep research session. If the topic requires depth, escalate to the `deep-research` skill.

## Output contract

The researcher returns a findings doc at the specified path containing:

- What already exists (file paths, links, or URLs).
- Whether each existing artifact is adaptable or must be built fresh.
- The relevant standard or pattern learned.

## After receiving findings

Read the findings doc. Do not build anything the findings show already exists and is adaptable. If the researcher found nothing, proceed with authoring using the appropriate writer skill. If the findings doc's "Existing owner of a named rule" section surfaces an existing owner, hand that owner (the `file:line`) to the implementer before implementation starts — the change must extend or call that owner, not duplicate it.
