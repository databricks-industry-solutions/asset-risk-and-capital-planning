"""Multi-year capital plan: which assets to replace, in which year, under annual budgets.

    maximize   sum_{i,t} benefit_usd[i,t] * x[i,t]  -  sum_{g,t} visit_value_usd[g] * d_t * v[g,t]
    subject to sum_t x[i,t] <= 1                       each asset replaced at most once in the plan
               sum_i capex_i x[i,t] + sum_g visit_capex_g v[g,t] <= budget_t    annual capital budget (nominal USD)
               sum_{i in class c} ... <= class_budget_{c,t}                    optional: per-class envelopes
               sum_i x[i,t] <= crew_t                       optional: replacements a year (crew capacity)
               sum_{t <= deadline_i} x[i,t] = 1             must-address assets (open rejects), by their deadline
               sum_{i in g} x[i,t] <= cap_g * v[g,t]        bundling only: work in group g in year t needs visits
                                                            (v integer; cap_g = units per visit, or all of them)

BUNDLING. A visit to a group (a protective-device section, or a feeder) has a fixed part that its units share:
mobilization (capital, in the budget) and, for a section, the setup part of the planned outage (customers behind the
device x setup minutes x value of a customer-minute). Without bundling each unit is its own visit, and that fixed
part is already inside its benefit (portfolio.py prices a proactive replacement as a one-unit planned job). With
bundling the caller adds it back to the benefit (`Bundling.benefit_addback`) and charges it once per visit instead,
so the optimizer groups work wherever the shared cost pays for it. Visit costs are deterministic (the crew goes),
discounted to the start of the plan year.

Solved exactly with HiGHS (scipy.optimize.milp). Only (asset, year) pairs with positive benefit are candidates,
plus every year up to the deadline for must-address assets; that keeps the problem small without changing the
optimum (a non-positive pair would never be chosen by a maximizer unless forced).

The caller may solve over more years than it commits to (the app optimizes 10 years ahead and keeps the first N), so a
short plan only takes the work whose best year is within it.

Must-address work is funded first from the same budget. If the budget can't cover it the plan is infeasible and
says so; the engine never quietly drops an obligation.
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import csr_matrix


@dataclasses.dataclass
class PlanRequest:
    budgets: list[float]                    # USD per plan year, len = T
    crew: list[int] | None = None           # max replacements per plan year
    must_address_deadline: dict | None = None   # asset_id -> last plan year (1-based) it must be done by
    min_spend_fraction: float = 0.0          # full budget: after the optimal plan, fill each year to this share of its budget with the
                                             # next-best replacements, even at negative net value; 0 = spend only where it pays
    time_limit_s: float = 300.0
    mip_rel_gap: float = 1e-4
    class_budgets: dict | None = None        # asset_class -> USD per plan year (len T): envelope within the total
    classes: np.ndarray | None = None        # (N,) asset_class per asset, needed for class_budgets


@dataclasses.dataclass
class Bundling:
    """Shared visits. group: (N,) group key per asset (None = not bundled); per group key: value, capex, capacity."""
    group: np.ndarray
    visit_value_usd: dict          # g -> USD charged to the objective per visit (mobilization + setup-outage value)
    visit_capex_usd: dict          # g -> USD per visit counted in the budget (mobilization)
    capacity: dict                 # g -> units per visit (np.inf = no limit)
    discount: np.ndarray           # (T,) discount factor at the start of each plan year


def empty_plan() -> pd.DataFrame:
    """A plan with no lines, with the column types of a real one (so callers can index with plan_year)."""
    out = pd.DataFrame({"asset_id": pd.Series(dtype=object), "plan_year": pd.Series(dtype=int), "planned_usd": pd.Series(dtype=float),
                        "benefit_usd": pd.Series(dtype=float), "must_address": pd.Series(dtype=bool), "level_fill": pd.Series(dtype=bool)})
    out.attrs.update(status="no candidates", mip_gap=None, objective=0.0, n_candidates=0, level_fill=0, n_visit_variables=0,
                     visits=pd.DataFrame(columns=["group", "plan_year", "visits"]))
    return out


class PlanInfeasible(RuntimeError):
    pass


def solve(asset_ids: np.ndarray, benefit_usd: np.ndarray, planned_usd: np.ndarray, req: PlanRequest,
          bundling: Bundling | None = None) -> pd.DataFrame:
    """Returns the chosen actions: asset_id, plan_year, planned_usd, benefit_usd, must_address, level_fill (and group).

    planned_usd is the capital counted in the budget per unit. With bundling, out.attrs["visits"] lists the visits
    (group, plan_year, visits, units)."""
    N, T = benefit_usd.shape
    assert len(req.budgets) == T
    must = req.must_address_deadline or {}
    idx = {a: i for i, a in enumerate(asset_ids)}
    must_i = {idx[a]: min(int(d), T) for a, d in must.items() if a in idx}

    ok = np.isfinite(benefit_usd) & np.isfinite(planned_usd)[:, None]
    cand = ok & (benefit_usd > 0)

    no_cost = [a for a, i in idx.items() if i in must_i and not np.isfinite(planned_usd[i])]
    if no_cost:   # never quietly drop an obligation
        raise PlanInfeasible(f"{len(no_cost)} must-address assets have no planned replacement cost (e.g. {no_cost[0]}); "
                             "add their action_cost rows or turn off 'Clear the reject backlog first'.")
    for i, d in must_i.items():
        cand[i, :d] = True  # forced: every year up to the deadline is a candidate
        cand[i, d:] = False
    benefit_usd = np.where(cand & ~np.isfinite(benefit_usd), 0.0, benefit_usd)   # a forced candidate with no benefit
    ii, tt = np.nonzero(cand)
    if not len(ii):
        return empty_plan()
    nv = len(ii)

    # visit variables: one per (group, year) that holds a candidate
    vg, vt, vcap, vub = [], [], [], []
    if bundling is not None:
        g_of = np.asarray(bundling.group, dtype=object)[ii]
        has = np.array([g is not None for g in g_of])
        keys = pd.Series(list(zip(g_of[has], tt[has]))).value_counts()
        vkey = {k: j for j, k in enumerate(keys.index)}
        for (g, t), n in keys.items():
            cap = float(bundling.capacity.get(g, np.inf))
            vg.append(g); vt.append(t); vcap.append(cap if np.isfinite(cap) else float(n))
            vub.append(float(np.ceil(n / cap)) if np.isfinite(cap) else 1.0)
        xv = np.array([vkey[(g, t)] if h else -1 for g, t, h in zip(g_of, tt, has)])
    nw = len(vg)
    vt_a = np.asarray(vt, int)
    c = np.concatenate([-np.nan_to_num(benefit_usd[ii, tt]),
                        np.array([bundling.visit_value_usd.get(g, 0.0) * bundling.discount[t] for g, t in zip(vg, vt)]) if nw else np.zeros(0)])
    vcapex = np.array([bundling.visit_capex_usd.get(g, 0.0) for g in vg]) if nw else np.zeros(0)
    ncol = nv + nw

    rows = []
    # one action per asset
    assets, inv = np.unique(ii, return_inverse=True)
    A1 = csr_matrix((np.ones(nv), (inv, np.arange(nv))), shape=(len(assets), ncol))
    lo1 = np.zeros(len(assets)); hi1 = np.ones(len(assets))
    forced = np.isin(assets, list(must_i))
    lo1[forced] = 1.0
    rows.append(LinearConstraint(A1, lo1, hi1))
    # budgets: unit capital + visit capital (mobilization)
    def budget_rows(xmask, wmask, caps):
        data = np.concatenate([planned_usd[ii[xmask]], vcapex[wmask]])
        r = np.concatenate([tt[xmask], vt_a[wmask]]) if nw else tt[xmask]
        cols = np.concatenate([np.nonzero(xmask)[0], nv + np.nonzero(wmask)[0]]) if nw else np.nonzero(xmask)[0]
        return LinearConstraint(csr_matrix((data, (r, cols)), shape=(T, ncol)), -np.inf, np.asarray(caps, float))
    allw = np.ones(nw, bool)
    rows.append(budget_rows(np.ones(nv, bool), allw, req.budgets))
    if req.class_budgets:
        cls = np.asarray(req.classes)
        vcls = np.array([cls[ii[xv == j][0]] for j in range(nw)]) if nw else np.zeros(0, object)
        for k, caps in req.class_budgets.items():
            rows.append(budget_rows(cls[ii] == k, vcls == k if nw else allw, caps))
    if req.crew:
        A3 = csr_matrix((np.ones(nv), (tt, np.arange(nv))), shape=(T, ncol))
        rows.append(LinearConstraint(A3, -np.inf, np.asarray(req.crew, float)))
    if nw:
        # sum_{i in g} x[i,t] - cap_g v[g,t] <= 0
        xs = np.nonzero(xv >= 0)[0]
        A4 = csr_matrix((np.concatenate([np.ones(len(xs)), -np.asarray(vcap)]),
                         (np.concatenate([xv[xs], np.arange(nw)]), np.concatenate([xs, nv + np.arange(nw)]))), shape=(nw, ncol))
        rows.append(LinearConstraint(A4, -np.inf, 0.0))

    ub = np.concatenate([np.ones(nv), np.asarray(vub, float)])
    res = milp(c, constraints=rows, integrality=np.ones(ncol), bounds=Bounds(0, ub),
               options={"time_limit": req.time_limit_s, "mip_rel_gap": req.mip_rel_gap, "disp": False})
    if res.x is None and res.status == 1:
        raise PlanInfeasible(f"no plan found within the {req.time_limit_s:.0f} s time limit ({res.message}); try fewer candidates or no bundling.")
    if res.status == 2 or res.x is None:
        need = sum(planned_usd[i] for i in must_i)
        raise PlanInfeasible(f"no plan satisfies the constraints ({res.message}). Must-address work alone costs "
                             f"${need:,.0f} against a year-1 budget of ${req.budgets[0]:,.0f}.")
    x = res.x[:nv] > 0.5
    w = np.round(res.x[nv:]).astype(int) if nw else np.zeros(0, int)
    out = pd.DataFrame({"asset_id": np.asarray(asset_ids)[ii[x]], "plan_year": tt[x] + 1,
                        "planned_usd": planned_usd[ii[x]], "benefit_usd": benefit_usd[ii[x], tt[x]],
                        "must_address": np.isin(ii[x], list(must_i)), "level_fill": False})
    if bundling is not None:
        out["group"] = np.asarray(bundling.group, dtype=object)[ii[x]]
    visits = {(vg[j], vt[j]): int(w[j]) for j in range(nw) if w[j] > 0}
    filled = 0
    if req.min_spend_fraction > 0:
        # FULL BUDGET: the optimal plan leaves budget unspent where more replacement costs more than it saves. This fill
        # spends it anyway: each year, add the remaining assets with the highest net value for that year (least negative
        # first) until spend reaches the floor, within the total budget, the class envelopes and the crews. Transparent
        # and fast; the lines are flagged level_fill. With bundling, a unit that needs a new visit also pays its capital.
        used = set(ii[x])
        spend = np.bincount(tt[x], weights=planned_usd[ii[x]], minlength=T).astype(float)
        for (g, t), n in visits.items():
            spend[t] += n * bundling.visit_capex_usd.get(g, 0.0)
        units = pd.Series(list(zip(out.get("group", pd.Series([None] * len(out))), out["plan_year"] - 1))).value_counts().to_dict() if bundling is not None else {}
        count = np.bincount(tt[x], minlength=T)
        cls = np.asarray(req.classes) if req.classes is not None else None
        env = req.class_budgets or {}
        cspend = {}
        if env and cls is not None:
            for i, t in zip(ii[x], tt[x]):
                cspend[(cls[i], t)] = cspend.get((cls[i], t), 0.0) + planned_usd[i]
            for (g, t), n in visits.items():
                c = str(g).split("|", 1)[0]
                cspend[(c, t)] = cspend.get((c, t), 0.0) + n * bundling.visit_capex_usd.get(g, 0.0)
        extra = []
        for t in range(T):
            floor = req.min_spend_fraction * req.budgets[t]
            if spend[t] >= floor:
                continue
            col = np.where(np.isfinite(benefit_usd[:, t]) & np.isfinite(planned_usd), benefit_usd[:, t], -np.inf)
            for i in np.argsort(-col):
                if spend[t] >= floor or not np.isfinite(col[i]):
                    break
                g = bundling.group[i] if bundling is not None else None
                add = planned_usd[i]
                if g is not None:
                    cap = bundling.capacity.get(g, np.inf)
                    n = units.get((g, t), 0)
                    if n == 0 or (np.isfinite(cap) and n % cap == 0):
                        add += bundling.visit_capex_usd.get(g, 0.0)
                c = cls[i] if cls is not None else None
                if i in used or spend[t] + add > req.budgets[t] or (req.crew and count[t] >= req.crew[t]) \
                        or (c in env and cspend.get((c, t), 0.0) + add > env[c][t]):
                    continue
                used.add(i); spend[t] += add; count[t] += 1
                if c is not None:
                    cspend[(c, t)] = cspend.get((c, t), 0.0) + add
                if g is not None:
                    n = units.get((g, t), 0)
                    cap = bundling.capacity.get(g, np.inf)
                    if n == 0 or (np.isfinite(cap) and n % cap == 0):
                        visits[(g, t)] = visits.get((g, t), 0) + 1
                    units[(g, t)] = n + 1
                extra.append((i, t))
        if extra:
            ei, et = np.array([e[0] for e in extra]), np.array([e[1] for e in extra])
            add = pd.DataFrame({"asset_id": np.asarray(asset_ids)[ei], "plan_year": et + 1, "planned_usd": planned_usd[ei],
                                "benefit_usd": benefit_usd[ei, et], "must_address": False, "level_fill": True})
            if bundling is not None:
                add["group"] = np.asarray(bundling.group, dtype=object)[ei]
            out = pd.concat([out, add], ignore_index=True)
            filled = len(extra)
    out.attrs.update(status=res.message, mip_gap=getattr(res, "mip_gap", None), objective=float(-res.fun), n_candidates=nv, level_fill=filled,
                     n_visit_variables=nw,
                     visits=pd.DataFrame([{"group": g, "plan_year": t + 1, "visits": n} for (g, t), n in visits.items()],
                                         columns=["group", "plan_year", "visits"]))
    return out.sort_values(["plan_year", "benefit_usd"], ascending=[True, False]).reset_index(drop=True)


BUNDLE_UNITS = {"section": "upstream_device_id", "feeder": "feeder_id"}


def bundle(a: pd.DataFrame, survival: np.ndarray, rate: float, T: int, unit: str, customer_minute_value: float | None):
    """Bundling for the priced assets `a` (rows aligned with the benefit matrix) -> (Bundling, benefit add-back (N, T)).

    unit = "section": a visit is one protective-device section (upstream_device_id) of one class; its units share
           mobilization and the setup part of the planned outage (the section's customers x setup minutes).
    unit = "feeder":  a visit is one feeder of one class; its units share mobilization only (different sections are
           different outages, so each unit keeps its own setup outage).
    Classes with no mobilization and no setup minutes have nothing to share and are not bundled."""
    key = BUNDLE_UNITS[unit]
    v = customer_minute_value or 0.0
    mob = a["mobilization_usd"].fillna(0.0).to_numpy(float)
    setup = a["planned_outage_setup_minutes"].fillna(0.0).to_numpy(float)
    cust = a["customers"].astype(float).fillna(0.0).to_numpy()
    shares = (mob > 0) | ((setup > 0) & (unit == "section") & (v > 0))
    cls = a["asset_class"].to_numpy()
    group = np.array([f"{c}|{u}" if s_ else None for c, u, s_ in zip(cls, a[key].to_numpy(), shares)], dtype=object)
    fixed_i = mob + (setup * cust * v if unit == "section" else 0.0)       # the part each unit carries on its own today
    df = pd.DataFrame({"g": group, "mob": mob, "setup": setup, "cust": cust,
                       "cap": a["assets_per_visit"].to_numpy(float)})[shares]
    g = df.groupby("g").agg(mob=("mob", "first"), setup=("setup", "first"), cust=("cust", "max"), cap=("cap", "first"))
    value_ = (g["mob"] + (g["setup"] * g["cust"] * v if unit == "section" else 0.0)).to_dict()
    disc = (1 + (rate or 0.0)) ** -np.arange(T, dtype=float)
    addback = np.where(shares[:, None], survival[:, :T] * disc[None, :] * fixed_i[:, None], 0.0)
    return Bundling(group=group, visit_value_usd=value_, visit_capex_usd=g["mob"].to_dict(),
                    capacity=g["cap"].fillna(np.inf).to_dict(), discount=disc), addback


def visit_value(p: pd.DataFrame, bundling: Bundling | None, discretionary_only: bool = True) -> float:
    """Discounted value charged for the plan's visits. With discretionary_only, each visit's value is split over its
    units and only the discretionary units' share is counted (the reject backlog is an obligation, reported apart)."""
    v = p.attrs.get("visits")
    if bundling is None or v is None or not len(v):
        return 0.0
    share = {}
    if discretionary_only and "group" in p:
        q = p[p["group"].notna()].groupby(["group", "plan_year"])["must_address"].agg(["size", "sum"])
        share = ((q["size"] - q["sum"]) / q["size"]).to_dict()
    return float(sum(r.visits * bundling.visit_value_usd.get(r.group, 0.0) * bundling.discount[r.plan_year - 1] * share.get((r.group, r.plan_year), 1.0)
                     for r in v.itertuples()))
