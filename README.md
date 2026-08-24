# Vitals

A private, Apple-style health log for fluid intake, urine output, blood pressure,
sugar, and customizable medicine alarms. It's a web app you install to your
phone's home screen — no App Store, works on Android and iPhone, and all your
data stays on your device unless you connect Google Drive.

This guide gets it online (free, ~10 minutes) and, optionally, connected to
your Google Drive.

---

## 1. Put the app online with GitHub Pages

You need a place to host these files so your phone can open them and so
Google Drive sign-in works (it requires a real web address, not a local
file). GitHub Pages is free.

1. Create a free account at [github.com](https://github.com) if you don't
   already have one.
2. Click the **+** in the top right → **New repository**. Name it something
   like `vitals` and make sure it's set to **Public**. Click **Create repository**.
3. On the new repository's page, click **uploading an existing file** (or
   drag-and-drop). Upload **every file in this folder**, keeping the `icons`
   folder as a folder (drag the whole `icons` folder in, GitHub will preserve
   it).

   **On a phone or tablet:** your file picker usually can't select or
   drag in a whole folder the way a computer can — only individual files.
   Here's how to get the 3 icon files into an `icons/` folder anyway,
   entirely from your phone, without needing a computer or redesigning
   anything (the icon is already made for you, inside this folder):
   1. Tap **uploading an existing file** and pick all the files that are
      loose in this folder (`index.html`, `styles.css`, `app.js`, `drive.js`,
      `manifest.json`, `service-worker.js`, `README.md`) — leave the 3 files
      inside `icons` for a moment.
   2. Tap **uploading an existing file** again (or **Add file → Upload
      files**) and this time pick the 3 files from inside `icons`
      (`icon-192.png`, `icon-512.png`, `icon-512-maskable.png`). They'll
      upload to the repo's root, not into a folder — that's fine, you'll fix
      it in the next step.
   3. Before committing, GitHub shows each uploaded file with its name in an
      editable text box. Tap into each of those 3 boxes and type `icons/` at
      the very start of the name, so it reads `icons/icon-192.png` (and the
      same for the other two). Typing a `/` in that box is what tells GitHub
      to put the file inside a folder — it creates `icons/` automatically,
      no drag-and-drop needed.
   4. Commit. Open the repo afterward and confirm you see an `icons` folder
      containing the 3 files.

   This same "type a `/` into the filename box" trick works any time you
   need to add or replace a file inside a subfolder from a phone.
4. Commit the upload (the green **Commit changes** button).
5. Go to the repository's **Settings** tab → **Pages** (left sidebar).
6. Under "Build and deployment", set **Source** to **Deploy from a branch**,
   branch **main**, folder **/ (root)**. Click **Save**.
7. Wait about a minute, then refresh that Pages settings screen — it will
   show your live URL, something like:

   `https://yourusername.github.io/vitals/`

8. Open that URL on your phone's browser. To install it like an app:
   - **Android (Chrome)**: tap the **⋮** menu → **Add to Home screen** / **Install app**.
   - **iPhone (Safari)**: tap the **Share** icon → **Add to Home Screen**.

You now have a real app icon on your home screen. Open it once — it'll ask
you to create a 4-digit passcode the first time.

**Updating later:** whenever you want to change something, edit the file on
GitHub (or upload a replacement) and it goes live within a minute or two —
no reinstalling needed.

---

## 2. (Optional) Connect Google Drive backup

Skip this section if you're fine with everything staying only on your phone —
the app works completely without it, and you can always export a CSV from
Settings.

To have new entries automatically back up to a Google Sheet in your own
Drive, you need a free "OAuth Client ID" from Google. This tells Google
"this specific website is allowed to ask my users for permission" — it's a
one-time setup, and only you can see the data (the app only ever requests
access to the one spreadsheet it creates, nothing else in your Drive).

### Create the Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   sign in with the Google account you want your health data to live in.
2. Click the project dropdown at the top → **New Project**. Name it
   `Vitals` → **Create**. Wait for it to switch into that project.
3. In the search bar at the top, search for **"Google Sheets API"** → open
   it → click **Enable**.
4. Search for **"Google Drive API"** → open it → click **Enable**.
5. In the left sidebar, go to **APIs & Services → OAuth consent screen**.
   - User type: **External** → **Create**.
   - App name: `Vitals`. User support email: your email. Developer contact:
     your email. Click through **Save and Continue** on each remaining
     screen (Scopes, Test users, Summary) — you don't need to add anything.
   - Back on the consent screen overview, under **Test users**, click **Add
     users** and add your own Google email address. (While the app is in
     "Testing" mode, only listed test users can sign in — that's fine, it's
     just you.)
6. Go to **APIs & Services → Credentials**.
   - Click **+ Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: `Vitals web`.
   - Under **Authorized JavaScript origins**, click **+ Add URI** and enter
     your GitHub Pages origin **without a trailing slash or path**, e.g.:
     `https://yourusername.github.io`
   - Click **Create**. Copy the **Client ID** it shows you
     (ends in `.apps.googleusercontent.com`).

### Paste it into the app

1. Open `drive.js` (in your GitHub repository, click the file → the pencil/edit icon).
2. Find this line near the top:
   ```js
   CLIENT_ID: 'PASTE_YOUR_GOOGLE_CLIENT_ID_HERE.apps.googleusercontent.com',
   ```
3. Replace the placeholder with the Client ID you copied, keeping the quotes.
4. Commit the change.
5. Open Vitals on your phone → **Settings → Google Drive backup → Connect**,
   sign in, and approve access. A sheet named **"Vitals Health Log"** will
   appear in your Drive, and Settings will show an **Open** link to it
   directly.

From then on, every new entry, edit, or delete pushes to that sheet
automatically (it retries in the background if you're offline when you log
something). The sheet is a one-way mirror of your log — always edit entries
inside the Vitals app itself, not in the spreadsheet, since changes made
directly in the sheet aren't read back into the app.

---

## What's on each screen

- **Home** — a card per tracked parameter: Fluid Intake, Urine output, Blood
  pressure, Sugar, plus any custom health parameters you've added (see
  below). Tap the colored top half of a card to log a new entry; tap the
  bottom half to see today's graph and entry list.
- **Trends** — 7/30-day patterns for every parameter you track, each with
  its own titled card. Points are placed by when they actually happened, not
  spaced evenly — two readings an hour apart sit close together, and a gap
  of a couple of days shows up as real empty space on the chart.
- **Alarms** — customizable, repeating medicine/measurement reminders, each
  with its own tone (Chime, Bell, Beep, or Silent) that plays while Vitals
  is open; tap a tone while picking it to preview how it sounds.
- **Settings** — light/dark, app lock, Face/Fingerprint unlock, per-tab
  colors, custom health parameters, Google Drive, and a CSV export of
  everything on this device.

### Editing or deleting an entry

Open the metric's detail screen (tap the bottom half of its card) and tap
any entry in the list — it opens pre-filled, with a **Delete** button.

### Custom health parameters

Beyond the four built-in cards, Settings → **Health parameters** lets you
add anything else worth tracking — serum creatinine, eGFR, tacrolimus
level, or anything of your own choosing. Give it a name, a unit (e.g.
`mg/dL`), and a color; it then gets its own card on Home, its own graph on
its detail screen, and its own titled trend card, exactly like the built-in
four. Deleting a custom parameter removes its card, but any values you'd
already logged under it stay in your data and CSV export.

### Tab colors

Settings → **Tab colors** lets you recolor any card — built-in or custom —
from the same 8-color palette. Tap a color swatch next to a parameter's name
to apply it immediately; it updates the Home card, the detail screen, and
the Trends card together.

### A note on alarms

Because this is a web app rather than a native app, alarms notify you
reliably while Vitals is installed and has been opened somewhat recently —
exactly like most reminder web-apps behave on Android and iPhone. For the
most consistent alerts:
- Keep it installed to your home screen (not just a browser bookmark).
- Open it at least once a day.
- Don't force-close it from your phone's recent-apps list.

If your phone aggressively restricts background apps, an alarm you were
"due" for will still show up the next time you open Vitals, so nothing is
silently lost — it just may arrive a bit late rather than exactly on time.

One honest limitation: no web app (Vitals included) can assign a custom
ringtone file to your phone's own notification sound — browsers don't allow
that. What Vitals does instead is play the tone you picked itself, out loud,
whenever the alarm fires while the app is open; if you pick **Silent**, the
system notification is also told to stay silent rather than make its
default sound.

### Your data, in plain terms

Everything is stored in your phone browser's local storage — nothing is
sent anywhere unless you connect Google Drive in Settings. Uninstalling the
app or clearing your browser's site data for it will erase your log, so if
you're relying on it long-term, either connect Drive backup or export a CSV
occasionally from Settings.

---

## File overview (for reference)

| File | Purpose |
|---|---|
| `index.html` | App layout/screens |
| `styles.css` | All visual styling, light + dark themes |
| `app.js` | All app logic — storage, entries, alarms, PIN, charts |
| `drive.js` | Optional Google Drive/Sheets backup |
| `manifest.json` | Makes it installable as an app |
| `service-worker.js` | Offline loading + notification taps |
| `icons/` | App icon |
