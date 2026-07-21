# Admin redesign consult — 2026-07-19

Working record of the admin-page working session (Fable, 2026-07-19). **Pre-issue material** —
nothing here is buildable until it becomes a GitHub issue that passes issue review per the
pipeline. Once an issue is filed or amended, the board wins.

Goal frame: the admin page must be intuitive for the hosts (Goal C — the hosts run the show),
with the gallery-style Photos page as the quality bar ("our new standard"). Recurring owner
complaint: everything on the admin page is too complex / power-user shaped.

---

## Settled items

### 1. Photos: moderation happens in the viewer; Comments tab dies (owner, 2026-07-19)

- The admin Photos page keeps the approved gallery look. Tapping a photo opens the
  moderation lightbox (#675, shared component from #673).
- **Three-dot menu top-right of the viewer** (same slot as the guest owner-menu, #387):
  contains the one contextual action — "Take down photo" when live, "Restore photo" when
  down. Kebab chosen over a bare button because it's more compact; extra actions can join
  the menu later without moving anything.
- **No bonus-points control** on photos ("bonus points might just feel unfair"). Host-awarded
  points flow through the badge-ranking page (#661) instead — every point a guest sees has a
  readable reason. The `photo_bonus` column stays in the DB (already-awarded points keep
  counting); only the control is removed.
- **Comments are moderated inside the photo viewer**, under the photo, each with a small
  Hide control. A hidden comment stays visible to the admin, struck-through, with Restore;
  guests never see it. Context (who's talking to whom, about what photo) is the point.
- **The admin Comments page and nav tab are removed entirely.** Accepted tradeoff: no single
  newest-comments-across-all-photos queue; moderation is reactive (browse or be told), which
  is right for a 3-day party. Hidden comments remain restorable, so a wrong call isn't fatal.
- Issue mapping — CORRECTED 2026-07-20 (accuracy review): #675/#674 were consolidated into
  #673 by the concurrent build session, and #673 shipped (PR #690); the shipped #259 admin
  Photos page is the "gallery I like" — and its Take down button inside the Give-a-badge
  dialog is exactly the buried-takedown complaint. ALL moderation scope now lives in
  **#684** (rewritten): kebab takedown out of the badge dialog, comments in the viewer,
  Comments page/tab removal, and retiring the leftover per-photo points route.

### 2. Tasks: step-through create, WYSIWYG cards, one edit popup (owner, 2026-07-19)

**Issue shape — RESCOPED same day (owner):** the owner's "one task, back end + front end at
once" rule means each FEATURE ships vertical, not that the whole section is one issue.
So: **#682** = the page fully wired (create flow, cards, popup, worth scoring, required
badge, Special radio with None + Hidden only, radio built to extend). Each special is its
own later vertical issue — **#624** one-day (radio option + date/bonus schema + mystery
card + on-day scoring), **#650** lucky, **#649** flash — admin backend + guest frontend +
logic together, so no unwired backend ever sits around. #682's earlier "one big issue"
framing below is superseded by this paragraph.

**Create flow (step-through):**

- Step 1: title, description, worth (1/2/3 chips — #645's tier menu lives here).
- Step 2: badge, REQUIRED. Picker only — **custom badge upload is dead**. The bundled icon
  set (#410, amended) grows to **~100 curated icons**: the romantic set (hearts, flowers,
  rings) plus concrete objects (wine glass, wave, luggage, cake...). Badge = icon in a
  circle-in-circle; the bare icons are reusable elsewhere as photo markers (no circle).
  Badge name typed at pick time. The default ugly ribbon stops existing.
- Hand-awarded badges (Best Dressed etc.) are made through the same picker — exactly one
  way a badge exists. (The "Create a custom badge" form on the Guests page dies with this.)

**The list:** admin task cards are the GUEST task card verbatim (badge, title, "Best photo
wins [badge]", +N pts) plus a thin chip strip for admin state (Active/Hidden, day chips,
lucky/flash markers). Tap a card → the edit popup. This is the anti-clutter rule for every
future task mechanic: a chip on the card + a control in the popup, nothing more.

- #652 reconciliation: "badge line only when customized" dies (badges are required now);
  what survives is the prize framing — every card reads "Best photo wins [badge]".
- Reorder: drag handle on the cards (not in the popup). Photo-count metadata REMOVED from
  the popup (information on information); count lives on the card chip strip if anywhere.

**Edit popup, top to bottom:** Title · Description · Worth (1/2/3) · Badge (tap to reopen
picker) · **Special** (radio, below) · Delete (small, bottom-left) · Save.

- "Pick winners" was cut from the popup — badge ranking (#661) enters from the PHOTOS side.

**Special — one radio, never stack (owner: "those don't stack ever"):**
Options: None · One day only · Lucky task · Flash · Hidden. Each option carries a one-line
plain-language subtitle (owner-drafted tone), and selecting one accordions its questions
open beneath it:

- **One day only** — date (chips from Configuration) + bonus (+1/+2/+3). Mystery locked
  card before its day; ON its day pays base + bonus; AFTER its day it stays submittable at
  base points (bonus only for on-day submissions — matches #624).
- **Lucky task** — day + bonus (+1/+2/+3). Invisible to guests entirely; EVERY guest who
  completes it that day gets the bonus, revealed only on the success-screen receipt. One
  lucky task per day; can be set ahead of time; latest set replaces the day's pick.
  (#650 amended: bonus is host-set, not flat +2; schedulable in advance.)
- **Flash** — bonus (+1/+2/+3) + duration (stepper, 10-minute increments — no preset
  menu) + start (Now, or scheduled day + time — arm the reception flash in the morning).
  Guests see a live countdown banner. When the window ends the task reverts to None.
  (#649 amended: bonus host-set; duration host-set; scheduled start added.)
- **Hidden** — guests never see it.
- Active specials render as status cards in the popup (with Remove / End now) and as chips
  on the task card, so state is visible from the list.

**Dates come from Configuration (NEW page):** linked off the dashboard,
**administrator-only** (hidden from the #666 host role). Holds event timezone (#624's
America/Boise setting) and the wedding dates. All day chips render as "Aug 7" — abbreviated
month + day, no weekday names, no year.

### 3. Guests: compact list, tap-open popup (owner, 2026-07-19)

**The list:** search bar + compact rows (initials/avatar, name, "12 pts · 5 of 9 tasks",
chevron). Blocked guests show a red "Blocked" state in the row. Tap → popup.

**Removed from the page:** "Pin first in gallery" (feature deleted outright), guest-level
bonus points (all host-awarded points flow through photo-side badge ranking), the badge-award
dropdown, and the "Create a custom badge" form (dies with custom badges, section 2).

**Badges attach to PHOTOS, never to people** (owner): a guest holds a badge because their
photo won it. Photo-side ranking (#661) is the only hand-award path; automatic threshold
badges unchanged. No badge UI on Guests, ever.

**The popup:** Name · Contact · Entry code (masked as dots; tap the eye to reveal — pairs
with #666's hide-PINs-from-helpers) · Friends circle toggle (this IS #253's inner-circle,
owner confirmed; also the natural home for N4's couple-account flag when that lands) ·
Block toggle · Delete (small, bottom) · Save.

**Block semantics (owner confirmed):** blocked = locked out immediately, their photos and
comments hidden from guests (takedown-style, reversible); unblock restores everything.
Delete stays the nuclear option (files removed from disk). Accepted limit: the open join QR
means a determined bad actor can rescan and rejoin as a new guest — block again; it's a
speed bump, not a wall.

**No IP banning** (owner accepted the reasoning): the venue wifi NATs most guests behind one
shared IP, so an IP ban aimed at one person can lock out half the wedding. Account-level
block is the tool.

### 4. Poster → Invite (owner, 2026-07-19)

Tab renamed **Invite**. QR code rendered in black or theme green (chip toggle), saved as a
PNG — no print-poster pretense; hosts place the PNG wherever they want. Join link shown
with Copy and a native Share button (share sheet needs the real https origin — fine in
prod; the localhost warning stays for previews).

### 5. Bugs: lifecycle + seeded previews (owner, 2026-07-19)

- Each open report gets two actions: **"Open GitHub issue"** — a prefilled GitHub
  new-issue LINK (title/body carry the report text, guest, page, timestamp; no token, no
  GitHub API — it opens the browser form where the owner is already signed in, and marks
  the report "Tracked on GitHub" locally) — and **"Close — not an issue"** (kept,
  struck-through). Three states: open / tracked / closed. Bugs stay hidden from the #666
  host role.
- **Seed stories gain fake bug reports** so `npm run preview` shows a populated Bugs page
  (today they seed zero). `scripts/` is not on the frozen surface.

### 6. Dashboard: the checklist IS the dashboard (owner, 2026-07-19)

Layout top to bottom: **stats row** (guests · live tasks · open bugs — bugs tile goes red
when any are open) → **one flat checklist** (NOT grouped by day; owner call) → **setup
links** (Configuration [administrator-only] · Invite guests · Download the keepsake export).

Checklist rows are STATE-DRIVEN, not a static list (this absorbs/supersedes #646's doc-style
checklist): "Set a lucky task for Aug 8" checks itself off because one was actually set;
"Look at N new bug reports" appears while open bugs exist; **each ended task gets its own
"Pick winners — [task]" row** (photo count in the subtitle) that clears when that task's
points are released; curated tips ("Put the prizes on display") fill the quiet moments.
Dates render in subtitles ("scheduled Aug 8, 7:30 pm"), ordered by what's actionable now.

---

## Issue actions coming out of this consult

**Filed 2026-07-19 — the board is now canonical for all of these:**
Configuration → **#681** · tasks-admin redesign → **#682** (absorbs #645 + #652, both
closed) · guests-admin redesign → **#683** · comments-in-viewer + Comments-page removal →
**#684** · Invite → **#685** · bugs lifecycle + seeded previews → **#686**. Amendment
comments posted on **#675, #661, #624, #650, #649, #646 (becomes the dashboard),
#662, #666, #647, #253, #363**. Closed: **#485** (superseded by #661 + amended #675),
**#645**, **#652** (absorbed into #682). Same day, after the vertical rescope: **#682's
body was rewritten** (page only; Special radio ships None + Hidden), **#624/#650/#649 got
full-vertical rescope comments** (each owns its radio option + schema + logic + guest
surface), and **#410 was retitled and its body fully rewritten** as the icon-set issue
(upload scope dead; the icon set is the only badge source).

**Accuracy-review corrections (Fable reviewer, applied 2026-07-20):** #675/#674 had been
closed into #673 (shipped, PR #690) BEFORE the #675 amendment comment was posted — that
scope moved into **#684's rewritten body** (kebab + comments + tab removal + points-route
retirement). #682 gained `task.ejs` / `how-to-play.ejs` / `tests/` (completing the
#645/#652 absorption) and the correct `leaderboard()` location. #681's Blocks dropped
#682 and its plan now targets the existing settings table. #410/# 363 corrected to the
**10** catalog badges (most-liked included); #410 re-labeled needs-issue-review.
Dependency comments added on #649/#650 (→ #681, #682, own storage), #683 (→ #410),
#662 (trigger unification), #646 (supersedes shipped #256 where they conflict; #662 not a
hard dep). #485 pointer corrected. #655 stays OPEN despite the merged fix (PR #692) — the
owner is holding it for one remaining gate. Build order rebuilt below after the concurrent
session's merges.

Original action list (for the reasoning; numbers above win):

1. **Amend #675** — admin lightbox SHOWS comments with Hide/Restore (reverses its "no
   comment affordance" line); kebab menu top-right with the contextual Take down/Restore;
   per-photo bonus control removed.
2. **New: admin comments-in-viewer + Comments page/tab removal** (may fold into the #675
   amendment at filing time).
3. **New: tasks-admin redesign — ONE issue** (owner: front + back together): step-through
   create, WYSIWYG card list, edit popup, Special radio (None/One-day/Lucky/Flash/Hidden)
   with per-special bonus. Absorbs #645. If #649/#650 stay beyond-MVP, the popup ships
   with those two options absent and they slot in when their issues land.
4. **New: Configuration page** — event dates + timezone (#624's setting), admin-only,
   linked off the dashboard. Prerequisite for tasks-redesign day chips + dashboard.
5. **Amend #410** — icon set ONLY (custom upload dead), ~100 curated icons.
6. **Amend #649** (host-set bonus 1-3, duration in 10-min steps, scheduled start, reverts
   to None on expiry) and **#650** (host-set bonus 1-3, schedulable ahead, one per day,
   latest wins).
7. **Amend #652** — prize framing survives; "only when customized" clause dies.
8. **Amend #624** — dates from Configuration; "Aug 7" date format; on-day-bonus semantics
   confirmed (submittable after its day at base points).
9. **New: guests-admin redesign** — list + popup, Block feature; pin-first, guest-level
   bonus, badge-award UI, and the custom-badge form all deleted.
10. **New: Invite page** (supersedes the poster page).
11. **New: dashboard checklist** (absorbs/supersedes #646's surface).
12. **New: bug lifecycle + seeded bug reports** in the preview stories.
13. **Amend #661** — entry point is the Photos side (card/lightbox), not the tasks popup;
    dashboard checklist rows link into it (#662 stays aligned).

All admin screens above are visual surfaces: they go through ONE holistic phase-1
visual-approval loop (per the bundle pattern), then split into their phase-2 issues.

---

## Build order (corrected 2026-07-20 — order only, no dates)

Supersedes the earlier week-by-week draft (owner: order, not dates) AND the first ordered
list, which predated the concurrent session's merges: already SHIPPED and struck from the
order — #655 (PR #692), #612-adjacent feed work, #613 (PR #678), #468 slideshow (PR #672),
#673 lightbox with #674/#675 consolidated into it (PR #690), #259 admin photos rework,
#256 dashboard rework, #610 gallery show-more, #663 how-to-play link. One issue per build
session, per the wave discipline. Sequencing rules: #410 before #682 (required badge needs
the picker); #681 + #682 before #624; #644 before #625 (point swings need delivery); #646
late (its rows read #682/#686/#661 state), #662 right after #646. #682 does NOT depend on
#681.

1. #612 feed photo fill (verify still open against the merged feed changes, then build)
2. #684 photo moderation — kebab takedown, comments in viewer, Comments tab removal
3. #410 icon set
4. #682 tasks-admin page rebuild
5. #681 Configuration
6. #624 one-day tasks (full vertical)
7. #644 bell
8. #611 success screen
9. #625 crowd votes
10. #626 pedestal
11. #661 badge ranking (Photos side; #259's chosen/5 flow is its shipped entry)
12. #683 guests-admin rebuild + Block
13. #686 bug lifecycle + seeded previews
14. #685 Invite
15. #646 dashboard checklist (as amended; reworks the shipped #256 layout)
16. #662 smart checklist rows
17. #490 tile medals · 18. #489 leaderboard badges · 19. #469 prizes
18. #647 Couple's Heart · 21. #666 host role · 22. #669 photos pagination
19. #656 memories points · 24. #527 live task search · 25. #340 edit own comments
20. #284 security headers/CSRF · 27. #539 empty-DB drill · 28. #292 load-test drill

If green and time remains: #649 flash, #650 lucky, #648 first-to-finish, #651 duels,
#253 friends circle, #363 badge-art restyle (10 catalog badges incl. most-liked),
#368/#653 backlog, #640 bachelor instance.
