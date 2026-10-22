// Data model: exactly what ARMOR reads, whether this deployment's tables match, and what each table switches on.
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner } from "@databricks/appkit-ui/react";
import { CheckCircle2, CircleSlash, XCircle } from "lucide-react";
import { Kpi } from "../components/Kpi";
import { fmtInt, fmtUsd } from "../lib/fmt";
import { useStore } from "../lib/store";
import { Title } from "../components/Info";

const StatusIcon = ({ s }: { s: string }) =>
  s === "PASS" ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : s === "ABSENT" ? <CircleSlash className="h-4 w-4 text-slate-400" /> : <XCircle className="h-4 w-4 text-red-600" />;

export default function DataModelPage() {
  const { inputs: I, overview } = useStore();
  if (!I) return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Spinner /> Loading…</div>;
  const t = Object.fromEntries(I.tables.map((x) => [x.table, x]));
  const on = (n: string) => t[n]?.status === "PASS";
  const cm = I.planning.customer_minute_value, dr = I.planning.discount_rate;
  const cp = I.class_parameters ?? [];
  const has = (p: string) => cp.some((r) => r.parameter === p);
  const cpv = (p: string) => cp.filter((r) => r.parameter === p).map((r) => `${r.asset_class} ${r.value} ${r.unit}`).join(", ") || "–";
  const features: [string, string, boolean, string][] = [
    ["Life curves per class and cohort", "asset + record_window", on("asset") && on("record_window"), "Fitted on documented removals of every unit ever in service; records starting after the first installs are corrected for."],
    ["Reject backlog", "inspection (unresolved reject / priority_reject)", on("inspection"), `Funded first when the plan's backlog setting is on: priority rejects by plan year ${I.must_address_rule.priority_reject}, rejects by year ${I.must_address_rule.reject}.`],
    ["Customers interrupted per failure", "device.customers_downstream", on("device"), "Who loses power when an asset fails."],
    ["Restoration time per failure", "outage", on("outage"), on("outage") ? "Median blue-sky outage duration, by failed-asset class where there are enough events." : "No outage history: customer-minutes are not valued."],
    ["Dollar plans", "action_cost", on("action_cost"), on("action_cost") ? `Priced classes: ${I.priced_classes.join(", ")}. Others show probabilities and customers only.` : "No costs: probabilities and customers only."],
    ["Value of reliability", "planning_parameter.customer_minute_value", cm != null, cm != null ? `$${cm} per customer-minute` : "Not given: customer-minutes reported, not priced."],
    ["Discounting", "planning_parameter.discount_rate", dr != null, dr != null ? `${(dr * 100).toFixed(1)}% per year` : "Not given: benefits not discounted."],
    ["Failure share from a stated source", "class_parameter.failure_share", has("failure_share"), has("failure_share") ? cpv("failure_share") : "Not given: classes whose removals only say end_of_life show no failures, SAIFI, SAIDI or risk $."],
    ["Planned-outage minutes", "class_parameter.planned_outage_setup_minutes / _minutes_per_asset", has("planned_outage_setup_minutes") || has("planned_outage_minutes_per_asset"),
      has("planned_outage_setup_minutes") || has("planned_outage_minutes_per_asset") ? `${cpv("planned_outage_setup_minutes")}; ${cpv("planned_outage_minutes_per_asset")}` : "Not given: a planned replacement causes no planned outage in the figures."],
    ["Crew mobilization and work bundling", "class_parameter.mobilization_usd (+ assets_per_visit)", has("mobilization_usd") || has("planned_outage_setup_minutes"),
      has("mobilization_usd") ? cpv("mobilization_usd") : has("planned_outage_setup_minutes") ? "Bundling shares the outage setup by device section." : "Not given: no shared visit costs, so plans don't bundle."],
    ["Fast asset lookups (map drawer)", "Lakebase synced tables (optional)", I.serving?.backend === "lakebase",
      I.serving?.backend === "lakebase" ? `Lakebase ${I.serving.instance}: per-asset reads in milliseconds.`
        : I.serving?.error ? `Lakebase unavailable (${I.serving.error}): per-asset reads come from the SQL warehouse; Lakebase is retried every few minutes.` : "Not configured: per-asset reads come from the SQL warehouse (about a second or more)."],
    ["Actual replacement capital", "capital_history", on("capital_history"), on("capital_history") ? "Historical capital is the actual spend." : "Not given: historical capital is estimated at today's planned cost."],
  ];
  const nFail = I.tables.filter((x) => x.status === "FAIL").length, nAbs = I.tables.filter((x) => x.status === "ABSENT").length;
  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-6 py-6" id="data-model">
      <div>
        <h1 className="text-2xl font-bold"><Title info="The tables, columns, types, units and codes this application reads. Checks cover structure only: columns, types, not-null, keys, references, codes and physical domains such as 0-100%. Missing optional tables switch the features that need them off; nothing is filled in.">Data model</Title></h1>
        <p className="text-muted-foreground">Data as of {I.model_run.as_of_date} · cohorts: {I.model_run.settings?.cohorts?.keys ? `asset.cohort when supplied, else ${Object.entries(I.model_run.settings.cohorts.keys).map(([k, v]: any) => `${k}: ${v.join(" × ")}`).join("; ")}` : "–"}</p>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi label="Tables pass" value={`${I.tables.length - nFail - nAbs}`} accent />
        <Kpi label="Optional tables absent" value={`${nAbs}`} />
        <Kpi label="Tables failing" value={`${nFail}`} />
        <Kpi label="Forecast as of" value={I.model_run.as_of_date} />
        <Kpi label="Active assets with a forecast" value={fmtInt(I.coverage.reduce((a, r) => a + r.active_with_forecast, 0))} />
      </div>
      <Card>
        <CardHeader><CardTitle>What's on, and why</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-sm" id="features">
            <tbody>{features.map(([f, need, ok, why]) => (
              <tr key={f} className="border-b"><td className="py-2 pr-3 font-medium">{f}</td><td className="pr-3"><code className="text-xs">{need}</code></td>
                <td className="pr-3">{ok ? <Badge className="bg-green-100 text-green-800 hover:bg-green-100">on</Badge> : <Badge variant="outline">off</Badge>}</td><td className="text-muted-foreground">{why}</td></tr>))}</tbody>
          </table>
          {I.notes.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-muted-foreground">{I.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </CardContent>
      </Card>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle><Title info="Classes with no documented end of life get no life curve and no forecast.">Coverage by asset class</Title></CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Class</th><th className="text-right">Active</th><th className="text-right">Mean age</th><th className="text-right">Expected EoL / yr</th><th className="text-right">In dollar plans</th></tr></thead>
              <tbody>{(overview?.by_class ?? []).map((r) => (
                <tr key={r.asset_class} className="border-b tabular-nums"><td className="py-1.5">{r.asset_class}</td><td className="text-right">{fmtInt(r.active)}</td><td className="text-right">{r.mean_age.toFixed(1)}</td>
                  <td className="text-right">{fmtInt(r.expected_eol)}</td><td className="text-right">{r.priced ? <Badge className="bg-green-100 text-green-800 hover:bg-green-100">yes</Badge> : <span className="text-xs text-muted-foreground">no cost rows</span>}</td></tr>))}</tbody></table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle><Title info="Every value with its source, as supplied in the data model.">Costs and planning parameters</Title></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <table className="w-full text-xs"><thead className="border-b text-left text-muted-foreground"><tr><th className="py-1.5">Class</th><th>Action</th><th>Basis</th><th>Zone</th><th className="text-right">USD</th><th className="pl-3">Source</th></tr></thead>
              <tbody>{I.costs.map((c, i) => (<tr key={i} className="border-b"><td className="py-1">{c.asset_class}</td><td>{c.action}</td><td>{c.cost_basis}</td><td>{c.cost_zone ?? "all"}</td><td className="text-right tabular-nums">{fmtUsd(c.usd_per_asset)}</td><td className="pl-3 text-muted-foreground">{c.source}</td></tr>))}</tbody></table>
            <table className="w-full text-xs"><tbody>{Object.entries(I.planning).map(([k, v]) => <tr key={k} className="border-b"><td className="py-1 font-mono">{k}</td><td className="text-right tabular-nums">{String(v)}</td></tr>)}</tbody></table>
            <table className="w-full text-xs"><tbody>{Object.entries(I.restoration.minutes).map(([k, v]) => (
              <tr key={k} className="border-b"><td className="py-1">restoration: {k === "*" ? "all classes (fallback)" : k}</td><td className="text-right tabular-nums">{Math.round(v)} min</td><td className="pl-3 text-muted-foreground">{I.restoration.source[k]}</td></tr>))}</tbody></table>
          </CardContent>
        </Card>
      </div>
      <h2 className="pt-2 text-lg font-semibold">Tables</h2>
      
      <div className="space-y-3">
        {I.tables.map((x) => (
          <details key={x.table} className="rounded-xl border bg-card px-4 py-3" data-table={x.table}>
            <summary className="flex cursor-pointer items-center gap-3">
              <StatusIcon s={x.status} /><span className="font-mono font-semibold">{x.table}</span>
              <Badge variant="outline">{x.required ? "required" : "optional"}</Badge>
              <span className="flex-1 truncate text-sm text-muted-foreground">{x.grain}</span><span className="text-xs text-muted-foreground">{x.rows}</span>
            </summary>
            <div className="mt-3 space-y-2">
              {x.why && <p className="text-sm"><b>Why:</b> {x.why}</p>}
              {x.enables && <p className="text-sm"><b>Enables:</b> {x.enables}</p>}
              <table className="w-full text-xs"><thead className="border-b text-left text-muted-foreground"><tr><th className="py-1.5">Column</th><th>Type</th><th>Unit</th><th>Required</th><th>Meaning</th></tr></thead>
                <tbody>{x.columns.map((c: any) => (
                  <tr key={c.name} className="border-b align-top"><td className="py-1.5 font-mono">{c.name}</td><td>{c.type}</td><td>{c.unit ?? ""}</td><td>{c.required ? "yes" : c.required_when ? `when ${c.required_when}` : "no"}</td>
                    <td>{c.meaning ?? ""}{c.codes && <span className="text-muted-foreground"> codes: {Object.keys(I.codes[c.codes]).join(", ")}</span>}{c.references && <span className="text-muted-foreground"> → {c.references}</span>}</td></tr>))}</tbody></table>
              <details><summary className="cursor-pointer text-xs text-muted-foreground">{x.checks.length} checks</summary>
                <table className="mt-1 w-full text-xs"><tbody>{x.checks.map((k: any, i: number) => <tr key={i} className="border-b"><td className="py-1"><StatusIcon s={k.status} /></td><td>{k.check}</td><td className="text-muted-foreground">{k.detail}</td></tr>)}</tbody></table>
              </details>
            </div>
          </details>
        ))}
      </div>
      <h2 className="pt-2 text-lg font-semibold"><Title info="What any probability model provides to this application. The shipped model writes these tables; a different model (condition-based, machine learning, a vendor feed) can replace it by writing the same tables.">Probability contract</Title></h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {Object.entries(I.model_outputs).map(([name, spec]: [string, any]) => (
          <Card key={name}><CardHeader><CardTitle className="font-mono text-base">{name}</CardTitle><CardDescription>{spec.grain}</CardDescription></CardHeader>
            <CardContent><table className="w-full text-xs"><tbody>{Object.entries(spec.columns).map(([k, v]: [string, any]) => <tr key={k} className="border-b align-top"><td className="py-1 font-mono">{k}</td><td className="text-muted-foreground">{v.meaning ?? v.type}</td></tr>)}</tbody></table></CardContent></Card>
        ))}
      </div>
    </div>
  );
}
