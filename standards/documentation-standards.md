# Documentation Standards

**As a reviewer or author of a doc in this repo, I need a single, checkable standard so I can determine whether a doc passes or fails without relying on subjective judgment.**

**Scope:** every doc produced or modified in this repo.

---

## Acceptance criteria must be literal

Acceptance criteria for a documentation artifact must be **literal string or
structural checks** — present/absent phrases, section headers, file paths, token
counts. They must not depend on a reader agent's nondeterministic answer to a
question like "can an agent figure out X from this?" Prose criteria that rely on
comprehension cannot be re-checked deterministically.

Lesson from issue #0001: every AC that said "an agent can answer X" was unfalsifiable.
Rewrite as: "the file contains the phrase `X`" or "section Y exists with subsections
A, B, C."

---

## User story is written from the consumer's POV

A doc's user story names the consumer — the agent, human, or system that will read
and act on the doc — not the author. Write from: "As a [consumer], I need…" If you
cannot name a consumer, the doc has no purpose.

---

## Anti-bloat

No preamble ("This document aims to…"), no restatements of the section header, no
padding between points. If a section can be one line, make it one line. Bloat is a
defect only when a reviewer can quote the specific sentence or section that is
removable without loss of meaning — a vague assertion that the doc "feels long" is
not a finding.

---

## Anti-AI-slop

No filler adjectives. Banned words: `elegantly`, `robustly`, `seamlessly`,
`comprehensively`, `holistically`, `notably`, `importantly`, `leverages`,
`cutting-edge`, `game-changing`, `powerful`, `innovative`. A reviewer flags filler
by quoting the exact word or phrase — a finding without a quotation is not a finding.
No throat-clearing openers ("In conclusion…", "It's worth noting…", "As we can
see…"). Write what the thing does, not how impressive it is.

---

## Naming

No FINAL, LAST, TRULY_FINAL, or similar terminal labels in filenames or section
headers. They are falsified by the next iteration. Use versions (`v1`, `v2`),
timestamps (`2026-06-15`), or descriptive deltas (`add-bias-gate`).

---

## Documentation split

| File        | Contains                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `DESIGN.md` | Architecture decisions, rationale, tradeoffs. Answers "why is it built this way?"                       |
| `CLAUDE.md` | Behavioral rules for the AI agent operating in this repo. Conventions, constraints, working agreements. |
| `README.md` | Getting-started and reference for human users. What it is, how to install/run, what commands exist.     |

Do not mix these. Behavioral rules in README confuse humans. Architecture rationale in
CLAUDE.md bloats the agent context. Getting-started prose in DESIGN.md misleads
readers about the scope of the decision log.

---

## Currency triggers

A doc must be updated when:

- An interface it describes changes (function signature, API contract, file path).
- A decision it records is reversed or superseded.
- An acceptance criterion it lists is added, removed, or reworded.
- A referenced external source (URL, version number) becomes stale or broken.
- A consumer it names no longer exists or has a changed mandate.
- A downstream artifact (skill, agent, issue, PR) contradicts or extends a claim this
  doc makes — the contradiction is a trigger to update this doc, not the artifact.

Stale docs are worse than no docs — they produce false confidence.
