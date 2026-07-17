---
name: capture-system-defect
description: >
  Turn a noticed system defect into a correctly-tiered issue without derailing the current task.
  Use when "a skill misbehaves", "a standard is ambiguous", "a reviewer rubber-stamps",
  "a reviewer false-flags", or any other machinery defect surfaces during a run.
---

# Capturing a system defect

When you notice a defect in the repo's own machinery during a run, do not silently work around it.
File it. This skill produces a correctly-tiered issue and returns you to the current task.

## Step 1 — identify and describe the defect

Write a one-paragraph description covering:

- what the defect is (observable behavior, not a guess about root cause)
- which artifact is affected (`skills/`, `agents/`, `standards/`, or a process step)
- what triggered the observation

## Step 2 — determine tier and action

**fix-now:** the defect blocks the current task's correctness or safety and cannot be worked
around without compromising the deliverable. Pause the current task; fix through the pipeline;
resume. A fix-now issue is filed as `ready` and must meet the full ready-tier checklist in
`standards/issue-standards.md` (user story, Given/When/Then acceptance criteria, an implementation
plan with at least three numbered steps, and the Depends/Blocks/Touches dependency map).

**backlog:** everything else. File the issue and continue. The current task does not pause.

**Scenario (fix-now):** while implementing an issue, `tools/issue-core.ps1`'s `Resolve-IssueNumber` stops matching a valid `Closes #N` commit message, so the commit-msg hook blocks every commit on the branch. Basis: the current task cannot complete correctly (no commit can land) and there is no workaround that does not involve bypassing the gate — pause, fix through the pipeline, resume.

**Scenario (backlog):** during the same run you notice `skills/research-prior-art.md` cites a section header that was renamed two merges ago. Basis: the stale pointer does not block the current task — you found the right section anyway — so file it at backlog tier and keep going.

Tier is declared in the issue's `**Type:**` line. Consult `standards/issue-standards.md` for
the full tier definitions and required fields for each tier — do not restate them here.

## Step 3 — draft the issue

Use `skills/issue-create.md`. File the issue in `data/wip-issues/<N>-slug.md` with:

- a user story naming the agent or human hurt by the defect
- at least one Given/When/Then acceptance criterion — see `issue-standards.md` § "Acceptance criteria"
  for what a criterion must be (even at backlog tier)
- for a backlog issue: the graduation-condition field required by `standards/issue-standards.md`
  (deterministic, not human-approval)

Assign the next available four-digit number. Do not reuse or skip numbers.

## Step 4 — return to the current task

After filing, resume the interrupted task. The captured issue enters the pipeline on its next
scheduled segment. No separate escalation step is needed unless the issue is fix-now.
