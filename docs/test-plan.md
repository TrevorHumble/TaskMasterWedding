# Manual Walkthrough Test Plan

A step-by-step checklist for a human — not a developer — to confirm the app works end to end before the wedding. Run it against a seeded ~100-guest event, not the real event data, so nothing here touches a real guest.

Each scenario below is written as: what to do, what you should see, and a checkbox to mark the result. Work through every box. If a box fails, write down what you saw next to it (or in a separate notes doc) and file it as a defect — do not just re-check it and move on.

## Setup

Do this once, before you start testing.

1. **Seed the isolated event database.** Do not run this against your real event data — it creates its own separate database. From the project root, in PowerShell:

   ```powershell
   $env:DATA_DIR = "data-demo"
   node scripts/seed-event.js --guests 100
   ```

   This creates ~100 guests, a set of tasks, sample photo submissions, and awarded badges, all inside `data-demo` (a folder next to the real `data` folder — it never touches real event data). Guest sign-in tokens are `event-guest-token-0` through `event-guest-token-99`. Guest `event-guest-token-0` is the top scorer on the leaderboard — useful for checking rank #1 quickly.

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
   - **Guest window:** go to `http://localhost:3000/j/event-guest-token-5` (any number 0–99 works; use a different number than token-0 if you also want to check a non-top-scorer). This signs you in as that guest.
   - **Admin window:** go to `http://localhost:3000/admin/login` and sign in with the password you set in step 2.

- [ ] Setup complete: server running, guest window signed in, admin window signed in.

---

## Goal A — Easy in, solid throughout

Any guest can play in seconds, and nothing about the tech gets in the way.

### A1. QR sign-in works with a valid link

Steps: In a fresh private window, go to `/j/event-guest-token-12`.

Expected: You land on the guest home page (or the onboarding form, if that guest hasn't onboarded yet) with no error, no login prompt, no password asked.

- [ ] Pass/fail

### A2. First-run onboarding collects a name

Steps: If step A1 sent you to `/onboard`, fill in a name and submit. Skip the avatar and social fields.

Expected: You're redirected to the guest home page (`/`), and the name you entered now appears there. Revisiting `/onboard` afterward does not show the form again — it goes straight to `/`.

- [ ] Pass/fail

### A3. Invalid or unknown token does not sign anyone in

Steps: In a fresh private window, go to `/j/not-a-real-token-xyz`.

Expected: A "Link Not Recognized" message page, not a crash or a blank page. No sign-in cookie is set — confirm by then visiting `/tasks` in that same window; it should show the "Private Link Needed" message, not the tasks list.

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

Expected: Guests are ordered highest points first. Two guests with the same point total show the same rank number (e.g. both show "3"), and the next distinct guest below them skips the tied ranks (e.g. jumps to "5", not "4"). `event-guest-token-0` should be at or near rank 1.

- [ ] Pass/fail

### B5. Special badges display correctly on a guest's profile

Steps: In the admin window, go to `/admin/guests`, pick a guest, and award a special badge (e.g. SHUTTERBUG). Then view that guest's public profile at `/u/<their-id>`.

Expected: The badge appears on their profile immediately, alongside any auto badges (BLOOM/BOUQUET/GARDEN) they've earned.

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

### C8. Guest management: create, bulk create, rename, delete

Steps: In `/admin/guests`, create one guest by hand, then use the bulk-create form to add several guests at once, rename one guest, and delete a guest you just created.

Expected: Each action shows a confirmation message and updates the guest table immediately. The bulk-created guests each get their own unique sign-in link. Deleting a guest removes them and their photos from the system (their photos also disappear from `/gallery`).

- [ ] Pass/fail

### C9. QR sheet renders a printable page

Steps: Go to `/admin/qrsheet`.

Expected: A page listing every guest's name (or a placeholder like "Guest #N" if unnamed) alongside a scannable QR code image for their personal link. The page should look ready to print — no broken images, no missing names.

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

Expected: Photos are grouped under each guest's name, newest first within each group.

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

### D8. Admin export produces a ZIP and a spreadsheet

Steps: In the admin window, go to `/admin/export`. Let the download finish, then open the downloaded ZIP file.

Expected: The browser downloads a `.zip` file. Inside it: a `summary.xlsx` spreadsheet at the top level, and one folder per guest containing their submitted photos.

- [ ] Pass/fail

### D9. Taken-down photos are excluded from the gallery but included in the export

Steps: Take down a photo (as in C6) if you haven't already. Confirm it is gone from `/gallery`. Then run `/admin/export` again and check the ZIP.

Expected: The taken-down photo does not appear anywhere in `/gallery`, but the same photo's file IS present inside the exported guest folder in the ZIP, and its row in `summary.xlsx`'s Submissions sheet is marked "Taken Down: YES". This confirms the rule that a taken-down photo is excluded from the gallery but included in the export — nothing is ever permanently lost by a takedown.

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

### X2b. Real-phone uploads: HEIC is either transcoded or rejected with instructions (issue #188)

Steps: From a **real iPhone**, upload a camera-roll photo to a task twice — once picking from the Photos app, once picking the same photo via the Files app. Then repeat from a **real Android phone** (Samsung if available) using its default picker. Use photos taken with the phone's default camera settings (iPhones produce HEIC by default).

Expected: Every attempt ends in one of exactly two outcomes — the photo uploads and its thumbnail appears (the picker transcoded it to JPEG), or it is rejected with the actionable message telling you to take a screenshot or switch the camera to "Most Compatible". **Never** the dead-end "could not save that photo. Please try again."

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
- [ ] The `data-demo` database and admin password used for this walkthrough are discarded — they are test data only and are never used for the real wedding event.
