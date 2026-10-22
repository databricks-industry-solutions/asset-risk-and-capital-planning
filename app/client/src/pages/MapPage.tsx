// Risk map, laid out like the original ARMOR explorer: summary bar on top, Controls + selection tools below it, a
// slide-in controls drawer on the left, a feeder tray on the right, and the asset drawer. Metric names, definitions
// and formulas come from lib/metrics (shared with every page). Colour scales are set from the data, never fixed.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  Button, Input, Label, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider, Spinner, Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ToggleGroup, ToggleGroupItem,
} from "@databricks/appkit-ui/react";
import { ArrowRight, Bookmark, Pause, Play, Download, Layers, Lasso, MousePointer2, SlidersHorizontal, Square, Trash2, X } from "lucide-react";
import { AssetMap, DARK_STYLE, LIGHT_STYLE, insidePolygon, type RGBA, type SelectMode } from "../components/AssetMap";
import { AssetSheet } from "../components/AssetSheet";
import { HistogramRange } from "../components/HistogramRange";
import { Info, Title } from "../components/Info";
import { GradientLegend, SwatchLegend } from "../components/Legend";
import { MultiSelect } from "../components/MultiSelect";
import { planColor, planLegend, type PlanView } from "../components/PlanTimeline";
import { postJSON, type Frame } from "../lib/api";
import { fmt1, fmtBig, fmtInt, fmtPct, fmtUsd } from "../lib/fmt";
import { M } from "../lib/metrics";
import { AGE_RAMP, BLUE_RAMP, RISK_RAMP, lerp, type RGB } from "../lib/ramps";
import { useStore } from "../lib/store";

type ColorBy = "p" | "cof" | "risk" | "saidi" | "age" | "findings" | "plan" | "matrix";
type FeederMetric = "riskPerAsset" | "risk" | "saidi" | "p";
const COLOR_MODES: { k: ColorBy; label: string }[] = [
  { k: "p", label: "P(end of life)" }, { k: "cof", label: "Consequence" }, { k: "risk", label: "Risk" }, { k: "saidi", label: "SAIDI" },
  { k: "age", label: "Age" }, { k: "matrix", label: "Risk matrix" }, { k: "findings", label: "Reject backlog" }, { k: "plan", label: "Plan year" },
];
const SAVED_KEY = "armor.savedSelections";
type Saved = { name: string; ids: string[]; created: string };
// the 5x5 matrix: cell severity = likelihood band + consequence band (0..8), green -> red
const matrixColor = (li: number, ci: number): RGB => lerp(RISK_RAMP, (li + ci) / 8);

function quantile(v: (number | null)[], q: number): number {
  const x = v.filter((a): a is number => a != null && Number.isFinite(a)).sort((a, b) => a - b);
  return x.length ? x[Math.min(x.length - 1, Math.floor(q * (x.length - 1)))] : 0;
}
const narrowed = (r: [number, number] | null, d: [number, number]) => !!r && (r[0] > d[0] + 1e-12 || r[1] < d[1] - 1e-12);

export default function MapPage() {
  const { points, lines, overview, plan: currentPlan, setFocus, assetClass, setAssetClass, saved: savedPlans, current } = useStore();
  // which plan the plan-year view shows: the current plan (Plan page) or a saved one
  const [planId, setPlanId] = useState<string>("current");
  const plan = useMemo(() => {
    if (planId === "current") return currentPlan;
    const p = savedPlans.find((x) => x.id === planId);
    return p ? new Map(p.ids.map((a, k) => [a, p.years[k]])) : currentPlan;
  }, [planId, currentPlan, savedPlans]);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const served = overview?.customers_served ?? 0;
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<SelectMode>("pointer");
  const [colorBy, setColorBy] = useState<ColorBy>(params.get("color") === "plan" ? "plan" : "risk");
  // time: 0 = today (actual state); 1..N = the projected state in that plan year under the selected plan
  const [year, setYear] = useState(0);
  const [planMode, setPlanMode] = useState<PlanView["mode"]>("through");
  const planView: PlanView = { year: year || null, mode: planMode };
  const [playing, setPlaying] = useState(false);
  const planYears = useMemo(() => { if (!plan) return 0; let m = 1; for (const v of plan.values()) if (v > m) m = v; return m; }, [plan]);
  const planLabel = planId === "current" ? (current?.info?.strategy?.label ? `current plan · ${current.info.strategy.label}` : "current plan") : savedPlans.find((p) => p.id === planId)?.name ?? "plan";
  const [fut, setFut] = useState<{ key: string; plan: Float32Array[]; ry: Int16Array; L: { plan: Float32Array[]; ry: Int16Array }; asOfYear: number; years: number } | null>(null);
  const [base, setBase] = useState<{ P: Float32Array[]; L: Float32Array[] } | null>(null);
  const [futBusy, setFutBusy] = useState(false);
  const planKey = planId === "current" ? `current|${current?._key ?? currentPlan?.size ?? 0}` : planId;
  const [feederMetric, setFeederMetric] = useState<FeederMetric>("riskPerAsset");
  const [basemap, setBasemap] = useState<"dark" | "light">("dark");
  const [classes, setClassesRaw] = useState<Set<string> | null>(null);
  const [feeders, setFeeders] = useState<Set<string>>(new Set());
  const [cohorts, setCohorts] = useState<Set<string>>(new Set());
  const [ranges, setRanges] = useState<Record<string, [number, number] | null>>({});
  const [onlyFindings, setOnlyFindings] = useState(false);
  const [network, setNetwork] = useState(true);
  const [byFeeder, setByFeeder] = useState(true);
  const [dot, setDot] = useState(1);
  const [lineW, setLineW] = useState(1);
  const [sel, setSel] = useState<[number, number][] | null>(null);
  const [cell, setCell] = useState<[number, number] | null>(null);
  const [savedSet, setSavedSet] = useState<{ name: string; ids: Set<string> } | null>(null);
  const [saved, setSaved] = useState<Saved[]>(() => { try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"); } catch { return []; } });
  const [asset, setAsset] = useState<string | null>(null);
  const [tray, setTray] = useState<string | null>(null);
  const [zoom, setZoom] = useState(10);
  const [fit, setFit] = useState<{ bounds: [[number, number], [number, number]]; key: string } | null>(null);
  const [selMsg, setSelMsg] = useState<string | null>(null);
  useEffect(() => {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); setSelMsg(null); }
    catch { setSelMsg("Saved for this session only: browser storage is full"); }
  }, [saved]);
  const allClasses = useMemo(() => (overview?.by_class ?? []).map((c) => c.asset_class), [overview]);

  // the class selection follows the rest of the app (Territory risk sets it too)
  useEffect(() => {
    if (classes || !allClasses.length) return;
    const c = params.get("class") ?? assetClass;
    setClassesRaw(new Set(c && c !== "*" ? [c] : allClasses));
  }, [allClasses]);
  const setClasses = (v: Set<string>) => { setClassesRaw(v); setAssetClass(v.size === 1 ? [...v][0] : v.size === allClasses.length ? "*" : assetClass); };
  const cls = classes ?? new Set<string>();
  // categorical views (risk matrix, plan year, reject backlog) always show individual assets
  const aggregated = byFeeder && zoom < 12.5 && !["matrix", "plan", "findings"].includes(colorBy);

  const saidiOf = (F: Frame) => F.num("customer_minutes_at_risk_next_year").map((x) => (x != null && served ? x / served : null));
  const colsToday = useMemo(() => {
    const get = (F: Frame | null) => {
      if (!F) return null;
      const of = F.codes("open_finding");   // the reject backlog: assets with an unresolved reject / priority reject
      return { p: F.num("p_end_of_life_next_year"), cof: F.num("cof_usd"), risk: F.num("risk_usd_next_year"), saidi: saidiOf(F), age: F.num("age_years"),
        cust: F.num("customers"), pf: F.num("expected_failures_next_year"), ci: F.num("expected_customers_interrupted_next_year"), lat: F.num("lat"), lon: F.num("lon"),
        rej: Array.from({ length: F.n }, (_, i) => !!(of && of.dict[of.codes[i]])), projected: null as boolean[] | null };
    };
    return { P: get(points), L: get(lines) };
  }, [points, lines, served]);

  // the projected state: every next-year metric is linear in P(end of life), so it scales by eol_t / P(end of life next
  // year); replaced units restart their age; today's backlog closes when the plan replaces the asset
  const project = (C: any, eol: Float32Array[] | undefined, ry: Int16Array | undefined, t: number) => {
    if (!C || !eol || t < 1) return C;
    const e = eol[t - 1], n = C.p.length;
    const out: any = { ...C, p: new Array(n), pf: new Array(n), risk: new Array(n), saidi: new Array(n), ci: new Array(n), age: new Array(n), rej: new Array(n), projected: new Array(n) };
    for (let i = 0; i < n; i++) {
      const v = e[i];
      if (!Number.isFinite(v)) {   // not projected (class not in dollar plans): today's values
        out.p[i] = C.p[i]; out.pf[i] = C.pf[i]; out.risk[i] = C.risk[i]; out.saidi[i] = C.saidi[i]; out.ci[i] = C.ci[i]; out.age[i] = C.age[i]; out.rej[i] = C.rej[i]; out.projected[i] = false;
        continue;
      }
      const f = C.p[i] ? v / C.p[i] : 0, y = ry ? ry[i] : 0, replaced = y > 0 && y <= t;
      out.p[i] = v;
      out.pf[i] = C.pf[i] == null ? null : C.pf[i] * f; out.risk[i] = C.risk[i] == null ? null : C.risk[i] * f;
      out.saidi[i] = C.saidi[i] == null ? null : C.saidi[i] * f; out.ci[i] = C.ci[i] == null ? null : C.ci[i] * f;
      out.age[i] = replaced ? t - y : C.age[i] == null ? null : C.age[i] + t - 1;
      out.rej[i] = C.rej[i] && !replaced; out.projected[i] = true;
    }
    return out;
  };
  const projected = year > 0 && !!fut && fut.key === planKey;   // only ever the selected plan's projection
  const cols = useMemo(() => (projected ? { P: project(colsToday.P, fut!.plan, fut!.ry, year), L: project(colsToday.L, fut!.L.plan, fut!.L.ry, year) } : colsToday),
    [colsToday, fut, year, projected]);
  const colsBase = useMemo(() => (projected && base ? { P: project(colsToday.P, base.P, undefined, year), L: project(colsToday.L, base.L, undefined, year) } : null),
    [colsToday, base, year, projected]);
  // scales and histogram domains from the data: 0 .. 99.5th percentile of every asset on the map
  const dom = useMemo(() => {   // fixed at today's values, so the projected years are comparable with today
    const all = (k: string) => [...((colsToday.P as any)?.[k] ?? []), ...((colsToday.L as any)?.[k] ?? [])];
    const d = (k: string, q = 0.995): [number, number] => [0, quantile(all(k), q) || 1];
    return { p: d("p"), cof: d("cof"), risk: d("risk"), saidi: d("saidi"), age: [0, Math.ceil(quantile(all("age"), 1))] as [number, number], cust: d("cust") };
  }, [colsToday]);

  const opts = useMemo(() => {
    if (!points) return { feeders: [] as string[], cohorts: [] as string[], cohortCounts: {} as Record<string, number> };
    const f = points.codes("feeder_id")!, c = points.codes("cohort")!;
    const cc: Record<string, number> = {};
    for (let i = 0; i < points.n; i++) { const k = c.dict[c.codes[i]] ?? ""; cc[k] = (cc[k] ?? 0) + 1; }
    return { feeders: (f.dict.filter(Boolean) as string[]).sort(), cohorts: Object.keys(cc).sort(), cohortCounts: cc };
  }, [points]);

  const RANGE_KEYS: { k: keyof typeof dom; label: string; fmt: (v: number) => string }[] = [
    { k: "p", label: M.pEol.label, fmt: (v) => fmtPct(v) }, { k: "cof", label: M.cof.label, fmt: (v) => fmtUsd(v) }, { k: "risk", label: M.risk.label, fmt: (v) => fmtUsd(v) },
    { k: "cust", label: M.customers.label, fmt: (v) => fmtInt(v) }, { k: "age", label: "Age (years)", fmt: (v) => v.toFixed(0) },
  ];
  // base filter: everything except the risk-matrix cell
  const baseFilter = (F: Frame | null, C: any) => {
    if (!F || !C) return [] as number[];
    const ac = F.codes("asset_class")!, fd = F.codes("feeder_id")!, ch = F.codes("cohort")!, of = F.codes("open_finding");
    const clsOk = ac.dict.map((c) => cls.has(c ?? "")), fdOk = fd.dict.map((f) => feeders.size === 0 || feeders.has(f ?? "")), chOk = ch.dict.map((c) => cohorts.size === 0 || cohorts.has(c ?? ""));
    const active = RANGE_KEYS.filter((r) => narrowed(ranges[r.k] ?? null, dom[r.k]));
    const out: number[] = [];
    for (let i = 0; i < F.n; i++) {
      if (!clsOk[ac.codes[i]] || !fdOk[fd.codes[i]] || !chOk[ch.codes[i]]) continue;
      let ok = true;
      for (const r of active) { const v = C[r.k][i], rr = ranges[r.k]!; if (v == null || v < rr[0] || v > rr[1]) { ok = false; break; } }
      if (!ok) continue;
      if (onlyFindings && !C.rej[i]) continue;
      if (savedSet && !savedSet.ids.has(F.str("asset_id", i)!)) continue;
      if (sel && !insidePolygon(C.lon[i]!, C.lat[i]!, sel)) continue;
      out.push(i);
    }
    return out;
  };
  const deps = [cls, feeders, cohorts, ranges, onlyFindings, sel, savedSet, dom];
  const basePIdx = useMemo(() => baseFilter(points, cols.P), [points, cols, ...deps]);
  const baseLIdx = useMemo(() => baseFilter(lines, cols.L), [lines, cols, ...deps]);

  // risk matrix: quintile bands of P(failure) and consequence among the assets shown that have both
  const matrix = useMemo(() => {
    const C = cols.P, C0 = colsToday.P;
    if (!C || !C0 || !points) return null;
    const ok = basePIdx.filter((i) => C.pf[i] != null && C.cof[i] != null);
    if (!ok.length) return null;
    // band edges from today's values (projected years are placed on today's bands)
    const qs = (v: (number | null)[]) => [0.2, 0.4, 0.6, 0.8].map((q) => quantile(ok.map((i) => v[i]), q));
    const lb = qs(C0.pf), cb = qs(C0.cof);
    const band = (x: number, b: number[]) => { let k = 0; while (k < 4 && x > b[k]) k++; return k; };
    const li = new Int8Array(points.n).fill(-1), ci = new Int8Array(points.n).fill(-1);
    const counts = Array.from({ length: 5 }, () => new Array(5).fill(0)), risk = Array.from({ length: 5 }, () => new Array(5).fill(0));
    for (const i of ok) { li[i] = band(C.pf[i]!, lb); ci[i] = band(C.cof[i]!, cb); counts[li[i]][ci[i]]++; risk[li[i]][ci[i]] += C.risk[i] ?? 0; }
    return { li, ci, counts, risk, lb, cb };
  }, [cols, basePIdx]);
  const pIdx = useMemo(() => (cell && matrix ? basePIdx.filter((i) => matrix.li[i] === cell[0] && matrix.ci[i] === cell[1]) : basePIdx), [basePIdx, cell, matrix]);
  const lIdx = cell ? [] : baseLIdx;

  const scaleKey = (c: ColorBy) => (c === "p" || c === "cof" || c === "risk" || c === "saidi" || c === "age" ? c : null);
  const pIdxSorted = useMemo(() => {
    const k = scaleKey(colorBy);
    if (!cols.P || !k) return pIdx;
    const v = (cols.P as any)[k];
    return [...pIdx].sort((a, b) => (v[a] ?? -1) - (v[b] ?? -1));
  }, [pIdx, cols, colorBy]);

  // feeder aggregates: zoomed-out view, hover and tray
  const aggOf = (C: any) => {
    if (!points || !C) return null;
    const fd = points.codes("feeder_id")!;
    const n = fd.dict.length, z = () => new Float64Array(n);
    const A = { assets: z(), eol: z(), fail: z(), cm: z(), risk: z(), rej: z(), cust: z(), known: z() };
    for (const i of pIdx) {
      const c = fd.codes[i];
      A.assets[c]++; A.eol[c] += C.p[i] ?? 0; A.fail[c] += C.pf[i] ?? 0; A.risk[c] += C.risk[i] ?? 0; if (C.pf[i] != null) A.known[c]++;
      A.cm[c] += C.saidi[i] ?? 0; if (C.rej[i]) A.rej[c]++; A.cust[c] = Math.max(A.cust[c], C.cust[i] ?? 0);
    }
    const value = Array.from({ length: n }, (_, c) => !A.assets[c] ? null : feederMetric === "riskPerAsset" ? A.risk[c] / A.assets[c] : feederMetric === "risk" ? A.risk[c] : feederMetric === "saidi" ? A.cm[c] : A.eol[c] / A.assets[c]);
    return { ...A, value, max: quantile(value, 0.95) || 1, dict: fd.dict, codes: fd.codes };
  };
  const feederMaxToday = useMemo(() => aggOf(colsToday.P)?.max ?? 1, [points, colsToday, pIdx, feederMetric]);
  const feederAgg = useMemo(() => { const g = aggOf(cols.P); return g ? { ...g, max: feederMaxToday } : null; }, [points, cols, pIdx, feederMetric, feederMaxToday]);
  const fmtFeeder = (v: number | null) => (v == null ? "–" : feederMetric === "p" ? fmtPct(v) : feederMetric === "saidi" ? `${v.toFixed(3)} min` : fmtUsd(v));

  const rgba = ([r, g, b]: RGB, a = 230): RGBA => [r, g, b, a];
  const colorFor = (F: Frame | null, C: any) => (i: number): RGBA => {
    if (!F || !C) return [0, 0, 0, 0];
    if (aggregated && feederAgg && F === points) {
      const v = feederAgg.value[feederAgg.codes[i]];
      return v == null ? [120, 130, 145, 60] : rgba(lerp(RISK_RAMP, v / feederAgg.max), 235);
    }
    if (colorBy === "plan") return planColor(plan?.get(F.str("asset_id", i)!), planView);
    if (colorBy === "findings") {
      const f = F.str("open_finding", i);
      return f === "priority_reject" ? [220, 38, 38, 255] : f === "reject" ? [249, 115, 22, 255] : [120, 130, 145, 35];
    }
    if (colorBy === "matrix") {
      if (F !== points || !matrix || matrix.li[i] < 0) return [120, 130, 145, 40];
      return rgba(matrixColor(matrix.li[i], matrix.ci[i]), 235);
    }
    const k = scaleKey(colorBy)!, v = C[k][i];
    if (v == null || !Number.isFinite(v)) return [120, 130, 145, 60];
    return rgba(lerp(k === "age" ? AGE_RAMP : k === "saidi" ? BLUE_RAMP : RISK_RAMP, v / (dom as any)[k][1]));
  };

  const summarize = (sets: [Frame | null, any, number[]][]) => {
    let n = 0, eol = 0, fail = 0, ci = 0, cm = 0, risk = 0, rej = 0, age = 0, anyFail = false, anyRisk = false;
    for (const [F, C, idx] of sets) {
      if (!F || !C) continue;
      for (const i of idx) {
        n++; eol += C.p[i] ?? 0; age += C.age[i] ?? 0;
        if (C.pf[i] != null) { fail += C.pf[i]; anyFail = true; }
        ci += C.ci[i] ?? 0; cm += C.saidi[i] ?? 0;
        if (C.risk[i] != null) { risk += C.risk[i]; anyRisk = true; }
        if (C.rej[i]) rej++;
      }
    }
    return { n, eol, fail: anyFail ? fail : null, saifi: anyFail && served ? ci / served : null, saidi: anyFail ? cm : null, risk: anyRisk ? risk : null, rej, age: n ? age / n : null };
  };
  const kpis = useMemo(() => summarize([[points, cols.P, pIdx], [lines, cols.L, lIdx]]), [pIdx, lIdx, cols]);
  const kpisToday = useMemo(() => (projected ? summarize([[points, colsToday.P, pIdx], [lines, colsToday.L, lIdx]]) : null), [pIdx, lIdx, colsToday, projected]);
  const kpisBase = useMemo(() => (colsBase ? summarize([[points, colsBase.P, pIdx], [lines, colsBase.L, lIdx]]) : null), [pIdx, lIdx, colsBase]);
  const delta = (k: string) => {
    if (!projected || !kpisToday) return undefined;
    const v = (kpis as any)[k], t = (kpisToday as any)[k], b = (kpisBase as any)?.[k];
    if (v == null || t == null) return undefined;
    const pct = (a: number, z: number) => (z ? `${a >= z ? "+" : "−"}${Math.abs(Math.round((a / z - 1) * 100))}%` : "–");
    return `${pct(v, t)} vs today${b != null ? `\n${pct(v, b)} vs do-nothing` : ""}`;
  };
  const idIndex = useMemo(() => { const m = new Map<string, number>(); if (points) for (let i = 0; i < points.n; i++) m.set(points.str("asset_id", i)!, i); return m; }, [points]);
  const lineIndex = useMemo(() => { const m = new Map<string, number>(); if (lines) for (let i = 0; i < lines.n; i++) m.set(lines.str("asset_id", i)!, i); return m; }, [lines]);
  const [futErr, setFutErr] = useState<string | null>(null);
  // the projection of the plan on screen: the client sends that plan's own schedule (current or saved)
  const futId = useRef(0);
  const loadFuture = async () => {
    if (!points || fut?.key === planKey) return;
    const sp = planId === "current" ? null : savedPlans.find((x) => x.id === planId);
    const ids = sp ? sp.ids : current?.plan_asset_ids, yrs = sp ? sp.years : current?.plan_years_of_assets;
    if (!ids || !yrs) return;
    const id = ++futId.current, key = planKey;
    setFutBusy(true); setFutErr(null);
    try {
      const r: any = await postJSON("/api/future", { asset_ids: ids, plan_years: yrs, base: !base });
      if (id !== futId.current) return;          // the plan changed while this was loading
      const place = (n: number, index: Map<string, number>) => {
        const pos = r.asset_ids.map((id: string) => index.get(id) ?? -1);
        const mk = (rows: number[][]) => rows.map((arr) => { const a = new Float32Array(n).fill(NaN); arr.forEach((v, k) => { if (pos[k] >= 0) a[pos[k]] = v * r.scale; }); return a; });
        const ry = new Int16Array(n); r.replace_year.forEach((v: number, k: number) => { if (pos[k] >= 0) ry[pos[k]] = v; });
        return { mk, ry };
      };
      const P = place(points.n, idIndex), L = place(lines?.n ?? 0, lineIndex);
      setFut({ key, plan: P.mk(r.plan), ry: P.ry, L: { plan: L.mk(r.plan), ry: L.ry }, asOfYear: r.as_of_year, years: r.years });
      if (r.do_nothing) setBase({ P: P.mk(r.do_nothing), L: L.mk(r.do_nothing) });
    } catch (e: any) { if (id === futId.current) { setFutErr(String(e.message)); setYear(0); } }
    if (id === futId.current) setFutBusy(false);
  };
  useEffect(() => { if (year > 0) loadFuture(); }, [year, planKey]);
  useEffect(() => { if (fut && fut.key !== planKey) setFut(null); }, [planKey]);
  // the plan's full length (a plan can have no work in its last years), not the last year with work
  const planLength = planId === "current" ? current?.info?.plan_years : savedPlans.find((p) => p.id === planId)?.settings.years;
  const maxYear = Math.max(1, planLength ?? (planYears || 10));
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => setYear((y) => { if (y >= maxYear) { setPlaying(false); return y; } return y + 1; }), 1500);
    return () => clearInterval(h);
  }, [playing, maxYear]);
  const calYear = (t: number) => (fut?.asOfYear ?? Number(String(overview?.as_of_date ?? "").slice(0, 4))) + t - 1;
  const ids = () => { const s = new Set<string>(); for (const i of pIdx) s.add(points!.str("asset_id", i)!); for (const i of lIdx) s.add(lines!.str("asset_id", i)!); return s; };

  const feederBounds = (f: string): [[number, number], [number, number]] | null => {
    if (!points || !cols.P) return null;
    const fd = points.codes("feeder_id")!, k = fd.dict.indexOf(f), { lat, lon } = cols.P;
    if (k < 0) return null;
    let a = 90, b = -90, c = 180, d = -180;
    for (let i = 0; i < points.n; i++) if (fd.codes[i] === k && lat[i] != null) { a = Math.min(a, lat[i]!); b = Math.max(b, lat[i]!); c = Math.min(c, lon[i]!); d = Math.max(d, lon[i]!); }
    return a <= b ? [[c, a], [d, b]] : null;
  };
  const openFeeder = (f: string) => { setFeeders(new Set([f])); setTray(f); const bb = feederBounds(f); if (bb) setFit({ bounds: bb, key: `${f}-${Date.now()}` }); };
  // a ?feeder= link opens that feeder once (not again on every year or filter change)
  const feederParam = params.get("feeder");
  const openedFeeder = useRef<string | null>(null);
  useEffect(() => {
    if (points && colsToday.P && feederParam && openedFeeder.current !== feederParam) { openedFeeder.current = feederParam; openFeeder(feederParam); }
  }, [points, colsToday, feederParam]);

  const exportCsv = () => {
    const header = ["asset_id", "asset_class", "cohort", "feeder_id", "age_years", "p_end_of_life_next_year", "expected_failures_next_year", "cof_usd", "risk_usd_next_year", "customers", "open_finding", "lat", "lon"];
    const strCols = new Set(["asset_id", "asset_class", "cohort", "feeder_id", "open_finding"]);
    const rows = [header.join(",")];
    for (const [F, idx] of [[points, pIdx], [lines, lIdx]] as [Frame | null, number[]][]) if (F) for (const i of idx) rows.push(header.map((c) => (strCols.has(c) ? F.str(c, i) ?? "" : F.num(c)[i] ?? "")).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })); a.download = "armor_assets.csv"; a.click();
  };
  const tooltip = (kind: "P" | "L", i: number) => {
    const F = kind === "P" ? points : lines, C = kind === "P" ? cols.P : cols.L;
    if (!F || !C) return null;
    if (aggregated && feederAgg && kind === "P") {
      const c = feederAgg.codes[i];
      return `feeder ${feederAgg.dict[c]}\n${fmtInt(overview?.feeder_customers?.[feederAgg.dict[c] ?? ""])} customers · ${fmtInt(feederAgg.assets[c])} assets shown\nend of life ${fmt1(feederAgg.eol[c])}/yr · failures ${feederAgg.known[c] ? `${feederAgg.fail[c].toFixed(1)}/yr` : "not recorded"}\n` +
        `SAIDI ${feederAgg.known[c] ? `${feederAgg.cm[c].toFixed(3)} min` : "–"} · risk ${fmtUsd(feederAgg.risk[c])}/yr · ${fmtUsd(feederAgg.risk[c] / Math.max(1, feederAgg.assets[c]))}/asset\nreject backlog ${fmtInt(feederAgg.rej[c])}`;
    }
    const when = projected ? (C.projected?.[i] ? `plan year ${year} (projected)${fut!.ry && kind === "P" && fut!.ry[i] > 0 && fut!.ry[i] <= year ? " · replaced by the plan" : ""}\n` : "today's state (class not projected)\n") : "";
    return when + `${F.str("asset_class", i)} ${F.str("asset_id", i)} · feeder ${F.str("feeder_id", i)}\n${F.str("cohort", i)} · ${fmt1(C.age[i])} yr\nP(end of life) ${fmtPct(C.p[i])}` +
      (C.pf[i] != null ? ` · P(failure) ${fmtPct(C.pf[i])}` : "") + (C.risk[i] != null ? `\nconsequence ${fmtUsd(C.cof[i])} · risk ${fmtUsd(C.risk[i])}/yr` : "") +
      `\n${fmtInt(C.cust[i])} customers out if it fails` + (F.str("open_finding", i) ? `\nopen ${F.str("open_finding", i)?.replace("_", " ")}` : "");
  };

  (window as any).__armorMap = { openAsset: setAsset, shown: kpis.n, setColorBy, setClasses, setFeeders, setTray, setSel, openFeeder, aggregated, setCell, setYear, year, projected, futBusy, setPlanId, idAt: (k: number) => (points && k < points.n ? points.str("asset_id", k) : null),
    matrixCounts: matrix?.counts,
    topPole: () => { const p = cols.P?.risk ?? []; let b = -1, id: string | null = null; for (const i of pIdx) if ((p[i] ?? -1) > b) { b = p[i] ?? -1; id = points!.str("asset_id", i); } return id; },
    selectAround: (f: string) => { const bb = feederBounds(f); if (!bb) return false; const [[c, a], [d, b]] = bb; setSel([[c, a], [d, a], [d, b], [c, b]]); return true; } };

  if (!points || !classes) return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Spinner /> Loading assets…</div>;
  const k = scaleKey(colorBy);
  const legendTitle = k ? ({ p: M.pEol.label, cof: M.cof.label, risk: M.risk.label, saidi: `${M.saidi.label} (min)`, age: "Age (years)" } as any)[k] : "";
  const legendFmt = (v: number) => (k === "p" ? fmtPct(v) : k === "cof" || k === "risk" ? fmtUsd(v) : k === "saidi" ? v.toFixed(4) : v.toFixed(0));
  const classCounts = Object.fromEntries((overview?.by_class ?? []).map((c) => [c.asset_class, c.active]));

  return (
    <AssetMap points={points} lines={lines} pointIdx={pIdxSorted} lineIdx={lIdx} pointColor={colorFor(points, cols.P)} lineColor={colorFor(lines, cols.L)}
      colorKey={`${colorBy}|${planId}|${plan?.size ?? 0}|${aggregated}|${feederMetric}|${cell}|${year}|${planMode}|${projected}|${fut?.key}`} onZoom={setZoom} fit={fit}
      onPick={(id) => { const i = idIndex.get(id); if (aggregated && i != null) openFeeder(points.str("feeder_id", i)!); else setAsset(id); }}
      tooltip={tooltip} selectMode={mode} onSelect={(poly) => { setSel(poly); setMode("pointer"); }}
      selection={sel} style={basemap === "dark" ? DARK_STYLE : LIGHT_STYLE} network={network} lineWidth={lineW} pointRadius={2.2 * dot}>
      {projected && <div className="pointer-events-none absolute inset-0 z-10 border-[5px] border-orange-500/90" />}
      {projected && (
        <div className="absolute inset-x-0 top-0 z-30 flex h-11 items-center justify-between bg-gradient-to-r from-orange-600 via-orange-500 to-amber-500 px-5 text-white shadow-lg" id="future-banner">
          <div className="flex items-baseline gap-3">
            <span className="text-xs font-bold uppercase tracking-[0.2em]">Projected</span>
            <span className="text-lg font-bold">Plan year {year} · {calYear(year)}</span>
            <span className="text-sm opacity-90">under {planLabel} · expected values</span>
          </div>
          <Button size="sm" variant="secondary" className="h-7" onClick={() => { setPlaying(false); setYear(0); }} id="back-to-today">Back to today</Button>
        </div>
      )}
      <div className={`absolute left-1/2 z-20 -translate-x-1/2 ${projected ? "top-14" : "top-3"}`} id="kpi-strip">
        <div className={`rounded-lg border bg-background/95 shadow-xl backdrop-blur ${projected ? "border-orange-400" : ""}`}>
        <div className="flex items-center gap-5 px-5 py-2">
          <Stat m="assets" value={fmtBig(kpis.n)} />
          <Stat m="eol" value={fmtInt(kpis.eol)} accent sub={delta("eol")} />
          <Stat m="failures" value={kpis.fail != null ? fmt1(kpis.fail) : "not recorded"} sub={delta("fail")} />
          <Stat m="saifi" value={kpis.saifi != null ? kpis.saifi.toFixed(4) : "–"} sub={delta("saifi")} />
          <Stat m="saidi" value={kpis.saidi != null ? `${kpis.saidi.toFixed(2)} min` : "–"} sub={delta("saidi")} />
          <Stat m="risk" value={kpis.risk != null ? fmtUsd(kpis.risk) : "not priced"} sub={delta("risk")} />
          <Stat m="openRejects" value={fmtInt(kpis.rej)} sub={projected && kpisToday ? `${fmtInt(kpisToday.rej - kpis.rej)} cleared by the plan` : undefined} />
          {(sel || savedSet || cell) && (
            <div className="flex items-center gap-1 border-l pl-4">
              {sel && <Button size="sm" variant="ghost" className="h-7" onClick={() => setSaved([...saved, { name: `Selection ${saved.length + 1}`, ids: [...ids()], created: new Date().toISOString().slice(0, 10) }])}><Bookmark className="mr-1 h-3.5 w-3.5" />Save</Button>}
              <Button size="sm" className="h-7" onClick={() => { setFocus({ ids: ids(), label: savedSet ? savedSet.name : `map selection (${fmtInt(kpis.n)} assets)` }); nav("/plan"); }}>Plan this <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" className="h-7" onClick={() => { setSel(null); setSavedSet(null); setCell(null); }}><X className="mr-1 h-3.5 w-3.5" />Clear</Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 border-t px-4 py-1.5 text-xs" id="time-control">
          <Title info="Today is the actual state. A plan year shows the expected state in that year under the selected plan: units it replaces restart as new, the rest keep ageing, and end-of-life units are replaced as they happen. Colour scales stay at today's ranges. Classes not in dollar plans stay at today's state. Projected age restarts only for the plan's own replacements.">
            <span className="font-semibold">{projected ? `Plan year ${year}` : "Today"}</span></Title>
          {(currentPlan || savedPlans.length > 0) ? (<>
            <Select value={planId} onValueChange={(v: string) => { setPlanId(v); setPlaying(false); }}>
              <SelectTrigger className="h-7 w-64 text-xs" id="map-plan-pick"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="current">{currentPlan ? `Current plan · ${current?.info?.strategy?.label ?? "Plan page"}` : "Current plan (none yet)"}</SelectItem>
                {savedPlans.map((p) => <SelectItem key={p.id} value={p.id}>Saved · {p.name}</SelectItem>)}
              </SelectContent></Select>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { if (!playing && year >= maxYear) setYear(0); setPlaying(!playing); }} id="time-play" aria-label={playing ? "pause" : "play"}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</Button>
            <div className="w-56 [&_[data-slot=slider-track]]:bg-slate-200"><Slider min={0} max={maxYear} step={1} value={[year]} onValueChange={(v: number[]) => { setPlaying(false); setYear(v[0]); }} id="time-slider" /></div>
            <span className="whitespace-nowrap tabular-nums text-muted-foreground">{year ? `year ${year} · ${calYear(year)}` : `as of ${overview?.as_of_date ?? ""}`}</span>
            {futBusy && <Spinner className="h-3.5 w-3.5" />}
            {futErr && <span className="text-destructive">{futErr}</span>}
          </>) : <span className="text-muted-foreground">Build a plan on the Plan page to see the projected years</span>}
        </div>
        </div>
      </div>
      <div className={`absolute left-3 z-20 flex items-center gap-2 ${projected ? "top-[200px]" : "top-16"}`}>
        <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)}><SlidersHorizontal className="mr-1 h-4 w-4" />Controls</Button>
        <ToggleGroup type="single" value={mode} onValueChange={(v: string) => v && setMode(v as SelectMode)} className="rounded-md border bg-background/90">
          <ToggleGroupItem value="pointer" title="Click to inspect / pan"><MousePointer2 className="h-4 w-4" /></ToggleGroupItem>
          <ToggleGroupItem value="box" title="Drag a box to select"><Square className="h-4 w-4" /></ToggleGroupItem>
          <ToggleGroupItem value="lasso" title="Draw a freehand loop to select"><Lasso className="h-4 w-4" /></ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className={`absolute right-3 z-20 ${projected ? "top-[200px]" : "top-16"}`}><Button size="sm" variant="secondary" onClick={exportCsv}><Download className="mr-1 h-4 w-4" />Export {fmtInt(kpis.n)}</Button></div>

      <div className={`absolute bottom-3 left-3 z-20 w-[320px] ${projected ? "top-[248px]" : "top-28"} overflow-hidden transition-transform duration-200 ${open ? "translate-x-0" : "-translate-x-[calc(100%+1rem)]"}`} id="map-controls">
        <div className="flex h-full flex-col rounded-lg border bg-background/95 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-semibold"><Layers className="h-4 w-4" /> Map controls</span>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 p-4 text-sm">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wide">Saved selections</Label>
                {selMsg && <p className="text-xs text-amber-700">{selMsg}</p>}
                {saved.length === 0 ? <p className="text-xs text-muted-foreground">none</p> : (
                  <div className="space-y-1">{saved.map((s, j) => (
                    <div key={j} className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${savedSet?.name === s.name ? "border-foreground" : ""}`}>
                      <button className="flex-1 truncate text-left" onClick={() => { setSavedSet(savedSet?.name === s.name ? null : { name: s.name, ids: new Set(s.ids) }); setSel(null); }}>
                        {s.name} <span className="text-xs text-muted-foreground">{fmtInt(s.ids.length)} · {s.created}</span></button>
                      <button onClick={() => setSaved(saved.filter((_, q) => q !== j))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>))}</div>
                )}
              </div>
              <MultiSelect id="ms-class" label="Asset classes" options={allClasses} value={cls} onChange={setClasses} allLabel="Choose classes" counts={classCounts} />
              <MultiSelect id="ms-feeder" label="Feeders" options={opts.feeders} value={feeders} onChange={(v) => { if (v.size === 1) openFeeder([...v][0]); else { setFeeders(v); setTray(null); } }} allLabel={`All feeders (${opts.feeders.length})`} />
              <MultiSelect id="ms-cohort" label="Cohort" options={opts.cohorts} value={cohorts} onChange={setCohorts} allLabel="All cohorts" counts={opts.cohortCounts} />
              {RANGE_KEYS.map((r) => (
                <HistogramRange key={r.k} label={r.label} values={[...((cols.P as any)?.[r.k] ?? []), ...((cols.L as any)?.[r.k] ?? [])]} min={dom[r.k][0]} max={dom[r.k][1]}
                  step={r.k === "age" || r.k === "cust" ? 1 : dom[r.k][1] / 200} value={ranges[r.k] ?? dom[r.k]} onChange={(v) => setRanges({ ...ranges, [r.k]: v })} format={r.fmt} />
              ))}
              <label className="flex cursor-pointer items-center justify-between"><span>Only the reject backlog</span><Switch checked={onlyFindings} onCheckedChange={setOnlyFindings} /></label>
              <div className="space-y-1.5">
                <Label>Color by</Label>
                <ToggleGroup type="single" value={colorBy} onValueChange={(v: string) => { if (v) { setColorBy(v as ColorBy); setCell(null); } }} className="flex-wrap justify-start">
                  {COLOR_MODES.map((c) => <ToggleGroupItem key={c.k} value={c.k} data-color={c.k}>{c.label}</ToggleGroupItem>)}
                </ToggleGroup>
              </div>
              <div className="space-y-1.5">
                <Label><Title info="When zoomed out, each feeder is coloured by one value for the assets shown on it.">Feeder view</Title></Label>
                <div className="flex items-center gap-2">
                  <Switch checked={byFeeder} onCheckedChange={setByFeeder} id="by-feeder" />
                  <Select value={feederMetric} onValueChange={(v: string) => setFeederMetric(v as FeederMetric)}><SelectTrigger className="h-8 flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="riskPerAsset">Risk / asset</SelectItem><SelectItem value="risk">Risk / yr</SelectItem><SelectItem value="saidi">SAIDI contribution</SelectItem><SelectItem value="p">Mean P(end of life)</SelectItem></SelectContent></Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Base map</Label>
                <Select value={basemap} onValueChange={(v: string) => setBasemap(v as "dark" | "light")}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="dark">Dark</SelectItem><SelectItem value="light">Light</SelectItem></SelectContent></Select>
              </div>
              <div className="space-y-3 border-t pt-3">
                <label className="flex cursor-pointer items-center justify-between"><span>Circuit lines</span><Switch checked={network} onCheckedChange={setNetwork} /></label>
                <div className="space-y-1"><Label>Structure size</Label><Slider min={0.3} max={3} step={0.1} value={[dot]} onValueChange={(v: number[]) => setDot(v[0])} /></div>
                <div className="space-y-1"><Label>Line width</Label><Slider min={0.3} max={3} step={0.1} value={[lineW]} onValueChange={(v: number[]) => setLineW(v[0])} /></div>
              </div>
              <Button variant="outline" size="sm" className="w-full" onClick={() => { setRanges({}); setFeeders(new Set()); setCohorts(new Set()); setOnlyFindings(false); setSel(null); setSavedSet(null); setTray(null); setCell(null); }}>Reset filters</Button>
            </div>
          </ScrollArea>
        </div>
      </div>

      {tray && feederAgg && <FeederTray feeder={tray} customers={overview?.feeder_customers?.[tray] ?? null} points={points} C={cols.P} idx={pIdx} agg={feederAgg} onClose={() => setTray(null)} onPick={setAsset}
        onPlan={(idsOfFeeder) => { setFocus({ ids: idsOfFeeder, label: `feeder ${tray}` }); nav("/plan"); }} />}

      <div className={`absolute bottom-6 z-20 ${tray ? "right-[416px]" : "right-3"}`} id="legend">
        {aggregated && feederAgg ? (
          <GradientLegend title={`Feeder · ${({ riskPerAsset: "risk / asset", risk: "risk / yr", saidi: "SAIDI contribution", p: "mean P(end of life)" } as any)[feederMetric]}`} ramp={RISK_RAMP}
            ticks={[0, 0.25, 0.5, 0.75, 1].map((q) => fmtFeeder(q * feederAgg.max))} />
        ) : colorBy === "matrix" && matrix ? (
          <RiskMatrix matrix={matrix} cell={cell} onCell={(c) => setCell(cell && c[0] === cell[0] && c[1] === cell[1] ? null : c)} />
        ) : colorBy === "plan" ? (
          <div className="flex flex-col items-end gap-2">
            {year > 0 && (
              <ToggleGroup type="single" value={planMode} onValueChange={(m: string) => m && setPlanMode(m as PlanView["mode"])} className="rounded-md border bg-background/95">
                <ToggleGroupItem value="in" className="h-7 px-2 text-xs">in year</ToggleGroupItem>
                <ToggleGroupItem value="through" className="h-7 px-2 text-xs">through year</ToggleGroupItem>
              </ToggleGroup>)}
            <SwatchLegend title={`Replacement year · ${planLabel}`} items={planLegend(planView, !!plan)} />
          </div>
        ) : colorBy === "findings" ? (
          <SwatchLegend title="Reject backlog" items={[{ label: "priority reject", color: "#dc2626" }, { label: "reject", color: "#f97316" }, { label: "none", color: "#78828f" }]} />
        ) : k ? (
          <GradientLegend title={legendTitle} ramp={k === "age" ? AGE_RAMP : k === "saidi" ? BLUE_RAMP : RISK_RAMP} ticks={[0, 0.25, 0.5, 0.75, 1].map((q) => legendFmt(q * (dom as any)[k][1]) + (q === 1 ? "+" : ""))} />
        ) : null}
      </div>
      <AssetSheet assetId={asset} onClose={() => setAsset(null)} onFeeder={(f) => { openFeeder(f); setAsset(null); }} />
    </AssetMap>
  );
}

function Stat({ m, value, accent, sub }: { m: string; value: string; accent?: boolean; sub?: string }) {
  const d = M[m];
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">{d.label}<Info formula={d.formula} source={d.source}>{d.info}</Info></div>
      <div className="text-lg font-bold tabular-nums" style={accent ? { color: "var(--armor)" } : undefined}>{value}</div>
      {sub && <div className="whitespace-pre text-[10px] leading-tight tabular-nums text-orange-700">{sub}</div>}
    </div>
  );
}

function RiskMatrix({ matrix, cell, onCell }: { matrix: any; cell: [number, number] | null; onCell: (c: [number, number]) => void }) {
  return (
    <div className="rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur" id="risk-matrix">
      <div className="mb-2 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">{M.riskMatrix.label}<Info>{M.riskMatrix.info}</Info></div>
      <div className="flex">
        <div className="mr-1 flex w-4 items-center justify-center"><span className="-rotate-90 whitespace-nowrap text-[10px] text-muted-foreground">likelihood →</span></div>
        <div>
          {[4, 3, 2, 1, 0].map((li) => (
            <div key={li} className="flex">
              {[0, 1, 2, 3, 4].map((ci) => {
                const [r, g, b] = matrixColor(li, ci), on = cell && cell[0] === li && cell[1] === ci;
                return (
                  <button key={ci} onClick={() => onCell([li, ci])} title={`${matrix.counts[li][ci].toLocaleString()} assets · risk ${fmtUsd(matrix.risk[li][ci])}/yr`}
                    className={`m-[1px] flex h-8 w-11 items-center justify-center rounded text-[10px] font-semibold ${on ? "ring-2 ring-foreground" : ""}`}
                    style={{ background: `rgb(${r},${g},${b})`, color: li + ci > 4 ? "white" : "#1f2937" }} data-cell={`${li}-${ci}`}>
                    {matrix.counts[li][ci] ? fmtBig(matrix.counts[li][ci]) : ""}
                  </button>);
              })}
            </div>))}
          <div className="mt-1 text-center text-[10px] text-muted-foreground">consequence of failure →</div>
        </div>
      </div>
    </div>
  );
}

function FeederTray({ feeder, customers, points, C, idx, agg, onClose, onPick, onPlan }: { feeder: string; customers: number | null; points: Frame; C: any; idx: number[]; agg: any; onClose: () => void; onPick: (id: string) => void; onPlan: (ids: Set<string>) => void }) {
  const [q, setQ] = useState("");
  const k = agg.dict.indexOf(feeder);
  const mine = useMemo(() => idx.filter((i) => agg.codes[i] === k).sort((a, b) => (C.risk[b] ?? C.p[b] ?? 0) - (C.risk[a] ?? C.p[a] ?? 0)), [idx, k]);
  const rows = mine.filter((i) => !q || points.str("asset_id", i)!.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  const maxRisk = Math.max(1e-9, ...mine.slice(0, 50).map((i) => C.risk[i] ?? 0));
  return (
    <div className="absolute bottom-3 right-3 top-28 z-20 w-[400px]" id="feeder-tray">
      <div className="flex h-full flex-col rounded-lg border bg-background/97 shadow-xl backdrop-blur">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <span className="font-mono text-sm font-semibold">{feeder}</span>
          <div className="flex items-center gap-1">
            <Button size="sm" className="h-7" onClick={() => onPlan(new Set(mine.map((i) => points.str("asset_id", i)!)))} id="plan-feeder">Plan this feeder <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onClose}><X className="h-4 w-4" /></Button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5 p-3">
          <Mini m="feederCustomers" label="Customers" value={fmtInt(customers)} /><Mini m="assets" label="Assets" value={fmtInt(agg.assets[k])} accent />
          <Mini m="eol" label="End of life / yr" value={fmt1(agg.eol[k])} /><Mini m="failures" label="Failures / yr" value={agg.known[k] ? agg.fail[k].toFixed(2) : "not recorded"} />
          <Mini m="saidi" label="SAIDI" value={agg.known[k] ? `${agg.cm[k].toFixed(3)} min` : "–"} /><Mini m="risk" label="Risk / yr" value={fmtUsd(agg.risk[k])} />
          <Mini m="riskPerAsset" label="Risk / asset" value={fmtUsd(agg.risk[k] / Math.max(1, agg.assets[k]))} /><Mini m="openRejects" label="Reject backlog" value={fmtInt(agg.rej[k])} />
        </div>
        <div className="px-3"><Input placeholder="Find asset…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-xs" /></div>
        <ScrollArea className="min-h-0 flex-1 px-1">
          <Table>
            <TableHeader><TableRow><TableHead>Asset</TableHead><TableHead className="text-right">Age</TableHead><TableHead className="text-right">P(EoL)</TableHead><TableHead className="text-right">Consequence</TableHead><TableHead className="text-right">Risk / yr</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((i) => (
              <TableRow key={i} className="cursor-pointer" onClick={() => onPick(points.str("asset_id", i)!)}>
                <TableCell className="font-mono text-[11px]">{points.str("asset_id", i)!.replace(`${feeder}-`, "")}{points.str("open_finding", i) ? " ⚠" : ""}<div className="text-[10px] text-muted-foreground">{points.str("cohort", i)}</div></TableCell>
                <TableCell className="text-right text-[11px]">{fmt1(C.age[i])}</TableCell>
                <TableCell className="text-right text-[11px]">{fmtPct(C.p[i])}</TableCell>
                <TableCell className="text-right text-[11px]">{C.cof[i] != null ? fmtUsd(C.cof[i]) : "–"}</TableCell>
                <TableCell className="text-right text-[11px]"><div className="flex items-center justify-end gap-1.5">
                  <div className="h-1.5 w-8 rounded-full bg-muted"><div className="h-1.5 rounded-full" style={{ width: `${(100 * (C.risk[i] ?? 0)) / maxRisk}%`, background: "var(--armor)" }} /></div>
                  <span className="font-semibold">{C.risk[i] != null ? fmtUsd(C.risk[i]) : "–"}</span></div></TableCell>
              </TableRow>))}</TableBody>
          </Table>
        </ScrollArea>
      </div>
    </div>
  );
}

function Mini({ m, label, value, accent }: { m: string; label: string; value: string; accent?: boolean }) {
  const d = M[m];
  return (
    <div className="rounded-md border px-2 py-1.5">
      <div className="flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{label}{d && <Info formula={d.formula} source={d.source}>{d.info}</Info>}</div>
      <div className="text-sm font-bold tabular-nums" style={accent ? { color: "var(--armor)" } : undefined}>{value}</div>
    </div>
  );
}
