"""The data-model check: does a set of tables match contract/asset_data_model.yml?

STRUCTURE ONLY. For each table the contract declares, it checks:
  - the table exists (a missing optional table is reported ABSENT, not a failure);
  - each declared column exists with a compatible type;
  - required columns are not null (and `required_when` columns are not null when their condition holds);
  - the primary key is unique;
  - references resolve (e.g. every asset.upstream_device_id is a device.device_id);
  - code columns hold only codes from the contract's vocabulary;
  - bounded quantities are inside their declared domain (a percent 0-100, a count >= 0);
  - planning_parameter.unit equals the unit its parameter code declares;
  - every asset_class in `asset` has a record_window row.

It does NOT look at distributions, realism, or whether numbers are plausible for a utility. Those are the
data owner's call, not a precondition for running the engine.

The value checks are plain SQL that runs on Databricks SQL / Spark SQL and on sqlite (local tests). The
caller supplies two callbacks, so this module has no Spark or warehouse dependency:
    columns(table_name) -> {column_name: type_string} or None if the table doesn't exist
    query(sql) -> first row as a tuple
"""
from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Callable

import yaml

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contract" / "asset_data_model.yml"

# Contract type -> type-name fragments accepted from the engine's DESCRIBE output (Spark, sqlite, pandas).
_TYPE_OK = {
    "string": ("string", "varchar", "char", "text", "object"),
    "date": ("date", "datetime64", "timestamp"),  # a timestamp column carries a date; accepted
    "timestamp": ("timestamp", "datetime64"),
    "double": ("double", "float", "decimal", "real", "numeric"),
    "long": ("bigint", "long", "int", "integer"),
    "int": ("int", "integer", "bigint", "long", "smallint", "tinyint"),
    "boolean": ("boolean", "bool"),
}


def load_contract(path: Path = CONTRACT_PATH) -> dict:
    return yaml.safe_load(path.read_text())


@dataclasses.dataclass
class Finding:
    table: str
    check: str
    status: str  # PASS | FAIL | ABSENT
    detail: str = ""


def _type_ok(declared: str, actual: str) -> bool:
    a = actual.lower()
    return any(frag in a for frag in _TYPE_OK[declared])


def check(tables: dict[str, str], columns: Callable[[str], dict | None], query: Callable[[str], tuple],
          section: str = "tables", contract: dict | None = None) -> list[Finding]:
    """Check `tables` (contract table name -> physical table name) against the contract.

    section = "tables" checks the utility data model; "model_outputs" checks a probability model's output.
    """
    c = contract or load_contract()
    spec_all = c[section]
    codes = c["codes"]
    out: list[Finding] = []
    present: dict[str, str] = {}
    incomplete: set[str] = set()   # present but missing columns: value, reference and cross-table checks are skipped

    for tname, spec in spec_all.items():
        phys = tables.get(tname)
        cols = columns(phys) if phys else None
        if cols is None:
            required = spec.get("required", True) if section == "tables" else True
            out.append(Finding(tname, "exists", "FAIL" if required else "ABSENT",
                               f"required table missing ({phys or 'not mapped'})" if required
                               else f"optional; disables: {spec.get('enables', '')}"))
            continue
        present[tname] = phys
        cols_l = {k.lower(): v for k, v in cols.items()}
        missing = [k for k in spec["columns"] if k.lower() not in cols_l]
        out.append(Finding(tname, "columns", "FAIL" if missing else "PASS",
                           f"missing: {missing}" if missing else f"{len(spec['columns'])} columns"))
        bad_types = [f"{k}: {cols_l[k.lower()]} (want {v['type']})" for k, v in spec["columns"].items()
                     if k.lower() in cols_l and not _type_ok(v["type"], cols_l[k.lower()])]
        out.append(Finding(tname, "types", "FAIL" if bad_types else "PASS", "; ".join(bad_types)))
        if missing:
            incomplete.add(tname)  # value, reference and cross-table checks would query the missing columns
            continue

        n = query(f"SELECT COUNT(*) FROM {phys}")[0]
        out.append(Finding(tname, "rows", "PASS" if n else "FAIL", f"{n:,} rows"))

        pk = spec["primary_key"]
        # A nullable key column (e.g. action_cost.cost_zone) is part of the key; coalesce so NULLs compare.
        keyexpr = ", ".join(f"COALESCE(CAST({k} AS VARCHAR(400)), '<null>')" for k in pk)
        dup = query(f"SELECT COUNT(*) FROM (SELECT {keyexpr}, COUNT(*) AS n FROM {phys} GROUP BY {keyexpr} HAVING COUNT(*) > 1) d")[0]
        out.append(Finding(tname, f"primary key {pk}", "FAIL" if dup else "PASS", f"{dup:,} duplicated keys" if dup else ""))

        for col, cs in spec["columns"].items():
            if cs.get("required"):
                nn = query(f"SELECT COUNT(*) FROM {phys} WHERE {col} IS NULL")[0]
                out.append(Finding(tname, f"{col} not null", "FAIL" if nn else "PASS", f"{nn:,} nulls" if nn else ""))
            if cs.get("required_when"):
                nn = query(f"SELECT COUNT(*) FROM {phys} WHERE ({cs['required_when']}) AND {col} IS NULL")[0]
                out.append(Finding(tname, f"{col} not null when {cs['required_when']}", "FAIL" if nn else "PASS",
                                   f"{nn:,} nulls" if nn else ""))
            if cs.get("codes"):
                vocab = list(codes[cs["codes"]].keys())
                inlist = ", ".join(f"'{v}'" for v in vocab)
                bad = query(f"SELECT COUNT(*), MIN({col}) FROM {phys} WHERE {col} IS NOT NULL AND {col} NOT IN ({inlist})")
                out.append(Finding(tname, f"{col} codes", "FAIL" if bad[0] else "PASS",
                                   f"{bad[0]:,} rows outside {vocab}, e.g. '{bad[1]}'" if bad[0] else ""))
            if cs.get("domain"):
                lo, hi = cs["domain"]
                cond = " OR ".join(x for x in [f"{col} < {lo}" if lo is not None else "",
                                               f"{col} > {hi}" if hi is not None else ""] if x)
                bad = query(f"SELECT COUNT(*) FROM {phys} WHERE {cond}")[0]
                out.append(Finding(tname, f"{col} in {cs['domain']} {cs.get('unit', '')}".strip(), "FAIL" if bad else "PASS",
                                   f"{bad:,} rows outside" if bad else ""))

    # references and cross-table rules: only between tables that are present with all their columns
    present = {t: p for t, p in present.items() if t not in incomplete}
    all_tables = {**c.get("tables", {}), **c.get("model_outputs", {})}
    for tname, phys in present.items():
        for col, cs in spec_all[tname]["columns"].items():
            ref = cs.get("references")
            if not ref:
                continue
            rt, rc = ref.split(".")
            rphys = present.get(rt) or (tables.get(rt) if rt not in incomplete else None)
            if not rphys or rt not in all_tables:
                continue
            bad = query(f"SELECT COUNT(*) FROM {phys} a WHERE a.{col} IS NOT NULL AND NOT EXISTS "
                        f"(SELECT 1 FROM {rphys} b WHERE b.{rc} = a.{col})")[0]
            out.append(Finding(tname, f"{col} -> {ref}", "FAIL" if bad else "PASS", f"{bad:,} unresolved" if bad else ""))

    # cross-table rules that are part of the model, not a data-quality opinion
    if section == "tables":
        if "asset" in present and "record_window" in present:
            bad = query(f"SELECT COUNT(DISTINCT a.asset_class) FROM {present['asset']} a WHERE NOT EXISTS "
                        f"(SELECT 1 FROM {present['record_window']} w WHERE w.asset_class = a.asset_class)")[0]
            out.append(Finding("record_window", "every asset_class has a window", "FAIL" if bad else "PASS",
                               f"{bad} classes without one" if bad else ""))
        if "asset" in present:
            bad = query(f"SELECT COUNT(*) FROM {present['asset']} WHERE removal_date < install_date")[0]
            out.append(Finding("asset", "removal_date >= install_date", "FAIL" if bad else "PASS", f"{bad:,} rows" if bad else ""))
        if "class_parameter" in present:
            for p, ps in codes["class_parameter"].items():
                row = query(f"SELECT COUNT(*), MIN(unit) FROM {present['class_parameter']} WHERE parameter = '{p}' AND unit <> '{ps['unit']}'")
                out.append(Finding("class_parameter", f"{p} unit = {ps['unit']}", "FAIL" if row[0] else "PASS", f"found unit '{row[1]}'" if row[0] else ""))
                bad = query(f"SELECT COUNT(*) FROM {present['class_parameter']} WHERE parameter = '{p}' AND ({_outside(ps['domain'])})")[0]
                out.append(Finding("class_parameter", f"{p} in {ps['domain']}", "FAIL" if bad else "PASS", ""))
        if "planning_parameter" in present:
            for p, ps in codes["planning_parameter"].items():
                row = query(f"SELECT COUNT(*), MIN(unit) FROM {present['planning_parameter']} WHERE parameter = '{p}' AND unit <> '{ps['unit']}'")
                out.append(Finding("planning_parameter", f"{p} unit = {ps['unit']}", "FAIL" if row[0] else "PASS",
                                   f"found unit '{row[1]}'" if row[0] else ""))
                bad = query(f"SELECT COUNT(*) FROM {present['planning_parameter']} WHERE parameter = '{p}' AND ({_outside(ps['domain'])})")[0]
                out.append(Finding("planning_parameter", f"{p} in {ps['domain']}", "FAIL" if bad else "PASS", ""))
    return out


def _outside(domain) -> str:
    """SQL condition for a value outside [lo, hi]; either bound may be null (open)."""
    lo, hi = domain
    return " OR ".join(x for x in [f"value < {lo}" if lo is not None else "", f"value > {hi}" if hi is not None else ""] if x) or "FALSE"


def failed(findings: list[Finding]) -> list[Finding]:
    return [f for f in findings if f.status == "FAIL"]


def absent_tables(findings: list[Finding]) -> set[str]:
    return {f.table for f in findings if f.status == "ABSENT"}


def required_inputs_markdown(contract: dict | None = None) -> str:
    """docs/REQUIRED_INPUTS.md, generated from the contract so the doc can never drift from the check."""
    c = contract or load_contract()
    L = ["# Required inputs", "", "Generated from `contract/asset_data_model.yml` by `python -m armor.contract --doc`. Do not edit.", "",
         "ARMOR checks structure only: tables, columns, types, not-null, keys, references, code vocabularies and physical",
         "domains. It never checks whether your numbers look realistic, and it never fills in a missing input.", ""]
    for section, title in (("tables", "Your data"), ("model_outputs", "Probability model outputs (written by the reference model, or by yours)")):
        L += [f"## {title}", ""]
        for t, s in c[section].items():
            req = "required" if s.get("required", True) else "optional"
            L += [f"### `{t}` ({req})", "", f"**Grain:** {s['grain']}", ""]
            if s.get("why"):
                L += [f"**Why:** {s['why']}", ""]
            if s.get("enables"):
                L += [f"**Enables:** {s['enables']}", ""]
            L += [f"**Primary key:** `{', '.join(s['primary_key'])}`", "", "| column | type | unit | required | meaning |", "|---|---|---|---|---|"]
            for col, cs in s["columns"].items():
                req_c = "yes" if cs.get("required") else (f"when {cs['required_when']}" if cs.get("required_when") else "no")
                extra = []
                if cs.get("codes"):
                    extra.append(f"codes: {', '.join('`' + k + '`' for k in c['codes'][cs['codes']])}")
                if cs.get("domain"):
                    extra.append(f"domain {cs['domain']}")
                if cs.get("references"):
                    extra.append(f"references `{cs['references']}`")
                meaning = " ".join([cs.get("meaning", "")] + [f"({e})" for e in extra]).strip()
                L.append(f"| `{col}` | {cs['type']} | {cs.get('unit', '')} | {req_c} | {meaning} |")
            L.append("")
    L += ["## Code vocabularies", ""]
    for name, vocab in c["codes"].items():
        L += [f"### `{name}`", "", "| code | meaning |", "|---|---|"]
        for k, v in vocab.items():
            L.append(f"| `{k}` | {v['meaning'] + ' (unit ' + v['unit'] + ')' if isinstance(v, dict) else v} |")
        L.append("")
    return "\n".join(L)


if __name__ == "__main__":
    import sys
    if "--doc" in sys.argv:
        out = CONTRACT_PATH.parents[1] / "docs" / "REQUIRED_INPUTS.md"
        text = required_inputs_markdown()
        if "--check" in sys.argv:
            raise SystemExit(0 if out.exists() and out.read_text() == text else "docs/REQUIRED_INPUTS.md is stale: run python -m armor.contract --doc")
        out.parent.mkdir(exist_ok=True)
        out.write_text(text)
        print(f"wrote {out}")
