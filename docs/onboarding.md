# Onboarding — start here

A one-screen map for a human developer new to this repo. This page is not itself a reference — it
just tells you what order to read the real references in, and what you can skip.

## Read these, in order

1. [`README.md`](../README.md) — what the app does, and how to run it locally.
2. [`CONTEXT.md`](../CONTEXT.md) — the domain vocabulary (guest, task, submission, badge, points, and
   the rest), defined once so you use the same words the code does.
3. [`docs/architecture.md`](architecture.md) — the schema and how a request flows through the app.
4. [`docs/game-design-points-badges.md`](game-design-points-badges.md) — the game rules: how points
   and badges are actually computed.
5. [`docs/deploy.md`](deploy.md) — how the app goes from a bare Linux host to serving guests over
   HTTPS.
6. [`docs/test-plan.md`](test-plan.md) — the manual pre-wedding walkthrough, step by step.

## Two files that are records, not references

- **`BUILDLOG.md`** is a history log: a dated entry per shipped change, in the order it landed. Read
  it to see what happened and why — not to learn how the app works today (that's the six docs above).
- **`DESIGN.md`** is a decision archive: the reasoning behind specific choices, recorded as they were
  made. Look up a section when you need to know _why_ something is built the way it is — it has its
  own table of contents for that; it isn't meant to be read front to back as an introduction.

## What you can skip

This repo is built through an AI-agent pipeline (issue -> adversarial review -> implement -> review ->
merge). Its own machinery is not required reading for a human making changes by hand — skip
`CLAUDE.md`, `AGENTS.md`, `standards/`, and `agents/` unless you're specifically working on the
pipeline itself.
