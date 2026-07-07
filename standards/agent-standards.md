# Agent Standards

**As an agent reviewer or author, I need a single checkable standard so I can determine whether an agent passes or fails without guessing.**

---

## Single responsibility

Each agent does one thing. If the agent's description requires "and" to list its responsibilities, split it. An agent that does code review should not also write code.

---

## Least-privilege tool access

An agent gets only the tools it needs for its defined job. Specify the `tools` array in frontmatter. If a tool is not required to complete the agent's output contract, omit it.

---

## Input / output contract

Every agent must have a defined input/output contract: what it receives (file paths, strings, structured data) and what it produces (file paths, structured data, PASS/FAIL verdicts). State both in the agent's system prompt. An agent without a contract cannot be tested or replaced.

---

## Model tier and reviewer bias

Use the tier appropriate to the job:

| Job type                        | Tier   |
| ------------------------------- | ------ |
| Orchestration, review, judgment | Opus   |
| Implementation, transformation  | Sonnet |
| Classification, routing, triage | Haiku  |

**Tie-break for mixed jobs:** when an agent's job spans rows, tier to the **highest-judgment task** the agent performs, not its most frequent one. Example: an agent that mostly routes incoming defects (Haiku-tier work) but also judges whether each is consequential (judgment) is an Opus agent — the routing does not need Opus, but the judgment call is the part that fails silently on a weaker tier.

**Reviewer independence (implementation plan step 1 — choice recorded here):**
Choice: implementer stays Sonnet; all reviewers run on Opus. Reviewers must run on a different model from the implementer. A reviewer running on the same model as the implementer inherits the implementer's correlated blind spots — the errors the author makes are the ones the reviewer misses. A weaker different model (Haiku) is unacceptable for a gate; Opus is required. The cost tradeoff of a more expensive reviewer is noted and deferred as a separate decision.

A reviewer agent's prompt must carry no task-specific bias: it receives only the artifact under review and the relevant standard. The spawner must never state what the artifact is trying to accomplish, never express any expectation about the outcome, and never pre-answer anticipated objections.

---

## Reviewer checklist

- [ ] PASS/FAIL — Frontmatter specifies `tools` array limited to tools required for the agent's defined job.
- [ ] PASS/FAIL — System prompt states an explicit input/output contract (what comes in, what goes out).
- [ ] PASS/FAIL — `model` field is set to a tier appropriate to the job (see table above), not left as a default that may escalate silently.
- [ ] PASS/FAIL — Body contains a `## When to invoke` section with at least two bullet points.
- [ ] PASS/FAIL — No banned slop words appear in the file.
