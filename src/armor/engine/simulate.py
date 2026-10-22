"""Uncertainty of fixed plans: the fleet simulated forward under each plan, with the same random draws for every plan.

    res = run(pf, SimRequest(years=10, replicates=30, schedules={"value": df, "reactive": empty_df}))

Every plan sees the SAME future: the uniform draws that decide whether an asset reaches end of life in a year, and
whether that end of life is an in-service failure, are fixed per (asset position, year, replicate). Differences between
plans are therefore caused by the plans, not by luck (common random numbers).

Each simulated year, for every asset position in the population:
  1. the plan's scheduled replacements for that year happen if the unit is still the original; a replaced position
     becomes a new unit (age 0) that follows the new-asset curve. With must_address, the reject backlog is also
     replaced by its deadline if the plan hasn't already (plans built with the backlog setting on already hold it);
  2. every position draws end of life: an original unit uses its pof_forecast for that year, a replaced unit its
     new-asset curve at its age;
  3. an end of life is an in-service failure with probability p_failure (emergency cost, customers out for the
     restoration time) or is caught and replaced planned (planned cost + mobilization, its planned outage);
     either way the position gets a new unit.

Outputs per plan x year: mean and 5th/95th percentile across replicates of end-of-life events, in-service failures,
customers interrupted, customer-minutes (unplanned, and planned for the replacement work), planned / emergency /
program spend, and fleet age. The analytic expectation (value.trajectory) is the mean of this simulation.
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd


@dataclasses.dataclass
class SimRequest:
    years: int = 10
    replicates: int = 30
    schedules: dict = dataclasses.field(default_factory=dict)   # plan name -> fixed schedule (asset_id, plan_year)
    population: np.ndarray | None = None   # asset_ids to simulate (the plans' scope); None = every priced asset
    must_address: bool = True              # replace the reject backlog by its deadline when a plan hasn't
    seed: int = 7


def run(pf, req: SimRequest) -> pd.DataFrame:
    a = pf.assets[pf.assets["priced"]].reset_index(drop=True)
    P = pf.P[np.nonzero(pf.assets["priced"].to_numpy())[0]]
    if req.population is not None:
        keep = a["asset_id"].isin(set(req.population)).to_numpy()
        a, P = a[keep].reset_index(drop=True), P[keep]
    N, Y, R = len(a), req.years, req.replicates
    cls = a["asset_class"].to_numpy()
    newc = {c: np.asarray(v) for c, v in pf.new.items()}
    pfail = np.nan_to_num(a["p_failure"].to_numpy(float))
    # a planned job is priced on its own here (capital + mobilization); its planned outage is counted separately
    planned = a["planned_usd"].to_numpy(float) + a["mobilization_usd"].fillna(0.0).to_numpy(float)
    emerg = a["emergency_usd"].to_numpy(float)
    pmin = a["planned_customer_minutes"].fillna(0.0).to_numpy(float)
    cust = a["customers"].astype(float).fillna(0.0).to_numpy()
    cmin = np.nan_to_num(a["customer_minutes_per_failure"].to_numpy(float))
    age0 = a["calendar_age_years"].to_numpy(float)
    must = a["must_address_by_year"].to_numpy(float) if req.must_address else np.full(N, np.nan)
    index = pd.Index(a["asset_id"])

    rows = []
    for name, df in req.schedules.items():
        sched: dict = {}
        if df is not None and len(df):
            pos = index.get_indexer(df["asset_id"])
            for p, y in zip(pos, df["plan_year"]):
                if p >= 0:
                    sched.setdefault(int(y), []).append(p)
        rng = np.random.default_rng(req.seed)           # same stream for every plan -> common random numbers
        orig = np.ones((N, R), bool)                    # still the original unit
        age_new = np.zeros((N, R))                      # age of the replacement unit
        stats = {k: np.zeros((Y, R)) for k in ("eol", "failures", "customers", "customer_minutes", "planned_customer_minutes",
                                               "spend_program", "spend_planned_eol", "spend_emergency", "mean_age")}
        for y in range(Y):
            u_eol, u_fail = rng.random((N, R)), rng.random((N, R))
            replace = np.zeros((N, R), bool)
            for p in sched.get(y + 1, []):
                replace[p] |= orig[p]
            due = (must <= y + 1) & np.isfinite(must)
            if due.any():
                replace |= due[:, None] & orig
            spend_prog = (replace * planned[:, None]).sum(axis=0)
            orig &= ~replace
            age_new = np.where(replace, 0.0, age_new)
            # end-of-life draws
            p = np.where(orig, P[:, min(y, P.shape[1] - 1)][:, None], 0.0)
            for c, curve in newc.items():
                sel = (cls == c)[:, None] & ~orig
                if sel.any():
                    p = np.where(sel, curve[np.minimum(age_new.astype(int), len(curve) - 1)], p)
            eol = u_eol < p
            fail = eol & (u_fail < pfail[:, None])
            caught = eol & ~fail
            stats["eol"][y] = eol.sum(axis=0)
            stats["failures"][y] = fail.sum(axis=0)
            stats["customers"][y] = (fail * cust[:, None]).sum(axis=0)
            stats["customer_minutes"][y] = (fail * cmin[:, None]).sum(axis=0)
            stats["planned_customer_minutes"][y] = ((replace | caught) * pmin[:, None]).sum(axis=0)
            stats["spend_program"][y] = spend_prog
            stats["spend_planned_eol"][y] = (caught * planned[:, None]).sum(axis=0)
            stats["spend_emergency"][y] = (fail * emerg[:, None]).sum(axis=0)
            stats["mean_age"][y] = np.where(orig, age0[:, None] + y + 1, age_new + 1).mean(axis=0) if N else 0.0
            # every end of life is replaced by a new unit
            orig &= ~eol
            age_new = np.where(eol, 0.0, age_new + 1)
        for k, v in stats.items():
            for y in range(Y):
                rows.append({"program": name, "year": y + 1, "metric": k, "mean": float(v[y].mean()),
                             "p05": float(np.percentile(v[y], 5)), "p95": float(np.percentile(v[y], 95))})
    return pd.DataFrame(rows)
