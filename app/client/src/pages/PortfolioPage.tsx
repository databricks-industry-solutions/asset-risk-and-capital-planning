// Service territory risk: the fleet today and what is coming if nothing new is done, for all asset classes or one.
// One class filter at the top drives every figure on the page. Definitions live in the ⓘ hovers; method detail on
// the Methods & assumptions page.
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  Button, Card, CardContent, CardHeader, CardTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Spinner,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@databricks/appkit-ui/react";
import { ArrowRight } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CNAIM, IEEE1366, Title } from "../components/Info";
import { Kpi } from "../components/Kpi";
import { getJSON } from "../lib/api";
import { fmt1, fmtBig, fmtInt, fmtPct, fmtUsd } from "../lib/fmt";
import { M } from "../lib/metrics";
import { useStore } from "../lib/store";

const REASON: Record<string, { label: string; color: string }> = {
  failure: { label: "failed in service", color: "#dc2626" },
  condition: { label: "replaced on inspection", color: "#f97316" },
  end_of_life: { label: "end of life (split not recorded)", color: "#f59e0b" },
  damage: { label: "damage", color: "#e9d5ff" },
  program: { label: "capital program (other drivers)", color: "#cbd5e1" },
  other: { label: "other", color: "#e2e8f0" },
  f_failure: { label: "forecast: in-service failures", color: "#fca5a5" },
  f_caught: { label: "forecast: replaced on inspection", color: "#fdba74" },
  f_eol: { label: "forecast: end of life (split not recorded)", color: "#fcd34d" },
};
const ORDER = ["failure", "condition", "end_of_life", "damage", "program", "other"];
const PALETTE = ["#1f2937", "#ff6b35", "#0ea5e9", "#16a34a", "#8b5cf6", "#eab308", "#94a3b8", "#ec4899", "#14b8a6"];
const sum = (xs: (number | null | undefined)[]) => { let t = 0, any = false; for (const x of xs) if (x != null && Number.isFinite(x)) { t += x; any = true; } return any ? t : null; };

export default function PortfolioPage() {
  const { overview, inputs, assetClass: cls, setAssetClass: setCls } = useStore();
  const nav = useNavigate();
  const [pf, setPf] = useState<any>(null);
  const [feeders, setFeeders] = useState<any[] | null>(null);
  useEffect(() => { if (inputs) getJSON("/api/portfolio").then(setPf); }, [inputs]);
  useEffect(() => { if (!inputs) return; setFeeders(null); getJSON(`/api/feeders${cls === "*" ? "" : `?asset_class=${encodeURIComponent(cls)}`}`).then((r) => setFeeders(r.feeders)); }, [inputs, cls]);

  (window as any).__armorPortfolio = { setCls };
  const all = overview?.by_class ?? [];
  const inSel = (c: string) => cls === "*" || c === cls;
  const rows = all.filter((c) => inSel(c.asset_class));
  const served = overview?.customers_served ?? 0;
  const k = {
    active: sum(rows.map((r) => r.active)), eol: sum(rows.map((r) => r.expected_eol)), fail: sum(rows.map((r: any) => r.expected_failures)),
    ci: sum(rows.map((r: any) => r.customers_interrupted)), cm: sum(rows.map((r) => r.customer_minutes_at_risk)), risk: sum(rows.map((r) => r.risk_usd)),
    findings: sum(rows.map((r) => r.open_findings)), age: rows.length === 1 ? rows[0].mean_age : null,
  };
  const failCovered = rows.filter((r: any) => r.failure_share != null).map((r) => r.asset_class);
  const pricedCovered = rows.filter((r) => r.priced).map((r) => r.asset_class);
  const covers = (list: string[]) => (cls !== "*" || list.length === rows.length ? "" : `Covers ${list.join(", ") || "no classes"}; the other classes lack the required inputs.`);

  const y0 = pf?.as_of_year ?? 0;
  const demand = useMemo(() => {
    if (!pf) return { rows: [] as any[], reasons: [] as string[], future: [] as string[] };
    const byYear: Record<number, any> = {};
    for (const h of pf.history) if (inSel(h.asset_class) && h.year >= y0 - 20 && h.year < y0) { const r = (byYear[h.year] ??= { year: h.year }); r[h.removal_reason] = (r[h.removal_reason] ?? 0) + h.n; }
    const fut = new Set<string>();
    for (const w of pf.wave) if (inSel(w.asset_class) && w.year < y0 + 30) {
      const r = (byYear[w.year] ??= { year: w.year });
      if (w.expected_failures != null) { r.f_failure = (r.f_failure ?? 0) + w.expected_failures; r.f_caught = (r.f_caught ?? 0) + w.expected_caught; fut.add("f_failure"); fut.add("f_caught"); }
      else { r.f_eol = (r.f_eol ?? 0) + w.expected_eol; fut.add("f_eol"); }
    }
    const reasons = ORDER.filter((r) => pf.history.some((h: any) => inSel(h.asset_class) && h.removal_reason === r));
    return { rows: Object.values(byYear).sort((a: any, b: any) => a.year - b.year), reasons, future: ["f_failure", "f_caught", "f_eol"].filter((f) => fut.has(f)) };
  }, [pf, cls]);

  const activity = useMemo(() => {
    if (!pf) return null;
    const spans = Object.entries(pf.history_years as Record<string, number>).filter(([c]) => inSel(c)).map(([, n]) => n);
    const years = spans.length ? Math.min(...spans) : 0;
    const by: Record<string, number> = {};
    let dollars = 0;
    for (const h of pf.history) if (inSel(h.asset_class) && years > 0 && h.year >= y0 - years && h.year < y0) {
      by[h.removal_reason] = (by[h.removal_reason] ?? 0) + h.n / years;
      const pc = pf.planned_cost_usd[h.asset_class];
      if (pc != null) dollars += (h.n / years) * pc;
    }
    const priced = Object.keys(pf.planned_cost_usd).some((c) => inSel(c));
    const cap = pf.capital_history ? (pf.capital_history as any[]).filter((r) => inSel(r.asset_class) && r.year >= y0 - years && r.year < y0) : null;
    const actual = cap && cap.length ? cap.reduce((a, r) => a + r.capex_usd, 0) / years : null;
    return { years, by, dollars: priced ? dollars : null, actual };
  }, [pf, cls]);

  const ages = useMemo(() => {
    if (!pf) return { rows: [] as any[], keys: [] as string[] };
    const byBin: Record<number, any> = {}, keys = new Set<string>();
    for (const a of pf.ages) if (inSel(a.asset_class)) {
      const key = cls === "*" ? a.asset_class : a.cohort;
      keys.add(key);
      const r = (byBin[a.age_bin] ??= { age: a.age_bin });
      r[key] = (r[key] ?? 0) + a.n;
    }
    return { rows: Object.values(byBin).sort((a: any, b: any) => a.age - b.age), keys: [...keys] };
  }, [pf, cls]);

  const pareto = pf?.pareto?.[cls] ?? null;
  const cost = useMemo(() => {
    if (!pf) return [];
    const byYear: Record<number, any> = {};
    for (const e of pf.eol_cost) if (inSel(e.asset_class) && e.year < y0 + 30) { const r = (byYear[e.year] ??= { year: e.year }); r.eol_cost = (r.eol_cost ?? 0) + e.eol_cost_usd; }
    for (const w of pf.wave) if (inSel(w.asset_class) && w.year < y0 + 30) {
      const r = (byYear[w.year] ??= { year: w.year });
      if (w.expected_failures != null) r.failures = (r.failures ?? 0) + w.expected_failures;
      r.eol = (r.eol ?? 0) + w.expected_eol;
    }
    return Object.values(byYear).sort((a: any, b: any) => a.year - b.year);
  }, [pf, cls]);
  const hasCost = cost.some((r: any) => r.eol_cost != null), hasFail = cost.some((r: any) => r.failures != null);

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 px-6 py-6" id="portfolio">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Service territory risk</h1>
          <p className="text-muted-foreground">{fmtInt(overview?.feeders)} feeders · {fmtInt(served)} customers</p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Asset class</div>
            <Select value={cls} onValueChange={setCls}><SelectTrigger className="w-56" id="class-filter"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="*">All classes</SelectItem>{all.map((c) => <SelectItem key={c.asset_class} value={c.asset_class}>{c.asset_class}</SelectItem>)}</SelectContent></Select>
          </div>
          <Link to="/plan"><Button>Build a plan <ArrowRight className="ml-1 h-4 w-4" /></Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-7" id="portfolio-kpis">
        <Kpi label="Active assets" value={fmtBig(k.active)} hint={k.age != null ? `mean age ${fmt1(k.age)} yr` : undefined} info="Units in service today." />
        <Kpi label="End of life next year" value={fmtInt(k.eol)} accent info="Expected number of units reaching end of life in the next 12 months: failing in service, or replaced after an inspection finds them at end of life." formula="Σ P(end of life next year)" />
        <Kpi label="In-service failures / yr" value={k.fail != null ? fmt1(k.fail) : "not recorded"} info={<>End-of-life events expected to happen as failures in service, rather than being replaced on inspection. {covers(failCovered)}</>} formula="Σ P(end of life) × share failing in service" />
        <Kpi label="SAIFI contribution" value={k.ci != null && served ? (k.ci / served).toFixed(4) : "–"} info={<>Expected customer interruptions per customer served per year caused by these in-service failures. {covers(failCovered)}</>} formula="Σ P(failure) × customers interrupted ÷ customers served" source={IEEE1366} />
        <Kpi label="SAIDI contribution" value={k.cm != null && served ? `${(k.cm / served).toFixed(2)} min` : "–"} info={<>Expected minutes of interruption per customer served per year caused by these in-service failures. {covers(failCovered)}</>} formula="Σ P(failure) × customers interrupted × restoration minutes ÷ customers served" source={IEEE1366} />
        <Kpi label="Risk next year" value={k.risk != null ? fmtUsd(k.risk) : "not priced"} info={<>Monetized risk: probability of an in-service failure times its consequence. The consequence counts the emergency cost over the planned job and the value of the customer-minutes lost beyond the planned job's own outage. {covers(pricedCovered)}</>} formula={`Σ P(failure) × consequence of failure;  consequence = ${M.cof.formula}`} source={CNAIM} />
        <Kpi label="Reject backlog" value={fmtInt(k.findings)} info="Inspections with a reject or priority-reject outcome that had not been resolved (replaced or restored) by the as-of date." />
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle><Title info="Units removed each year by documented reason (left of today) and the expected end-of-life volume of the fleet (right of today), including the end of life of the units that replace them. Forecast volumes are split into in-service failures and inspection replacements where the failure share is known.">Replacement demand forecast</Title></CardTitle></CardHeader>
        <CardContent>
          {!pf ? <div className="flex h-72 items-center justify-center gap-2 text-muted-foreground"><Spinner /> Loading…</div> : (
            <div className="h-80" id="wave">
              <ResponsiveContainer>
                <ComposedChart data={demand.rows} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={fmtBig} tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any, n: any) => [fmtInt(v), REASON[n]?.label ?? n]} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} formatter={(v) => REASON[v]?.label ?? v} />
                  {[...demand.reasons, ...demand.future].map((r) => <Bar key={r} dataKey={r} stackId="h" fill={REASON[r].color} isAnimationActive={false} />)}
                  <ReferenceLine x={y0} stroke="#1f2937" strokeDasharray="4 3" label={{ value: "today", fontSize: 11, position: "insideTopRight", offset: 8 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle><Title info={cls === "*" ? "Active units by age, by asset class." : "Active units by age, by cohort."}>Age profile</Title></CardTitle></CardHeader>
          <CardContent>
            <div className="h-72" id="ages">
              <ResponsiveContainer>
                <BarChart data={ages.rows} margin={{ left: 4, right: 12, top: 4, bottom: 14 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="age" tick={{ fontSize: 11 }} label={{ value: "age (years)", position: "insideBottom", offset: -8, fontSize: 11 }} />
                  <YAxis tickFormatter={fmtBig} tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any) => fmtInt(v)} labelFormatter={(l) => `${l}–${Number(l) + 4} years`} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                  {ages.keys.map((c, i) => <Bar key={c} dataKey={c} stackId="a" fill={PALETTE[i % PALETTE.length]} isAnimationActive={false} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle><Title info="Average units removed per year over the most recent years of records, by reason, and the capital that volume represents. Actual spend is shown when capital history is supplied; otherwise the volume is priced at today's planned replacement cost.">Historical replacement activity</Title></CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm" id="anchors">
            {activity && activity.years > 0 ? (<>
              <div className="text-xs text-muted-foreground">average of the last {activity.years} years</div>
              <table className="w-full"><tbody className="[&_td]:py-1">
                {ORDER.filter((r) => activity.by[r]).map((r) => (
                  <tr key={r} className="border-b"><td><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: REASON[r].color }} />{REASON[r].label}</td><td className="text-right tabular-nums">{fmtInt(activity.by[r])} / yr</td></tr>))}
                <tr className="font-semibold"><td>all removals</td><td className="text-right tabular-nums">{fmtInt(Object.values(activity.by).reduce((a, b) => a + b, 0))} / yr</td></tr>
              </tbody></table>
              <div className="rounded-lg bg-muted/60 p-3">
                {activity.actual != null ? (<><div className="text-xs text-muted-foreground">replacement capital, actual</div><div className="text-lg font-bold">{fmtUsd(activity.actual)} / yr</div></>)
                  : activity.dollars != null ? (<><div className="text-xs text-muted-foreground">replacement capital, estimated at today's planned cost</div><div className="text-lg font-bold">{fmtUsd(activity.dollars)} / yr</div></>)
                  : <div className="text-xs text-muted-foreground">no cost data for this class</div>}
              </div>
            </>) : <div className="text-muted-foreground">No removal history in the record window.</div>}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle><Title info={pareto?.basis === "risk_usd" ? "Share of next year's monetized risk held by the riskiest share of assets." : "Share of next year's expected end-of-life events held by the most likely share of assets (this class has no cost data)."}>Next-year risk</Title></CardTitle></CardHeader>
          <CardContent>
            {pareto && (
              <div className="h-60" id="pareto">
                <ResponsiveContainer>
                  <AreaChart data={pareto.points} margin={{ left: 0, right: 12, top: 4, bottom: 14 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="share_assets" tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 11 }} label={{ value: "share of assets, riskiest first", position: "insideBottom", offset: -8, fontSize: 11 }} />
                    <YAxis tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 11 }} width={40} domain={[0, 1]} />
                    <Tooltip formatter={(v: any) => fmtPct(v)} labelFormatter={(l) => `riskiest ${Math.round(Number(l) * 100)}% of assets`} />
                    <Area dataKey="share" name={pareto.basis === "risk_usd" ? "share of risk $" : "share of end-of-life events"} stroke="#ff6b35" fill="#ff6b35" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2"><CardTitle><Title info="Expected in-service failures, end-of-life volume and end-of-life replacement cost per year if nothing is replaced early, including replacements' own end of life. Cost is planned cost when replaced on inspection and emergency cost when failed; shown where cost data exists.">Expected failures and end-of-life cost</Title></CardTitle></CardHeader>
          <CardContent>
            <div className="h-60" id="expected">
              <ResponsiveContainer>
                <ComposedChart data={cost} margin={{ left: 4, right: 12, top: 4, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                  {hasCost && <YAxis yAxisId="usd" tickFormatter={(v) => fmtUsd(v, 0)} tick={{ fontSize: 11 }} width={56} />}
                  <YAxis yAxisId="n" orientation={hasCost ? "right" : "left"} tickFormatter={fmtBig} tick={{ fontSize: 11 }} width={48} />
                  <Tooltip formatter={(v: any, n: any) => [n === "end-of-life cost" ? fmtUsd(v) : fmt1(v), n]} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 11 }} />
                  {hasCost && <Bar yAxisId="usd" dataKey="eol_cost" name="end-of-life cost" fill="#1f2937" isAnimationActive={false} />}
                  <Line yAxisId="n" dataKey="eol" name="end of life" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                  {hasFail && <Line yAxisId="n" dataKey="failures" name="in-service failures" stroke="#dc2626" strokeWidth={2} dot={false} isAnimationActive={false} />}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      <FeederRisk rows={feeders} served={served} onOpen={(f) => nav(`/map?feeder=${encodeURIComponent(f)}`)} />
    </div>
  );
}

function FeederRisk({ rows, served, onOpen }: { rows: any[] | null; served: number; onOpen: (f: string) => void }) {
  const [sort, setSort] = useState({ k: "risk_usd", asc: false });
  const [q, setQ] = useState("");
  const cols: { k: string; label: string; fmt: (v: any) => string; info?: string }[] = [
    { k: "feeder_id", label: "Feeder", fmt: (v) => v }, { k: "customers", label: "Customers", fmt: fmtInt, info: "Customers interrupted if the feeder head opens." },
    { k: "assets", label: "Assets", fmt: fmtInt }, { k: "mean_age", label: "Mean age", fmt: fmt1 },
    { k: "expected_eol", label: "End of life / yr", fmt: fmt1 }, { k: "expected_failures", label: "Failures / yr", fmt: (v) => (v ?? 0).toFixed(2) },
    { k: "saidi", label: "SAIDI contribution", fmt: (v) => (v != null ? `${v.toFixed(3)} min` : "–"), info: "Expected minutes of interruption per customer served (system-wide) per year from this feeder's in-service failures." },
    { k: "risk_usd", label: "Risk / yr", fmt: (v) => fmtUsd(v) }, { k: "risk_per_asset_usd", label: "Risk / asset", fmt: (v) => fmtUsd(v), info: "Risk per asset: separates feeders with many assets from feeders in poor condition." },
    { k: "open_findings", label: "Backlog", fmt: fmtInt },
  ];
  const data = useMemo(() => (rows ?? []).map((r) => ({ ...r, saidi: served ? (r.customer_minutes_at_risk ?? 0) / served : null }))
    .filter((x) => !q || String(x.feeder_id).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => ((a[sort.k] ?? -1) < (b[sort.k] ?? -1) ? -1 : 1) * (sort.asc ? 1 : -1)), [rows, sort, q, served]);
  const max = Math.max(1e-9, ...(rows ?? []).map((r) => r.risk_usd ?? 0));
  return (
    <Card id="feeder-register">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle><Title info="Every feeder, next year, if nothing is done. Select a feeder to open it on the map with its assets.">Feeder risk</Title></CardTitle>
        <Input placeholder="Filter feeders…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
      </CardHeader>
      <CardContent>
        <div className="max-h-[460px] overflow-auto">
          <Table>
            <TableHeader><TableRow>{cols.map((c) => (
              <TableHead key={c.k} className={`cursor-pointer select-none whitespace-nowrap ${c.k === "feeder_id" ? "" : "text-right"}`} onClick={() => setSort({ k: c.k, asc: sort.k === c.k ? !sort.asc : false })}>
                {c.info ? <Title info={c.info}>{c.label}</Title> : c.label}{sort.k === c.k ? (sort.asc ? " ▲" : " ▼") : ""}
              </TableHead>))}<TableHead className="w-32" /></TableRow></TableHeader>
            <TableBody>
              {!rows && <TableRow><TableCell colSpan={11}><Spinner /></TableCell></TableRow>}
              {data.slice(0, 400).map((r) => (
                <TableRow key={r.feeder_id} className="cursor-pointer" onClick={() => onOpen(r.feeder_id)}>
                  {cols.map((c) => <TableCell key={c.k} className={c.k === "feeder_id" ? "font-mono" : "text-right tabular-nums"}>{c.fmt(r[c.k])}</TableCell>)}
                  <TableCell><div className="h-2 rounded-full bg-muted"><div className="h-2 rounded-full" style={{ width: `${(100 * (r.risk_usd ?? 0)) / max}%`, background: "var(--armor)" }} /></div></TableCell>
                </TableRow>))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
