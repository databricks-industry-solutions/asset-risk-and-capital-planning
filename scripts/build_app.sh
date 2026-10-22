#!/usr/bin/env bash
# Build the deployable app folder: the React client (app/client/dist) and a copy of the armor package, its data
# contract and its settings (app/src, app/contract, app/config). A deployed app sees only its own folder, so these
# must sit inside it. All four are build outputs (git ignores them; databricks.yml syncs them).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
(cd app/client && (npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null) && npx vite build >/dev/null)
rm -rf app/src app/contract app/config
mkdir -p app/src
rsync -a --exclude __pycache__ src/armor app/src/
cp -R contract config app/
echo "built app/ (client/dist, src/armor, contract, config)"
