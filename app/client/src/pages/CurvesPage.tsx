// Curves: the reference model's life curves, shown so they can be reviewed, and honest about where the data ends.
//
// Every curve is drawn SOLID over the ages where this utility has documented end-of-life removals, and DASHED over
// ages beyond the oldest one: that part is the fitted Weibull extrapolating, not evidence. (A curve showing units
// "alive at 140 years" is extrapolation when the oldest documented end of life was at 108.)
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner, ToggleGroup, ToggleGroupItem } from "@databricks/appkit-ui/react";
import { CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart } from "recharts";
import { getJSON } from "../lib/api";
import { useStore } from "../lib/store";
import { Title } from "../components/Info";
import { fmt1, fmtInt, fmtPct } from "../lib/fmt";

interface Curve {
  asset_class: string; cohort: string; scale: number; shape: number; n_units: number; n_events: number; data_weight: number; source: string;
  median_life_years: number; p10_life_years: number; p90_life_years: number; oldest_unit_age: number | null; oldest_event_age: number | null;
}
const S = (c: Curve, a: number) => Math.exp(-Math.pow(a / c.scale, c.shape));
const H = (c: Curve, a: number) => 1 - S(c, a + 1) / S(c, a);
const OVERLAY_COLORS = ["#ff6b35", "#0ea5e9", "#16a34a", "#8b5cf6", "#eab308"];
const reach = (c: Curve) => (c.oldest_event_age != null && Number.isFinite(c.oldest_event_age) ? c.oldest_event_age : 0);

export default function CurvesPage() {
  const [data, setData] = useState<any>(null);
  const [clsPick, setCls] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<string[]>([]);
  const [metric, setMetric] = useState<"survival" | "hazard">("survival");
  const { inputs } = useStore();
  useEffect(() => { if (inputs) getJSON("/api/curves").then(setData); }, [inputs]);

  const curves: Curve[] = data?.life_curve ?? [];
  const classes = useMemo(() => [...new Set(curves.map((c) => c.asset_class))], [curves]);
  // default: the first class in dollar plans, else the one with the most documented ends of life (never a fixed name)
  const cls = clsPick ?? (inputs?.priced_classes ?? []).find((c) => classes.includes(c))
    ?? [...curves].filter((c) => c.cohort === "class").sort((a, b) => b.n_events - a.n_events)[0]?.asset_class ?? classes[0] ?? "";
  const rows = curves.filter((c) => c.asset_class === cls).sort((a, b) => (a.cohort === "class" ? -1 : b.cohort === "class" ? 1 : b.n_events - a.n_events));
  const maxAge = Math.min(160, Math.ceil(Math.max(...rows.map((c) => c.p90_life_years), 60) / 10) * 10);
  const fs = (data?.failure_share ?? []).find((r: any) => r.asset_class === cls);
  const bt = (data?.backtest_metrics ?? []).filter((r: any) => r.asset_class === cls);
  const cal = (data?.backtest_calibration ?? []).filter((r: any) => r.asset_class === cls);
  const lastOrigin = Math.max(0, ...cal.map((r: any) => r.origin));

  const ov = rows.filter((c) => overlay.includes(`${c.asset_class}|${c.cohort}`));
  const ovData = useMemo(() => Array.from({ length: maxAge + 1 }, (_, a) => {
    const r: any = { age: a };
    ov.forEach((c) => {
      const v = metric === "survival" ? S(c, a) : H(c, a);
      r[a <= reach(c) ? `${c.cohort}` : `${c.cohort} (extrapolated)`] = v;
      if (Math.abs(a - reach(c)) < 0.5) r[`${c.cohort} (extrapolated)`] = v;
    });
    return r;
  }), [ov, maxAge, metric]);

  if (!data) return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Spinner /> Loading curves…</div>;
  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-6 py-6" id="curves">
      <Card>
        <CardHeader>
          <CardTitle><Title info={<>Wear-out life curves fitted on documented removals: end-of-life removals are events; rebuilds, damage and units still in service are set aside
            (censored). So a curve is the share <b>not yet worn out</b>, not the share still standing. <b>Solid</b> = ages covered by documented ends of life;
            <b> dashed</b> = beyond the oldest one, where the curve is extrapolating.</>}>Curve Explorer</Title></CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-6">
          <div><Label className="text-xs">Asset class</Label>
            <Select value={cls} onValueChange={(v: string) => { setCls(v); setOverlay([]); }}><SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{classes.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></div>
          <div className="text-sm text-muted-foreground">
            {fs && <><Title info="Share of end-of-life events of this class that happen as in-service failures rather than inspection replacements.">Share failing in service</Title>: <b>{fs.share == null ? "not recorded" : fmtPct(fs.share)}</b>
              {fs.share != null && <> · {fmtInt(fs.failures)} failures, {fmtInt(fs.condition_removals)} inspection replacements · {fs.source}</>}</>}
          </div>
        </CardContent>
      </Card>

      <FailureShare rows={(data.failure_share_by_year ?? []).filter((r: any) => r.asset_class === cls)} window={data.failure_share_years} asOf={data.as_of_date} used={fs} />

      {ov.length > 0 && (
        <Card id="overlay">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">Overlay</CardTitle>
            <div className="flex items-center gap-2">
              <ToggleGroup type="single" value={metric} onValueChange={(v: string) => v && setMetric(v as any)}>
                <ToggleGroupItem value="survival" className="text-xs">Share not worn out</ToggleGroupItem>
                <ToggleGroupItem value="hazard" className="text-xs">Annual P(end of life)</ToggleGroupItem>
              </ToggleGroup>
              <Button variant="outline" size="sm" onClick={() => setOverlay([])}>Clear</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              <ResponsiveContainer>
                <LineChart data={ovData} margin={{ left: 8, right: 16, top: 6, bottom: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="age" type="number" domain={[0, maxAge]} tick={{ fontSize: 11 }} label={{ value: "age (years)", position: "insideBottom", offset: -8, fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => (metric === "survival" ? `${Math.round(v * 100)}%` : fmtPct(v))} tick={{ fontSize: 11 }} width={50} />
                  <Tooltip formatter={(v: any) => fmtPct(v)} labelFormatter={(l) => `age ${l}`} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                  {ov.flatMap((c, k) => [
                    <Line key={c.cohort} dataKey={c.cohort} stroke={OVERLAY_COLORS[k]} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />,
                    <Line key={`${c.cohort}x`} dataKey={`${c.cohort} (extrapolated)`} stroke={OVERLAY_COLORS[k]} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} legendType="none" />,
                  ])}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" id="curve-cards">
        {rows.map((c) => <CurveCard key={c.cohort} c={c} maxAge={maxAge} on={overlay.includes(`${c.asset_class}|${c.cohort}`)}
          onToggle={() => { const k = `${c.asset_class}|${c.cohort}`; setOverlay((o) => (o.includes(k) ? o.filter((x) => x !== k) : o.length < 5 ? [...o, k] : o)); }} />)}
      </div>

      <WhatIf rows={rows} />

      <Card id="backtest">
        <CardHeader>
          <CardTitle><Title info={<>Each model version is fitted on data before an origin date and forecasts the next {inputs?.model_run.settings?.backtest?.horizon_years ?? "–"} years, compared with what happened.
            <b> Top-decile capture</b> = share of actual end-of-life events among the 10% of assets ranked riskiest. <b>Predicted / observed</b> = 1.0 when the total is right.</>}>Backtest</Title></CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Origin</th><th className="text-right">Unit-years</th><th className="text-right">Predicted</th><th className="text-right">Observed</th><th className="text-right">Pred / obs</th><th className="text-right">Top-decile capture</th></tr></thead>
            <tbody>{bt.map((r: any) => (
              <tr key={r.origin + r.model} className="border-b tabular-nums"><td className="py-1.5">{r.origin}</td><td className="text-right">{fmtInt(r.unit_years)}</td><td className="text-right">{fmtInt(r.predicted)}</td>
                <td className="text-right">{fmtInt(r.observed)}</td><td className="text-right">{r.pred_over_obs != null ? r.pred_over_obs.toFixed(2) : "–"}</td><td className="text-right">{fmtPct(r.top_decile_capture)}</td></tr>))}</tbody>
          </table>
          <div>
            <div className="mb-1 text-sm font-medium">Calibration by predicted-risk decile, origin {lastOrigin}</div>
            <div className="h-60">
              <ResponsiveContainer>
                <BarChart data={cal.filter((r: any) => r.origin === lastOrigin).map((r: any) => ({ decile: r.decile + 1, predicted: r.mean_p, observed: r.observed_rate }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="decile" tick={{ fontSize: 11 }} label={{ value: "decile of predicted risk", position: "insideBottom", offset: -2, fontSize: 11 }} height={36} />
                  <YAxis tickFormatter={(v) => fmtPct(v)} tick={{ fontSize: 11 }} width={50} />
                  <Tooltip formatter={(v: any) => fmtPct(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="predicted" fill="#1f2937" />
                  <Bar dataKey="observed" fill="#ff6b35" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CurveCard({ c, maxAge, on, onToggle }: { c: Curve; maxAge: number; on: boolean; onToggle: () => void }) {
  const r = reach(c);
  const pts = Array.from({ length: maxAge / 2 + 1 }, (_, k) => {
    const a = k * 2, v = S(c, a);
    return { age: a, data: a <= r + 1 ? v : null, extrap: a >= r - 1 ? v : null };
  });
  const border = c.source === "class" ? "#1f2937" : c.source === "cohort" ? (c.data_weight > 0.9 ? "#16a34a" : "#eab308") : "#94a3b8";
  const thin = r < c.median_life_years;
  return (
    <Card className="relative overflow-hidden" style={{ borderLeft: `4px solid ${border}` }}>
      <CardContent className="space-y-2 pt-4 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-sm font-semibold">{c.asset_class} | {c.cohort}</div>
            <div className="text-xs text-muted-foreground">{fmtInt(c.n_units)} units · {fmtInt(c.n_events)} end-of-life events</div>
          </div>
          <Button size="sm" variant={on ? "default" : "outline"} onClick={onToggle}>Overlay</Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {c.source === "class" && <Badge variant="outline">CLASS CURVE · all units</Badge>}
          {c.source === "cohort" && <Badge variant="outline">OWN DATA {Math.round(c.data_weight * 100)}%</Badge>}
          {c.source === "class_curve" && <Badge variant="outline">TOO FEW EVENTS · uses class curve</Badge>}
          {thin && <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">median is extrapolated</Badge>}
        </div>
        <div className="h-36">
          <ResponsiveContainer>
            <LineChart data={pts} margin={{ left: -18, right: 6, top: 6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef0f3" />
              <XAxis dataKey="age" type="number" domain={[0, maxAge]} tick={{ fontSize: 10 }} ticks={[0, 30, 60, 90, 120, 150].filter((t) => t <= maxAge)} />
              <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} ticks={[0, 0.5, 1]} />
              {r > 0 && r < maxAge && <ReferenceArea x1={r} x2={maxAge} fill="#f1f5f9" fillOpacity={0.9} />}
              <ReferenceLine x={c.p10_life_years} stroke="#94a3b8" strokeDasharray="2 3" />
              <ReferenceLine x={c.median_life_years} stroke="#1f2937" />
              <ReferenceLine x={c.p90_life_years} stroke="#94a3b8" strokeDasharray="2 3" />
              <Line dataKey="data" stroke="#ff6b35" strokeWidth={2.5} dot={false} isAnimationActive={false} />
              <Line dataKey="extrap" stroke="#ff6b35" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-between font-mono text-xs"><span>p10 {fmt1(c.p10_life_years)}</span><span className="font-semibold">median {fmt1(c.median_life_years)} yr</span><span>p90 {fmt1(c.p90_life_years)}</span></div>
        <div className="text-[11px] text-muted-foreground">
          shape β={c.shape.toFixed(2)} · scale λ={fmt1(c.scale)} · data reach: oldest end of life at {r ? `${fmt1(r)} yr` : "none"}, oldest unit {fmt1(c.oldest_unit_age)} yr
        </div>
      </CardContent>
    </Card>
  );
}

function WhatIf({ rows }: { rows: Curve[] }) {
  const [coh, setCoh] = useState<string>("class");
  const [age, setAge] = useState(50);
  const c = rows.find((r) => r.cohort === coh) ?? rows[0];
  if (!c) return null;
  const p1 = H(c, age), s0 = S(c, age);
  const q = (x: number) => c.scale * Math.pow(Math.pow(age / c.scale, c.shape) - Math.log(1 - x), 1 / c.shape) - age;  // remaining-life quantile given alive at age
  const r = reach(c);
  return (
    <Card id="what-if">
      <CardHeader><CardTitle><Title info={<>Read the curve for one asset: pick a cohort and an age.</>}>What-if asset</Title></CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-6">
        <div><Label className="text-xs">Cohort</Label>
          <Select value={c.cohort} onValueChange={setCoh}><SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>{rows.map((x) => <SelectItem key={x.cohort} value={x.cohort}>{x.cohort}</SelectItem>)}</SelectContent></Select></div>
        <div><Label className="text-xs">Age (years)</Label><Input type="number" value={age} min={0} max={200} onChange={(e) => setAge(Math.max(0, Number(e.target.value)))} className="w-28" /></div>
        <div className="grid grid-cols-2 gap-6 text-sm md:grid-cols-4">
          <div><div className="text-xs text-muted-foreground">P(end of life) next year</div><div className="text-xl font-bold" style={{ color: "var(--armor)" }}>{fmtPct(p1)}</div></div>
          <div><div className="text-xs text-muted-foreground">Remaining life: median</div><div className="text-xl font-bold">{fmt1(q(0.5))} yr</div></div>
          <div><div className="text-xs text-muted-foreground">10% / 90% of remaining lives</div><div className="text-xl font-bold">{fmt1(q(0.1))} – {fmt1(q(0.9))} yr</div></div>
          <div><div className="text-xs text-muted-foreground">Share of new units not worn out by this age</div><div className="text-xl font-bold">{fmtPct(s0)}</div></div>
        </div>
        {age + q(0.5) > r && (
          <p className="w-full text-xs text-amber-700">Beyond the data: oldest documented end of life in this cohort at {fmt1(r)} years.</p>
        )}
      </CardContent>
    </Card>
  );
}

// Share failing in service, year by year: a change in the inspection program (more or fewer catches) shows here as a
// step, and the share the model uses is the pooled share over its window (shaded).
function FailureShare({ rows, window: win, asOf, used }: { rows: any[]; window: number | null; asOf: string; used: any }) {
  const asOfYear = Number(String(asOf).slice(0, 4));
  const data = [...rows].sort((a, b) => a.year - b.year).map((r) => ({ ...r, events: r.failures + r.condition_removals }));
  const pooled = (n: number) => {
    const w = data.filter((r) => r.year >= asOfYear - n && r.year < asOfYear);
    const f = w.reduce((a, r) => a + r.failures, 0), c = w.reduce((a, r) => a + r.condition_removals, 0);
    return { share: f + c ? f / (f + c) : null, events: f + c, first: w[0]?.year, last: w[w.length - 1]?.year };
  };
  const windows = [...new Set([1, 3, 5, win ?? 10, 20].filter((n) => n > 0))].sort((a, b) => a - b);
  if (!data.length) return null;
  return (
    <Card id="failure-share">
      <CardHeader className="pb-2">
        <CardTitle className="text-base"><Title info={<>Share of documented end-of-life removals that were in-service failures rather than inspection replacements, by removal year.
          The share used for P(failure) is pooled over the most recent window (shaded).</>} formula="failures ÷ (failures + inspection replacements)">Share failing in service, by year</Title></CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="h-64">
          <ResponsiveContainer>
            <ComposedChart data={data} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="n" tick={{ fontSize: 11 }} width={44} />
              <YAxis yAxisId="s" orientation="right" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 11 }} width={40} />
              <Tooltip formatter={(v: any, n: any) => [n === "share failing" ? fmtPct(v) : fmtInt(v), n]} />
              <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="n" dataKey="condition_removals" name="inspection replacements" stackId="e" fill="#cbd5e1" isAnimationActive={false} />
              <Bar yAxisId="n" dataKey="failures" name="in-service failures" stackId="e" fill="#1f2937" isAnimationActive={false} />
              <Line yAxisId="s" dataKey="share" name="share failing" stroke="var(--armor)" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} />
              {win && <ReferenceArea yAxisId="n" x1={Math.max(data[0].year, asOfYear - win)} x2={asOfYear - 1} fill="#ff6b35" fillOpacity={0.1} stroke="#ff6b35" strokeOpacity={0.5} strokeDasharray="3 3"
                label={{ value: `window in use: ${win} yr`, position: "insideTop", fontSize: 10, fill: "#c2410c" }} />}
              {used?.share != null && <ReferenceLine yAxisId="s" y={used.share} stroke="var(--armor)" strokeDasharray="4 3" />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="mb-1 flex items-center text-xs font-medium text-muted-foreground">
            <Title info={<>The window is a model setting (failure_share_years in the model settings). Changing it changes P(failure), SAIFI, SAIDI, risk and plan value after the model is re-run.
              Shorter windows follow a recent change in the inspection program; longer ones average more events.</>}>Pooled share by window</Title></div>
          <table className="w-full text-sm" id="share-windows">
            <thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-1.5">Window</th><th>Years</th><th className="text-right">Events</th><th className="text-right">Share</th></tr></thead>
            <tbody>{windows.map((n) => { const p = pooled(n); const on = n === win; return (
              <tr key={n} className={`border-b tabular-nums ${on ? "font-semibold" : ""}`} style={on ? { background: "#fff1e8" } : undefined}>
                <td className="py-1.5">last {n} yr{on && <Badge variant="outline" className="ml-2 border-orange-300 text-[10px] text-orange-700">in use</Badge>}</td>
                <td className="text-xs text-muted-foreground">{p.first ? `${p.first}–${p.last}` : "–"}</td><td className="text-right">{fmtInt(p.events)}</td>
                <td className="text-right">{p.share == null ? "–" : fmtPct(p.share)}</td></tr>); })}</tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
