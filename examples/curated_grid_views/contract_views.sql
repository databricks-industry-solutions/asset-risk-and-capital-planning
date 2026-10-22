-- =====================================================================================================
-- ILLUSTRATIVE: a curated grid data model -> ARMOR asset data model.
--
-- A worked example of onboarding, written against one particular curated grid data model (dimension and fact tables
-- such as dim_grid_asset, dim_feeder, dim_grid_device, fact_grid_outage). It is not runnable as-is unless you have
-- tables of that shape: read it as a template for your own views. {src} is the source curated schema. Run with:
--     python examples/curated_grid_views/build_views.py --profile <p> --warehouse <id> --src <catalog>.<schema> --dst <schema>
-- Views RENAME and RECODE only. Identifiers are the source's natural keys (*_number).
--
-- Classes left out, and why:
--   substation, transmission_line, transmission_structure: no install dates, and install_date is required.
-- =====================================================================================================

-- asset: every unit ever in service, every distribution class with install dates.
CREATE OR REPLACE VIEW {dst}.asset AS
WITH pos AS (SELECT DISTINCT position_id, position_number FROM {src}.dim_grid_asset)
SELECT
  a.asset_number AS asset_id,
  a.asset_class,
  a.position_number AS position_id,
  a.install_date,
  a.removal_date,
  -- The foundation's removal vocabulary -> the contract's. Non-pole classes only record "end_of_life_replacement"
  -- (no split between in-service failure and a caught condition), so they map to end_of_life.
  CASE WHEN a.removal_reason IS NULL                     THEN NULL
       WHEN a.removal_reason = 'decay_failure'           THEN 'failure'
       WHEN a.removal_reason = 'decay_replacement'       THEN 'condition'
       WHEN a.removal_reason = 'end_of_life_replacement' THEN 'end_of_life'
       WHEN a.removal_reason = 'capital_rebuild'         THEN 'program'
       WHEN a.removal_reason IN ('storm_damage', 'vehicle_damage') THEN 'damage'
       ELSE 'other' END                                                AS removal_reason,
  f.feeder_number AS feeder_id,
  -- dim_grid_asset.upstream_device_id is already the device that opens when the asset fails
  d.device_number AS upstream_device_id,
  a.latitude,
  a.longitude,
  a.end_latitude,
  a.end_longitude,
  p.position_number AS parent_position_id,
  -- poles: wood species (pine/cedar), else the pole material (steel)
  CASE WHEN a.asset_class = 'pole' THEN COALESCE(a.species, a.material) ELSE a.material END AS material,
  a.treatment,
  CAST(NULL AS STRING) AS cohort,   -- the source has no cohort label of its own: cohorts come from the model settings
  CASE WHEN a.asset_class = 'pole'           THEN a.pole_class
       WHEN a.asset_class = 'conductor_span' THEN a.conductor_size
       WHEN a.asset_class = 'transformer'    THEN CAST(CAST(a.kva_rating AS INT) AS STRING) END AS size_class,
  CASE WHEN a.asset_class = 'pole' THEN a.density_class END          AS cost_zone,
  CASE WHEN a.asset_class = 'transformer' THEN a.served_premise_count END AS customers_interrupted_on_failure
FROM {src}.dim_grid_asset a
LEFT JOIN {src}.dim_feeder f      ON f.feeder_id = a.feeder_id
LEFT JOIN {src}.dim_grid_device d ON d.device_id = a.upstream_device_id
LEFT JOIN pos p                   ON p.position_id = a.parent_position_id
WHERE a.asset_class NOT IN ('substation', 'transmission_line', 'transmission_structure');

-- record_window: the source records removals from 1990 for every class.
CREATE OR REPLACE VIEW {dst}.record_window AS
SELECT DISTINCT asset_class, DATE'1990-01-01' AS records_start_date,
       'Source curated grid model: removals recorded from 1990-01-01' AS source
FROM {dst}.asset;

CREATE OR REPLACE VIEW {dst}.device AS
SELECT d.device_number AS device_id, d.device_type, f.feeder_number AS feeder_id, pd.device_number AS parent_device_id,
       d.customers_downstream, d.latitude, d.longitude
FROM {src}.dim_grid_device d
LEFT JOIN {src}.dim_feeder f       ON f.feeder_id = d.feeder_id
LEFT JOIN {src}.dim_grid_device pd ON pd.device_id = d.parent_device_id;

-- inspection: pole inspections. A reject is resolved when its work order completes.
CREATE OR REPLACE VIEW {dst}.inspection AS
SELECT i.inspection_number AS inspection_id, a.asset_number AS asset_id, i.inspection_date, i.method,
       CASE i.outcome WHEN 'pass_with_decay' THEN 'finding' ELSE i.outcome END AS outcome,
       i.remaining_strength_pct,
       CASE WHEN i.outcome IN ('reject', 'priority_reject') AND w.status = 'completed' THEN CAST(w.completed_at AS DATE) END AS resolved_date
FROM {src}.fact_asset_inspection i
JOIN {src}.dim_grid_asset a             ON a.grid_asset_id = i.grid_asset_id
LEFT JOIN {src}.fact_asset_work_order w ON w.work_order_id = i.work_order_id;

CREATE OR REPLACE VIEW {dst}.outage AS
SELECT o.outage_number AS outage_id, d.device_number AS device_id, a.asset_number AS failed_asset_id, o.cause_code,
       o.started_at AS start_ts, o.restored_at AS restore_ts, o.customers_interrupted, o.is_major_event_day AS major_event_day
FROM {src}.fact_grid_outage o
JOIN {src}.dim_grid_device d       ON d.device_id = o.device_id
LEFT JOIN {src}.dim_grid_asset a   ON a.grid_asset_id = o.failed_grid_asset_id;

-- action_cost: the foundation's rate book (every row labelled ASSUMPTION there) in the contract's shape.
-- Emergency replacement = planned x the rate book's corrective_multiplier; the source says so.
CREATE OR REPLACE VIEW {dst}.action_cost AS
WITH u AS (SELECT cost_key, value, source FROM {src}.dim_grid_unit_cost),
     m AS (SELECT value AS mult, source AS msrc FROM u WHERE cost_key = 'corrective_multiplier')
SELECT 'pole' AS asset_class, 'replace' AS action, 'planned' AS cost_basis,
       regexp_extract(cost_key, 'replace_pole_(.*)', 1) AS cost_zone, value AS usd_per_asset, source
FROM u WHERE cost_key LIKE 'replace_pole_%'
UNION ALL
SELECT 'pole', 'replace', 'emergency', regexp_extract(cost_key, 'replace_pole_(.*)', 1), value * m.mult,
       concat(source, ' x corrective_multiplier ', CAST(m.mult AS STRING), ' (', m.msrc, ')')
FROM u CROSS JOIN m WHERE cost_key LIKE 'replace_pole_%'
UNION ALL
SELECT 'pole', 'reinforce', 'planned', CAST(NULL AS STRING), value, source FROM u WHERE cost_key = 'reinforce_frp'
UNION ALL
SELECT 'pole', 'inspect', 'planned', CAST(NULL AS STRING), value, source FROM u WHERE cost_key = 'inspect_groundline';

CREATE OR REPLACE VIEW {dst}.planning_parameter AS
SELECT 'discount_rate' AS parameter, value, 'fraction_per_year' AS unit, source
FROM {src}.dim_grid_unit_cost WHERE cost_key = 'discount_rate'
UNION ALL
SELECT 'customer_minute_value', value, 'USD_per_customer_minute', source
FROM {src}.dim_grid_unit_cost WHERE cost_key = 'voll_usd_per_customer_minute';
