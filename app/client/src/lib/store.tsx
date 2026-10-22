// One place that loads the engine's data once and shares it across pages: the data-model report (/api/inputs),
// the map frames (/api/map) and the headline numbers (/api/overview). Pages that need more fetch it themselves.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { decode, getJSON, waitReady, type Frame } from "./api";

export interface Inputs {
  tables: any[];
  codes: Record<string, Record<string, any>>;
  model_outputs: Record<string, any>;
  model_run: { model_id: string; as_of_date: string; method: string; created_at: string; settings: any };
  coverage: { asset_class: string; active_with_forecast: number; expected_eol_next_year: number }[];
  notes: string[];
  priced_classes: string[];
  planning: Record<string, number>;
  restoration: { minutes: Record<string, number>; source: Record<string, string> };
  costs: any[];
  must_address: Record<string, number>;
  must_address_rule: Record<string, number>;
  value_status?: { asset_class: string; value_status: string; n: number }[];
  failure_share?: Record<string, number | null>;
  failure_share_years?: number | null;
  class_parameters?: { asset_class: string; parameter: string; value: number; unit: string; source: string }[];
  strategies?: { k: string; label: string; rule: string; optimizer: boolean }[];
  serving?: { backend: "lakebase" | "warehouse"; instance: string | null; error: string | null };
}

/** A map selection carried into Plan as the candidate population; v changes with every new selection. */
export interface Focus { ids: Set<string>; label: string; v?: number }

export interface Overview {
  by_class: {
    asset_class: string; active: number; expected_eol: number; mean_age: number; expected_failures: number;
    customer_minutes_at_risk: number; risk_usd: number; open_findings: number; priced: boolean;
    customers_interrupted?: number | null; eol_cost_usd?: number | null; failure_share?: number | null; failure_share_source?: string | null;
  }[];
  customers_served: number;
  feeder_customers?: Record<string, number>;
  feeders: number;
  as_of_date: string;
}

interface Store {
  stage: string;
  error: string | null;
  inputs: Inputs | null;
  overview: Overview | null;
  points: Frame | null;
  lines: Frame | null;
  // the current plan (asset_id -> plan year), shared between Plan, the map and Compare
  plan: Map<string, number> | null;
  setPlan: (p: Map<string, number> | null) => void;
  // a map selection (box / lasso / feeder) the user can carry into Plan as the candidate population
  focus: Focus | null;
  setFocus: (f: Focus | null) => void;
  // the asset class chosen on any page ("*" = all), shared by Territory risk and the map
  assetClass: string;
  setAssetClass: (c: string) => void;
  settings: PlanSettings;
  setSettings: (f: (s: PlanSettings) => PlanSettings) => void;
  // the current plan's response (Plan page), so Compare and the map can show it next to saved plans
  current: any | null;
  setCurrent: (r: any | null) => void;
  saved: SavedPlan[];
  savePlan: (name: string) => boolean;      // false = not kept (no current plan, or browser storage full)
  deletePlan: (id: string) => void;
}

// Plan settings, shared by Plan and Compare so both always describe the same plan and its alternatives.
export interface PlanSettings {
  strategy: string; budget: number; years: number; must: boolean; crew: string; classes: string[]; envelopes: Record<string, string>;
  bundleBy: string; useFocus: boolean; ageThreshold: string;
}
// bundleBy "auto": by device section wherever the data supplies shared visit costs, otherwise each unit is its own job
export const DEFAULT_SETTINGS: PlanSettings = { strategy: "value", budget: 15e6, years: 10, must: true, crew: "", classes: [], envelopes: {}, bundleBy: "auto", useFocus: true, ageThreshold: "60" };

// A plan saved for comparison: its settings (so it can be rebuilt), summary totals, and its schedule (for the maps).
export interface SavedPlan { v: 1; id: string; name: string; created: string; settings: PlanSettings; scope: string | null; summary: any; strategyLabel: string; ids: string[]; years: number[]; focusIds?: string[] }
const SAVED_PLANS_KEY = "armor.savedPlans";
const MAX_FOCUS_SAVED = 20000;   // larger map selections are saved by name only (too big for browser storage)

/** The key of a plan request: same key = same plan. */
export const settingsKey = (s: PlanSettings, focus: Focus | null) => JSON.stringify([s, s.useFocus && focus ? `${focus.label}|${focus.ids.size}|${focus.v ?? 0}` : ""]);

/** The request body for /api/plan, /api/frontier and /api/strategies from the shared settings. */
export function planRequest(s: PlanSettings, focus: Focus | null, budget = s.budget) {
  const scope = s.classes;
  return {
    strategy: s.strategy, budgets: Array(s.years).fill(budget), plan_years: s.years, crew: s.crew ? Array(s.years).fill(Number(s.crew)) : null, must_address: s.must,
    asset_ids: s.useFocus && focus ? [...focus.ids] : null, classes: scope.length ? scope : null, age_threshold: Number(s.ageThreshold) || 60,
    class_budgets: Object.fromEntries(Object.entries(s.envelopes).filter(([c, v]) => v && (!scope.length || scope.includes(c))).map(([c, v]) => [c, Number(v) * 1e6])),
    bundle_by: s.bundleBy,
  };
}

const Ctx = createContext<Store | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState("connecting");
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Inputs | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [points, setPoints] = useState<Frame | null>(null);
  const [lines, setLines] = useState<Frame | null>(null);
  const [plan, setPlan] = useState<Map<string, number> | null>(null);
  const [focus, setFocusRaw] = useState<Focus | null>(null);
  const setFocus = (f: Focus | null) => setFocusRaw(f ? { ...f, v: Date.now() } : null);
  const [assetClass, setAssetClass] = useState<string>("*");
  const [settings, setSettingsRaw] = useState<PlanSettings>(DEFAULT_SETTINGS);
  const setSettings = (f: (s: PlanSettings) => PlanSettings) => setSettingsRaw((s) => f(s));
  const [current, setCurrent] = useState<any | null>(null);
  const [saved, setSaved] = useState<SavedPlan[]>(() => {
    try { return (JSON.parse(localStorage.getItem(SAVED_PLANS_KEY) || "[]") as SavedPlan[]).filter((p) => p && p.v === 1 && Array.isArray(p.ids)); } catch { return []; }
  });
  const persist = (x: SavedPlan[]) => {
    try { localStorage.setItem(SAVED_PLANS_KEY, JSON.stringify(x)); } catch { return false; }
    setSaved(x);
    return true;
  };
  // a plan is saved with the settings and scope it was BUILT with (stored on the response), never the page's newer ones
  const savePlan = (name: string) => {
    if (!current?._settings) return false;
    const st: PlanSettings = current._settings, fx: Focus | null = current._focus ?? null;
    const p: SavedPlan = { v: 1, id: Math.random().toString(36).slice(2, 10), name, created: new Date().toISOString().slice(0, 16).replace("T", " "), settings: st,
      scope: st.useFocus && fx ? fx.label : null, summary: current.summary, strategyLabel: current.info?.strategy?.label ?? "",
      ids: current.plan_asset_ids, years: current.plan_years_of_assets,
      focusIds: st.useFocus && fx && fx.ids.size <= MAX_FOCUS_SAVED ? [...fx.ids] : undefined };
    return persist([...saved, p]);
  };
  const deletePlan = (id: string) => { persist(saved.filter((p) => p.id !== id)); };

  useEffect(() => {
    (async () => {
      try {
        await waitReady(setStage);
        setStage("loading");
        const [i, o] = await Promise.all([getJSON<Inputs>("/api/inputs"), getJSON<Overview>("/api/overview")]);
        setInputs(i);
        setOverview(o);
        setStage("ready");
        const m = await getJSON<{ points: any; lines: any }>("/api/map");
        setPoints(decode(m.points));
        setLines(decode(m.lines));
      } catch (e: any) {
        setError(String(e.message ?? e));
        (window as any).__armorError = String(e.message ?? e);
      }
    })();
  }, []);

  return <Ctx.Provider value={{ stage, error, inputs, overview, points, lines, plan, setPlan, focus, setFocus, assetClass, setAssetClass,
    settings, setSettings, current, setCurrent, saved, savePlan, deletePlan }}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside DataProvider");
  return s;
}
