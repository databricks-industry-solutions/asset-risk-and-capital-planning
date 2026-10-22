"""Backtest: fit as of an origin date, forecast the next years, compare with what actually happened.

This is a REPORT, not a gate. It tells a reviewer how well a probability model ranks and sizes end-of-life
events on years it didn't see, and it lets model variants be compared on the same units and years (pass
`variants`). It never blocks a run.

For each origin: the model is fitted on data known before the origin (life.exposure cuts at the origin). Every unit active at the origin is followed for `horizon` years: in year h it is at risk if
not removed before the year started, and it has an event if it was removed for end of life during the year.
Metrics per model x origin x class:
  unit_years, predicted events (sum of p), observed events, predicted/observed ratio,
  Brier score (mean squared error of p vs 0/1), and top-decile capture (share of observed events that the
  model ranked in its riskiest 10% of units that year).
Plus a calibration table by predicted-probability decile.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import reference
from .life import END_OF_LIFE


def _outcomes(asset: pd.DataFrame, ids: np.ndarray, origin: pd.Timestamp, horizon: int) -> pd.DataFrame:
    a = asset.set_index("asset_id").loc[ids]
    rem = pd.to_datetime(a["removal_date"])
    rows = []
    for h in range(1, horizon + 1):
        y0, y1 = origin + pd.DateOffset(years=h - 1), origin + pd.DateOffset(years=h)
        at_risk = rem.isna() | (rem >= y0)
        ev = at_risk & (rem < y1) & a["removal_reason"].isin(END_OF_LIFE)
        rows.append(pd.DataFrame({"asset_id": ids, "year_offset": h, "at_risk": at_risk.to_numpy(), "event": ev.to_numpy()}))
    return pd.concat(rows, ignore_index=True)


def full_years(origin: pd.Timestamp, as_of: pd.Timestamp) -> int:
    """Whole years observed from origin up to as_of."""
    n = as_of.year - origin.year
    return n - 1 if origin + pd.DateOffset(years=n) > as_of else n


def origins_for(as_of, record_window: pd.DataFrame, years_before: list, horizon: int):
    """Backtest origins placed relative to the data, never on fixed calendar years: January 1 of each year that is
    `years_before` years before the as-of date's year. An origin is kept only when the data can score it:
    removals are recorded before it (records_start_date of at least one class is earlier), and at least one full
    year is observed after it (each kept origin is followed for min(horizon, full years to as_of)).
    Returns (kept origins, [(skipped origin, reason), ...])."""
    as_of = pd.Timestamp(as_of)
    first_records = pd.to_datetime(record_window["records_start_date"]).min() if len(record_window) else pd.NaT
    kept, skipped = [], []
    for n in sorted(set(int(x) for x in years_before), reverse=True):
        o = pd.Timestamp(year=as_of.year - n, month=1, day=1)
        if pd.isna(first_records) or o <= first_records:
            skipped.append((o, f"no removal records before it (records start {first_records.date() if not pd.isna(first_records) else 'unknown'})"))
        elif full_years(o, as_of) < 1:
            skipped.append((o, "no full year observed after it"))
        else:
            kept.append(o)
    return kept, skipped


def run(tables: dict, origins: list, horizon: int, settings: dict | None = None,
        variants: dict | None = None, as_of=None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """`as_of` (the data's as-of date) caps each origin's horizon at the full years observed after it."""
    variants = variants or {"age_based": {}}
    metrics, calib = [], []
    for origin in origins:
        origin = pd.Timestamp(f"{origin}-01-01") if isinstance(origin, int) else pd.Timestamp(origin)
        h = horizon if as_of is None else min(horizon, full_years(origin, pd.Timestamp(as_of)))
        if h < 1:
            continue
        for name, kw in variants.items():
            o = reference.build(tables, origin, settings, horizon=h, **kw)
            f = o["pof_forecast"].merge(o["asset_explanation"][["asset_id", "asset_class"]], on="asset_id")
            out = _outcomes(tables["asset"], o["asset_explanation"]["asset_id"].to_numpy(), origin, h)
            d = f.merge(out, on=["asset_id", "year_offset"])
            d = d[d["at_risk"]]
            for cls, g in d.groupby("asset_class"):
                top = g.groupby("year_offset")["p_end_of_life"].transform(lambda s: s >= s.quantile(0.9))
                obs = int(g["event"].sum())
                metrics.append({"model": name, "origin": origin.year, "asset_class": cls, "unit_years": len(g),
                                "predicted": float(g["p_end_of_life"].sum()), "observed": obs,
                                "pred_over_obs": float(g["p_end_of_life"].sum() / obs) if obs else np.nan,
                                "brier": float(np.mean((g["p_end_of_life"] - g["event"]) ** 2)),
                                "top_decile_capture": float(g.loc[top, "event"].sum() / obs) if obs else np.nan})
                q = pd.qcut(g["p_end_of_life"].rank(method="first"), 10, labels=False)
                c = g.groupby(q).agg(mean_p=("p_end_of_life", "mean"), observed_rate=("event", "mean"), n=("event", "size")).reset_index(names="decile")
                calib.append(c.assign(model=name, origin=origin.year, asset_class=cls))
    return pd.DataFrame(metrics), pd.concat(calib, ignore_index=True)
