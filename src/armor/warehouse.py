"""Minimal SQL-warehouse client (Databricks SDK statement execution) for scripts that run outside a cluster.

Jobs running on Databricks use Spark directly; this is for onboarding scripts, local development and the
app. Results come back as pandas via Arrow external links, so large tables download efficiently.
"""
from __future__ import annotations

import io
import time
import urllib.request

import pandas as pd
import pyarrow as pa
import pyarrow.ipc as ipc
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import Disposition, Format, StatementParameterListItem, StatementState


def _download(url: str, tries: int = 4) -> bytes:
    """Fetch one result chunk (a pre-signed URL). Retries transient network errors with backoff."""
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as fh:
                return fh.read()
        except OSError:
            if k == tries - 1:
                raise
            time.sleep(2 ** k)
    raise RuntimeError("unreachable")


class Warehouse:
    def __init__(self, w: WorkspaceClient, warehouse_id: str):
        self.w, self.id = w, warehouse_id

    def _run(self, sql: str, arrow: bool, params: dict | None = None):
        kw = dict(disposition=Disposition.EXTERNAL_LINKS, format=Format.ARROW_STREAM) if arrow else {}
        if params:   # named parameters (:name) instead of values pasted into the SQL
            kw["parameters"] = [StatementParameterListItem(name=k, value=None if v is None else str(v)) for k, v in params.items()]
        r = self.w.statement_execution.execute_statement(statement=sql, warehouse_id=self.id, wait_timeout="50s", **kw)
        while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
            time.sleep(1)
            r = self.w.statement_execution.get_statement(r.statement_id)
        if r.status.state != StatementState.SUCCEEDED:
            raise RuntimeError(f"{r.status.state}: {r.status.error.message if r.status.error else ''}\n{sql[:500]}")
        return r

    def execute(self, sql: str) -> None:
        self._run(sql, arrow=False)

    def df(self, sql: str, params: dict | None = None) -> pd.DataFrame:
        r = self._run(sql, arrow=True, params=params)
        tables, chunk = [], r.result
        while chunk is not None:
            for link in chunk.external_links or []:
                tables.append(ipc.open_stream(io.BytesIO(_download(link.external_link))).read_all())
            nxt = (chunk.external_links or [None])[-1]
            idx = nxt.next_chunk_index if nxt is not None else None
            chunk = self.w.statement_execution.get_statement_result_chunk_n(r.statement_id, idx) if idx is not None else None
        if tables:
            return pa.concat_tables(tables).to_pandas()
        # no rows: keep the columns, so callers can still select them
        cols = [c.name for c in (r.manifest.schema.columns or [])] if r.manifest and r.manifest.schema else []
        return pd.DataFrame(columns=cols)

    def first(self, sql: str) -> tuple:
        r = self._run(sql, arrow=False)
        rows = r.result.data_array or [[None]]
        # JSON results are strings; convert integers so callers can compare counts
        return tuple(int(v) if isinstance(v, str) and v.lstrip("-").isdigit() else v for v in rows[0])

    def columns(self, table: str) -> dict | None:
        try:
            r = self._run(f"DESCRIBE TABLE {table}", arrow=False)
        except RuntimeError:
            return None
        out = {}
        for name, typ, *_ in r.result.data_array or []:
            if not name or name.startswith("#"):
                break  # partition / metadata section
            out[name] = typ
        return out
