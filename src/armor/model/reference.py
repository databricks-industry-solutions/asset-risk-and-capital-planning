"""The shipped reference probability model: age-based life curves from documented removals -> pof_forecast.

    outputs = build(tables, as_of, settings)

`tables` holds contract tables as pandas DataFrames (`asset`, `record_window`).
Returns the three contract model outputs (pof_forecast, new_asset_curve, model_run), the optional
asset_explanation, and the reviewer tables the app shows (life_curve, failure_share).

Two steps, each explainable in a sentence:
  1. life.py  a Weibull per class and per cohort, fitted on every unit ever in service (removed ones included):
              documented end-of-life removals (failure / condition / end_of_life) are events, every other removal and
              every unit still in service is censored, and records that began after the first installs are corrected
              for (left truncation).
  2. here     P(end of life in year h) = 1 - S(a+h)/S(a+h-1) at the asset's age a; and the share of end-of-life
              events that are in-service failures, measured from recent removals.

Deliberately NOT here (future steps): moving an individual asset along its curve with its own
inspection results (condition-implied age, inspection-outcome evidence). This version is age and cohort
only, so every probability traces to documented removals and nothing else.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from . import life

SETTINGS_PATH = Path(__file__).resolve().parents[3] / "config" / "reference_model.yml"


def load_settings(path: Path = SETTINGS_PATH) -> dict:
    return yaml.safe_load(path.read_text())


def failure_share(asset: pd.DataFrame, as_of: pd.Timestamp, years: int, class_parameter: pd.DataFrame | None = None) -> dict:
    """Per class: in-service failures / (failures + condition removals) over the last `years` years.

    When the records only say `end_of_life`, the utility's class_parameter failure_share is used (with its source);
    otherwise None (the data can't split failure from caught, and nothing is assumed)."""
    rem = pd.to_datetime(asset["removal_date"])
    recent = asset[(rem < as_of) & (rem >= as_of - pd.DateOffset(years=years))]
    given = {}
    if class_parameter is not None and len(class_parameter):
        cp = class_parameter[class_parameter["parameter"] == "failure_share"]
        given = {r.asset_class: (float(r.value), r.source) for r in cp.itertuples()}
    out = {}
    for cls, g in recent.groupby("asset_class"):
        f, c = int((g["removal_reason"] == "failure").sum()), int((g["removal_reason"] == "condition").sum())
        if f + c:
            out[cls] = {"share": f / (f + c), "failures": f, "condition_removals": c, "source": f"removal records, last {years} years"}
        elif cls in given:
            out[cls] = {"share": given[cls][0], "failures": f, "condition_removals": c, "source": f"class_parameter: {given[cls][1]}"}
        else:
            out[cls] = {"share": None, "failures": f, "condition_removals": c, "source": "not recorded"}
    for cls, (v, src) in given.items():   # a supplied share also covers classes with no recent removals
        out.setdefault(cls, {"share": v, "failures": 0, "condition_removals": 0, "source": f"class_parameter: {src}"})
    return out


def build(tables: dict, as_of, settings: dict | None = None, horizon: int | None = None) -> dict:
    S = settings or load_settings()
    as_of = pd.Timestamp(as_of)
    H = horizon or S["horizon_years"]
    keys = S["cohorts"]["keys"]
    asset = tables["asset"]

    # 1. life curves
    ex = life.exposure(asset, tables["record_window"], as_of)
    curves = life.fit_library(ex, keys, S["cohorts"]["min_events"], S["cohorts"]["shrinkage_events"])
    by_key = {(c.asset_class, c.cohort): c for c in curves}

    # active at as_of, in classes that have a curve (no end of life ever documented: no curve, no forecast)
    inst, rem = pd.to_datetime(asset["install_date"]), pd.to_datetime(asset["removal_date"])
    act = asset[(inst <= as_of) & (rem.isna() | (rem > as_of)) & asset["asset_class"].isin({c.asset_class for c in curves})].copy()
    act["age_years"] = (as_of - pd.to_datetime(act["install_date"])).dt.days / life.YEAR
    act["cohort"] = ""
    for cls, g in act.groupby("asset_class"):
        act.loc[g.index, "cohort"] = life.cohort_label(g, keys.get(cls, keys.get("default", [])))

    # 2. forecast at age
    fshare = failure_share(asset, as_of, S["failure_share_years"], tables.get("class_parameter"))
    scale = np.empty(len(act)); shape = np.empty(len(act)); src = []
    for j, (cls, coh) in enumerate(zip(act["asset_class"], act["cohort"])):
        c = by_key.get((cls, coh)) or by_key[(cls, "class")]
        scale[j], shape[j] = c.scale, c.shape
        src.append(c.source)
    act["curve_source"] = src
    h = np.arange(1, H + 1)
    A = act["age_years"].to_numpy()[:, None] + h[None, :]
    cum = lambda x: (x / scale[:, None]) ** shape[:, None]  # noqa: E731
    p = 1.0 - np.exp(-(cum(A) - cum(A - 1.0)))

    model_id = "ref-" + as_of.strftime("%Y%m%d") + "-" + hashlib.sha1(json.dumps(S, sort_keys=True).encode()).hexdigest()[:8]
    pfge = act["asset_class"].map(lambda c: (fshare.get(c) or {}).get("share"))
    pof = pd.DataFrame({
        "asset_id": np.repeat(act["asset_id"].to_numpy(), H),
        "year_offset": np.tile(h, len(act)).astype("int32"),
        "p_end_of_life": p.ravel(),
        "p_failure_given_eol": np.repeat(pfge.to_numpy(dtype=float, na_value=np.nan), H),
        "model_id": model_id,
    })

    # new assets: the curve a replacement follows
    nac = []
    for cls in sorted({c.asset_class for c in curves}):
        choice = S["new_asset_curve"].get(cls, S["new_asset_curve"]["default"])
        c = (by_key.get((cls, choice)) if choice != "class" else None) or by_key[(cls, "class")]
        ages = np.arange(0, H + 1)
        nac.append(pd.DataFrame({"asset_class": cls, "age_year": ages.astype("int32"), "p_end_of_life": c.p_year(ages),
                                 "p_failure_given_eol": (fshare.get(cls) or {}).get("share"), "model_id": model_id}))
    nac = pd.concat([n.astype({"p_failure_given_eol": float}) for n in nac], ignore_index=True)

    explain = act[["asset_id", "asset_class", "cohort", "age_years", "curve_source"]].copy()
    explain["p_end_of_life_next_year"] = p[:, 0]
    explain["explanation"] = [f"{r.asset_class} {r.cohort}, {r.age_years:.0f} yr in service; curve: {r.curve_source}"
                              for r in explain.itertuples()]
    explain["model_id"] = model_id

    details = {"settings": S, "as_of_date": str(as_of.date()),
               "curves": [dataclasses.asdict(c) | {"median_life_years": c.median} for c in curves], "failure_share": fshare}
    run = pd.DataFrame([{"model_id": model_id, "as_of_date": as_of.date(),
                         "method": "ARMOR reference: left-truncated Weibull per class and cohort (shrunk to class), scored at age",
                         "created_at": pd.Timestamp(dt.datetime.now(dt.timezone.utc)).tz_localize(None),
                         "details_json": json.dumps(details, default=str)}])
    return {"pof_forecast": pof, "new_asset_curve": nac, "model_run": run,
            "asset_explanation": explain, "life_curve": life.curves_frame(curves),
            "failure_share": pd.DataFrame([{"asset_class": k, **v} for k, v in fshare.items()]),
            "_active": act}
