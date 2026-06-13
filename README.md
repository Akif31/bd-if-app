# BD Intermittent Fasting Plan — installable web app (PWA)

A configurable two-person IF planner. Set current/target weight, height, age,
activity, and a preferred timeline; calorie targets, protein floors, the meal
budget and the projection curve recalculate — with the timeline clamped to a
safe rate (never below BMR / clinical floor).

Data (weight logs, custom foods, edited rotation, both people's settings) is
stored on-device and works offline.

## Run locally first

```bash
npm install
npm run dev        # open the printed localhost URL
```

## Put it on the phones (no APK, no SDK)

1. Build:
   
   ```bash
   npm run build
   ```
2. Host the `dist/` folder anywhere with HTTPS (a PWA needs HTTPS to install):
   - **Vercel:** push to GitHub → import at vercel.com → it detects Vite → Deploy.
   - **Netlify drop:** drag the `dist/` folder onto app.netlify.com/drop.
   - **GitHub Pages:** push `dist/` to a `gh-pages` branch.
3. On each Android phone open the URL in **Chrome** → "Install app" (or menu ⋮ →
   "Add to Home screen" → Install). It lands on the home screen, opens
   fullscreen, works offline, and keeps its own data per phone.

Updates: redeploy; the app refreshes itself on next open.

## Data safety — read this once

The app saves every change instantly to on-device storage. That storage is
wiped if you clear Chrome's site data or uninstall the app, and it does NOT
sync between the two phones. So:

- The **Setup tab → Backup & restore** panel exports a JSON file with
  everything, and imports it back (also how you copy data between phones).
- **Auto-export on open** (toggle, on by default) drops a fresh backup file
  whenever you open the app and it's been a day. It only runs while the app is
  open — a closed app can't back itself up.
- The app asks the browser for persistent storage to reduce accidental
  eviction.

Keep the latest backup file in Google Drive or email it to yourself. Import
overwrites with the file's contents (it's a restore, not a merge), so back up
*after* logging, not before.

## Note

`capacitor.config.ts` is left in the project in case you ever want to wrap this
as a native APK later — ignore it for the PWA path; it does nothing unless you
add Capacitor.
