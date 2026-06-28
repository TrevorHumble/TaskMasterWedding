# PLAN.md

<!-- CUSTOMIZE: North Star pending — owner defines goals in an upcoming session; do not fill in autonomously -->

**North Star / goals:** pending. The owner defines goals, success outcomes, and any roadmap in an upcoming session. Do not invent goals or a roadmap here.

Stand-in description (neutral): a self-hosted wedding scavenger-hunt web app for ~100 phone-based guests with QR sign-in, photo tasks, points, badges, a leaderboard, a shared gallery, profiles, and an admin who runs the event and exports results.

## Build plan (as built)

The detailed, copy-paste-ready build plan for the app lives in [`PLAN/`](PLAN/), read in order:

- [`PLAN/00-README.md`](PLAN/00-README.md) — overview, stack, data-flow
- [`PLAN/01-setup.md`](PLAN/01-setup.md) — project setup and boot
- [`PLAN/02-database.md`](PLAN/02-database.md) — schema and helpers
- [`PLAN/03-auth-and-links.md`](PLAN/03-auth-and-links.md) — guest tokens, sign-in, admin login
- [`PLAN/04-guest-experience.md`](PLAN/04-guest-experience.md) — home, tasks, submission
- [`PLAN/05-photos.md`](PLAN/05-photos.md) — uploads, thumbnails, takedown
- [`PLAN/06-scoring-badges.md`](PLAN/06-scoring-badges.md) — points and badges
- [`PLAN/07-gallery-leaderboard.md`](PLAN/07-gallery-leaderboard.md) — gallery, leaderboard, profiles
- [`PLAN/08-admin.md`](PLAN/08-admin.md) — admin panel
- [`PLAN/09-export.md`](PLAN/09-export.md) — ZIP + xlsx export
- [`PLAN/10-theme-and-art.md`](PLAN/10-theme-and-art.md) — theme and badge art

## Refactor plan

The repo was initialized from the as-built app. A refactor plan is being produced and goes through the same adversarial review as any other artifact. It will be linked here once its adversarial review passes. Until then, treat `PLAN/` as the authoritative build reference.

## Where tasks are tracked

GitHub is the single source of truth for tasks. Work is filed as GitHub issues per `standards/issue-standards.md` and moves through the orchestrator pipeline described in `CLAUDE.md` and `AGENTS.md`. Status is canonical on the GitHub board, not in this file.
