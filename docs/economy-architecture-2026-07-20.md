# Economy architecture — five structural rules (2026-07-20)

Owner-directed architecture note for the points/badges build wave (the 2026-07-19/20
design session). Every issue that touches scoring or badges builds against these five
rules; an implementation that violates one is a defect to flag at review, not a style
choice. Committed to the repo by #706; the game rules themselves live in the canonical
rules comment posted on every adjacent issue and in `docs/game-design-points-badges.md`.

The problem these prevent: the economy is growing from two point sources to nine, across
two parallel read paths and a dozen surfaces. Without single owners, every new rule is a
copy-paste into N places and the next audit finds N-1 of them drifted.

## 1. One points recipe

Every point rule today is written twice — once in `getPoints` (src/services/scoring.js)
and once in the `leaderboard()` SQL. Two copies held together by comments. Adding six
rules doubles into twelve drift chances.

**Rule (prescribed, not the shipped shape):** point terms are defined once, in one
registry in `src/services/scoring.js` (the same shape `src/services/badges.js` uses for
badge registries), and BOTH read paths compose the same term list. A new rule (worth,
banked bonus, memory day, auto-badge +1, crowd favorite, ranked awards) is one registry
entry, never a second hand-written copy. If the per-guest and all-guests shapes genuinely
need different SQL, both shapes live side by side in the term's single entry — never in
two far-apart functions.

**What actually shipped:** no such registry exists. `getPoints()` (one guest) sums eight
JS terms read from separate prepared statements; `leaderboard()` (all guests) computes the
same eight terms as one large interpolated SQL expression. These are two independently
written, hand-kept-in-sync implementations — each term's doc comment in both functions
cross-references the other by name specifically because there is no single registry
enforcing agreement. This rule's own goal (stop a new rule from becoming a second
hand-written copy) has not been met; treat it as an open prescription, not a description
of `src/services/scoring.js` as it stands.

## 2. One "active task" definition

"Active" is about to mean: not deleted, not hidden (`special_mode`, #682), and not a
future-dated challenge (#624). At least five call sites ask the question: the guest task
list, the submit gate (src/services/submissions.js), COMPLETIONIST's task set
(src/services/badges.js), the next-badge nudge (#653), and the lucky/flash task pickers
(#649/#650).

**Rule:** one owner (a function or SQL fragment exported from one module) answers "which
tasks are live for guests right now"; every surface consumes it. A second hand-written
`is_active`/`special_mode` predicate anywhere is a defect. This is also what keeps
COMPLETIONIST honest: #624's challenge tasks are excluded from its set by the owner
definition, in one place.

## 3. One banked-bonus shape

Daily on-day (#624), flash (#649), and lucky (#650) are the same mechanism three times:
a bonus decided at submit time, banked on the photo, surviving replace, dying with
takedown, explained on a receipt.

**Rule:** one column pair on `submissions` — banked bonus amount + banked bonus reason —
with three writers and a single intended reader. The scoring term (rule 1) sums the amount
over visible submissions exactly like `photo_bonus`; the success screen (#611) is meant to
render the reason, though as shipped that reader does not yet exist (see the amendment
below). Three separate columns or three separate scoring terms is the defect. The first of
#624/#649/#650 to land owns the migration; the other two consume it.

Amended by #644: the recap does NOT also render this reason. The owner decided
(2026-07-21) that a recap row explaining a bonus the guest already saw explained on the
success screen is a duplicate receipt, not a second surface — #644's scope is badge
grant/revoke, likes, and comments only. The success screen (#611) was intended as the sole
reader of `bonus_reason`, but as shipped `bonus_reason` is currently write-only: the three
banked-bonus writers (`src/services/tasks.js`'s daily/flash/lucky `SPECIAL_RULES` reasons,
written through `src/services/submissions.js`) populate the column, and no code path reads
it back — `bonus_reason` does not appear in any `SELECT` list or view in this codebase.
The success screen's reader is not yet built.

## 4. One recompute seam, with a trigger checklist

Points derive on read and cannot rot. Materialized badge rows rot the moment any input
mutates without a recompute — the entire defect class the 2026-07-19 audit found (#701).

**Rule A — derive over store.** A new scoring/badge feature computes on read unless it
has a stated reason to materialize (crowd favorite is fully derived for exactly this
reason — see #625). Anything materialized must list, in its issue, a trigger for every
input mutation.

**Rule B — one door.** All recompute triggers go through the existing seams
(`recomputeAfterSubmissionChange`, `recomputeAfterTaskChange`, and their future
siblings) — never a route calling a private recompute of its own. The current trigger
checklist: submission create/replace, takedown/restore, like toggle, task
add/toggle/delete (#701). Known additions owed: guest delete (N8), block/unblock (#683).
A route that mutates a scoring input and is not on this list is a defect.

**Rule C — the recap listens at the same door, for row-bearing badges.** #644 emits
badge grant/revoke events from the recompute door's own inner statements
(`recomputeBadges`/`recomputeTransferableBadges`) for recompute-driven badges — never
from per-surface display code. Two emitters are deliberately NOT on this door, and this
is not a violation of Rule B (which governs SCORING recompute triggers, not the recap's
event log): #644's own host-award seams (`awardSpecialBadge`/`removeSpecialBadge`) fire
from the admin action itself, since a host award is not a recomputed fact to begin with;
and #783's moderation events (photo takedown/restore, comment hide/restore) will, once
built, fire from the host **routes** that perform the moderation, not from
`photos.hideSubmission`'s recompute seam, for the identical reason — the actor being
recorded is the host's action, not a derived recompute. #783 has not landed: the four
moderation `kind` values (`photo_takedown`/`photo_restore`/`comment_hidden`/
`comment_restored`) exist only as display-mapping entries in
`src/services/notifications.js`'s `KIND_VIEW` — no route calls `recordEvent` with any of
them yet, so this paragraph states the rule the eventual emitters must follow, not a
built behavior. Crowd-favorite reward/loss events (from the like-toggle derived diff)
remain owned by #625 and are shipped.

## 5. One badge medallion

Badges render on nine surfaces (task cards, admin cards, guest home, public profile,
leaderboard strip, badge detail, celebration modal, feed medals, slideshow). #410 shipped
the icon-in-ring medallion as the single badge look.

**Rule:** every surface renders a badge through the shared medallion partial — including
the gold variant (rank 1, one render rule + one sort rule, N2) and the tile medal markers
(#489/#490). A surface hand-composing badge art outside the partial is a defect. As
shipped (#788, #811), gold's two rank _sources_ (award rows for task badges, the derived
crowd-favorite set) feed two sibling tile _renderers_ — `partials/crowd-favorite-mark.ejs`
(the crown) and `partials/badge-victory-mark.ejs` (the medal) — not one shared renderer;
each is the single owner of its own rank source's gold treatment, and the two are kept
visually consistent (same shape, same "only the winner is gold" rule) by convention
between the two partials' own doc comments rather than by a shared component. The
gold-sorts-first display rule this section also describes remains unbuilt.

## The standing kills (context, owned elsewhere)

One badge substrate (`badges` + `guest_badges`, shipped — `badge_winners` dropped outright
by `src/db.js`'s `ensureBadgeWinnersTableDropped`; the placeholder five and their parallel
catalog die in #661's rewrite, shipped) · no freeform points and no badges on people:
photo-level is shipped (#684, closed); guest-level is a planned removal — #683 open,
owner decision pending as of 2026-07-24 (the guests-page badge dropdown, custom-badge
form, and guest-level bonus points remain currently live until #683 is decided) ·
MOSTPHOTOS/MOSTLIKED removed (replaced by derived crowd favorite, shipped #625).
