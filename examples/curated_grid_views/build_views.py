"""Create the example contract views and run the data-model check against them (an illustrative onboarding example).

    python examples/curated_grid_views/build_views.py --profile <profile> --warehouse <warehouse id> \
        --src <catalog>.<schema> --dst <catalog>.<schema>

--src is a curated grid schema with the tables contract_views.sql reads (see the note there); --dst is the schema that becomes
ARMOR's input (the bundle variable input_schema). contract_views.sql is the mapping: rename and recode only.
Runs through the SQL warehouse, so it needs only the Databricks SDK and a CLI profile.
"""
import argparse
import sys
from pathlib import Path

from databricks.sdk import WorkspaceClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from armor import contract  # noqa: E402
from armor.warehouse import Warehouse  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--profile", required=True, help="Databricks CLI profile")
ap.add_argument("--warehouse", required=True, help="SQL warehouse id")
ap.add_argument("--src", required=True, help="the foundation's curated schema, <catalog>.curated")
ap.add_argument("--dst", required=True, help="schema for ARMOR's input views, <catalog>.<schema>")
A = ap.parse_args()
VIEWS = "contract_views.sql"

wh = Warehouse(WorkspaceClient(profile=A.profile), A.warehouse)
wh.execute(f"CREATE SCHEMA IF NOT EXISTS {A.dst} COMMENT 'ARMOR asset data model: views over {A.src} (rename/recode only)'")
sql = (Path(__file__).parent / VIEWS).read_text().format(src=A.src, dst=A.dst)
# drop full-line comments first: they may contain semicolons
sql = "\n".join(l for l in sql.splitlines() if not l.lstrip().startswith("--"))
for stmt in [s.strip() for s in sql.split(";") if s.strip()]:
    name = stmt.split("VIEW", 1)[1].split("AS", 1)[0].strip()
    wh.execute(stmt)
    print("view", name)

tables = {t: f"{A.dst}.{t}" for t in contract.load_contract()["tables"]}
findings = contract.check(tables, wh.columns, wh.first)
for f in findings:
    print(f"{f.status:6} {f.table:20} {f.check:55} {f.detail}")
bad = contract.failed(findings)
print(f"\n{len(bad)} FAIL, {sum(f.status == 'ABSENT' for f in findings)} ABSENT, {sum(f.status == 'PASS' for f in findings)} PASS")
sys.exit(1 if bad else 0)
