---
name: issue-create
description: >
  How to draft an issue in this repo. Use when asked to "create an issue", "write a ticket",
  "draft an issue for X", or "spec out a feature" — and when the output is a `data/wip-issues/*.md`
  file that an implementation agent will act on.
---

# Drafting an issue

**Standard:** `standards/issue-standards.md` — read it; do not restate it here.

## Required sections

### User story

`As a [consumer], I need… so that….` Name the end-consumer (agent, human, or system). If you cannot name one, the issue has no purpose.

### Acceptance criteria

Each criterion in Given/When/Then form. What a criterion must be is defined in
`issue-standards.md` § "Acceptance criteria" — read it; do not restate it here.

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

**Example plan step, before:** "2. Update the upload handling to reject bad files."
**After:** "2. In `src/services/photos.js`, in the multer `fileFilter`, reject any file whose mimetype is not a key of `ALLOWED_MIME_TO_EXT` by calling the callback with an error whose message names the rejected type."
The before step forces the implementer to decide which file, which mechanism, and what "bad" means; the after step decides all three.

## Creating the GitHub issue

Create the GitHub issue **first**, before writing the local draft, applying the `needs-issue-review` label at creation time:

```
gh issue create --label needs-issue-review ...
```

Capture the number GitHub assigns — that number is the draft's identity (see Naming). Every newly created issue is born carrying the `needs-issue-review` label. The label is cleared only after a recorded issue-review PASS, by running `tools/clear-issue-marker.ps1 -IssueNumber <N>`.

## Naming

Draft files live in `data/wip-issues/` and are named `<N>-slug.md`, where `N` is the **GitHub-assigned issue number** from `gh issue create` above — never a locally-minted number. Lowercase hyphenated slug. No FINAL/LAST. Full rule: `standards/issue-standards.md`.
