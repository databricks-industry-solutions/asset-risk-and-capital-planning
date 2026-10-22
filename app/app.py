"""ARMOR Capital Planner: backend.

The app is the DECISION layer. It never fits a model and never fills in a missing input. It reads:
  - the utility's asset data model (contract tables, schema ARMOR_INPUT_SCHEMA), and
  - the probability contract (pof_forecast, new_asset_curve, model_run) plus the reference model's review tables
    and the data-model check (contract_report), from the ARMOR output schema (ARMOR_OUTPUT_SCHEMA);
and runs the decision engine (armor.engine) in-process: consequence, value of replacement, the multi-year
optimizer and the program simulation.

Endpoints
  /api/status               loading progress
  /api/inputs               data-model check, what's on/off and why, model run, coverage, strategies, class parameters
  /api/overview             headline numbers per class (Territory risk, map summary)
  /api/portfolio            replacement history, replacement demand forecast, age profile, risk concentration
  /api/feeders              feeder risk (optionally one class)
  /api/map                  active assets with probability, risk and consequence fields (columnar JSON)
  /api/asset/{id}           one asset: explanation, forecast, consequence, value by plan year, inspections, unit history
                            (per-asset reads from Lakebase when ARMOR_LAKEBASE_INSTANCE is set; else the warehouse)
  /api/curves               life curves, failure share (pooled and by year), backtest
  POST /api/plan            one plan for a strategy (default: the optimizer), committed 1..10 years of a 10-year
                            look-ahead -> info (incl. break-even value of a customer-minute), by_year, outcome, projects,
                            lines, summary, plan_id
  POST /api/strategies      a plan per strategy at the same settings, evaluated the same way (Compare strategies)
  POST /api/frontier        net value, spend and SAIDI of the chosen strategy at a range of annual budgets
  POST /api/future          projected per-asset end of life by plan year for a schedule, and for doing nothing (Risk map)
  POST /api/simulate        Monte Carlo of the strategies built on Compare (async; poll GET /api/simulate/{job})
  /api/plan.csv?plan=       a plan's asset lines;  /api/projects.csv?plan=  its work plan (projects)
  /api/genie/space          whether a Genie space is configured (ARMOR_GENIE_SPACE_ID), its title and sample questions
  POST /api/genie/{alias}/messages, GET /api/genie/{alias}/conversations/{id}
                            Ask: the AppKit Genie chat protocol (server-sent events) over the Genie Conversation API

Auth: the SDK uses the app's service principal in Databricks Apps, DATABRICKS_CONFIG_PROFILE locally.
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import math
import os
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from databricks.sdk import WorkspaceClient
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
# the repo's src/ when running from a checkout; the copy inside the app folder when deployed (scripts/build_app.sh)
sys.path.insert(0, str(HERE.parent / "src") if (HERE.parent / "src" / "armor").exists() else str(HERE / "src"))
from armor import contract  # noqa: E402
from armor.engine import plan as planmod  # noqa: E402
from armor.engine import portfolio, simulate  # noqa: E402
from armor.warehouse import Warehouse  # noqa: E402

# Where the data lives is deployment configuration (databricks.yml targets), never a default in code: the app runs
# on any utility's data in any catalog. load() refuses to start, and says which setting is missing, without them.
INPUT = os.environ.get("ARMOR_INPUT_SCHEMA", "")           # <catalog>.<schema> of the asset data model (contract tables)
OUT = os.environ.get("ARMOR_OUTPUT_SCHEMA", "")            # <catalog>.<schema> the model job writes
WAREHOUSE = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
REQUIRED_SETTINGS = {"ARMOR_INPUT_SCHEMA": INPUT, "ARMOR_OUTPUT_SCHEMA": OUT, "DATABRICKS_WAREHOUSE_ID": WAREHOUSE}
HORIZON, PLAN_YEARS = 30, 10

@contextlib.asynccontextmanager
async def _lifespan(_app):
    threading.Thread(target=load, daemon=True).start()   # load in the background; endpoints say 503 until ready
    yield


app = FastAPI(title="ARMOR Capital Planner", lifespan=_lifespan)
STATE: dict = {"stage": "starting", "error": None}
JOBS: dict = {}
_lock = threading.Lock()


def _clean(o):
    """NaN/inf -> None everywhere (json.dumps would emit NaN, which browsers reject)."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.floating):
        return float(o) if math.isfinite(o) else None
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def _gz(obj) -> Response:
    body = gzip.compress(json.dumps(_clean(obj), separators=(",", ":"), default=_default, allow_nan=False).encode(), 6)
    return Response(body, media_type="application/json", headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"})


def _default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return None if not math.isfinite(o) else float(o)
    if isinstance(o, (pd.Timestamp,)):
        return str(o.date())
    if isinstance(o, np.bool_):
        return bool(o)
    return str(o)


def _records(df: pd.DataFrame) -> list[dict]:
    df = df.replace([np.inf, -np.inf], np.nan).astype(object).where(df.notna(), None)
    return df.to_dict(orient="records")


def columnar(df: pd.DataFrame) -> dict:
    """Compact columnar JSON: numbers as arrays (rounded), low-cardinality strings dictionary-encoded."""
    out = {}
    for c in df.columns:
        s = df[c]
        if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
            v = s.astype(float).round(7).to_numpy()
            out[c] = [None if not math.isfinite(x) else x for x in v]
        else:
            codes, uniq = pd.factorize(s.astype("string").fillna("∅"))
            if len(uniq) <= 50000:
                out[c] = {"dict": [None if u == "∅" else u for u in uniq], "codes": codes.tolist()}
            else:
                out[c] = s.astype("string").tolist()
    return {"n": len(df), "columns": out}


# ------------------------------------------------------------------------------------------------ loading
LAKEBASE_INSTANCE = os.environ.get("ARMOR_LAKEBASE_INSTANCE", "")
LAKEBASE_RETRY_S = 120     # after a failed Lakebase lookup, serve from the warehouse this long before trying again


def _connect_lakebase(w):
    """Optional: point lookups for the asset drawer from Lakebase (armor.serving). Without it, or if it can't connect,
    the drawer reads from the warehouse, and /api/inputs says which is in use and why."""
    STATE["lakebase"], STATE["lakebase_error"] = None, None
    if not LAKEBASE_INSTANCE:
        return
    try:
        from armor import serving
        lb = serving.Lakebase(w, LAKEBASE_INSTANCE, os.environ.get("ARMOR_LAKEBASE_DATABASE", "armor"),
                              os.environ.get("ARMOR_LAKEBASE_SCHEMA", OUT.split(".")[-1]))
        lb.drawer("", "")            # open a connection now (token + TLS), so the first click is fast
        STATE["lakebase"] = lb
    except Exception as e:
        STATE["lakebase_error"] = f"{type(e).__name__}: {e}"


def load():
    try:
        missing = [k for k, v in REQUIRED_SETTINGS.items() if not v]
        if missing:
            raise RuntimeError(f"not configured: set {', '.join(missing)} (the app's databricks.yml target sets them)")
        w = WorkspaceClient()
        wh = Warehouse(w, WAREHOUSE)
        C = contract.load_contract()
        STATE["stage"] = "reading data-model check"
        rep = wh.df(f"SELECT * FROM {OUT}.contract_report")
        absent = set(rep.loc[rep["status"] == "ABSENT", "table"])
        T = {}
        STATE["stage"] = "reading asset data model"
        T["asset"] = wh.df(f"SELECT * FROM {INPUT}.asset WHERE removal_date IS NULL")
        T["record_window"] = wh.df(f"SELECT * FROM {INPUT}.record_window")
        T["device"] = wh.df(f"SELECT * FROM {INPUT}.device")
        for t in ("action_cost", "planning_parameter"):
            T[t] = None if t in absent else wh.df(f"SELECT * FROM {INPUT}.{t}")
        T["outage"] = None if "outage" in absent else wh.df(
            f"SELECT outage_id, device_id, failed_asset_id, start_ts, restore_ts, customers_interrupted, major_event_day FROM {INPUT}.outage")
        for t in ("class_parameter", "capital_history"):
            T[t] = None if t in absent else wh.df(f"SELECT * FROM {INPUT}.{t}")
        T["inspection"] = None if "inspection" in absent else wh.df(
            f"SELECT * FROM {INPUT}.inspection WHERE outcome IN ('reject', 'priority_reject')")
        # restoration by class needs the class of every failed asset, including removed ones
        failed = wh.df(f"SELECT DISTINCT a.asset_id, a.asset_class FROM {INPUT}.outage o JOIN {INPUT}.asset a ON a.asset_id = o.failed_asset_id") \
            if T["outage"] is not None else pd.DataFrame(columns=["asset_id", "asset_class"])
        asset_all = pd.concat([T["asset"][["asset_id", "asset_class"]], failed]).drop_duplicates("asset_id")

        STATE["stage"] = "reading probability outputs"
        mo = {"model_run": wh.df(f"SELECT * FROM {OUT}.model_run"),
              "new_asset_curve": wh.df(f"SELECT * FROM {OUT}.new_asset_curve")}
        priced = sorted(T["action_cost"]["asset_class"].unique()) if T["action_cost"] is not None else []
        cls_list = ", ".join(f"'{c}'" for c in priced) or "''"
        # Only the priced classes, and only what the engine uses: the failure share is per asset (read at
        # year 1), model_id is one value. Halves the transfer for large fleets.
        mo["pof_forecast"] = wh.df(f"""SELECT f.asset_id, CAST(f.year_offset AS INT) AS year_offset, f.p_end_of_life,
                CASE WHEN f.year_offset = 1 THEN f.p_failure_given_eol END AS p_failure_given_eol
            FROM {OUT}.pof_forecast f
            WHERE f.asset_id IN (SELECT asset_id FROM {INPUT}.asset WHERE removal_date IS NULL AND asset_class IN ({cls_list}))""")
        explain = wh.df(f"SELECT * FROM {OUT}.asset_explanation")
        review = {}
        for t in ("life_curve", "failure_share", "backtest_metrics", "backtest_calibration"):
            try:  # review tables are specific to the reference model; another model may not write them
                review[t] = wh.df(f"SELECT * FROM {OUT}.{t}")
            except RuntimeError:
                review[t] = pd.DataFrame()

        STATE["stage"] = "building the portfolio (consequence and value of replacement)"
        pf = portfolio.build({**T, "asset_all": asset_all}, mo, HORIZON, PLAN_YEARS, classes=priced)
        from armor.engine import consequence
        planning = dict(zip(T["planning_parameter"]["parameter"], T["planning_parameter"]["value"])) if T["planning_parameter"] is not None else {}
        mins, msrc = consequence.restoration_minutes(T["outage"], asset_all)
        STATE["stage"] = "connecting to the Lakebase serving database"
        _connect_lakebase(w)
        STATE.update(T=T, mo=mo, pf=pf, explain=explain, review=review, report=rep, contract=C, priced=priced,
                     planning=planning, restoration={"minutes": mins, "source": msrc}, wh=wh)
        # warm what the first asset click needs (map frame, hash indexes), so it is as fast as the rest
        m = _map_frame()
        for name, df in (("explain", explain), ("map", m), ("asset", T["asset"]), ("pf", pf.assets)):
            _row(name, df, "")
        STATE["stage"] = "ready"
    except Exception as e:  # surface the reason on the page instead of a blank app
        STATE["error"] = f"{type(e).__name__}: {e}"
        STATE["trace"] = traceback.format_exc()
        STATE["stage"] = "error"




def _need_ready():
    if STATE["stage"] != "ready":
        raise HTTPException(503, f"loading: {STATE['stage']}" + (f" ({STATE['error']})" if STATE["error"] else ""))


# ------------------------------------------------------------------------------------------------ endpoints
@app.get("/api/status")
def status():
    return {"stage": STATE["stage"], "error": STATE["error"], "trace": STATE.get("trace")}


@app.get("/api/inputs")
def inputs():
    _need_ready()
    C, rep, pf, run = STATE["contract"], STATE["report"], STATE["pf"], STATE["mo"]["model_run"].iloc[0]
    tables = []
    for t, spec in C["tables"].items():
        r = rep[rep["table"] == t]
        st = "ABSENT" if (r["status"] == "ABSENT").any() else ("FAIL" if (r["status"] == "FAIL").any() else "PASS")
        rows = r.loc[r["check"] == "rows", "detail"]
        tables.append({"table": t, "required": spec.get("required", True), "status": st,
                       "rows": rows.iloc[0] if len(rows) else "", "grain": spec["grain"], "enables": spec.get("enables", ""),
                       "why": spec.get("why", ""), "columns": [{"name": k, **{kk: vv for kk, vv in v.items()}} for k, v in spec["columns"].items()],
                       "checks": _records(r[["check", "status", "detail"]])})
    ex = STATE["explain"]
    cover = ex.groupby("asset_class").agg(active_with_forecast=("asset_id", "size"),
                                          expected_eol_next_year=("p_end_of_life_next_year", "sum")).reset_index()
    a = pf.assets
    val = a.groupby(["asset_class", "value_status"]).size().rename("n").reset_index()
    details = json.loads(run["details_json"])
    return _gz({"tables": tables, "codes": C["codes"], "model_outputs": C["model_outputs"],
                "model_run": {"model_id": run["model_id"], "as_of_date": str(run["as_of_date"]), "method": run["method"],
                              "created_at": str(run["created_at"]), "settings": details.get("settings")},
                "coverage": _records(cover), "value_status": _records(val), "notes": pf.notes,
                "priced_classes": STATE["priced"], "planning": STATE["planning"],
                "restoration": STATE["restoration"],
                "costs": _records(STATE["T"]["action_cost"]) if STATE["T"]["action_cost"] is not None else [],
                "must_address": {k: int(v) for k, v in a["open_finding"].value_counts().items()},
                "must_address_rule": portfolio.MUST_ADDRESS_DEADLINE,
                "failure_share": {r["asset_class"]: (None if pd.isna(r["share"]) else float(r["share"])) for r in _records(STATE["review"]["failure_share"])}
                if len(STATE["review"]["failure_share"]) else {},
                "failure_share_years": (details.get("settings") or {}).get("failure_share_years"),
                "strategies": [{"k": k, **v, "optimizer": k in OPTIMIZER_STRATEGIES} for k, v in STRATEGIES.items()],
                "serving": {"backend": "lakebase" if STATE.get("lakebase") is not None and time.time() >= STATE.get("lakebase_down_until", 0) else "warehouse",
                            "instance": LAKEBASE_INSTANCE or None, "error": STATE.get("lakebase_error")},
                "class_parameters": _records(STATE["T"]["class_parameter"]) if STATE["T"].get("class_parameter") is not None else []})


def _map_frame() -> pd.DataFrame:
    """Every active asset with a forecast, with the fields the map colours, filters and summarises on."""
    if "map_df" in STATE:
        return STATE["map_df"]
    ex, pf, T = STATE["explain"], STATE["pf"], STATE["T"]
    a = T["asset"]
    geo = a[["asset_id", "feeder_id", "latitude", "longitude", "end_latitude", "end_longitude", "upstream_device_id",
             "customers_interrupted_on_failure", "parent_position_id", "material"]]
    # network: the coordinates of the parent position (its active unit), so the map can draw structure-to-structure lines
    pos = a.drop_duplicates("position_id").set_index("position_id")[["latitude", "longitude"]]
    geo = geo.assign(plat=geo["parent_position_id"].map(pos["latitude"]), plon=geo["parent_position_id"].map(pos["longitude"])).drop(columns="parent_position_id")
    d = ex[["asset_id", "asset_class", "cohort", "age_years", "p_end_of_life_next_year", "curve_source"]].merge(geo, on="asset_id", how="left")
    dev = T["device"].set_index("device_id")["customers_downstream"]
    d["customers"] = d["customers_interrupted_on_failure"].astype("Float64").fillna(d["upstream_device_id"].map(dev).astype("Float64")).astype(float)
    # reliability: every class whose failure share is known (records or class_parameter), priced or not
    fsh = STATE["review"]["failure_share"]
    share = dict(zip(fsh["asset_class"], fsh["share"])) if len(fsh) else {}
    mins = STATE["restoration"]["minutes"]
    d["p_failure"] = d["asset_class"].map(share).astype(float)
    d["restoration_minutes"] = d["asset_class"].map(lambda c: mins.get(c, mins.get("*", np.nan)))
    d["expected_failures_next_year"] = d["p_end_of_life_next_year"] * d["p_failure"]
    d["expected_customers_interrupted_next_year"] = d["expected_failures_next_year"] * d["customers"]
    d["customer_minutes_at_risk_next_year"] = d["expected_customers_interrupted_next_year"] * d["restoration_minutes"]
    extra = pf.assets[["asset_id", "risk_usd_next_year", "eol_cost_usd_next_year", "cof_usd", "open_finding", "best_plan_year", "best_benefit_usd"]]
    d = d.merge(extra, on="asset_id", how="left").drop(columns=["upstream_device_id", "customers_interrupted_on_failure", "p_failure", "restoration_minutes"])
    STATE["map_df"] = d
    return d


@app.get("/api/map")
def map_points():
    """Point assets and line assets (those with end coordinates), columnar."""
    _need_ready()
    d = _map_frame().rename(columns={"latitude": "lat", "longitude": "lon", "end_latitude": "lat2", "end_longitude": "lon2"})
    line = d["lat2"].notna()
    return _gz({"points": columnar(d[~line].drop(columns=["lat2", "lon2"])), "lines": columnar(d[line])})


@app.get("/api/overview")
def overview():
    """Headline numbers for the map's KPI strip, per class and in total (next year, if nothing is done)."""
    _need_ready()
    d = _map_frame()
    g = d.groupby("asset_class").agg(active=("asset_id", "size"), expected_eol=("p_end_of_life_next_year", "sum"),
                                      mean_age=("age_years", "mean"), expected_failures=("expected_failures_next_year", lambda x: x.sum(min_count=1)),
                                      customers_interrupted=("expected_customers_interrupted_next_year", lambda x: x.sum(min_count=1)),
                                      customer_minutes_at_risk=("customer_minutes_at_risk_next_year", lambda x: x.sum(min_count=1)),
                                      risk_usd=("risk_usd_next_year", lambda x: x.sum(min_count=1)),
                                      eol_cost_usd=("eol_cost_usd_next_year", lambda x: x.sum(min_count=1)),
                                      open_findings=("open_finding", "count")).reset_index()
    g["priced"] = g["asset_class"].isin(STATE["priced"])
    fsh = STATE["review"]["failure_share"]
    g = g.merge(fsh[["asset_class", "share", "source"]].rename(columns={"share": "failure_share", "source": "failure_share_source"}), on="asset_class", how="left") if len(fsh) and "source" in fsh else g
    # customers served: every customer below a feeder head (devices with no parent), from the device table
    dev = STATE["T"]["device"]
    served = int(dev.loc[dev["parent_device_id"].isna(), "customers_downstream"].sum())
    feeder_customers = dev[dev["parent_device_id"].isna()].groupby("feeder_id")["customers_downstream"].sum().astype(int).to_dict()
    return _gz({"by_class": _records(g), "customers_served": served, "feeder_customers": feeder_customers,
                "feeders": int(d["feeder_id"].nunique()), "as_of_date": str(STATE["mo"]["model_run"].iloc[0]["as_of_date"])})


def _removal_history() -> pd.DataFrame:
    """Removals per class x calendar year x reason, from the asset table (every unit ever in service)."""
    if "removal_history" not in STATE:
        STATE["removal_history"] = STATE["wh"].df(f"""SELECT asset_class, CAST(year(removal_date) AS INT) AS year, removal_reason, COUNT(*) AS n
                                                      FROM {INPUT}.asset WHERE removal_date IS NOT NULL GROUP BY 1, 2, 3""")
    return STATE["removal_history"]


def _portfolio():
    """Service territory outlook, per asset class: replacement history, the replacement demand forecast (with
    replacements' own end of life), age profile, next-year risk concentration, expected failures and end-of-life cost."""
    if "portfolio" in STATE:
        return STATE["portfolio"]
    wh, pf, T = STATE["wh"], STATE["pf"], STATE["T"]
    as_of_year = int(pd.Timestamp(STATE["mo"]["model_run"].iloc[0]["as_of_date"]).year)
    hist = _removal_history()
    rw = T["record_window"].copy()
    rw["records_start_year"] = pd.to_datetime(rw["records_start_date"]).dt.year
    # years of history available per class (within the record window, up to 10)
    span = {r.asset_class: int(min(10, max(0, as_of_year - r.records_start_year))) for r in rw.itertuples()}
    # first end of life of TODAY's units per future year (SQL, every class) ...
    first = wh.df(f"""WITH f AS (
          SELECT a.asset_class, f.year_offset, LEAST(f.p_end_of_life, 0.999999) AS p,
                 COALESCE(SUM(LN(1 - LEAST(f.p_end_of_life, 0.999999))) OVER (PARTITION BY f.asset_id ORDER BY f.year_offset
                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS log_s
          FROM {OUT}.pof_forecast f JOIN {INPUT}.asset a ON a.asset_id = f.asset_id)
        SELECT asset_class, CAST(year_offset AS INT) AS year_offset, SUM(p * EXP(log_s)) AS n FROM f GROUP BY 1, 2""")
    # ... plus the end of life of their replacements (renewal), from the class's new-asset curve:
    #     m_h = n_h + sum_{j<h} n_j r_{h-j}
    from armor.engine import value as V
    nac = STATE["mo"]["new_asset_curve"]
    new = {c: g.sort_values("age_year")["p_end_of_life"].to_numpy() for c, g in nac.groupby("asset_class")}
    fsh = STATE["review"]["failure_share"]
    share = dict(zip(fsh["asset_class"], fsh["share"])) if len(fsh) else {}
    wave = []
    for cls, g in first.groupby("asset_class"):
        n = g.sort_values("year_offset")["n"].to_numpy()
        H = len(n)
        r = V.renewal(new[cls], H) if cls in new else np.zeros(H)
        m = np.array([n[h] + sum(n[j] * r[h - j - 1] for j in range(h)) for h in range(H)])
        sh = share.get(cls)
        sh = None if sh is None or (isinstance(sh, float) and np.isnan(sh)) else float(sh)
        for h in range(H):
            wave.append({"asset_class": cls, "year": as_of_year + h, "expected_eol": float(m[h]), "today_units": float(n[h]),
                         "expected_failures": None if sh is None else float(m[h] * sh), "expected_caught": None if sh is None else float(m[h] * (1 - sh))})
    # expected end-of-life cost per year (priced classes, with renewal)
    # (assets in dollar plans only: an unknown failure split is left out, never costed as 0% failing)
    a = pf.assets
    tr = V.trajectory(pf.P, a["asset_class"].to_numpy(), pf.new, np.zeros(len(a), int), pf.horizon)
    pfail = a["p_failure"].to_numpy(float)
    planned_job = a["planned_usd"].to_numpy(float) + a["mobilization_usd"].fillna(0.0).to_numpy(float)   # as in the Plan's end-of-life capital
    unit = np.where(a["priced"].to_numpy(), pfail * a["emergency_usd"].to_numpy(float) + (1 - pfail) * planned_job, np.nan)
    eol_cost = []
    for cls in np.unique(a["asset_class"]):
        m = (a["asset_class"] == cls).to_numpy()
        for h in range(tr["eol"].shape[1]):
            eol_cost.append({"asset_class": cls, "year": as_of_year + h, "eol_cost_usd": float(np.nansum(tr["eol"][m, h] * unit[m]))})
    planned_cost = {c: float(g["planned_usd"].mean()) for c, g in a.groupby("asset_class")}
    # age profile by cohort (5-year bins)
    ex = STATE["explain"].assign(age_bin=lambda d: (np.floor(d["age_years"] / 5) * 5).astype(int))
    ages = ex.groupby(["asset_class", "cohort", "age_bin"]).size().rename("n").reset_index()
    # next-year risk concentration per class: risk $ where priced, else P(end of life)
    m = _map_frame()
    pareto = {}
    qs = np.linspace(0, 1, 101)[1:]
    for key, g in list(m.groupby("asset_class")) + [("*", m)]:
        priced_g = g["risk_usd_next_year"].notna().any()
        v = np.sort((g["risk_usd_next_year"] if priced_g else g["p_end_of_life_next_year"]).fillna(0).to_numpy())[::-1]
        cum = np.cumsum(v) / max(v.sum(), 1e-12)
        pareto[key] = {"basis": "risk_usd" if priced_g else "p_end_of_life",
                       "points": [{"share_assets": float(q), "share": float(cum[max(0, int(q * len(v)) - 1)])} for q in qs]}
    cap = T.get("capital_history")
    out = {"history": _records(hist), "history_years": span, "records_start": _records(rw.drop(columns=["records_start_date"])),
           "wave": wave, "eol_cost": eol_cost, "planned_cost_usd": planned_cost, "ages": _records(ages), "pareto": pareto,
           "capital_history": _records(cap) if cap is not None else None, "priced_classes": STATE["priced"], "as_of_year": as_of_year}
    STATE["portfolio"] = out
    return out


@app.get("/api/portfolio")
def portfolio_ep():
    _need_ready()
    return _gz(_portfolio())


@app.get("/api/feeders")
def feeders(asset_class: str = ""):
    """Feeder risk: every feeder with active forecast assets (optionally one asset class)."""
    _need_ready()
    d = _map_frame()
    if asset_class:
        d = d[d["asset_class"] == asset_class]
    known = lambda x: x.sum(min_count=1)  # noqa: E731   (no failure share recorded -> not recorded, not 0)
    g = d.groupby("feeder_id").agg(assets=("asset_id", "size"),
                                   mean_age=("age_years", "mean"), expected_eol=("p_end_of_life_next_year", "sum"),
                                   expected_failures=("expected_failures_next_year", known),
                                   customer_minutes_at_risk=("customer_minutes_at_risk_next_year", known),
                                   customers_interrupted=("expected_customers_interrupted_next_year", known),
                                   risk_usd=("risk_usd_next_year", lambda x: x.sum(min_count=1)), open_findings=("open_finding", "count"),
                                   lat=("latitude", "mean"), lon=("longitude", "mean")).reset_index()
    dev = STATE["T"]["device"]
    g["customers"] = g["feeder_id"].map(dev[dev["parent_device_id"].isna()].groupby("feeder_id")["customers_downstream"].sum())
    g["risk_per_asset_usd"] = g["risk_usd"] / g["assets"]
    return _gz({"feeders": _records(g.sort_values("risk_usd", ascending=False))})


def _row(name: str, df: pd.DataFrame, asset_id: str) -> int:
    """Position of asset_id in a loaded frame, by a cached hash index (point lookups without scanning 400k rows)."""
    idx = STATE.setdefault("_idx", {})
    if name not in idx or idx[name][0] is not df:
        idx[name] = (df, pd.Index(df["asset_id"]))
    k = idx[name][1].get_indexer([asset_id])[0]
    return int(k)


def _drawer_lookups(asset_id: str, position_id: str) -> dict:
    """The drawer's per-asset reads: forecast by year, units at the position, inspections. From Lakebase when
    configured (one round trip, milliseconds); otherwise from the SQL warehouse, the three statements in parallel."""
    lb = STATE.get("lakebase")
    if lb is not None and time.time() >= STATE.get("lakebase_down_until", 0):
        try:
            t0 = time.time()
            d = lb.drawer(asset_id, position_id)
            STATE["lakebase_error"] = None
            return {**d, "serving": "lakebase", "lookup_ms": round((time.time() - t0) * 1000, 1)}
        except Exception as e:  # serve from the warehouse, don't try Lakebase again for a while, and say so
            STATE["lakebase_error"] = f"{type(e).__name__}: {e}"
            STATE["lakebase_down_until"] = time.time() + LAKEBASE_RETRY_S
    from concurrent.futures import ThreadPoolExecutor
    wh, q = STATE["wh"], {"id": asset_id}
    sqls = {"forecast": (f"SELECT year_offset, p_end_of_life, p_failure_given_eol FROM {OUT}.pof_forecast WHERE asset_id = :id ORDER BY year_offset", q),
            "history": (f"SELECT asset_id, install_date, removal_date, removal_reason FROM {INPUT}.asset WHERE position_id = :pos ORDER BY install_date", {"pos": position_id}),
            "inspections": (f"SELECT inspection_date, method, outcome, remaining_strength_pct, resolved_date FROM {INPUT}.inspection WHERE asset_id = :id ORDER BY inspection_date", q)}

    def one(k):
        try:
            return k, _records(wh.df(*sqls[k])), None
        except Exception as e:     # say which read failed; an error is not "no data"
            return k, [], f"{type(e).__name__}: {str(e)[:200]}"
    t0 = time.time()
    with ThreadPoolExecutor(3) as ex:
        res = list(ex.map(one, sqls))
    out = {k: v for k, v, _ in res}
    errors = {k: err for k, _, err in res if err}
    if "inspections" in errors and STATE["T"].get("inspection") is None:
        errors.pop("inspections")  # no inspection table in the data model: none to show, not an error
    return {**out, "serving": "warehouse", "lookup_ms": round((time.time() - t0) * 1000, 1), "lookup_errors": errors or None}


@app.get("/api/asset/{asset_id}")
def asset(asset_id: str):
    _need_ready()
    ex, pf = STATE["explain"], STATE["pf"]
    k = _row("explain", ex, asset_id)
    if k < 0:
        raise HTTPException(404, "not an active asset with a forecast")
    e = ex.iloc[[k]]
    out = {"explanation": _records(e)[0]}
    m = _map_frame()
    row_m = _records(m.iloc[[_row("map", m, asset_id)]][["customers", "expected_failures_next_year", "expected_customers_interrupted_next_year", "customer_minutes_at_risk_next_year", "feeder_id"]])[0]
    out["customers"] = row_m["customers"]
    served = _served()
    out["reliability"] = {"p_failure_next_year": row_m["expected_failures_next_year"],
                          "saifi": (row_m["expected_customers_interrupted_next_year"] / served) if served and row_m["expected_customers_interrupted_next_year"] is not None else None,
                          "saidi_min": (row_m["customer_minutes_at_risk_next_year"] / served) if served and row_m["customer_minutes_at_risk_next_year"] is not None else None}
    fsh = STATE["review"]["failure_share"]
    fr = fsh[fsh["asset_class"] == e.iloc[0]["asset_class"]]
    out["failure_share_source"] = fr["source"].iloc[0] if len(fr) and "source" in fr else None
    a = STATE["T"]["asset"]
    out["record"] = _records(a.iloc[[_row("asset", a, asset_id)]])[0]
    out.update(_drawer_lookups(asset_id, out["record"]["position_id"]))
    lc = STATE["review"]["life_curve"]
    r = e.iloc[0]
    cur = lc[(lc["asset_class"] == r["asset_class"]) & (lc["cohort"] == r["cohort"])]
    out["curve"] = _records(cur)[0] if len(cur) else None
    i = _row("pf", pf.assets, asset_id)
    if i >= 0:
        pa = pf.assets.iloc[i]
        out["consequence"] = {k: pa.get(k) for k in ("customers", "minutes", "minutes_source", "p_failure", "planned_usd", "planned_source",
                                                      "emergency_usd", "emergency_source", "customer_minutes_per_failure", "cost_per_eol_usd",
                                                      "cof_usd", "risk_usd_next_year", "eol_cost_usd_next_year", "expected_failures_next_year",
                                                      "value_status", "open_finding", "must_address_by_year",
                                                      "planned_outage_minutes", "planned_customer_minutes", "planned_outage_setup_minutes",
                                                      "planned_outage_minutes_per_asset", "planned_outage_setup_minutes_source",
                                                      "planned_outage_minutes_per_asset_source", "mobilization_usd", "mobilization_usd_source",
                                                      "planned_job_usd", "planned_outage_value_usd")}
        out["consequence"]["customer_minute_value"] = STATE["planning"].get("customer_minute_value")
        out["consequence"]["customer_minute_value_source"] = next((r["source"] for r in _records(STATE["T"]["planning_parameter"]) if r["parameter"] == "customer_minute_value"), None) if STATE["T"]["planning_parameter"] is not None else None
        bi = np.nonzero(pf.benefit["index"] == i)[0]
        if len(bi):
            out["benefit_by_year"] = [{"plan_year": t + 1, "benefit_usd": float(pf.benefit["usd"][bi[0], t]),
                                       "eol_avoided": float(pf.benefit["eol_avoided"][bi[0], t])} for t in range(pf.plan_years)]
    return _gz(out)


@app.get("/api/curves")
def curves():
    _need_ready()
    R = STATE["review"]
    out = {k: _records(v) for k, v in R.items()}
    # share failing in service by removal year (failures / (failures + condition removals)), so a change in the
    # inspection program shows; the model's share is measured over its window (model settings failure_share_years)
    h = _removal_history()
    h = h[h["removal_reason"].isin(["failure", "condition"])].pivot_table(index=["asset_class", "year"], columns="removal_reason", values="n", aggfunc="sum", fill_value=0)
    h = h.reindex(columns=["failure", "condition"], fill_value=0).reset_index().rename(columns={"failure": "failures", "condition": "condition_removals"})
    h["share"] = h["failures"] / (h["failures"] + h["condition_removals"])
    as_of = pd.Timestamp(STATE["mo"]["model_run"].iloc[0]["as_of_date"])
    settings = json.loads(STATE["mo"]["model_run"].iloc[0]["details_json"]).get("settings") or {}
    out["failure_share_by_year"] = _records(h[h["year"] < as_of.year + (1 if as_of.dayofyear > 1 else 0)])
    out["failure_share_years"] = settings.get("failure_share_years")
    out["as_of_date"] = str(as_of.date())
    return _gz(out)


def _priced_arrays():
    pf = STATE["pf"]
    a = pf.assets.iloc[pf.benefit["index"]]
    must = {r.asset_id: int(r.must_address_by_year) for r in a[a["must_address_by_year"].notna()].itertuples()}
    return a, pf.benefit["usd"], a["planned_usd"].to_numpy(float), must


def _plan_setup(req: dict) -> dict:
    """The optimizer inputs for a plan request (shared by /api/plan and /api/frontier).

    Scope: asset_ids (a map selection) and/or classes; everything else is left as is. class_budgets: optional per-class
    annual envelopes. bundle_by: "none" | "section" | "feeder" (plan.bundle)."""
    a, B, P, must = _priced_arrays()
    pf = STATE["pf"]
    # The plan commits to `plan_years` but always looks PLAN_YEARS ahead: a short plan then only takes the assets whose
    # best year really is now (a 1-year plan solved alone would take anything worth replacing now, even when waiting
    # pays more), and a deadline beyond the committed years stays in the later year it is due.
    commit = max(1, min(int(req.get("plan_years", PLAN_YEARS)), PLAN_YEARS))
    T = PLAN_YEARS
    B = B[:, :T]
    scope = np.ones(len(a), bool)
    if req.get("asset_ids"):
        scope &= a["asset_id"].isin(set(req["asset_ids"])).to_numpy()
    if req.get("classes"):
        scope &= a["asset_class"].isin(set(req["classes"])).to_numpy()
    if not scope.all():
        B = np.where(scope[:, None], B, -np.inf)
        keep = set(a.loc[scope, "asset_id"])
        must = {k: v for k, v in must.items() if k in keep}
    unit = req.get("bundle_by") or "none"
    if unit == "auto":            # the default: bundle by section wherever the data supplies shared visit costs
        unit = "section"
    mob = a["mobilization_usd"].fillna(0.0).to_numpy(float)
    bundling = None
    if unit in planmod.BUNDLE_UNITS:
        bundling, add = planmod.bundle(a, pf.benefit["survival"], pf.discount_rate or 0.0, T, unit, STATE["planning"].get("customer_minute_value"))
        B = B + add
        bundled = np.array([g is not None for g in bundling.group])
        if not bundled.any():
            bundling, unit = None, "none"
    capex = P + (mob if bundling is None else np.where(bundled, 0.0, mob))   # unbundled units carry their own mobilization
    cb = {c: [float(x)] * T for c, x in (req.get("class_budgets") or {}).items() if x not in (None, "")}
    budgets = [float(b) for b in (req.get("budgets") or [float(req.get("annual_budget_usd", 0))])]
    budgets = (budgets + [budgets[-1]] * T)[:T]
    crew = req.get("crew")
    crew = ([int(c) for c in crew] + [int(crew[-1])] * T)[:T] if crew else None
    return {"a": a, "B": B, "capex": capex, "must": must if req.get("must_address", True) else None, "T": T, "commit": commit, "scope": scope,
            "bundling": bundling, "unit": unit, "class_budgets": cb or None, "classes": a["asset_class"].to_numpy(),
            "budgets": budgets, "crew": crew}


def _commit(p: pd.DataFrame, n: int) -> pd.DataFrame:
    """The committed years of a look-ahead schedule (visits too)."""
    out = p[p["plan_year"] <= n].reset_index(drop=True)
    out.attrs.update(p.attrs)
    if p.attrs.get("visits") is not None and len(p.attrs["visits"]):
        out.attrs["visits"] = p.attrs["visits"][p.attrs["visits"]["plan_year"] <= n].reset_index(drop=True)
    return out


def _solve_value(S: dict, min_spend_fraction: float = 0.0, quick: bool = False) -> pd.DataFrame:
    """The value-maximizing schedule (plan.solve) over the look-ahead years. quick: the frontier's shorter limits."""
    bundling = S["bundling"]
    limit, gap = (45, 5e-3) if bundling is not None else (90, 1e-4)
    if quick:
        limit, gap = (15, 1e-2) if bundling is not None else (30, 1e-4)
    try:
        return planmod.solve(S["a"]["asset_id"].to_numpy(), S["B"], S["capex"],
                             planmod.PlanRequest(budgets=S["budgets"], crew=S["crew"], must_address_deadline=S["must"],
                                                 min_spend_fraction=min_spend_fraction,
                                                 # visit variables make the problem much harder: accept a stated 0.5% gap
                                                 time_limit_s=limit, mip_rel_gap=gap,
                                                 class_budgets=S["class_budgets"], classes=S["classes"]), bundling)
    except planmod.PlanInfeasible as e:
        raise HTTPException(422, str(e))


def _strategy_key(req: dict) -> str:
    k = req.get("strategy") or ("value_full" if float(req.get("min_spend_fraction", 0) or 0) > 0 else "value")
    if k not in STRATEGIES:
        raise HTTPException(400, f"unknown strategy {k}")
    return k


def _setup_for(req: dict, key: str) -> dict:
    """Plan inputs for a strategy: bundling is an optimizer constraint, so the rule-based strategies plan unbundled."""
    return _plan_setup(req if key in OPTIMIZER_STRATEGIES else {**req, "bundle_by": "none"})


def _build(req: dict, key: str, quick: bool = False) -> dict:
    S = _setup_for(req, key)
    t0 = time.time()
    p = _commit(_strategy(key, S, float(req.get("age_threshold", 60) or 60), quick), S["commit"])
    ev = _evaluate(p, S, round(time.time() - t0, 2))
    ev["response"]["info"]["strategy"] = {"key": key, **STRATEGIES[key]}
    return ev


@app.post("/api/plan")
def make_plan(req: dict = Body(...)):
    """One plan: the chosen strategy (default: the optimizer, max net value) at the request's budget and settings."""
    _need_ready()
    out = _build(req, _strategy_key(req))
    _remember(out)
    r = out["response"]
    r["summary"] = _summary(r, _served())
    return _gz(r)


def _served() -> float:
    d = STATE["T"]["device"]
    return float(d.loc[d["parent_device_id"].isna(), "customers_downstream"].sum())


MAX_PLANS = 20


def _remember(out: dict) -> str:
    """Keep a plan under its own id (the CSV downloads ask for it by id), so a slower, older request, another tab or
    another user can't change which plan a page is looking at."""
    pid = uuid.uuid4().hex[:12]
    with _lock:
        plans = STATE.setdefault("plans", {})
        plans[pid] = {"lines": out["lines"], "projects": out["projects"]}
        while len(plans) > MAX_PLANS:
            plans.pop(next(iter(plans)))
    out["response"]["plan_id"] = pid
    return pid


def _evaluate(p: pd.DataFrame, S: dict, seconds: float) -> dict:
    """Everything the Plan page shows for a schedule p (asset_id, plan_year, planned_usd, benefit_usd, must_address, ...):
    lines, per-year spend, outcome plan vs do-nothing, projects. Used for the optimizer's plan and every strategy."""
    a, bundling, pf = S["a"], S["bundling"], STATE["pf"]
    T, budgets = S["commit"], S["budgets"]
    attrs = dict(p.attrs)                  # (pandas compares attrs when casting, and attrs hold a DataFrame)
    p = p.copy()
    p.attrs = {}
    p = p.astype({"plan_year": int, "must_address": bool, "level_fill": bool})
    p.attrs.update(attrs)
    info = {k: v for k, v in p.attrs.items() if k not in ("visits", "objective", "n_candidates")}
    info["seconds"] = seconds
    v_cm = STATE["planning"].get("customer_minute_value") or 0.0
    idx = pd.Index(a["asset_id"]).get_indexer(p["asset_id"])
    ty = p["plan_year"].to_numpy() - 1
    surv = pf.benefit["survival"][idx, ty]                    # the planned job happens only if the original is still there
    cust = a["customers"].astype(float).fillna(0.0).to_numpy()[idx]
    setup = a["planned_outage_setup_minutes"].fillna(0.0).to_numpy(float)[idx]
    per = a["planned_outage_minutes_per_asset"].fillna(0.0).to_numpy(float)[idx]
    lines = p.merge(a[["asset_id", "asset_class", "feeder_id", "upstream_device_id", "cost_zone", "calendar_age_years", "p_eol_next_year",
                       "risk_usd_next_year", "customers", "open_finding", "latitude", "longitude"]], on="asset_id", how="left")
    lines = lines.merge(STATE["explain"][["asset_id", "cohort"]], on="asset_id", how="left")
    # shared visits: each visit's capital and value are split evenly over the units it replaces
    g = lines["group"] if "group" in lines else pd.Series([None] * len(lines))
    grouped = g.notna().to_numpy()
    vis = p.attrs.get("visits")
    lines["visit_share_usd"] = 0.0
    lines["visit_value_share_usd"] = 0.0
    lines["visit_setup_customer_minutes"] = 0.0
    if bundling is not None and vis is not None and len(vis):
        n = lines[grouped].groupby(["group", "plan_year"]).size().rename("units").reset_index()
        vv = vis.merge(n, on=["group", "plan_year"], how="left")
        vv["capex"] = vv["visits"] * vv["group"].map(bundling.visit_capex_usd) / vv["units"]
        vv["value"] = vv["visits"] * vv["group"].map(bundling.visit_value_usd) * bundling.discount[vv["plan_year"].to_numpy() - 1] / vv["units"]
        vv["setup_cm"] = 0.0
        if S["unit"] == "section":
            gl = pd.DataFrame({"group": g[grouped], "cust": cust[grouped], "setup": setup[grouped]}).groupby("group").agg(cust=("cust", "max"), setup=("setup", "first"))
            vv["setup_cm"] = vv["visits"] * vv["group"].map(gl["cust"] * gl["setup"]) / vv["units"]
        m = lines[["group", "plan_year"]].merge(vv[["group", "plan_year", "capex", "value", "setup_cm"]], on=["group", "plan_year"], how="left")
        lines["visit_share_usd"] = m["capex"].fillna(0.0).to_numpy()
        lines["visit_value_share_usd"] = m["value"].fillna(0.0).to_numpy()
        lines["visit_setup_customer_minutes"] = m["setup_cm"].fillna(0.0).to_numpy()
    shared_setup = grouped & (S["unit"] == "section")
    # planned-outage customer-minutes of each line: its own minutes (expected) + its share of the visits' setup
    lines["planned_customer_minutes"] = surv * cust * (per + np.where(shared_setup, 0.0, setup)) + lines["visit_setup_customer_minutes"]
    lines["cost_usd"] = lines["planned_usd"] + lines["visit_share_usd"]
    lines["net_benefit_usd"] = lines["benefit_usd"] - lines["visit_value_share_usd"]
    # Must-address work is an obligation, not an investment choice: its spend is reported on its own and its
    # modelled benefit is left out of "net benefit" (an open reject is replaced because the finding says so).
    lines["discretionary_benefit_usd"] = lines["net_benefit_usd"].where(~lines["must_address"], 0.0)
    lines["must_address_usd"] = lines["cost_usd"].where(lines["must_address"], 0.0)
    by_year = lines.groupby("plan_year").agg(replacements=("asset_id", "size"), spend_usd=("cost_usd", "sum"),
                                             must_address=("must_address", "sum"), must_address_usd=("must_address_usd", "sum"),
                                             benefit_usd=("discretionary_benefit_usd", "sum")).reindex(range(1, T + 1), fill_value=0).reset_index()
    by_year["budget_usd"] = budgets[:T]
    by_year["visits"] = vis.groupby("plan_year")["visits"].sum().reindex(range(1, T + 1), fill_value=0).to_numpy() if vis is not None and len(vis) else 0
    if S["class_budgets"]:
        for c, caps in S["class_budgets"].items():
            by_year[f"class_budget_{c}"] = caps[:T]
    by_class = lines.groupby(["plan_year", "asset_class"])["cost_usd"].sum().unstack(fill_value=0.0).reindex(range(1, T + 1), fill_value=0.0)
    by_year = by_year.join(by_class.add_prefix("spend_").reset_index(drop=True))
    # what the plan buys, in physical terms (undiscounted, over the forecast horizon)
    eol = pf.benefit["eol_avoided"][idx, ty]
    pfail = a["p_failure"].to_numpy(float)[idx]
    cmin = a["customer_minutes_per_failure"].to_numpy(float)[idx]
    disc_cost = float((lines["cost_usd"] * ~lines["must_address"]).sum())
    info.update(total_spend_usd=float(lines["cost_usd"].sum()), total_benefit_usd=float(lines["discretionary_benefit_usd"].sum()),
                must_address_usd=float(lines["must_address_usd"].sum()), n_must_address=int(lines["must_address"].sum()),
                eol_avoided=float(np.nansum(eol)), failures_avoided=float(np.nansum(eol * pfail)),
                customer_minutes_avoided=float(np.nansum(eol * pfail * cmin)), n_priced=len(a),
                discount_rate=pf.discount_rate, horizon_years=HORIZON, bundle_by=S["unit"],
                visits=int(vis["visits"].sum()) if vis is not None and len(vis) else 0,
                classes=sorted(set(a.loc[S["scope"], "asset_class"])), customer_minute_value=v_cm or None,
                planned_outage_given=bool(a[["planned_outage_setup_minutes", "planned_outage_minutes_per_asset"]].notna().any().any()),
                mobilization_given=bool(a["mobilization_usd"].notna().any()))
    # outcome by year, plan vs do nothing (analytic expectation over the scoped assets)
    from armor.engine import value as V
    ry = np.zeros(len(a), int)
    ry[idx] = lines["plan_year"].to_numpy()
    classes = a["asset_class"].to_numpy()
    Pm = pf.P[pf.benefit["index"]]
    Y = T
    scope = S["scope"]
    key = (Y, scope.tobytes())
    with _lock:                          # do-nothing is the same for every schedule over the same scope
        base = STATE.setdefault("_base", {}).get(key)
    if base is None:
        base = V.trajectory(Pm[scope], classes[scope], pf.new, np.zeros(int(scope.sum()), int), Y)
        with _lock:
            cache = STATE["_base"]
            cache[key] = base
            while len(cache) > 8:
                cache.pop(next(iter(cache)))
    plan_t = V.trajectory(Pm[scope], classes[scope], pf.new, ry[scope], Y)
    pfs = np.nan_to_num(a["p_failure"].to_numpy(float))[scope]
    cms = np.nan_to_num(a["customer_minutes_per_failure"].to_numpy(float))[scope]
    pms = np.nan_to_num(a["planned_customer_minutes"].to_numpy(float))[scope]
    pl = (a["planned_usd"].to_numpy(float) + a["mobilization_usd"].fillna(0.0).to_numpy(float))[scope]
    em = a["emergency_usd"].to_numpy(float)[scope]
    def summarize(tr, program, program_cm):
        e = tr["eol"]
        return {"eol": e.sum(0), "failures": (e * pfs[:, None]).sum(0), "customer_minutes": (e * (pfs * cms)[:, None]).sum(0),
                "eol_capital": (e * (pfs * em + (1 - pfs) * pl)[:, None]).sum(0), "program_capital": program,
                # planned interruptions: end-of-life units caught and replaced planned, plus the program's own work
                "planned_customer_minutes": (e * ((1 - pfs) * pms)[:, None]).sum(0) + program_cm}
    prog = np.bincount(ty, weights=lines["cost_usd"].to_numpy(), minlength=Y)[:Y]
    prog_cm = np.bincount(ty, weights=lines["planned_customer_minutes"].to_numpy(), minlength=Y)[:Y]
    sb, sp = summarize(base, np.zeros(Y), np.zeros(Y)), summarize(plan_t, prog, prog_cm)
    outcome = [{"plan_year": y + 1, **{f"do_nothing_{k}": float(v[y]) for k, v in sb.items() if k != "program_capital"},
                **{f"plan_{k}": float(v[y]) for k, v in sp.items()}} for y in range(Y)]
    # projects: the work plan, one per bundling unit x plan year (device section when bundling by section, else feeder)
    ukey = "upstream_device_id" if S["unit"] == "section" else "feeder_id"
    extra = {"feeder_id": ("feeder_id", "first")} if ukey != "feeder_id" else {}
    proj = lines.groupby(["plan_year", ukey]).agg(**extra, assets=("asset_id", "size"), cost_usd=("cost_usd", "sum"),
                                                  must_address=("must_address", "sum"), benefit_usd=("discretionary_benefit_usd", "sum"),
                                                  mean_age=("calendar_age_years", "mean"), max_customers=("customers", "max"),
                                                  planned_customer_minutes=("planned_customer_minutes", "sum"),
                                                  classes=("asset_class", lambda s: ", ".join(sorted(set(s)))),
                                                  lat0=("latitude", "min"), lat1=("latitude", "max"), lon0=("longitude", "min"), lon1=("longitude", "max")).reset_index()
    proj["unit_id"] = proj[ukey]
    if vis is not None and len(vis):
        vu = vis.assign(unit_id=vis["group"].str.split("|", n=1).str[1]).groupby(["plan_year", "unit_id"])["visits"].sum()
        proj["visits"] = proj.set_index(["plan_year", "unit_id"]).index.map(vu).fillna(0).astype(int)
    else:
        proj["visits"] = 0
    proj["project_id"] = ["P" + str(int(y)).zfill(2) + "-" + str(u) for y, u in zip(proj["plan_year"], proj["unit_id"])]
    # B/C of the discretionary work only (open rejects are obligations); none when a project is all obligations
    dcost = lines.assign(d=lines["cost_usd"].where(~lines["must_address"], 0.0)).groupby(["plan_year", ukey])["d"].sum()
    proj["discretionary_cost_usd"] = proj.set_index(["plan_year", ukey]).index.map(dcost).astype(float)
    proj["bc_ratio"] = np.where(proj["discretionary_cost_usd"] > 0, (proj["benefit_usd"] + proj["discretionary_cost_usd"]) / proj["discretionary_cost_usd"].where(proj["discretionary_cost_usd"] > 0), np.nan)
    lines["project_id"] = ["P" + str(int(y)).zfill(2) + "-" + str(u) for y, u in zip(lines["plan_year"], lines[ukey])]
    info["project_unit"] = "section" if S["unit"] == "section" else "feeder"
    info["scope_assets"] = int(scope.sum())
    info["budget_total_usd"] = float(np.sum(budgets[:T]))
    info["level_fill"] = int(p["level_fill"].sum())   # committed years only (the solve looks further ahead)
    info["bc_ratio"] = float((info["total_benefit_usd"] + disc_cost) / disc_cost) if disc_cost > 0 else None
    info["plan_years"] = T
    info.update(_break_even(lines, S))
    resp = {"info": info, "by_year": _records(by_year),
            "outcome": outcome, "projects": _records(proj.sort_values(["plan_year", "cost_usd"], ascending=[True, False])),
            "lines": _records(lines.drop(columns=["group"], errors="ignore").head(3000)), "n_lines": len(lines),
            "plan_asset_ids": lines["asset_id"].tolist(), "plan_years_of_assets": lines["plan_year"].tolist(),
            "plan_projects_of_assets": lines["project_id"].tolist()}
    return {"response": resp, "lines": lines, "projects": proj}


def _break_even(lines: pd.DataFrame, S: dict) -> dict:
    """The value of a customer-minute at which this plan's discretionary work breaks even (net value 0).

    Net value is linear in the value of a customer-minute v (failure outages avoided, and the planned outages the work
    causes, are both customer-minutes x v), so it is evaluated at v = 0 and v = 1 for the same schedule:
    NPV(v) = N0 + (N1 - N0) v, break-even v* = -N0 / (N1 - N0) when more valuable reliability raises the value."""
    from armor.engine import value as V
    pf, a = STATE["pf"], S["a"]
    d = lines[~lines["must_address"]]
    if not len(d):
        return {"npv_at_zero_cm_value_usd": None, "break_even_cm_value": None}
    i = pd.Index(a["asset_id"]).get_indexer(d["asset_id"])
    t = d["plan_year"].to_numpy() - 1
    cls = a["asset_class"].to_numpy()[i]
    pfl = np.nan_to_num(a["p_failure"].to_numpy(float)[i])
    em, pl = a["emergency_usd"].to_numpy(float)[i], a["planned_usd"].to_numpy(float)[i]
    mob = a["mobilization_usd"].fillna(0.0).to_numpy(float)[i]
    cm = np.nan_to_num(a["customer_minutes_per_failure"].to_numpy(float)[i])
    pm = np.nan_to_num(a["planned_customer_minutes"].to_numpy(float)[i])
    cust = a["customers"].astype(float).fillna(0.0).to_numpy()[i]
    setup = a["planned_outage_setup_minutes"].fillna(0.0).to_numpy(float)[i]
    rate = pf.discount_rate or 0.0
    disc = (1 + rate) ** -t.astype(float)
    surv = pf.benefit["survival"][i, t]
    grouped = d["group"].notna().to_numpy() if (S["bundling"] is not None and "group" in d) else np.zeros(len(d), bool)
    section = S["unit"] == "section"
    P = pf.P[pf.benefit["index"]][i]

    def npv(v):
        J = pl + mob + pm * v
        K = pfl * (em + cm * v) + (1 - pfl) * J
        b = V.benefits(P, cls, pf.new, K, J, rate, PLAN_YEARS)["usd"][np.arange(len(d)), t]
        fixed = mob + (setup * cust * v if section else 0.0)
        visit = disc * (d["visit_share_usd"].to_numpy() + d["visit_setup_customer_minutes"].to_numpy() * v)
        return float(np.sum(b + np.where(grouped, surv * disc * fixed - visit, 0.0)))
    n0, n1 = npv(0.0), npv(1.0)
    if n0 >= 0:      # pays on the emergency premium alone: worth doing at any value of a customer-minute
        return {"npv_at_zero_cm_value_usd": n0, "break_even_cm_value": 0.0, "pays_without_reliability": True}
    return {"npv_at_zero_cm_value_usd": n0, "break_even_cm_value": (-n0 / (n1 - n0)) if n1 > n0 else None, "pays_without_reliability": False}


@app.post("/api/frontier")
def frontier(req: dict = Body(...)):
    """Net value, spend and SAIDI of the chosen strategy's plan at a range of annual budgets."""
    _need_ready()
    key = _strategy_key(req)
    served = _served()
    rows = []
    for b in [float(x) for x in req.get("levels", [])][:12]:
        try:
            r = _build({**req, "budgets": [b]}, key, quick=True)["response"]
            sm = _summary(r, served)
            rows.append({"annual_budget_usd": b, "benefit_usd": sm["npv_usd"], "spend_usd": sm["program_usd"], "saidi_min": sm["saidi_min"],
                         "replacements": sm["replacements"], "feasible": True, "mip_gap": r["info"].get("mip_gap")})
        except HTTPException:
            rows.append({"annual_budget_usd": b, "benefit_usd": None, "spend_usd": None, "saidi_min": None, "replacements": 0, "feasible": False})
    return _gz({"frontier": rows, "strategy": key})


@app.post("/api/future")
def future(req: dict = Body(...)):
    """The projected state for the Risk map: each priced asset's expected end-of-life events in each plan year under a
    schedule (the current plan, or a saved plan's asset_ids + plan_years), with replacements and their renewals, and
    the same for doing nothing. Integers in units of 1e-6 events (compact JSON); the map scales its next-year metrics
    by eol_t / P(end of life next year) and fixes its colour scales at today's."""
    _need_ready()
    from armor.engine import value as V
    import hashlib
    pf = STATE["pf"]
    a = pf.assets.iloc[pf.benefit["index"]]
    # the caller sends the schedule it is showing (the client holds every plan's asset_ids and plan years), so the
    # projection always matches the plan on screen
    ids, yrs = req.get("asset_ids"), req.get("plan_years")
    if ids is None or yrs is None or len(ids) != len(yrs):
        raise HTTPException(422, "asset_ids and plan_years are required and must be the same length")
    sched = pd.DataFrame({"asset_id": ids, "plan_year": pd.to_numeric(pd.Series(yrs), errors="coerce")})
    if sched["plan_year"].isna().any() or not sched["plan_year"].between(1, PLAN_YEARS).all():
        raise HTTPException(422, f"plan_years must be whole years 1..{PLAN_YEARS}")
    sched["plan_year"] = sched["plan_year"].astype(int)
    key = hashlib.sha1(pd.util.hash_pandas_object(sched, index=False).values.tobytes()).hexdigest()
    Y = PLAN_YEARS
    with _lock:
        c = STATE.setdefault("_future", {}).get(key)
        fbase = STATE.get("_future_base")
    if c is None:
        ry = np.zeros(len(a), int)
        pos = pd.Index(a["asset_id"]).get_indexer(sched["asset_id"])
        ok = pos >= 0
        ry[pos[ok]] = sched["plan_year"].to_numpy()[ok]
        P = pf.P[pf.benefit["index"]]
        tr = V.trajectory(P, a["asset_class"].to_numpy(), pf.new, ry, Y)["eol"]
        if fbase is None:
            fbase = V.trajectory(P, a["asset_class"].to_numpy(), pf.new, np.zeros(len(a), int), Y)["eol"]
        c = {"eol": tr, "replace_year": ry}
        with _lock:
            cache = STATE.setdefault("_future", {})
            cache[key] = c
            while len(cache) > 4:
                cache.pop(next(iter(cache)))
            STATE["_future_base"] = fbase
    enc = lambda m: [np.round(m[:, t] * 1e6).astype(np.int64).tolist() for t in range(Y)]  # noqa: E731
    out = {"key": key, "years": Y, "scale": 1e-6, "asset_ids": a["asset_id"].tolist(), "plan": enc(c["eol"]),
           "replace_year": c["replace_year"].tolist(),
           "as_of_year": int(pd.Timestamp(STATE["mo"]["model_run"].iloc[0]["as_of_date"]).year)}
    if req.get("base", True):
        out["do_nothing"] = enc(fbase)
    return _gz(out)


# ------------------------------------------------------------------------------------------------ strategies
# Each strategy turns the same budget into a complete plan by a different rule; every plan is then evaluated exactly
# like the optimizer's (same outcome arithmetic), so they compare like for like and any of them can be opened in Plan.
STRATEGIES = {
    "reactive":   {"label": "Reactive", "rule": "Replace only what fails or is rejected on inspection; no proactive work. The reject backlog is replaced by its deadline whatever the budget (this is the baseline)."},
    "value":      {"label": "Max net value", "rule": "The optimizer: the replacements, and years, worth the most after their cost. Stops where more work costs more than it saves."},
    "value_full": {"label": "Max net value, full budget", "rule": "The optimizer's plan, then the budget is spent to at least 95% each year on the next-best replacements."},
    "reliability": {"label": "Most outage reduction per $", "rule": "Each year, the replacements that avoid the most customer-minutes of failure outage per dollar."},
    "pof":        {"label": "Highest P(failure) first", "rule": "Each year, the assets most likely to fail in service, as far as the budget goes."},
    "age":        {"label": "Oldest first", "rule": "Each year, the oldest assets above the age limit, as far as the budget goes."},
    "feeder":     {"label": "Worst feeders first", "rule": "Rebuild whole feeders in order of risk per dollar, carrying a feeder into the next year until it is done."},
}
OPTIMIZER_STRATEGIES = {"value", "value_full"}


def _rule_schedule(S: dict, score, per_feeder: bool = False, baseline: bool = False) -> pd.DataFrame:
    """Greedy schedule: every year fund what is due (the reject backlog by its deadline) and then the highest score[i, t]
    as far as the budget goes. per_feeder: score is per feeder (F,) and feeders are taken whole, in order.
    baseline (Reactive): the backlog is replaced whatever the budget, so the baseline exists at every setting."""
    from collections import deque
    a, T, capex = S["a"], S["T"], S["capex"]
    N = len(a)
    left = S["scope"] & np.isfinite(capex)
    idx = {x: i for i, x in enumerate(a["asset_id"])}
    due = np.full(N, np.inf)
    for k, d in (S["must"] or {}).items():
        due[idx[k]] = d
    rows = []
    if per_feeder:
        f_codes, _ = pd.factorize(a["feeder_id"])
        order = [f for f in np.argsort(-score) if np.isfinite(score[f])]
        queue = deque(i for f in order for i in np.nonzero((f_codes == f) & left & ~np.isfinite(due))[0])
    cls = S["classes"]
    env = S["class_budgets"] or {}
    lo = float(np.min(capex[left])) if left.any() else 0.0
    for t in range(T):
        budget = S["budgets"][t]
        must = np.nonzero(left & (due <= t + 1))[0]
        take = list(must)
        spend = float(capex[must].sum())
        cspend: dict = {}
        for i in must:
            cspend[cls[i]] = cspend.get(cls[i], 0.0) + capex[i]
        left[must] = False
        cap = S["crew"][t] if S["crew"] else np.inf
        # the backlog is an obligation: like the optimizer, say so when the year's budget, crews or envelopes can't hold it
        over = [f"{c} envelope" for c, v in cspend.items() if c in env and v > env[c][t] + 1e-6]
        if not baseline and (spend > budget + 1e-6 or len(take) > cap or over):
            raise HTTPException(422, f"the reject backlog due by plan year {t + 1} (${spend:,.0f}, {len(take):,} units) doesn't fit "
                                     f"the year's {', '.join(over) or ('budget' if spend > budget + 1e-6 else 'crews')}.")

        def fits(i):
            c = cls[i]
            return spend + capex[i] <= budget and (c not in env or cspend.get(c, 0.0) + capex[i] <= env[c][t])
        if per_feeder:
            # finish feeders in order; a unit whose class envelope is full waits (in order) for next year, the rest go on
            held = deque()
            while queue and len(take) < cap and spend + lo <= budget:
                i = queue.popleft()
                if not left[i]:
                    continue
                if spend + capex[i] > budget:
                    queue.appendleft(i)
                    break
                if fits(i):
                    take.append(i); spend += capex[i]; cspend[cls[i]] = cspend.get(cls[i], 0.0) + capex[i]; left[i] = False
                else:
                    held.append(i)
            queue.extendleft(reversed(held))
        elif score is not None:
            sc = np.where(left & ~np.isfinite(due), score[:, t], -np.inf)
            cand = np.argsort(-sc)
            cand = cand[np.isfinite(sc[cand])]
            for i in cand:                     # highest score first, as far as the budget, envelopes and crews allow
                if len(take) >= cap or budget - spend < lo:
                    break
                if fits(i):
                    take.append(i); spend += capex[i]; cspend[cls[i]] = cspend.get(cls[i], 0.0) + capex[i]; left[i] = False
        for i in take:
            rows.append((i, t))
    ii = np.array([r[0] for r in rows], int); tt = np.array([r[1] for r in rows], int)
    B = S["B"]
    out = pd.DataFrame({"asset_id": a["asset_id"].to_numpy()[ii], "plan_year": tt + 1, "planned_usd": capex[ii],
                        "benefit_usd": np.where(np.isfinite(B[ii, tt]), B[ii, tt], 0.0), "must_address": np.isfinite(due[ii]), "level_fill": False})
    out.attrs.update(status="rule", n_candidates=int(S["scope"].sum()))
    return out


def _strategy(key: str, S: dict, age_threshold: float, quick: bool = False) -> pd.DataFrame:
    pf, a, T = STATE["pf"], S["a"], S["T"]
    rows = pf.benefit["index"]
    capex = S["capex"]
    pfail = np.nan_to_num(a["p_failure"].to_numpy(float))
    if key == "value":
        return _solve_value(S, quick=quick)
    if key == "value_full":
        return _solve_value(S, 0.95, quick=quick)
    if key == "reactive":
        return _rule_schedule(S, None, baseline=True)
    if key == "reliability":
        cm = np.nan_to_num(a["customer_minutes_per_failure"].to_numpy(float))
        return _rule_schedule(S, pf.benefit["eol_avoided"][:, :T] * (pfail * cm)[:, None] / capex[:, None])
    if key == "pof":
        return _rule_schedule(S, pf.P[rows][:, :T] * pfail[:, None])     # P(in-service failure) in year t if still original
    if key == "age":
        age = a["calendar_age_years"].to_numpy(float)[:, None] + np.arange(T)[None, :]
        return _rule_schedule(S, np.where(age >= age_threshold, age, -np.inf))
    if key == "feeder":
        f_codes, _ = pd.factorize(a["feeder_id"])
        risk = np.bincount(f_codes, weights=np.nan_to_num(a["risk_usd_next_year"].to_numpy(float)) * S["scope"])
        cost = np.bincount(f_codes, weights=np.where(S["scope"], capex, 0.0))
        return _rule_schedule(S, np.where(cost > 0, risk / np.maximum(cost, 1), -np.inf), per_feeder=True)
    raise HTTPException(400, f"unknown strategy {key}")


def _summary(r: dict, served: float) -> dict:
    """Totals over the committed years for one evaluated plan."""
    o = r["outcome"]
    s = lambda k: float(sum(x.get(k, 0.0) or 0.0 for x in o))  # noqa: E731
    i = r["info"]
    return {"replacements": r["n_lines"], "backlog": i["n_must_address"], "program_usd": i["total_spend_usd"], "npv_usd": i["total_benefit_usd"],
            "eol_capital_usd": s("plan_eol_capital"), "total_capital_usd": s("plan_eol_capital") + s("plan_program_capital"),
            "break_even_cm_value": i.get("break_even_cm_value"), "npv_at_zero_cm_value_usd": i.get("npv_at_zero_cm_value_usd"),
            "pays_without_reliability": i.get("pays_without_reliability"),
            "failures": s("plan_failures"), "saidi_min": s("plan_customer_minutes") / served if served else None,
            "planned_saidi_min": s("plan_planned_customer_minutes") / served if served else None,
            "do_nothing_failures": s("do_nothing_failures"), "do_nothing_saidi_min": s("do_nothing_customer_minutes") / served if served else None,
            "by_year": [{"plan_year": x["plan_year"], "failures": x["plan_failures"], "saidi_min": x["plan_customer_minutes"] / served if served else None,
                         "capital_usd": x["plan_program_capital"] + x["plan_eol_capital"]} for x in o]}


@app.post("/api/strategies")
def strategies(req: dict = Body(...)):
    """Build a plan per strategy at the same budget, scope and settings, and evaluate each like the Plan page does."""
    _need_ready()
    served = _served()
    keys = [k for k in (req.get("strategies") or list(STRATEGIES)) if k in STRATEGIES]
    built, out = {}, []
    for k in keys:
        try:
            ev = _build(req, k)
        except HTTPException as e:      # e.g. the reject backlog doesn't fit this budget: say so on its card
            out.append({"key": k, **STRATEGIES[k], "infeasible": str(e.detail)})
            continue
        built[k] = ev
        out.append({"key": k, **STRATEGIES[k], "seconds": ev["response"]["info"]["seconds"], **_summary(ev["response"], served)})
    S = _plan_setup(req)
    with _lock:   # what the uncertainty run simulates: these plans, over the same scope, years and backlog rule
        STATE["strategies"] = {"plans": built, "population": S["a"].loc[S["scope"], "asset_id"].to_numpy(),
                               "years": S["commit"], "must_address": bool(req.get("must_address", True))}
    return _gz({"strategies": out, "plan_years": int(req.get("plan_years", PLAN_YEARS)), "annual_budget_usd": float((req.get("budgets") or [req.get("annual_budget_usd", 0)])[0]),
                "customers_served": served, "customer_minute_value": STATE["planning"].get("customer_minute_value")})


def _run_sim(job, req):
    """Monte Carlo of the strategies built on Compare (their fixed schedules, same scope, years and backlog rule),
    for uncertainty ranges around the expected values."""
    try:
        with _lock:
            st = STATE.get("strategies") or {}
        built = st.get("plans") or {}
        keys = [k for k in req.get("strategies", list(built)) if k in built]
        if not keys:
            raise ValueError("no plans to simulate: build the strategies first")
        r = simulate.SimRequest(years=st["years"], replicates=max(5, min(int(req.get("runs", 30)), 200)),
                                schedules={k: built[k]["lines"][["asset_id", "plan_year"]] for k in keys},
                                population=st["population"], must_address=st["must_address"])
        t0 = time.time()
        res = simulate.run(STATE["pf"], r)
        JOBS[job] = {"state": "done", "seconds": round(time.time() - t0, 1), "result": _records(res), "programs": keys,
                     "customer_minute_value": STATE["planning"].get("customer_minute_value")}
    except Exception as e:
        JOBS[job] = {"state": "error", "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}


@app.post("/api/simulate")
def start_sim(req: dict = Body(...)):
    _need_ready()
    job = uuid.uuid4().hex[:10]
    with _lock:
        while len(JOBS) >= 20:          # keep the most recent jobs only
            JOBS.pop(next(iter(JOBS)))
        JOBS[job] = {"state": "running"}
    threading.Thread(target=_run_sim, args=(job, req), daemon=True).start()
    return {"job": job}


@app.get("/api/simulate/{job}")
def sim_status(job: str):
    if job not in JOBS:
        raise HTTPException(404, "unknown job")
    return _gz(JOBS[job])


def _plan_by_id(plan: str) -> dict:
    with _lock:
        plans = STATE.get("plans") or {}
        p = plans.get(plan) if plan else (plans[next(reversed(plans))] if plans else None)
    if p is None:
        raise HTTPException(404, "unknown plan: build it again on the Plan page")
    return p


@app.get("/api/projects.csv")
def projects_csv(plan: str = ""):
    """The work plan (projects) of plan `plan` (the plan_id returned by POST /api/plan)."""
    _need_ready()
    buf = io.StringIO()
    _plan_by_id(plan)["projects"].to_csv(buf, index=False)
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=armor_work_plan.csv"})


@app.get("/api/plan.csv")
def plan_csv(plan: str = ""):
    """Every asset line of plan `plan`."""
    _need_ready()
    buf = io.StringIO()
    _plan_by_id(plan)["lines"].drop(columns=["group"], errors="ignore").to_csv(buf, index=False)
    return Response(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": "attachment; filename=armor_plan.csv"})


# ------------------------------------------------------------------------------------------------ Ask (Genie)
# Optional: a Genie space over the same data model and model outputs, asked in natural language from the Ask page.
# The browser speaks the AppKit Genie chat protocol (server-sent events); these endpoints translate it to the Genie
# Conversation API, called as the app's service principal (the app resource grants it CAN_RUN on the space).
GENIE_SPACE = os.environ.get("ARMOR_GENIE_SPACE_ID", "")
# Starter questions for an empty chat: the space's own sample questions when the app may read them (CAN_EDIT), else
# ARMOR_GENIE_QUESTIONS from the deployment target ("|"-separated).
GENIE_QUESTIONS = [q.strip() for q in os.environ.get("ARMOR_GENIE_QUESTIONS", "").split("|") if q.strip()]
GENIE_POLL_S, GENIE_TIMEOUT_S, GENIE_MAX_ROWS = 1.5, 300, 1000
GENIE_DONE = {"COMPLETED", "FAILED", "CANCELLED", "QUERY_RESULT_EXPIRED"}
_genie_w: list = []


def _genie(method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
    if not _genie_w:
        _genie_w.append(WorkspaceClient())
    return _genie_w[0].api_client.do(method, f"/api/2.0/genie/spaces/{GENIE_SPACE}{path}", body=body, query=query)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(_clean(event), default=_default)}\n\n"


def _genie_message(m: dict) -> dict:
    """A Genie message in the shape the AppKit chat renders (GenieMessageResponse)."""
    atts = []
    for a in m.get("attachments") or []:
        x: dict = {"attachmentId": a.get("attachment_id")}
        if a.get("query"):
            q = a["query"]
            x["query"] = {"title": q.get("title"), "description": q.get("description"), "query": q.get("query"),
                          "statementId": q.get("statement_id")}
        if a.get("text"):
            x["text"] = {"content": a["text"].get("content")}
        if a.get("suggested_questions"):
            x["suggestedQuestions"] = a["suggested_questions"].get("questions", [])
        atts.append(x)
    out = {"messageId": m.get("message_id") or m.get("id"), "conversationId": m.get("conversation_id"),
           "spaceId": m.get("space_id", GENIE_SPACE), "status": m.get("status"), "content": m.get("content", ""),
           "attachments": atts}
    if m.get("error"):
        e = m["error"]
        out["error"] = e.get("error") if isinstance(e, dict) else str(e)
    return out


def _genie_results(m: dict):
    """One query_result event per query attachment: the rows Genie's SQL returned (at most GENIE_MAX_ROWS)."""
    for a in m.get("attachments") or []:
        if not a.get("query") or not a.get("attachment_id"):
            continue
        r = _genie("GET", f"/conversations/{m['conversation_id']}/messages/{m.get('message_id') or m.get('id')}"
                          f"/attachments/{a['attachment_id']}/query-result")
        sr = r.get("statement_response") or {}
        rows = (sr.get("result") or {}).get("data_array") or []
        yield {"type": "query_result", "attachmentId": a["attachment_id"], "statementId": sr.get("statement_id"),
               "data": {"manifest": sr.get("manifest") or {"schema": {"columns": []}}, "result": {"data_array": rows[:GENIE_MAX_ROWS]}}}


def _need_genie():
    if not GENIE_SPACE:
        raise HTTPException(404, "no Genie space configured for this deployment (ARMOR_GENIE_SPACE_ID)")


@app.get("/api/genie/space")
def genie_space():
    if not GENIE_SPACE:
        return {"enabled": False}
    out = {"enabled": True, "title": None, "description": None, "sample_questions": GENIE_QUESTIONS}
    try:
        s = _genie("GET", "")
        out.update(title=s.get("title"), description=s.get("description"))
        try:     # the sample questions are in the serialized space, which needs more than CAN_RUN on some workspaces
            ser = json.loads(_genie("GET", "", query={"include_serialized_space": "true"}).get("serialized_space") or "{}")
            out["sample_questions"] = [q["question"][0] for q in ser.get("config", {}).get("sample_questions", []) if q.get("question")] or GENIE_QUESTIONS
        except Exception:
            pass
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


@app.post("/api/genie/{alias}/messages")
def genie_send(alias: str, body: dict = Body(...)):
    _need_genie()
    content, conv = str(body.get("content", "")).strip(), body.get("conversationId")
    if not content:
        raise HTTPException(422, "empty question")

    def stream():
        try:
            if conv:
                m = _genie("POST", f"/conversations/{conv}/messages", {"content": content})
            else:
                m = _genie("POST", "/start-conversation", {"content": content})
                m = {**(m.get("message") or {}), "conversation_id": m.get("conversation_id"), "message_id": m.get("message_id")}
            cid, mid = m.get("conversation_id"), m.get("message_id") or m.get("id")
            yield _sse({"type": "message_start", "conversationId": cid, "messageId": mid, "spaceId": GENIE_SPACE})
            last, t0 = None, time.time()
            while True:
                m = _genie("GET", f"/conversations/{cid}/messages/{mid}")
                if m.get("status") != last:
                    last = m.get("status")
                    yield _sse({"type": "status", "status": last})
                if last in GENIE_DONE:
                    break
                if time.time() - t0 > GENIE_TIMEOUT_S:
                    yield _sse({"type": "error", "error": f"Genie did not answer within {GENIE_TIMEOUT_S} s"})
                    return
                time.sleep(GENIE_POLL_S)
            yield _sse({"type": "message_result", "message": _genie_message(m)})
            if last == "COMPLETED":
                for ev in _genie_results(m):
                    yield _sse(ev)
        except Exception as e:
            yield _sse({"type": "error", "error": f"{type(e).__name__}: {e}"})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


@app.get("/api/genie/{alias}/conversations/{conversation_id}")
def genie_history(alias: str, conversation_id: str):
    """Replays a conversation (the chat keeps its id in the URL, so a reload restores it)."""
    _need_genie()

    def stream():
        try:
            msgs = _genie("GET", f"/conversations/{conversation_id}/messages").get("messages") or []
            msgs.sort(key=lambda m: m.get("created_timestamp") or 0)
            for m in msgs:
                yield _sse({"type": "message_result", "message": _genie_message(m)})
                if m.get("status") == "COMPLETED":
                    for ev in _genie_results(m):
                        yield _sse(ev)
            yield _sse({"type": "history_info", "conversationId": conversation_id, "spaceId": GENIE_SPACE,
                        "nextPageToken": None, "loadedCount": len(msgs)})
        except Exception as e:
            yield _sse({"type": "error", "error": f"{type(e).__name__}: {e}"})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


CLIENT = next((p for p in (HERE / "client" / "dist", HERE / "client_dist") if (p / "index.html").exists()), None)


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


if CLIENT is not None:
    app.mount("/assets", StaticFiles(directory=CLIENT / "assets"), name="assets")


@app.get("/{path:path}")
def spa(path: str):
    """The React client (client/dist): every non-API path serves index.html so client-side routes work."""
    if path.startswith("api/"):
        raise HTTPException(404, "unknown endpoint")
    if CLIENT is None:
        raise HTTPException(503, "client not built: cd app/client && npm run build")
    f = CLIENT / path
    if path and f.is_file():
        return FileResponse(f)
    return FileResponse(CLIENT / "index.html")
