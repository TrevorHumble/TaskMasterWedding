# Stickiness consultation — 2026-07-19

Working record of the game-stickiness consult (Fable, 2026-07-19), updated same day after an
owner Q&A session that settled most open questions. **This document is pre-issue material** —
nothing here is buildable until it becomes a GitHub issue that passes issue review per the
pipeline. Status lives on the board, not here; once an issue is filed or amended, the board wins.

Goal frame: stickiness here means a guest keeps _choosing_ to re-open the app across the
3-day weekend and the game keeps sending them back into the room — not long-term retention.

**Filed 2026-07-19 — the board is now canonical for all of these:**
N1 bell → **#644** (absorbs #563, now closed) · N2 task values → **#645** · N3 admin
checklist → **#646** · N4 Couple's Heart → **#647** · N5 first-to-finish → **#648** ·
N6 flash tasks → **#649** · N7 lucky task → **#650** · N8 duels → **#651** · N9 copy fix →
**#652** · N10 nudge → **#653** (backlog). Amendment comments posted on **#624, #625, #468,
#410**. Beyond-MVP label created and applied to #648–#651.

---

## Global decisions (apply to everything below)

1. **Fixed floor, variable ceiling.** The base economy stays legible — every task shows what
   it is worth and the base is never random. All variance (crowd votes, bonuses, lucky tasks,
   judged awards) layers on top as bonuses. Nobody should ever feel the machine shorted them.
2. **Pull, never push.** No push notifications, streaks, reply threads, unread anxiety, or
   activity feeds. The bell (below) is the sanctioned pull surface. "Look up, not look down"
   stays the test for every social feature.
3. **The rulebook never grows.** How-to-play stays at exactly three rows. Every new mechanic
   must be learnable from one of three channels, in ≤8 words:
   - **Price tag** — a label on the artifact ("+3 pts", a lock with "Opens Saturday", a countdown).
   - **Receipt** — a one-line "why" at the payoff ("First! +1 bonus", "Lucky task! +2").
   - **Ambient marker** — an envied marker on someone else's win (crown, First! ribbon, gold heart).
     A mechanic that needs a paragraph gets redesigned or cut, not documented.
4. **Pace the reveals across the weekend.** Friday: base loop only. Saturday onward: daily
   challenge lock, first flash task, crowd-favorite crowns. One new thing per session, and
   Saturday's app feels newer than Friday's.
5. **Async rewards must be delivered.** Most of this game's variable rewards land while the
   guest's phone is pocketed (host awards, likes, badge steals, crowd-vote swings). Every one
   must reach the guest on their next visit — the bell (N1) is the prerequisite that
   multiplies the value of everything else.
6. **Non-point rewards are free variance.** Badge moments, the Task Master's note, gold
   hearts, appearing on the slideshow — use them; they don't inflate the economy.
7. **Bonuses bank when earned** _(owner, 2026-07-19)_: a time-derived bonus (daily on-day,
   flash-window, lucky) is stored at award time and survives a later photo replace. A guest
   improving their photo must never lose points for it. **Exception:** first-to-finish is
   deliberately NOT banked — see N5's anti-junk rule.
8. **The app never calls the internet** _(verified 2026-07-19)_: fonts are already bundled
   under `src/public/fonts/`, no CDN references exist in views or theme.css. Every new asset
   (badge icon set etc.) ships as files in the repo — venue wifi can die and nothing breaks.

---

## Part 1 — Existing issues: review notes and amendments

### #624 Daily challenges — amend, then review

Verdict: right idea; appointment mechanics + on-day bonus is straight live-event design.

Settled (owner, 2026-07-19):

- **Locked card is a MYSTERY BOX**: shown before its day as "Saturday's challenge 🔒" with
  NO title — more tease, more table talk, and can't spoil host plans (e.g. bouquet toss).
- **On-day bonus banks at submit time** (global decision 7): a later replace keeps it.
- **Event timezone: Idaho — `America/Boise` — as a config setting**, not hard-coded (owner
  has scaling ambitions; configurable event timezone is the reusable shape).
- Teaching: price tag on the card ("2 pts today only" → "1 pt" after its day) + lock chip.

No open questions remain.

### #625 Crowd-favorite votes — amend, then review

Verdict: converts the app's biggest dead-end (browsing others' photos) into gameplay; the
only mechanic that makes guests look at each other's contributions. Biggest variance injector
in the queue.

Settled (owner, 2026-07-19):

- **Ships after the bell (N1).** Without delivery, crowd-vote point swings read as buggy math.
- **Self-likes are BLOCKED, not silently discounted**: tapping the heart on your own photo
  plays a small "nope" fail animation and records nothing — clearer than a heart that lights
  up but doesn't count. (Verified: the like route currently has no ownership check.)
- Rich-get-richer from gallery pinning: accepted for one weekend; feed stays newest-first.
- Teaching: bell receipt ("Your photo is #2 crowd favorite — +4 pts") + crown markers in the
  gallery + one onboarding line ("a like is a vote"), ≤8 words.

Still open (minor): copy coordination across the three like-driven surfaces (per-guest
MOSTLIKED badge, #490's most-liked-photo medal, crowd votes) — one shared language for likes.

### #626 Pedestal redesign — proceed as specced

Dense ranking is psychologically right for a compressed-score economy; every-tied-face
visible is ownership applied literally. Compounds with #625 (spread scores → smaller ties →
podium means more). Visual-approval loop applies. No open questions.

### #563 Ghost medal (admin award never reaches the guest) — ABSORBED INTO THE BELL (N1)

Settled (owner, 2026-07-19): **one issue, not two.** The bell is the umbrella; #563's
owed-celebration is its badge-delivery half. One unread model, built once. #563 should be
closed into / superseded by the bell issue when N1 is filed.

### #611 Post-submit success screen — treat as top-tier, not polish

The success screen is the loop's payoff beat and the highest-traffic reward moment. Design it
with a slot for "bonus reason lines" — on-day bonus, First!, lucky task receipts all land
here. Visual loop drives the pixels. No other open questions.

### #469 Prizes on display — proceed

No changes. Visible stakes make the pedestal worth staring at.

### #468 Slideshow — amend: it runs DURING the party

Settled (owner, 2026-07-19): **yes, live on the venue screen during the party**, not only
end-of-night. Reframe the issue from "end-of-night slideshow" to "live surface with an
end-of-night favorites mode." Seeing your own photo on the big screen is the strongest
in-room reward the system can produce.

### #490 / #489 Badge medals on tiles / leaderboard badges — proceed as specced

Ambient markers that teach mechanics by envy. No changes.

### #410 Badge art upload — extend with the bundled icon set

Settled (owner, 2026-07-19): add a **bundled set of ~50–60 material-style icons** (SVG files
in the repo — global decision 8, no live Google fetch) shown as an admin dropdown; the chosen
icon renders in a circle as the badge art. Easy, classy, **no emoji**. This replaces the
"default ribbon everywhere" wallpaper problem: every task badge can look intentional with
zero design work from the hosts.

---

## Part 2 — New issues to create

Filed in recommended build order within each tier. Each needs the full issue-standards
treatment (user story, G/W/T, plan, dependency map) before it is real.

### N1. Notification bell (umbrella — absorbs #563)

- **Pitch:** a bell with an unread count ("+3"). Tapping shows a recap of what happened to
  you: likes on your photos (batched — "3 people liked your ring-shot photo"), comments on
  your photos, badges earned (row taps replay the full award modal), steal-able badges won
  _and lost_, host bonus points. Pull-only; nothing ever buzzes.
- **Settled:** one issue with #563 inside (owner, 2026-07-19). Only things that happened _to
  you_ — no "X passed you" anxiety rows. Likes batched. Badge auto-celebration on next page
  load still fires independent of the bell (the bell is the archive/replay, not the only
  delivery).
- **Placement — NOT settled:** proposed header top-right (convention; visible everywhere).
  Owner is skeptical — header is clean today — and **must see it in the visual-approval loop
  before it's real.** May grow into a small header-redesign issue.
- **Still open:** unread model (per-guest last-checked timestamp + derived queries vs. a
  notifications table) — issue-review/implementer call; everything listed already has
  timestamped rows.

### N2. Per-task point values

- **Settled:** tiers **1 / 2 / 3 only** (owner, 2026-07-19) — a simple menu, not arbitrary
  integers a host could break the game with. Host-set, default 1, printed on the card
  ("+3 pts" — price tag, zero teaching).
- **Note for the issue:** touches the `POINTS_PER_PHOTO` single-owner constant, `getPoints`,
  and the `leaderboard()` SQL — enumerate every scoring surface. On-day/flash bonuses are
  additive on top.

### N3. Admin host checklist (replaces the "host guide doc" idea)

- **Settled (owner, 2026-07-19):** the host guide lives **inside the admin pages as an
  interactive todo list**, not a document — "Have you picked today's lucky task? ☐", "Flash
  task fired at the reception? ☐", "3-pointers on the big moments? ☐". The app guides the
  hosts day-of; nobody re-reads a doc at a wedding. Task-authoring tips (funny tasks, mixing
  tasks, people-connecting tasks) fold into the same surface.
- Folds what was previously N10 (host guide) and N11 (weekend pacing plan) into one admin
  feature. Pacing plan content (Friday base loop; Saturday: lock, flash, crowns, live
  slideshow; Sunday: standings + favorites + prizes) becomes the checklist's day sections.

### N4. Couple's Heart — Lilly & Axel's likes are gold

- **Settled (owner, 2026-07-19):** the gold heart carries **no extra points and no extra
  vote weight** — it counts as one vote like any heart; the prize is the feels + the bell
  brag ("Lilly loved your photo"). Keeps crowd-favorite the crowd's prize and the math
  legible; the couple already has Task Master awards/bonus points to express taste.
- **Design constraint (owner):** the gold must be chosen to sit well with the garden green
  theme — settle the exact color in the visual-approval loop.
- Minor open: how the couple's guest accounts get flagged (admin toggle on the guest row —
  settle in the issue).

### Tier 4 — beyond-MVP (owner, 2026-07-19: file all as issues, label beyond-MVP; owner may

personally get some in if time allows)

### N5. First-to-finish bonus

- **Settled (owner, 2026-07-19):** **+1 only — never double** (double makes junk-spam
  profitable). **NOT banked** — the deliberate exception to global decision 7: first place is
  derived from the currently-visible earliest submission, so a host takedown of a junk photo
  passes First to the next guest. Small prize + losable = spamming junk photos to claim
  firsts isn't worth doing; the room seeing your junk does the rest.
- Teaching: receipt ("First! +1 bonus") + ambient ribbon in the feed.

### N6. Flash tasks — host-triggered, time-boxed bonus window

- **Settled (owner, 2026-07-19):** **flat +2 during the window**, not a multiplier — simpler
  math for guests. Banks when earned (decision 7). Teaching = the countdown banner itself.
  First flash fires Saturday, not Friday (decision 4).
- Still open (implementer): schema shape (flag + expiry on tasks vs. settings row).

### N7. Lucky task

- **Settled (owner, 2026-07-19):** **host picks; if the host picked none, the app picks
  random** for the day. +2, revealed ONLY on the success screen receipt ("Lucky task! +2") —
  never announced; discovery and table talk are the delivery mechanism. Follows the
  event-local day (#624's timezone config).

### N8. Photo duels — "which one's better?"

- **Settled (owner, 2026-07-19):** nav stays at 4 links — the duel entry is a **button on
  the gallery page**. A duel tap records a like on the winner (existing one-like-per-guest-
  per-photo constraint caps it; feeds #625's votes — no second currency). **Owner design
  note:** photos fly in fast from either side, tap the winner, the loser bounces away —
  animation over text popups; pixels settle in the visual loop.
- Still open: pair-selection rule and exhaustion (what shows when a guest has judged/liked
  most pairs) — settle at issue review.

### N9. Task-badge copy fix — stop over-promising

- **Settled (owner, 2026-07-19):** the "Earn _[badge]_" line shows **only when the host has
  customized the task's badge**; plain tasks show points only. Custom badges become special
  instead of wallpaper. Also reword to prize framing: "Best photo wins _[badge]_" — a task
  badge is judged, not earned by completion.

### N10. Next-badge nudge (backlog)

- "2 tasks to First Bloom" on the home progress area, rendered only when the next threshold
  is reachable given active tasks (fixes what #88 removed). Small; backlog tier.

---

## Part 3 — Priority order (3 weeks to Aug 7) — CONFIRMED by owner 2026-07-19

Tier 1 — make the rewards that exist actually land:

1. N1 bell (with #563 inside; placement via visual loop)
2. #611 success screen (with slots for bonus receipts)

Tier 2 — the new loops: 3. #625 crowd votes (self-like block, ships after bell) 4. #626 pedestal 5. #624 daily challenges (mystery box, banked bonus, Boise config) 6. N2 per-task values

Tier 3 — visible stakes and status: 7. #469 prizes · #468 slideshow (live during party) · #490/#489 badge visibility ·
N9 copy fix · #410 + icon set · N3 admin checklist · N4 Couple's Heart

Tier 4 — beyond-MVP (all get issues; owner may pull in if time allows): 8. N6 flash tasks · N5 first-to-finish · N8 duels · N7 lucky task

---

## Remaining open questions (the live list — everything else above is settled)

1. **Bell placement / header design** (N1): owner must see it in the visual loop; header is
   clean today and he's skeptical. Possibly its own small header issue.
2. **Bell unread model** (N1): last-checked timestamp + derived queries vs. a notifications
   table — issue-review/implementer call.
3. **Duels pair-selection + exhaustion rule** (N8) — settle at issue review.
4. **Flash task schema shape** (N6) — implementer call.
5. **Couple-account flagging mechanism** (N4) — admin toggle; settle in the issue.
6. **Like-copy coordination** (#625/#490/MOSTLIKED): one shared language across the three
   like-driven surfaces — minor, settle when #625 is amended.
7. **Shared dense-rank helper** (#625/#626): whichever lands first owns it — already noted in
   both issues, just don't lose it.
