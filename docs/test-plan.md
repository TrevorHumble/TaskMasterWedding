# Manual Walkthrough Test Plan

A step-by-step checklist for a human — not a developer — to confirm the app works end to end, run before the wedding and after any significant deploy. Run it against a seeded ~100-guest event, not the real event data, so nothing here touches a real guest.

Each scenario below is written as: what to do, what you should see, and a checkbox to mark the result. Work through every box. If a box fails, write down what you saw next to it (or in a separate notes doc) and file it as a defect — do not just re-check it and move on.

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

Expected: You're redirected straight to the guest home page (`/`), with the name you entered now shown there — there is no separate onboarding form afterward.

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

---

## Goal B — A game worth playing

Guests get instant rewards, see badges and standings, and stay active in the celebration rather than just watching a screen.

### B1. Submitting a photo completes a task and awards a point

Steps: As a signed-in guest, go to `/tasks`, pick any task not yet marked done, open it, and upload a photo.

Expected: A success message appears ("Task complete! +1 point."), the task now shows as done on `/tasks`, and the guest's points total on their home page (`/`) went up by 1.

- [ ] Pass/fail

### B2. Auto badges unlock at the right thresholds

Steps: As a guest with fewer than 5 completed tasks, complete tasks one at a time (or use a guest token already near a threshold from the seed data) until you cross 5 completed tasks, watching the home page badges section after each submission.

Expected: The **BLOOM** badge appears exactly when the 5th task is completed — not before. If you continue to 10 and 15, **BOUQUET** unlocks at 10 and **GARDEN** unlocks at 15. Badges never appear early.

- [ ] Pass/fail

### B3. Replacing a submission keeps the task at one point, doesn't double-count

Steps: Go to a task you've already completed, and upload a new photo to replace the existing one.

Expected: A "Photo replaced!" message, the new photo shows on the task page, and the guest's total points do **not** increase (still counts as one completed task, not two).

- [ ] Pass/fail

### B4. Leaderboard shows correct order, with ties handled sensibly

Steps: Go to `/leaderboard` in either browser window (no sign-in required to view it, but the session gate still applies per Cross-cutting note below).

Expected: Guests are ordered highest points first. Two guests with the same point total show the same rank number (e.g. both show "3"), and the next distinct guest below them skips the tied ranks (e.g. jumps to "5", not "4"). "Ava Martinez" (the engineered top scorer — see Setup step 1) should be at or near rank 1.

- [ ] Pass/fail

### B5. Special badges display correctly on a guest's profile

Steps: In the admin window, go to `/admin/guests`, pick a guest, and award a special badge (e.g. SHUTTERBUG). Then view that guest's public profile at `/u/<their-id>`.

Expected: The badge appears on their profile immediately, alongside any auto badges (BLOOM/BOUQUET/GARDEN) they've earned.

- [ ] Pass/fail

### B6. Upload button shows the right label at each stage

Steps: On a task you haven't completed yet, open the upload form and look at the submit button before choosing a photo.

Expected: The button reads "Upload & complete". Choose a photo and tap the button.

Expected: While the upload is in progress, the button's label changes to "Uploading…". Once it finishes, you land back on the task page as normal (per B1).

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

Steps: Go to `/leaderboard`. Look at the top-3 podium display (not the full standings list below it) for a spot where two or more guests are tied — the seed data should produce at least one tie near the top; if not, award bonus points in the admin window (C4) until two guests share a podium spot.

Expected: A tied podium spot shows a stack of the tied guests' avatars — up to three, with a "+N" badge if more than three guests are tied — and a subline reading something like "2nd place · 12 pts each" — the literal phrase "pts each" appears under a tied group, unlike a single winner's spot, which just shows their name.

- [ ] Pass/fail

---

## Goal C — The hosts run the show

The couple and planners can steer tasks, set prizes and points, and moderate content — choreographing the weekend as it happens.

### C1. Create, edit, delete a task

Steps: In the admin window, go to `/admin/tasks`. Create a new task with a title and description. Edit its title. Then delete it.

Expected: Each action shows a confirmation message and the tasks list updates immediately — the new task appears after creating, the new title shows after editing, and the task is gone after deleting.

- [ ] Pass/fail

### C2. Activate/deactivate a task hides it from guests

Steps: In `/admin/tasks`, toggle a task to inactive. Then, as a guest, visit `/tasks`.

Expected: The deactivated task no longer appears in the guest's task list. Toggling it back to active makes it reappear.

- [ ] Pass/fail

### C3. Reorder tasks

Steps: In `/admin/tasks`, move a task up or down in the list using the reorder controls.

Expected: The task's position changes in the admin list, and the same new order shows on the guest's `/tasks` page.

- [ ] Pass/fail

### C4. Award and deduct bonus points

Steps: In `/admin/guests`, award a guest +5 bonus points, then check their total on `/leaderboard` or their own home page. Then deduct points (a negative amount) from the same guest.

Expected: Points increase by exactly the awarded amount, then decrease by the deducted amount. The guest's rank on `/leaderboard` updates accordingly.

- [ ] Pass/fail

### C5. Award and remove a special badge

Steps: In `/admin/guests`, award a special badge to a guest, confirm it shows on their profile (`/u/<id>`), then remove it from the admin panel.

Expected: The badge appears after awarding and disappears after removal — both changes visible on the guest's public profile without needing a page other than a refresh.

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

### C10. Hide and restore a comment

Steps: In the admin window, go to `/admin/comments`. If no comments exist yet, post one from a guest window first (see D9 below). Find a comment in the list and click **Hide**.

Expected: A "Comment hidden." confirmation message appears, and the comment is marked HIDDEN in the admin list. As a guest, reload `/feed` — the hidden comment no longer appears anywhere on its photo's card, including inside the full comment-thread dialog. Then click **Restore** on the same comment.

Expected: A "Comment restored." message appears, and the comment reappears on `/feed` for guests.

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
