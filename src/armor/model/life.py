"""Life curves: a Weibull per asset class and per cohort, fitted from the asset register.

WHAT COUNTS AS AN END OF LIFE
An asset's life ENDS when it is removed as `failure`, `condition` or `end_of_life` (it wore out, whether it
failed in service or was caught first). Removals for `program`, `damage` or `other` cut a life short without
ending it: those units, and every unit still in service, are right-censored at their removal / the as-of date.

LEFT TRUNCATION (why record_window is required)
A unit is only visible to us if it was still in service when removal records began. A pole installed in 1950
that wore out in 1975 is missing when records start in 1990, and its 1950 siblings that ARE present are the
survivors. Ignoring that makes old cohorts look stronger than they were. The likelihood below conditions each
unit on having survived to its entry age (the age at which records began for it), which removes that bias.

THE LIKELIHOOD (Weibull, scale lam, shape k; cumulative hazard H(t) = (t/lam)^k)
    log L = sum_events log h(t_i)  -  sum_all [ H(t_i) - H(entry_i) ]
with h(t) = (k/lam) (t/lam)^(k-1). Fitted in log-parameter space with scipy.

COHORTS AND SHRINKAGE
The class curve is fitted on every unit of the class. A cohort (e.g. pine|creosote) gets its own fit only if it
has at least `min_events` end-of-life events; its parameters are then pulled toward the class curve in
log-parameter space with data weight  w = events / (events + shrinkage_events). Cohorts below the threshold use
the class curve unchanged. Every curve records its source (class / cohort) and weight, so a thin cohort is never
presented as if its own data spoke for it.
"""
from __future__ import annotations

import dataclasses

import numpy as np
import pandas as pd
from scipy.optimize import minimize

END_OF_LIFE = ("failure", "condition", "end_of_life")
YEAR = 365.25


@dataclasses.dataclass
class Curve:
    asset_class: str
    cohort: str            # "class" for the class curve, else "val1|val2|..."
    scale: float           # lam, years
    shape: float           # k
    n_units: int
    n_events: int
    data_weight: float     # 1.0 for the class curve; w for a cohort; 0.0 if it borrows the class curve
    source: str            # class | cohort | class_curve (cohort too thin, uses class)
    oldest_unit_age: float = float("nan")   # oldest age any unit of the cohort was observed at (in service or removed)
    oldest_event_age: float = float("nan")  # oldest age at which a documented end of life was observed

    @property
    def median(self) -> float:
        return self.scale * np.log(2) ** (1 / self.shape)

    def cum_hazard(self, age):
        return (np.maximum(np.asarray(age, dtype=float), 0.0) / self.scale) ** self.shape

    def p_year(self, age_start):
        """P(end of life within the year starting at `age_start` | alive at age_start)."""
        a = np.asarray(age_start, dtype=float)
        return 1.0 - np.exp(-(self.cum_hazard(a + 1.0) - self.cum_hazard(a)))


def cohort_label(df: pd.DataFrame, keys: list[str]) -> pd.Series:
    """The unit's cohort: the utility's own `cohort` label when given, else the configured columns joined by '|'."""
    built = pd.Series("all", index=df.index) if not keys else df[keys].astype("string").fillna("unknown").agg("|".join, axis=1)
    if "cohort" in df.columns:
        own = df["cohort"].astype("string")
        return own.where(own.notna() & (own.str.len() > 0), built)
    return built


def exposure(asset: pd.DataFrame, record_window: pd.DataFrame, as_of: pd.Timestamp) -> pd.DataFrame:
    """One row per unit observable in the record window as of `as_of`: entry age, exit age, event flag.

    Units installed after as_of are dropped; removals after as_of are treated as not yet happened (this is
    what makes a backtest honest: fitting "as of 2015" sees only what was known in 2015).
    """
    a = asset.merge(record_window[["asset_class", "records_start_date"]], on="asset_class", how="left")
    inst = pd.to_datetime(a["install_date"])
    rem = pd.to_datetime(a["removal_date"])
    start = pd.to_datetime(a["records_start_date"])
    keep = (inst <= as_of) & (rem.isna() | (rem >= start))  # removed before records began = not observable
    a, inst, rem, start = a[keep].copy(), inst[keep], rem[keep], start[keep]
    removed = rem.notna() & (rem <= as_of)
    end = rem.where(removed, as_of)
    a["entry_age"] = ((start - inst).dt.days / YEAR).clip(lower=0.0)
    a["exit_age"] = ((end - inst).dt.days / YEAR).clip(lower=1.0 / YEAR)
    a["event"] = removed & a["removal_reason"].isin(END_OF_LIFE)
    a["entry_age"] = np.minimum(a["entry_age"], a["exit_age"] - 1e-6)
    return a


def fit_weibull(t: np.ndarray, e: np.ndarray, entry: np.ndarray) -> tuple[float, float]:
    t, e, entry = np.asarray(t, float), np.asarray(e, bool), np.asarray(entry, float)
    lt = np.log(t)

    def nll(p):
        loglam, logk = p
        k = np.exp(logk)
        z = np.exp(k * (lt - loglam))
        z0 = np.where(entry > 0, np.exp(k * (np.log(np.maximum(entry, 1e-9)) - loglam)), 0.0)
        ll = np.sum(logk - loglam + (k - 1) * (lt[e] - loglam)) - np.sum(z - z0)
        return -ll

    # start: scale near the event-time median (or the longest exposure), shape 3 (wear-out)
    lam0 = np.median(t[e]) * 1.5 if e.any() else t.max() * 2
    res = minimize(nll, x0=[np.log(lam0), np.log(3.0)], method="L-BFGS-B",
                   bounds=[(np.log(1.0), np.log(1000.0)), (np.log(0.3), np.log(15.0))])
    return float(np.exp(res.x[0])), float(np.exp(res.x[1]))


def fit_library(exp_df: pd.DataFrame, cohort_keys: dict, min_events: int, shrinkage_events: float) -> list[Curve]:
    """Class curve + cohort curves for every asset_class in `exp_df` (the output of `exposure`)."""
    curves: list[Curve] = []
    for cls, g in exp_df.groupby("asset_class"):
        if not g["event"].any():
            continue  # no end of life ever observed: nothing to fit, and we don't invent a curve
        lam, k = fit_weibull(g["exit_age"], g["event"], g["entry_age"])
        span = lambda d: (float(d["exit_age"].max()), float(d.loc[d["event"], "exit_age"].max()) if d["event"].any() else float("nan"))  # noqa: E731
        base = Curve(cls, "class", lam, k, len(g), int(g["event"].sum()), 1.0, "class", *span(g))
        curves.append(base)
        keys = cohort_keys.get(cls, cohort_keys.get("default", []))
        lab = cohort_label(g, keys)
        for coh, gc in g.groupby(lab):
            d = int(gc["event"].sum())
            if d < min_events:
                curves.append(Curve(cls, coh, lam, k, len(gc), d, 0.0, "class_curve", *span(gc)))
                continue
            lc, kc = fit_weibull(gc["exit_age"], gc["event"], gc["entry_age"])
            w = d / (d + shrinkage_events)
            curves.append(Curve(cls, coh, float(np.exp(w * np.log(lc) + (1 - w) * np.log(lam))),
                                float(np.exp(w * np.log(kc) + (1 - w) * np.log(k))), len(gc), d, w, "cohort", *span(gc)))
    return curves


def quantile_age(c: "Curve", q: float) -> float:
    """Age by which a share q of new units has reached end of life (wear-out only)."""
    return c.scale * (-np.log(1 - q)) ** (1 / c.shape)


def curves_frame(curves: list[Curve]) -> pd.DataFrame:
    return pd.DataFrame([{**dataclasses.asdict(c), "median_life_years": c.median, "p10_life_years": quantile_age(c, 0.1),
                          "p90_life_years": quantile_age(c, 0.9)} for c in curves])
