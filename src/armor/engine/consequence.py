"""Consequence of one end-of-life event, per active asset. Every number traces to a contract table.

For each asset:
  customers   who lose power if it fails in service: asset.customers_interrupted_on_failure when given, else
              device.customers_downstream of asset.upstream_device_id.
  minutes     how long they're out: the MEDIAN duration of blue-sky (non major-event-day) outages that name a
              failed asset of the same class, when there are at least `min_events`; otherwise the median of ALL
              blue-sky outages (labelled `all_outages`). No outage table -> NULL (customer-minutes not valued).
  p_failure   share of end-of-life events that happen as in-service failures (from the probability model).
              NULL when the data can't split failures from caught removals.
  costs       planned / emergency replacement cost for the asset's class and cost_zone (a zone-specific row wins
              over the class-wide NULL-zone row). NULL when the class isn't priced.

  planned job what a planned replacement of this one unit costs, from class_parameter when given (else 0, labelled):
              mobilization (USD per crew visit) and a planned outage for the same customers of
              setup + minutes-per-asset minutes. Work done energized has 0 planned-outage minutes.

With v = customer_minute_value, cm = customers * minutes (unplanned) and pm = customers * (setup + per-asset minutes):
    planned job  J = planned + mobilization + pm * v             (one unit replaced on its own)
    failure      F = emergency + cm * v
Consequence of one in-service failure (used for the risk figure, risk = P(failure) x CoF): what the failure costs
beyond the planned replacement that end of life requires anyway,
    CoF = F - J = (emergency - planned - mobilization) + (cm - pm) * v
The expected cost of one end-of-life event, if the asset is left in place until it reaches it (used for plan value):
    K = p_failure * F + (1 - p_failure) * J
Where a cost or the failure split is missing, K is NULL and the asset is left out of dollar plans, with the reason
recorded in `value_status`. Missing restoration minutes / customer_minute_value only drop the reliability term
(status `ok_without_reliability`). Nothing is defaulted.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MIN_EVENTS_CLASS_DURATION = 30


def restoration_minutes(outage: pd.DataFrame | None, asset: pd.DataFrame) -> tuple[dict, dict]:
    """{asset_class: minutes} and {asset_class: source}; plus key '*' for the all-outage fallback."""
    if outage is None or not len(outage):
        return {}, {}
    o = outage[~outage["major_event_day"].astype(bool)].copy()
    o["minutes"] = (pd.to_datetime(o["restore_ts"]) - pd.to_datetime(o["start_ts"])).dt.total_seconds() / 60
    o = o[o["minutes"] > 0]
    mins, src = {"*": float(o["minutes"].median())}, {"*": f"median of {len(o):,} blue-sky outages (all causes)"}
    cls = o.merge(asset[["asset_id", "asset_class"]], left_on="failed_asset_id", right_on="asset_id", how="inner")
    for c, g in cls.groupby("asset_class"):
        if len(g) >= MIN_EVENTS_CLASS_DURATION:
            mins[c], src[c] = float(g["minutes"].median()), f"median of {len(g):,} blue-sky outages caused by a failed {c}"
    return mins, src


PLANNED_JOB_PARAMETERS = ("planned_outage_setup_minutes", "planned_outage_minutes_per_asset", "mobilization_usd", "assets_per_visit")


def class_parameters(class_parameter: pd.DataFrame | None, names=PLANNED_JOB_PARAMETERS) -> dict:
    """{parameter: {asset_class: (value, source)}} for the named class parameters that are given."""
    out = {n: {} for n in names}
    if class_parameter is None or not len(class_parameter):
        return out
    for r in class_parameter[class_parameter["parameter"].isin(names)].itertuples():
        out[r.parameter][r.asset_class] = (float(r.value), r.source)
    return out


def build(active: pd.DataFrame, device: pd.DataFrame, outage: pd.DataFrame | None, action_cost: pd.DataFrame | None,
          planning: dict, p_failure: pd.Series, asset_all: pd.DataFrame, class_parameter: pd.DataFrame | None = None) -> pd.DataFrame:
    """`active`: active assets (contract columns). `p_failure`: asset_id -> p_failure_given_eol (may be NaN)."""
    c = active[["asset_id", "asset_class", "feeder_id", "upstream_device_id", "cost_zone", "customers_interrupted_on_failure"]].copy()
    dev = device.set_index("device_id")["customers_downstream"]
    c["customers"] = c["customers_interrupted_on_failure"].astype("Float64").fillna(c["upstream_device_id"].map(dev).astype("Float64"))
    mins, msrc = restoration_minutes(outage, asset_all)
    c["minutes"] = c["asset_class"].map(lambda k: mins.get(k, mins.get("*", np.nan)))
    c["minutes_source"] = c["asset_class"].map(lambda k: msrc.get(k, msrc.get("*")))
    c["p_failure"] = c["asset_id"].map(p_failure).astype(float)

    for basis in ("planned", "emergency"):
        c[f"{basis}_usd"] = np.nan
        c[f"{basis}_source"] = None
        if action_cost is None:
            continue
        r = action_cost[(action_cost["action"] == "replace") & (action_cost["cost_basis"] == basis)]
        zone = r[r["cost_zone"].notna()].set_index(["asset_class", "cost_zone"])
        wide = r[r["cost_zone"].isna()].set_index("asset_class")
        z = pd.MultiIndex.from_arrays([c["asset_class"], c["cost_zone"]])
        zv = pd.Series(zone["usd_per_asset"].reindex(z).to_numpy(), index=c.index)
        zs = pd.Series(zone["source"].reindex(z).to_numpy(), index=c.index)
        c[f"{basis}_usd"] = zv.fillna(c["asset_class"].map(wide["usd_per_asset"]))
        c[f"{basis}_source"] = zs.fillna(c["asset_class"].map(wide["source"]))

    # the planned job: per-class parameters, 0 where not given (and the source says so)
    cp = class_parameters(class_parameter)
    for name in PLANNED_JOB_PARAMETERS:
        given = cp[name]
        c[name] = c["asset_class"].map(lambda k: given[k][0] if k in given else np.nan)
        c[f"{name}_source"] = c["asset_class"].map(lambda k: given[k][1] if k in given else "not given")
    setup, per = c["planned_outage_setup_minutes"].fillna(0.0), c["planned_outage_minutes_per_asset"].fillna(0.0)
    c["planned_outage_minutes"] = setup + per      # one unit replaced on its own
    c["planned_customer_minutes"] = c["customers"].astype(float) * c["planned_outage_minutes"]
    mob = c["mobilization_usd"].fillna(0.0)

    v = planning.get("customer_minute_value")
    c["customer_minutes_per_failure"] = c["customers"].astype(float) * c["minutes"]
    status = np.select(
        [c["planned_usd"].isna(), c["emergency_usd"].isna(), c["p_failure"].isna(), c["minutes"].isna() | (v is None)],
        ["not priced: no planned replacement cost for this class/zone",
         "not priced: no emergency replacement cost for this class/zone",
         "no failure/caught split: the records only say end_of_life",
         "ok_without_reliability"],
        default="ok")
    c["value_status"] = status
    # Without restoration minutes or a customer_minute_value, dollars still work but reliability is valued at 0;
    # the status says so on every affected row, and the app shows it.
    cm_value = (c["customer_minutes_per_failure"] * v).fillna(0.0) if v is not None else 0.0
    pm_value = (c["planned_customer_minutes"] * v).fillna(0.0) if v is not None else 0.0
    per_value = (c["customers"].astype(float) * per * v).fillna(0.0) if v is not None else 0.0
    # the planned job, valued: capital + mobilization + its planned outage (one unit on its own) ...
    c["planned_job_usd"] = c["planned_usd"] + mob + pm_value
    # ... and the part of it that does NOT depend on how many units share the visit (bundling shares this part)
    c["visit_fixed_usd"] = mob + (pm_value - per_value)
    c["planned_outage_value_usd"] = pm_value
    c["cost_per_eol_usd"] = c["p_failure"] * (c["emergency_usd"] + cm_value) + (1 - c["p_failure"]) * c["planned_job_usd"]
    # Consequence of failure (CoF), in the sense of the standard risk definition risk = PoF x CoF (e.g. Ofgem CNAIM v2.1):
    # what an in-service failure costs beyond the planned replacement that end of life requires anyway. Financial part
    # = emergency cost over the planned job's; network-performance part = (unplanned - planned) customer-minutes x value.
    c["cof_usd"] = (c["emergency_usd"] - c["planned_usd"] - mob) + (cm_value - pm_value)
    bad = ~c["value_status"].isin(["ok", "ok_without_reliability"])
    c.loc[bad, "cost_per_eol_usd"] = np.nan
    c.loc[bad, "cof_usd"] = np.nan
    return c
