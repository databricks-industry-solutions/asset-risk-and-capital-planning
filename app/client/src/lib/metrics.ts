// One definition per metric, used by every page (labels, hover definitions, formulas, references), so the same number
// is named and explained the same way everywhere. Wording is general and impersonal.
import { CNAIM, IEEE1366 } from "../components/Info";

export interface MetricDef { label: string; info: string; formula?: string; source?: { label: string; href: string } }

export const M: Record<string, MetricDef> = {
  assets: { label: "Assets", info: "Units in service today." },
  age: { label: "Mean age", info: "Average years in service of the units shown." },
  eol: { label: "End of life / yr", info: "Expected number of units reaching end of life in the next 12 months: failing in service, or replaced after an inspection finds them at end of life.", formula: "Σ P(end of life next year)" },
  pEol: { label: "P(end of life) next year", info: "Probability the unit reaches end of life in the next 12 months if nothing is done, from its cohort's life curve at its age.", formula: "1 − S(age + 1) ÷ S(age)" },
  failures: { label: "Failures / yr", info: "End-of-life events expected to happen as failures in service, rather than being replaced on inspection.", formula: "Σ P(end of life) × share failing in service" },
  pFail: { label: "P(failure) next year", info: "Probability the unit fails in service in the next 12 months.", formula: "P(end of life) × share failing in service" },
  shareFailing: { label: "Share failing in service", info: "Share of end-of-life events of this class that happen as in-service failures rather than inspection replacements.", formula: "failures ÷ (failures + inspection replacements)" },
  saifi: { label: "SAIFI contribution", info: "Expected customer interruptions per customer served per year from in-service failures.", formula: "Σ P(failure) × customers interrupted ÷ customers served", source: IEEE1366 },
  saidi: { label: "SAIDI contribution", info: "Expected minutes of interruption per customer served per year from in-service failures.", formula: "Σ P(failure) × customers interrupted × restoration minutes ÷ customers served", source: IEEE1366 },
  cof: { label: "Consequence of failure", info: "Cost of one in-service failure beyond the planned replacement that end of life requires anyway: the emergency cost over the planned job's cost, plus the value of the unplanned customer-minutes beyond the planned job's own outage.", formula: "(emergency − planned − mobilization) + customers × (restoration − planned-outage minutes) × $/customer-minute", source: CNAIM },
  risk: { label: "Risk / yr", info: "Monetized risk: probability of an in-service failure in the next 12 months times its consequence.", formula: "P(failure) × consequence of failure", source: CNAIM },
  riskPerAsset: { label: "Risk / asset", info: "Risk per asset, separating feeders with many assets from feeders in poor condition.", formula: "Σ risk ÷ assets" },
  eolCost: { label: "End-of-life cost", info: "Expected replacement cost at end of life: planned cost when replaced on inspection, emergency cost plus lost customer-minutes when failed.", formula: "P(end of life) × [share failing × (emergency + customer-minutes × $/min) + (1 − share failing) × planned job]" },
  plannedJob: { label: "Planned job", info: "Cost of replacing the unit on its own on a planned basis: planned cost, crew mobilization, and the value of the planned outage the work causes (zero where the work is done energized).", formula: "planned + mobilization + customers × (setup + per-unit minutes) × $/customer-minute" },
  plannedSaidi: { label: "Planned-outage SAIDI", info: "Minutes of planned interruption per customer served from replacement work.", formula: "Σ planned customer-minutes ÷ customers served", source: IEEE1366 },
  feederCustomers: { label: "Customers", info: "Customers served by the feeder: everyone below its feeder-head device." },
  customers: { label: "Customers out if it fails", info: "Customers downstream of the protective device that opens when this unit fails." },
  restoration: { label: "Restoration time", info: "Median duration of outages on non-major-event days caused by failures of this class; where a class has too few such outages, the median of all non-major-event outages." },
  openRejects: { label: "Reject backlog", info: "Assets with an unresolved reject or priority-reject inspection finding (the most severe one counts) not yet replaced or restored by the as-of date." },
  planYear: { label: "Plan year", info: "Year the current capital plan replaces this unit." },
  replaceValue: { label: "Replacement value by plan year", info: "Net value of replacing the unit planned in each plan year instead of leaving it until end of life, over the value horizon, discounted. Positive = worth doing that year." },
  riskMatrix: { label: "Risk matrix", info: "Likelihood (P(failure) next year) against consequence of failure, each split into five bands at the quintiles of the assets shown. Top-right cells hold the likely, high-consequence assets." },
};
