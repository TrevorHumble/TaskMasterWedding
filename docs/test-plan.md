# Manual Walkthrough Test Plan

A step-by-step checklist for a human — not a developer — to confirm the app works end to end, run before the wedding and after any significant deploy. Run it against a seeded ~100-guest event, not the real event data, so nothing here touches a real guest.

Each scenario below is written as: what to do, what you should see, and a checkbox to mark the result. Work through every box. If a box fails, write down what you saw next to it (or in a separate notes doc) and file it as a defect — do not just re-check it and move on.

**A note on scope:** the Goal B and admin award/badge steps below target the design being built — the authority is [`docs/game-design-points-badges.md`](game-design-points-badges.md), specifically its "Data flow and architecture" section; steps that still exercise the previous scoring/badge model are moved to [Deprecated](#deprecated) at the bottom.

## Setup

Do this once, before you start testing.

0. **Make sure you are testing current code.** Build sessions merge their work on GitHub, and your local folder does not update itself. From the project root, in PowerShell:

   ```powershell
   powershell -File tools/check-freshness.ps1
   ```

   If it says you are behind, run `git pull` first — otherwise this whole walkthrough (including the wedding dress-rehearsal) is run against an old version of the app. The check is read-only and never changes your files.

1. **Seed the isolated event database.** Do not run this against your real event data — it creates its own separate database. From the project root, in PowerShell:

   ```powershell
   $env:DATA_DIR = "data-demo"
   node scripts/seed-event.js --guests 100
   ```

   This creates ~100 guests, a set of tasks, sample photo submissions, and awarded badges, all inside `data-demo` (a folder next to the real `data` folder — it never touches real event data). These guests carry internal identifiers `event-guest-token-0` through `event-guest-token-99` — not sign-in links; nothing signs you in as one of them. The first guest, named "Ava Martinez," is the engineered top scorer on the leaderboard — useful for checking rank #1 quickly.

2. **Set an admin password for this test run.** Choose your own password (at least 12 characters) — do not reuse the real event's password, and do not write the real password into any document:

   ```powershell
   $env:DATA_DIR = "data-demo"
   node scripts/set-admin-password.js <choose-your-own-password>
   ```

3. **Start the app** with the same `data-demo` directory:

   ```powershell
   $env:DATA_DIR = "data-demo"
   npm run serve
   ```

   Leave this running in its own terminal window for the rest of the walkthrough.

4. **Open two browser sessions** — use one regular window and one private/incognito window so the two sign-ins don't overwrite each other's cookies:
   - **Guest window:** go to `http://localhost:3000/join` and sign up with a name, an email or phone, and a 4-digit PIN of your choosing. This creates a brand-new guest and signs you in as them — the 100 pre-seeded event guests are there to populate the gallery/leaderboard for you to look at, not for you to sign in as.
   - **Admin window:** go to `http://localhost:3000/admin/login` and sign in with the password you set in step 2.

- [ ] Setup complete: server running, guest window signed in, admin window signed in.

---

## Goal A — Easy in, solid throughout

Any guest can play in seconds, and nothing about the tech gets in the way.

### A1. The shared poster link takes a new guest straight to signup

Steps: In a fresh private window, go to `/join` (the same link every guest gets, from the printed poster — see C9 below).

Expected: The signup form appears immediately — no error, no login prompt, no password asked.

- [ ] Pass/fail

### A2. Signup collects a name, contact, and PIN in one step

Steps: Fill in a name, an email or phone, and a 4-digit PIN. Skip the avatar and social fields.

Expected: You land on the "How to play" rules card (`/how-to-play`), with no "Skip for now" link on it — that link only appears when the page is reached with a `?first=1` link, which nothing in the app currently sends you here with. Tap "See your list of tasks" at the bottom of the card.

Expected: You land on `/tasks`, with the name you entered now shown around the app (e.g. on your home page) — there is no separate onboarding form anywhere in this flow.

- [ ] Pass/fail

### A3. An old personal link never signs anyone in

Steps: In a fresh private window, go to `/j/anything-at-all` (any value — this route is fully retired).

Expected: You land on `/join`, signed OUT. No sign-in cookie is set — confirm by then visiting `/tasks` in that same window; it should also redirect you to `/join`, not show the tasks list.

- [ ] Pass/fail

### A4. Session persists across a browser restart

Steps: After signing in as a guest (A1), close the browser window entirely and reopen it, then go to `http://localhost:3000/`.

Expected: You're still signed in as the same guest — no need to scan the link again.

- [ ] Pass/fail

### A5. Maintenance mode blocks guests but not admin

Steps: Stop the server. Restart it with maintenance mode on:

```powershell
$env:DATA_DIR = "data-demo"
$env:MAINTENANCE = "1"
npm run serve
```

Then load `/` as a guest, and separately load `/admin/login` as admin.

Expected: The guest gets a 503 "under maintenance" style page. The admin login page still loads normally and admin can still sign in and reach `/admin`. Afterward, stop the server, unset `$env:MAINTENANCE` (or set it to `"0"`), and restart normally before continuing the rest of this plan.

- [ ] Pass/fail

### A6. Guest re-entry on a new device, and a wrong-PIN lockout

Steps: Sign out of the guest window (or open a fresh private window) and go to `/login`. Enter the contact and PIN you chose at signup in A2.

Expected: You're signed back in as the same guest, landing on `/` with your existing points, badges, and photos intact — this is how a guest gets back in on a different device with no private link to re-scan.

Steps (continued): Sign out again, go to `/login`, and deliberately submit the correct contact with the wrong PIN five times in a row.

Expected: Every wrong attempt shows the same generic "That contact and code don't match." message (it never hints whether the contact itself is registered). After the 5th failed attempt, a 6th attempt — even with the CORRECT PIN — is refused with a "Too many attempts. Try again in a few minutes." message. Wait out the lockout (or restart the server to reset it) before continuing testing.

- [ ] Pass/fail

---

## Goal B — A game worth playing

Guests get instant rewards, see badges and standings, and stay active in the celebration rather than just watching a screen.

### B2. Auto badges unlock at the right thresholds

Steps: As a guest with fewer than 5 completed tasks, complete tasks one at a time (or use a guest token already near a threshold from the seed data) until you cross 5 completed tasks, watching the home page badges section after each submission.

Expected: The **BLOOM** badge appears exactly when the 5th task is completed — not before. If you continue to 10 and 15, **BOUQUET** unlocks at 10 and **GARDEN** unlocks at 15. Badges never appear early.

- [ ] Pass/fail

### B3. Replacing a submission doesn't double-count the task

Steps: Go to a task you've already completed, and upload a new photo to replace the existing one.

Expected: A "Photo replaced!" message, the new photo shows on the task page, and the guest's total points do **not** increase (still counts as one completed task, not two).

- [ ] Pass/fail

### B4. Leaderboard shows correct order, with ties handled sensibly

Steps: In the guest window, go to `/leaderboard`. Then, in a fresh private window with no guest signed in, go to the same URL.

Expected: Signed in, the full standings list appears, ordered highest points first. Signed out, you're redirected to `/join` instead — `/leaderboard` requires a signed-in guest, the same as `/gallery`, `/feed`, and the other community pages. Back in the guest window: two guests with the same point total show the same rank number (e.g. both show "3"), and the next distinct guest below them takes the very next number with no gap (e.g. "4", not "5" — a tie never skips a rank on this list). "Ava Martinez" (the engineered top scorer — see Setup step 1) should be at or near rank 1.

- [ ] Pass/fail

### B6. Upload button shows the right label at each stage

Steps: On a task you haven't completed yet, open the upload form and look at the submit button before choosing a photo.

Expected: The button reads "Upload & complete". Choose a photo and tap the button.

Expected: While the upload is in progress, the button's label changes to "Uploading…". Once it finishes, you land back on the task page as normal, now showing the task as completed.

Steps (continued): Go to that same now-completed task again and open the upload form.

Expected: This time the button reads "Replace photo" instead of "Upload & complete", since a submission already exists.

- [ ] Pass/fail

### B7. Large photos are downscaled before upload

Steps: Upload a large photo (over roughly 2000 pixels on its longest side — most phone camera photos qualify) to a task.

Expected: The upload succeeds without a slow wait or a failure. The app resizes the image in your browser (down to a 2000px-long-edge maximum) before sending it, so you don't need to compress the photo yourself first.

- [ ] Pass/fail

### B8. Tasks page shows a running "to do" count

Steps: As a signed-in guest with at least one task still incomplete, go to `/tasks`.

Expected: A chip near the top reads "To do ·" followed by a number, and that number matches how many tasks on the page are still not completed. Complete one more task and reload `/tasks`.

Expected: The number in the chip goes down by one.

- [ ] Pass/fail

### B9. Tied podium spots show a "points each" note

Steps: Go to `/leaderboard`. Look at the top-3 podium display (not the full standings list below it) for a spot where two or more guests are tied — the seed data should produce at least one tie near the top; if not, see the Deprecated section below for one way to force a tie for testing purposes.

Expected: A tied podium spot shows a stack of the tied guests' avatars — up to nine, with a "+N" badge if more than nine guests are tied — and a subline reading something like "2nd place · 12 pts each" — the literal phrase "pts each" appears under a tied group, unlike a single winner's spot, which just shows their name.

- [ ] Pass/fail

### B10. A one-day-only challenge is a locked mystery box, and only one shows at a time

Steps: In the admin window, go to `/admin/tasks` and create a task with Special set to "One day only," dated for a day after today (see C1 below for the create-wizard steps). Create a SECOND task the same way, dated for a different future day. As a guest, go to `/tasks`.

Expected: Only ONE locked card appears at the top of the list — the one unlocking soonest — even though two sealed challenges exist (the "one-box ceiling": a guest never sees more than one mystery box at once). The card shows no title, no description, and no badge — just a lock icon, a live "Unlocks in Xd Xh Xm Xs" countdown, and a "+? pts" price tag. It is not a link.

Steps (continued): In the admin window, edit the soonest-unlocking task's date to today (see C2 below for the edit popup).

Expected: Reload `/tasks` as the guest. That task now renders as an ordinary row with its real title and a gold "+N pts Today Only" flag (its price tag shows the base worth struck through, then the raised total). The OTHER sealed challenge now takes the one-box slot and shows as the locked card instead.

- [ ] Pass/fail

### B11. A flash task counts down live and pays a time-boxed bonus

Steps: In the admin window, edit a task (or create one) and set Special to "Flash," starting now, for a short window (e.g. 5 minutes) with a bonus of your choosing. As a guest, go to `/tasks`.

Expected: The task leads the to-do list with a lightning-bolt flag reading "+N pts right now" and a live mm:ss (or h:mm:ss) countdown, plus a fill bar that visibly drains toward empty as the window runs out. Its price tag shows the base worth struck through, then the raised total.

Steps (continued): Submit a photo to that task before the window ends.

Expected: The success card confirms the raised total banked, and the guest's point total on `/` reflects it. Reload `/tasks` after the window ends (or set a very short window and wait it out).

Expected: The flash flag and drain bar are gone; the task shows as an ordinary completed row, worth only its base points.

- [ ] Pass/fail

### B12. A lucky task is a hidden surprise — no marker until you win it

Steps: In the admin window, edit a task and set Special to "Lucky," dated for today, with a bonus of your choosing. As a guest, go to `/tasks` and look at that task's row.

Expected: The row looks completely ordinary — no flag, no hint that it is today's lucky task (the whole point: it stays a secret until someone wins it).

Steps (continued): Submit a photo to that task.

Expected: The success card shows a gold four-leaf-clover mark (replacing the usual green check) and the heading "You found the lucky task!", with the points shown as a split — the task's normal earn, plus "+N bonus" — rather than one merged number.

- [ ] Pass/fail

### B13. Liking a photo crowns it a crowd favorite

Steps: As a guest, go to `/feed` and tap the heart on any photo that has zero likes so far.

Expected: The like registers (D8 below covers the heart/count behavior itself). Reload `/feed` or `/gallery`.

Expected: That photo now wears a small crown mark on its tile. Because it is (for now) the only liked photo, it is the sole rank-1 photo, so the crown is GOLD (its accessible label reads "Crowd favorite — number one"). If four more guests like four other photos before this one collects a second like, reload again: your photo's crown may turn plain white (still top-5, no longer the lone leader) rather than gold — either state is correct, it just depends on what else got liked meanwhile.

- [ ] Pass/fail

### B14. A new badge celebrates once, then the recap panel remembers it

Steps: As a guest below 5 completed tasks, complete tasks until you cross the 5-task BLOOM threshold (same trigger as B2 above), watching the page that redirects you after the winning submission.

Expected: A "You earned a badge" celebration dialog opens automatically on that page load, showing the badge's name and art with a "Continue" button. Dismiss it, then reload the same page.

Expected: The dialog does NOT reopen — it celebrates once, not on every subsequent visit. Now look at the header at the top of any page.

Expected: A strip reading "1 new notification" (or more, if other things happened meanwhile) appears; tap it to open the "What you missed" panel, and confirm the new-badge moment is listed there. Tap it again — the celebration dialog reopens as a replay. Reload any page afterward.

Expected: The notification strip is gone (opening the recap panel marks it seen) and no count remains.

- [ ] Pass/fail

---

## Goal C — The hosts run the show

The couple and planners can steer tasks, set prizes and points, and moderate content — choreographing the weekend as it happens.

### C1. Create, edit, delete a task

Steps: In the admin window, go to `/admin/tasks` and open "New task." Step 1 of the create wizard: fill in a title, an optional description, and pick a Worth (1/2/3 pts), then tap Next. Step 2: leave Special as "None," then tap Next. Step 3: tap "Choose badge" and pick any badge from the picker.

Expected: Once a badge is chosen, the "Create task" button (previously disabled) becomes tappable — a task cannot be created without picking a badge. Tap it.

Expected: A confirmation message appears and the new task shows up in the tasks list immediately, carrying the badge you picked. Edit its title, then delete it.

Expected: The new title shows after editing, and the task is gone after deleting — each action shows its own confirmation message.

- [ ] Pass/fail

### C2. Hiding a task removes it from the guest list; showing it again brings it back

Steps: In `/admin/tasks`, tap a task's card to open its edit popup. Under "Special," select "Hidden," then Save. As a guest, visit `/tasks`.

Expected: The hidden task no longer appears anywhere in the guest's task list. Reopen the same task's edit popup in the admin window, switch Special back to "None," and Save.

Expected: Reload `/tasks` as the guest — the task reappears.

- [ ] Pass/fail

### C3. Reorder tasks

Steps: In `/admin/tasks`, press and drag a task card by its drag handle to a new position in the list, then drop it.

Expected: The task's position changes in the admin list, and the same new order shows on the guest's `/tasks` page.

- [ ] Pass/fail

### C6. Photo takedown hides a photo and recomputes badges

Steps: Find a guest sitting exactly at a badge threshold (e.g. exactly 5 completed tasks, holding BLOOM). In `/admin/photos`, take down one of their photos.

Expected: The photo disappears from `/gallery` and from the guest's own home page immediately. Because their completed count just dropped below 5, the BLOOM badge is revoked — check the guest's profile or home page to confirm it no longer shows.

- [ ] Pass/fail

### C7. Restoring a photo brings the badge back

Steps: On `/admin/photos`, use the restore control on the same photo you took down in C6 (this calls the same `takedown`/`restore` pair of admin actions, just in reverse).

Expected: The photo reappears in `/gallery` and on the guest's home page, and the BLOOM badge is re-granted once their completed count reaches 5 again.

- [ ] Pass/fail

### C8. Guest management: rename and delete

Steps: In `/admin/guests`, rename one of the guests who signed up during this walkthrough, then delete a guest.

Expected: Each action shows a confirmation message and updates the guest table immediately. Guests are no longer created from this page — they join themselves through `/join` — deleting a guest removes them and their photos from the system (their photos also disappear from `/gallery`).

- [ ] Pass/fail

### C9. The entry poster renders a printable page

Steps: Go to `/admin/poster`.

Expected: A single page with one scannable QR code pointing at the shared `/join` link, spelled out underneath. The page should look ready to print — no broken image.

- [ ] Pass/fail

### C10. Hide and restore a comment, moderated inline on the photo

Steps: If no comments exist yet, post one from a guest window first (see D9 below). In the admin window, go to `/admin/photos`, tap that photo's tile to open the inline feed view, and find the comment sitting under it (a thread of 2+ comments clamps to the 2 most recent with a "See all N comments" link that opens the full thread in a dialog). Click **Hide** next to the comment.

Expected: A "Comment hidden." confirmation message appears, and the comment stays visible to the host but struck through, with a **Restore** control in place of Hide. As a guest, reload `/feed` — the hidden comment no longer appears anywhere on its photo's card, including inside the full comment-thread dialog. There is no standalone Comments page anymore — `/admin/comments` now 404s. Back in the admin window, click **Restore** on the same comment.

Expected: A "Comment restored." message appears, and the comment reappears on `/feed` for guests.

- [ ] Pass/fail

### C11. The dashboard checklist tracks what still needs the host's attention

Steps: In the admin window, go to `/admin` (the dashboard).

Expected: A stat grid up top shows counts for Guests, Live tasks, and Open bugs, plus a nudge reading "N things need you" (turning urgent-styled if any item is urgent). Below it, "Your checklist" lists rows — some are plain links (e.g. into Guests or Tasks when something there needs a look), some are tappable checkboxes for manual, off-app reminders like "Place-cards printed and on the tables."

Steps (continued): Tap a manual checkbox row (e.g. "Slideshow up on the venue screen").

Expected: A "Checklist updated." confirmation appears and the row now shows checked. Tap it again to uncheck it — it toggles back.

- [ ] Pass/fail

### C12. Configuration sets the event timezone and dates, and every date-aware feature follows it

Steps: In the admin window, go to `/admin/config`. Change the event timezone and the wedding start/end dates, then Save.

Expected: A confirmation message appears and the page reloads showing your new values selected/filled in. Any date-aware guest feature (a one-day-only challenge's unlock day, the dashboard checklist) now reasons from this timezone/date range rather than server UTC.

- [ ] Pass/fail

### C13. Rank a task's photos and release its badge and points

Steps: Make sure at least one guest has submitted a photo to some task. In the admin window, go to `/admin/photos?view=task`, open that task's group, and tap "Rank & award this task's photos" (or its rank link) to reach `/admin/tasks/<id>/rank`. Pick between 1 and 5 of the task's photos and place them in order (drag to reorder), then hit Release.

Expected: A confirmation message names how many winners the badge released to (e.g. "Badge released to 3 winners."). The 1st-place photo pays 5 points, 2nd pays 4, and so on down to 1 point for 5th — a host can award as few as one winner (5 points, one badge) or as many as five; it is never forced to a full five. Go check the winning guest(s)' public profile (`/u/<id>`) and the photo itself on `/gallery` or `/feed`.

Expected: Each winner's profile shows the task's badge. The winning photo(s) wear a small medal mark on their tile — gold for 1st place, plain for 2nd-5th.

- [ ] Pass/fail

### C14. Recover a locked-out guest's contact or PIN on the spot

Steps: In the admin window, go to `/admin/guests` and find a guest's card. Read their "Re-entry code" line, then use the Contact/Re-entry code fields on that same card to change their PIN, and Update.

Expected: A "Guest contact/PIN updated." confirmation appears, and the card's "Re-entry code" line now shows the new value — a host can read a guest's PIN back to them, or fix a mistyped contact, on the spot at the reception with no reset flow. Confirm the guest can now sign in at `/login` with the new PIN.

- [ ] Pass/fail

### C15. Create a custom badge

Steps: In `/admin/guests`, open the "Create a custom badge" section near the bottom of the page. Fill in a name (e.g. "Best Dressed"), an emoji for its art (e.g. 👔), and an optional description, then Create badge.

Expected: The new badge now appears in the per-guest badge-award dropdown on every guest card, ready to award. Award it to a guest (dropdown + Go) and confirm it shows on their public profile (`/u/<id>`).

- [ ] Pass/fail

### C16. Favorite a photo from the admin wall

Steps: In the admin window, go to `/admin/photos` and tap the heart on any photo tile.

Expected: The page reloads with an "Added to favorites." confirmation and the heart now shows filled in. Switch to the Favorites chip/view.

Expected: That photo now appears in the Favorites wall. Tap its heart again to remove it — it disappears from Favorites and the heart un-fills.

- [ ] Pass/fail

### C17. Bug queue: open, tracked, closed

Steps: As a guest, go to `/bug-report`, describe a made-up issue, and submit it. In the admin window, go to `/admin/bugs`.

Expected: The report appears at the top of the list (open reports sort first) with its guest's name and the page they reported from. Use its "Open issue" link/action.

Expected: The report moves to "tracked" state — it leaves the open queue without you having to come back and close it separately. Now close it.

Expected: The report moves to "closed" state. There is no "reopen" control — closing is one-way by design.

- [ ] Pass/fail

---

## Goal D — One shared record, kept

A hundred phones pool into one gallery, with a favorites view and a keepsake export at the end.

### D1. Gallery — recent view

Steps: As a signed-in guest, go to `/gallery` (default view).

Expected: A grid of photo thumbnails, newest first, with no taken-down photos mixed in.

- [ ] Pass/fail

### D2. Gallery — grouped by task

Steps: Go to `/gallery?view=task`.

Expected: Photos are grouped under their task titles, newest first within each group.

- [ ] Pass/fail

### D3. Gallery — grouped by guest (user)

Steps: Go to `/gallery?view=user`.

Expected: Photos are grouped under each guest's name, newest first within each group. Each group shows **at most 6** preview tiles, even for a guest who has submitted more than 6 photos.

Steps (continued): In the admin window, go to `/admin/guests` and pin a guest using the **pinned** checkbox (this is meant for the couple's own "our section"). Reload `/gallery?view=user` as a guest.

Expected: The pinned guest's section now leads — it appears first in the grouped list, ahead of every other guest's section, regardless of who posted most recently.

- [ ] Pass/fail

### D4. Gallery search

Steps: Go to `/gallery?view=task&q=<some task keyword>` using a word from one of the seeded task titles.

Expected: Only matching results show; the search box reflects what you typed.

- [ ] Pass/fail

### D5. Feed — full-screen scroll

Steps: Go to `/feed`.

Expected: Every visible photo appears in one continuous scroll, newest first, with no taken-down photos.

- [ ] Pass/fail

### D6. Photo detail with prev/next navigation

Steps: From `/gallery`, click into any photo to open `/p/<id>`. Use the next/previous links.

Expected: The full-resolution photo displays with its caption, task title, and uploader link. Next/previous move through the gallery in the same newest-first order without skipping or looping incorrectly.

- [ ] Pass/fail

### D7. Public profile page

Steps: From any photo detail page or the leaderboard, click through to a guest's profile at `/u/<id>`.

Expected: Shows their name, avatar, badges, points, and their own photo submissions (taken-down photos excluded).

- [ ] Pass/fail

### D8. Give and remove a like on a feed photo

Steps: As a signed-in guest, go to `/feed`. On any photo, tap the heart button.

Expected: The heart fills in and the like count next to it goes up by one. Tap the same heart again.

Expected: The heart un-fills and the count drops back down by one — liking a photo you've already liked removes your like rather than adding a second one.

- [ ] Pass/fail

### D9. Add a comment on a feed photo; confirm no reply thread or notification; confirm hidden content stays hidden

Steps: On `/feed`, open a photo's comment dialog (tap the comment bubble). Type a short message into the box (placeholder text reads "Add a comment") and tap **Post**.

Expected: Your comment appears in the thread immediately, and the comment count next to the bubble goes up by one. Look for any way to reply to a specific comment, and for any notification or alert sent to another guest about the new comment — there should be **none**; this app has no reply threads and no comment notifications.

Steps (continued): In the admin window, hide the comment you just posted (see C10 above). Sign in as a different guest: open a fresh private/incognito window, go to `/join`, and sign up with a different name/contact/PIN than your first guest. Then reload `/feed` in that window.

Expected: The hidden comment does not appear anywhere on that photo's card or inside its comment dialog to the second guest.

- [ ] Pass/fail

### D10. Admin export produces a ZIP and a spreadsheet

Steps: In the admin window, go to `/admin/export`. Let the download finish, then open the downloaded ZIP file.

Expected: The browser downloads a `.zip` file. Inside it: a `summary.xlsx` spreadsheet at the top level with four sheets — Guests, Submissions, Badges, and Comments — and one folder per guest containing their submitted photos. Any guest who has set an avatar has an `avatar.<ext>` file (e.g. `avatar.jpg`) inside their folder too.

- [ ] Pass/fail

### D11. Taken-down and hidden content is excluded from guest views but included, and labelled, in the export

Steps: Take down a photo (as in C6) and hide a comment (as in C10) if you haven't already. Confirm the photo is gone from `/gallery` and the comment is gone from `/feed`. Then run `/admin/export` again and check the ZIP.

Expected: Neither the taken-down photo nor the hidden comment appears anywhere in the live `/gallery` or `/feed`. But in the export: the photo's file IS present inside its guest folder, and its row in `summary.xlsx`'s Submissions sheet reads "Taken Down: YES"; the comment's row on the Comments sheet reads "Hidden: YES". This confirms the rule that taken-down/hidden content is excluded from what guests see but never lost — it's included in the export, just labelled.

- [ ] Pass/fail

### D12. A guest can edit their own caption, take down their own photo, and delete their own comment

Steps: As a guest, go to `/feed` and find one of your own photos. Tap its ⋯ menu (only present on your own photos) and choose "Edit caption." Change the text and Save.

Expected: A caption dialog opens pre-filled with the current caption; after saving, the new caption shows on the card immediately.

Steps (continued): Open that same ⋯ menu again and choose "Delete."

Expected: A confirm prompt reads "Take this photo down? It leaves the feed and gallery right away." Confirm it — the photo disappears from `/feed` and `/gallery` immediately (this is a self-service takedown, distinct from the admin takedown in C6/C7 above).

Steps (continued): On a different photo (not your own), post a comment (see D9 above), then find that comment's own ⋯ menu (present only on your OWN comments, on any photo) and choose "Delete."

Expected: A confirm prompt reads "Delete this comment? This can't be undone." Confirm it — the comment disappears from that photo's thread immediately.

- [ ] Pass/fail

### D13. End-of-night slideshow: Auto and Directed

Steps: With several liked/ranked photos in the event, go to `/slideshow` (Auto mode, the default).

Expected: A full-screen, chrome-free display opens with a "Crowd favorite" section (the site's top-5 most-liked photos, if any are liked — see B13 above) then plays a title card per task (its fullest tasks first, up to 5 sections), each followed by that task's photos ranked by points then likes, worst-first — the section's best photo plays last and holds on screen longer, tagged "Crowd favorite" or "Top shot" (2nd-5th place photos show a plain "2nd place"-style tag instead). Move the mouse — a chrome layer with prev/next controls fades in; leave it idle and the chrome fades back out.

Steps (continued): Go to `/slideshow?mode=directed`.

Expected: The same reel appears, but it does NOT auto-advance — you must tap the left/right zones, use the on-screen arrows, or press arrow keys to move between slides, at your own pace (this is the mode a host drives live from a laptop, vs. Auto left running unattended on the venue screen).

- [ ] Pass/fail

### D14. Sharing a memory batch, and its once-per-day bonus

Steps: As a guest, go to `/tasks` and tap the last row, "Share a memory" (its price tag reads "+1 pt" if you haven't shared one yet today). On the form, attach several photos at once (up to 10) and an optional caption, then submit.

Expected: A "Shared! They're in the gallery." confirmation appears and every photo in the batch shows up on `/gallery`. Your points on `/` went up by 1 for the day's first memory, plus each photo's own admin bonus if any (a memory earns no automatic per-photo base the way a task photo does). Go back to `/tasks`.

Expected: The "Share a memory" row's price tag is now gone entirely (not "+0", not "Complete") — the description still reads "First memory of the day earns +1," but the tag stops advertising a point already claimed today. Share a second memory the same day.

Expected: It uploads and appears in the gallery same as before, but no further points are banked for it — only the first memory of each event-local day pays the +1.

- [ ] Pass/fail

---

## Cross-cutting

Checks that don't belong to a single goal but must hold everywhere.

### X1. A taken-down photo's direct file link 404s

Steps: Note the photo/thumbnail URL of a submission (visible in your browser's dev tools, or from the `/uploads/` path shown on its `/p/:id` page) before taking it down. Take the photo down via `/admin/photos`. Then paste that same `/uploads/...` URL directly into the browser address bar.

Expected: The browser shows a `404` — the file is not directly reachable once taken down, even though you have the exact URL.

- [ ] Pass/fail

### X2. Wrong file type or oversized upload shows a clear error

Steps: On any task's upload form, try to upload a non-image file (e.g. a `.txt` or `.pdf`). Separately, if you have a very large image file (over 15 MB), try uploading that too.

Expected: Both attempts are rejected with a clear, human-readable error message (not a crash, not a blank page, not a raw stack trace). The task remains not-completed.

- [ ] Pass/fail

### X2b. Real-phone uploads: HEIC is accepted and converted (issue #281, supersedes #188)

Steps: From a **real iPhone**, upload a camera-roll photo (taken with the phone's default camera settings — iPhones produce HEIC by default) to a task twice — once picking from the Photos app, once picking the same photo via the Files app. Then repeat from a **real Android phone** (Samsung if available) using its default picker.

Expected: Every attempt succeeds — the photo uploads, its thumbnail appears, and the full photo opens normally from the gallery/feed — whether the picker already transcoded the file to JPEG itself or handed over a real HEIC/HEIF file for the server to convert. **Never** a rejection, and never the dead-end "could not save that photo. Please try again."

- [ ] Pass/fail

### X3. Admin login locks out after repeated failed attempts

Steps: On `/admin/login`, deliberately enter the wrong password several times in a row (10+).

Expected: After enough failed attempts, further attempts are blocked for a cooldown period with a "too many failed attempts" message, even if you then enter the correct password. Wait out the lockout (or restart the server to reset it) before continuing testing.

- [ ] Pass/fail

### X4. 404 and error pages render correctly

Steps: As a signed-in guest, visit a nonsense URL like `/this-page-does-not-exist`. Also visit `/tasks/999999` (a task id that doesn't exist).

Expected: Both show a friendly "not found" page — not a raw error, not a blank screen, not the default Express error page.

- [ ] Pass/fail

---

## Wrap-up

- [ ] Every box above is checked.
- [ ] Any failed box has a written note describing what actually happened, filed as a defect before the event.
- [ ] The `data-demo` database and admin password used for this walkthrough are discarded — they are test data only and are never used for the live event data.

---

## Deprecated

Steps below exercise the previous scoring/badge model, or a screen the redesign plan intends to retire. #684 (photo moderation) and #661 (rank-and-award consolidation) have both already shipped — the standalone Comments page and the old per-photo give-a-badge picker they retired are gone; visiting either now 404s, not something to still expect working. #683 (the guests-admin redesign) has NOT shipped yet: the guest-level bonus-points input, the badge-award dropdown, and the "Create a custom badge" form that B5 and C5 below exercise are LIVE routes today on `/admin/guests`, not dead ones — they only become obsolete once #683 lands. The project is actively building away from all of it; do not treat any of these steps as the plan going forward. The settled replacement is `docs/game-design-points-badges.md`, with its data flow recorded in that document's "Data flow and architecture" section.

### B1 (deprecated). Submitting a photo completes a task and awards a point

Steps: As a signed-in guest, go to `/tasks`, pick any task not yet marked done, open it, and upload a photo.

Expected: A success message appears ("Task complete! +1 point."), the task now shows as done on `/tasks`, and the guest's points total on their home page (`/`) went up by 1.

- [ ] Pass/fail

### B5 (deprecated). Special badges display correctly on a guest's profile

Steps: In the admin window, go to `/admin/guests`, pick a guest, and award a special badge (e.g. EARLYBIRD). Then view that guest's public profile at `/u/<their-id>`.

Expected: The badge appears on their profile immediately, alongside any auto badges (BLOOM/BOUQUET/GARDEN) they've earned.

- [ ] Pass/fail

### C4 (deprecated). Award and deduct bonus points

Steps: In `/admin/guests`, award a guest +5 bonus points, then check their total on `/leaderboard` or their own home page. Then deduct points (a negative amount) from the same guest.

Expected: Points increase by exactly the awarded amount, then decrease by the deducted amount. The guest's rank on `/leaderboard` updates accordingly.

This is also the fastest way to force a podium tie for testing B9 above, until the ranked-award/crowd-favorite mechanics replace it.

- [ ] Pass/fail

### C5 (deprecated). Award and remove a special badge

Steps: In `/admin/guests`, award a special badge to a guest, confirm it shows on their profile (`/u/<id>`), then remove it from the admin panel.

Expected: The badge appears after awarding and disappears after removal — both changes visible on the guest's public profile without needing a page other than a refresh.

- [ ] Pass/fail
