"""Glue: contract tables + probability outputs -> one per-asset portfolio frame the plan and simulation run on.

    pf = build(tables, model_outputs, horizon=30, plan_years=10)

pf.assets  one row per ACTIVE asset with a forecast: consequence, costs, risk, value status, must-address flag
pf.P       (N, H) p_end_of_life by forecast year, rows aligned with pf.assets
pf.new     asset_class -> p_end_of_life by age 0..H for a replacement
pf.benefit value.benefits(...) for the priced assets (dollars and avoided end-of-life events per plan year)

The decision population is ACTIVE assets only; removed units matter only through the life curves they trained.
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd

from . import consequence, value

# Open findings that must be addressed, and by which plan year. A plan setting (shown in the app), not data.
MUST_ADDRESS_DEADLINE = {"priority_reject": 1, "reject": 2}


@dataclasses.dataclass
class Portfolio:
    assets: pd.DataFrame
    P: np.ndarray
    new: dict
    benefit: dict
    plan_years: int
    horizon: int
    discount_rate: float | None
    notes: list


def open_findings(inspection: pd.DataFrame | None, active_ids: pd.Index, as_of: pd.Timestamp) -> pd.DataFrame:
    """Latest unresolved reject / priority_reject per active asset (as of `as_of`)."""
    if inspection is None or not len(inspection):
        return pd.DataFrame(columns=["asset_id", "open_finding", "finding_date"])
    i = inspection.copy()
    i["inspection_date"] = pd.to_datetime(i["inspection_date"])
    res = pd.to_datetime(i["resolved_date"])
    i = i[i["outcome"].isin(list(MUST_ADDRESS_DEADLINE)) & (i["inspection_date"] < as_of) & (res.isna() | (res >= as_of))
          & i["asset_id"].isin(active_ids)]
    i["rank"] = i["outcome"].map({"priority_reject": 0, "reject": 1})
    i = i.sort_values(["asset_id", "rank"]).groupby("asset_id").head(1)
    return i.rename(columns={"outcome": "open_finding", "inspection_date": "finding_date"})[["asset_id", "open_finding", "finding_date"]]


def build(tables: dict, mo: dict, horizon: int = 30, plan_years: int = 10, classes: list | None = None) -> Portfolio:
    """`classes` limits the portfolio to those asset classes (e.g. the priced ones, to keep the app's memory small);
    None = every class."""
    notes = []
    run = mo["model_run"].iloc[0]
    as_of = pd.Timestamp(run["as_of_date"])
    asset = tables["asset"]
    fc_ids = pd.Index(mo["pof_forecast"]["asset_id"].unique())
    # classes=None: every class; an empty list (nothing priced) gives an empty portfolio, not every class
    in_scope = asset["removal_date"].isna() & (asset["asset_class"].isin(classes) if classes is not None else True)
    act = asset[in_scope & asset["asset_id"].isin(fc_ids)].reset_index(drop=True)
    no_fc = int((in_scope & ~asset["asset_id"].isin(fc_ids)).sum())
    if no_fc:
        notes.append(f"{no_fc:,} active assets have no forecast from the probability model and are not in the plan")
    P = value.forecast_matrix(mo["pof_forecast"], act["asset_id"].to_numpy(), horizon)
    pfge = mo["pof_forecast"][mo["pof_forecast"]["year_offset"] == 1].set_index("asset_id")["p_failure_given_eol"]

    planning = {}
    if tables.get("planning_parameter") is not None:
        planning = dict(zip(tables["planning_parameter"]["parameter"], tables["planning_parameter"]["value"]))
    # restoration by class looks up the class of each outage's failed asset, which is often a REMOVED unit;
    # callers holding only active assets pass the (asset_id, asset_class) of every failed asset as asset_all
    c = consequence.build(act, tables["device"], tables.get("outage"), tables.get("action_cost"), planning, pfge,
                          tables.get("asset_all", asset), tables.get("class_parameter"))
    act = act.merge(c.drop(columns=["asset_class", "feeder_id", "upstream_device_id", "cost_zone", "customers_interrupted_on_failure"]),
                    on="asset_id", how="left")
    act["calendar_age_years"] = (as_of - pd.to_datetime(act["install_date"])).dt.days / 365.25
    act["p_eol_next_year"] = P[:, 0]
    act["expected_failures_next_year"] = P[:, 0] * act["p_failure"].to_numpy()
    # risk (standard definition): P(in-service failure next year) x consequence of failure
    act["risk_usd_next_year"] = act["expected_failures_next_year"] * act["cof_usd"].to_numpy(float)
    # capital need: expected cost of end of life next year (planned when caught, emergency + outage when failed)
    act["eol_cost_usd_next_year"] = value.annual_risk(P, act["cost_per_eol_usd"].to_numpy())
    act["expected_customers_interrupted_next_year"] = act["expected_failures_next_year"] * act["customers"].astype(float)
    act["customer_minutes_at_risk_next_year"] = act["expected_failures_next_year"] * act["customer_minutes_per_failure"].astype(float)
    # planned interruptions if nothing new is done: the end-of-life units caught and replaced planned
    act["planned_customer_minutes_next_year"] = P[:, 0] * (1 - act["p_failure"].to_numpy()) * act["planned_customer_minutes"].astype(float)
    of = open_findings(tables.get("inspection"), pd.Index(act["asset_id"]), as_of)
    act = act.merge(of, on="asset_id", how="left")
    act["must_address_by_year"] = act["open_finding"].map(MUST_ADDRESS_DEADLINE)

    nac = mo["new_asset_curve"]
    new = {cls: g.sort_values("age_year")["p_end_of_life"].to_numpy() for cls, g in nac.groupby("asset_class")}
    rate = planning.get("discount_rate")
    if rate is None:
        notes.append("no discount_rate: dollar benefits are not discounted")
    priced = act["cost_per_eol_usd"].notna().to_numpy()
    # a proactive replacement costs the planned job (capital + mobilization + its planned outage, one unit on its own);
    # the plan moves the visit-fixed part onto shared visits when it bundles (plan.Bundling)
    b = value.benefits(P[priced], act.loc[priced, "asset_class"].to_numpy(), new, act.loc[priced, "cost_per_eol_usd"].to_numpy(),
                       act.loc[priced, "planned_job_usd"].to_numpy(), rate or 0.0, plan_years)
    for status, n in act.loc[~priced, "value_status"].value_counts().items():
        notes.append(f"{n:,} active assets left out of dollar plans: {status}")
    act["priced"] = priced
    act["best_plan_year"] = np.nan
    act["best_benefit_usd"] = np.nan
    if priced.any():
        bu = np.where(np.isfinite(b["usd"]), b["usd"], -np.inf)
        act.loc[priced, "best_plan_year"] = bu.argmax(axis=1) + 1
        act.loc[priced, "best_benefit_usd"] = bu.max(axis=1)
        act.loc[priced, "benefit_replace_year1_usd"] = b["usd"][:, 0]
    b["index"] = np.nonzero(priced)[0]
    return Portfolio(act, P, new, b, plan_years, horizon, rate, notes)
