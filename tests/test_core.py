"""Unit tests for the parts whose correctness isn't visible from the output: the structural check catches what it
claims to, the life fit recovers a known curve under left truncation, the value arithmetic matches a direct
calculation, the backtest is placed relative to the data, the app refuses to start unconfigured, the optimizer honours obligations, budgets, envelopes and visits, and the consequence counts the planned
job. App-level plan tests (look-ahead, strategies, break-even, projection, simulation) are in test_app.py."""
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from armor import contract  # noqa: E402
from armor.engine import plan, value  # noqa: E402
from armor.model import backtest, life  # noqa: E402


# ------------------------------------------------------------------ contract check
def _sqlite(tables: dict):
    con = sqlite3.connect(":memory:")
    for name, df in tables.items():
        df.to_sql(name, con, index=False)
    types = {n: {c: ("date" if c.endswith("_date") else str(df[c].dtype)) for c in df.columns} for n, df in tables.items()}
    return (lambda t: types.get(t)), (lambda q: con.execute(q).fetchone())


def _good():
    asset = pd.DataFrame({"asset_id": ["a1", "a2"], "asset_class": ["pole", "pole"], "position_id": ["p1", "p1"],
                          "install_date": ["1960-01-01", "2000-01-01"], "removal_date": ["2000-01-01", None],
                          "removal_reason": ["condition", None], "feeder_id": ["f", "f"], "upstream_device_id": ["d1", "d1"],
                          "latitude": [42.0, 42.0], "longitude": [-83.0, -83.0], "end_latitude": [None, None], "end_longitude": [None, None], "parent_position_id": [None, "p0"], "cohort": [None, None], "material": ["pine", "pine"],
                          "treatment": ["creosote", "CCA"], "size_class": ["4", "4"], "cost_zone": [None, None],
                          "customers_interrupted_on_failure": [None, None]})
    asset["customers_interrupted_on_failure"] = asset["customers_interrupted_on_failure"].astype("Int64")
    asset[["end_latitude", "end_longitude"]] = asset[["end_latitude", "end_longitude"]].astype(float)
    rw = pd.DataFrame({"asset_class": ["pole"], "records_start_date": ["1990-01-01"], "source": ["test"]})
    dev = pd.DataFrame({"device_id": ["d1"], "device_type": ["fuse"], "feeder_id": ["f"], "parent_device_id": [None],
                        "customers_downstream": [10], "latitude": [42.0], "longitude": [-83.0]})
    return {"asset": asset, "record_window": rw, "device": dev}


def test_contract_passes_good_data_and_reports_optional_tables_absent():
    t = _good()
    cols, q = _sqlite(t)
    f = contract.check({k: k for k in t}, cols, q)
    assert not contract.failed(f), [x for x in contract.failed(f)]
    assert {"inspection", "outage", "action_cost", "planning_parameter"} <= contract.absent_tables(f)


@pytest.mark.parametrize("breakit,expect", [
    (lambda t: t["asset"].loc.__setitem__((0, "removal_reason"), "rotted"), "removal_reason codes"),
    (lambda t: t["asset"].loc.__setitem__((0, "removal_reason"), None), "removal_reason not null when"),
    (lambda t: t["asset"].loc.__setitem__((1, "upstream_device_id"), "nope"), "upstream_device_id -> device.device_id"),
    (lambda t: t["asset"].loc.__setitem__((1, "asset_id"), "a1"), "primary key"),
    (lambda t: t["asset"].loc.__setitem__((0, "latitude"), 95.0), "latitude in"),
    (lambda t: t["device"].loc.__setitem__((0, "customers_downstream"), -1), "customers_downstream in"),
    (lambda t: t.__setitem__("record_window", t["record_window"].assign(asset_class="tower")), "every asset_class has a window"),
])
def test_contract_catches_structural_errors(breakit, expect):
    t = _good()
    breakit(t)
    cols, q = _sqlite(t)
    bad = contract.failed(contract.check({k: k for k in t}, cols, q))
    assert any(expect in f.check for f in bad), [f.check for f in bad]


# ------------------------------------------------------------------ life curves
def test_weibull_fit_recovers_truth_under_left_truncation():
    """Units installed 1900-2000, records start 1990: pre-1990 deaths are invisible. The truncated fit must still
    recover the generating curve; ignoring truncation (entry = 0) must not."""
    rng = np.random.default_rng(1)
    lam, k, n = 70.0, 3.5, 60000
    inst = rng.uniform(1900, 2000, n)
    life_ = lam * rng.weibull(k, n)
    death = inst + life_
    start, as_of = 1990.0, 2024.0
    keep = death >= start
    inst, death = inst[keep], death[keep]
    entry = np.clip(start - inst, 0, None)
    exit_ = np.minimum(death, as_of) - inst
    event = death <= as_of
    l_hat, k_hat = life.fit_weibull(exit_, event, entry)
    assert abs(l_hat / lam - 1) < 0.03 and abs(k_hat / k - 1) < 0.05
    l_naive, _ = life.fit_weibull(exit_, event, np.zeros_like(entry))
    assert l_naive > lam * 1.05  # survivors-only view overstates life


def test_own_cohort_label_wins_over_configured_columns():
    df = pd.DataFrame({"material": ["pine", "pine"], "treatment": ["creosote", "CCA"], "cohort": ["VendorA-1985", None]})
    assert life.cohort_label(df, ["material", "treatment"]).tolist() == ["VendorA-1985", "pine|CCA"]


def test_curve_year_probability_matches_survival():
    c = life.Curve("pole", "class", 80.0, 4.0, 1, 1, 1.0, "class")
    a = 50.0
    S = lambda t: np.exp(-(t / 80.0) ** 4)  # noqa: E731
    assert np.isclose(c.p_year(a), 1 - S(a + 1) / S(a))


# ------------------------------------------------------------------ value
def test_renewal_matches_monte_carlo():
    p_new = np.full(31, 0.1)
    r = value.renewal(p_new, 30)
    # constant hazard 0.1 with immediate renewal -> 0.1 events per year, every year
    assert np.allclose(r, 0.1, atol=1e-9)


def test_benefit_matches_direct_calculation_no_renewal():
    """With a new-asset curve of 0, benefit(t) = K * sum_{j>=t} n_j D_j - S(t-1) * (1+r)^-(t-1) * P."""
    H, T, rate = 30, 5, 0.05
    p = np.linspace(0.01, 0.2, H)[None, :]
    K, P = np.array([30000.0]), np.array([12000.0])
    b = value.benefits(p, np.array(["pole"]), {"pole": np.zeros(H + 1)}, K, P, rate, T)
    S = np.concatenate([[1.0], np.cumprod(1 - p[0])[:-1]])
    n = S * p[0]
    D = (1 + rate) ** -(np.arange(1, H + 1) - 0.5)
    for t in range(T):
        direct = K[0] * np.sum(n[t:] * D[t:]) - S[t] * (1 + rate) ** -t * P[0]
        assert np.isclose(b["usd"][0, t], direct)


# ------------------------------------------------------------------ plan
def test_plan_respects_budget_and_must_address():
    ids = np.array(["a", "b", "c", "d"])
    B = np.array([[100.0, 90], [50, 60], [-10, -10], [30, 20]])
    P = np.array([10.0, 10, 10, 10])
    p = plan.solve(ids, B, P, plan.PlanRequest(budgets=[20, 10], must_address_deadline={"c": 1}))
    assert set(p.loc[p.plan_year == 1, "asset_id"]) >= {"c"}               # obligation funded in year 1
    assert p.groupby("plan_year")["planned_usd"].sum().le(pd.Series({1: 20, 2: 10})).all()
    assert p["asset_id"].is_unique


def test_plan_infeasible_when_budget_cannot_cover_obligations():
    with pytest.raises(plan.PlanInfeasible):
        plan.solve(np.array(["a", "b"]), np.array([[1.0], [1.0]]), np.array([10.0, 10.0]),
                   plan.PlanRequest(budgets=[15], must_address_deadline={"a": 1, "b": 1}))


def test_trajectory_constant_hazard_and_planned_replacement():
    P = np.full((1, 30), 0.1)
    v = value.trajectory(P, np.array(["x"]), {"x": np.full(31, 0.1)}, np.array([0]), 10)
    assert np.allclose(v["eol"], 0.1)                       # do nothing, renewal at the same hazard: steady 0.1/yr
    v = value.trajectory(P, np.array(["x"]), {"x": np.zeros(31)}, np.array([3]), 6)
    assert np.allclose(v["eol"][0], [0.1, 0.09, 0, 0, 0, 0])  # replaced in year 3 by a unit that never fails
    assert np.isclose(v["planned"][0, 2], 0.81)             # the planned job happens only if the original survived 2 years


def test_plan_respects_class_envelopes():
    ids = np.array(["p1", "p2", "t1"])
    B = np.array([[100.0], [90.0], [80.0]])
    P = np.array([10.0, 10, 10])
    req = plan.PlanRequest(budgets=[30], class_budgets={"pole": [10]}, classes=np.array(["pole", "pole", "transformer"]))
    p = plan.solve(ids, B, P, req)
    assert set(p["asset_id"]) == {"p1", "t1"}               # only one pole fits the pole envelope


def test_bundling_shares_the_visit_cost_and_respects_visit_capacity():
    """Two units in one section: alone each is worth -5 once it carries its own visit (setup + mobilization 20);
    together they share one visit, so both are worth doing. Capacity 1 per visit takes two visits and kills it."""
    ids = np.array(["a", "b"])
    B = np.array([[-5.0], [-5.0]])          # benefit with the visit cost included (one-unit job)
    add = np.array([[20.0], [20.0]])        # the visit's fixed part, added back when bundled
    P = np.array([10.0, 10.0])
    mk = lambda cap: plan.Bundling(group=np.array(["pole|d1", "pole|d1"], dtype=object), visit_value_usd={"pole|d1": 20.0},  # noqa: E731
                                   visit_capex_usd={"pole|d1": 5.0}, capacity={"pole|d1": cap}, discount=np.ones(1))
    p = plan.solve(ids, B + add, P, plan.PlanRequest(budgets=[100]), mk(np.inf))
    assert set(p["asset_id"]) == {"a", "b"}
    assert p.attrs["visits"]["visits"].sum() == 1
    assert np.isclose(plan.visit_value(p, mk(np.inf)), 20.0)
    assert len(plan.solve(ids, B + add, P, plan.PlanRequest(budgets=[100]), mk(1))) == 0
    # the visit's mobilization counts in the budget: 10 + 10 + 5 > 24
    assert len(plan.solve(ids, B + add, P, plan.PlanRequest(budgets=[24]), mk(np.inf))) < 2


def test_consequence_planned_job_counts_its_own_outage_and_mobilization():
    from armor.engine import consequence
    t = _good()
    act = t["asset"][t["asset"]["removal_date"].isna()]
    cost = pd.DataFrame({"asset_class": ["pole", "pole"], "action": ["replace", "replace"], "cost_basis": ["planned", "emergency"],
                         "cost_zone": [None, None], "usd_per_asset": [10000.0, 25000.0], "source": ["t", "t"]})
    outage = pd.DataFrame({"outage_id": ["o"], "device_id": ["d1"], "failed_asset_id": ["a1"], "start_ts": ["2020-01-01 00:00"],
                           "restore_ts": ["2020-01-01 03:00"], "customers_interrupted": [10], "major_event_day": [False]})
    cp = pd.DataFrame({"asset_class": ["pole"] * 3, "parameter": ["planned_outage_setup_minutes", "planned_outage_minutes_per_asset", "mobilization_usd"],
                       "value": [60.0, 120.0, 1500.0], "unit": ["minutes", "minutes", "USD"], "source": ["t"] * 3})
    c = consequence.build(act, t["device"], outage, cost, {"customer_minute_value": 2.0}, pd.Series({"a2": 0.25}), t["asset"], cp).iloc[0]
    # 10 customers: unplanned 180 min, planned 60 + 120 = 180 min -> the customer-minutes cancel in the CoF
    assert np.isclose(c["planned_job_usd"], 10000 + 1500 + 10 * 180 * 2.0)
    assert np.isclose(c["cof_usd"], 25000 - 10000 - 1500)
    assert np.isclose(c["visit_fixed_usd"], 1500 + 10 * 60 * 2.0)
    assert np.isclose(c["cost_per_eol_usd"], 0.25 * (25000 + 10 * 180 * 2.0) + 0.75 * c["planned_job_usd"])
    # without class_parameter the planned job is the planned cost, as before
    c0 = consequence.build(act, t["device"], outage, cost, {"customer_minute_value": 2.0}, pd.Series({"a2": 0.25}), t["asset"]).iloc[0]
    assert np.isclose(c0["planned_job_usd"], 10000) and np.isclose(c0["cof_usd"], 15000 + 10 * 180 * 2.0)


def test_contract_reports_missing_columns_without_crashing_reference_checks():
    t = _good()
    t["asset"] = t["asset"].drop(columns=["upstream_device_id"])   # a column that a reference check uses
    cols, q = _sqlite(t)
    f = contract.check({k: k for k in t}, cols, q)
    assert any(x.table == "asset" and x.check == "columns" and x.status == "FAIL" for x in f)


def test_supplied_failure_share_covers_a_class_with_no_recent_removals():
    from armor.model import reference
    a = _good()["asset"].assign(removal_date=[None, None], removal_reason=[None, None])
    cp = pd.DataFrame({"asset_class": ["pole"], "parameter": ["failure_share"], "value": [0.4], "unit": ["fraction"], "source": ["s"]})
    out = reference.failure_share(a, pd.Timestamp("2026-01-01"), 10, cp)
    assert out["pole"]["share"] == 0.4 and out["pole"]["source"].startswith("class_parameter")


def test_plan_refuses_a_must_address_asset_without_a_cost():
    req = plan.PlanRequest(budgets=[1e6, 1e6], must_address_deadline={"a": 1})
    with pytest.raises(plan.PlanInfeasible, match="no planned replacement cost"):
        plan.solve(np.array(["a", "b"]), np.array([[10.0, 10.0], [5.0, 5.0]]), np.array([np.nan, 100.0]), req)


# ------------------------------------------------------------------ configuration and backtest placement
def test_app_refuses_to_start_unconfigured(monkeypatch):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
    import app as A
    monkeypatch.setattr(A, "REQUIRED_SETTINGS", {"ARMOR_INPUT_SCHEMA": "", "ARMOR_OUTPUT_SCHEMA": "x.y", "DATABRICKS_WAREHOUSE_ID": "w"})
    saved = dict(A.STATE)
    try:
        A.load()
        assert A.STATE["stage"] == "error" and "ARMOR_INPUT_SCHEMA" in A.STATE["error"]
    finally:
        A.STATE.clear(); A.STATE.update(saved)


def test_backtest_origins_follow_the_data():
    rw = pd.DataFrame({"asset_class": ["a", "b"], "records_start_date": ["1990-01-01", "2005-06-01"]})
    kept, skipped = backtest.origins_for("2026-11-15", rw, [9, 6, 3], 5)
    assert [o.year for o in kept] == [2017, 2020, 2023] and not skipped
    # a utility whose records only start in 2019: origins before that are skipped, with the reason
    rw2 = pd.DataFrame({"asset_class": ["a"], "records_start_date": ["2019-03-01"]})
    kept, skipped = backtest.origins_for("2026-11-15", rw2, [9, 6, 3], 5)
    assert [o.year for o in kept] == [2020, 2023]
    assert [o.year for o, _ in skipped] == [2017] and "records start" in skipped[0][1]
    # an origin with no full year after it is skipped
    kept, skipped = backtest.origins_for("2026-03-01", rw, [0], 5)
    assert not kept and "no full year" in skipped[0][1]


def test_backtest_horizon_stops_at_the_as_of_date():
    assert backtest.full_years(pd.Timestamp("2023-01-01"), pd.Timestamp("2026-11-15")) == 3
    assert backtest.full_years(pd.Timestamp("2023-01-01"), pd.Timestamp("2028-01-01")) == 5
