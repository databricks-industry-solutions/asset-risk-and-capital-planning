#!/usr/bin/env bash
# Run a Databricks bundle command; a deploy builds the app first (scripts/build_app.sh).
#   scripts/bundle.sh validate -t <target> --profile <profile>
#   scripts/bundle.sh deploy -t <target> --profile <profile>
#   scripts/bundle.sh run armor_model -t <target> --profile <profile>
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [[ "${1:-}" == deploy ]]; then
  scripts/build_app.sh
fi
exec databricks bundle "$@"
