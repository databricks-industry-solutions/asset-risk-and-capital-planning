// Plan · capital program. One flow: set the proactive budget and constraints, the exact multi-year optimizer
// re-plans (on slider release), and the page shows what it costs in total, what it buys, where and when, and the
// work plan. The year strip, the map's time slider and the work-plan year tabs are one control: the plan year.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Slider, Spinner, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, TabsList, TabsTrigger,
} from "@databricks/appkit-ui/react";
import { Bookmark, Download, Map as MapIcon, TrendingUp } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AssetMap } from "../components/AssetMap";
import { AssetSheet } from "../components/AssetSheet";
import { Kpi } from "../components/Kpi";
import { SwatchLegend } from "../components/Legend";
import { PlanTimeline, planColor, planLegend, type PlanView } from "../components/PlanTimeline";
import { postJSON } from "../lib/api";
import { fmt1, fmtInt, fmtPct, fmtUsd } from "../lib/fmt";
import { DEFAULT_SETTINGS, planRequest, settingsKey, useStore, type PlanSettings, type SavedPlan } from "../lib/store";
import { Info, Title } from "../components/Info";

const BUNDLE_PARAMS = ["mobilization_usd", "planned_outage_setup_minutes"];
const UNIT_LABEL: Record<string, string> = { section: "Device section", feeder: "Feeder" };


export default function PlanPage() {
  const { inputs, points, lines, focus, setFocus, plan, setPlan, overview } = useStore();
  const served = overview?.customers_served ?? 0;
  const priced = inputs?.priced_classes ?? [];
  const cp: any[] = (inputs as any)?.class_parameters ?? [];
  const canBundle = cp.some((r) => BUNDLE_PARAMS.includes(r.parameter) && r.value > 0);
  const { settings: st, setSettings, current, setCurrent, saved, savePlan } = useStore();
  const strategies = inputs?.strategies ?? [];
  const set = (patch: Partial<PlanSettings>) => setSettings((x) => ({ ...x, ...patch }));
  const [budget, setBudget] = useState(st.budget);          // the slider while dragging; committed to settings on release
  const [crew, setCrew] = useState(st.crew);
  const [envelopes, setEnvelopes] = useState(st.envelopes);
  useEffect(() => { setBudget(st.budget); setCrew(st.crew); setEnvelopes(st.envelopes); }, [st.budget, st.crew, JSON.stringify(st.envelopes)]);
  const years = st.years, classes = st.classes;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(current);
  const [err, setErr] = useState<string | null>(null);
  const [asset, setAsset] = useState<string | null>(null);
  const [frontier, setFrontier] = useState<any[] | null>(null);
  const [fBusy, setFBusy] = useState(false);
  const [view, setView] = useState<PlanView>({ year: null, mode: "in" });
  const [playing, setPlaying] = useState(false);
  const [project, setProject] = useState<any>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const runId = useRef(0);
  const mapRef = useRef<HTMLDivElement | null>(null);
  const optimizer = strategies.find((o) => o.k === st.strategy)?.optimizer ?? st.strategy.startsWith("value");
  const bundleShown = st.bundleBy === "auto" ? "section" : st.bundleBy;

  const scopeClasses = classes.length ? classes : priced;
  const key = settingsKey(st, focus);
  const run = async () => {
    const id = ++runId.current;
    const reqSettings = st, reqFocus = focus, reqKey = key;   // what this plan is built with (saved with it)
    setBusy(true); setErr(null);
    try {
      const r = await postJSON("/api/plan", planRequest(reqSettings, reqFocus));
      if (id !== runId.current) return;
      r._key = reqKey; r._settings = reqSettings; r._focus = reqFocus;
      setRes(r); setCurrent(r); setProject(null);
      setPlan(new Map(r.plan_asset_ids.map((a: string, k: number) => [a, r.plan_years_of_assets[k]])));
    } catch (e: any) { if (id === runId.current) { setErr(String(e.message)); setRes(null); setCurrent(null); } }
    if (id === runId.current) setBusy(false);
  };
  // re-plan whenever a setting changes (Plan and Compare share them); coming back to the page reuses the current plan
  useEffect(() => {
    if (!inputs) return;
    if (current?._key === key) { setRes(current); return; }
    run(); setFrontier(null); setFrontierKey(null);
  }, [inputs, key]);
  // the frontier for the plan on screen; a result for older settings is dropped, and a newer plan re-requests it
  const fId = useRef(0);
  const [frontierKey, setFrontierKey] = useState<string | null>(null);
  const runFrontier = async () => {
    const id = ++fId.current, k = key;
    setFBusy(true);
    const levels = [0.3, 0.5, 0.75, 1, 1.5, 2, 3].map((m) => Math.round((st.budget * m) / 1e5) * 1e5);
    try {
      const f = (await postJSON("/api/frontier", { ...planRequest(st, focus), levels })).frontier;
      if (id === fId.current) { setFrontier(f); setFrontierKey(k); }
    } catch (e: any) { if (id === fId.current) setErr(String(e.message)); }
    if (id === fId.current) setFBusy(false);
  };
  useEffect(() => { if (res && res._key === key && frontierKey !== key) runFrontier(); }, [res, key]);
  const doSave = (name: string) => {
    setSaveMsg(savePlan(name) ? `Saved "${name}"` : "Not saved: browser storage is full (delete a saved plan on Compare)");
    setSaveName(null);
    setTimeout(() => setSaveMsg(null), 4000);
  };
  const openSaved = (p: SavedPlan) => {
    if (p.focusIds) setFocus({ ids: new Set(p.focusIds), label: p.scope ?? "saved selection" });
    setSettings(() => ({ ...DEFAULT_SETTINGS, ...p.settings, useFocus: !!p.focusIds }));
  };

  const i = res?.info;
  const outcome = (res?.outcome ?? []).map((o: any) => ({ ...o, plan_total: o.plan_program_capital + o.plan_eol_capital,
    do_nothing_saidi: served ? o.do_nothing_customer_minutes / served : null, plan_saidi: served ? o.plan_customer_minutes / served : null,
    do_nothing_planned_saidi: served ? o.do_nothing_planned_customer_minutes / served : null, plan_planned_saidi: served ? o.plan_planned_customer_minutes / served : null }));
  const tot = useMemo(() => {
    const s = (k: string) => outcome.reduce((a: number, o: any) => a + (o[k] ?? 0), 0);
    return { failN: s("do_nothing_failures"), failP: s("plan_failures"), cmN: s("do_nothing_customer_minutes"), cmP: s("plan_customer_minutes"),
      pcmN: s("do_nothing_planned_customer_minutes"), pcmP: s("plan_planned_customer_minutes"),
      capN: s("do_nothing_eol_capital"), capP: s("plan_eol_capital") + s("plan_program_capital") };
  }, [res]);
  const plannedGiven = !!i?.planned_outage_given;
  const shownYears: number = i?.plan_years ?? years;
  const projectOf = useMemo(() => new Map<string, string>((res?.plan_asset_ids ?? []).map((a: string, k: number) => [a, res.plan_projects_of_assets[k]])), [res]);
  const pickProject = (p: any) => {
    setProject(p); setPlaying(false); setView((v) => ({ ...v, year: p.plan_year }));
    mapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  (window as any).__armorPlan = { setBudget: (b: number) => set({ budget: b }), setStrategy: (k: string) => set({ strategy: k }), busy, res, setView, pickProject, view, project, save: savePlan, saved };

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-6 py-6" id="plan">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold"><Title info="Which assets to replace proactively, and when, under the budget and constraints, chosen by the selected strategy. Compare strategies shows every strategy at these same settings.">Capital plan</Title></h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {saved.length > 0 && (
            <Select value="" onValueChange={(id: string) => { const p = saved.find((x) => x.id === id); if (p) openSaved(p); }}>
              <SelectTrigger className="w-48" id="saved-plans"><SelectValue placeholder={`Saved plans (${saved.length})`} /></SelectTrigger>
              <SelectContent>{saved.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select>
          )}
          {saveMsg && <span className="text-xs text-muted-foreground" id="save-msg">{saveMsg}</span>}
          {res && (saveName == null
            ? <Button variant="outline" disabled={busy || res._key !== key} onClick={() => setSaveName(`${i.strategy?.label ?? "Plan"} · ${fmtUsd(st.budget, 0)} · ${shownYears} yr${st.useFocus && focus ? ` · ${focus.label}` : ""}`)} id="save-plan"><Bookmark className="mr-1 h-4 w-4" />Save plan</Button>
            : <span className="flex items-center gap-1"><Input className="h-9 w-72" value={saveName} onChange={(e) => setSaveName(e.target.value)} id="save-name" autoFocus
                onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) doSave(saveName.trim()); if (e.key === "Escape") setSaveName(null); }} />
                <Button onClick={() => { if (saveName.trim()) doSave(saveName.trim()); else setSaveName(null); }} id="save-confirm">Save</Button></span>)}
          {res && <a href={`/api/projects.csv?plan=${res.plan_id ?? ""}`}><Button variant="outline"><Download className="mr-1 h-4 w-4" />Work plan</Button></a>}
          {res && <a href={`/api/plan.csv?plan=${res.plan_id ?? ""}`}><Button variant="outline"><Download className="mr-1 h-4 w-4" />{fmtInt(res.n_lines)} asset lines</Button></a>}
          {plan && <Link to="/map?color=plan"><Button variant="outline"><MapIcon className="mr-1 h-4 w-4" />On the risk map</Button></Link>}
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-6 pt-6 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Label className="text-sm"><Title info="Annual budget for proactive replacements. End-of-life replacements (failed or replaced on inspection) are in addition and are shown in Capital by year. Open inspection rejects are funded from this budget first.">Proactive capital budget</Title>: <span className="text-xl font-bold" style={{ color: "var(--armor)" }} id="budget-value">{fmtUsd(budget)}</span> / year</Label>
            <Slider className="mt-3" min={0} max={60e6} step={500000} value={[budget]} onValueChange={(v: number[]) => setBudget(v[0])} onValueCommit={(v: number[]) => set({ budget: v[0] })} id="budget-slider" />
            <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>$0</span><span>$60M</span></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs"><Title info="Years the plan commits to. The optimizer always looks 10 years ahead, so a short plan only takes the assets whose best year to replace is within it.">Plan years</Title></Label>
              <Select value={String(years)} onValueChange={(v: string) => set({ years: Number(v) })}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Array.from({ length: 10 }, (_, k) => k + 1).map((y) => <SelectItem key={y} value={String(y)}>{y === 1 ? "Next year only" : `${y} years`}</SelectItem>)}</SelectContent></Select></div>
            <div><Label className="text-xs">Crews: max replacements / yr</Label><Input placeholder="no limit" value={crew} onChange={(e) => setCrew(e.target.value.replace(/\D/g, ""))} onBlur={() => set({ crew })} /></div>
            <label className="col-span-2 flex items-center justify-between text-sm"><span>Clear the reject backlog first</span><Switch checked={st.must} onCheckedChange={(v: boolean) => set({ must: v })} /></label>
            {st.strategy === "age" && <label className="col-span-2 flex items-center justify-between text-sm"><span>Age limit (years)</span><Input className="h-8 w-20" value={st.ageThreshold} onChange={(e) => set({ ageThreshold: e.target.value.replace(/\D/g, "") })} /></label>}
          </div>
          <div className="space-y-2" id="class-scope">
            <Label className="text-xs"><Title info="Asset classes the plan may replace. Each class can have its own annual envelope within the total budget.">Asset classes</Title></Label>
            <div className="flex flex-wrap gap-1.5">
              {priced.map((c) => { const on = classes.length === 0 || classes.includes(c); return (
                <Button key={c} size="sm" variant={on ? "default" : "outline"} className="h-7 text-xs" id={`class-${c}`}
                  onClick={() => set({ classes: ((cur) => { const base = cur.length ? cur : priced; const nx = base.includes(c) ? base.filter((x) => x !== c) : [...base, c]; return nx.length === 0 || nx.length === priced.length ? [] : nx; })(classes) })}>{c}</Button>); })}
            </div>
            {scopeClasses.length > 1 && (
              <div className="space-y-1 pt-1">
                {scopeClasses.map((c) => (
                  <div key={c} className="flex items-center gap-2 text-xs"><span className="w-24 truncate">{c}</span>
                    <Input className="h-7 w-24 text-xs" placeholder="no cap" value={envelopes[c] ?? ""} onChange={(e) => setEnvelopes({ ...envelopes, [c]: e.target.value.replace(/[^0-9.]/g, "") })} onBlur={() => set({ envelopes })} /><span className="text-muted-foreground">$M / yr</span></div>))}
              </div>
            )}
            <Label className="block pt-2 text-xs">Candidate assets</Label>
            {focus ? (
              <div className="flex items-center gap-2 text-sm"><Switch checked={st.useFocus} onCheckedChange={(v: boolean) => set({ useFocus: v })} /><span className="truncate">{st.useFocus ? focus.label : "all priced assets"}</span>
                <Button variant="link" size="sm" onClick={() => setFocus(null)}>clear</Button></div>
            ) : <p className="text-sm text-muted-foreground">All priced active assets · <Link to="/map" className="underline">select an area on the map</Link></p>}
          </div>
          <div className="space-y-2 text-sm">
            <Label className="text-xs"><Title info={<>How the plan chooses what to replace. Compare strategies shows all of them side by side at these settings.</>}>Strategy</Title></Label>
            <Select value={st.strategy} onValueChange={(v: string) => set({ strategy: v })}><SelectTrigger id="strategy"><SelectValue /></SelectTrigger>
              <SelectContent>{strategies.map((o) => <SelectItem key={o.k} value={o.k}>{o.label}</SelectItem>)}</SelectContent></Select>
            <p className="text-xs leading-snug text-muted-foreground" id="strategy-rule">{strategies.find((o) => o.k === st.strategy)?.rule}</p>
            <Label className="block pt-1 text-xs"><Title info={<>A crew visit to one area replaces several units for one mobilization and, on a device section, one outage setup. Bundling lets the optimizer group work where the shared cost pays for it.
              {canBundle && !optimizer && <> Bundling is an optimizer constraint: it applies to the Max net value strategies only.</>}
              {!canBundle && <> Turned on by supplying, per asset class, a crew mobilization cost (class_parameter mobilization_usd) or planned-outage setup minutes (planned_outage_setup_minutes); see Methods &amp; assumptions.</>}</>}>Work bundling</Title></Label>
            {canBundle && !optimizer ? (
              <div id="bundle-by" data-off="1" className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">Not used by this strategy</div>
            ) : canBundle ? (
              <Select value={bundleShown} onValueChange={(v: string) => set({ bundleBy: v })}><SelectTrigger id="bundle-by"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">None: each unit its own job</SelectItem><SelectItem value="section">By protective-device section</SelectItem><SelectItem value="feeder">By feeder</SelectItem></SelectContent></Select>
            ) : (
              <div id="bundle-by" data-off="1" className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">Off: no shared visit costs in the data</div>
            )}
            <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">{busy ? <><Spinner className="h-3 w-3" /> planning…</> : i ? <Badge variant="outline" id="solve-status">{i.status === "rule" ? "rule-based" : /Optimal/.test(i.status) ? "optimal" : `within ${fmtPct(i.mip_gap ?? 0)} of optimal`} · {i.seconds}s</Badge> : null}</div>
          </div>
        </CardContent>
      </Card>
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      {res && (<>
        {i.total_spend_usd < 0.9 * i.budget_total_usd && st.strategy === "value" && (
          <div id="utilization" className="flex items-center gap-2 rounded-lg border bg-amber-50 px-4 py-2 text-sm">
            <Title info="Replacements beyond this volume would cost more than they save at the given costs and consequences, so the plan leaves the rest of the budget unspent. The full-budget strategy spends it anyway and shows the net-value cost.">Budget used: <b>{fmtUsd(i.total_spend_usd)}</b> of {fmtUsd(i.budget_total_usd)} ({fmtPct(i.total_spend_usd / i.budget_total_usd)})</Title>
          </div>
        )}
        {st.strategy === "value_full" && i.level_fill > 0 && (
          <div className="flex items-center gap-2 rounded-lg border px-4 py-2 text-sm"><Title info="Replacements beyond the optimal plan, added in order of highest remaining value, to spend at least 95% of each year's budget. Their net value is included in the figures.">Full budget: {fmtInt(i.level_fill)} replacements beyond the optimal plan</Title></div>
        )}
        {focus && st.useFocus && <p className="text-xs text-muted-foreground">Scope: {fmtInt(i.scope_assets)} priced assets in {focus.label}</p>}
        <div className={`grid grid-cols-2 gap-4 ${plannedGiven ? "lg:grid-cols-7" : "lg:grid-cols-6"}`} id="plan-kpis">
          <Kpi label="Proactive replacements" value={fmtInt(res.n_lines)} accent hint={`${fmtInt(i.n_must_address)} from the reject backlog${i.visits ? ` · ${fmtInt(i.visits)} visits` : ""}`} info="Units the plan replaces before end of life, including open inspection rejects." />
          <Kpi label="Program spend" value={fmtUsd(i.total_spend_usd)} hint={`${shownYears} years · ${fmtUsd(i.must_address_usd)} reject backlog`} info="Capital of the proactive program over the plan years (nominal): planned unit costs plus crew mobilization where given." />
          <Kpi label="Net value (NPV)" value={fmtUsd(i.total_benefit_usd)} hint={i.bc_ratio != null ? `B/C ${i.bc_ratio.toFixed(2)}${i.break_even_cm_value != null ? ` · breaks even at $${i.break_even_cm_value.toFixed(2)}/cust-min` : ""}` : "no discretionary work"} info="Discounted value of the discretionary replacements after their cost: avoided end-of-life cost (emergency premium, customer-minutes, renewals) minus the planned job (capital, mobilization and its planned outage). The reject backlog is an obligation and is excluded." formula="Σ [discounted avoided end-of-life cost − discounted planned job];  B/C = (net value + cost) ÷ cost" />
          <Kpi label="Failures avoided" value={fmtInt(tot.failN - tot.failP)} hint={`${fmtPct(1 - tot.failP / Math.max(1, tot.failN))} of do-nothing · ${shownYears} yr`} info="Expected in-service failures avoided over the plan years compared with doing nothing new." />
          <Kpi label="SAIDI avoided" value={served ? `${((tot.cmN - tot.cmP) / served).toFixed(1)} min` : "–"} hint={`${fmtPct(1 - tot.cmP / Math.max(1, tot.cmN))} of do-nothing · ${shownYears} yr`} info="Minutes of unplanned interruption per customer served avoided over the plan years, from fewer in-service failures." formula="Σ years (do-nothing − plan) unplanned customer-minutes ÷ customers served" />
          {plannedGiven && <Kpi id="kpi-planned-saidi" label="Planned-outage SAIDI" value={served ? `${(tot.pcmP / served).toFixed(1)} min` : "–"} hint={`vs ${served ? (tot.pcmN / served).toFixed(1) : "–"} min do-nothing · ${shownYears} yr`} info="Minutes of planned interruption per customer served over the plan years, from replacement work: the program's jobs and the end-of-life units replaced after inspection. Whether planned interruptions count toward reported SAIDI depends on the regulator." formula="Σ years planned customer-minutes ÷ customers served" source={undefined} />}
          <Kpi label="Total capital" value={fmtUsd(tot.capP)} hint={`vs ${fmtUsd(tot.capN)} do-nothing`} info="Proactive program plus the end-of-life replacements that happen anyway, over the plan years (nominal)." />
        </div>

        <YearStrip byYear={res.by_year} outcome={outcome} served={served} view={view} planned={plannedGiven} onPick={(y) => { setPlaying(false); setView((v) => ({ ...v, year: v.year === y ? null : y })); }} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-base"><Title info={<>Proactive program (budgeted) plus the end-of-life replacements that happen anyway.</>}>Capital by year</Title></CardTitle></CardHeader>
            <CardContent>
              <div className="h-72" id="capital-chart">
                <ResponsiveContainer>
                  <ComposedChart data={res.by_year.map((y: any, k: number) => ({ ...y, discretionary: y.spend_usd - y.must_address_usd, eol: outcome[k]?.plan_eol_capital ?? 0 }))} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="plan_year" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={(v) => fmtUsd(v, 0)} tick={{ fontSize: 11 }} width={56} />
                    <Tooltip formatter={(v: any) => fmtUsd(v)} labelFormatter={(l) => `plan year ${l}`} />
                    <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="must_address_usd" name="reject backlog" stackId="s" fill="#f97316" isAnimationActive={false} />
                    <Bar dataKey="discretionary" name="proactive (discretionary)" stackId="s" fill="#1f2937" isAnimationActive={false} />
                    <Bar dataKey="eol" name="end-of-life replacements" stackId="s" fill="#cbd5e1" isAnimationActive={false} />
                    <Line dataKey="budget_usd" name="proactive budget" stroke="#ff6b35" strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardTitle className="text-base"><Title info={<>Expected in-service failures and customer-minutes per year: plan vs doing nothing new.{plannedGiven ? " Planned interruptions from the replacement work are shown separately." : ""}</>}>What it buys</Title></CardTitle></CardHeader>
            <CardContent>
              <div className="h-72" id="outcome-chart">
                <ResponsiveContainer>
                  <ComposedChart data={outcome} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="plan_year" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="f" tick={{ fontSize: 11 }} width={40} />
                    <YAxis yAxisId="c" orientation="right" tickFormatter={(v) => Number(v).toFixed(1)} tick={{ fontSize: 11 }} width={48} />
                    <Tooltip formatter={(v: any, n: any) => [String(n).includes("SAIDI") ? `${Number(v).toFixed(2)} min` : fmt1(v), n]} labelFormatter={(l) => `plan year ${l}`} />
                    <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="c" dataKey="do_nothing_saidi" name="SAIDI contribution, do nothing (min)" fill="#e2e8f0" isAnimationActive={false} />
                    <Bar yAxisId="c" dataKey="plan_saidi" name="SAIDI contribution, plan (min)" fill="#86efac" isAnimationActive={false} />
                    {plannedGiven && <Line yAxisId="c" dataKey="plan_planned_saidi" name="planned-outage SAIDI, plan (min)" stroke="#8b5cf6" strokeDasharray="5 3" strokeWidth={2} dot={false} isAnimationActive={false} />}
                    {plannedGiven && <Line yAxisId="c" dataKey="do_nothing_planned_saidi" name="planned-outage SAIDI, do nothing (min)" stroke="#c4b5fd" strokeDasharray="2 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
                    <Line yAxisId="f" dataKey="do_nothing_failures" name="failures, do nothing" stroke="#94a3b8" strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line yAxisId="f" dataKey="plan_failures" name="failures, plan" stroke="#16a34a" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.35fr_1fr]">
          <div className="relative h-[540px] overflow-hidden rounded-xl border" ref={mapRef}>
            <PlanMap points={points} lines={lines} plan={plan} classes={i.classes ?? scopeClasses} onPick={setAsset} view={view} project={project} projectOf={projectOf}
              timeline={<PlanTimeline years={shownYears} view={view} onChange={(v) => { setView(v); if (v.year !== project?.plan_year) setProject(null); }} playing={playing} setPlaying={setPlaying} id="plan-timeline" />} />
          </div>
          <Frontier data={frontier} busy={fBusy} budget={st.budget} onRun={runFrontier} onPick={(b) => set({ budget: b })} label={i.strategy?.label} />
        </div>

        <WorkPlan planId={res.plan_id} projects={res.projects} years={shownYears} unit={i.project_unit} bundled={!!i.visits} planned={plannedGiven} year={view.year}
          onYear={(y) => { setPlaying(false); setProject(null); setView((v) => ({ ...v, year: y })); }} project={project} onProject={pickProject} />
      </>)}
      {!res && busy && <div className="flex h-40 items-center justify-center gap-2 text-muted-foreground"><Spinner /> Optimizing the plan…</div>}
      <AssetSheet assetId={asset} onClose={() => setAsset(null)} />
    </div>
  );
}

// One tile per plan year: what the program does that year and what it changes. Click a tile to show that year.
function YearStrip({ byYear, outcome, served, view, planned, onPick }: { byYear: any[]; outcome: any[]; served: number; view: PlanView; planned: boolean; onPick: (y: number) => void }) {
  return (
    <div id="year-strip">
    <div className="mb-1 flex items-center text-xs font-medium text-muted-foreground"><Title info="Each year of the plan: spend, replacements, reject backlog cleared, and expected in-service failures and SAIDI contribution with the plan vs doing nothing new (grey). Click a year to show it on the map and in the work plan.">By plan year</Title></div>
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${byYear.length}, minmax(0, 1fr))` }}>
      {byYear.map((y: any, k: number) => {
        const o = outcome[k] ?? {}, on = view.year === y.plan_year;
        return (
          <button key={y.plan_year} onClick={() => onPick(y.plan_year)} id={`year-tile-${y.plan_year}`}
            className={`rounded-lg border px-2 py-1.5 text-left text-[11px] leading-tight transition hover:border-orange-300 ${on ? "border-orange-400 bg-orange-50 shadow-sm" : "bg-card"}`}>
            <div className="flex items-baseline justify-between"><span className="font-semibold">Year {y.plan_year}</span><span className="tabular-nums text-muted-foreground">{fmtUsd(y.spend_usd, 0)}</span></div>
            <div className="mt-0.5 tabular-nums"><b>{fmtInt(y.replacements)}</b> replaced</div>
            <div className="tabular-nums text-orange-700">{y.must_address ? `${fmtInt(y.must_address)} from backlog` : "\u00a0"}</div>
            <div className="tabular-nums text-muted-foreground">failures {fmtInt(o.plan_failures)} <span className="text-slate-400">vs {fmtInt(o.do_nothing_failures)}</span></div>
            <div className="tabular-nums text-muted-foreground">SAIDI {served ? o.plan_saidi?.toFixed(1) : "–"} <span className="text-slate-400">vs {served ? o.do_nothing_saidi?.toFixed(1) : "–"}</span></div>
            {planned && <div className="tabular-nums text-violet-700">planned {served ? o.plan_planned_saidi?.toFixed(1) : "–"} min</div>}
          </button>
        );
      })}
    </div>
    </div>
  );
}

function PlanMap({ points, lines, plan, classes, onPick, view, project, projectOf, timeline }: {
  points: any; lines: any; plan: Map<string, number> | null; classes: string[]; onPick: (id: string) => void; view: PlanView; project: any;
  projectOf: Map<string, string>; timeline: React.ReactNode;
}) {
  const pick = (F: any) => {
    if (!F || !plan) return [] as number[];
    const cls = F.codes("asset_class")!, keep = new Set(classes.map((c) => cls.dict.indexOf(c)).filter((k) => k >= 0));
    const out: number[] = [], inPlan: number[] = [];
    for (let i = 0; i < F.n; i++) if (keep.has(cls.codes[i])) (plan.has(F.str("asset_id", i)) ? inPlan : out).push(i);
    return out.concat(inPlan);  // plan on top
  };
  const pIdx = useMemo(() => pick(points), [points, plan, classes.join()]);
  const lIdx = useMemo(() => pick(lines), [lines, plan, classes.join()]);
  const color = (F: any) => (i: number) => {
    const id = F.str("asset_id", i);
    return planColor(plan?.get(id), view, !!project && projectOf.get(id) === project.project_id);
  };
  const fit = project && project.lat0 != null ? { bounds: [[project.lon0, project.lat0], [project.lon1, project.lat1]] as [[number, number], [number, number]], key: project.project_id } : null;
  const tip = (F: any, i: number) => { const id = F.str("asset_id", i), y = plan?.get(id); return `${id} · feeder ${F.str("feeder_id", i)}\n${y ? `replace in plan year ${y} · ${projectOf.get(id) ?? ""}` : "not in plan"} · P ${fmtPct(F.num("p_end_of_life_next_year")[i])}`; };
  return (
    <AssetMap points={points} lines={lines} pointIdx={pIdx} lineIdx={lIdx} pointColor={color(points)} lineColor={color(lines)} colorKey={`plan${plan?.size}|${view.year}|${view.mode}|${project?.project_id}`} onPick={onPick}
      pointRadius={2.6} fit={fit} tooltip={(k, i) => tip(k === "P" ? points : lines, i)}>
      <div className="absolute left-3 top-3 z-20 flex flex-col items-start gap-2">
        <div className="rounded-lg border bg-background/95 px-3 py-1.5 text-sm font-semibold shadow">{project ? <>Project <span className="font-mono">{project.project_id}</span></> : "Where the plan works"}</div>
        {timeline}
      </div>
      <div className="absolute bottom-6 right-3 z-20"><SwatchLegend title="Replacement year" items={project ? [{ label: `project ${project.project_id}`, color: "#ffffff" }, ...planLegend(view, !!plan)] : planLegend(view, !!plan)} /></div>
    </AssetMap>
  );
}

function Frontier({ data, busy, budget, onRun, onPick, label }: { data: any[] | null; busy: boolean; budget: number; onRun: () => void; onPick: (b: number) => void; label?: string }) {
  const f = (data ?? []).filter((x) => x.feasible);
  const here = f.reduce((best: any, x: any) => (!best || Math.abs(x.annual_budget_usd - budget) < Math.abs(best.annual_budget_usd - budget) ? x : best), null);
  return (
    <Card id="frontier">
      <CardHeader className="flex flex-row items-start justify-between gap-3"><div><CardTitle className="text-base"><Title info={<>The selected strategy's plan at a range of annual budgets: net value (left axis) and the SAIDI contribution of in-service failures over the plan years (right axis). Where net value flattens or falls, more budget buys reliability at a cost rather than value. Click a point to use that budget.</>}>How much is enough?{label ? ` · ${label}` : ""}</Title></CardTitle></div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={onRun} disabled={busy}>{busy ? <Spinner className="mr-1 h-3 w-3" /> : <TrendingUp className="mr-1 h-4 w-4" />}Refresh</Button></CardHeader>
      <CardContent>
        {!data ? <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground"><Spinner /> Planning 7 budgets…</div> : (
          <div className="h-72">
            <ResponsiveContainer>
              <ComposedChart data={f} margin={{ left: 4, right: 12, top: 8, bottom: 14 }} onClick={(e: any) => e?.activePayload && onPick(e.activePayload[0].payload.annual_budget_usd)}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="annual_budget_usd" tickFormatter={(v) => fmtUsd(v, 0)} tick={{ fontSize: 11 }} label={{ value: "proactive budget / year", position: "insideBottom", offset: -8, fontSize: 11 }} />
                <YAxis yAxisId="v" tickFormatter={(v) => fmtUsd(v, 0)} tick={{ fontSize: 11 }} width={56} />
                <YAxis yAxisId="s" orientation="right" tickFormatter={(v) => Number(v).toFixed(0)} tick={{ fontSize: 11 }} width={40} />
                <Tooltip formatter={(v: any, n: any) => (String(n).includes("SAIDI") ? `${Number(v).toFixed(1)} min` : fmtUsd(v))} labelFormatter={(l) => `${fmtUsd(Number(l))}/yr`} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine yAxisId="v" y={0} stroke="#94a3b8" />
                <Line yAxisId="v" dataKey="benefit_usd" name="net value (NPV)" stroke="#16a34a" strokeWidth={2.5} isAnimationActive={false} />
                <Line yAxisId="s" dataKey="saidi_min" name="SAIDI over the plan (min)" stroke="#0ea5e9" strokeDasharray="4 3" strokeWidth={2} isAnimationActive={false} />
                {here && <ReferenceDot yAxisId="v" x={here.annual_budget_usd} y={here.benefit_usd} r={6} fill="#ff6b35" stroke="white" />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        {data?.some((x) => !x.feasible) && <p className="text-xs text-muted-foreground">Can't clear the reject backlog at: {data.filter((x) => !x.feasible).map((x) => fmtUsd(x.annual_budget_usd)).join(", ")}/yr.</p>}
      </CardContent>
    </Card>
  );
}

function WorkPlan({ projects, years, unit, bundled, planned, year, onYear, project, onProject, planId }: {
  projects: any[]; years: number; unit: string; bundled: boolean; planned: boolean; year: number | null; onYear: (y: number | null) => void;
  project: any; onProject: (p: any) => void; planId?: string;
}) {
  const [sort, setSort] = useState({ k: "cost_usd", asc: false });
  const rows = useMemo(() => projects.filter((p) => year == null || p.plan_year === year).sort((a, b) => ((a[sort.k] ?? 0) < (b[sort.k] ?? 0) ? -1 : 1) * (sort.asc ? 1 : -1)), [projects, year, sort]);
  const unitLabel = UNIT_LABEL[unit] ?? "Feeder";
  // timeline: the units with the most plan spend x years
  const timeline = useMemo(() => {
    const by: Record<string, Record<number, any>> = {}, tot: Record<string, number> = {};
    for (const p of projects) { (by[p.unit_id] ??= {})[p.plan_year] = p; tot[p.unit_id] = (tot[p.unit_id] ?? 0) + p.cost_usd; }
    const top = Object.keys(tot).sort((a, b) => tot[b] - tot[a]).slice(0, 18);
    const max = Math.max(1, ...projects.map((p) => p.cost_usd));
    return { top, by, max, tot };
  }, [projects]);
  const cols: { k: string; label: string; fmt: (v: any, r: any) => any; info?: string }[] = [
    { k: "project_id", label: "Project", fmt: (v) => <span className="font-mono">{v}</span> }, { k: "plan_year", label: "Year", fmt: (v) => v },
    ...(unit === "section" ? [{ k: "feeder_id", label: "Feeder", fmt: (v: any) => <span className="font-mono">{v}</span> }] : []),
    { k: "classes", label: "Classes", fmt: (v) => v },
    { k: "assets", label: "Assets", fmt: fmtInt },
    ...(bundled ? [{ k: "visits", label: "Visits", fmt: fmtInt, info: "Crew visits the project needs: each has its own mobilization and outage setup." }] : []),
    { k: "must_address", label: "Backlog", fmt: (v) => (v ? <Badge variant="outline" className="border-orange-300 text-orange-700">{v}</Badge> : "–") },
    { k: "cost_usd", label: "Cost", fmt: (v) => fmtUsd(v) }, { k: "benefit_usd", label: "Net value", fmt: (v) => fmtUsd(v) },
    { k: "bc_ratio", label: "B/C", fmt: (v) => (Number.isFinite(v) ? v.toFixed(2) : "–") }, { k: "mean_age", label: "Mean age", fmt: fmt1 },
    { k: "max_customers", label: "Customers", fmt: fmtInt, info: "Most customers any of the project's assets interrupts when it fails (the customers behind its protective device)." },
    ...(planned ? [{ k: "planned_customer_minutes", label: "Planned cust-min", fmt: fmtInt, info: "Expected customer-minutes of planned interruption the project's work causes." }] : []),
  ];
  return (
    <Card id="work-plan">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div><CardTitle><Title info={<>One project per {unitLabel.toLowerCase()} and plan year. The reject backlog is an obligation; net value is for the discretionary work. Click a project to show it on the map.</>}>Work plan · {fmtInt(projects.length)} projects</Title></CardTitle></div>
        <a href={`/api/projects.csv?plan=${planId ?? ""}`}><Button size="sm" variant="outline"><Download className="mr-1 h-4 w-4" />CSV</Button></a>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="overflow-x-auto" id="timeline">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Timeline · the {timeline.top.length} {unit === "section" ? "device sections" : "feeders"} with the most work</div>
          <table className="text-xs">
            <thead><tr><th className="pr-3 text-left font-normal text-muted-foreground">{unitLabel.toLowerCase()}</th>{Array.from({ length: years }, (_, k) => <th key={k} className={`w-16 text-center font-normal ${year === k + 1 ? "font-semibold text-orange-700" : "text-muted-foreground"}`}>yr {k + 1}</th>)}<th className="pl-3 text-right font-normal text-muted-foreground">total</th></tr></thead>
            <tbody>{timeline.top.map((f) => (
              <tr key={f}><td className="pr-3 font-mono">{f}</td>
                {Array.from({ length: years }, (_, k) => { const p = timeline.by[f][k + 1], v = p?.cost_usd ?? 0; return (
                  <td key={k} className="p-0.5"><button disabled={!p} onClick={() => p && onProject(p)} className={`flex h-6 w-full items-center justify-center rounded text-[10px] ${project && p && project.project_id === p.project_id ? "ring-2 ring-orange-500" : ""}`}
                    style={{ background: v ? `rgba(255,107,53,${0.15 + 0.85 * (v / timeline.max)})` : "#f8fafc", color: v / timeline.max > 0.55 ? "white" : "#334155" }}>{v ? fmtUsd(v, 0) : ""}</button></td>); })}
                <td className="pl-3 text-right tabular-nums">{fmtUsd(timeline.tot[f])}</td></tr>))}</tbody>
          </table>
        </div>
        <Tabs value={year == null ? "all" : String(year)} onValueChange={(v: string) => onYear(v === "all" ? null : Number(v))}>
          <TabsList><TabsTrigger value="all">All years</TabsTrigger>{Array.from({ length: years }, (_, k) => <TabsTrigger key={k} value={String(k + 1)}>Year {k + 1}</TabsTrigger>)}</TabsList>
        </Tabs>
        <div className="max-h-[420px] overflow-auto">
          <Table>
            <TableHeader><TableRow>{cols.map((c) => <TableHead key={c.k} className={`cursor-pointer select-none ${["project_id", "feeder_id", "classes"].includes(c.k) ? "" : "text-right"}`} onClick={() => setSort({ k: c.k, asc: sort.k === c.k ? !sort.asc : false })}>
              <span className="inline-flex items-center gap-0.5">{c.label}{c.info && <Info>{c.info}</Info>}{sort.k === c.k ? (sort.asc ? " ▲" : " ▼") : ""}</span></TableHead>)}</TableRow></TableHeader>
            <TableBody id="project-rows">{rows.slice(0, 500).map((r) => <TableRow key={r.project_id} className={`cursor-pointer ${project?.project_id === r.project_id ? "bg-orange-50" : ""}`} onClick={() => onProject(r)}>
              {cols.map((c) => <TableCell key={c.k} className={["project_id", "feeder_id", "classes"].includes(c.k) ? "" : "text-right tabular-nums"}>{c.fmt(r[c.k], r)}</TableCell>)}</TableRow>)}</TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
