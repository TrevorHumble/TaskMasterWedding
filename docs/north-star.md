# North Star & Goals — Garden Party Pastels

**As an agent or contributor about to change this codebase, I need one orienting picture of what we're building and why, so every issue, plan, PR, and review can be checked against it.**

Confirmed with the owner 2026-06-28. The app must be live for guests by **Friday, August 7, 2026** (the welcome dinner). The wedding weekend runs **Aug 7–9, 2026**: Fri the 7th welcome dinner · Sat the 8th wedding + party · Sun the 9th brunch.

This states the outcomes we're building toward — the destination, not a status report. What is shipped versus still in flight is tracked as GitHub issues, not here.

## The shift we're designing for

> A wedding guest goes from passive spectator to active, _steered_ participant — drawn to the moments, activities, and people the hosts point them toward, mingling beyond their own circle, and dropping what they capture into a shared record of the weekend, because the game makes it rewarding. The engagement is in the celebration itself, not on the screen.

- **End user (whose behavior changes):** the wedding guest.
- **Who it pays off for:** the couple (Lilly & Axel) and their planners.

## The four goals

### A · Easy in, solid throughout

> Let any guest start playing within seconds of tapping their link — on a site that stays fast with the whole party on it at once — so the tech sidelines no one, and everyone they invited, grandparents included, gets to share in the day.

- **Effortless entry** — playing seconds after a tap; no install, account, or password.
- **Explains itself** — a guest knows what to do without instructions.
- **Holds up at peak** — fast and standing with the whole guest list on it at once, on venue wifi or their own connection.

### B · A game worth playing

> Keep guests choosing to play — an instant payoff every time they finish a task, badges and standings that pull them back, and the hosts' prizes in plain view — so the room stays full of guests active in the celebration itself: not polite spectators, and not buried in their phones.

- **Instant reward** — finish a task, points and a badge land right away.
- **Sustains + confers status** — leaderboard, badges, and visible profiles keep guests coming back and give bragging rights.
- **Visible stakes** — the hosts' prizes and awards are on clear display, so guests know what they're chasing.

### C · The hosts run the show

> Give the couple and planners a live steering wheel: tasks they set and change on the fly, prizes they put up, and the power to hide, move, or delete any photo. It lets them choreograph the weekend they planned — guests drawn to the moments that matter, the different families and friend-circles mixing, and what's shared kept right for each part of the weekend.

- **Steer in real time** — add, edit, remove tasks themselves, day-of, with no tech help.
- **Mixing feels sanctioned** — "the game told me to" makes meeting strangers easy.
- **Contained sharing** — keep content to the right audience; delete, hide, or move a photo between groups.

### D · One shared record, kept

> Turn a hundred phones into one shared record of the weekend — gathered into a gallery as it happens, shown as a favorites slideshow at the end, and exported as a keepsake after — so the couple walks away with the candid, hundred-angle story they'd never have collected on their own.

- **Real, visible, trusted sharing** — one gallery everyone watches fill; profiles and social links to find each other after.
- **Collects into a keepsake** — export every photo plus a record of who did what (Flickr / email).
- **The best becomes a shared moment** — host-curated favorites auto-build the slideshow.

## Scope

Built for **this** wedding: ~100 guests, run for this one event on a small web host (live before, during, and shortly after the weekend), then exported and taken down. Out of scope for this build: multi-event or organizer accounts, native apps, a multi-event hosting product, in-app messaging, teams or GPS/check-in mechanics, RSVP / guest-management / payments, and internet-scale load. (hosting this one wedding on a web host is in scope — decided 2026-07-07) The visual design and brand look are the owner's separate track — agents do not redesign.

**In scope: a bounded social layer.** Guests can give **likes**, leave host-moderated **comments**, and earn per-photo **points** on the gallery — tied to Goal B (an instant, sustaining reward loop) and Goal D (the gallery as a real, shared record people actually watch and return to).

**Moderation, reconciled.** Host **takedown/hide** of a photo or a comment is in scope — the same reversible moderation already described in `DESIGN.md`. A **per-photo pre-approval pipeline** (screening before anything is visible) remains out of scope; moderation here is after-the-fact, not gatekeeping.

**Guiding principle for the social layer: "look up, not look down."** Likes, comments, and points exist to pull a guest's eyes back up from the phone into the room — never to build a second screen worth staring at. In service of that test, comments ship with **no notifications** and **no reply threads**.

Confirmed with the owner 2026-06-28. **Scope expanded by the owner on 2026-07-02** to admit the social layer above (likes, host-moderated comments, per-photo points); the 2026-06-28 confirmation stands, this is additive. Hosting decision recorded 2026-07-07: the app runs on a rented web host; single-event scope is unchanged.

## The longer horizon

If it turns out good, it could grow past this one wedding into a reusable product. That ambition sits _above_ these goals — it is the open door, not this build's scope. Build cleanly enough not to wall it off; do not spend this build's time on multi-event plumbing it doesn't need yet.

## How to use this

Every issue, implementation plan, PR, and review checks its work against the goal it serves (A–D). A change that moves none of the four — and isn't protecting the scope line — should be questioned before it goes in.
