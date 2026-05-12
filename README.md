# Norwegian Singles Planner — PWA

A sub-threshold training planner built as an installable Progressive Web App. Works on desktop, iPhone, and Android. Stores all data locally in your browser.

## Features

- Generates a personalized Norwegian Singles training plan with a built-in rehab ramp for returning from injury
- Weekly calendar view with drag-and-drop between days
- Session detail modal with pace targets, HR targets, and execution notes
- **Export to Calendar (.ics)** — adds every session to Google/Apple Calendar with reminders
- **Export structured workouts to Garmin/Coros (.tcx)** — import into Garmin Connect or Coros app, run it on your watch, auto-syncs to Strava after
- Tracks completion across every session, persists locally
- Installable on phone home screen as a real-feeling app

## Install & run locally

You need Node.js 18+ and npm.

```bash
# clone/unzip this folder, then:
cd singles-pwa
npm install
npm run dev
```

Then open http://localhost:5173 in your browser.

## Build and deploy

```bash
npm run build
```

The output in `dist/` is a static site — deploy it to any static host:

### Option 1: Vercel (easiest, free)
```bash
npm install -g vercel
vercel
```

### Option 2: Netlify
Drop the `dist/` folder onto https://app.netlify.com/drop

### Option 3: GitHub Pages
Push the `dist/` contents to the `gh-pages` branch of a repo.

Once deployed, open the URL on your phone, then "Add to Home Screen" (iOS) or "Install App" (Android) to get the native-app experience.

## Missing: PWA icons

Before deploying, add two icon files to `public/`:
- `pwa-192x192.png` (192×192 px)
- `pwa-512x512.png` (512×512 px)

A simple colored square with an "S" works fine. You can generate them at https://realfavicongenerator.net.

## How Strava export works (and doesn't)

**What works:** Export structured sub-T workouts as .tcx → import into Garmin Connect or Coros app → watch receives the workout with pace targets and interval structure → run it → watch syncs the completed activity to Strava automatically.

**What doesn't work:** Direct push of planned workouts to Strava. Strava's API does not permit this for non-partner apps. The .tcx → watch → Strava chain is the supported path.

## Data

All data is stored in your browser's `localStorage` under the key prefix `ns-planner:`. It's not sent anywhere. If you clear browser data, your plan and completion history are lost. To back up: export plan as .ics periodically.

## File structure

```
singles-pwa/
  src/
    App.jsx           # Main React component
    main.jsx          # Entry point
    index.css         # Tailwind imports
    storage.js        # localStorage wrapper
    planLogic.js      # Plan generation
    icsExport.js      # Calendar export
    tcxExport.js      # Garmin/Coros workout export
  index.html
  vite.config.js      # Vite + PWA config
  tailwind.config.js
  postcss.config.js
  package.json
```
