# Asset Risk Modeling and Optimized Renewal (ARMOR)

[![Databricks](https://img.shields.io/badge/Databricks-Solution_Accelerator-FF3621?style=for-the-badge&logo=databricks)](https://databricks.com)
[![Unity Catalog](https://img.shields.io/badge/Unity_Catalog-Enabled-00A1C9?style=for-the-badge)](https://docs.databricks.com/en/data-governance/unity-catalog/index.html)
[![Serverless](https://img.shields.io/badge/Serverless-Compute-00C851?style=for-the-badge)](https://docs.databricks.com/en/compute/serverless.html)

Electric distribution utilities set their pole and grid-asset replacement budgets by age and inspection cycle, and
can't say what each capital dollar buys in avoided outages. **ARMOR** (Asset Risk Modeling & Optimized Renewal) gives
every asset a probability of reaching end of life, multiplies it by the customers behind the device that would open,
and plans replacements against the budget:

- **Territory risk:** expected failures, SAIFI and SAIDI contribution and risk $ by asset class and feeder, predicted
  rather than reported.
- **Risk map:** every asset with its probability, consequence and evidence, projected year by year under any plan.
- **Plan:** a 10-year replacement plan from an exact optimizer (MILP) or a rule (oldest first, worst feeders...),
  the budget frontier and its knee, and the work plan.
- **Compare strategies:** seven strategies side by side, with Monte Carlo uncertainty.
- **Curves and backtest:** the fitted life curves and their out-of-sample checks.
- **Ask Genie (optional):** natural-language questions over the same governed tables.

It runs as-is on a **fictional demo utility** generated in your workspace (no data is downloaded), and on your own
data once you map your tables to its asset data model (see [Make it yours](#make-it-yours)).

## Installation

You need a Databricks workspace with Unity Catalog, serverless compute and Databricks Apps; an existing catalog you
can create schemas in; a SQL warehouse; the [Databricks CLI](https://github.com/databricks/cli) and Node.js 20+
(to build the app's web client).

```bash
git clone https://github.com/databricks-industry-solutions/asset-risk-and-capital-planning.git
cd asset-risk-and-capital-planning
(cd app/client && npm ci)

# 1. Deploy the app and jobs. catalog is the only variable you normally set; the schemas are created in it.
scripts/bundle.sh deploy --var catalog=<your_catalog> --profile <your_profile>

# 2. Generate the demo utility and run the model (about 10 minutes on serverless).
databricks bundle run armor_demo --var catalog=<your_catalog> --profile <your_profile>

# 3. Start the app, then open the URL it prints.
databricks bundle run armor --var catalog=<your_catalog> --profile <your_profile>
```

`scripts/bundle.sh deploy` builds the app (web client, model package, data model and settings) before deploying.
Deploy from a local clone with the CLI as above: the workspace **Asset Bundle editor** doesn't run `npm`, so it can't
build the app's web client. Once deployed, the jobs and the app are also in the workspace UI (Jobs & Pipelines, Apps),
where you can run and open them.

Variables (all have defaults, set with `--var name=value`):

| Variable | Default | What it is |
|---|---|---|
| `catalog` | `main` | Existing catalog to deploy into |
| `input_schema` | `<catalog>.armor_demo_input` | The asset data model: the demo data, or views over your own tables |
| `output_schema` | `<catalog>.armor` | Where the model writes and the app reads |
| `warehouse_id` | the warehouse named `Serverless Starter Warehouse` | SQL warehouse the app queries |
| `app_name` | `armor-capital-planner` | The Databricks App |
| `lakebase_instance`, `genie_space_id` | empty (off) | Optional Lakebase lookups and Genie space; see [`targets/README.md`](targets/README.md) |

The `armor_demo` job grants the app's service principal read access to both schemas. If you can't grant on the
catalog, ask its owner to run:
`GRANT USE CATALOG ON CATALOG <catalog> TO <app service principal>;`
`GRANT USE SCHEMA, SELECT ON SCHEMA <catalog>.armor_demo_input TO <app service principal>;`
`GRANT USE SCHEMA, SELECT ON SCHEMA <catalog>.armor TO <app service principal>;`

To remove everything: `databricks bundle destroy --var catalog=<your_catalog>`, then drop the two schemas.

## The demo utility

[`src/armor/demo.py`](src/armor/demo.py) (run by `jobs/generate_demo_data.py`) generates a fictional utility from a
fixed seed, straight into the asset data model:
- **Network:** 24 radial feeders around a made-up center; about 10,000 wood and steel poles; conductor spans;
  pole-top transformers with customers; and a breaker, recloser and fuses per feeder.
- **History:** each position's history from its build year (1925 onward): failures, inspection-caught
  replacements, storm damage and capital rebuilds.
- **Inspections:** a 10-year groundline inspection cycle, with an open reject backlog.
- **Outages:** one outage per in-service failure at the device that opened, plus trees, animal and storm outages.
- **Rate book:** a demo rate book. Every number is labelled ASSUMPTION.

Removal records start in 1990, as in real systems, so the model's correction for units that left service before the
records began has something to correct. The life laws that generated the data are written to `demo_life_law`, so the
fitted curves can be checked against the planted truth: the reference model recovers them within a few percent
(`tests/test_demo.py`). Change the size or shape with the job's `--n_feeders`, `--seed` and `--as_of` parameters.

## Make it yours

ARMOR reads one opinionated data model, [`contract/asset_data_model.yml`](contract/asset_data_model.yml) (rendered as
[`docs/REQUIRED_INPUTS.md`](docs/REQUIRED_INPUTS.md)), and checks its **structure** every run: tables, columns, types,
keys, references, code vocabularies and physical domains. It never fills in missing data. Optional tables switch
features on, and the app's Data model page says which are on and why.

1. **Map your tables with views.** Create a schema and write one view per table, renaming and recoding your
   columns into the data model's shape. You need at least:
   - **`asset`:** every unit ever in service, active and removed, with the reason it left service;
   - **`device`:** your protective devices, with customers downstream;
   - **`record_window`:** when your removal records start.

   Add `inspection`, `outage`, `action_cost`, `planning_parameter` and `class_parameter` to turn on the reject backlog,
   restoration times, dollars, discounting and failure shares. [`examples/curated_grid_views/`](examples/curated_grid_views/)
   is an illustrative example over a curated grid data model; `build_views.py` there creates the views and runs the check.
2. **Point ARMOR at them and run the model** instead of the demo:
   ```bash
   scripts/bundle.sh deploy --var catalog=<catalog> --var input_schema=<catalog>.<your_views_schema>
   databricks bundle run armor_model --var catalog=<catalog> --var input_schema=<catalog>.<your_views_schema>
   ```
   Grant the app's service principal `SELECT` on your views' schema. The job stops before modeling if the data-model
   check fails, and the `contract_report` table says what to fix.
3. **Tune the model** in [`config/reference_model.yml`](config/reference_model.yml): which columns define a cohort, how
   much data a cohort needs before it gets its own curve, and the failure-share window and backtest origins. Every run
   copies its settings into `model_run`.
4. **Bring your own model** if you have one (CNAIM, a vendor health index, an ML model): write `pof_forecast`,
   `new_asset_curve` and `model_run` yourself. The decision engine reads only those tables (data model, section
   `model_outputs`).
5. **Add Lakebase and Genie** for millisecond asset lookups and natural-language questions: copy
   [`targets/example.yml.template`](targets/example.yml.template) to `targets/<name>.yml` and fill it in.

Methods and assumptions: the app's Methods & assumptions page.

## Project layout

```
src/armor/contract.py      the data-model check (structure only) + REQUIRED_INPUTS generator
src/armor/demo.py          the demo utility generator
src/armor/model/           the reference probability model (swappable): left-truncated Weibull life curves, backtest
src/armor/engine/          the decision engine: consequence, value of replacement, optimizer (+ bundling), plan simulation
src/armor/serving.py       optional Lakebase serving of the app's per-asset lookups (tools/setup_serving.py sets it up)
jobs/                      generate_demo_data.py (demo) and run_model.py (check -> model -> serving tables -> backtest)
app/                       the Capital Planner app: FastAPI engine (app.py) + React client (app/client)
config/reference_model.yml the reference model's settings, copied into every model run
databricks.yml, resources/ the bundle: app, armor_demo job, armor_model job
scripts/                   bundle.sh (deploy builds the app first), build_app.sh, cleanup.sh
tests/                     unit tests: python -m pytest tests
```

## Contributing

1. **git clone** this project locally.
2. Use the Databricks CLI to test your changes against a Databricks workspace of your choice:
   `python -m pytest tests`, then deploy and run `armor_demo` as above (browser walkthrough: `node app/tests/smoke.mjs <app-url>`).
3. Contribute with pull requests (PRs), and always get a second-party review from a capable teammate.

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## Project support

Please note the code in this project is provided for your exploration only, and is not formally supported by
Databricks with Service Level Agreements (SLAs). It is provided AS-IS and we do not make any guarantees of any kind.
Please do not submit a support ticket relating to any issues arising from the use of this project. Any issues
discovered through the use of this project should be filed as GitHub Issues on the repo. They will be reviewed as
time permits, but there are no formal SLAs for support.

## 📄 Third-Party Package Licenses

&copy; 2026 Databricks, Inc. All rights reserved. The source in this project is provided subject to the Databricks
License [https://databricks.com/db-license-source]. All included or referenced third party libraries are subject to
the licenses set forth below. Full notices: [NOTICE.md](NOTICE.md).

Shipped in the app's web client (`app/client`):

| Package | License | Copyright |
|---------|---------|-----------|
| @databricks/appkit-ui | Apache-2.0 | Copyright (2022) Databricks, Inc. |
| @deck.gl/core, @deck.gl/layers, @deck.gl/mapbox, @deck.gl/react | MIT | Copyright Vis.gl contributors |
| lucide-react | ISC | Copyright (c) 2026 Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis |
| maplibre-gl | BSD-3-Clause | Copyright (c) 2023, MapLibre contributors; Copyright (c) 2020, Mapbox; Copyright (C) 2011 by Evan Wallace; Copyright 2010-2016 Mike Bostock |
| react, react-dom | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| react-map-gl | MIT | Copyright (c) Vis.gl contributors |
| react-router | MIT | Copyright (c) React Training LLC 2015-2019; Remix Software Inc. 2020-2021; Shopify Inc. 2022-2023 |
| recharts | MIT | Copyright (c) 2015-2023 Recharts Group |
| tw-animate-css | MIT | Copyright (c) 2025 Wombosvideo |

Installed at deploy time by the app (`app/requirements.txt`) and the jobs (`resources/*.job.yml`), not bundled:

| Package | License | Copyright |
|---------|---------|-----------|
| databricks-sdk | Apache-2.0 | Copyright 2023 Databricks, Inc. All rights reserved. |
| fastapi | MIT | Sebastián Ramírez |
| uvicorn | BSD-3-Clause | Tom Christie |
| numpy | BSD-3-Clause | NumPy Developers |
| pandas | BSD-3-Clause | AQR Capital Management, LLC; Lambda Foundry, Inc.; PyData Development Team; and open-source contributors |
| scipy | BSD-3-Clause | Copyright (c) 2001-2002 Enthought, Inc.; 2003, SciPy Developers |
| pyarrow | Apache-2.0 | Apache Arrow Developers |
| pyyaml | MIT | Copyright (c) 2017-2019 Ingy döt Net; Copyright (c) 2006-2016 Kirill Simonov |
| psycopg[binary] (optional Lakebase lookups) | LGPL-3.0 | Copyright (C) 2020 The Psycopg Team |
