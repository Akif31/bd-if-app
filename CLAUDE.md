# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev        # Vite dev server (prints localhost URL)
npm run build      # tsc -b && vite build  → dist/  (this is also the typecheck)
npm run preview    # serve the built dist/ locally
```

There is **no test runner and no linter** configured. `npm run build` is the only correctness gate — it runs `tsc -b` (strict mode) before bundling, so a type error fails the build. Run it after changes.

Capacitor scripts (`cap:add`, `cap:sync`, `cap:open`, `apk`) exist only for an optional future native-APK wrap. The shipping path is the PWA; `capacitor.config.ts` is inert unless Capacitor is actually added.

## Architecture

This is a **single-file React app**. Effectively all logic, data, and UI live in `src/App.tsx` (~1700 lines). `src/main.tsx` only mounts `<DietPlan/>`; `src/index.css` only holds Tailwind directives. When adding a feature, you are almost always editing `App.tsx`.

It's a configurable **two-person** intermittent-fasting planner ("Him" = `m`, "Her" = `f`). The top-level `DietPlan` component holds three pieces of state — `person`, `tab`, and `bodies` (per-person editable config) — and renders one of six tabs: `plan | week | track | tips | move | setup`.

### The domain core (pure functions, near the top of `App.tsx`)
Everything the UI shows is derived from a person's `Body` config by pure functions — this is the heart of the app:
- `bmrOf(...)` — Mifflin-St Jeor BMR.
- `buildProjection(...)` — week-by-week, **non-linear** weight-loss curve (recomputes TDEE from current weight each week; detects plateau-before-target).
- `deriveProfile(person, body)` → `DerivedProfile` — the master derivation: BMR/TDEE → calorie intake → protein floors → 3-meal calorie budget split (oil and fruit/tea reserved first) → clamped timeline.

`deriveProfile` is memoized in `DietPlan` and threaded into every tab as the `profile` prop. **Changing it ripples everywhere.** It enforces safety clamps that must be preserved: a max loss rate (~0.95% bodyweight/week), never cutting more than 25% of TDEE, and a hard floor of `max(BMR, ABS_FLOOR)` so intake never drops below clinical minimums.

### Static data tables
Domain content is hardcoded as typed constants: `IDENTITY`, `ACTIVITY`, `DEFAULT_BODY`, `ABS_FLOOR`, `MEALS`, `PROTEIN_ITEMS`, `FOOD_DB`, `DEFAULT_ROTATION`, `TIPS`, `EXERCISE_PLANS`. To change recipes, foods, tips, or workouts, edit these arrays.

### Persistence — always through the storage adapter
Never touch `localStorage` directly. Use the async `storeGet`/`storeSet` helpers, which fall back through three tiers: `window.storage` (Claude artifact host) → `localStorage` (Vercel/Pages) → in-memory. All reads are async, so tabs load with a `loaded` flag and persist on every edit (no save button).

Storage keys in use: `bodies_v1`, `rotation_v1`, `custom_foods`, `hidden_foods`, `wlog_m`, `wlog_f`, plus `last_backup` / `auto_backup`. **When you add a new persisted key, also add it to the `STORE_KEYS` array** — that constant defines what `collectBackup`/`exportBackup` include, and the backup JSON is the only cross-device sync mechanism (import is a full overwrite/restore, not a merge). Auto-export drops a daily backup on app open.

### Styling
Mixed approach: Tailwind utility classes for layout plus inline `style={{...}}` using the central `C` color-palette object (defined at top of `App.tsx`). There are no CSS modules or styled-components — follow the existing inline-style + `C` pattern.

## PWA / deployment notes
- `vite.config.ts` sets `base: "./"` (relative paths) — required so the build works when hosted under a subpath. Don't switch to an absolute base without reason.
- `vite-plugin-pwa` is configured with `registerType: "autoUpdate"`, so deployed clients self-update on next open.
- A PWA needs **HTTPS** to be installable. Deploy `dist/` to Vercel (auto-detects Vite), Netlify drop, or GitHub Pages, then install via Chrome → "Install app".
