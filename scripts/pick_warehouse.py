"""Pick the SQL warehouse the app queries, once per bundle target, and save it where the Databricks CLI reads
variable values (.databricks/bundle/<target>/variable-overrides.json).

Skipped when warehouse_id is already set: --var warehouse_id=..., BUNDLE_VAR_warehouse_id, or a saved value.
Otherwise it takes a serverless warehouse in the workspace, preferring "Serverless Starter Warehouse", then one that
is running. With no serverless warehouse it takes any warehouse, and with none at all it stops and says what to pass.

Called by scripts/bundle.sh with the bundle command's arguments (it reads --profile/-p and --target/-t from them).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

PREFERRED = "Serverless Starter Warehouse"


def arg(args, *names):
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                return args[i + 1]
            if a.startswith(n + "="):
                return a.split("=", 1)[1]
    return None


def main(args):
    if any("warehouse_id=" in a for a in args) or os.environ.get("BUNDLE_VAR_warehouse_id"):
        return
    target = arg(args, "--target", "-t") or os.environ.get("DATABRICKS_BUNDLE_TARGET") or "dev"
    path = Path(".databricks/bundle") / target / "variable-overrides.json"
    saved = json.loads(path.read_text()) if path.exists() else {}
    if saved.get("warehouse_id"):
        return
    cmd = ["databricks", "warehouses", "list", "-o", "json"]
    profile = arg(args, "--profile", "-p")
    if profile:
        cmd += ["--profile", profile]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"Could not list SQL warehouses ({out.stderr.strip()}). Pass --var warehouse_id=<id>.")
    warehouses = json.loads(out.stdout or "[]")
    if not warehouses:
        sys.exit("No SQL warehouse in this workspace. Create one (serverless recommended), "
                 "or pass --var warehouse_id=<id>.")
    serverless = [w for w in warehouses if w.get("enable_serverless_compute")]
    pool = serverless or warehouses
    pool.sort(key=lambda w: (w.get("name") != PREFERRED, w.get("state") != "RUNNING", w.get("name", "")))
    w = pool[0]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({**saved, "warehouse_id": w["id"]}, indent=2) + "\n")
    kind = "serverless" if serverless else "not serverless (no serverless warehouse found)"
    print(f"SQL warehouse for the app: {w.get('name')} ({w['id']}, {kind}); saved in {path}. "
          f"Change it with --var warehouse_id=<id> or by editing that file.")


if __name__ == "__main__":
    main(sys.argv[1:])
