"""Demo data: a fictional distribution utility, written straight into ARMOR's asset data model.

It exists so the accelerator runs as-is: deploy, run the demo job, open the app. It is not a model of any real
utility. Everything is synthetic (numpy draws from a fixed seed): the network is generated around a made-up center,
not real streets, and no data is downloaded.

What it generates, per feeder:
  - a radial network on a fictional street grid, each feeder in its own rectangle of streets: a trunk of poles along
    the middle avenue from a substation, laterals along the cross streets, conductor spans between poles, pole-top transformers with customers, a breaker at the head, a mid-trunk recloser and a fuse per lateral;
  - each position's history from its build year to the as-of date: the unit installed there, how it left service
    (in-service failure, caught by inspection and replaced, damage, a capital program) and the unit that replaced it;
  - a 10-year groundline inspection cycle for wood poles, finding decay before failure some of the time and leaving a
    realistic open reject backlog;
  - outages: one per in-service failure at the protective device above the failed asset, plus background outages
    (trees, animals, unknown) and major event days;
  - a demo rate book and planning parameters.

Removal records start on records_start (default 1990-01-01): units that left service before it are not in the
asset table, as in real systems, so the reference model's left-truncation correction has something to correct.

The life laws (planted truth) are in LIFE_LAW and are written to the demo_life_law table, so the fitted curves can be
compared with what generated the data. The fitted median comes out somewhat below the planted one for wood poles,
because inspection catches some units before the life law would have ended them, and ARMOR counts a caught
unit's removal as its end of life.

Sources for the parameters that come from literature (the rest are labelled ASSUMPTION):
  - creosote pine median 78 years: Lebow et al. (2015), Fifty-Year Durability Evaluation of Posts Treated with
    Industrial Wood Preservatives, Forest Products Journal 65(7/8), USDA FPL;
  - cedar life 1.25x pine: utility asset-life practice (useful life cedar 50 / pine 40 years);
  - groundline inspection on a 10-year cycle for poles 20 years and older: common utility pole inspection practice.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

YEAR = 365.25

# asset_class -> cohort ("material|treatment") -> (median life in years, Weibull shape, source)
LIFE_LAW: dict[str, dict[str, tuple[float, float, str]]] = {
    "pole": {
        "pine|creosote": (78.0, 3.5, "Lebow et al. 2015 (USDA FPL): creosote pine posts, 50% failed at 78 years"),
        "pine|penta": (90.0, 3.5, "ASSUMPTION: penta outlasts creosote (Lebow 2015 saw no penta failures in 50 years)"),
        "pine|CCA": (95.0, 3.5, "ASSUMPTION: CCA outlasts creosote (Lebow 2015 saw no CCA failures in 50 years)"),
        "cedar|creosote": (97.5, 3.5, "ASSUMPTION: cedar life 1.25x pine (useful life cedar 50 / pine 40 years)"),
        "steel|galvanized": (120.0, 4.0, "ASSUMPTION: galvanized steel poles"),
    },
    "conductor_span": {"copper|bare": (85.0, 3.0, "ASSUMPTION"), "aluminum|bare": (80.0, 3.0, "ASSUMPTION")},
    "transformer": {"mineral_oil|pole_top": (45.0, 2.2, "ASSUMPTION")},
    "fuse": {"cutout|expulsion": (40.0, 2.0, "ASSUMPTION")},
    "recloser": {"electronic|vacuum": (28.0, 2.0, "ASSUMPTION")},
}
# share of a non-pole class's end-of-life events that happen as in-service failures (the rest are replaced on a
# planned basis). The removal records of those classes only say end_of_life; this is supplied as class_parameter.
FAILURE_SHARE = {"conductor_span": 0.15, "transformer": 0.5, "fuse": 0.2, "recloser": 0.3}
DAMAGE_RATE = 0.0012          # per unit-year: storm, vehicle, third party
POLE_COST = {"urban": 14500.0, "suburban": 12000.0, "rural": 9500.0}   # planned replacement, USD per pole
EMERGENCY_MULTIPLIER = 2.4


@dataclass
class DemoSettings:
    seed: int = 7
    n_feeders: int = 24
    poles_per_feeder: int = 420
    as_of: str = "2026-01-01"
    records_start: str = "1990-01-01"
    first_build_year: int = 1925
    center_lat: float = 38.47         # a made-up territory center on open farmland; any lat/lon works
    center_lon: float = -101.25
    inspection_start_year: int = 2000
    inspection_cycle_years: int = 10
    rebuild_feeder_share: float = 0.3  # feeders with one capital rebuild of part of the feeder since records_start


def _cohort(cls: str, year: float, rng) -> str:
    if cls == "pole":
        if year < 1950:
            opts, p = ["pine|creosote", "cedar|creosote"], [0.6, 0.4]
        elif year < 1980:
            opts, p = ["pine|creosote", "pine|penta", "cedar|creosote"], [0.4, 0.5, 0.1]
        elif year < 2005:
            opts, p = ["pine|penta", "pine|CCA", "steel|galvanized"], [0.5, 0.45, 0.05]
        else:
            opts, p = ["pine|CCA", "pine|penta", "steel|galvanized"], [0.6, 0.25, 0.15]
        return opts[rng.choice(len(opts), p=p)]
    if cls == "conductor_span":
        return "copper|bare" if year < 1965 and rng.random() < 0.7 else "aluminum|bare"
    return next(iter(LIFE_LAW[cls]))


def _life(cls: str, cohort: str, rng) -> float:
    med, k, _ = LIFE_LAW[cls][cohort]
    scale = med / math.log(2) ** (1 / k)
    return float(scale * rng.weibull(k))


def _dt(year: float) -> pd.Timestamp:
    """Decimal year -> date."""
    y = int(math.floor(year))
    return pd.Timestamp(y, 1, 1) + pd.Timedelta(days=int((year - y) * YEAR))


def _year(ts) -> float:
    ts = pd.Timestamp(ts)
    return ts.year + (ts.dayofyear - 1) / YEAR


# ------------------------------------------------------------------------------------------------- network
BLOCK_M = 150.0      # street spacing of the town grid
POLE_M = 50.0        # pole spacing along a street (3 spans per block)
HALF_BLOCKS = 6      # a feeder's laterals run up to this many blocks either side of its trunk


def _network(S: DemoSettings, rng):
    """Positions (structures), devices and transformers of every feeder, laid out on a fictional street grid.

    The territory is a grid of streets. Each feeder serves its own rectangle of it, so feeders never overlap: the trunk
    runs along the rectangle's middle avenue away from a substation shared with the neighbouring feeder, and laterals
    run along the cross streets, up and down from the trunk. Poles stand every POLE_M along the streets, so spans
    follow the streets."""
    deg_lat = 1 / 111_320.0
    deg_lon = 1 / (111_320.0 * math.cos(math.radians(S.center_lat)))
    width = max(6, round(S.poles_per_feeder / 20))     # blocks along the trunk (about 20 poles per block of trunk + laterals)
    per_block = int(round(BLOCK_M / POLE_M))
    cols = 2 * max(1, round(math.sqrt(S.n_feeders * 2 * HALF_BLOCKS / width) / 2))   # a squarish territory; feeders pair up on a substation
    rows = math.ceil(S.n_feeders / cols)
    x0 = -cols * width * BLOCK_M / 2
    y0 = -rows * 2 * HALF_BLOCKS * BLOCK_M / 2
    span = (cols * width * BLOCK_M / 2) ** 2 + (rows * 2 * HALF_BLOCKS * BLOCK_M / 2) ** 2

    def ll(x, y):
        return S.center_lat + (y + rng.normal(0, 2.0)) * deg_lat, S.center_lon + (x + rng.normal(0, 2.0)) * deg_lon

    pos, dev, xf = [], [], []
    for f in range(S.n_feeders):
        fid = f"F{f + 1:03d}"
        c, r = f % cols, f // cols
        west = c % 2 == 0                      # the left feeder of a pair runs west from the shared substation
        sx = x0 + (c + (1 if west else 0)) * width * BLOCK_M
        ty = y0 + (2 * r + 1) * HALF_BLOCKS * BLOCK_M
        d = -1 if west else 1
        dist0 = math.sqrt(((sx + d * width * BLOCK_M / 2) ** 2 + ty ** 2) / span)
        base_year = S.first_build_year + 40 * min(1.0, dist0) + rng.uniform(0, 10)
        slat, slon = ll(sx, ty)
        bkr, recs = f"{fid}-BKR", [f"{fid}-REC1", f"{fid}-REC2"]
        dev.append({"device_id": bkr, "device_type": "breaker", "feeder_id": fid, "parent_device_id": None, "lat": slat, "lon": slon})
        n_trunk = width * per_block
        cut = [n_trunk // 3, 2 * n_trunk // 3]   # the trunk is sectionalized by two reclosers, at a third and two thirds
        trunk, prev = {}, None
        for i in range(1, n_trunk + 1):
            lat, lon = ll(sx + d * i * POLE_M, ty)
            pid = f"{fid}-T{i:04d}"
            prot = bkr if i <= cut[0] else recs[0] if i <= cut[1] else recs[1]
            if i - 1 in cut:
                k_rec = cut.index(i - 1)
                dev.append({"device_id": recs[k_rec], "device_type": "recloser", "feeder_id": fid,
                            "parent_device_id": bkr if k_rec == 0 else recs[0], "lat": lat, "lon": lon, "position_id": pid})
            pos.append({"position_id": pid, "feeder_id": fid, "parent_position_id": prev, "lat": lat, "lon": lon,
                        "device_id": prot, "build_year": base_year, "trunk": True})
            trunk[i] = (pid, lat, lon, prot)
            prev = pid
        # Laterals: up and down every other cross street the trunk passes, each behind its own fuse, with taps along
        # the side streets they cross (to the neighbouring cross streets, which have no lateral of their own).
        xmin, xmax = sorted((sx, sx + d * width * BLOCK_M))
        k = 0
        for blk in range(1 + int(rng.integers(0, 2)), width + 1, 2):
            tap = trunk[blk * per_block]
            for side in (1, -1):
                if rng.random() < 0.15:            # not every street is built out on both sides
                    continue
                n_lat = int(rng.integers(2 * per_block, HALF_BLOCKS * per_block + 1))
                k += 1
                fuse = f"{fid}-FU{k:03d}"
                dev.append({"device_id": fuse, "device_type": "fuse", "feeder_id": fid, "parent_device_id": tap[3],
                            "lat": tap[1], "lon": tap[2], "position_id": tap[0]})
                lat_year = base_year + rng.uniform(0, 25)
                lx = sx + d * blk * BLOCK_M
                prev = tap[0]
                for j in range(1, n_lat + 1):
                    ly = ty + side * j * POLE_M
                    lat, lon = ll(lx, ly)
                    pid = f"{fid}-L{k:03d}-{j:03d}"
                    pos.append({"position_id": pid, "feeder_id": fid, "parent_position_id": prev, "lat": lat, "lon": lon,
                                "device_id": fuse, "build_year": lat_year, "trunk": False})
                    prev = pid
                    if j % per_block == 0 and j < n_lat:          # a side street: tap off along it
                        for hdir in (1, -1):
                            if rng.random() > 0.45:
                                continue
                            n_tap = int(rng.integers(1, 2 * per_block))
                            tp = pid
                            for m in range(1, n_tap + 1):
                                tx = lx + hdir * m * POLE_M
                                if not (xmin < tx < xmax):
                                    break
                                tlat, tlon = ll(tx, ly)
                                tid = f"{pid}-B{'E' if hdir > 0 else 'W'}{m:02d}"
                                pos.append({"position_id": tid, "feeder_id": fid, "parent_position_id": tp, "lat": tlat,
                                            "lon": tlon, "device_id": fuse, "build_year": lat_year + rng.uniform(0, 10), "trunk": False})
                                tp = tid
    P = pd.DataFrame(pos)
    P["build_year"] = P["build_year"].clip(upper=_year(S.as_of) - 3)
    dist = np.hypot((P["lat"] - S.center_lat) / deg_lat, (P["lon"] - S.center_lon) / deg_lon) / math.sqrt(span)
    P["cost_zone"] = np.where(dist < 0.35, "urban", np.where(dist < 0.7, "suburban", "rural"))
    # pole-top transformers on about a third of the poles; customers by density
    has = rng.random(len(P)) < 0.35
    per = {"urban": (6, 16), "suburban": (3, 10), "rural": (1, 4)}
    for r in P[has].itertuples():
        lo, hi = per[r.cost_zone]
        xf.append({"position_id": r.position_id, "device_id": r.device_id, "customers": int(rng.integers(lo, hi + 1))})
    D = pd.DataFrame(dev)
    X = pd.DataFrame(xf)
    # customers below each device: its own zone plus every device below it
    own = X.groupby("device_id")["customers"].sum()
    children = D.groupby("parent_device_id")["device_id"].apply(list).to_dict()

    def total(d):
        return int(own.get(d, 0)) + sum(total(c) for c in children.get(d, []))
    D["customers_downstream"] = [total(d) for d in D["device_id"]]
    return P, D, X


# ------------------------------------------------------------------------------------------------- history
def _history(cls, position_id, start_year, S, rng, inspect_years, out_assets, out_insp, out_events, base):
    """Units at one position from start_year to as_of, with inspections (poles) and their end-of-life events."""
    as_of, rec0 = _year(S.as_of), _year(S.records_start)
    t, gen = start_year, 0
    while t < as_of:
        gen += 1
        coh = _cohort(cls, t, rng)
        life = _life(cls, coh, rng)
        eol = t + life
        dmg = t + rng.exponential(1 / DAMAGE_RATE)
        prog = base.get("rebuild_year") if base.get("rebuild_year") and base["rebuild_year"] > t else math.inf
        end, reason = eol, None
        insp_rows = []
        if cls == "pole" and coh.split("|")[0] in ("pine", "cedar"):
            # groundline inspections on the feeder's cycle, once the pole is 20 years old
            for y in inspect_years:
                if y <= t + 20 or y >= min(eol, dmg, prog, as_of):
                    continue
                left = eol - y
                if left < 10 and rng.random() < 0.9:
                    out = "priority_reject" if left < 2 and rng.random() < 0.4 else "reject"
                elif left < 14 and rng.random() < 0.6:
                    out = "finding"
                else:
                    out = "pass"
                strength = float(np.clip(100 * (max(left, 0) / life) ** 0.5 + rng.normal(0, 4), 5, 100))
                insp_rows.append([y, out, strength])
                if out in ("reject", "priority_reject"):
                    fix = y + (rng.uniform(0.1, 0.6) if out == "priority_reject" else rng.uniform(0.5, 3.0))
                    if fix < eol:
                        end, reason = fix, "condition"
                    break
        if reason is None:
            reason = "failure" if cls == "pole" else "end_of_life"
        cands = [(end, reason), (dmg, "damage"), (prog, "program")]
        end, reason = min(cands, key=lambda c: c[0])
        removed = end < as_of
        uid = f"{position_id}-U{gen}"
        if not removed or end >= rec0:      # left truncation: removals before the records start are not on file
            mat, trt = coh.split("|")
            out_assets.append({**base["row"], "asset_id": uid, "asset_class": cls, "position_id": position_id,
                               "install_date": _dt(t), "removal_date": _dt(end) if removed else None,
                               "removal_reason": reason if removed else None, "material": mat, "treatment": trt})
            for k, (y, o, s) in enumerate(insp_rows):
                if y >= as_of:
                    continue
                resolved = _dt(end) if (o in ("reject", "priority_reject") and removed) else None
                out_insp.append({"inspection_id": f"{uid}-I{k + 1}", "asset_id": uid, "inspection_date": _dt(y),
                                 "method": "groundline_bore", "outcome": o, "remaining_strength_pct": round(s, 1),
                                 "resolved_date": resolved})
            if removed and end >= rec0:
                out_events.append({"asset_id": uid, "asset_class": cls, "year": end, "reason": reason})
        t = end


def generate(S: DemoSettings | None = None) -> dict[str, pd.DataFrame]:
    """All the demo tables, as pandas DataFrames keyed by table name (the asset data model plus demo_life_law)."""
    S = S or DemoSettings()
    rng = np.random.default_rng(S.seed)
    P, D, X = _network(S, rng)
    as_of = _year(S.as_of)
    feeders = sorted(P["feeder_id"].unique())
    # a rolling cycle: each pole position comes up once every inspection_cycle_years, a tenth of the fleet each year
    def insp_years(_feeder):
        first = S.inspection_start_year + int(rng.integers(0, S.inspection_cycle_years))
        return [y + float(rng.uniform(0.05, 0.95)) for y in range(first, int(as_of) + 1, S.inspection_cycle_years)]
    rebuild = {}
    for f in feeders:
        if rng.random() < S.rebuild_feeder_share:
            rebuild[f] = rng.uniform(_year(S.records_start) + 2, as_of - 1)
    rebuilt_laterals = {f: set(rng.choice(sorted({p.split("-")[1] for p in P.loc[(P.feeder_id == f) & ~P.trunk, "position_id"]}), size=3, replace=False))
                        for f in rebuild}
    assets, insp, events = [], [], []
    xf_by_pos = X.set_index("position_id")
    for p in P.itertuples():
        lateral = p.position_id.split("-")[1]
        rb = rebuild.get(p.feeder_id) if lateral in rebuilt_laterals.get(p.feeder_id, ()) else None
        common = {"feeder_id": p.feeder_id, "upstream_device_id": p.device_id, "latitude": p.lat, "longitude": p.lon,
                  "end_latitude": None, "end_longitude": None, "parent_position_id": p.parent_position_id,
                  "cost_zone": p.cost_zone, "size_class": None, "customers_interrupted_on_failure": None, "cohort": None}
        _history("pole", p.position_id, p.build_year, S, rng, insp_years(p.feeder_id), assets, insp, events,
                 {"rebuild_year": rb, "row": {**common, "size_class": str(int(rng.choice([2, 3, 4, 5], p=[0.1, 0.3, 0.4, 0.2])))}})
        if p.position_id in xf_by_pos.index:
            c = int(xf_by_pos.loc[p.position_id, "customers"])
            _history("transformer", f"{p.position_id}-X", p.build_year, S, rng, [], assets, insp, events,
                     {"rebuild_year": rb, "row": {**common, "size_class": str(int(rng.choice([25, 50, 75]))),
                                                  "customers_interrupted_on_failure": c, "parent_position_id": p.position_id}})
    # conductor spans: a line from the parent pole to this pole
    loc = P.set_index("position_id")[["lat", "lon"]]
    for p in P[P.parent_position_id.notna()].itertuples():
        a = loc.loc[p.parent_position_id]
        _history("conductor_span", f"{p.position_id}-S", p.build_year, S, rng, [], assets, insp, events,
                 {"rebuild_year": None, "row": {"feeder_id": p.feeder_id, "upstream_device_id": p.device_id,
                                                "latitude": float(a.lat), "longitude": float(a.lon), "end_latitude": p.lat,
                                                "end_longitude": p.lon, "parent_position_id": p.parent_position_id,
                                                "cost_zone": p.cost_zone, "size_class": None,
                                                "customers_interrupted_on_failure": None, "cohort": None}})
    # protective devices (fuses, reclosers) are assets too: when one fails, the device above it opens
    dev_build = P.groupby("feeder_id")["build_year"].min()
    for d in D[D.device_type.isin(["fuse", "recloser"])].itertuples():
        cls = d.device_type
        _history(cls, f"{d.device_id}-D", float(dev_build[d.feeder_id]) + 5, S, rng, [], assets, insp, events,
                 {"rebuild_year": None, "row": {"feeder_id": d.feeder_id, "upstream_device_id": d.parent_device_id,
                                                "latitude": d.lat, "longitude": d.lon, "end_latitude": None, "end_longitude": None,
                                                "parent_position_id": d.position_id, "cost_zone": None, "size_class": None,
                                                "customers_interrupted_on_failure": None, "cohort": None}})

    A = pd.DataFrame(assets)
    A["material"] = A["material"].astype("string")
    A["customers_interrupted_on_failure"] = A["customers_interrupted_on_failure"].astype("Int64")
    I = pd.DataFrame(insp)
    dev = D.rename(columns={"lat": "latitude", "lon": "longitude"})[["device_id", "device_type", "feeder_id", "parent_device_id", "customers_downstream", "latitude", "longitude"]]
    O = _outages(S, rng, A, dev, pd.DataFrame(events))
    tables = {
        "asset": A[["asset_id", "asset_class", "position_id", "install_date", "removal_date", "removal_reason", "feeder_id",
                    "upstream_device_id", "latitude", "longitude", "end_latitude", "end_longitude", "parent_position_id",
                    "cohort", "material", "treatment", "size_class", "cost_zone", "customers_interrupted_on_failure"]],
        "record_window": pd.DataFrame({"asset_class": sorted(A["asset_class"].unique()), "records_start_date": pd.Timestamp(S.records_start),
                                       "source": "Demo data generator: removals recorded from records_start (synthetic)"}),
        "device": dev,
        "inspection": I,
        "outage": O,
        "action_cost": _rate_book(),
        "planning_parameter": pd.DataFrame([
            {"parameter": "discount_rate", "value": 0.07, "unit": "fraction_per_year", "source": "ASSUMPTION: demo finance parameter"},
            {"parameter": "customer_minute_value", "value": 2.0, "unit": "USD_per_customer_minute", "source": "ASSUMPTION: demo value of a customer-minute"}]),
        "class_parameter": pd.DataFrame([{"asset_class": c, "parameter": "failure_share", "value": v, "unit": "fraction",
                                          "source": "Demo data generator: share of end-of-life events generated as in-service failures"}
                                         for c, v in FAILURE_SHARE.items()]),
        "demo_life_law": pd.DataFrame([{"asset_class": c, "cohort": k, "median_life_years": m, "weibull_shape": s, "source": src}
                                       for c, d in LIFE_LAW.items() for k, (m, s, src) in d.items()]),
    }
    return tables


def _outages(S, rng, A, dev, E):
    """One outage per in-service failure (and per damage removal), plus background outages at fuses and reclosers."""
    rec0, as_of = _year(S.records_start), _year(S.as_of)
    cust = dev.set_index("device_id")["customers_downstream"]
    a = A.set_index("asset_id")
    storm_days = {y: [y + rng.uniform(0.3, 0.7) for _ in range(2)] for y in range(int(rec0), int(as_of))}
    rows = []
    med_minutes = {"pole": 190, "conductor_span": 150, "transformer": 130, "fuse": 90, "recloser": 110}
    for e in E.itertuples():
        failed_in_service = (e.reason == "failure") or (e.reason == "end_of_life" and rng.random() < FAILURE_SHARE.get(e.asset_class, 0))
        if not (failed_in_service or e.reason == "damage"):
            continue
        r = a.loc[e.asset_id]
        d = r.upstream_device_id
        n = int(r.customers_interrupted_on_failure) if pd.notna(r.customers_interrupted_on_failure) else int(cust.get(d, 0))
        t = e.year
        med = False
        if e.reason == "damage" and rng.random() < 0.5:
            t = storm_days[int(t)][0] if int(t) in storm_days else t
            med = True
        mins = float(rng.lognormal(math.log(med_minutes[e.asset_class] * (3 if med else 1)), 0.6))
        rows.append({"device_id": d, "failed_asset_id": e.asset_id, "cause_code": "storm" if e.reason == "damage" else "equipment_failure",
                     "t": t, "minutes": mins, "customers_interrupted": n, "major_event_day": med})
    for d in dev[dev.device_type.isin(["fuse", "recloser"])].itertuples():
        lam = 0.25 if d.device_type == "fuse" else 0.15
        k = rng.poisson(lam * (as_of - rec0))
        for t in rng.uniform(rec0, as_of, size=k):
            rows.append({"device_id": d.device_id, "failed_asset_id": None,
                         "cause_code": str(rng.choice(["trees", "animal", "unknown", "vehicle"], p=[0.45, 0.25, 0.2, 0.1])),
                         "t": float(t), "minutes": float(rng.lognormal(math.log(100), 0.7)),
                         "customers_interrupted": int(d.customers_downstream), "major_event_day": False})
    O = pd.DataFrame(rows).sort_values("t").reset_index(drop=True)
    O["outage_id"] = [f"OUT{i + 1:07d}" for i in range(len(O))]
    O["start_ts"] = [_dt(t) + pd.Timedelta(hours=float(rng.uniform(0, 24))) for t in O["t"]]
    O["restore_ts"] = O["start_ts"] + pd.to_timedelta(O["minutes"].clip(lower=5), unit="m")
    return O[["outage_id", "device_id", "failed_asset_id", "cause_code", "start_ts", "restore_ts", "customers_interrupted", "major_event_day"]]


def _rate_book() -> pd.DataFrame:
    rows = []
    for z, c in POLE_COST.items():
        rows.append({"asset_class": "pole", "action": "replace", "cost_basis": "planned", "cost_zone": z, "usd_per_asset": c, "source": "ASSUMPTION: demo rate book"})
        rows.append({"asset_class": "pole", "action": "replace", "cost_basis": "emergency", "cost_zone": z, "usd_per_asset": c * EMERGENCY_MULTIPLIER,
                     "source": f"ASSUMPTION: demo rate book x {EMERGENCY_MULTIPLIER} emergency multiplier"})
    rows.append({"asset_class": "pole", "action": "reinforce", "cost_basis": "planned", "cost_zone": None, "usd_per_asset": 2800.0, "source": "ASSUMPTION: demo rate book"})
    rows.append({"asset_class": "pole", "action": "inspect", "cost_basis": "planned", "cost_zone": None, "usd_per_asset": 85.0, "source": "ASSUMPTION: demo rate book"})
    return pd.DataFrame(rows)
