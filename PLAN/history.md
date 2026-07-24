# PLAN/ — historical summary

This directory used to hold 11 numbered files (`00-README.md` through `10-theme-and-art.md`),
a copy-paste-ready build plan written for a junior developer building the app from zero. They
were deleted by #833 (git history preserves them) and replaced by this one-page summary.

## What was originally built

The plan walked through the whole as-built app in order: project setup and boot
(`01-setup`), the SQLite schema and seed data (`02-database`), guest tokens and admin login
(`03-auth-and-links`), the guest home/task/submission screens (`04-guest-experience`), photo
upload + thumbnailing (`05-photos`), points and badges (`06-scoring-badges`), the shared
gallery and leaderboard (`07-gallery-leaderboard`), the admin panel (`08-admin`), the ZIP +
xlsx export (`09-export`), and the theme + badge art (`10-theme-and-art`). `00-README.md` was
the overview: stack table, data-flow diagram, the `config.js` UPPER_SNAKE_CASE contract, and
a day-of runbook for running the app on a laptop with a Cloudflare quick tunnel.

## Why it is superseded

- **Hosting changed (2026-07).** The laptop + `cloudflared` quick-tunnel model the runbook
  taught is retired; the app now runs on a rented host behind a reverse proxy — see
  `DESIGN.md` § "Hosted deployment" and `docs/deploy.md` for the current runbook. The
  day-of laptop/tunnel instructions from the old `00-README.md` are not preserved anywhere;
  they describe a deployment model this project no longer uses.
- **The app was already built.** Every numbered file described work that shipped years of
  commits ago; re-reading them to understand the current app means cross-checking prose
  against code that has since been rewritten many times over (routes split into services,
  scoring/badges rules changed, whole new features like crowd favorites and flash tasks
  added). `docs/architecture.md` and the source tree are the live description of the app now.
- **Planning moved to the GitHub board.** `PLAN.md` used to promise a forthcoming refactor
  plan; that promise is retired. Work is filed, reviewed, and tracked as GitHub issues per
  `standards/issue-standards.md`, not as a document in this repo.

For how the app works today, read `docs/architecture.md`, `DESIGN.md`, and the source tree
directly. For what to build next, read the GitHub board.
