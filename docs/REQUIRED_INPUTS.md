# Required inputs

Generated from `contract/asset_data_model.yml` by `python -m armor.contract --doc`. Do not edit.

ARMOR checks structure only: tables, columns, types, not-null, keys, references, code vocabularies and physical
domains. It never checks whether your numbers look realistic, and it never fills in a missing input.

## Your data

### `asset` (required)

**Grain:** One row per physical asset UNIT ever in service: active units AND removed units. When a unit is replaced, the old unit keeps its row (with removal_date/removal_reason) and the new unit gets a new row at the same position_id.

**Why:** Life curves are learned from units that ended their life (removed) as much as from units still standing. ARMOR plans only on active units (removal_date IS NULL).

**Primary key:** `asset_id`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_id` | string |  | yes | Unique id of this physical unit. |
| `asset_class` | string |  | yes | What kind of asset (pole, conductor_span, transformer, fuse, recloser, ...). Your own vocabulary; every class must have a record_window row. |
| `position_id` | string |  | yes | The location the unit occupies. All units that replaced each other share it. If you don't track replacements, use asset_id. |
| `install_date` | date |  | yes | Date the unit went into service. |
| `removal_date` | date |  | no | Date the unit left service. NULL = in service today. |
| `removal_reason` | string |  | when removal_date IS NOT NULL | Why it left service. (codes: `failure`, `condition`, `end_of_life`, `program`, `damage`, `other`) |
| `feeder_id` | string |  | yes | Distribution circuit the unit is on. |
| `upstream_device_id` | string |  | yes | The protective device that opens when THIS asset fails (for a device asset, the device above it). (references `device.device_id`) |
| `latitude` | double | degrees | yes | (domain [-90, 90]) |
| `longitude` | double | degrees | yes | (domain [-180, 180]) |
| `end_latitude` | double | degrees | no | Linear assets (conductor spans, cables): the far end. The map draws the asset as a line from (latitude, longitude). NULL for point assets. (domain [-90, 90]) |
| `end_longitude` | double | degrees | no | (domain [-180, 180]) |
| `parent_position_id` | string |  | no | The position the circuit comes from (e.g. the upstream pole). Lets the map draw the network as lines between structures. NULL at a feeder head or if you don't track it. |
| `cohort` | string |  | no | Your own cohort label for this unit (any grouping you plan by: manufacturer, vintage program, spec). When given, the life curves are fitted per this label and the material/treatment/size_class columns are not used to group. NULL = build cohorts from the columns listed in the model settings. |
| `material` | string |  | no | Cohort attribute (e.g. pine, cedar, steel; conductor material). NULL if unknown. |
| `treatment` | string |  | no | Cohort attribute (e.g. creosote, penta, CCA). NULL if unknown. |
| `size_class` | string |  | no | Cohort attribute (e.g. pole class 1-5, kVA band, conductor size). |
| `cost_zone` | string |  | no | Which cost row applies (e.g. urban/suburban/rural). Matches action_cost.cost_zone. NULL = the class-wide cost. |
| `customers_interrupted_on_failure` | long | customers | no | Override for customers who lose power when this asset fails, if not all customers below upstream_device_id (e.g. a transformer serving 8 premises under a fuse serving 200). NULL = use the upstream device's customers_downstream. (domain [0, None]) |

### `record_window` (required)

**Grain:** One row per asset_class.

**Why:** Removal records rarely go back to the first installs. A unit installed in 1950 that failed in 1975, before your records began, is simply missing. ARMOR corrects for that (left truncation) only if it knows when the record starts. Without it, old cohorts look stronger than they were.

**Primary key:** `asset_class`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_class` | string |  | yes |  |
| `records_start_date` | date |  | yes | First date from which removals of this class are completely recorded. |
| `source` | string |  | yes | How you know (system go-live date, data migration note, ...). |

### `device` (required)

**Grain:** One row per protective / sectionalizing device (breaker, recloser, fuse, switch).

**Why:** Consequence: who loses power when an asset fails.

**Primary key:** `device_id`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `device_id` | string |  | yes |  |
| `device_type` | string |  | yes | breaker / recloser / fuse / switch / ... (your vocabulary). |
| `feeder_id` | string |  | yes |  |
| `parent_device_id` | string |  | no | Next device upstream. NULL at the feeder head. (references `device.device_id`) |
| `customers_downstream` | long | customers | yes | Customers interrupted when this device opens (all customers below it, cumulative). (domain [0, None]) |
| `latitude` | double | degrees | no | (domain [-90, 90]) |
| `longitude` | double | degrees | no | (domain [-180, 180]) |

### `inspection` (optional)

**Grain:** One row per inspection of one unit.

**Enables:** The reject backlog: unresolved reject / priority_reject findings, funded first (by their deadlines) when the plan's 'Clear the reject backlog first' setting is on. (Using test results to adjust an individual asset's probability is a future step.)

**Primary key:** `inspection_id`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `inspection_id` | string |  | yes |  |
| `asset_id` | string |  | yes | (references `asset.asset_id`) |
| `inspection_date` | date |  | yes |  |
| `method` | string |  | yes | Your inspection method (visual, groundline_bore, resistograph, drone, ...). |
| `outcome` | string |  | yes | (codes: `pass`, `finding`, `reject`, `priority_reject`) |
| `remaining_strength_pct` | double | percent_of_new | no | Measured remaining strength as % of a new unit's design strength. NULL when the method doesn't measure it. (domain [0, 100]) |
| `resolved_date` | date |  | no | For reject / priority_reject: date the finding was resolved (asset replaced or restored). NULL = still open. |

### `outage` (optional)

**Grain:** One row per sustained interruption event.

**Enables:** Restoration time per failure (customer-minutes at risk). Without it the plan values only customers interrupted and costs.

**Primary key:** `outage_id`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `outage_id` | string |  | yes |  |
| `device_id` | string |  | yes | Device that opened. (references `device.device_id`) |
| `failed_asset_id` | string |  | no | The asset whose failure caused it, when known. (references `asset.asset_id`) |
| `cause_code` | string |  | yes | Your cause vocabulary (kept for display). |
| `start_ts` | timestamp |  | yes |  |
| `restore_ts` | timestamp |  | yes | Last customer restored. |
| `customers_interrupted` | long | customers | yes | (domain [0, None]) |
| `major_event_day` | boolean |  | yes | IEEE 1366 major event day. MED events are excluded from blue-sky restoration times. |

### `action_cost` (optional)

**Grain:** One row per asset_class x action x cost_basis x cost_zone.

**Enables:** Dollars: risk in USD, budgets, the optimizer, and program comparison. Without it ARMOR shows probabilities and customers only.

**Primary key:** `asset_class, action, cost_basis, cost_zone`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_class` | string |  | yes |  |
| `action` | string |  | yes | (codes: `replace`, `reinforce`, `inspect`) |
| `cost_basis` | string |  | yes | (codes: `planned`, `emergency`) |
| `cost_zone` | string |  | no | NULL = applies to every zone of the class. |
| `usd_per_asset` | double | USD | yes | (domain [0, None]) |
| `source` | string |  | yes | Where the number comes from (rate book, work-order average 2019-2023, ...). |

### `planning_parameter` (optional)

**Grain:** One row per parameter.

**Enables:** Discounting and the value of customer-minutes. Without a customer_minute_value, reliability benefit is reported in customer-minutes, not dollars.

**Primary key:** `parameter`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `parameter` | string |  | yes | (codes: `discount_rate`, `customer_minute_value`) |
| `value` | double |  | yes | In the unit the parameter code declares. |
| `unit` | string |  | yes | Must equal the declared unit (a guard against a percent passed as a fraction). |
| `source` | string |  | yes |  |

### `class_parameter` (optional)

**Grain:** One row per asset_class x parameter.

**Enables:** Per-class facts the removal records can't provide. failure_share lets classes whose removals only say end_of_life show in-service failures, SAIFI, SAIDI and risk $. The planned-outage minutes value the interruption a planned replacement causes (value of replacing = unplanned - planned customer-minutes). mobilization_usd and the setup minutes are shared by the units of one visit, so the plan can bundle nearby work; assets_per_visit caps a visit.

**Primary key:** `asset_class, parameter`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_class` | string |  | yes |  |
| `parameter` | string |  | yes | (codes: `failure_share`, `planned_outage_setup_minutes`, `planned_outage_minutes_per_asset`, `mobilization_usd`, `assets_per_visit`) |
| `value` | double |  | yes |  |
| `unit` | string |  | yes | Must equal the declared unit. |
| `source` | string |  | yes |  |

### `capital_history` (optional)

**Grain:** One row per year x asset_class.

**Enables:** Actual capital spend in the historical replacement activity view. Without it, history is shown as replacement volumes, and dollars are an estimate at today's planned cost.

**Primary key:** `year, asset_class`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `year` | int |  | yes |  |
| `asset_class` | string |  | yes |  |
| `capex_usd` | double | USD | yes | Replacement capital actually spent that year (nominal). (domain [0, None]) |
| `source` | string |  | yes |  |

## Probability model outputs (written by the reference model, or by yours)

### `pof_forecast` (required)

**Grain:** One row per ACTIVE asset x forecast year, year_offset 1..horizon.

**Primary key:** `asset_id, year_offset`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_id` | string |  | yes | (references `asset.asset_id`) |
| `year_offset` | int |  | yes | 1 = the first year after as_of_date. |
| `p_end_of_life` | double | probability | yes | P(the asset reaches end of life in this year | it is still in service at the start of the year and nothing is done to it). (domain [0, 1]) |
| `p_failure_given_eol` | double | probability | no | Share of those end-of-life events that happen as an in-service failure (the rest are caught and replaced planned). NULL = the data can't tell. (domain [0, 1]) |
| `model_id` | string |  | yes | (references `model_run.model_id`) |

### `new_asset_curve` (required)

**Grain:** One row per asset_class x age year, for a unit built to today's standard (what a replacement becomes).

**Primary key:** `asset_class, age_year`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `asset_class` | string |  | yes |  |
| `age_year` | int |  | yes | 0 = first year in service. |
| `p_end_of_life` | double | probability | yes | (domain [0, 1]) |
| `p_failure_given_eol` | double | probability | no | (domain [0, 1]) |
| `model_id` | string |  | yes | (references `model_run.model_id`) |

### `model_run` (required)

**Grain:** One row per model run.

**Primary key:** `model_id`

| column | type | unit | required | meaning |
|---|---|---|---|---|
| `model_id` | string |  | yes |  |
| `as_of_date` | date |  | yes | Forecast origin: year_offset 1 is the year after this date. |
| `method` | string |  | yes | Human-readable description of the method. |
| `created_at` | timestamp |  | yes |  |
| `details_json` | string |  | yes | Everything a reviewer needs to reproduce the model (fitted parameters, cohorts, settings). |

## Code vocabularies

### `removal_reason`

| code | meaning |
|---|---|
| `failure` | Removed after it FAILED IN SERVICE on its own (deterioration, end of life). Unplanned. |
| `condition` | Removed on a PLANNED basis because inspection or testing found it at end of life (e.g. a pole reject). |
| `end_of_life` | Removed at end of life, but your records don't say whether it failed first or was caught. Use only when you can't tell failure from condition. |
| `program` | Removed by a capital program for reasons other than its own condition (feeder rebuild, voltage conversion, undergrounding, relocation). |
| `damage` | Removed after external damage: storm, vehicle, fire, third party. Not deterioration. |
| `other` | Any other removal. Treated like program/damage: the asset's life was cut short, it didn't end. |

### `inspection_outcome`

| code | meaning |
|---|---|
| `pass` | No actionable finding. |
| `finding` | A finding that doesn't require removal (e.g. pass with decay, treat). |
| `reject` | Must be replaced or restored; planned timeframe. |
| `priority_reject` | Must be addressed urgently (safety / imminent failure). ARMOR treats these as must-address. |

### `action`

| code | meaning |
|---|---|
| `replace` | Remove the asset and install a new one to the current standard. |
| `reinforce` | Restore strength without replacing (e.g. pole truss / FRP wrap). |
| `inspect` | A condition inspection (used for inspection program costs). |

### `cost_basis`

| code | meaning |
|---|---|
| `planned` | Cost when the work is scheduled. |
| `emergency` | Cost when the work follows an in-service failure (overtime, callout, expedited). |

### `class_parameter`

| code | meaning |
|---|---|
| `failure_share` | Share of end-of-life events of this class that happen as in-service failures (the rest are caught and replaced planned). Supply it when your removal records only say end_of_life, e.g. from outage cause codes; state the source. (unit fraction) |
| `planned_outage_setup_minutes` | Customer interruption per planned replacement job, however many units the job does: switching, isolating, grounding and restoring. The customers are those behind the asset's upstream protective device. 0 where the work is done energized (live-line or bypass). (unit minutes) |
| `planned_outage_minutes_per_asset` | Additional customer interruption for each unit replaced in a planned job. 0 where the work is done energized. (unit minutes) |
| `mobilization_usd` | Fixed cost of one crew visit (travel, setup, traffic control), paid once per visit however many units it replaces. Only supply it when action_cost planned is the per-unit cost WITHOUT mobilization; if your unit cost is all-in, leave it out. (unit USD) |
| `assets_per_visit` | Most units one crew visit can replace (crew-day capacity). A bundle larger than this takes more visits, each with its own mobilization and setup outage. Absent = no limit per visit. (unit assets) |

### `planning_parameter`

| code | meaning |
|---|---|
| `discount_rate` | Real or nominal rate used to discount future costs and benefits to today. (unit fraction_per_year) |
| `customer_minute_value` | What one customer-minute of interruption is worth in the plan (e.g. from the DOE ICE calculator or your regulator). (unit USD_per_customer_minute) |
