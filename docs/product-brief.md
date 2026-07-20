# Product Brief — Wedding Master

> **Historical (hosting model changed 2026-07):** this document describes the original laptop + Cloudflare-tunnel deployment. Current hosting: see DESIGN.md § Hosted deployment and docs/deploy.md.

What the owner asked for, in his own words, captured from discovery. This is the requirements record that fed the goals session. It is **not** the North Star or goals — those are confirmed and live in [`north-star.md`](north-star.md). Architecture decisions and their rationale live in `DESIGN.md`; the historical build reference lives in `PLAN/`, superseded by `PLAN.md`'s refactor plan for current work.

- **Captured / confirmed:** 2026-06-28
- **Source:** 25-question discovery with the owner (Trevor), re-confirmed 2026-06-28
- **Status:** confirmed requirements. Open gaps are listed at the bottom.

## At a glance

|                     |                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| **What**            | A phone web app that runs a wedding photo task game                                           |
| **Couple**          | Lilly & Axel                                                                                  |
| **Theme**           | A soft green ramp (reference: the bouquet photo the owner provided)                           |
| **Guests**          | ~100, each on their own phone                                                                 |
| **Sign-in**         | Tap a personal link (no email, no password)                                                   |
| **The game**        | Complete admin-set photo tasks → points (worth + bonuses) → badges → leaderboard              |
| **Sharing**         | One shared gallery everyone can see; personal profiles                                        |
| **Run by**          | The Wedding Master admin who edits tasks, ranks task-badge winners, removes photos            |
| **Hosting**         | Self-hosted on the owner's Windows laptop for the wedding weekend; cheap/free                 |
| **After**           | Export everything (photos + a record), likely post to Flickr + email blast, then take it down |
| **Scale of photos** | ~1,500 total (≈15 per guest × 100 guests)                                                     |

## The wedding & vibe

- **Couple:** Lilly & Axel.
- **Dates:** the wedding weekend is **Aug 7–9, 2026** — Fri the 7th welcome dinner, Sat the 8th wedding + party, Sun the 9th brunch. The app must be live for guests by **Friday, Aug 7**.
- **Theme:** a soft green ramp, referenced by a bouquet photo the owner supplied. Visual design is the owner's call; agents do not redesign.
- **Hashtag / monogram:** none requested.

## Who uses it

- **~100 guests.** This number drives the hosting choice (one laptop is enough; no cloud needed).
- **Sign-in is a personal link** — no accounts, no email, no passwords. Possession of your link is how the app knows it's you. (Resolved in build as one shared poster QR code: it opens `/join`, where a guest signs up with a name, contact, and a self-chosen PIN; a returning guest re-enters at `/login` with that same contact + PIN. Per-guest links were retired by #244.)
- **One device per person.** Not designed for couples sharing a phone.
- **A private admin view is required** for the person running the event.

## The game

- **Tasks are written and edited in the admin view**, not hard-coded. The admin can add, change, and remove tasks anytime.
- **Number of tasks: however many the admin adds.** No fixed count.
- **Everyone gets the same task list** (not per-person or per-team lists).
- **Individual play.** No teams.
- **A task is marked done when the guest uploads a photo for it** — the upload auto-counts. No separate approval step to complete a task.
- **Scoring + leaderboard:** points come from a fixed set of readable sources — task
  worth (1/2/3, host-chosen), timed bonuses, memory/profile-photo firsts, held badges,
  and host-ranked task-badge and crowd-favorite awards — never from open-ended admin
  judgment. The leaderboard ranks guests. This replaced the original "1 point per task
  plus admin-judgment bonus points" direction; see
  [`game-design-points-badges.md`](game-design-points-badges.md) for the full,
  owner-settled rule set (2026-07-19/20).

## Badges

- **Auto badges are earned by completing a number of tasks:** about **3 badges**, one every **5 tasks** (so at 5, 10, and 15 completed), plus a Completionist badge for holding every active task.
- **Task badges are prize badges, not participation badges.** Every task has one badge; the host ranks that task's 5 best photos and all five wear it, with the best photo's copy wearing it gold.
- **Crowd favorite** is derived from likes — the 5 most-liked photos wear it, recomputed live all weekend, rather than awarded by hand or left to change hands on a raw photo-count metric.
- **Placeholder badge art is fine** — the owner is OK with designed placeholders.
- **Badges are visible to everyone**, not private.
- Superseded by the 2026-07-19/20 session: the "most photos" transferable badge, the
  fixed special-badge set, and hand-created custom badges are being removed — see
  [`game-design-points-badges.md`](game-design-points-badges.md) for the current model
  and the full kill list.

## Photos & sharing

- **Photos are downloadable by the owner** (not locked inside the app).
- **One big shared gallery** everyone can see.
- **Moderation = the ability to take things down.** Photos are public when posted; the admin can remove anything inappropriate. (No pre-approval queue.)
- **~1,500 photos total** expected (≈15 per guest × 100 guests) — the storage planning number.

## Profiles & the group area

- **A guest profile shows** their photo, name, their badges, and their submissions.
- **Optional social links** so guests who hit it off can find each other afterward.
- **Guests can see each other's profiles** — the point is to show off badges and photos, not just the shared gallery.

## Practical

- **Budget: cheap.** The owner hosts it on his own computer for the weekend. No paid services expected.
- **Starting from zero** — no existing domain, host, or cloud accounts.
- **After the wedding:** a **mass export** of everything (photos + a record of who earned what) would be great. The owner will likely **upload to Flickr and send an email blast**, then take the app down. Keeping it up as a keepsake is a nice-to-have, not a requirement.
- **Admin password** is set by the owner out-of-band and stored only as a one-way hash on the host machine. It is never written into the repo or this document.

## Open gaps (need from the owner)

- None outstanding. The goals session (2026-06-28) resolved the wedding dates (**Aug 7–9, 2026**; live by Fri the 7th) and the strategic frame — see [`north-star.md`](north-star.md).

## What this brief deliberately does not contain

- **Goals / North Star / success measures.** Now confirmed in [`north-star.md`](north-star.md) (one-screen summary in `CLAUDE.md`). This brief is the raw "what and why"; the strategic frame lives there.
- **Architecture decisions.** See `DESIGN.md`.
- **The build/refactor plan.** `PLAN/` is the historical as-built plan, superseded; see `PLAN.md` for the current refactor plan once its review passes.
- **Known defects.** See `docs/reviews/2026-06-28-adversarial-review.md`.
