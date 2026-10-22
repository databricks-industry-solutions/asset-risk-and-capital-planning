"""Tests of the app's plan layer on a small synthetic portfolio: the 10-year look-ahead and commit, empty plans, the
break-even value of a customer-minute, the rule strategies' limits, class envelopes in the full-budget fill, the
projection endpoint's validation, and the simulation (common random numbers, mean = analytic expectation)."""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "app"))
import app as A  # noqa: E402
from armor.engine import portfolio, simulate, value  # noqa: E402

J = lambda r: json.loads(gzip.decompress(r.body))  # noqa: E731
H = 30


@pytest.fixture(scope="module", autouse=True)
def state():
    rng = np.random.default_rng(1)
    n = 60
    ids = [f"a{i:02d}" for i in range(n)]
    dev = pd.DataFrame({"device_id": [f"d{k}" for k in range(6)], "feeder_id": [f"f{k // 2}" for k in range(6)],
                        "parent_device_id": [None, "d0", None, "d2", None, "d4"], "customers_downstream": [400, 120, 300, 90, 500, 60]})
    age = rng.uniform(5, 90, n)
    asset = pd.DataFrame({"asset_id": ids, "asset_class": "pole", "position_id": ids, "feeder_id": [f"f{i % 3}" for i in range(n)],
                          "upstream_device_id": [f"d{i % 6}" for i in range(n)], "cost_zone": None, "customers_interrupted_on_failure": None,
                          "install_date": pd.Timestamp("2024-01-01") - pd.to_timedelta(age * 365.25, unit="D"), "removal_date": None,
                          "latitude": 42 + rng.random(n) / 10, "longitude": -83 + rng.random(n) / 10, "material": "pine"})
    asset["customers_interrupted_on_failure"] = asset["customers_interrupted_on_failure"].astype("Float64")
    outage = pd.DataFrame({"outage_id": [f"o{k}" for k in range(5)], "device_id": "d0", "failed_asset_id": "a00",
                           "start_ts": pd.Timestamp("2020-01-01"), "restore_ts": pd.Timestamp("2020-01-01 03:00"),
                           "customers_interrupted": 100, "major_event_day": False})
    cost = pd.DataFrame({"asset_class": "pole", "action": "replace", "cost_basis": ["planned", "emergency"], "cost_zone": None,
                         "usd_per_asset": [12000.0, 30000.0], "source": "test"})
    insp = pd.DataFrame({"asset_id": ["a01", "a02"], "inspection_date": pd.Timestamp("2023-06-01"), "outcome": ["priority_reject", "reject"],
                         "resolved_date": None})
    planning = pd.DataFrame({"parameter": ["discount_rate", "customer_minute_value"], "value": [0.05, 2.0]})
    # Weibull-ish hazards by age
    h = np.arange(1, H + 1)
    A_ = age[:, None] + h[None, :]
    cum = lambda x: (x / 70.0) ** 4  # noqa: E731
    p = 1 - np.exp(-(cum(A_) - cum(A_ - 1)))
    pof = pd.DataFrame({"asset_id": np.repeat(ids, H), "year_offset": np.tile(h, n), "p_end_of_life": p.ravel(),
                        "p_failure_given_eol": np.where(np.tile(h, n) == 1, 0.25, np.nan)})
    ages = np.arange(0, H + 1)
    nac = pd.DataFrame({"asset_class": "pole", "age_year": ages, "p_end_of_life": 1 - np.exp(-(cum(ages + 1.0) - cum(ages * 1.0)))})
    run = pd.DataFrame([{"model_id": "t", "as_of_date": pd.Timestamp("2024-01-01").date(), "method": "test", "created_at": None,
                         "details_json": json.dumps({"settings": {"failure_share_years": 10}})}])
    T = {"asset": asset, "device": dev, "outage": outage, "action_cost": cost, "planning_parameter": planning, "inspection": insp,
         "class_parameter": None}
    mo = {"model_run": run, "pof_forecast": pof, "new_asset_curve": nac}
    pf = portfolio.build({**T, "asset_all": asset[["asset_id", "asset_class"]]}, mo, H, 10, classes=["pole"])
    A.STATE.clear()
    A.STATE.update(stage="ready", error=None, pf=pf, T=T, mo=mo, priced=["pole"], planning={"discount_rate": 0.05, "customer_minute_value": 2.0},
                   explain=pd.DataFrame({"asset_id": ids, "cohort": "pine"}))
    yield


def plan(**kw):
    return J(A.make_plan({"budgets": [60000.0], "plan_years": 10, **kw}))


def test_commit_keeps_only_the_committed_years_and_counts_fill_there():
    r = plan(plan_years=2, strategy="value_full")
    assert len(r["by_year"]) == 2
    assert all(y <= 2 for y in r["plan_years_of_assets"])
    assert r["info"]["level_fill"] <= r["n_lines"]


def test_reject_due_in_year_2_is_not_forced_into_a_one_year_plan():
    r = plan(plan_years=1)
    assert "a02" not in r["plan_asset_ids"]          # a reject, due by plan year 2
    assert "a01" in r["plan_asset_ids"]              # a priority reject, due in year 1


def test_plan_with_no_candidates_is_empty_not_an_error():
    r = plan(asset_ids=["not-an-asset"], must_address=False)
    assert r["n_lines"] == 0 and r["info"]["total_spend_usd"] == 0


def test_break_even_is_where_net_value_crosses_zero():
    r = plan(budgets=[200000.0])
    i = r["info"]
    if i["pays_without_reliability"]:
        assert i["npv_at_zero_cm_value_usd"] >= 0
    else:
        n0, be, v = i["npv_at_zero_cm_value_usd"], i["break_even_cm_value"], 2.0
        slope = -n0 / be
        assert np.isclose(n0 + slope * v, i["total_benefit_usd"], rtol=1e-6, atol=1.0)


@pytest.mark.parametrize("strategy", ["pof", "age", "reliability", "feeder"])
def test_rule_strategies_respect_budget_and_crews(strategy):
    r = plan(strategy=strategy, budgets=[50000.0], crew=[3], age_threshold=10)
    for y in r["by_year"]:
        assert y["spend_usd"] <= 50000.0 + 1e-6
        assert y["replacements"] <= 3


def test_rule_strategy_says_when_the_backlog_does_not_fit():
    with pytest.raises(HTTPException) as e:
        plan(strategy="pof", budgets=[1000.0])
    assert e.value.status_code == 422


def test_full_budget_fill_respects_class_envelopes():
    r = plan(strategy="value_full", budgets=[100000.0], class_budgets={"pole": 40000.0})
    assert all(y["spend_usd"] <= 40000.0 + 1e-6 for y in r["by_year"])


def test_future_validates_and_matches_trajectory():
    with pytest.raises(HTTPException):
        A.future({"asset_ids": ["a00", "a01"], "plan_years": [1]})
    with pytest.raises(HTTPException):
        A.future({"asset_ids": ["a00"], "plan_years": [11]})
    f = J(A.future({"asset_ids": ["a03"], "plan_years": [2]}))
    k = f["asset_ids"].index("a03")
    assert f["replace_year"][k] == 2
    pf = A.STATE["pf"]
    base = value.trajectory(pf.P[pf.benefit["index"]], pf.assets.iloc[pf.benefit["index"]]["asset_class"].to_numpy(), pf.new,
                            np.zeros(len(pf.benefit["index"]), int), 10)["eol"]
    assert np.allclose(np.array(f["do_nothing"]).T * f["scale"], base, atol=2e-6)


def test_simulation_uses_common_random_numbers_and_matches_the_expectation():
    pf = A.STATE["pf"]
    sched = pd.DataFrame({"asset_id": ["a03", "a04"], "plan_year": [1, 2]})
    r = simulate.run(pf, simulate.SimRequest(years=10, replicates=600, schedules={"x": sched, "y": sched.copy()}, must_address=False))
    x, y = (r[r["program"] == k].reset_index(drop=True) for k in ("x", "y"))
    assert np.allclose(x["mean"], y["mean"])                      # same plan, same draws -> identical
    ry = np.zeros(len(pf.assets), int)
    ry[pf.assets.index[pf.assets["asset_id"].isin(["a03", "a04"])]] = [1, 2]
    tr = value.trajectory(pf.P, pf.assets["asset_class"].to_numpy(), pf.new, ry, 10)["eol"].sum(0)
    sim = x[x["metric"] == "eol"].sort_values("year")["mean"].to_numpy()
    assert np.allclose(sim.sum(), tr.sum(), rtol=0.06)
