"""Failure handling of the optional Lakebase serving: serving tables, per-table refresh, and the app's fallback."""
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "app"))
from armor import serving  # noqa: E402


def test_absent_inspection_replaces_the_serving_copy_with_an_empty_table():
    sql = serving.build_sql("in", "out", absent={"inspection"})
    insp = [q for q in sql if "serving_inspection" in q]
    assert len(insp) == 1 and " AS SELECT" not in insp[0] and "asset_id STRING" in insp[0]
    assert any("FROM in.inspection" in q for q in serving.build_sql("in", "out", absent=set()))


def test_refresh_handles_each_table_on_its_own():
    from databricks.sdk.errors import NotFound
    started = []

    class Pipelines:
        def start_update(self, pid):
            if pid == "p-busy":
                raise RuntimeError("an update is already running")
            started.append(pid)

    def get(name):
        if "serving_inspection" in name:
            raise NotFound("no such table")
        pid = "p-busy" if "serving_unit_history" in name else "p-ok"
        return types.SimpleNamespace(data_synchronization_status=types.SimpleNamespace(pipeline_id=pid))
    w = types.SimpleNamespace(database=types.SimpleNamespace(get_synced_database_table=get), pipelines=Pipelines())
    out = serving.refresh_synced(w, "cat.sch")
    assert started == ["p-ok"]                                            # pof_forecast still refreshed
    assert any("serving_unit_history" in o and "FAILED" in o for o in out)
    assert any("serving_inspection" in o and "not set up" in o for o in out)


def test_app_falls_back_and_stops_trying_lakebase_for_a_while(monkeypatch):
    import app as A
    calls = []

    class Down:
        def drawer(self, *a):
            calls.append(1)
            raise ConnectionError("unreachable")

    class WH:
        def df(self, sql, params=None):
            import pandas as pd
            if "inspection" in sql:
                raise RuntimeError("warehouse stopped")
            return pd.DataFrame({"x": [1]})
    monkeypatch.setitem(A.STATE, "lakebase", Down())
    monkeypatch.setitem(A.STATE, "lakebase_down_until", 0)
    monkeypatch.setitem(A.STATE, "wh", WH())
    monkeypatch.setitem(A.STATE, "T", {"inspection": object()})
    r1 = A._drawer_lookups("a", "p")
    r2 = A._drawer_lookups("a", "p")
    assert r1["serving"] == r2["serving"] == "warehouse"
    assert len(calls) == 1                                               # not retried within the window
    assert r1["lookup_errors"] and "inspections" in r1["lookup_errors"]  # an error is reported, not shown as no data
    assert r1["forecast"] == [{"x": 1}]
