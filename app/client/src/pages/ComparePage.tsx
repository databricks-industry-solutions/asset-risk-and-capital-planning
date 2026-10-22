// Compare strategies: the same budget turned into a complete plan by different rules (maximize value, reduce outages,
// highest P(failure), oldest, worst feeders, reactive). Every plan is evaluated exactly like the Plan page's, so they
// compare like for like, and any of them opens in Plan (map, year strip, work plan). A Monte Carlo of the fixed plans
// adds uncertainty ranges on request.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider, Spinner, Switch } from "@databricks/appkit-ui/react";
import { ArrowRight, Play, Sigma, Trash2 } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, LabelList, Legend, Line, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";
import { getJSON, postJSON } from "../lib/api";
import { fmt1, fmtInt, fmtPct, fmtUsd } from "../lib/fmt";
import { DEFAULT_SETTINGS, planRequest, settingsKey, useStore } from "../lib/store";
import { Title } from "../components/Info";

const SAVED_COLORS = ["#1f2937", "#b45309", "#7c3aed", "#be185d", "#0f766e"];
const COLORS: Record<string, string> = { reactive: "#94a3b8", value: "#16a34a", value_full: "#0d9488", reliability: "#0ea5e9", pof: "#f97316", age: "#8b5cf6", feeder: "#e11d48" };

export default function ComparePage() {
  const { inputs, settings: st, setSettings, focus, setFocus, saved, deletePlan } = useStore();
  const set = (patch: any) => setSettings((x) => ({ ...x, ...patch }));
  const nav = useNavigate();
  const [budget, setBudget] = useState(st.budget);
  const years = st.years, must = st.must, age = st.ageThreshold;
  const setAge = (v: string) => set({ ageThreshold: v });
  const [builtKey, setBuiltKey] = useState<string | null>(null);
  const key = settingsKey(st, focus);
  const KEYS = (inputs?.strategies ?? []).map((o) => o.k);
  const LABELS: Record<string, string> = Object.fromEntries((inputs?.strategies ?? []).map((o) => [o.k, o.label]));
  const [off, setOff] = useState<Set<string>>(new Set());   // strategies left out of the comparison
  const on = { has: (k: string) => !off.has(k), size: KEYS.length - off.size };
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState("30");
  const [sim, setSim] = useState<any>(null);
  const [simBusy, setSimBusy] = useState(false);

  const build = async () => {
    setBusy(true); setErr(null); setSim(null);
    try {
      setRes(await postJSON("/api/strategies", { ...planRequest(st, focus), strategies: KEYS.filter((k) => on.has(k)) }));
      setBuiltKey(key);
    } catch (e: any) { setErr(String(e.message)); }
    setBusy(false);
  };
  const simulate = async () => {
    setSimBusy(true); setErr(null);
    try {
      const { job } = await postJSON("/api/simulate", { runs: Number(runs) });
      let r: any;
      for (;;) { r = await getJSON(`/api/simulate/${job}`); if (r.state !== "running") break; await new Promise((z) => setTimeout(z, 1200)); }
      if (r.state === "error") throw new Error(r.error);
      setSim(r);
    } catch (e: any) { setErr(String(e.message)); }
    setSimBusy(false);
  };

  const all: any[] = res?.strategies ?? [];
  const S: any[] = all.filter((x) => !x.infeasible);
  const infeasible: any[] = all.filter((x) => x.infeasible);
  const base = S.find((s) => s.key === "reactive");
  const savedRows = saved.filter((p) => p.summary).map((p, k) => ({ ...p.summary, key: `saved:${p.id}`, id: p.id, label: p.name, saved: true, settings: p.settings, scope: p.scope, color: SAVED_COLORS[k % SAVED_COLORS.length],
    rule: `Saved ${p.created} · ${p.strategyLabel} · ${fmtUsd(p.settings.budget, 0)}/yr · ${p.settings.years} yr${p.scope ? ` · ${p.scope}` : ""}` }));
  // a saved plan is compared with Reactive only when it shares the baseline (same years, backlog rule, classes, scope)
  const sameBase = (p: any) => !p.saved || (p.settings && p.settings.years === st.years && p.settings.must === st.must &&
    JSON.stringify(p.settings.classes) === JSON.stringify(st.classes) && (p.scope ?? null) === (st.useFocus && focus ? focus.label : null));
  const toRow = (s: any) => {
    if (!sameBase(s)) return { ...s, dSaidi: null, dCap: null, perMin: null };
    const dSaidi = base && s.key !== "reactive" ? base.saidi_min - s.saidi_min : null;
    const dCap = base && s.key !== "reactive" ? s.total_capital_usd - base.total_capital_usd : null;
    return { ...s, dSaidi, dCap, perMin: dSaidi != null && dSaidi > 0 && dCap != null ? dCap / dSaidi : null };
  };
  const rows = S.map(toRow);
  const srows = savedRows.map(toRow);
  // data-driven highlights
  const best = useMemo(() => {
    const pick = (f: (r: any) => number | null, dir: 1 | -1) => rows.filter((r) => f(r) != null).sort((a, b) => dir * ((f(a) as number) - (f(b) as number)))[0]?.key;
    return { value: pick((r) => r.npv_usd, -1), saidi: pick((r) => r.saidi_min, 1), perMin: pick((r) => (r.perMin != null && r.perMin > 0 ? r.perMin : null), 1) };
  }, [res]);
  const V = res?.customer_minute_value as number | null;
  const served = res?.customers_served ?? 0;

  // per-year series: analytic expectation; with the simulation, its 5th-95th percentile band
  const perYear = (metric: "saidi_min" | "failures" | "capital_usd") => {
    const out: Record<number, any> = {};
    for (const s of [...S, ...savedRows]) for (const y of s.by_year ?? []) (out[y.plan_year] ??= { year: y.plan_year })[s.key] = y[metric];
    if (sim && metric !== "capital_usd") {
      const m = metric === "saidi_min" ? "customer_minutes" : "failures", k = metric === "saidi_min" ? 1 / Math.max(1, served) : 1;
      for (const x of sim.result) if (x.metric === m && out[x.year]) out[x.year][`${x.program}_band`] = [x.p05 * k, x.p95 * k];
    }
    return Object.values(out).sort((a: any, b: any) => a.year - b.year);
  };

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-6 py-6" id="compare">
      <div>
        <h1 className="text-2xl font-bold"><Title info="Each strategy turns the same budget into a complete multi-year plan by a different rule. Every plan is evaluated the same way as on the Plan page (expected failures, SAIDI and capital, with end-of-life replacements and their renewals), so the results compare like for like. Open any strategy in Plan to see where and when it works.">Compare strategies</Title></h1>
        <p className="text-muted-foreground">Settings shared with Plan · classes: {(st.classes.length ? st.classes : inputs?.priced_classes ?? []).join(", ")}{st.useFocus && focus ? ` · ${focus.label}` : " · all priced assets"}{st.crew ? ` · crews ${st.crew}/yr` : ""}</p>
      </div>

      <Card className="border-sky-200 bg-sky-50/40">
        <CardContent className="grid grid-cols-1 gap-6 pt-6 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Label className="flex justify-between text-sm"><Title info="Annual budget for proactive replacements, the same for every strategy. End-of-life replacements are in addition.">Proactive budget</Title><span className="font-semibold tabular-nums" style={{ color: "var(--armor)" }}>{fmtUsd(budget)} / year</span></Label>
            <Slider className="mt-3" min={0} max={60e6} step={500000} value={[budget]} onValueChange={(v: number[]) => setBudget(v[0])} onValueCommit={(v: number[]) => set({ budget: v[0] })} id="cp-budget" />
          </div>
          <div><Label className="text-xs">Plan years</Label>
            <Select value={String(years)} onValueChange={(v: string) => set({ years: Number(v) })}><SelectTrigger id="cp-years"><SelectValue /></SelectTrigger>
              <SelectContent>{Array.from({ length: 10 }, (_, k) => k + 1).map((y) => <SelectItem key={y} value={String(y)}>{y === 1 ? "Next year only" : `${y} years`}</SelectItem>)}</SelectContent></Select></div>
          <label className="flex items-center justify-between self-end text-sm"><span>Clear the reject backlog first</span><Switch checked={must} onCheckedChange={(v: boolean) => set({ must: v })} /></label>
        </CardContent>
        <CardContent className="flex flex-wrap items-center gap-2 pb-6">
          {KEYS.map((k) => {
            const active = on.has(k);
            return (
              <span key={k} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? "border-foreground bg-foreground text-background" : "bg-background hover:border-foreground"}`}>
                <button data-strategy={k} className="flex items-center gap-2" onClick={() => { const s = new Set(off); active ? s.add(k) : s.delete(k); setOff(s); }}>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS[k] }} />{LABELS[k]}
                </button>
                {k === "age" && active && <span className="flex items-center gap-1 text-xs">≥<Input className="h-6 w-12 bg-background px-1 text-xs text-foreground" value={age} onChange={(e) => setAge(e.target.value.replace(/\D/g, ""))} />yr</span>}
              </span>
            );
          })}
          <Button className="ml-auto" onClick={build} disabled={busy || !on.size} id="cp-run">{busy ? <Spinner className="mr-1" /> : <Play className="mr-1 h-4 w-4" />}Build plans</Button>
        </CardContent>
      </Card>
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}
      {res && builtKey !== key && !busy && <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm" id="cp-stale">Settings changed since these plans were built · <button className="underline" onClick={build}>rebuild</button></div>}
      {busy && !res && <div className="flex h-40 items-center justify-center gap-2 text-muted-foreground"><Spinner /> Building a plan per strategy…</div>}

      {res && (<>
        <p className="text-xs text-muted-foreground" id="cp-msg">{S.length} plans · {fmtUsd(res.annual_budget_usd)} / year · {res.plan_years} {res.plan_years === 1 ? "year" : "years"}</p>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.1fr_1fr]">
          <Card id="cp-tradeoff">
            <CardHeader className="pb-1"><CardTitle className="text-base"><Title info={<>Each dot is one strategy: total capital over the plan years (proactive program plus the end-of-life replacements that happen anyway) against the SAIDI contribution of in-service failures over the same years. Lower and further left is better; the dashed lines mark Reactive. Saved plans are the outlined diamonds, at their own settings.</>}>Capital vs outages</Title></CardTitle></CardHeader>
            <CardContent>
              <div className="h-[340px]">
                <ResponsiveContainer>
                  <ScatterChart margin={{ left: 8, right: 24, top: 16, bottom: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" dataKey="total_capital_usd" name="total capital" tickFormatter={(v) => fmtUsd(v, 0)} tick={{ fontSize: 11 }} domain={["auto", "auto"]}
                      label={{ value: `total capital, ${res.plan_years} yr`, position: "insideBottom", offset: -8, fontSize: 11 }} />
                    <YAxis type="number" dataKey="saidi_min" name="SAIDI" tickFormatter={(v) => Number(v).toFixed(0)} tick={{ fontSize: 11 }} width={48} domain={["auto", "auto"]}
                      label={{ value: "SAIDI min", angle: -90, position: "insideLeft", fontSize: 11 }} />
                    <ZAxis range={[170, 170]} />
                    <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11, paddingTop: 18 }} />
                    {base && <ReferenceLine x={base.total_capital_usd} stroke="#94a3b8" strokeDasharray="4 3" />}
                    {base && <ReferenceLine y={base.saidi_min} stroke="#94a3b8" strokeDasharray="4 3" />}
                    <Tooltip content={({ payload }: any) => { const r = payload?.[0]?.payload; return r ? <div className="rounded border bg-background px-2 py-1 text-xs shadow"><b>{r.label}</b><br />{fmtUsd(r.total_capital_usd)} · {r.saidi_min.toFixed(1)} SAIDI min</div> : null; }} />
                    {rows.map((r) => (
                      <Scatter key={r.key} name={r.label} data={[r]} fill={COLORS[r.key]} isAnimationActive={false} />
                    ))}
                    {srows.map((r: any) => (
                      <Scatter key={r.key} name={`${r.label} (saved)`} data={[r]} shape="diamond" fill="#ffffff" stroke={r.color} strokeWidth={2.5} isAnimationActive={false} legendType="diamond">
                        <LabelList dataKey="label" position="right" style={{ fontSize: 10, fill: r.color }} />
                      </Scatter>
                    ))}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-3 pb-1">
              <CardTitle className="text-base"><Title info={<>SAIDI contribution of in-service failures per year for each plan. With uncertainty ranges on, the shaded band is the 5th to 95th percentile of a Monte Carlo of the same plans with the same random futures for every strategy; more runs give steadier bands but take longer.</>}>SAIDI contribution by year</Title></CardTitle>
              <div className="flex items-center gap-2">
                <Select value={runs} onValueChange={setRuns}><SelectTrigger className="h-8 w-28 text-xs" id="cp-runs"><SelectValue /></SelectTrigger>
                  <SelectContent>{["10", "30", "100"].map((n) => <SelectItem key={n} value={n}>{n} runs</SelectItem>)}</SelectContent></Select>
                <Button size="sm" variant="outline" onClick={simulate} disabled={simBusy} id="cp-sim">{simBusy ? <Spinner className="mr-1 h-3 w-3" /> : <Sigma className="mr-1 h-4 w-4" />}Uncertainty ranges</Button>
              </div>
            </CardHeader>
            <CardContent><YearChart data={perYear("saidi_min")} keys={S.map((s) => s.key)} labels={LABELS} saved={savedRows} fmt={(v) => v.toFixed(1)} bands={!!sim} /></CardContent>
          </Card>
        </div>

        {infeasible.length > 0 && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm" id="cp-infeasible">
            {infeasible.map((x) => <div key={x.key}><b>{x.label}</b>: no plan at these settings. {x.infeasible}</div>)}
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" id="cp-cards">
          {rows.map((r) => (
            <Card key={r.key} className="flex flex-col shadow-sm" style={{ borderTop: `3px solid ${COLORS[r.key]}` }} data-card={r.key}>
              <CardContent className="flex flex-1 flex-col gap-2 pt-4 pb-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold">{r.label}</span>
                  {best.value === r.key && <Badge className="bg-green-100 text-green-800 hover:bg-green-100">most value</Badge>}
                  {best.saidi === r.key && <Badge className="bg-sky-100 text-sky-800 hover:bg-sky-100">lowest SAIDI</Badge>}
                  {best.perMin === r.key && <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">cheapest SAIDI minute</Badge>}
                  {st.strategy === r.key && <Badge variant="outline" className="border-foreground">Plan's strategy</Badge>}
                </div>
                <p className="text-xs leading-snug text-muted-foreground">{r.rule}</p>
                <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm tabular-nums">
                  <Metric k="Program spend" v={fmtUsd(r.program_usd)} info="Proactive replacements over the plan years, including the reject backlog." />
                  <Metric k="Total capital" v={fmtUsd(r.total_capital_usd)} info="Program spend plus the end-of-life replacements that happen anyway." />
                  <Metric k="SAIDI" v={`${r.saidi_min.toFixed(1)} min`} sub={r.dSaidi != null && base ? `${fmtPct(r.dSaidi / base.saidi_min)} below reactive` : undefined} info="SAIDI contribution of in-service failures, summed over the plan years." />
                  <Metric k="Failures" v={fmtInt(r.failures)} info="Expected in-service failures over the plan years." />
                  <Metric k="Net value" v={fmtUsd(r.npv_usd)} info="Discounted value of the discretionary replacements after their cost (the reject backlog is an obligation and is excluded). Negative = the work costs more than it saves at the given costs and consequences." />
                  <Metric k="$ per SAIDI minute" v={r.perMin != null ? fmtUsd(r.perMin) : "–"} info="Extra total capital compared with Reactive, per minute of SAIDI avoided over the plan years." />
                  <Metric k="Breaks even at" v={r.break_even_cm_value != null ? `$${r.break_even_cm_value.toFixed(2)} / cust-min` : "–"}
                    info={`Value of a customer-minute at which this plan's discretionary work has zero net value${V != null ? ` (the data uses $${V})` : ""}. Above it the plan is worth doing.`} />
                </div>
                <Button size="sm" variant={st.strategy === r.key ? "outline" : "default"} className="mt-auto self-start" onClick={() => { set({ strategy: r.key }); nav("/plan"); }} data-open={r.key}>{st.strategy === r.key ? "Open in Plan" : "Use this strategy"} <ArrowRight className="ml-1 h-3.5 w-3.5" /></Button>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card><CardHeader className="pb-1"><CardTitle className="text-base"><Title info="Expected in-service failures per year for each plan (with uncertainty ranges when simulated).">In-service failures by year</Title></CardTitle></CardHeader>
            <CardContent><YearChart data={perYear("failures")} keys={S.map((s) => s.key)} labels={LABELS} saved={savedRows} fmt={fmt1} bands={!!sim} /></CardContent></Card>
          <Card><CardHeader className="pb-1"><CardTitle className="text-base"><Title info="Proactive program plus end-of-life replacements, per year (nominal).">Total capital by year</Title></CardTitle></CardHeader>
            <CardContent><YearChart data={perYear("capital_usd")} keys={S.map((s) => s.key)} labels={LABELS} saved={savedRows} fmt={(v) => fmtUsd(v, 0)} bands={false} /></CardContent></Card>
        </div>

        <Card>
          <CardHeader><CardTitle><Title info={<>Totals over the plan years, expected values. Value of customer-minutes uses the deployment's value of a customer-minute; capital + reliability adds it to total capital.</>}>Totals over {res.plan_years} {res.plan_years === 1 ? "year" : "years"}</Title></CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm" id="cp-totals">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr><th className="py-2">Strategy / saved plan</th><th className="text-right">Replacements</th><th className="text-right">Program spend</th><th className="text-right">End-of-life replacements</th><th className="text-right">Total capital</th>
                  <th className="text-right">Failures</th><th className="text-right">SAIDI (min)</th>{S.some((s) => s.planned_saidi_min > 0) && <th className="text-right">Planned-outage SAIDI</th>}
                  <th className="text-right">Net value</th><th className="text-right">Breaks even, $/cust-min</th><th className="text-right">$ per SAIDI min</th><th className="text-right">Value of customer-min</th><th className="text-right">Capital + reliability</th></tr>
              </thead>
              <tbody>{[...rows, ...srows].map((r: any) => {
                const cm = r.saidi_min * served;
                return (
                  <tr key={r.key} className="border-b tabular-nums">
                    <td className="py-2 font-medium">{r.saved ? <span className="mr-2 inline-block h-2.5 w-2.5 rotate-45 border-2 bg-white" style={{ borderColor: r.color }} /> : <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS[r.key] }} />}{r.label}{r.saved && <span className="ml-1 text-xs font-normal text-muted-foreground">(saved)</span>}</td>
                    <td className="text-right">{fmtInt(r.replacements)}</td><td className="text-right">{fmtUsd(r.program_usd)}</td><td className="text-right">{fmtUsd(r.eol_capital_usd)}</td>
                    <td className="text-right">{fmtUsd(r.total_capital_usd)}</td><td className="text-right">{fmtInt(r.failures)}</td><td className="text-right">{r.saidi_min.toFixed(1)}</td>
                    {S.some((s) => s.planned_saidi_min > 0) && <td className="text-right">{r.planned_saidi_min?.toFixed(1)}</td>}
                    <td className="text-right">{fmtUsd(r.npv_usd)}</td><td className="text-right">{r.break_even_cm_value != null ? `$${r.break_even_cm_value.toFixed(2)}` : "–"}</td><td className="text-right">{r.perMin != null ? fmtUsd(r.perMin) : "–"}</td>
                    <td className="text-right">{V != null ? fmtUsd(cm * V) : "not valued"}</td><td className="text-right">{V != null ? fmtUsd(r.total_capital_usd + cm * V) : "–"}</td>
                  </tr>);
              })}</tbody>
            </table>
          </CardContent>
        </Card>
      </>)}
      {saved.length > 0 && (
        <Card id="cp-saved">
          <CardHeader className="pb-2"><CardTitle className="text-base"><Title info="Plans saved from the Plan page, kept in this browser. They appear in the plots and totals above at their own settings. Opening one restores its settings on Plan.">Saved plans</Title></CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm"><tbody>{saved.map((p, k) => (
              <tr key={p.id} className="border-b"><td className="py-1.5"><span className="mr-2 inline-block h-2.5 w-2.5 rotate-45 border-2" style={{ borderColor: SAVED_COLORS[k % SAVED_COLORS.length] }} />{p.name}</td>
                <td className="text-xs text-muted-foreground">{p.created} · {p.strategyLabel} · {fmtUsd(p.settings.budget, 0)}/yr · {p.settings.years} yr</td>
                <td className="text-right"><Button size="sm" variant="ghost" onClick={() => { if (p.focusIds) setFocus({ ids: new Set(p.focusIds), label: p.scope ?? "saved selection" }); setSettings(() => ({ ...DEFAULT_SETTINGS, ...p.settings, useFocus: !!p.focusIds })); nav("/plan"); }}>Open in Plan</Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => deletePlan(p.id)} aria-label="delete"><Trash2 className="h-4 w-4" /></Button></td></tr>))}</tbody></table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ k, v, sub, info }: { k: string; v: string; sub?: string; info: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground"><Title info={info}>{k}</Title></div>
      <div className="font-semibold">{v}</div>
      {sub && <div className="text-[11px] text-green-700">{sub}</div>}
    </div>
  );
}

function YearChart({ data, keys, labels, fmt, bands, saved = [] }: { data: any[]; keys: string[]; labels: Record<string, string>; fmt: (v: number) => string; bands: boolean; saved?: any[] }) {
  return (
    <div className="h-72">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="year" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={fmt} tick={{ fontSize: 11 }} width={56} domain={["auto", "auto"]} />
          <Tooltip formatter={(v: any) => (Array.isArray(v) ? `${fmt(v[0])} – ${fmt(v[1])}` : fmt(v))} labelFormatter={(l) => `plan year ${l}`} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {bands && keys.map((k) => <Area key={`${k}_b`} dataKey={`${k}_band`} stroke="none" fill={COLORS[k]} fillOpacity={0.12} legendType="none" isAnimationActive={false} />)}
          {keys.map((k) => <Line key={k} dataKey={k} name={labels[k] ?? k} stroke={COLORS[k]} strokeWidth={2.2} dot={data.length < 3} isAnimationActive={false} />)}
          {saved.map((r) => <Line key={r.key} dataKey={r.key} name={`${r.label} (saved)`} stroke={r.color} strokeWidth={2} strokeDasharray="6 3" dot={false} isAnimationActive={false} />)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
