import { useState, useEffect, useMemo, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// BD Intermittent Fasting Plan v2
// Fixes vs v1: protein math corrected, calorie budget reconciled (cooking oil
// was the missing line item), projection is non-linear, real weigh-ins can be
// logged, ACV protocol added, more BD recipes.
// Storage: uses window.storage (Claude artifact) → localStorage (Vercel/Pages)
// → in-memory, whichever exists.
// ─────────────────────────────────────────────────────────────────────────────

type Person = "m" | "f";
type Tab = "plan" | "week" | "track" | "tips" | "move" | "setup";

// Palette is theme-driven: every value resolves to a CSS variable defined in
// index.css under :root (light) and :root[data-theme="dark"]. Toggling the
// data-theme attribute on <html> re-themes the whole app with no React churn.
const C = {
  paper: "var(--c-paper)",
  ink: "var(--c-ink)",
  faint: "var(--c-faint)",
  line: "var(--c-line)",
  card: "var(--c-card)",
  green: "var(--c-green)",
  greenSoft: "var(--c-green-soft)",
  plum: "var(--c-plum)",
  plumSoft: "var(--c-plum-soft)",
  turmeric: "var(--c-turmeric)",
  turmericSoft: "var(--c-turmeric-soft)",
  clay: "var(--c-clay)",
  claySoft: "var(--c-clay-soft)",
  sky: "var(--c-sky)",
  skySoft: "var(--c-sky-soft)",
  lime: "var(--c-lime)",
  limeSoft: "var(--c-lime-soft)",
  // surfaces + previously-inline literals, now themeable
  surface: "var(--c-surface)",       // was "#fff" card backgrounds
  onAccent: "var(--c-on-accent)",    // text/icon on accent buttons (light→white, dark→ink, always legible)
  knob: "var(--c-knob)",             // toggle thumb — stays light in both themes
  ink2: "var(--c-ink2)",             // was "#55534C" default chip text
  carbFg: "var(--c-carb-fg)",        // was "#7A5A06"
  greenBorder: "var(--c-green-border)",
  skyBorder: "var(--c-sky-border)",
  turmericBorder: "var(--c-turmeric-border)",
  clayBorder: "var(--c-clay-border)",
};

const serif = '"Fraunces Variable", Fraunces, Georgia, "Times New Roman", serif';

// Theme — drives the data-theme attribute the CSS variables key off of.
type Theme = "light" | "dark";
const THEME_META: Record<Theme, string> = { light: "#1E5B3F", dark: "#161512" };

function applyTheme(next: Theme, animate: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    window.setTimeout(() => root.classList.remove("theme-transition"), 220);
  }
  root.setAttribute("data-theme", next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_META[next]);
}

function prefersDark(): boolean {
  try { return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches; } catch { return false; }
}

// ── Identity (fixed) vs body config (editable) ───────────────────────────────

const IDENTITY = {
  m: { label: "Him", accent: C.green, accentSoft: C.greenSoft, window: "16:8", eatStart: 11, eatEnd: 19, windowLabel: "11am – 7pm" },
  f: { label: "Her", accent: C.plum, accentSoft: C.plumSoft, window: "14:10", eatStart: 10, eatEnd: 20, windowLabel: "10am – 8pm" },
} as const;

type Activity = "sedentary" | "light" | "moderate" | "active";

const ACTIVITY: Record<Activity, { mult: number; label: string }> = {
  sedentary: { mult: 1.2, label: "Sedentary — desk job, little walking" },
  light: { mult: 1.375, label: "Light — on feet some, 1–3 workouts/wk" },
  moderate: { mult: 1.55, label: "Moderate — active job or 3–5 workouts/wk" },
  active: { mult: 1.725, label: "Active — very active, 6–7 workouts/wk" },
};

interface Body {
  startKg: number;
  targetKg: number;
  heightCm: number;
  age: number;
  activity: Activity;
  weeks: number; // preferred timeline; gets clamped to a safe rate
}

// Generic placeholder defaults — users overwrite these on the Setup tab.
const DEFAULT_BODY: Record<Person, Body> = {
  m: { startKg: 90, targetKg: 72, heightCm: 180, age: 40, activity: "light", weeks: 40 },
  f: { startKg: 70, targetKg: 62, heightCm: 160, age: 35, activity: "light", weeks: 40 },
};

// Absolute calorie floors regardless of math (clinical minimums for unsupervised dieting)
const ABS_FLOOR: Record<Person, number> = { m: 1500, f: 1300 };

function bmrOf(person: Person, kg: number, heightCm: number, age: number): number {
  const sexConst = person === "m" ? 5 : -161; // Mifflin-St Jeor
  return 10 * kg + 6.25 * heightCm - 5 * age + sexConst;
}

// Weight-aware projection: TDEE recomputed from current weight each week.
// Returns the curve and whether the target is actually reachable at this intake.
function buildProjection(
  person: Person, startKg: number, targetKg: number, intake: number,
  heightCm: number, age: number, activityMult: number
): { pts: number[]; reached: boolean } {
  const pts = [startKg];
  let kg = startKg;
  let week = 0;
  while (kg > targetKg && week < 200) {
    week++;
    const tdee = bmrOf(person, kg, heightCm, age) * activityMult;
    let loss = (Math.max(0, tdee - intake) * 7) / 7700;
    if (week === 1) loss += 0.6;
    if (week === 2) loss += 0.2;
    if (loss < 0.02) break; // intake has caught up to burn — plateau before target
    kg = Math.max(targetKg, +(kg - loss).toFixed(2));
    pts.push(kg);
  }
  return { pts, reached: kg <= targetKg + 0.05 };
}

// The full derivation: body config → everything the UI consumes.
interface DerivedProfile {
  label: string; accent: string; accentSoft: string;
  window: string; eatStart: number; eatEnd: number; windowLabel: string;
  startKg: number; targetKg: number;
  bmr: number; tdee: number; intake: number;
  proteinFloor: number; proteinStretch: number;
  reqWeeks: number; realisticWeeks: number; reached: boolean;
  rateClamped: boolean; atFloor: boolean; reqRate: number; actualRate: number;
  mealKcal: { b: string; main: string; eve: string };
  mealTime: { b: string; main: string; eve: string };
  ledger: { item: string; kcal: number }[];
  projection: number[];
}

function deriveProfile(person: Person, body: Body): DerivedProfile {
  const id = IDENTITY[person];
  const { startKg, targetKg, heightCm, age, activity, weeks } = body;
  const mult = ACTIVITY[activity].mult;
  const bmr = Math.round(bmrOf(person, startKg, heightCm, age));
  const tdee = Math.round(bmr * mult);
  const toLose = Math.max(0, startKg - targetKg);

  const reqRate = weeks > 0 ? toLose / weeks : 99; // kg/week requested
  const maxRate = 0.0095 * startKg; // ~0.95% bodyweight/week ceiling
  const rateClamped = reqRate > maxRate + 1e-6;
  const safeRate = Math.min(reqRate, maxRate);

  let dailyDeficit = (safeRate * 7700) / 7;
  dailyDeficit = Math.min(dailyDeficit, 0.25 * tdee); // never cut more than 25% of TDEE
  let intake = Math.round(tdee - dailyDeficit);

  const floor = Math.max(bmr, ABS_FLOOR[person]);
  const atFloor = intake < floor;
  if (atFloor) intake = floor;

  const { pts, reached } = buildProjection(person, startKg, targetKg, intake, heightCm, age, mult);
  const realisticWeeks = pts.length - 1;
  const actualRate = realisticWeeks > 0 ? toLose / realisticWeeks : 0;

  const proteinFloor = Math.round(1.6 * targetKg); // g/day, target bodyweight
  const proteinStretch = Math.round(1.9 * targetKg);

  // Budget split: reserve oil + fruit/tea, divide the rest across 3 meals.
  const oilTbsp = person === "m" ? 1.5 : 1;
  const oilKcal = Math.round(oilTbsp * 120);
  const fruitKcal = person === "m" ? 80 : 60;
  const mealBudget = Math.max(0, intake - oilKcal - fruitKcal);
  const bK = Math.round(mealBudget * 0.28);
  const mainK = Math.round(mealBudget * 0.48);
  const eveK = mealBudget - bK - mainK;
  const band = (n: number) => `${Math.round((n - 40) / 10) * 10}–${Math.round((n + 40) / 10) * 10} kcal`;

  return {
    ...id,
    startKg, targetKg, bmr, tdee, intake,
    proteinFloor, proteinStretch,
    reqWeeks: weeks, realisticWeeks, reached,
    rateClamped, atFloor, reqRate, actualRate,
    mealKcal: { b: `~${bK}`, main: `~${mainK}`, eve: `~${eveK}` },
    mealTime: {
      b: `${person === "m" ? "11am" : "10am"} · ${band(bK)}`,
      main: `1–2pm · ${band(mainK)}`,
      eve: `${person === "m" ? "5–6pm" : "6–7pm"} · ${band(eveK)}`,
    },
    ledger: [
      { item: "Three meals", kcal: bK + mainK + eveK },
      { item: `Cooking oil (${oilTbsp} tbsp/day across curries)`, kcal: oilKcal },
      { item: "Fruit serving + tea milk", kcal: fruitKcal },
    ],
    projection: pts,
  };
}

// ── Storage adapter: artifact storage → localStorage → memory ────────────────

const memStore: Record<string, string> = {};

async function storeGet(key: string): Promise<string | null> {
  try {
    const w = window as any;
    if (w.storage?.get) {
      try {
        const r = await w.storage.get(key);
        return r?.value ?? null;
      } catch {
        return null;
      }
    }
    if (typeof w.localStorage !== "undefined") return w.localStorage.getItem(key);
  } catch {}
  return memStore[key] ?? null;
}

async function storeSet(key: string, value: string): Promise<void> {
  try {
    const w = window as any;
    if (w.storage?.set) {
      await w.storage.set(key, value);
      return;
    }
    if (typeof w.localStorage !== "undefined") {
      w.localStorage.setItem(key, value);
      return;
    }
  } catch {}
  memStore[key] = value;
}

// ── Meal data (recipes expanded; per-option protein estimates are real sums) ─

interface Chip { text: string; kind: "protein" | "carb" | "veg" | "warn" | "default"; }
interface MealOption { label: string; proteinG: number; chips: Chip[]; }
interface Meal { id: string; name: string; warning?: string; options: MealOption[]; }

const MEALS: Meal[] = [
  {
    id: "b",
    name: "Meal 1 · Break-fast",
    options: [
      {
        label: "A — Cilbir-style (recommended)",
        proteinG: 24,
        chips: [
          { text: "3 poached eggs", kind: "protein" },
          { text: "full-fat yogurt 100g", kind: "protein" },
          { text: "cucumber + tomato", kind: "veg" },
          { text: "garlic + chilli flakes", kind: "default" },
          { text: "1 small roti", kind: "carb" },
        ],
      },
      {
        label: "B — Chola chaat",
        proteinG: 13,
        chips: [
          { text: "boiled chickpea 100g", kind: "protein" },
          { text: "yogurt 80g", kind: "protein" },
          { text: "cucumber + onion", kind: "veg" },
          { text: "cumin + coriander", kind: "default" },
          { text: "low protein — add a boiled egg", kind: "warn" },
        ],
      },
      {
        label: "C — Chia/flax pudding",
        proteinG: 16,
        chips: [
          { text: "chia or tishi 2 tbsp", kind: "default" },
          { text: "milk 150ml", kind: "protein" },
          { text: "2 dates", kind: "default" },
          { text: "banana slices", kind: "default" },
          { text: "1 boiled egg on the side", kind: "protein" },
          { text: "fruit alone won't hold you to 1pm", kind: "warn" },
        ],
      },
      {
        label: "D — Chira + milk",
        proteinG: 14,
        chips: [
          { text: "chira ½ cup", kind: "carb" },
          { text: "milk 150ml", kind: "protein" },
          { text: "2–3 dates max", kind: "warn" },
          { text: "1 boiled egg", kind: "protein" },
        ],
      },
      {
        label: "E — Dim bhuna, light",
        proteinG: 16,
        chips: [
          { text: "2 eggs bhuna (1 tsp oil)", kind: "protein" },
          { text: "1 roti", kind: "carb" },
          { text: "cucumber salad", kind: "veg" },
        ],
      },
      {
        label: "F — Oats khichuri",
        proteinG: 19,
        chips: [
          { text: "oats 40g + mung dal 30g", kind: "carb" },
          { text: "mixed vegetables", kind: "veg" },
          { text: "1 egg stirred in", kind: "protein" },
          { text: "turmeric + ginger", kind: "default" },
        ],
      },
    ],
  },
  {
    id: "main",
    name: "Meal 2 · Main meal",
    options: [
      {
        label: "A — Tandoori-style chicken (recommended)",
        proteinG: 52,
        chips: [
          { text: "chicken 150g (boil, marinate, grill)", kind: "protein" },
          { text: "pumpkin curry", kind: "veg" },
          { text: "lal shak / pui shak", kind: "veg" },
          { text: "rice ½ cup cooked", kind: "carb" },
          { text: "dal ½ cup", kind: "protein" },
        ],
      },
      {
        label: "B — Fish curry plate",
        proteinG: 44,
        chips: [
          { text: "fish 150g (rui/tilapia/pangas)", kind: "protein" },
          { text: "green papaya curry", kind: "veg" },
          { text: "shak", kind: "veg" },
          { text: "salad", kind: "veg" },
          { text: "rice ½ cup + dal ½ cup", kind: "carb" },
        ],
      },
      {
        label: "C — Chicken wrap",
        proteinG: 40,
        chips: [
          { text: "brown-flour roti 1", kind: "carb" },
          { text: "chicken 120g grilled", kind: "protein" },
          { text: "cabbage + cucumber + onion", kind: "veg" },
          { text: "yogurt-lemon sauce, not mayo", kind: "warn" },
        ],
      },
      {
        label: "D — Mushroom + chicken stir fry",
        proteinG: 38,
        chips: [
          { text: "chicken 120g", kind: "protein" },
          { text: "mushroom 80g", kind: "veg" },
          { text: "mixed vegetables", kind: "veg" },
          { text: "rice ½ cup", kind: "carb" },
        ],
      },
      {
        label: "E — Dal + egg (budget)",
        proteinG: 33,
        chips: [
          { text: "masoor/mung dal 1 cup", kind: "protein" },
          { text: "2 eggs", kind: "protein" },
          { text: "shak + salad", kind: "veg" },
          { text: "rice ½ cup", kind: "carb" },
        ],
      },
      {
        label: "F — Chingri + lau",
        proteinG: 36,
        chips: [
          { text: "shrimp 120g", kind: "protein" },
          { text: "lau (bottle gourd)", kind: "veg" },
          { text: "rice ½ cup + dal ½ cup", kind: "carb" },
        ],
      },
      {
        label: "G — Lean beef bhuna (max 1×/week)",
        proteinG: 38,
        chips: [
          { text: "lean beef 100g, fat trimmed", kind: "protein" },
          { text: "extra vegetables on the plate", kind: "veg" },
          { text: "rice ½ cup", kind: "carb" },
          { text: "oil-heavy dish — count it as the treat-adjacent meal", kind: "warn" },
        ],
      },
    ],
  },
  {
    id: "eve",
    name: "Meal 3 · Evening, light",
    warning: "Keep this genuinely light. This is where most people silently overshoot the daily budget.",
    options: [
      {
        label: "Pick one",
        proteinG: 14,
        chips: [
          { text: "yogurt 150g + chia 1 tbsp", kind: "protein" },
          { text: "2 boiled eggs + cucumber", kind: "protein" },
          { text: "roasted chickpea + lemon + chilli", kind: "default" },
          { text: "chicken-vegetable soup", kind: "protein" },
          { text: "vegetable egg-drop soup", kind: "protein" },
          { text: "fruit + peanuts 1 tbsp", kind: "default" },
          { text: "corn + lemon + chilli", kind: "veg" },
          { text: "doi-chira, small bowl, measured", kind: "carb" },
        ],
      },
    ],
  },
];

// ── Protein counter items (the floor is hit by counting, not hoping) ─────────

const PROTEIN_ITEMS = [
  { name: "Egg (1)", g: 6 },
  { name: "Chicken 100g cooked", g: 27 },
  { name: "Fish 100g cooked", g: 24 },
  { name: "Shrimp 100g", g: 20 },
  { name: "Lean beef 100g", g: 26 },
  { name: "Dal 1 cup cooked", g: 18 },
  { name: "Yogurt 100g", g: 4 },
  { name: "Milk 1 glass (200ml)", g: 7 },
  { name: "Chickpea 100g boiled", g: 9 },
];

// ── Week rotation ────────────────────────────────────────────────────────────

// ── BD food knowledge base ───────────────────────────────────────────────────
// Portion-based on purpose: real servings beat per-100g math at the table.
// kcal/protein are typical home-cooked values with minimal oil; oil itself is
// budgeted separately. Values are estimates — treat ±15% as normal.

type FoodCat = "protein" | "veg" | "shak" | "staple" | "fruit" | "dairy" | "extra" | "treat";

interface Food { name: string; portion: string; kcal: number; proteinG: number; cat: FoodCat; note?: string; }

const FOOD_DB: Food[] = [
  // protein
  { name: "Egg", portion: "1 boiled/poached", kcal: 70, proteinG: 6, cat: "protein" },
  { name: "Chicken", portion: "100g cooked", kcal: 180, proteinG: 27, cat: "protein" },
  { name: "Rui / katla", portion: "100g cooked", kcal: 125, proteinG: 20, cat: "protein" },
  { name: "Tilapia", portion: "100g cooked", kcal: 130, proteinG: 26, cat: "protein" },
  { name: "Pangas", portion: "100g cooked", kcal: 155, proteinG: 18, cat: "protein", note: "fattier fish" },
  { name: "Ilish", portion: "100g cooked", kcal: 250, proteinG: 22, cat: "protein", note: "oily — occasional" },
  { name: "Shrimp (chingri)", portion: "100g cooked", kcal: 100, proteinG: 20, cat: "protein" },
  { name: "Lean beef", portion: "100g cooked", kcal: 220, proteinG: 26, cat: "protein", note: "max 1×/week" },
  { name: "Mutton", portion: "100g cooked", kcal: 260, proteinG: 25, cat: "protein", note: "occasional" },
  { name: "Masoor dal", portion: "1 cup cooked", kcal: 200, proteinG: 18, cat: "protein" },
  { name: "Mung dal", portion: "1 cup cooked", kcal: 210, proteinG: 14, cat: "protein" },
  { name: "Chola (boiled)", portion: "100g", kcal: 164, proteinG: 9, cat: "protein" },
  // shak
  { name: "Lal shak", portion: "1 serving cooked", kcal: 60, proteinG: 3, cat: "shak" },
  { name: "Pui shak", portion: "1 serving cooked", kcal: 55, proteinG: 2, cat: "shak" },
  { name: "Palong shak", portion: "1 serving cooked", kcal: 50, proteinG: 3, cat: "shak" },
  { name: "Data shak", portion: "1 serving cooked", kcal: 55, proteinG: 3, cat: "shak" },
  // veg
  { name: "Lau", portion: "1 serving cooked", kcal: 25, proteinG: 1, cat: "veg" },
  { name: "Misti kumra (pumpkin)", portion: "1 serving cooked", kcal: 40, proteinG: 1, cat: "veg" },
  { name: "Green papaya", portion: "1 serving cooked", kcal: 35, proteinG: 1, cat: "veg" },
  { name: "Jhinga", portion: "1 serving cooked", kcal: 30, proteinG: 1, cat: "veg" },
  { name: "Beans", portion: "1 serving cooked", kcal: 45, proteinG: 2, cat: "veg" },
  { name: "Cabbage", portion: "1 serving cooked", kcal: 35, proteinG: 2, cat: "veg" },
  { name: "Cauliflower", portion: "1 serving cooked", kcal: 35, proteinG: 2, cat: "veg" },
  { name: "Kachkola", portion: "1 piece cooked", kcal: 90, proteinG: 1, cat: "veg" },
  { name: "Mocha", portion: "1 serving cooked", kcal: 60, proteinG: 2, cat: "veg" },
  { name: "Potol", portion: "1 serving cooked", kcal: 35, proteinG: 2, cat: "veg" },
  { name: "Korola", portion: "1 serving cooked", kcal: 30, proteinG: 1, cat: "veg" },
  { name: "Begun", portion: "1 serving cooked", kcal: 80, proteinG: 1, cat: "veg", note: "absorbs oil fast" },
  { name: "Mushroom", portion: "80g cooked", kcal: 25, proteinG: 3, cat: "veg" },
  { name: "Salad (cucumber+tomato+onion)", portion: "1 bowl", kcal: 30, proteinG: 1, cat: "veg" },
  // staples
  { name: "Rice", portion: "½ cup cooked", kcal: 105, proteinG: 2, cat: "staple" },
  { name: "Roti", portion: "1 medium", kcal: 105, proteinG: 3, cat: "staple" },
  { name: "Brown-flour roti", portion: "1 medium", kcal: 100, proteinG: 4, cat: "staple" },
  { name: "Chira", portion: "½ cup dry", kcal: 170, proteinG: 3, cat: "staple" },
  { name: "Muri", portion: "1 cup", kcal: 55, proteinG: 1, cat: "staple" },
  { name: "Oats", portion: "40g dry", kcal: 150, proteinG: 5, cat: "staple" },
  { name: "Potato", portion: "100g boiled", kcal: 87, proteinG: 2, cat: "staple" },
  { name: "Corn", portion: "1 medium cob", kcal: 100, proteinG: 3, cat: "staple" },
  // fruit
  { name: "Mango", portion: "1 medium", kcal: 150, proteinG: 1, cat: "fruit", note: "max 1/day" },
  { name: "Banana", portion: "1 medium", kcal: 105, proteinG: 1, cat: "fruit" },
  { name: "Watermelon", portion: "200g", kcal: 60, proteinG: 1, cat: "fruit" },
  { name: "Papaya (ripe)", portion: "150g", kcal: 65, proteinG: 1, cat: "fruit" },
  { name: "Guava", portion: "1 medium", kcal: 70, proteinG: 3, cat: "fruit" },
  { name: "Jamrul", portion: "2 pieces", kcal: 50, proteinG: 0, cat: "fruit" },
  { name: "Pineapple", portion: "150g", kcal: 75, proteinG: 1, cat: "fruit" },
  { name: "Lichu", portion: "10 pieces", kcal: 65, proteinG: 1, cat: "fruit" },
  { name: "Dates", portion: "3 pieces", kcal: 70, proteinG: 0, cat: "fruit" },
  // dairy
  { name: "Milk (full fat)", portion: "200ml", kcal: 120, proteinG: 7, cat: "dairy" },
  { name: "Yogurt (doi, plain)", portion: "100g", kcal: 60, proteinG: 4, cat: "dairy" },
  { name: "Paneer", portion: "50g", kcal: 130, proteinG: 9, cat: "dairy" },
  // extras
  { name: "Cooking oil", portion: "1 tbsp", kcal: 120, proteinG: 0, cat: "extra", note: "the silent budget-killer" },
  { name: "Sugar", portion: "1 tsp", kcal: 16, proteinG: 0, cat: "extra" },
  { name: "Peanuts", portion: "1 tbsp", kcal: 50, proteinG: 2, cat: "extra" },
  { name: "Chia / tishi", portion: "1 tbsp", kcal: 60, proteinG: 2, cat: "extra" },
  { name: "Milk tea", portion: "1 cup, light sugar", kcal: 60, proteinG: 1, cat: "extra" },
  // treats (honest numbers)
  { name: "Biryani", portion: "1 plate", kcal: 700, proteinG: 25, cat: "treat", note: "= ⅓ of his day" },
  { name: "Fuchka", portion: "6 pieces", kcal: 300, proteinG: 5, cat: "treat" },
  { name: "Singara", portion: "1 piece", kcal: 140, proteinG: 3, cat: "treat" },
  { name: "Samosa", portion: "1 piece", kcal: 150, proteinG: 3, cat: "treat" },
  { name: "Burger", portion: "1 regular", kcal: 500, proteinG: 25, cat: "treat" },
  { name: "Ice cream", portion: "1 scoop", kcal: 140, proteinG: 2, cat: "treat" },
  { name: "Paratha", portion: "1 piece", kcal: 260, proteinG: 5, cat: "treat", note: "oil-fried — treat tier" },
];

const CAT_LABEL: Record<FoodCat, string> = {
  protein: "Protein", shak: "Shak", veg: "Vegetables", staple: "Staples",
  fruit: "Fruit", dairy: "Dairy", extra: "Extras", treat: "Treats",
};
const CAT_ORDER: FoodCat[] = ["protein", "shak", "veg", "staple", "fruit", "dairy", "extra", "treat"];

interface RotationDay { day: string; items: string[]; }

const DEFAULT_ROTATION: RotationDay[] = [
  { day: "Sat", items: ["Lal shak", "Misti kumra (pumpkin)", "Egg"] },
  { day: "Sun", items: ["Pui shak", "Lau", "Chicken"] },
  { day: "Mon", items: ["Palong shak", "Green papaya", "Rui / katla"] },
  { day: "Tue", items: ["Jhinga", "Beans", "Egg"] },
  { day: "Wed", items: ["Cabbage", "Cauliflower", "Chicken"] },
  { day: "Thu", items: ["Kachkola", "Mocha", "Tilapia"] },
  { day: "Fri", items: ["Salad (cucumber+tomato+onion)", "Masoor dal", "Egg"] },
];

// ── Tips (corrected protein card, new oil card, ACV card) ────────────────────

interface Tip { kind: "success" | "info" | "warn" | "danger"; title: string; body: string; }

const TIPS: Tip[] = [
  {
    kind: "danger",
    title: "Cooking oil — the calories v1 of this plan forgot",
    body: "BD curry cooking quietly absorbs 2–4 tbsp of oil a day — that's 240–480 kcal, enough to erase the whole deficit. The budget here allocates 1½ tbsp (him) / 1 tbsp (her) per day across all dishes. Measure with an actual spoon for the first two weeks until the eye calibrates. This single line item decides whether the plan works.",
  },
  {
    kind: "info",
    title: "Apple cider vinegar — what it does and doesn't do",
    body: "Honest read: the weight-loss evidence is weak. Expect at most mild appetite blunting and a small post-meal glucose effect — it will not change the timeline. Protocol since it's bought: 1 tbsp (15ml) in a full glass of water, 10–15 min before the main meal. Max 2 tbsp/day. Never undiluted — it erodes tooth enamel and irritates the throat. Rinse mouth after. Skip entirely if there's any gastritis or acid reflux. It does not break the fast.",
  },
  {
    kind: "success",
    title: "Tracking — one non-negotiable rule",
    body: "Weigh every morning — same time, after toilet, before eating. Log the weekly average in the Track tab, not daily numbers. Daily weight swings 1–2 kg on water alone. If 3 consecutive weeks show zero movement, audit weekend eating first — that's where deficits disappear.",
  },
  {
    kind: "info",
    title: "During the fasting window",
    body: "Water, black tea or coffee without sugar, lemon water with no sugar. Anything with calories — even milk in tea — technically breaks the fast. If milk tea is non-negotiable, it comes out of the fruit/tea budget and stays inside the eating window.",
  },
  {
    kind: "info",
    title: "Protein — counted, not assumed",
    body: "v1 of this plan claimed example meals hit 110g; the real sum was ~85g. Corrected floors: him 95g (stretch 110), her 78g (stretch 90). Hitting the stretch on BD food requires deliberately adding 100g chicken/fish or 2 extra eggs somewhere. Eggs are the cheapest protein per taka — when in doubt, add an egg. Use the protein counter in the Plan tab; don't estimate.",
  },
  {
    kind: "warn",
    title: "Sleep — the invisible factor",
    body: "Poor sleep raises cortisol, which increases hunger and works against fat loss. 7–8 hours is part of the plan, not a bonus. Phone off 30 min before bed makes a measurable difference.",
  },
  {
    kind: "warn",
    title: "Rice portion — the most common mistake",
    body: "Him: ½ cup cooked per meal (a tennis ball). Her: 3–4 tablespoons cooked. Standard BD plates are 2–3× this. Visual anchor: your fist ≈ your rice portion. Dal and shak fill the rest of the plate.",
  },
  {
    kind: "danger",
    title: "Her hormonal signals — hard rules",
    body: "If energy crashes badly, mood drops, or the cycle becomes irregular within 4–6 weeks, the deficit is too aggressive. Add 150–200 kcal from protein (not carbs) and stay at 14:10. Hard floor: do not eat below 1,400 kcal — her BMR is ~1,440, and eating under it trades muscle for scale movement and rebounds. Slower at 1,590 is protective, not lazy.",
  },
  {
    kind: "info",
    title: "Plateau protocol",
    body: "Plateaus are normal at weeks 4–6. Check in order: (1) are weekends tracked, (2) is protein hitting the floor, (3) add 1,000 steps/day. Only cut 100 kcal after all three are ruled out.",
  },
  {
    kind: "success",
    title: "BD availability",
    body: "Chia: Chaldal, Meena Bazar health section — pricey. Flaxseed (tishi) is the cheaper substitute with a similar fiber profile. Everything else in this plan is standard bazar.",
  },
];

// ── Exercise plans — same movements, different loading ───────────────────────
// What differs by sex: starting volume, upper-body progression speed, and
// recovery rules under a deficit. Not the movements themselves.

interface ExSession { title: string; items: { name: string; detail: string }[]; }
interface ExPlan {
  walk: string;
  schedule: string;
  sessions: ExSession[];
  progressionRule: string;
  phases: { label: string; value: string; sub: string }[];
  deficitNote: string;
}

const EXERCISE_PLANS: Record<Person, ExPlan> = {
  m: {
    walk: "8,000–10,000 steps daily — this is the fat-loss engine, not the sessions below",
    schedule: "4 sessions/week alternating A–B (e.g. Sat A, Sun B, Tue A, Wed B) · ~20 min",
    sessions: [
      {
        title: "Day A — Lower body",
        items: [
          { name: "Squat", detail: "3 × 12–15 · full depth to chair height · 60–90s rest" },
          { name: "Stair step-up", detail: "3 × 15 per leg · drive through the heel" },
          { name: "Glute bridge", detail: "3 × 15 · 2s squeeze at top" },
          { name: "Plank", detail: "3 × 30–40s · hips level, no sag" },
        ],
      },
      {
        title: "Day B — Upper body + core",
        items: [
          { name: "Push-up ladder", detail: "3 × 8–12 · start incline (table), progress to floor by week 4–6" },
          { name: "Pike push-up", detail: "2 × 6–8 · add from week 7 · shoulders" },
          { name: "Bird-dog", detail: "3 × 10 per side · slow, no rotation" },
          { name: "Side plank", detail: "2 × 20–30s per side" },
        ],
      },
    ],
    progressionRule:
      "When you hit the top of a rep range on all sets two sessions in a row at ≤7/10 effort, progress: harder variation first, then +2 reps. Strength should hold or rise slightly even in deficit.",
    phases: [
      { label: "Weeks 1–3", value: "2 sets", sub: "groove form, build habit" },
      { label: "Weeks 4–6", value: "3 sets", sub: "floor push-ups by now" },
      { label: "Weeks 7+", value: "3 sets +load", sub: "backpack with books for squats/step-ups" },
    ],
    deficitNote:
      "If a session feels unusually heavy, cut one set per exercise rather than skipping. Never skip the walk.",
  },
  f: {
    walk: "7,000–9,000 steps daily — non-negotiable; the sessions below protect muscle, walking burns fat",
    schedule: "3–4 sessions/week alternating A–B · ~18 min",
    sessions: [
      {
        title: "Day A — Lower body",
        items: [
          { name: "Squat", detail: "3 × 10–12 · sit-to-chair for first 2 weeks, then free squat" },
          { name: "Stair step-up", detail: "2–3 × 12 per leg · hold rail for balance, not assistance" },
          { name: "Glute bridge", detail: "3 × 12–15 · 2s squeeze at top" },
          { name: "Plank", detail: "3 × 20–30s · knees-down version is a valid start" },
        ],
      },
      {
        title: "Day B — Upper body + core",
        items: [
          { name: "Push-up ladder", detail: "3 × 8–10 · wall → incline → knee. Floor push-ups by week 10–12 is the realistic timeline — upper-body strength builds slower in women; that's physiology, not effort" },
          { name: "Bird-dog", detail: "3 × 8 per side · slow and controlled" },
          { name: "Side plank", detail: "2 × 15–20s per side · knees-down start is fine" },
          { name: "Dead bug", detail: "2 × 10 · lower back stays pressed to floor" },
        ],
      },
    ],
    progressionRule:
      "Progress when the top of the rep range feels ≤7/10 effort two sessions running. In a deficit, strength staying flat IS the win — it means muscle is being kept while fat goes.",
    phases: [
      { label: "Weeks 1–3", value: "2 sets", sub: "form + habit, nothing heroic" },
      { label: "Weeks 4–6", value: "3 sets", sub: "incline push-ups solid" },
      { label: "Weeks 7+", value: "3 sets", sub: "knee → floor push-up path" },
    ],
    deficitNote:
      "Cycle rule: on low-energy days, drop one set per exercise and keep the walk. Two skipped sessions in a row plus mood/energy crash = the calorie deficit is too deep, not a discipline problem — see the hormonal-signals card in Tips.",
  },
};

// ── Small components ─────────────────────────────────────────────────────────

const chipStyle: Record<string, { bg: string; fg: string }> = {
  protein: { bg: C.greenSoft, fg: C.green },
  carb: { bg: C.turmericSoft, fg: C.carbFg },
  veg: { bg: C.limeSoft, fg: C.lime },
  warn: { bg: C.claySoft, fg: C.clay },
  default: { bg: C.card, fg: C.ink2 },
};

function ChipEl({ chip }: { chip: Chip }) {
  const s = chipStyle[chip.kind];
  return (
    <span
      className="inline-block text-xs px-2.5 py-1 rounded-lg"
      style={{ background: s.bg, color: s.fg }}
    >
      {chip.text}
    </span>
  );
}

const tipStyle: Record<Tip["kind"], { bg: string; fg: string; border: string }> = {
  success: { bg: C.greenSoft, fg: C.green, border: C.greenBorder },
  info: { bg: C.skySoft, fg: C.sky, border: C.skyBorder },
  warn: { bg: C.turmericSoft, fg: C.carbFg, border: C.turmericBorder },
  danger: { bg: C.claySoft, fg: C.clay, border: C.clayBorder },
};

function TipCard({ tip }: { tip: Tip }) {
  const s = tipStyle[tip.kind];
  return (
    <div className="rounded-xl px-4 py-3 mb-2.5" style={{ background: s.bg, border: `1px solid ${s.border}` }}>
      <p className="text-sm font-semibold mb-1" style={{ color: s.fg }}>{tip.title}</p>
      <p className="text-xs leading-relaxed" style={{ color: s.fg, opacity: 0.9 }}>{tip.body}</p>
    </div>
  );
}

function MealCard({ meal, profile }: { meal: Meal; profile: DerivedProfile }) {
  const [open, setOpen] = useState(false);
  const p = profile;
  const time = meal.id === "b" ? p.mealTime.b : meal.id === "main" ? p.mealTime.main : p.mealTime.eve;
  const kcal = meal.id === "b" ? p.mealKcal.b : meal.id === "main" ? p.mealKcal.main : p.mealKcal.eve;

  return (
    <div className="rounded-xl overflow-hidden mb-2.5" style={{ border: `1px solid ${C.line}`, background: C.surface }}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: C.ink }}>{meal.name}</p>
          <p className="text-xs mt-0.5" style={{ color: C.faint }}>{time}</p>
        </div>
        <span
          className="text-xs font-medium px-2.5 py-1 rounded-lg shrink-0"
          style={{ background: p.accentSoft, color: p.accent }}
        >
          {kcal} kcal
        </span>
        <span className="text-xs transition-transform duration-200" style={{ color: C.faint, transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: `1px solid ${C.line}` }}>
          {meal.warning && (
            <div className="text-xs rounded-lg px-3 py-2 mb-3 mt-2" style={{ background: C.claySoft, color: C.clay }}>
              {meal.warning}
            </div>
          )}
          {meal.options.map((opt) => (
            <div key={opt.label} className="mt-3">
              <div className="flex items-baseline justify-between mb-2">
                <p className="text-[11px] font-medium uppercase tracking-wide" style={{ color: C.faint }}>{opt.label}</p>
                <span className="text-[11px] shrink-0 ml-2" style={{ color: C.green }}>≈{opt.proteinG}g protein</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {opt.chips.map((c) => <ChipEl key={c.text} chip={c} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Live day strip (signature element) ───────────────────────────────────────

function DayStrip({ profile }: { profile: DerivedProfile }) {
  const p = profile;
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const hourNow = now.getHours() + now.getMinutes() / 60;
  const pct = (hourNow / 24) * 100;
  const inWindow = hourNow >= p.eatStart && hourNow < p.eatEnd;
  const eatLeft = (p.eatStart / 24) * 100;
  const eatWidth = ((p.eatEnd - p.eatStart) / 24) * 100;

  const fmt = (h: number) => {
    const hr = h % 12 === 0 ? 12 : h % 12;
    return `${hr}${h < 12 ? "am" : "pm"}`;
  };

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between mb-1.5">
        <p className="text-xs" style={{ color: C.faint }}>
          {p.window} window · eating {p.windowLabel}
        </p>
        <p className="text-xs font-medium" style={{ color: inWindow ? p.accent : C.sky }}>
          {inWindow ? `Eating window — closes ${fmt(p.eatEnd)}` : `Fasting — opens ${fmt(p.eatStart)}`}
        </p>
      </div>
      <div className="relative h-9 rounded-xl overflow-hidden" style={{ background: C.skySoft, border: `1px solid ${C.line}` }}>
        <div
          className="absolute top-0 bottom-0"
          style={{ left: `${eatLeft}%`, width: `${eatWidth}%`, background: p.accentSoft, borderLeft: `1px solid ${C.line}`, borderRight: `1px solid ${C.line}` }}
        />
        <div className="absolute top-0 bottom-0 flex items-center" style={{ left: `${eatLeft}%`, width: `${eatWidth}%` }}>
          <span className="text-[10px] font-medium mx-auto" style={{ color: p.accent }}>eat</span>
        </div>
        <div
          className="absolute top-0 bottom-0"
          style={{ left: `${pct}%`, width: 2, background: C.ink }}
          title="now"
        />
        <div
          className="absolute text-[9px] font-medium px-1 rounded"
          style={{ left: `min(${pct}%, 92%)`, top: 2, background: C.ink, color: C.paper, transform: "translateX(-50%)" }}
        >
          now
        </div>
      </div>
      <div className="flex justify-between mt-1 text-[10px]" style={{ color: C.faint }}>
        <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
      </div>
    </div>
  );
}

// ── Protein counter ──────────────────────────────────────────────────────────

function ProteinCounter({ profile }: { profile: DerivedProfile }) {
  const p = profile;
  const [counts, setCounts] = useState<Record<string, number>>({});
  const total = PROTEIN_ITEMS.reduce((s, it) => s + (counts[it.name] ?? 0) * it.g, 0);
  const pctFloor = Math.min(100, Math.round((total / p.proteinFloor) * 100));

  return (
    <div className="rounded-xl px-4 py-3 mb-5" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-sm font-medium" style={{ color: C.ink }}>Today's protein</p>
        <p className="text-sm" style={{ color: total >= p.proteinFloor ? C.green : C.clay, fontVariantNumeric: "tabular-nums" }}>
          <span className="font-semibold">{total}g</span> / {p.proteinFloor}g floor
        </p>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden mb-3" style={{ background: C.card }}>
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pctFloor}%`, background: total >= p.proteinFloor ? C.green : C.turmeric }} />
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {PROTEIN_ITEMS.map((it) => {
          const n = counts[it.name] ?? 0;
          return (
            <div key={it.name} className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: C.ink }}>{it.name} <span style={{ color: C.faint }}>· {it.g}g</span></span>
              <button
                onClick={() => setCounts({ ...counts, [it.name]: Math.max(0, n - 1) })}
                className="w-7 h-7 rounded-lg text-sm"
                style={{ background: C.card, color: C.ink }}
                aria-label={`remove ${it.name}`}
              >−</button>
              <span className="text-xs w-5 text-center" style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{n}</span>
              <button
                onClick={() => setCounts({ ...counts, [it.name]: n + 1 })}
                className="w-7 h-7 rounded-lg text-sm"
                style={{ background: p.accentSoft, color: p.accent }}
                aria-label={`add ${it.name}`}
              >+</button>
            </div>
          );
        })}
      </div>
      <p className="text-[10px] mt-2.5" style={{ color: C.faint }}>
        Resets when the page reloads — it's a day counter, not a log. Stretch target: {p.proteinStretch}g.
      </p>
    </div>
  );
}

// ── Week tab: editable rotation backed by the food KB ─────────────────────────

function WeekTab({ profile }: { profile: DerivedProfile }) {
  const p = profile;
  const [rotation, setRotation] = useState<RotationDay[]>(DEFAULT_ROTATION);
  const [customFoods, setCustomFoods] = useState<Food[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [editDay, setEditDay] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [showKB, setShowKB] = useState(false);
  const [nf, setNf] = useState({ name: "", portion: "", kcal: "", proteinG: "", cat: "veg" as FoodCat });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([storeGet("rotation_v1"), storeGet("custom_foods"), storeGet("hidden_foods")]).then(
      ([r, c, h]) => {
        if (!alive) return;
        try { if (r) setRotation(JSON.parse(r)); } catch {}
        try { if (c) setCustomFoods(JSON.parse(c)); } catch {}
        try { if (h) setHidden(JSON.parse(h)); } catch {}
        setLoaded(true);
      }
    );
    return () => { alive = false; };
  }, []);

  const allFoods = useMemo(
    () => [...FOOD_DB.filter((f) => !hidden.includes(f.name)), ...customFoods],
    [hidden, customFoods]
  );
  const byName = useMemo(() => {
    const m: Record<string, Food> = {};
    allFoods.forEach((f) => { m[f.name] = f; });
    return m;
  }, [allFoods]);

  const saveRotation = async (next: RotationDay[]) => {
    setRotation(next);
    await storeSet("rotation_v1", JSON.stringify(next));
  };

  const addToDay = async (day: string, name: string) => {
    if (!name) return;
    const next = rotation.map((d) =>
      d.day === day && !d.items.includes(name) ? { ...d, items: [...d.items, name] } : d
    );
    setPick("");
    await saveRotation(next);
  };

  const removeFromDay = async (day: string, name: string) => {
    await saveRotation(rotation.map((d) => (d.day === day ? { ...d, items: d.items.filter((i) => i !== name) } : d)));
  };

  const removeFood = async (name: string) => {
    const isCustom = customFoods.some((f) => f.name === name);
    if (isCustom) {
      const next = customFoods.filter((f) => f.name !== name);
      setCustomFoods(next);
      await storeSet("custom_foods", JSON.stringify(next));
    } else {
      const next = [...hidden, name];
      setHidden(next);
      await storeSet("hidden_foods", JSON.stringify(next));
    }
    // also drop from rotation so days never reference a removed food
    await saveRotation(rotation.map((d) => ({ ...d, items: d.items.filter((i) => i !== name) })));
  };

  const restoreDefaults = async () => {
    setHidden([]);
    await storeSet("hidden_foods", JSON.stringify([]));
  };

  const addCustomFood = async () => {
    const kcal = parseInt(nf.kcal, 10);
    const proteinG = parseFloat(nf.proteinG || "0");
    if (!nf.name.trim() || isNaN(kcal) || kcal < 0 || kcal > 2000) return;
    if (byName[nf.name.trim()]) return; // no duplicate names
    const food: Food = {
      name: nf.name.trim(),
      portion: nf.portion.trim() || "1 serving",
      kcal,
      proteinG: isNaN(proteinG) ? 0 : proteinG,
      cat: nf.cat,
    };
    const next = [...customFoods, food];
    setCustomFoods(next);
    setNf({ name: "", portion: "", kcal: "", proteinG: "", cat: "veg" });
    await storeSet("custom_foods", JSON.stringify(next));
  };

  const dayTotals = (d: RotationDay) =>
    d.items.reduce(
      (acc, n) => {
        const f = byName[n];
        return f ? { kcal: acc.kcal + f.kcal, p: acc.p + f.proteinG } : acc;
      },
      { kcal: 0, p: 0 }
    );

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: C.faint }}>
        Rotation — tap a day to edit
      </p>
      {!loaded && <p className="text-xs mb-2" style={{ color: C.faint }}>Loading…</p>}
      <div className="space-y-1.5 mb-2">
        {rotation.map((d) => {
          const t = dayTotals(d);
          const editing = editDay === d.day;
          return (
            <div key={d.day} className="rounded-xl" style={{ background: editing ? C.surface : C.card, border: `1px solid ${editing ? p.accent : C.line}` }}>
              <button
                onClick={() => { setEditDay(editing ? null : d.day); setPick(""); }}
                className="w-full flex items-center gap-3 px-3 py-2 text-left"
              >
                <span className="text-[10px] font-semibold uppercase w-8 shrink-0" style={{ color: C.faint }}>{d.day}</span>
                <span className="text-xs flex-1 truncate" style={{ color: C.ink }}>
                  {d.items.length ? d.items.join(" · ") : <span style={{ color: C.faint }}>empty — tap to add</span>}
                </span>
                <span className="text-[10px] shrink-0" style={{ color: C.faint, fontVariantNumeric: "tabular-nums" }}>
                  {t.kcal} kcal · {Math.round(t.p)}g P
                </span>
              </button>
              {editing && (
                <div className="px-3 pb-3" style={{ borderTop: `1px solid ${C.line}` }}>
                  <div className="flex flex-wrap gap-1.5 mt-2.5 mb-2.5">
                    {d.items.map((n) => (
                      <span key={n} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg" style={{ background: p.accentSoft, color: p.accent }}>
                        {n}
                        <button onClick={() => removeFromDay(d.day, n)} aria-label={`remove ${n}`} style={{ color: p.accent, fontWeight: 600 }}>×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={pick}
                      onChange={(e) => setPick(e.target.value)}
                      className="flex-1 text-xs px-2 py-2 rounded-xl"
                      style={{ border: `1px solid ${C.line}`, background: C.surface, color: C.ink }}
                    >
                      <option value="">Add food…</option>
                      {CAT_ORDER.map((cat) => {
                        const foods = allFoods.filter((f) => f.cat === cat && !d.items.includes(f.name));
                        if (!foods.length) return null;
                        return (
                          <optgroup key={cat} label={CAT_LABEL[cat]}>
                            {foods.map((f) => (
                              <option key={f.name} value={f.name}>{f.name} — {f.kcal} kcal / {f.portion}</option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                    <button
                      onClick={() => addToDay(d.day, pick)}
                      className="px-4 py-2 rounded-xl text-xs font-medium"
                      style={{ background: p.accent, color: C.onAccent }}
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] mb-5" style={{ color: C.faint }}>
        Day totals count rotation items only — staples, oil and fruit live in the daily budget on the Plan tab.
        Edits save automatically.
      </p>

      <button
        onClick={() => setShowKB(!showKB)}
        className="w-full flex items-center justify-between px-4 py-3 rounded-xl mb-2"
        style={{ background: C.surface, border: `1px solid ${C.line}` }}
      >
        <span className="text-sm font-medium" style={{ color: C.ink }}>Food knowledge base · {allFoods.length} items</span>
        <span className="text-xs" style={{ color: C.faint, transform: showKB ? "rotate(180deg)" : "none" }}>▼</span>
      </button>

      {showKB && (
        <div className="rounded-xl px-4 py-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
          {/* Add custom food */}
          <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: C.faint }}>Add a food</p>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} placeholder="Name"
              className="text-xs px-2.5 py-2 rounded-xl outline-none" style={{ border: `1px solid ${C.line}`, color: C.ink }} />
            <input value={nf.portion} onChange={(e) => setNf({ ...nf, portion: e.target.value })} placeholder="Portion (e.g. 1 bowl)"
              className="text-xs px-2.5 py-2 rounded-xl outline-none" style={{ border: `1px solid ${C.line}`, color: C.ink }} />
            <input value={nf.kcal} onChange={(e) => setNf({ ...nf, kcal: e.target.value })} placeholder="kcal" type="number" inputMode="numeric"
              className="text-xs px-2.5 py-2 rounded-xl outline-none" style={{ border: `1px solid ${C.line}`, color: C.ink }} />
            <input value={nf.proteinG} onChange={(e) => setNf({ ...nf, proteinG: e.target.value })} placeholder="protein g" type="number" inputMode="decimal"
              className="text-xs px-2.5 py-2 rounded-xl outline-none" style={{ border: `1px solid ${C.line}`, color: C.ink }} />
          </div>
          <div className="flex gap-2 mb-4">
            <select value={nf.cat} onChange={(e) => setNf({ ...nf, cat: e.target.value as FoodCat })}
              className="flex-1 text-xs px-2 py-2 rounded-xl" style={{ border: `1px solid ${C.line}`, background: C.surface, color: C.ink }}>
              {CAT_ORDER.map((c2) => <option key={c2} value={c2}>{CAT_LABEL[c2]}</option>)}
            </select>
            <button onClick={addCustomFood} className="px-4 py-2 rounded-xl text-xs font-medium" style={{ background: p.accent, color: C.onAccent }}>
              Save food
            </button>
          </div>

          {/* Browse / remove */}
          {CAT_ORDER.map((cat) => {
            const foods = allFoods.filter((f) => f.cat === cat);
            if (!foods.length) return null;
            return (
              <div key={cat} className="mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: C.faint }}>{CAT_LABEL[cat]}</p>
                {foods.map((f) => (
                  <div key={f.name} className="flex items-baseline gap-2 py-1" style={{ borderBottom: `1px solid ${C.line}` }}>
                    <span className="text-xs flex-1" style={{ color: C.ink }}>
                      {f.name} <span style={{ color: C.faint }}>· {f.portion}</span>
                      {f.note && <span style={{ color: C.clay }}> · {f.note}</span>}
                    </span>
                    <span className="text-[11px] shrink-0" style={{ color: C.faint, fontVariantNumeric: "tabular-nums" }}>
                      {f.kcal} kcal · {f.proteinG}g
                    </span>
                    <button onClick={() => removeFood(f.name)} className="text-xs shrink-0 ml-1" style={{ color: C.clay }} aria-label={`remove ${f.name}`}>×</button>
                  </div>
                ))}
              </div>
            );
          })}
          {hidden.length > 0 && (
            <button onClick={restoreDefaults} className="text-xs mt-1" style={{ color: C.sky }}>
              Restore {hidden.length} removed default {hidden.length === 1 ? "item" : "items"}
            </button>
          )}
          <p className="text-[10px] mt-3" style={{ color: C.faint }}>
            Values are typical home-cooked estimates (±15%). Removing a built-in hides it (restorable); custom foods delete outright. Removed foods also leave the rotation.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Track tab: projection chart + weigh-in log ───────────────────────────────

interface LogEntry { date: string; kg: number; }

function TrackTab({ person, profile }: { person: Person; profile: DerivedProfile }) {
  const p = profile;
  const storageKey = `wlog_${person}`;
  const [log, setLog] = useState<LogEntry[]>([]);
  const [input, setInput] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    storeGet(storageKey).then((raw) => {
      if (!alive) return;
      if (raw) {
        try { setLog(JSON.parse(raw)); } catch {}
      } else {
        setLog([]);
      }
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [storageKey]);

  const projection = p.projection;
  const weeksToGoal = projection.length - 1;

  const addEntry = async () => {
    const kg = parseFloat(input);
    if (isNaN(kg) || kg < 30 || kg > 200) return;
    const entry = { date: new Date().toISOString().slice(0, 10), kg: +kg.toFixed(1) };
    const next = [...log.filter((e) => e.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date));
    setLog(next);
    setInput("");
    await storeSet(storageKey, JSON.stringify(next));
  };

  const removeEntry = async (date: string) => {
    const next = log.filter((e) => e.date !== date);
    setLog(next);
    await storeSet(storageKey, JSON.stringify(next));
  };

  // Chart geometry
  const W = 560, H = 200, PAD = 28;
  const maxKg = p.startKg + 1;
  const minKg = p.targetKg - 1;
  const x = (week: number) => PAD + (week / weeksToGoal) * (W - PAD * 2);
  const y = (kg: number) => PAD + ((maxKg - kg) / (maxKg - minKg)) * (H - PAD * 2);
  const path = projection.map((kg, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(kg).toFixed(1)}`).join(" ");

  const firstLogDate = log[0]?.date;
  const weekOf = (date: string) => {
    if (!firstLogDate) return 0;
    const d0 = new Date(firstLogDate).getTime();
    const d1 = new Date(date).getTime();
    return Math.round((d1 - d0) / (7 * 24 * 3600 * 1000));
  };

  return (
    <div>
      <div className="rounded-xl px-4 py-3 mb-4" style={{ background: C.skySoft, border: `1px solid ${C.skyBorder}` }}>
        <p className="text-xs leading-relaxed" style={{ color: C.sky }}>
          <span className="font-semibold">This curve is honest, not linear.</span> Weeks 1–2 drop fast (water and glycogen, not fat).
          After that the body's burn rate shrinks as weight falls, so the curve flattens.
          {p.reached ? (
            <> Realistic timeline at the current target intake: <span className="font-semibold">~{weeksToGoal} weeks</span> ({p.startKg} → {p.targetKg} kg).</>
          ) : (
            <> At this intake the curve flattens <span className="font-semibold">before</span> reaching {p.targetKg} kg — burn rate catches up to intake. To go lower you'd need more daily activity (raises burn) rather than eating less. Adjust activity in Setup.</>
          )} Being above the line for a week or two means nothing; three weeks flat means audit weekends and protein.
        </p>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full mb-4" role="img" aria-label="Weight projection">
        {[p.startKg, Math.round((p.startKg + p.targetKg) / 2), p.targetKg].map((kg) => (
          <g key={kg}>
            <line x1={PAD} x2={W - PAD} y1={y(kg)} y2={y(kg)} stroke={C.line} strokeWidth="1" />
            <text x={PAD - 6} y={y(kg) + 3} fontSize="9" fill={C.faint} textAnchor="end">{kg}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke={p.accent} strokeWidth="2" strokeLinecap="round" />
        {log.map((e) => {
          const wk = Math.min(weekOf(e.date), weeksToGoal);
          return <circle key={e.date} cx={x(wk)} cy={y(Math.min(maxKg, Math.max(minKg, e.kg)))} r="3.5" fill={C.ink} />;
        })}
        <text x={W - PAD} y={H - 8} fontSize="9" fill={C.faint} textAnchor="end">week {weeksToGoal}</text>
        <text x={PAD} y={H - 8} fontSize="9" fill={C.faint}>week 0</text>
      </svg>

      <div className="flex gap-2 mb-3">
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Weekly average weight (kg)"
          className="flex-1 text-sm px-3 py-2 rounded-xl outline-none"
          style={{ border: `1px solid ${C.line}`, background: C.surface, color: C.ink }}
        />
        <button
          onClick={addEntry}
          className="px-4 py-2 rounded-xl text-sm font-medium"
          style={{ background: p.accent, color: C.onAccent }}
        >
          Log weight
        </button>
      </div>

      {!loaded && <p className="text-xs" style={{ color: C.faint }}>Loading log…</p>}
      {loaded && log.length === 0 && (
        <p className="text-xs" style={{ color: C.faint }}>
          No entries yet. Log one weekly average (morning weight, same time daily, averaged over the week). Dots appear on the curve.
        </p>
      )}
      {log.slice().reverse().map((e) => (
        <div key={e.date} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${C.line}` }}>
          <span className="text-xs" style={{ color: C.faint }}>{e.date}</span>
          <span className="text-sm font-medium" style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{e.kg} kg</span>
          <button onClick={() => removeEntry(e.date)} className="text-xs" style={{ color: C.clay }}>remove</button>
        </div>
      ))}
    </div>
  );
}

// ── Backup: export / import every persisted key ──────────────────────────────

const STORE_KEYS = ["bodies_v1", "rotation_v1", "custom_foods", "hidden_foods", "wlog_m", "wlog_f"];

async function collectBackup() {
  const data: Record<string, string> = {};
  for (const k of STORE_KEYS) {
    const v = await storeGet(k);
    if (v != null) data[k] = v;
  }
  return { app: "bd-if-plan", version: 1, exportedAt: new Date().toISOString(), data };
}

function triggerDownload(payload: object) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bd-if-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Returns number of keys backed up. Best-effort; throws on hard failure.
async function exportBackup(): Promise<number> {
  const payload = await collectBackup();
  triggerDownload(payload);
  await storeSet("last_backup", new Date().toISOString());
  return Object.keys(payload.data).length;
}

function sinceLabel(iso: string | null): string {
  if (!iso) return "never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function BackupPanel({ profile }: { profile: DerivedProfile }) {
  const p = profile;
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [last, setLast] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([storeGet("last_backup"), storeGet("auto_backup")]).then(([lb, ab]) => {
      if (!alive) return;
      setLast(lb);
      if (ab != null) setAuto(ab === "on");
    });
    return () => { alive = false; };
  }, []);

  const doExport = async () => {
    try {
      const n = await exportBackup();
      setLast(new Date().toISOString());
      setMsg({ kind: "ok", text: `Backup downloaded — ${n} ${n === 1 ? "item" : "items"} saved. Keep this file in Drive or email.` });
    } catch {
      setMsg({ kind: "err", text: "Export failed. Your browser may be blocking downloads." });
    }
  };

  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed?.app !== "bd-if-plan" || typeof parsed.data !== "object") {
        setMsg({ kind: "err", text: "That doesn't look like a BD IF backup file." });
        return;
      }
      let restored = 0;
      for (const k of STORE_KEYS) {
        if (typeof parsed.data[k] === "string") {
          await storeSet(k, parsed.data[k]);
          restored++;
        }
      }
      setMsg({ kind: "ok", text: `Restored ${restored} ${restored === 1 ? "item" : "items"}. Reloading…` });
      setTimeout(() => { try { location.reload(); } catch {} }, 700);
    } catch {
      setMsg({ kind: "err", text: "Couldn't read that file — is it the right .json?" });
    }
  };

  const toggleAuto = async () => {
    const next = !auto;
    setAuto(next);
    await storeSet("auto_backup", next ? "on" : "off");
  };

  const stale = !last || Date.now() - new Date(last).getTime() > 7 * 86400000;

  return (
    <div className="rounded-xl px-4 py-3 mb-3" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
      <p className="text-sm font-medium mb-1" style={{ color: C.ink }}>Backup &amp; restore</p>
      <p className="text-xs leading-relaxed mb-3" style={{ color: C.faint }}>
        All data lives only on this phone. Export a file before clearing browser data, switching phones, or reinstalling
        — then Import it on the other phone or after a wipe. Backs up both people's settings, logs, foods and rotation.
      </p>

      {stale && (
        <div className="rounded-lg px-3 py-2 mb-3 text-xs" style={{ background: C.claySoft, color: C.clay }}>
          <span className="font-semibold">No recent backup ({sinceLabel(last)}).</span> Export now so a cleared browser
          can't wipe your history.
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <button onClick={doExport} className="flex-1 px-4 py-2 rounded-xl text-sm font-medium" style={{ background: p.accent, color: C.onAccent }}>
          Export backup
        </button>
        <button onClick={() => fileRef.current?.click()} className="flex-1 px-4 py-2 rounded-xl text-sm font-medium" style={{ background: p.accentSoft, color: p.accent }}>
          Import backup
        </button>
        <input
          ref={fileRef} type="file" accept="application/json,.json" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ""; }}
        />
      </div>

      <button onClick={toggleAuto} className="flex items-center gap-2.5 w-full text-left">
        <span
          className="shrink-0 rounded-full transition-colors"
          style={{ width: 36, height: 20, background: auto ? p.accent : C.line, position: "relative" }}
        >
          <span style={{ position: "absolute", top: 2, left: auto ? 18 : 2, width: 16, height: 16, borderRadius: "50%", background: C.knob, transition: "left .15s" }} />
        </span>
        <span className="text-xs" style={{ color: C.ink }}>
          Auto-export on open <span style={{ color: C.faint }}>· makes a backup when you open the app and it's been a day</span>
        </span>
      </button>

      {msg && <p className="text-xs mt-2.5" style={{ color: msg.kind === "ok" ? C.green : C.clay }}>{msg.text}</p>}

      <p className="text-[10px] mt-2" style={{ color: C.faint }}>
        Last backup: {sinceLabel(last)}. Import overwrites matching data with the file's contents (it's a restore, not a
        merge). Auto-export only runs while the app is open — a closed app can't back itself up.
      </p>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

// ── Bottom navigation (replaces the old top tab strip) ───────────────────────

function TabIcon({ id, size = 22 }: { id: Tab; size?: number }) {
  const s = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.8,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (id) {
    case "plan":  return (<svg {...s}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 3h6v3H9z" /><path d="m9 13 2.5 2.5L16 11" /></svg>);
    case "week":  return (<svg {...s}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>);
    case "track": return (<svg {...s}><path d="M4 5v15h16" /><path d="m8 14 3-3 3 2 4-6" /></svg>);
    case "tips":  return (<svg {...s}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1 1 1.6l.1.5h4.8l.1-.5c.1-.6.4-1.1 1-1.6A6 6 0 0 0 12 3Z" /></svg>);
    case "move":  return (<svg {...s}><path d="M3 12h4l2-6 4 12 2-6h6" /></svg>);
    case "setup": return (<svg {...s}><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="16" x2="20" y2="16" /><circle cx="10" cy="8" r="2.2" /><circle cx="15" cy="16" r="2.2" /></svg>);
  }
}

function BottomNav({ tabs, tab, setTab, accent }: {
  tabs: { id: Tab; label: string }[]; tab: Tab; setTab: (t: Tab) => void; accent: string;
}) {
  return (
    <nav
      style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 40,
        background: C.surface, borderTop: `1px solid ${C.line}`,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="max-w-2xl mx-auto flex">
        {tabs.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-label={t.label}
              aria-current={active ? "page" : undefined}
              className="nav-item flex-1 flex flex-col items-center justify-center gap-1 py-2"
              style={{ color: active ? accent : C.faint, minHeight: 54 }}
            >
              <TabIcon id={t.id} />
              <span className="text-[10px] font-medium" style={{ letterSpacing: "0.01em" }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function DietPlan() {
  const [person, setPerson] = useState<Person>("m");
  const [tab, setTab] = useState<Tab>("plan");
  const [bodies, setBodies] = useState<Record<Person, Body>>(DEFAULT_BODY);
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light")
  );

  useEffect(() => {
    // Ask the browser not to evict our data under storage pressure (best-effort).
    try { (navigator as any).storage?.persist?.(); } catch {}

    // Auto-export on open: if enabled and the last backup is >24h old, drop a
    // fresh file. Only runs while the app is open; a closed PWA can't do this.
    (async () => {
      try {
        const auto = await storeGet("auto_backup");
        if (auto === "off") return;
        const last = await storeGet("last_backup");
        const stale = !last || Date.now() - new Date(last).getTime() > 86400000;
        const hasData = (await storeGet("wlog_m")) || (await storeGet("wlog_f")) || (await storeGet("bodies_v1"));
        if (stale && hasData) {
          await exportBackup();
        }
      } catch {}
    })();

    let alive = true;
    storeGet("bodies_v1").then((raw) => {
      if (!alive) return;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setBodies({ m: { ...DEFAULT_BODY.m, ...parsed.m }, f: { ...DEFAULT_BODY.f, ...parsed.f } });
        } catch {}
      }
      setCfgLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  // Theme: use the saved choice, else follow the OS. Apply to <html> on load.
  useEffect(() => {
    let alive = true;
    storeGet("theme").then((saved) => {
      if (!alive) return;
      const resolved: Theme = saved === "dark" || saved === "light" ? saved : (prefersDark() ? "dark" : "light");
      setTheme(resolved);
      applyTheme(resolved, false);
    });
    return () => { alive = false; };
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next, true);
    storeSet("theme", next);
  };

  const saveBody = async (per: Person, body: Body) => {
    const next = { ...bodies, [per]: body };
    setBodies(next);
    await storeSet("bodies_v1", JSON.stringify(next));
  };

  const derived = useMemo(() => ({
    m: deriveProfile("m", bodies.m),
    f: deriveProfile("f", bodies.f),
  }), [bodies]);

  const p = derived[person];

  const projWeeks = p.realisticWeeks;

  const stats = [
    { label: "daily target", value: p.intake.toLocaleString(), sub: "kcal/day" },
    { label: "protein floor", value: `${p.proteinFloor}g`, sub: `stretch ${p.proteinStretch}g` },
    { label: "to lose", value: `${p.startKg - p.targetKg} kg`, sub: `${p.startKg} → ${p.targetKg}` },
    { label: "realistic", value: `~${projWeeks} wks`, sub: "non-linear" },
    { label: "window", value: p.window, sub: p.windowLabel },
  ];

  const TABS: { id: Tab; label: string }[] = [
    { id: "plan", label: "Plan" },
    { id: "week", label: "Week" },
    { id: "track", label: "Track" },
    { id: "tips", label: "Tips" },
    { id: "move", label: "Move" },
    { id: "setup", label: "Setup" },
  ];

  const ledgerTotal = p.ledger.reduce((s, l) => s + l.kcal, 0);

  return (
    <div style={{ background: C.paper, minHeight: "100vh" }}>
      <div className="max-w-2xl mx-auto px-4 pt-6" style={{ paddingBottom: "calc(84px + env(safe-area-inset-bottom))" }}>
        <div className="flex items-start justify-between gap-3 mb-5">
          <div className="min-w-0">
            <h1 className="text-4xl leading-tight mb-1" style={{ fontFamily: serif, fontWeight: 600, letterSpacing: "-0.02em", color: C.ink }}>
              BD Intermittent Fasting Plan
            </h1>
            <p className="text-sm" style={{ color: C.faint }}>
              For two people, Bangladesh summer · counted, not estimated
            </p>
          </div>
          <button
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="shrink-0 grid place-items-center rounded-xl"
            style={{ width: 40, height: 40, background: C.surface, border: `1px solid ${C.line}`, color: C.ink }}
          >
            {theme === "dark" ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
            )}
          </button>
        </div>

        {/* Person toggle */}
        <div className="grid grid-cols-2 gap-2 mb-5">
          {(["m", "f"] as Person[]).map((per) => {
            const pp = derived[per];
            const active = person === per;
            return (
              <button
                key={per}
                onClick={() => setPerson(per)}
                className="rounded-xl px-4 py-3 text-left transition-colors"
                style={{
                  background: active ? pp.accentSoft : C.surface,
                  border: `1px solid ${active ? pp.accent : C.line}`,
                }}
              >
                <p className="text-sm font-semibold" style={{ color: active ? pp.accent : C.faint }}>{pp.label}</p>
                <p className="text-xs mt-0.5" style={{ color: C.faint }}>
                  {pp.startKg} → {pp.targetKg} kg · {pp.window}
                </p>
              </button>
            );
          })}
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-1.5 mb-6">
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl p-2.5" style={{ background: C.card }}>
              <p className="text-[9px] uppercase tracking-wide mb-1" style={{ color: C.faint }}>{s.label}</p>
              <p className="text-base font-semibold leading-tight" style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{s.value}</p>
              <p className="text-[9px] mt-0.5" style={{ color: C.faint }}>{s.sub}</p>
            </div>
          ))}
        </div>

        <DayStrip profile={p} />

        {/* Section content — navigation lives in the fixed BottomNav below */}

        {/* ── Plan ── */}
        {tab === "plan" && (
          <div>
            <ProteinCounter profile={p} />

            {MEALS.map((m) => <MealCard key={m.id} meal={m} profile={p} />)}

            {/* Calorie ledger — the reconciliation v1 was missing */}
            <div className="rounded-xl px-4 py-3 mt-4 mb-4" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
              <p className="text-sm font-medium mb-2" style={{ color: C.ink }}>Where the {p.intake.toLocaleString()} kcal goes</p>
              {p.ledger.map((l) => (
                <div key={l.item} className="flex justify-between text-xs py-1" style={{ color: C.faint }}>
                  <span>{l.item}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", color: C.ink }}>{l.kcal}</span>
                </div>
              ))}
              <div className="flex justify-between text-xs pt-1.5 mt-1 font-semibold" style={{ borderTop: `1px solid ${C.line}`, color: C.ink }}>
                <span>Total</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{ledgerTotal}</span>
              </div>
              <p className="text-[10px] mt-2" style={{ color: C.clay }}>
                Oil is a budget line, not a free extra. Unmeasured cooking oil is how this plan fails silently.
              </p>
            </div>

            <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: C.faint }}>Summer fruits</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {["watermelon", "papaya", "guava", "jamrul", "pineapple", "banana"].map((f) => (
                <span key={f} className="text-xs px-2.5 py-1 rounded-lg" style={{ background: C.plumSoft, color: C.plum }}>{f}</span>
              ))}
              <span className="text-xs px-2.5 py-1 rounded-lg" style={{ background: C.turmericSoft, color: C.carbFg }}>
                mango — max 1 medium/day, pair with protein
              </span>
            </div>

            <div className="rounded-xl px-4 py-3 text-xs" style={{ background: C.greenSoft, border: `1px solid ${C.greenBorder}`, color: C.green }}>
              <span className="font-semibold">Treat rule: </span>
              once a week — biryani, fuchka, burger, ice cream — reduced portion. Twice a week during active fat loss
              wipes out the deficit.
            </div>
          </div>
        )}

        {/* ── Week ── */}
        {tab === "week" && <WeekTab profile={p} />}

        {/* ── Track ── */}
        {tab === "track" && <TrackTab person={person} profile={p} />}

        {/* ── Tips ── */}
        {tab === "tips" && (
          <div>
            {TIPS.map((tip) => <TipCard key={tip.title} tip={tip} />)}
          </div>
        )}

        {/* ── Move ── */}
        {tab === "move" && (() => {
          const ex = EXERCISE_PLANS[person];
          return (
            <div>
              <div className="rounded-xl px-4 py-3 text-xs mb-3" style={{ background: C.skySoft, border: `1px solid ${C.skyBorder}`, color: C.sky }}>
                <span className="font-semibold">Honest note: </span>
                the movements are the same for both of you — what differs is loading, progression speed, and recovery
                rules in a deficit. These sessions protect muscle; the daily walk does the fat-loss work.
              </div>

              <div className="rounded-xl px-4 py-3 mb-4" style={{ background: p.accentSoft, border: `1px solid ${p.accent}` }}>
                <p className="text-xs font-semibold mb-1" style={{ color: p.accent }}>{p.label}'s targets</p>
                <p className="text-xs leading-relaxed" style={{ color: p.accent }}>{ex.walk}</p>
                <p className="text-xs mt-1" style={{ color: p.accent, opacity: 0.85 }}>{ex.schedule}</p>
              </div>

              {ex.sessions.map((s) => (
                <div key={s.title} className="mb-4">
                  <p className="text-xs font-medium uppercase tracking-wide mb-2" style={{ color: C.faint }}>{s.title}</p>
                  <div className="space-y-2">
                    {s.items.map((it, i) => (
                      <div key={it.name} className="flex items-start gap-3 p-3 rounded-xl" style={{ background: C.surface, border: `1px solid ${C.line}` }}>
                        <div className="w-7 h-7 rounded-full text-xs font-semibold flex items-center justify-center shrink-0" style={{ background: p.accentSoft, color: p.accent }}>
                          {i + 1}
                        </div>
                        <div>
                          <p className="text-sm font-medium" style={{ color: C.ink }}>{it.name}</p>
                          <p className="text-xs mt-0.5 leading-relaxed" style={{ color: C.faint }}>{it.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div className="rounded-xl px-4 py-3 text-xs mb-4" style={{ background: C.card, color: C.ink }}>
                <span className="font-semibold">Progression rule: </span>{ex.progressionRule}
              </div>

              <p className="text-xs font-medium uppercase tracking-wide mb-3" style={{ color: C.faint }}>Phases</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {ex.phases.map((pr) => (
                  <div key={pr.label} className="rounded-xl p-3" style={{ background: C.card }}>
                    <p className="text-[10px] uppercase tracking-wide mb-1" style={{ color: C.faint }}>{pr.label}</p>
                    <p className="text-base font-semibold" style={{ color: C.ink }}>{pr.value}</p>
                    <p className="text-[10px] mt-0.5" style={{ color: C.faint }}>{pr.sub}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-xl px-4 py-3 text-xs" style={{ background: C.turmericSoft, border: `1px solid ${C.turmericBorder}`, color: C.carbFg }}>
                <span className="font-semibold">Deficit rule: </span>{ex.deficitNote}
              </div>
            </div>
          );
        })()}

        {/* ── Setup ── */}
        {tab === "setup" && (() => {
          const b = bodies[person];
          const num = (v: string, fallback: number) => {
            const n = parseFloat(v);
            return isNaN(n) ? fallback : n;
          };
          const field = (label: string, key: keyof Body, value: number, min: number, max: number, step = 1) => (
            <div>
              <label className="text-[10px] uppercase tracking-wide block mb-1" style={{ color: C.faint }}>{label}</label>
              <input
                type="number" inputMode="decimal" step={step} value={value}
                onChange={(e) => {
                  const v = Math.min(max, Math.max(min, num(e.target.value, value)));
                  saveBody(person, { ...b, [key]: v });
                }}
                className="w-full text-sm px-3 py-2 rounded-xl outline-none"
                style={{ border: `1px solid ${C.line}`, background: C.surface, color: C.ink }}
              />
            </div>
          );
          return (
            <div>
              <div className="rounded-xl px-4 py-3 mb-4 text-xs leading-relaxed" style={{ background: p.accentSoft, color: p.accent }}>
                Editing <span className="font-semibold">{p.label}</span>. Everything on the other tabs recalculates from these numbers.
                Switch person with the toggle above. Defaults are placeholders — set real values.
              </div>

              <BackupPanel profile={p} />

              {!cfgLoaded && <p className="text-xs mb-2" style={{ color: C.faint }}>Loading…</p>}

              <div className="grid grid-cols-2 gap-2 mb-3">
                {field("Current weight (kg)", "startKg", b.startKg, 35, 250, 0.5)}
                {field("Target weight (kg)", "targetKg", b.targetKg, 35, 250, 0.5)}
                {field("Height (cm)", "heightCm", b.heightCm, 120, 220)}
                {field("Age", "age", b.age, 16, 90)}
              </div>

              <label className="text-[10px] uppercase tracking-wide block mb-1" style={{ color: C.faint }}>Activity level</label>
              <select
                value={b.activity}
                onChange={(e) => saveBody(person, { ...b, activity: e.target.value as Activity })}
                className="w-full text-sm px-3 py-2 rounded-xl mb-3"
                style={{ border: `1px solid ${C.line}`, background: C.surface, color: C.ink }}
              >
                {(Object.keys(ACTIVITY) as Activity[]).map((a) => (
                  <option key={a} value={a}>{ACTIVITY[a].label}</option>
                ))}
              </select>

              <label className="text-[10px] uppercase tracking-wide block mb-1" style={{ color: C.faint }}>
                Preferred timeline — {b.weeks} weeks
              </label>
              <input
                type="range" min={4} max={80} step={1} value={b.weeks}
                onChange={(e) => saveBody(person, { ...b, weeks: parseInt(e.target.value, 10) })}
                className="w-full mb-4" style={{ accentColor: p.accent }}
              />

              {/* Live computed result */}
              <div className="rounded-xl overflow-hidden mb-3" style={{ border: `1px solid ${C.line}` }}>
                <div className="px-4 py-3" style={{ background: C.surface }}>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      { k: "BMR", v: p.bmr.toLocaleString(), s: "at rest" },
                      { k: "TDEE", v: p.tdee.toLocaleString(), s: "you burn/day" },
                      { k: "Eat", v: p.intake.toLocaleString(), s: "kcal target" },
                    ].map((m) => (
                      <div key={m.k}>
                        <p className="text-[9px] uppercase tracking-wide" style={{ color: C.faint }}>{m.k}</p>
                        <p className="text-lg font-semibold" style={{ color: C.ink, fontVariantNumeric: "tabular-nums" }}>{m.v}</p>
                        <p className="text-[9px]" style={{ color: C.faint }}>{m.s}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="px-4 py-2.5 text-xs" style={{ background: C.greenSoft, color: C.green }}>
                  Protein floor <span className="font-semibold">{p.proteinFloor}g</span> · stretch {p.proteinStretch}g ·
                  realistic time <span className="font-semibold">~{p.realisticWeeks} weeks</span>
                </div>
              </div>

              {/* Safety messaging */}
              {p.rateClamped && (
                <div className="rounded-xl px-4 py-3 mb-2 text-xs leading-relaxed" style={{ background: C.claySoft, border: `1px solid ${C.clayBorder}`, color: C.clay }}>
                  <span className="font-semibold">Timeline slowed for safety.</span> {b.weeks} weeks would need
                  ~{p.reqRate.toFixed(2)} kg/week — above the safe ceiling of ~1% bodyweight. The app set the fastest
                  safe pace instead (~{p.actualRate.toFixed(2)} kg/week). Going faster means losing muscle and rebounding,
                  not losing fat faster.
                </div>
              )}
              {p.atFloor && (
                <div className="rounded-xl px-4 py-3 mb-2 text-xs leading-relaxed" style={{ background: C.claySoft, border: `1px solid ${C.clayBorder}`, color: C.clay }}>
                  <span className="font-semibold">Held at the calorie floor.</span> The math wanted to go lower, but
                  {person === "f" ? " 1,300" : " 1,500"} kcal / your BMR is the floor for unsupervised dieting. Eating
                  under it trades muscle for scale movement. To lose faster, raise activity — not cut food.
                </div>
              )}
              {!p.reached && (
                <div className="rounded-xl px-4 py-3 mb-2 text-xs leading-relaxed" style={{ background: C.turmericSoft, border: `1px solid ${C.turmericBorder}`, color: C.carbFg }}>
                  <span className="font-semibold">Target may not be reachable at this intake.</span> As weight drops, burn
                  drops too, and it meets your intake before {p.targetKg} kg. Either accept a higher realistic end weight
                  or raise the activity level so you keep burning more.
                </div>
              )}

              <button
                onClick={() => saveBody(person, DEFAULT_BODY[person])}
                className="text-xs mt-1" style={{ color: C.sky }}
              >
                Reset {p.label} to defaults
              </button>
            </div>
          );
        })()}

        <p className="text-[10px] mt-8 text-center" style={{ color: C.faint }}>
          General guidance, not medical advice. Anyone with diabetes, thyroid issues, or on regular medication should
          clear fasting with a doctor first.
        </p>
      </div>

      <BottomNav tabs={TABS} tab={tab} setTab={setTab} accent={p.accent} />
    </div>
  );
}
