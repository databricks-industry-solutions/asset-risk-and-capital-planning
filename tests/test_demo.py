"""The demo data (armor.demo) is a valid asset data model, and the reference model recovers the life laws it planted."""
import sqlite3
import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from armor import contract, demo  # noqa: E402
from armor.model import reference  # noqa: E402


@pytest.fixture(scope="module")
def tables():
    return demo.generate(demo.DemoSettings(seed=7, n_feeders=24, as_of="2026-01-01"))


def test_demo_passes_the_data_model_check(tables):
    con = sqlite3.connect(":memory:")
    tabs = {k: v for k, v in tables.items() if k in contract.load_contract()["tables"]}
    for n, df in tabs.items():
        d = df.copy()
        for c in d.columns:
            if str(d[c].dtype).startswith("datetime"):
                d[c] = d[c].astype(str).where(d[c].notna(), None)
        d.to_sql(n, con, index=False)
    types = {n: {c: ("date" if c.endswith("_date") else str(df[c].dtype)) for c in df.columns} for n, df in tabs.items()}
    f = contract.check({k: k for k in tabs}, lambda t: types.get(t), lambda q: con.execute(q).fetchone())
    assert not contract.failed(f), [(x.table, x.check, x.detail) for x in contract.failed(f)]
    assert contract.absent_tables(f) == {"capital_history"}


def test_demo_is_reproducible(tables):
    again = demo.generate(demo.DemoSettings(seed=7, n_feeders=24, as_of="2026-01-01"))
    pd.testing.assert_frame_equal(tables["asset"], again["asset"])


def test_demo_fleet_looks_like_a_utility(tables):
    a = tables["asset"]
    poles = a[(a.asset_class == "pole") & a.removal_date.isna()]
    age = (pd.Timestamp("2026-01-01") - pd.to_datetime(poles.install_date)).dt.days / 365.25
    assert 40 <= age.mean() <= 55                        # an aging overhead fleet
    reasons = set(a.loc[a.asset_class == "pole", "removal_reason"].dropna())
    assert {"failure", "condition", "damage", "program"} <= reasons
    i = tables["inspection"]
    assert (i.outcome.isin(["reject", "priority_reject"]) & i.resolved_date.isna()).sum() > 0   # an open reject backlog
    assert pd.to_datetime(a.removal_date).min() >= pd.Timestamp("1990-01-01")                 # left truncation


def test_model_recovers_the_planted_life_laws(tables):
    o = reference.build({"asset": tables["asset"], "record_window": tables["record_window"],
                         "class_parameter": tables["class_parameter"]}, pd.Timestamp("2026-01-01"))
    m = o["life_curve"].merge(tables["demo_life_law"], on=["asset_class", "cohort"])
    m = m[m.n_events >= 300]                              # cohorts with plenty of end-of-life events
    assert len(m) >= 5
    err = (m.median_life_years_x / m.median_life_years_y - 1).abs()
    assert err.max() < 0.08, m[["asset_class", "cohort", "n_events", "median_life_years_x", "median_life_years_y"]]
