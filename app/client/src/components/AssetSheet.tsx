// Asset drawer: the risk chain for one asset (likelihood × consequence = risk), its forecast, what a failure would
// cost, what replacing it is worth by plan year, and its records. Definitions and sources live in the ⓘ hovers.
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Skeleton } from "@databricks/appkit-ui/react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getJSON } from "../lib/api";
import { fmt1, fmtInt, fmtPct, fmtUsd } from "../lib/fmt";
import { M } from "../lib/metrics";
import { useStore } from "../lib/store";
import { Info, Title } from "./Info";

export function AssetSheet({ assetId, onClose, onFeeder }: { assetId: string | null; onClose: () => void; onFeeder?: (feeder: string) => void }) {
  const { plan } = useStore();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) return;
    setD(null); setErr(null);
    getJSON(`/api/asset/${encodeURIComponent(assetId)}`).then(setD).catch((e) => setErr(String(e.message)));
  }, [assetId]);

  const e = d?.explanation, c = d?.consequence, r = d?.reliability, cv = d?.curve;
  let surv = 1;
  const fcRows = (d?.forecast ?? []).map((x: any) => { surv *= 1 - x.p_end_of_life; return { year: x.year_offset, p: x.p_end_of_life, cum: 1 - surv }; });
  // first forecast year whose age passes the oldest documented end of life in the cohort: the curve is extrapolating
  const reach = cv?.oldest_event_age;
  const extrapFrom = e && reach != null && Number.isFinite(reach) ? Math.max(1, Math.ceil(reach - e.age_years)) : null;
  const planYear = assetId ? plan?.get(assetId) : undefined;
  const best = d?.benefit_by_year?.reduce((b: any, x: any) => (!b || x.benefit_usd > b.benefit_usd ? x : b), null);

  return (
    <Sheet open={!!assetId} onOpenChange={(o: boolean) => !o && onClose()}>
      <SheetContent side="right" className="w-[540px] overflow-y-auto sm:max-w-[540px]">
        <SheetHeader>
          <SheetTitle className="font-mono text-base"><span id="asset-title">{assetId}</span></SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {e && <span>{e.asset_class} · {e.cohort} · {fmt1(e.age_years)} yr</span>}
              {d?.record?.feeder_id && (onFeeder ? <button className="underline" onClick={() => onFeeder(d.record.feeder_id)}>feeder {d.record.feeder_id}</button> : <span>feeder {d.record.feeder_id}</span>)}
              {d && <Badge variant="outline" id="plan-chip">{planYear ? `in plan · year ${planYear}` : "not in plan"}</Badge>}
              {c?.open_finding && <Badge className="bg-orange-100 text-orange-800 hover:bg-orange-100">open {String(c.open_finding).replace("_", " ")}</Badge>}
            </div>
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-8" id="asset-body">
          {err && <div className="text-sm text-destructive">{err}</div>}
          {d?.lookup_errors && <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800" id="lookup-errors">
            Couldn't read: {Object.entries(d.lookup_errors).map(([k, v]) => `${k} (${v})`).join("; ")}. Those sections are incomplete.</div>}
          {!d && !err && <Skeleton className="h-64 w-full" />}
          {d && (<>
            <section id="risk-chain">
              <h4 className="mb-2 text-sm font-semibold">Risk next year</h4>
              <div className="flex flex-wrap items-stretch gap-1.5 text-center">
                <Chain m="pEol" value={fmtPct(e.p_end_of_life_next_year)} />
                <Op>×</Op>
                <Chain m="shareFailing" value={c?.p_failure != null ? fmtPct(c.p_failure) : "not recorded"} extra={d.failure_share_source} />
                <Op>=</Op>
                <Chain m="pFail" value={r?.p_failure_next_year != null ? fmtPct(r.p_failure_next_year) : "–"} />
                <Op>×</Op>
                <Chain m="cof" value={c?.cof_usd != null ? fmtUsd(c.cof_usd) : "not priced"} />
                <Op>=</Op>
                <Chain m="risk" value={c?.risk_usd_next_year != null ? fmtUsd(c.risk_usd_next_year) : "–"} accent />
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                <Small m="customers" value={fmtInt(d.customers)} />
                <Small m="saifi" value={r?.saifi != null ? r.saifi.toFixed(7) : "–"} />
                <Small m="saidi" value={r?.saidi_min != null ? `${r.saidi_min.toFixed(5)} min` : "–"} />
              </div>
            </section>

            <section>
              <h4 className="mb-1 flex items-center text-sm font-semibold"><Title info={<>P(end of life) in each year if nothing is done (bars) and the cumulative chance of reaching end of life (line).
                {cv ? ` Life curve ${cv.asset_class} · ${cv.cohort}: median ${fmt1(cv.median_life_years)} yr, shape ${Number(cv.shape).toFixed(2)}, ${fmtInt(cv.n_events)} documented ends of life among ${fmtInt(cv.n_units)} units (${cv.source}). Oldest documented end of life at ${fmt1(reach)} yr; later ages are extrapolated.` : ""}</>}>Forecast if nothing is done</Title>
                {extrapFrom != null && extrapFrom <= 30 && <Badge variant="outline" className="ml-2 border-amber-300 text-amber-700">extrapolated from year {extrapFrom}</Badge>}</h4>
              <div className="h-48">
                <ResponsiveContainer>
                  <ComposedChart data={fcRows} margin={{ left: 0, right: 8, top: 6, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    {extrapFrom != null && extrapFrom <= 30 && <ReferenceArea yAxisId="p" x1={extrapFrom} x2={30} fill="#fef3c7" fillOpacity={0.6} />}
                    <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="p" tickFormatter={(v) => fmtPct(v)} tick={{ fontSize: 10 }} width={44} />
                    <YAxis yAxisId="c" orientation="right" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} width={36} />
                    <Tooltip formatter={(v: any, n: any) => [fmtPct(v), n === "p" ? "P(end of life) in year" : "cumulative"]} labelFormatter={(l) => `year ${l}`} />
                    <Bar yAxisId="p" dataKey="p" fill="#1f2937" isAnimationActive={false} />
                    <Line yAxisId="c" dataKey="cum" stroke="var(--armor)" dot={false} strokeWidth={2} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>

            {c && c.cof_usd != null ? (
              <section id="consequence">
                <h4 className="mb-1 text-sm font-semibold"><Title info={M.cof.info} formula={M.cof.formula} source={M.cof.source}>Consequence of failure</Title></h4>
                <table className="w-full text-sm"><tbody className="[&_td]:border-b [&_td]:py-1.5">
                  <Row k="Emergency replacement" v={fmtUsd(c.emergency_usd)} src={c.emergency_source} />
                  <Row k="Planned replacement" v={fmtUsd(c.planned_usd)} src={c.planned_source} />
                  {c.mobilization_usd != null && <Row k="Crew mobilization" v={fmtUsd(c.mobilization_usd)} src={c.mobilization_usd_source} />}
                  <Row k="Emergency premium" v={fmtUsd(c.emergency_usd - c.planned_usd - (c.mobilization_usd ?? 0))} />
                  <Row k={M.customers.label} v={fmtInt(c.customers)} info={M.customers.info} />
                  <Row k={M.restoration.label} v={`${fmtInt(c.minutes)} min`} src={c.minutes_source} />
                  {(c.planned_outage_setup_minutes != null || c.planned_outage_minutes_per_asset != null) && (
                    <Row k="Planned-outage minutes" v={`${fmtInt(c.planned_outage_minutes)} min`} info={`Setup ${fmtInt(c.planned_outage_setup_minutes ?? 0)} min (source: ${c.planned_outage_setup_minutes_source}) + ${fmtInt(c.planned_outage_minutes_per_asset ?? 0)} min per unit (source: ${c.planned_outage_minutes_per_asset_source}), when the unit is replaced on its own.`} />)}
                  <Row k="Value of a customer-minute" v={c.customer_minute_value != null ? `$${c.customer_minute_value}` : "not given"} src={c.customer_minute_value_source} />
                  <Row k="Customer-minutes value, net of planned outage" v={fmtUsd(c.cof_usd - (c.emergency_usd - c.planned_usd - (c.mobilization_usd ?? 0)))} />
                  <Row k={<b>Consequence of failure</b>} v={<b>{fmtUsd(c.cof_usd)}</b>} />
                  <Row k={<Title info={M.plannedJob.info} formula={M.plannedJob.formula}>{M.plannedJob.label}</Title>} v={fmtUsd(c.planned_job_usd)} />
                  <Row k={<Title info={M.eolCost.info} formula={M.eolCost.formula}>End-of-life cost next year</Title>} v={fmtUsd(c.eol_cost_usd_next_year)} />
                </tbody></table>
              </section>
            ) : (
              <section><h4 className="text-sm font-semibold">Consequence of failure</h4><p className="text-sm text-muted-foreground">not priced <Info>No replacement costs are supplied for this asset class.</Info></p></section>
            )}

            {d.benefit_by_year && (
              <section id="replace-value">
                <h4 className="mb-1 text-sm font-semibold"><Title info={M.replaceValue.info}>{M.replaceValue.label}</Title></h4>
                <div className="h-40">
                  <ResponsiveContainer>
                    <BarChart data={d.benefit_by_year} margin={{ left: 0, right: 8, top: 14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="plan_year" tick={{ fontSize: 10 }} />
                      <YAxis tickFormatter={(v) => fmtUsd(v)} tick={{ fontSize: 10 }} width={52} />
                      <Tooltip formatter={(v: any) => fmtUsd(v)} labelFormatter={(l) => `plan year ${l}`} />
                      <ReferenceLine y={0} stroke="#94a3b8" />
                      {planYear && <ReferenceLine x={planYear} stroke="#ff6b35" strokeDasharray="4 3" label={{ value: "plan", fontSize: 10, fill: "#ff6b35", position: "top" }} />}
                      <Bar dataKey="benefit_usd" isAnimationActive={false}>
                        {d.benefit_by_year.map((x: any, i: number) => <Cell key={i} fill={x.benefit_usd <= 0 ? "#cbd5e1" : best && x.plan_year === best.plan_year ? "#15803d" : "#4ade80"} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {best && <div className="text-xs text-muted-foreground">best year: {best.benefit_usd > 0 ? `${best.plan_year} (${fmtUsd(best.benefit_usd)})` : "none"}</div>}
              </section>
            )}

            {d.inspections?.length > 0 && (
              <section>
                <h4 className="mb-1 text-sm font-semibold">Inspections</h4>
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground"><tr><th className="text-left">date</th><th className="text-left">method</th><th className="text-left">outcome</th><th className="text-right">strength</th><th className="text-right">resolved</th></tr></thead>
                  <tbody>{d.inspections.map((x: any, i: number) => (
                    <tr key={i} className="border-b"><td className="py-1">{x.inspection_date}</td><td>{x.method}</td><td>{String(x.outcome).replace("_", " ")}</td>
                      <td className="text-right">{x.remaining_strength_pct != null ? `${fmt1(x.remaining_strength_pct)}%` : ""}</td><td className="text-right">{x.resolved_date ?? ""}</td></tr>
                  ))}</tbody>
                </table>
              </section>
            )}
            {d.history?.length > 1 && (
              <section>
                <h4 className="mb-1 text-sm font-semibold">Units at this position</h4>
                <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="text-left">unit</th><th className="text-left">installed</th><th className="text-left">removed</th><th className="text-left">reason</th></tr></thead>
                  <tbody>{d.history.map((x: any, i: number) => (
                    <tr key={i} className="border-b"><td className="py-1 font-mono">{x.asset_id}</td><td>{x.install_date}</td><td>{x.removal_date ?? "in service"}</td><td>{x.removal_reason ?? ""}</td></tr>
                  ))}</tbody></table>
              </section>
            )}
          </>)}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Chain({ m, value, accent, extra }: { m: string; value: string; accent?: boolean; extra?: string | null }) {
  const d = M[m];
  return (
    <div className={`min-w-[88px] flex-1 rounded-lg border px-2 py-1.5 ${accent ? "border-orange-300 bg-orange-50" : ""}`}>
      <div className="flex items-center justify-center gap-0.5 text-[9px] uppercase leading-tight tracking-wide text-muted-foreground">{d.label}
        <Info formula={d.formula} source={d.source}>{d.info}{extra ? ` Source: ${extra}.` : ""}</Info></div>
      <div className="text-sm font-bold tabular-nums" style={accent ? { color: "var(--armor)" } : undefined}>{value}</div>
    </div>
  );
}
const Op = ({ children }: { children: ReactNode }) => <div className="self-center text-sm text-muted-foreground">{children}</div>;
function Small({ m, value }: { m: string; value: string }) {
  const d = M[m];
  return (
    <div className="rounded-md border px-2 py-1">
      <div className="flex items-center gap-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">{d.label}<Info formula={d.formula} source={d.source}>{d.info}</Info></div>
      <div className="text-xs font-semibold tabular-nums">{value}</div>
    </div>
  );
}
function Row({ k, v, src, info }: { k: ReactNode; v: ReactNode; src?: string | null; info?: string }) {
  return (
    <tr>
      <td className="w-[55%] pr-2 text-muted-foreground">{k}</td>
      <td className="tabular-nums"><span className="inline-flex items-center gap-1">{v}{(src || info) && <Info>{info ?? `Source: ${src}`}</Info>}</span></td>
    </tr>
  );
}
