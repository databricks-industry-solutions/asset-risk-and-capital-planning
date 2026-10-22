"""Point-lookup serving for the app's asset drawer (optional): Lakebase (Postgres) synced tables.

The drawer looks up one asset at a time: its forecast by year, the units that have stood at its position, and its
inspections. From the SQL warehouse each lookup costs about a second (statement overhead) and the position lookup more
(the input `asset` is a view). From Lakebase they are indexed point reads in milliseconds.

Three lakehouse tables are synced (snapshot) into one Lakebase database; each primary key leads with the lookup key,
so the synced table's primary-key index serves the lookup:

    serving_unit_history  (position_id, asset_id)   every unit ever in service at a position
    serving_inspection    (asset_id, inspection_id) every inspection of an asset
    pof_forecast          (asset_id, year_offset)   the probability contract itself (already a table)

`build_sql(input_schema, output_schema)` gives the CREATE OR REPLACE statements for the two serving tables (run by
jobs/run_model.py after the model, and by tools/setup_serving.py once). Without Lakebase configured the app falls back
to warehouse queries for the same data.
"""
from __future__ import annotations

import os
import queue
import threading
import time
import uuid

SERVING = {
    "serving_unit_history": {"pk": ["position_id", "asset_id"],
                             "select": "SELECT position_id, asset_id, asset_class, install_date, removal_date, removal_reason FROM {input}.asset"},
    "serving_inspection": {"pk": ["asset_id", "inspection_id"],
                           "select": "SELECT asset_id, inspection_id, inspection_date, method, outcome, remaining_strength_pct, resolved_date FROM {input}.inspection"},
}
SYNCED = {**{k: v["pk"] for k, v in SERVING.items()}, "pof_forecast": ["asset_id", "year_offset"]}


EMPTY_INSPECTION = ("asset_id STRING, inspection_id STRING, inspection_date DATE, method STRING, outcome STRING, "
                    "remaining_strength_pct DOUBLE, resolved_date DATE")


def build_sql(input_schema: str, output_schema: str, absent: set | None = None) -> list[str]:
    """CREATE OR REPLACE TABLE statements for the serving tables. When the input has no inspection table the serving
    copy is replaced by an empty one (so a copy from an earlier run can't keep serving old inspections)."""
    out = []
    comment = "COMMENT 'ARMOR serving copy for point lookups (synced to Lakebase); rebuilt by the model job'"
    for name, spec in SERVING.items():
        if absent and name == "serving_inspection" and "inspection" in absent:
            out.append(f"CREATE OR REPLACE TABLE {output_schema}.{name} ({EMPTY_INSPECTION}) {comment}")
            continue
        out.append(f"CREATE OR REPLACE TABLE {output_schema}.{name} {comment} AS {spec['select'].format(input=input_schema)}")
    return out


# ------------------------------------------------------------------------------------------------ Lakebase reader

# one round trip for the drawer: the three lookups as JSON arrays (dates come back as YYYY-MM-DD strings)
DRAWER_SQL = """
SELECT
  (SELECT json_agg(f ORDER BY f.year_offset) FROM (
     SELECT year_offset, p_end_of_life, p_failure_given_eol FROM {s}.pof_forecast_pg WHERE asset_id = %(id)s) f) AS forecast,
  (SELECT json_agg(h ORDER BY h.install_date) FROM (
     SELECT asset_id, install_date, removal_date, removal_reason FROM {s}.serving_unit_history_pg WHERE position_id = %(pos)s) h) AS history,
  (SELECT json_agg(i ORDER BY i.inspection_date) FROM (
     SELECT inspection_date, method, outcome, remaining_strength_pct, resolved_date FROM {s}.serving_inspection_pg WHERE asset_id = %(id)s) i) AS inspections
"""


class Lakebase:
    """Point reads from the Lakebase serving database with OAuth credentials (the app's service principal in Databricks
    Apps, the developer locally). A small pool of connections; each is replaced before its token expires.

    Configured by ARMOR_LAKEBASE_INSTANCE (instance name), ARMOR_LAKEBASE_DATABASE (default "armor") and
    ARMOR_LAKEBASE_SCHEMA (the Postgres schema of the synced tables: the UC schema they are registered in)."""

    MAX_AGE_S = 40 * 60       # database credentials last an hour
    CONNECT_TIMEOUT_S = 3     # a point lookup that can't connect quickly is better served by the fallback
    STATEMENT_TIMEOUT_MS = 3000

    def __init__(self, w, instance: str, database: str = "armor", schema: str = "armor", size: int = 4):
        import psycopg  # noqa: F401  (fail early if the driver is missing)
        self.w, self.instance, self.database, self.schema = w, instance, database, schema
        inst = w.database.get_database_instance(instance)
        self.host = os.environ.get("PGHOST") or inst.read_write_dns
        self.user = os.environ.get("PGUSER") or os.environ.get("DATABRICKS_CLIENT_ID") or w.current_user.me().user_name
        self.pool: queue.LifoQueue = queue.LifoQueue(maxsize=size)
        self._token, self._token_t = None, 0.0
        self._lock = threading.Lock()
        self.sql = DRAWER_SQL.format(s=self.schema)

    def _password(self) -> str:
        with self._lock:
            if self._token is None or time.time() - self._token_t > self.MAX_AGE_S:
                cred = self.w.database.generate_database_credential(request_id=str(uuid.uuid4()), instance_names=[self.instance])
                self._token, self._token_t = cred.token, time.time()
            return self._token

    def _connect(self):
        import psycopg
        c = psycopg.connect(host=self.host, dbname=self.database, user=self.user, password=self._password(), sslmode="require",
                            autocommit=True, connect_timeout=self.CONNECT_TIMEOUT_S,
                            options=f"-c statement_timeout={self.STATEMENT_TIMEOUT_MS}")
        return (c, time.time())          # (connection, opened at)

    def _get(self):
        try:
            c = self.pool.get_nowait()
            if c[0].closed or time.time() - c[1] > self.MAX_AGE_S:
                c[0].close()
                return self._connect()
            return c
        except queue.Empty:
            return self._connect()

    def _put(self, c):
        try:
            self.pool.put_nowait(c)
        except queue.Full:
            c[0].close()

    def drawer(self, asset_id: str, position_id: str) -> dict:
        """forecast, history (units at the position) and inspections for one asset, in one round trip.

        A broken connection (idle timeout, server restart) is dropped and the lookup retried once on a NEW connection;
        a SQL error (missing table, permission) keeps the connection and is raised."""
        import psycopg
        c = self._get()
        for attempt in range(2):
            try:
                with c[0].cursor() as cur:
                    cur.execute(self.sql, {"id": asset_id, "pos": position_id})
                    f, h, i = cur.fetchone()
                self._put(c)
                return {"forecast": f or [], "history": h or [], "inspections": i or []}
            except (psycopg.OperationalError, psycopg.InterfaceError):
                c[0].close()
                if attempt:
                    raise
                c = self._connect()
            except Exception:
                if not c[0].closed:
                    self._put(c)
                raise
        raise RuntimeError("unreachable")


# ------------------------------------------------------------------------------------------------ refresh / setup
def synced_name(output_schema: str, table: str) -> str:
    """The Unity Catalog name of a synced table (registered next to its source, with a _pg suffix)."""
    return f"{output_schema}.{table}_pg"


def refresh_synced(w, output_schema: str) -> list[str]:
    """Start a snapshot refresh of every synced serving table that exists (after the model job rewrites its sources).
    Returns what it did; tables that don't exist (Lakebase not set up) are skipped."""
    from databricks.sdk.errors import NotFound
    done = []
    for t in SYNCED:          # each table on its own: one failure doesn't leave the others a run behind
        name = synced_name(output_schema, t)
        try:
            st = w.database.get_synced_database_table(name)
        except NotFound:
            done.append(f"{t}: no synced table (Lakebase serving not set up), skipped")
            continue
        except Exception as e:
            done.append(f"{t}: FAILED to read {name} ({type(e).__name__}: {e})")
            continue
        pid = st.data_synchronization_status.pipeline_id if st.data_synchronization_status else None
        if not pid:
            done.append(f"{t}: FAILED: {name} has no sync pipeline")
            continue
        try:
            w.pipelines.start_update(pid)
            done.append(f"{t}: snapshot refresh started (pipeline {pid})")
        except Exception as e:   # e.g. a refresh is still running: report it, refresh the rest
            done.append(f"{t}: FAILED to start refresh (pipeline {pid}): {type(e).__name__}: {e}")
    return done
