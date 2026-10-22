#!/usr/bin/env bash
# Run a Databricks bundle command; a deploy builds the app first (scripts/build_app.sh).
#   scripts/bundle.sh deploy --var catalog=<catalog> --profile <profile>
#   scripts/bundle.sh run armor_demo --var catalog=<catalog> --profile <profile>
# The first time, it also picks the SQL warehouse the app uses (scripts/pick_warehouse.py), unless you pass
# --var warehouse_id=<id>, and saves it for the target, so later `databricks bundle` commands use it too.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
python3 scripts/pick_warehouse.py "$@"
if [[ "${1:-}" == deploy ]]; then
  scripts/build_app.sh
fi
exec databricks bundle "$@"
