// Methods & assumptions: how every figure is calculated, what it assumes, and how to change it. Values shown here come
// from the deployment's own data model (costs, parameters, restoration times, failure shares), never from the page.
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@databricks/appkit-ui/react";
import { ArrowRight, Calculator, Database, LineChart } from "lucide-react";
import { CNAIM, IEEE1366 } from "../components/Info";
import { fmtPct, fmtUsd } from "../lib/fmt";
import { useStore } from "../lib/store";

export default function DocsPage() {
  const { inputs: I, overview } = useStore();
  const cm = I?.planning.customer_minute_value, dr = I?.planning.discount_rate;
  const fs = (overview?.by_class ?? []).filter((c: any) => c.failure_share != null);
  const costRows = I?.costs ?? [];
  const win = I?.failure_share_years ?? I?.model_run.settings?.failure_share_years;
  const cp = I?.class_parameters ?? [];
  const cpv = (p: string) => cp.filter((r) => r.parameter === p).map((r) => `${r.asset_class} ${r.value} ${r.unit} (${r.source})`).join("; ") || "not supplied";
  return (
    <div className="mx-auto max-w-5xl space-y-8 px-6 py-8 text-[15px] leading-relaxed" id="docs">
      <div>
        <h1 className="text-2xl font-bold">Methods &amp; assumptions</h1>
        <p className="text-muted-foreground">How each figure is calculated, what it assumes, and where to change it.</p>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Layer icon={<Database className="h-5 w-5" />} title="1 · Asset data model" body="Every unit ever in service (active and removed), when removal records begin, the device tree, and optionally inspections, outages, costs and parameters. Checked for structure only." />
        <ArrowRight className="hidden self-center text-muted-foreground md:block" />
        <Layer icon={<LineChart className="h-5 w-5" />} title="2 · Probability model" body="A wear-out life curve per class and cohort, fitted on documented removals; each active asset is scored at its age. Replaceable by any model that writes the probability contract." />
        <ArrowRight className="hidden self-center text-muted-foreground md:block" />
        <Layer icon={<Calculator className="h-5 w-5" />} title="3 · Decisions" body="Consequence and risk, the value of replacing each asset in each year, the multi-year plan under budgets, and program comparison." />
      </div>

      <Section title="Risk (monetized)">
        <p>Risk follows the standard definition used in asset risk management, <b>risk = probability of failure × consequence of failure</b> (e.g. <A {...CNAIM} />).</p>
        <Formula>Risk next year = Σ over assets  P(end of life next year) × share failing in service × CoF</Formula>
        <Formula>CoF = (emergency cost − planned cost − crew mobilization) + customers interrupted × (restoration minutes − planned-outage minutes) × value of a customer-minute</Formula>
        <Formula>Planned job = planned replacement cost + crew mobilization + customers × (setup + per-unit planned-outage minutes) × value of a customer-minute</Formula>
        <p className="text-sm">So CoF = (emergency cost + unplanned customer-minutes value) − planned job: what a failure costs beyond the planned job that end of life requires anyway.</p>
        <table className="mt-3 w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Term</th><th>Where it comes from</th><th>This deployment</th></tr></thead>
          <tbody className="[&_td]:border-b [&_td]:py-2 [&_td]:align-top">
            <tr><td>P(end of life next year)</td><td>Probability model (life curve for the asset's cohort at its age)</td><td>per asset</td></tr>
            <tr><td>Share failing in service</td><td>Documented removals: failures ÷ (failures + inspection replacements), pooled over the last {win ?? "–"} years (model setting <code>failure_share_years</code>), per class; or a supplied <code>class_parameter</code> with its source. The Curves page shows the share by year.</td>
              <td>{fs.length ? fs.map((c: any) => `${c.asset_class} ${fmtPct(c.failure_share)} (${c.failure_share_source ?? "records"})`).join("; ") : "none"}</td></tr>
            <tr><td>Planned / emergency replacement cost</td><td><code>action_cost</code> (replace, planned / emergency), by cost zone</td>
              <td>{costRows.filter((c) => c.action === "replace").map((c) => `${c.asset_class} ${c.cost_basis}${c.cost_zone ? ` (${c.cost_zone})` : ""} ${fmtUsd(c.usd_per_asset)}`).join("; ") || "none"}</td></tr>
            <tr><td>Customers interrupted</td><td>Customers downstream of the protective device that opens when the asset fails (<code>device.customers_downstream</code>, or the asset's own override)</td><td>per asset</td></tr>
            <tr><td>Restoration minutes</td><td>Median duration of outages on non-major-event days caused by a failed asset of the class (at least 30 events), else of all such outages</td>
              <td>{I ? Object.entries(I.restoration.minutes).map(([k, v]) => `${k === "*" ? "all classes" : k} ${Math.round(v)} min`).join("; ") : ""}</td></tr>
            <tr><td>Planned-outage minutes</td><td><code>class_parameter</code> planned_outage_setup_minutes (per job) and planned_outage_minutes_per_asset (per unit); the customers are those behind the asset's protective device. Zero where the work is done energized.</td>
              <td>setup: {cpv("planned_outage_setup_minutes")}; per unit: {cpv("planned_outage_minutes_per_asset")}</td></tr>
            <tr><td>Crew mobilization</td><td><code>class_parameter.mobilization_usd</code>, per crew visit, on top of a planned unit cost that excludes it</td><td>{cpv("mobilization_usd")}</td></tr>
            <tr><td>Value of a customer-minute</td><td><code>planning_parameter.customer_minute_value</code></td><td>{cm != null ? `$${cm} per customer-minute` : "not supplied: reliability not monetized"}</td></tr>
          </tbody></table>
        <p className="mt-3 text-sm"><b>Caveats.</b> Planned and unplanned customer-minutes are valued at the same rate; some regulators and value-of-service studies value planned interruptions lower.
          The financial consequence counts only the emergency premium over a planned replacement; the planned replacement cost is reported
          separately as end-of-life cost (capital need), so it is not counted twice. Safety and environmental consequences, part of CNAIM's consequence categories, are not included.
          CNAIM derives probability of failure from a condition-based health index; here it comes from life curves fitted on the utility's own removals.</p>
      </Section>

      <Section title="Reliability contributions (SAIFI, SAIDI)">
        <p>System indices in the sense of <A {...IEEE1366} />, restricted to the interruptions expected from asset in-service failures.</p>
        <Formula>SAIFI contribution = Σ P(failure) × customers interrupted ÷ customers served</Formula>
        <Formula>SAIDI contribution = Σ P(failure) × customers interrupted × restoration minutes ÷ customers served</Formula>
        <p className="text-sm">Customers served = all customers below feeder-head devices in <code>device</code> ({overview?.customers_served?.toLocaleString() ?? "–"}). Only classes with a known failure share contribute.</p>
        <Formula>Planned-outage SAIDI = Σ planned customer-minutes of replacement work ÷ customers served</Formula>
        <p className="text-sm">Planned interruptions from replacement work (the program's jobs and the end-of-life units replaced after inspection) are reported separately from the failure contribution. Whether they count toward reported SAIDI depends on the regulator.</p>
      </Section>

      <Section title="Replacement demand forecast">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><b>History</b>: units removed per year by the documented removal reason in <code>asset</code>. <i>Capital program</i> = removals for reasons other than the asset's condition (rebuilds, conversions, relocations).</li>
          <li><b>Forecast</b>: expected end-of-life units per year if nothing is replaced early, including the end of life of the units that replace them (each replacement follows its class's new-asset curve).</li>
          <li>Where the failure share is known, the forecast is split into in-service failures and inspection replacements; otherwise it is shown as end of life with the split not recorded.</li>
          <li>The forecast does not include future capital-program removals, damage, or growth of the asset base.</li>
        </ul>
      </Section>

      <Section title="Reject backlog">
        <p className="text-sm">Inspections with outcome <code>reject</code> or <code>priority_reject</code> and no <code>resolved_date</code> by the as-of date. Plans fund them first: priority rejects by plan year {I?.must_address_rule.priority_reject}, rejects by year {I?.must_address_rule.reject}.</p>
      </Section>

      <Section title="Cohorts">
        <p className="text-sm">A cohort is a group of units expected to share a life curve. If <code>asset.cohort</code> is supplied, it is used as given. Otherwise the cohort is built from the columns set in the model
          settings (currently {I?.model_run.settings?.cohorts?.keys ? Object.entries(I.model_run.settings.cohorts.keys).map(([k, v]: any) => `${k}: ${v.join(" × ")}`).join("; ") : "–"}). A cohort with fewer than
          {" "}{I?.model_run.settings?.cohorts?.min_events ?? "–"} documented end-of-life events uses its class curve.</p>
      </Section>

      <Section title="Historical replacement activity">
        <p className="text-sm">Average removals per year over the most recent years of records (up to 10, within the record window), by reason. Capital is the actual spend from <code>capital_history</code> when supplied; otherwise the
          volume is priced at today's planned replacement cost, as an estimate.</p>
      </Section>

      <Section title="Plan value">
        <p className="text-sm">Value of replacing an asset in plan year t = expected cost of leaving it until it reaches end of life (planned cost when replaced on inspection; emergency cost plus customer-minutes when failed; the replacement's own
          future end of life included) minus the cost of the planned job in year t, over a {I?.model_run.settings?.horizon_years ?? 30}-year horizon, discounted at {dr != null ? fmtPct(dr) : "0 (no discount rate supplied)"} per year.</p>
      </Section>

      <Section title="Plan constraints and work bundling">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li><b>Scope</b>: a map selection and/or a set of asset classes; assets outside the scope are left as they are.</li>
          <li><b>Plan years</b>: the plan commits to 1 to 10 years but always optimizes 10 years ahead, so a short plan takes only the assets whose best year to replace falls within it. Rejects due after the committed years (e.g. due by year {I?.must_address_rule.reject} in a 1-year plan) stay in the later year they are due.</li>
          <li><b>Budgets</b>: a total annual budget, and optional annual envelopes per class within it; the reject backlog is funded first.</li>
          <li><b>Bundling</b>: a crew visit to one protective-device section (or feeder) replaces several units for one mobilization and, on a section, one outage setup; each unit adds its own planned-outage minutes.
            With a limit on units per visit (<code>assets_per_visit</code>: {cpv("assets_per_visit")}), larger bundles need more visits. The optimizer groups work only where the shared cost pays for it.</li>
          <li>Visit costs are counted when the visit is scheduled; a unit's own planned job is counted only if the unit is still in service in its plan year.</li>
          <li>Plans with bundling are solved to within 0.5% of the optimum (the status shows the gap reached); without bundling, to within 0.01%. The frontier's budgets are solved with shorter limits (1% with bundling).</li>
        </ul>
      </Section>

      <Section title="Strategies (Compare strategies)">
        <p className="text-sm">The strategy is a plan setting: the Plan page shows one strategy's plan in full, and Compare strategies shows every strategy at the same settings (budget, plan years,
          reject backlog, scope, classes, crews and class envelopes, shared by the two pages), each evaluated with the same expected-value arithmetic. Work bundling is an optimizer
          constraint and applies to the Max net value strategies only. Saved plans (kept in the browser) are shown in the Compare plots and on the Risk map at their own settings. Rule-based strategies fund the reject backlog by its deadline, then take the highest-scoring assets each year while the budget lasts.</p>
        <table className="mt-2 w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Strategy</th><th>How it chooses</th></tr></thead>
          <tbody className="[&_td]:border-b [&_td]:py-2 [&_td]:align-top">
            {(I?.strategies ?? []).map((x) => <tr key={x.k}><td className="pr-3">{x.label}</td><td>{x.rule}{x.optimizer ? " (optimizer: bundling applies)" : ""}</td></tr>)}
          </tbody></table>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          <li>Every strategy funds the reject backlog by its deadline when that setting is on (Reactive, the baseline, whatever the budget). If a year's budget, crews or class envelopes can't hold the backlog due that year, the strategy has no plan at those settings and says so (as the optimizer does).</li>
          <li>The full-budget strategy adds the next-best replacements after the optimal plan, within the total budget, the class envelopes and the crews.</li>
          <li>Rule-based strategies take the highest-scoring units each year within the total budget, crews and class envelopes; Worst feeders first finishes a feeder before starting the next, and a unit whose class envelope is used up waits for the next year.</li>
        </ul>
        <p className="mt-2 text-sm">Breaks even at = the value of a customer-minute at which the plan's discretionary work has zero net value (net value is linear in it, so it is solved from the plan evaluated at $0 and $1).
          $0 means the work pays on the emergency premium alone; none means more valuable reliability wouldn't make it pay.
          $ per SAIDI minute = (total capital − Reactive's total capital) ÷ (Reactive's SAIDI − the strategy's SAIDI), over the plan years. Uncertainty ranges come from a Monte Carlo of the same fixed plans,
          over the same assets, years and backlog rule, with the same random futures for every strategy; its mean is the expected value shown.</p>
      </Section>

      <Section title="Projected map (Risk map time control)">
        <p className="text-sm">Plan year t on the Risk map shows the expected state in that year under the selected plan (current or saved): for each priced asset, the expected end-of-life events in year t,
          counting the original unit, its replacement by the plan, and replacements at end of life with their own later end of life. Every next-year figure (failures, SAIFI, SAIDI, risk) scales with it,
          since each is P(end of life) times a fixed consequence. Comparisons are against today and against doing nothing in the same year. Colour scales, risk-matrix bands and feeder scales stay at today's values.
          Classes not in dollar plans stay at today's state; the reject backlog shown is today's backlog not yet replaced (new inspection rejects are not forecast); customers and restoration times stay at today's.</p>
      </Section>

      <Section title="As-of date">
        <p className="text-sm">Forecasts start the day after the latest install or removal date in <code>asset</code> ({I?.model_run.as_of_date}). Year 1 is the 12 months from that date.</p>
      </Section>

      <Section title="Filling data gaps">
        <table className="w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Gap</th><th>Effect</th><th>How to fill it</th></tr></thead>
          <tbody className="[&_td]:border-b [&_td]:py-2 [&_td]:align-top">
            <tr><td>Removals only say <code>end_of_life</code></td><td>No failure share: no failures, SAIFI, SAIDI or risk $ for the class</td><td>Supply <code>class_parameter.failure_share</code> with its source (e.g. from outage cause codes)</td></tr>
            <tr><td>No cost rows for a class</td><td>Class is not in dollar figures or plans</td><td>Add <code>action_cost</code> rows (planned and emergency replacement) with sources</td></tr>
            <tr><td>Short or no removal history</td><td>History shows the years available; with no documented end of life a class gets no life curve</td><td>Use a different probability model (e.g. condition-based or published life tables) that writes the probability contract</td></tr>
            <tr><td>No planned-outage minutes or mobilization</td><td>A planned replacement costs its planned cost only: no planned outage, and nothing for bundling to share</td><td>Supply the <code>class_parameter</code> planned-outage minutes (0 for energized work) and <code>mobilization_usd</code></td></tr>
            <tr><td>No capital history</td><td>Historical capital is estimated at today's cost</td><td>Supply <code>capital_history</code></td></tr>
            <tr><td>No outage history</td><td>No restoration times: customer-minutes not valued</td><td>Supply <code>outage</code></td></tr>
          </tbody></table>
      </Section>

      <Section title="Assumptions">
        <table className="w-full text-sm"><thead className="border-b text-left text-xs text-muted-foreground"><tr><th className="py-2">Assumption</th><th>Applies to</th><th>To change</th></tr></thead>
          <tbody className="[&_td]:border-b [&_td]:py-2 [&_td]:align-top">
            <tr><td>Customer counts stay at today's level; no growth in customers served</td><td>SAIFI, SAIDI, risk, plan value</td><td>not modelled</td></tr>
            <tr><td>Today's network: customers downstream and device tree as they are now</td><td>consequence of failure</td><td>update <code>device</code></td></tr>
            <tr><td>Restoration time is the historical median on non-major-event days, constant over time</td><td>SAIDI, risk</td><td>update <code>outage</code></td></tr>
            <tr><td>Costs are today's, nominal, with no escalation</td><td>all dollar figures</td><td><code>action_cost</code></td></tr>
            <tr><td>The failure share of the last {win ?? "–"} years holds in future</td><td>failures, SAIFI, SAIDI, risk</td><td>model settings or <code>class_parameter</code></td></tr>
            <tr><td>The inspection program continues as it ran historically (it is reflected in the fitted curves and failure shares)</td><td>probabilities</td><td>refit after program changes</td></tr>
            <tr><td>Replacements follow the class's new-asset curve</td><td>forecast, plan</td><td>model settings (<code>new_asset_curve</code>)</td></tr>
            <tr><td>No climate or load-growth effect on probabilities</td><td>probabilities</td><td>a different probability model</td></tr>
            <tr><td>Life curves beyond the oldest documented end of life are extrapolated</td><td>older assets, later forecast years</td><td>longer records or a different model</td></tr>
            <tr><td>Value counted over a {I?.model_run.settings?.horizon_years ?? 30}-year horizon, discounted at {dr != null ? fmtPct(dr) : "0"} per year</td><td>plan value</td><td>model settings; <code>planning_parameter.discount_rate</code></td></tr>
            <tr><td>Future capital-program removals and damage are not forecast</td><td>replacement demand forecast</td><td>not modelled</td></tr>
          </tbody></table>
      </Section>
    </div>
  );
}

function A({ label, href }: { label: string; href: string }) {
  return <a href={href} target="_blank" rel="noreferrer" className="underline">{label}</a>;
}
function Formula({ children }: { children: ReactNode }) {
  return <div className="my-2 rounded-md bg-muted px-3 py-2 font-mono text-[13px]">{children}</div>;
}
function Layer({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <Card className="h-full"><CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><span style={{ color: "var(--armor)" }}>{icon}</span>{title}</CardTitle></CardHeader>
      <CardContent className="text-sm text-muted-foreground">{body}</CardContent></Card>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section><h2 className="mb-2 text-lg font-semibold">{title}</h2>{children}</section>;
}
