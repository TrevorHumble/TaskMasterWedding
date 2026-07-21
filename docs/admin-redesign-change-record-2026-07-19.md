# Admin redesign — change record (2026-07-19)

Everything decided in the admin working session, page by page, as before → after. This is
the companion to [`admin-consult-2026-07-19.md`](admin-consult-2026-07-19.md) (the full
design detail and issue actions) and reads best as the summary of what actually changed.
Nothing here is built yet; each change lands through the pipeline as an issue.

---

## System-wide transformations

These six decisions cut across every page:

1. **One interaction pattern everywhere.** Every admin page becomes: a simple list that
   looks like what guests see → tap an item → one popup with all the controls. No more
   always-open edit forms stacked on the page. (Tasks, Guests, and Photos all converge on
   this; the gallery-style Photos page set the standard.)

2. **Badges attach to photos, never to people.** A guest "has" a badge because their photo
   won it. Photo-side ranking is the only hand-award path; automatic threshold badges are
   unchanged. All badge UI leaves the Guests page.

3. **One way a badge exists.** Custom badge upload is dead. Every badge is picked from a
   bundled icon set (~100 curated icons: hearts, flowers, rings, plus concrete objects —
   wine glass, wave, luggage), rendered as an icon in a circle. Badges are required at task
   creation, so the ugly default ribbon stops existing. Bare icons are reusable as photo
   markers.

4. **Every point has a readable reason.** Freeform bonus points are gone — both the
   per-photo points path and the guest-level bonus form ("bonus points might just
   feel unfair"). Points come only from sources a guest can read the story of: task worth
   (1/2/3), special bonuses (one-day / lucky / flash, each host-set 1–3), crowd votes,
   ranked badge points, and the small fixed earn rules (first memory of the day #656,
   first-to-finish #648 if built).

5. **Dates live in one place.** A new Configuration page (administrator-only, linked off
   the dashboard) holds the event timezone and the wedding dates. Every day chip in the app
   reads from it and renders as "Aug 7" — no weekday names, no year.

6. **The admin nav shrinks.** The Comments tab is deleted (moderation moved into the photo
   viewer) and Poster becomes Invite. Result: Dashboard · Tasks · Guests · Photos · Bugs ·
   Invite.

---

## Page by page

### Dashboard

| Before (the shipped #256 page) | After |
| --- | --- |
| Six tappable stats + activity pulse + menu-list actions (shipped mid-consult by the concurrent session); owner's question "what is this page for" stands | Stats shrink to three: guests · live tasks · open bugs (red when any open) |
| | One flat **state-driven checklist** — rows check themselves off from real app state ("Set a lucky task for Aug 8"; one "Pick winners — [task]" row per ended task with photos waiting; "Look at N new bug reports"); curated tips fill gaps. Not grouped by day. |
| | Setup links at the bottom: Configuration (administrator-only) · Invite guests · Download the keepsake export |

### Tasks

| Before | After |
| --- | --- |
| One long page of always-open edit forms per task | Cards rendered exactly as guests see them (badge, title, "Best photo wins [badge]", +N pts) + a thin admin chip strip (state, day, lucky/flash); drag handle to reorder; tap a card to edit |
| Badge optional, ugly default; upload form inline | Badge **required** at creation via the icon picker (step 2 of a step-through: title/description/worth first, then badge) |
| No point values | Worth 1/2/3 chips (absorbs #645) |
| Active/hide toggle + separate concepts | One **Special** radio — None · One day only · Lucky task · Flash · Hidden — each with a one-line plain-language subtitle; picking one accordions its questions open. Specials never stack. |
| — | One day only: date + bonus; mystery card before its day; submittable after at base points. Lucky: day + bonus; invisible; every on-day completer gets the bonus on the success screen. Flash: bonus + duration (10-min stepper) + start now or scheduled day/time; countdown banner for guests; reverts when it ends. |
| "Pick winners" ideas floated in the popup | Cut — badge ranking is entered from the Photos side |
| Photo count in the editor | Removed ("information on top of information") |

Ships as **vertical issues** (rescoped 2026-07-19): #682 is the page fully wired (radio
carries None + Hidden only); each special — one-day #624, lucky #650, flash #649 — later
adds its own radio option, schema, logic, and guest surface in one issue apiece, so no
unwired backend sits around.

### Guests

| Before | After |
| --- | --- |
| Cards with name form, pin-first checkbox, identity forms, bonus-points form, badge-award dropdown, delete | Search + compact rows (avatar, name, pts, tasks, Blocked state) → tap → popup |
| Pin first in gallery | **Deleted outright** |
| Bonus points | **Deleted** (economy rule above) |
| Badge award dropdown + "Create a custom badge" form | **Deleted** (badge rules above) |
| Re-entry code shown in plain text | Masked as dots; tap the eye to reveal (pairs with #666 hiding PINs from helpers) |
| — | **Friends circle** toggle (the #253 inner-circle) |
| — | **Block** toggle: locked out immediately, photos/comments hidden (reversible); unblock restores. Delete stays the nuclear option. No IP bans — venue wifi shares one address; account block is the tool. |

### Photos

| Before (the shipped #259 page) | After |
| --- | --- |
| Gallery-parity grid + feed the owner likes, with full-res lightbox (#673, shipped) | Kept |
| Take down/Restore buried inside the Give-a-badge dialog — the owner's exact complaint | Three-dot menu on the photo with the one contextual action: Take down photo / Restore photo; the badge dialog becomes award-only (#684) |
| Leftover per-photo points route (form already gone in #259) | Route retired; existing awarded points keep counting (#684) |
| Comments moderated on a separate page | **Comments moderated in the viewer**, under the photo, each with Hide; hidden ones stay struck-through with Restore, invisible to guests (#684) |

### Comments

Page and nav tab **deleted**. Moderation happens with the photo in view — context is the
point. Accepted tradeoff: no all-newest-comments queue; reactive moderation is right for a
3-day party, and hidden comments stay restorable.

### Bugs

| Before | After |
| --- | --- |
| Report + one "Resolved" button | Three states: **open** → "Open GitHub issue" (prefilled new-issue link — report text, guest, page, timestamp; no token, no API) or "Close — not an issue" → **tracked** / **closed** (kept, struck through) |
| Preview instances always show an empty Bugs page | Seed stories gain fake bug reports so `npm run preview` has a populated page |
| | Dashboard bug tile counts only truly open reports |

### Poster → Invite

| Before | After |
| --- | --- |
| Print-a-poster page | **Invite** page: QR in black or theme green, saved as PNG (place it anywhere yourself); join link with Copy + native Share buttons |

---

## Where each change lands

New issues #681–#686; #410 and #684 retitled and rewritten; amendments on #624, #646,
#647, #649, #650, #253, #363, #661, #662, #666; #485/#645/#652 closed. #655's fix merged
(PR #692) but the issue stays open — the owner holds it for one remaining gate. The 2026-07-19 amendment on #675 landed after that issue was
consolidated into #673 (shipped) — its scope moved into #684's rewritten body. The full
disposition list and the corrected build order (order only, no dates) live in
[`admin-consult-2026-07-19.md`](admin-consult-2026-07-19.md). All admin screens go through
one holistic phase-1 visual-approval loop before their phase-2 issues run.
