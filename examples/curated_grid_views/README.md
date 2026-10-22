# Illustrative example: views over a curated grid data model

These files show what onboarding a utility to ARMOR looks like: one SQL view per table of ARMOR's asset data model
(`contract/asset_data_model.yml`), renaming and recoding the columns of an existing curated grid data model.

They are **illustrative**. `contract_views.sql` was written against one particular curated model (tables such as
`dim_grid_asset`, `dim_feeder`, `dim_grid_device`, `fact_grid_outage`, `fact_asset_inspection`), so it only runs where
tables of that shape exist. Use it as a template: copy it, point each view at your own tables, and run
`build_views.py` (or the SQL directly) to create the views and check them against the data model.
