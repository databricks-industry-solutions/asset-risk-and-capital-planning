# ARMOR job: check the asset data model, run the reference probability model, backtest it, write outputs.
#
#   --input_schema   schema holding the contract tables (asset, record_window, device, inspection, ...)
#   --output_schema  schema ARMOR writes to (model outputs + review tables)
#   --as_of          forecast origin (default: the day after the latest install/removal date in `asset`)
#   --src_dir        workspace folder holding src/ (serverless spark_python_task has no __file__)
#
# Stops before modeling if the data-model check FAILs. Optional tables that are absent are reported and
# the features that need them are off. Nothing is defaulted.
import argparse
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--input_schema", required=True, help="<catalog>.<schema> of the asset data model")
ap.add_argument("--output_schema", required=True, help="<catalog>.<schema> ARMOR writes to")
ap.add_argument("--as_of", default="")
ap.add_argument("--src_dir", default="")
ap.add_argument("--skip_backtest", action="store_true")
A, _ = ap.parse_known_args(sys.argv[1:])
if A.src_dir:
    sys.path.insert(0, f"{A.src_dir}/src")

import pandas as pd  # noqa: E402
from pyspark.sql import SparkSession  # noqa: E402

from armor import contract  # noqa: E402
from armor.model import backtest, reference  # noqa: E402

spark = SparkSession.builder.getOrCreate()
C = contract.load_contract()
spark.sql(f"CREATE SCHEMA IF NOT EXISTS {A.output_schema} COMMENT 'ARMOR outputs: probability model + decision engine'")


def columns(t):
    try:
        return dict(spark.table(t).dtypes)
    except Exception:
        return None


def first(sql):
    return tuple(spark.sql(sql).first())


# ---- 1. data-model check (structure only)
tables = {t: f"{A.input_schema}.{t}" for t in C["tables"]}
findings = contract.check(tables, columns, first)
rep = pd.DataFrame([f.__dict__ for f in findings])
spark.createDataFrame(rep).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{A.output_schema}.contract_report")
for f in findings:
    if f.status != "PASS":
        print(f.status, f.table, f.check, f.detail)
print(f"contract: {(rep.status == 'PASS').sum()} PASS, {(rep.status == 'ABSENT').sum()} ABSENT, {(rep.status == 'FAIL').sum()} FAIL")
if contract.failed(findings):
    raise SystemExit("data model check failed: see contract_report")
absent = contract.absent_tables(findings)

# ---- 2. load (pandas: the reference model is single-node; ~1M units fits comfortably)
T = {t: spark.table(tables[t]).toPandas() for t in ("asset", "record_window")}
if "class_parameter" not in absent:
    T["class_parameter"] = spark.table(tables["class_parameter"]).toPandas()
if A.as_of:
    as_of = pd.Timestamp(A.as_of)
else:
    last = max(pd.to_datetime(T["asset"]["install_date"]).max(), pd.to_datetime(T["asset"]["removal_date"]).max())
    as_of = (last + pd.Timedelta(days=1)).normalize()
print("as_of", as_of.date())

# ---- 3. reference model (drop review tables from an earlier model version that this one doesn't write)
for old in ("strength_curve", "persistence", "inspection_evidence"):
    spark.sql(f"DROP TABLE IF EXISTS {A.output_schema}.{old}")
S = reference.load_settings()
o = reference.build(T, as_of, S)
comments = {
    "pof_forecast": "Probability contract: P(end of life in year_offset | in service at its start, no action), per active asset. Written by the ARMOR reference model; any model may write it.",
    "new_asset_curve": "Probability contract: P(end of life) by age for a replacement built to today's standard, per class.",
    "model_run": "Probability contract: one row per model run, with every fitted parameter and setting in details_json.",
    "asset_explanation": "Per active asset: cohort, age, curve source, next-year probability, one-line explanation.",
    "life_curve": "Reference model: fitted Weibull per class and cohort (left-truncated), with events, data weight and source.",
    "failure_share": "Reference model: in-service failures / (failures + condition removals) over the recent window, per class.",
}
for name, df in o.items():
    if name.startswith("_") or df is None or not len(df):
        continue
    sdf = spark.createDataFrame(df)
    sdf.write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{A.output_schema}.{name}")
    if name in comments:
        spark.sql(f"COMMENT ON TABLE {A.output_schema}.{name} IS '{comments[name].replace(chr(39), chr(92) + chr(39))}'")
    print(f"wrote {A.output_schema}.{name}: {len(df):,} rows")

# ---- 4. the probability contract checks the model's own output the same way it checks the utility's data
mo_tables = {t: f"{A.output_schema}.{t}" for t in C["model_outputs"]}
mf = contract.check(mo_tables, columns, first, section="model_outputs")
bad = contract.failed(mf)
for f in bad:
    print("MODEL OUTPUT FAIL", f.table, f.check, f.detail)
if bad:
    raise SystemExit("model outputs don't match the probability contract")

# ---- 5. serving tables for the app's point lookups, and their Lakebase syncs if set up (armor.serving)
from armor import serving  # noqa: E402

for q in serving.build_sql(A.input_schema, A.output_schema, absent):
    spark.sql(q)
try:
    from databricks.sdk import WorkspaceClient
    for line in serving.refresh_synced(WorkspaceClient(), A.output_schema):
        print("serving:", line)
except Exception as e:   # serving is optional; the model outputs are already written
    print(f"serving: Lakebase refresh not started ({type(e).__name__}: {e})")

# ---- 6. backtest (a report, never a gate)
if not A.skip_backtest:
    B = S["backtest"]
    origins, skipped = backtest.origins_for(as_of, T["record_window"], B["origin_years_before_as_of"], B["horizon_years"])
    for o, why in skipped:
        print(f"backtest: origin {o.date()} skipped ({why})")
    if not origins:
        print("backtest: no usable origin in this data; skipped")
        A.skip_backtest = True
if not A.skip_backtest:
    m, cal = backtest.run(T, origins, B["horizon_years"], S, as_of=as_of)
    spark.createDataFrame(m).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{A.output_schema}.backtest_metrics")
    spark.createDataFrame(cal).write.mode("overwrite").option("overwriteSchema", "true").saveAsTable(f"{A.output_schema}.backtest_calibration")
    print(m.round(4).to_string())
print('{"status": "ok"}')
