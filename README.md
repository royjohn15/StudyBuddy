# Study Tracker 📚

A personal study tracker that installs on your Android phone like a native app
(a PWA — Progressive Web App). No accounts, no server, no dependencies:
all data lives in the phone's local storage and the app works fully offline.

## Features

- **Today dashboard** — daily goal ring, study streak 🔥, pomodoros done today,
  7-day quiz average, today's session list, quick manual time logging
- **Pomodoro timer** — focus / short break / long break cycles, configurable
  durations, subject tagging, auto-logs finished focus sessions, sound +
  vibration + notification when a session ends, keeps the screen awake while
  running, and stays accurate even if the app is closed mid-session
- **Quiz marks** — log daily quiz results per subject (score / out of / note),
  overall and 7-day averages, score-trend chart with subject filter
- **Stats** — last-7-days bar chart with goal line, all-time totals, best day,
  per-subject breakdown
- **Settings** — subjects with colors, pomodoro durations, daily goal,
  sound/vibration toggles, JSON backup export/import, full reset

## Run it on your computer

```bash
cd studytracker
python3 -m http.server 8800
# open http://localhost:8800
```

## Install it on your Android phone

A PWA needs HTTPS (or localhost) to install. Two easy options:

### Option A — GitHub Pages (recommended)

1. Push this folder to a GitHub repository.
2. In the repo: **Settings → Pages → Deploy from branch** → pick your branch, `/ (root)`.
3. On your phone, open the Pages URL in Chrome (`https://<you>.github.io/<repo>/`).
4. Chrome menu **⋮ → Add to Home screen → Install**.

It opens fullscreen from its own icon, works offline after the first load,
and your data never leaves the phone (the site is just static files).

### Option B — fully offline with Termux

1. Install [Termux](https://f-droid.org/packages/com.termux/) on the phone.
2. Copy this folder to the phone and run inside Termux:
   `cd studytracker && python -m http.server 8080`
3. Open `http://localhost:8080` in Chrome → **Add to Home screen**.
   (Chrome treats localhost as secure, so the full PWA install works.)

## Backups

Your data is only on your device. Use **Settings → Export backup** every now
and then; restore with **Import backup**.

## Tech

Plain HTML/CSS/JS — zero frameworks, zero build step. Service worker for
offline caching, Web Notifications, Wake Lock and Vibration APIs, localStorage
for data. A debug handle is exposed at `window.app` in the browser console.
