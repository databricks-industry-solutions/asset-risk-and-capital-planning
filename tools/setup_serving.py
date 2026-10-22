"""One-time setup of Lakebase serving for the app's asset drawer (optional; see armor/serving.py).

    python tools/setup_serving.py --profile <p> --warehouse <id> --app <app name> --instance <lakebase instance> \
        --input_schema <catalog>.<schema> --output_schema <catalog>.<schema>

Run it after the model job has written the output schema:
1. creates the Lakebase instance if it doesn't exist (smallest capacity);
2. builds the serving tables in the output schema (the model job rebuilds them after every run);
3. creates the snapshot synced tables into the Postgres database, if missing, and waits until they are online;
4. grants the app's service principal SELECT on them. The app needs the database as a resource first, which the
   bundle declares: set lakebase_instance (and lakebase_database) in your databricks.yml target, deploy, then run
   this again with --grants_only.
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from databricks.sdk import WorkspaceClient  # noqa: E402
from databricks.sdk.service.database import DatabaseInstance, SyncedDatabaseTable, SyncedTableSchedulingPolicy, SyncedTableSpec  # noqa: E402

from armor import serving  # noqa: E402
from armor.warehouse import Warehouse  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--profile", required=True, help="Databricks CLI profile")
ap.add_argument("--warehouse", required=True, help="SQL warehouse id")
ap.add_argument("--app", required=True, help="the app's name (bundle variable app_name)")
ap.add_argument("--instance", required=True, help="Lakebase instance name (bundle variable lakebase_instance)")
ap.add_argument("--database", default="armor", help="Postgres database (bundle variable lakebase_database)")
ap.add_argument("--input_schema", required=True, help="<catalog>.<schema> of the asset data model")
ap.add_argument("--output_schema", required=True, help="<catalog>.<schema> the model job writes")
ap.add_argument("--grants_only", action="store_true", help="only step 4 (after the bundle gave the app the database)")
A = ap.parse_args()
w = WorkspaceClient(profile=A.profile)


def grant():
    """4. SELECT on the synced tables for the app's service principal (its Postgres role exists once the app has the
    database as a resource)."""
    app = w.apps.get(A.app)
    if not any(r.database and r.database.instance_name == A.instance for r in (app.resources or [])):
        sys.exit(f"{A.app} has no database resource for {A.instance}: set lakebase_instance in the databricks.yml "
                 "target, deploy, then run this with --grants_only")
    sp = app.service_principal_client_id
    schema = A.output_schema.split(".")[-1]
    lb = serving.Lakebase(w, A.instance, A.database, schema)
    c, _ = lb._connect()
    with c.cursor() as cur:
        for q in (f'GRANT USAGE ON SCHEMA {schema} TO "{sp}"', f'GRANT SELECT ON ALL TABLES IN SCHEMA {schema} TO "{sp}"',
                  f'ALTER DEFAULT PRIVILEGES IN SCHEMA {schema} GRANT SELECT ON TABLES TO "{sp}"'):
            cur.execute(q)
    print(f"granted {sp} SELECT on {A.database}.{schema}")


if A.grants_only:
    grant()
    sys.exit(0)

# 1. instance
try:
    inst = w.database.get_database_instance(A.instance)
except Exception:
    print("creating instance", A.instance)
    inst = w.database.create_database_instance_and_wait(DatabaseInstance(name=A.instance, capacity="CU_1"))
print("instance", inst.name, inst.state, inst.read_write_dns)

# 2. serving tables
wh = Warehouse(w, A.warehouse)
for q in serving.build_sql(A.input_schema, A.output_schema):
    wh.execute(q)
print("serving tables built")

# 3. synced tables
for t, pk in serving.SYNCED.items():
    name = serving.synced_name(A.output_schema, t)
    try:
        w.database.get_synced_database_table(name)
        print("exists", name)
    except Exception:
        w.database.create_synced_database_table(SyncedDatabaseTable(
            name=name, database_instance_name=A.instance, logical_database_name=A.database,
            spec=SyncedTableSpec(source_table_full_name=f"{A.output_schema}.{t}", primary_key_columns=pk,
                                 scheduling_policy=SyncedTableSchedulingPolicy.SNAPSHOT, create_database_objects_if_missing=True)))
        print("created", name)
for t in serving.SYNCED:
    name = serving.synced_name(A.output_schema, t)
    while True:
        st = w.database.get_synced_database_table(name).data_synchronization_status
        state = str(st.detailed_state) if st else "?"
        if "ONLINE" in state:
            break
        if "FAILED" in state:
            sys.exit(f"{name}: {state} {st.message}")
        time.sleep(15)
    print("online", name)

# 4. grants, if the bundle has already given the app the database
try:
    grant()
except SystemExit as e:
    print(e)
