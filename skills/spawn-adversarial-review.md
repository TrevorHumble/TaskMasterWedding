---
name: spawn-adversarial-review
description: >
  How to spawn an unbiased adversarial reviewer. Use when asked to "spawn a reviewer",
  "run an adversarial review", "get an independent review of X", or "review this with
  no bias" — and when the reviewer must enter with no prior attachment to the artifact.
---

# Spawning an adversarial reviewer

**Protocol:** `standards/adversarial-review-protocol.md` — read it in full before spawning any reviewer.

## De-bias rules (required; no exceptions)

**Give the goal, not the implementation.** State the objective the artifact is judged against. Do not name the mechanisms ("it uses X loop, a Y gate") — that pre-confirms their existence and narrows the review.

**No positive hints.** Never include "the one thing we got right is…" or any framing that pre-establishes a passing area. The reviewer enters assuming everything is bad and discovers what survives.

**Plant no suspicions.** "Suspect X is broken" leads the witness toward a predetermined finding and away from problems you did not anticipate. Say "assume failure, look hard."

**Minimum context — no biasing framing.** Give the artifact + the relevant standard + the protocol, and none of your hopes or explanations. Every additional sentence is a potential bias vector.

**Full scope — list every artifact actually under review.** Anything not listed is itself a finding. Do not give the reviewer a curated subset.

## Bias gate (required before fan-out)

Before spawning N reviewers, spawn one independent agent to audit the briefing for bias. That agent returns required edits with quoted evidence. Apply the edits. Then fan out.

## Fan-out threshold

High-stakes reviews: minimum three independent adversaries. A finding is recorded only when ≥2 of 3 confirm it. A verdict of fine requires the same threshold. Fewer than three = invalid review. (Exception: a `system-level change` uses the two-reviewer, both-must-PASS bar defined in `standards/adversarial-review-protocol.md` — fail-closed, no third tie-breaker needed.)

## Spawner must never

1. Name suspected weak parts — that leads the witness.
2. Include positive framing or "we tried hard on X."
3. Allow the producing agent to review its own output.
4. Accept a PASS without verifying every cited URL, every `file:line` reference, and every in-scope item has an explicit finding.

## Output contract for the reviewer

Numbered defects, each with severity (blocker / major / minor / nit) and a copy-pasteable fix. Final verdict: **PASS** or **FAIL** — one token, no hedging. PASS with open blockers or majors is not a PASS.

## Stable-prefix structure for prompt caching

**Step-1 finding:** Anthropic's public docs describe prompt caching at the API level via `cache_control` breakpoints (explicit per-block placement, up to 4 per request) or a top-level automatic mode that applies a breakpoint to the last cacheable block and advances it as context grows. Claude Code's Task tool manages spawn context internally and does not publicly document a manual `cache_control` knob for subagents. Therefore: treat caching as automatic-where-supported, do not add explicit breakpoints in Task spawn prompts, and CONFIRM EMPIRICALLY via `cache_read_input_tokens` in the response usage field rather than assuming a cache hit occurred.

The lever we control is ordering: place the static standard(s) and protocol as the first content in every spawn prompt, and put the volatile artifact (the diff, the skill draft, the issue text) after it. The volatile artifact is always billed fresh.

**Precondition:** prompt caching only activates above a model-dependent minimum cached-prefix size. Below that minimum, no caching occurs and the ordering discipline has zero effect. Keep the static standards prefix above this minimum; treat the ordering benefit as conditional on meeting it. Do not rely on a fixed token count — consult current model documentation. (Example minimums as of 2026-06-16: 1,024 tokens for Claude Sonnet 4.6; 4,096 tokens for Claude Haiku 4.5.)

Caching changes ordering only, not the content any reviewer receives.

**Guardrail — content hash:** cache validity is tied to the exact bytes of the cached prefix. When the prefix is cached, any edit to the standards bytes invalidates it (a cache miss) on the next spawn. Before each pipeline run, record the content hash of every standards file passed as a prefix. If the hash changes mid-run, the cached prefix is stale and the next spawn will re-prime the cache — automatically if automatic caching is in effect; only if `cache_control` were re-added in explicit mode (not currently required for Task-spawned subagents; see finding above).

**TTL:** the default cache lifetime is 5 minutes, refreshed at no charge each time cached content is used. An extended 1-hour TTL option exists at additional cost (2× the base write price vs. 1.25× for the default).

**Cache-read pricing:** cache reads bill at 10% of the base input token price.

**Verification:** after a repeat spawn, inspect the response's usage field. A non-zero `cache_read_input_tokens` value confirms the stable prefix was served from cache rather than re-billed.

Source: Anthropic, "Prompt caching," https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching, accessed 2026-06-16.
