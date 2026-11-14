# GRC Resource Recovery Tournament: launch guide

Scores go in on a phone, iPad or PC, and every screen updates within about a second: the projector, other phones, and anyone watching the standings.

| Page | Who uses it | What it does |
|---|---|---|
| `control.html` | Staff, on **phone, iPad or PC** | Sign in, enter and correct scores, register teams, run the synced 3‑minute clock, pick the match the audience sees, print the schedule, back up, restore, reset |
| `display.html` | Projector and spectators | Live match, robot colours, synced clock, standings with rank-change animations. Also works as a public leaderboard on phones |
| `schedule.html` | Everyone (phones, second screen) | All 15 matches with robot colours: what's playing now, up next, and final scores. "Find your team" highlights a team's 6 matches and shows when they play next |
| `index.html` | Everyone | Start page linking to the two pages above |

---

## How it fits together

| Part | Where it runs | Status |
|---|---|---|
| **Backend**: database, staff login, live updates | **Supabase**, project `qponplxxgemmiijcboza` | ✅ Done and tested |
| **Website**: the pages in this folder | A free web host such as **GitHub Pages** | ⬜ Step 1 below |
| **Keep-alive**: stops Supabase pausing | **GitHub Actions**, in the same GitHub repository | ⬜ Step 2 below |

> **Why the pages aren't hosted on Supabase:** Supabase stores the data and logins, but it doesn't serve websites. If you upload an HTML file to Supabase Storage, it opens as plain text instead of a working page. The pages need a separate web host, and GitHub Pages is free and fine for this. The pages already know how to reach your Supabase project, because the address and public key are in `assets/config.js`.

---

## Step 1: Put the website online with GitHub Pages (about 10 minutes)

1. Go to **github.com** and sign up, or sign in. The free account is enough.
2. Click **+** (top right), then **New repository**.
   - **Repository name:** `grc-tournament`
   - Choose **Public**. Free GitHub Pages needs a public repository. That's fine: the only key in these files is the public one, and your data is protected by the staff login.
   - Click **Create repository**.
3. On the new repository page, click the **uploading an existing file** link.
4. Open this folder in File Explorer, select **everything inside it** (Ctrl+A) and drag it onto the GitHub page. Drag the contents, not the folder itself. That means `.github`, `assets`, `supabase`, `control.html`, `display.html`, `schedule.html`, `index.html`, `manifest.webmanifest` and `README.md`.
5. Scroll down and click **Commit changes**.
6. Check that the `.github` folder appears in the file list. If it's missing, add it by hand:
   - Click **Add file**, then **Create new file**.
   - In the name box type `.github/workflows/keep-alive.yml`. The slashes create the folders.
   - Open `.github/workflows/keep-alive.yml` from this folder in Notepad, copy everything, paste it into GitHub, and click **Commit changes**.
7. Go to **Settings**, then **Pages** in the left menu.
   - Under **Build and deployment** set **Source** to **Deploy from a branch**.
   - Set **Branch** to **main** and **/ (root)**, then click **Save**.
8. Wait 1–2 minutes and refresh. The address appears at the top of the Pages screen:
   `https://YOUR-GITHUB-USERNAME.github.io/grc-tournament/`

Your links will be:
- **Staff (phones, iPads, PC):** `https://YOUR-GITHUB-USERNAME.github.io/grc-tournament/control.html`
- **Projector or audience:** `https://YOUR-GITHUB-USERNAME.github.io/grc-tournament/display.html`
- **Match schedule (share with teams and parents):** `https://YOUR-GITHUB-USERNAME.github.io/grc-tournament/schedule.html`
  - Add `?team=3` to the end of the link to open it with Team 3's matches already highlighted. That's handy for sending each team its own link.

**Changing something later**, such as the event date or venue in `assets/config.js`: open the file on GitHub, click the ✏️ pencil, edit it, and click **Commit changes**. The site updates in about a minute.

*Quick alternative for hosting only:* drag this folder onto **app.netlify.com/drop** and create a free account to keep the site. You still need Step 2 on GitHub for the keep-alive.

---

## Step 2: Keep Supabase awake (5 minutes)

Free Supabase projects **pause after 7 days with no activity**. The file `.github/workflows/keep-alive.yml` pings your database every day so that never happens.

1. In your GitHub repository go to **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**. Add two secrets:

   | Name | Secret |
   |---|---|
   | `SUPABASE_URL` | `https://qponplxxgemmiijcboza.supabase.co` |
   | `SUPABASE_ANON_KEY` | your **publishable** key (`sb_publishable_…`), the same one in `assets/config.js` |

   ⚠️ Never use the `sb_secret_…` key here or anywhere in these files.
2. Click the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
3. Click **Keep Supabase awake**, then **Run workflow**, then **Run workflow** again.
4. After about 20 seconds it should turn green ✅, and the log ends with "Supabase is awake ✔". From now on it runs on its own every day.
5. *(Optional check)* In Supabase **SQL Editor**, run `select * from public.heartbeat;` to see the last ping time.

Good to know:
- GitHub turns off scheduled workflows if a repository has no commits for 60 days. If that happens, open **Actions** and click **Enable workflow**.
- If you ever want a guarantee that the project never pauses, the Supabase **Pro** plan doesn't pause.
- If the project does pause, open the Supabase dashboard and click **Restore project**. No data is lost.

---

## Step 3: Set up the devices

**Phones and iPads (staff)**
1. Open the **control.html** link and sign in with the shared staff login.
2. Add it to the home screen so it opens full-screen like an app, with the GRC logo:
   - **iPhone or iPad (Safari):** tap Share, then **Add to Home Screen**.
   - **Android (Chrome):** tap ⋮, then **Add to Home screen**.
3. Signing out on one device doesn't sign out the others.

**Projector laptop**
1. Open the **display.html** link.
2. Press **F**, double-click, or click **⛶ Fullscreen**. The mouse cursor hides after 3 seconds.
3. The screen is kept from going to sleep while the page is open.
4. **Match sounds:** click anywhere on the page once. Browsers don't allow sound until someone clicks, and the page shows a "🔊 Tap anywhere to turn on match sounds" prompt until you do. Then turn the speakers up. Clicking **🔊 Sound on/off** (bottom right) plays a test sound when you switch it on.

**Match sounds** play on every device showing the audience display: the projector, plus any phones and tablets watching `display.html`. The staff and schedule pages stay silent.
- When staff press **▶ Start**, including after Pause, the start sound plays (`assets/sounds/match-start.mp3`).
- When the clock reaches **0:30**, the Ole trumpet plays (`assets/sounds/30-seconds-ole-trumpet.mp3`).
- When the clock hits **0:00**, the buzzer horn plays (`assets/sounds/time-up-horn.mp3`).
- Every screen times the sounds from the shared server clock, so they play together. The start sound plays half a second after Start is pressed, on every screen at once. The trumpet and horn play at the exact moment the clock shows 0:30 and 0:00.
- A screen that's reloaded mid-match, or that hears about Start more than 5 seconds late, stays quiet until the next Start. Resuming below 0:30 won't replay the trumpet. If staff press Pause or Reset before 0:00, the horn doesn't play.
- To silence one screen, click **🔊 Sound on** so it reads **🔇 Sound off**. The screen remembers this. You can also open `display.html?sound=off`, and `?sound=on` turns it back on.
- To change a sound, replace the file in `assets/sounds/`, keeping the same name.

**Second screen or TV (optional)**
Open **schedule.html** the same way. On a landscape screen, all 15 matches fit on one screen. It updates live as matches are played and scored.

**Teams and parents**
Share the **schedule.html** link, or print a QR code of it for the venue. On a phone, people pick their team under **Find your team**, and the page remembers the choice on that phone.

---

## On the day: running a match

1. **Score** tab: the top card shows which match is **on the audience display**. Use **‹ ›** to change it.
2. Tap **▶ Start**. The 3‑minute clock runs on every screen. **Pause** and **Reset** work from any device.
3. **During the match**, tap **+ / −** on a robot as it scores. Each tap shows up on the projector and the schedule page within about a second, marked **Live scoring**. Two phones can score different robots at the same time.
4. **When time is up**, check the four numbers and tap **Save scores**. You can also type numbers and then tap Save. Saving makes the result **final**: the standings and awards update and the "Match winner" celebration plays. A half-played match never counts in the standings.
5. Tap **›** to put the next match on screen. The button pulses once the current match has been scored.

> **One-time setup for live + / −:** in Supabase open **SQL Editor → New query**, paste all of `supabase/live_scores.sql` and click **Run**. It's safe to run again. Until then, + / − only change the phone you're using, until you tap Save.

**Fixing a mistake.** Tap the match number, change the points (with + / − or by typing), and tap **Update scores**. The screens show the changed numbers as live until you tap Update, and the standings keep the old final result until then. Every saved change is logged with its time and its before and after scores. To see the log, run this in the Supabase SQL Editor:
```sql
select * from public.score_history order by changed_at desc;
```

### Extra matches (semi-finals, final…): judges choose who plays who

Judges can add matches after the 15 qualifying matches and pick the four teams that play.

> **One-time setup:** in Supabase open **SQL Editor → New query**, paste all of `supabase/extra_matches.sql` and click **Run**. It's safe to run again, and it works whether or not the other optional files have been run. Until then, the Match setup panel shows a reminder.

1. Go to the **Matches** tab, then the **Match setup · judges** panel at the top.
2. Give the match a name, such as *Semi-final 1* or *Final*, or leave it blank to call it *Match 16*.
3. Choose a team for each robot colour: **Red, Blue, Green, Yellow**. A team that's already picked is greyed out in the other lists. **★ Fill with the top 4** puts the current 1st–4th from the standings onto Red, Blue, Green and Yellow.
4. Tap **＋ Add match**. It appears straight away on every screen: the match chips, the schedule page, and after match 15 on the display.
5. In the list under the form, each extra match has **✎ Score**, **◫ Show on display**, **Edit teams** and **Delete** buttons. You can also reach them with the **‹ ›** buttons and the match chips.

Good to know:
- Extra matches are scored exactly like qualifying matches, with + / −, Save scores and the clock and sounds. Their points **count in the standings and awards**, so a team's "Played" goes to 7 when it plays an extra match.
- Matches run in the order they were added. Add the semi-finals before the final.
- A match's teams can only change while it has **no scores**. Clear its scores first if you need to. You can rename it at any time.
- You can't delete the match that's on the audience display. Show another match first.
- The 15 qualifying matches can't be changed or deleted.
- **Reset** removes all extra matches. Backups include them, and **Restore** brings them back with their scores.

**Teams tab.** Register or rename teams, copy the share links, **download a backup** (do this after each session), **restore** a backup, or **reset** the tournament (you'll be asked to type RESET).

**Moving data over from the old admin page.** In the old `GRC_Resource_Recovery_Tournament_Admin.html` click **↓ Backup**. Then in the new **Teams** tab click **Restore from backup file**.

**Connection light** (top of every page):
- 🟢 **Live**: everything is normal.
- 🟠 **Live · polling**: instant updates are blocked (often venue Wi‑Fi), but changes still arrive every 5 seconds.
- 🔴 **Offline**: no internet. The page reconnects by itself when the connection returns.

---

## Live stream (YouTube webcam)

The stream plays inside the **audience display**, next to the live scores. The **schedule page** shows a red **Watch live** button. YouTube carries the video, so any number of people can watch for free.

**Once, before the event**
1. **Turn on live streaming.** Go to **studio.youtube.com**, then **Create → Go live**, and follow the prompts, including phone verification. YouTube can take **up to 24 hours** to approve a channel the first time.
2. **Update the database.** In Supabase, open **SQL Editor → New query**, paste all of `supabase/live_stream.sql` and click **Run**. It's safe to run again.

**On the day**
1. Plug the USB webcam into a laptop and point it at the arena from high up. Connect the laptop to the internet; you need about 3–5 Mbps upload. Keep a phone hotspot as a backup.
2. In **YouTube Studio**, click **Create → Go live → Webcam**.
   - **Visibility:** choose **Unlisted**, so only people with your website link can find it.
   - **Latency:** choose **Low latency**.
   - Click **Go live**.
3. Copy the stream's link: **Share → Copy link**.
4. In the staff app, go to **Teams → Live stream**, paste the link and tap **● Show stream on the website**. Every screen shows it within a second or two.
5. To take it down, tap **Hide stream**. The link is kept, so you can switch it back on.

Good to know:
- The video plays **muted** to start, because browsers only autoplay muted video. Viewers tap the speaker icon for sound.
- The video runs **5–15 seconds behind** real life. Scores on the site stay instant.
- **The projector in the room:** the people there can see the real arena, and delayed video can confuse them. On that laptop, open `display.html?video=off`, or tap **Hide video on this screen** under the video. That screen stays scores-only and remembers it. `display.html?video=on` brings the video back.
- If the stream stops and you start it again, YouTube gives it a **new link**. Paste the new one into **Live stream**.
- **Filming children:** check that the school and parents are happy with the stream.

---

## Managing staff access (Supabase dashboard)

| To do this | Go here |
|---|---|
| Change the shared password | **Authentication**, then **Users**. Click the user, then **Reset password**, or delete the user and create it again |
| Give another email access | Create the user (tick **Auto Confirm User**), then in **SQL Editor** run `insert into public.staff (email) values ('new@email.com') on conflict do nothing;` |
| Remove access | **SQL Editor**: `delete from public.staff where email = 'old@email.com';` |
| Stop strangers creating accounts | **Authentication**, then **Sign In / Providers**. Turn off **Allow new users to sign up** |
| Rotate a leaked secret key | **Project Settings**, then **API Keys**. The website doesn't use the secret key, so rotating it breaks nothing |

---

## Troubleshooting

| What you see | Fix |
|---|---|
| "The database is not set up yet" | Run `supabase/schema.sql` in the SQL Editor. It's safe to re-run and doesn't erase data |
| "Not on the staff list" after signing in | Add the email with the `insert into public.staff …` line above, then tap **check again** |
| "Wrong email or password" | Reset the password in **Authentication**, then **Users** |
| GitHub Pages shows 404 | Wait 2 minutes. Check that `index.html` is in the top level of the repository, not inside another folder |
| Light stays 🟠 **Live · polling** | Venue Wi‑Fi may block live connections. Updates still arrive every 5 seconds. A phone hotspot usually fixes it |
| Keep-alive run is red ❌ | Check the two secrets are spelled exactly `SUPABASE_URL` and `SUPABASE_ANON_KEY`. If the project already paused, click **Restore** in Supabase |
| Live stream panel says "One-time setup" | Run `supabase/live_stream.sql` in the SQL Editor, then reload the staff page |
| Score tab says "+ / − will update every screen live once…" | Run `supabase/live_scores.sql` in the SQL Editor, then reload the staff page |
| Match setup says "One-time setup" or "Extra matches need a one-time database update" | Run `supabase/extra_matches.sql` in the SQL Editor, then reload the staff page |
| "This match already has scores" when editing teams | Open that match on the Score tab, tap **Clear**, then change its teams |
| Screen still says **Live scoring** after the match | Someone tapped + / − but didn't save. Open that match and tap **Save scores** or **Update scores** |
| No start sound or trumpet | Click once on the display page (the 🔊 prompt must be gone), check **🔊 Sound on** is showing, and turn up the laptop and speaker volume. On iPhone and iPad, make sure the volume is up |
| Video box is black or says "Video unavailable" | Check the stream is actually live in YouTube Studio. If you restarted it, paste the new link. In the stream's settings, make sure **Allow embedding** is on |

---

## What's in this folder

```
index.html               start page
control.html             staff app (phone / iPad / PC)
display.html             audience board
schedule.html            public live match schedule
manifest.webmanifest     "Add to Home Screen" settings
assets/config.js         Supabase address + public key, and event details (date, venue…)
assets/app.js            shared data, live-update and sync logic
assets/style.css         shared styles
assets/logo*.png, icon*  GRC logo (plus a light version for dark backgrounds) and app icons
assets/sounds/           match-start.mp3 (on Start), 30-seconds-ole-trumpet.mp3 (at 0:30), time-up-horn.mp3 (at 0:00), played by display.html
supabase/schema.sql      database, security rules and functions (already run on your project)
supabase/field_release.sql   optional: "Release balls" button + ESP32 servo (see esp32/README.md)
supabase/live_stream.sql     optional: YouTube live stream on the audience display (see "Live stream" above)
supabase/live_scores.sql     live + / − scoring on every screen (see "On the day" above)
supabase/extra_matches.sql   judges add extra matches (semi-finals, final) and pick the teams (see "Extra matches" above)
esp32/                   optional: ESP32 program that opens the ball gate, with a step-by-step guide
.github/workflows/keep-alive.yml   daily ping so Supabase never pauses
```
