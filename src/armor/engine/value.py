"""The value of replacing an asset in plan year t, compared with leaving it in place.

WHAT "LEAVE IT IN PLACE" MEANS
The asset stays until it reaches end of life. Then it is replaced anyway: reactively after an in-service failure
(emergency cost + an outage), or planned when an inspection catches it (planned cost). The replacement follows
the new-asset curve and can itself reach end of life before the horizon; that renewal chain is included.

WHAT "REPLACE IN YEAR t" MEANS
Nothing changes before year t. At the start of year t, if the original is still there (probability S(t-1)), it is
replaced planned at cost P, and the new unit follows the new-asset curve from then on.

THE ARITHMETIC (per asset; p_h = pof_forecast year h, discount D_h = (1+r)^-(h-0.5) mid-year)
  n_h = S(h-1) p_h                          chance the ORIGINAL reaches end of life in year h
  f_k, r_k                                  a new unit's first-end-of-life and renewal densities in its k-th year
  W_j = D_j + sum_{h>j} D_h r_{h-j}         discounted count of end-of-life events caused by an event in year j
                                            (the event itself + its replacement's future ones)
  V_t = sum_{h>=t} D_h r_{h-t+1}            the same for a unit newly installed at the start of year t
  benefit(t) = K * sum_{j>=t} n_j W_j  -  S(t-1) * [ (1+r)^-(t-1) P + K V_t ]
with K the expected cost of one end-of-life event (consequence.py). Positive = replacing in year t is worth
more than it costs, over the horizon. The same formula with D = 1 and K replaced by a physical quantity
gives the avoided in-service failures and avoided customer-minutes.

Benefits beyond the forecast horizon are not counted (the table would need probabilities we don't have), so
late plan years show less benefit: keep the horizon well beyond the plan length (default 30 vs 10).
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def renewal(p_new: np.ndarray, H: int) -> np.ndarray:
    """r_k, k=1..H: expected end-of-life events in the k-th year after a new unit is installed."""
    p = np.asarray(p_new, float)[:H]
    S = np.concatenate([[1.0], np.cumprod(1 - p)[:-1]])
    f = S * p
    r = np.zeros(H)
    for k in range(H):
        r[k] = f[k] + np.dot(r[:k], f[k - 1::-1][:k]) if k else f[0]
    return r


def _weights(r: np.ndarray, D: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    H = len(D)
    W = np.array([D[j] + sum(D[h] * r[h - j - 1] for h in range(j + 1, H)) for j in range(H)])
    V = np.array([sum(D[h] * r[h - t] for h in range(t, H)) for t in range(H)])
    return W, V


def benefits(P: np.ndarray, classes: np.ndarray, new_curves: dict, K: np.ndarray, planned: np.ndarray,
             rate: float, T: int) -> dict:
    """Per asset x plan year t=1..T: dollar benefit, avoided end-of-life events, and the survival S(t-1).

    P: (N, H) p_end_of_life by year_offset; classes: (N,) asset_class; new_curves: class -> p_new by age 0..H;
    K: (N,) cost per end-of-life event (NaN = not priced); planned: (N,) planned replacement cost.
    """
    N, H = P.shape
    S = np.concatenate([np.ones((N, 1)), np.cumprod(1 - P, axis=1)[:, :-1]], axis=1)
    n = S * P
    D = (1 + rate) ** -(np.arange(1, H + 1) - 0.5)
    ones = np.ones(H)
    usd = np.full((N, T), np.nan)
    eol = np.zeros((N, T))
    for cls in np.unique(classes):
        m = classes == cls
        r = renewal(new_curves[cls], H)
        W, V = _weights(r, D)
        W1, V1 = _weights(r, ones)
        tailW = np.cumsum((n[m] * W)[:, ::-1], axis=1)[:, ::-1]    # sum_{j>=t} n_j W_j
        tailW1 = np.cumsum((n[m] * W1)[:, ::-1], axis=1)[:, ::-1]
        t = np.arange(T)
        disc_p = (1 + rate) ** -t.astype(float)
        usd[m] = K[m, None] * tailW[:, t] - S[m][:, t] * (disc_p[None, :] * planned[m, None] + K[m, None] * V[None, t])
        eol[m] = tailW1[:, t] - S[m][:, t] * V1[None, t]
    return {"usd": usd, "eol_avoided": eol, "survival": S[:, :T]}


def annual_risk(P: np.ndarray, K: np.ndarray) -> np.ndarray:
    """Expected cost of end of life in the next year if nothing is done (the map's 'risk $/yr')."""
    return P[:, 0] * K


def forecast_matrix(pof: pd.DataFrame, asset_ids: np.ndarray, H: int) -> np.ndarray:
    """pof_forecast rows -> (N, H) matrix in the order of asset_ids. Missing years fail loudly."""
    idx = pd.Index(asset_ids)
    pos = idx.get_indexer(pof["asset_id"])
    if (pos < 0).any():
        pof = pof[pos >= 0]
        pos = pos[pos >= 0]
    M = np.full((len(asset_ids), H), np.nan)
    yo = pof["year_offset"].to_numpy()
    ok = yo <= H
    M[pos[ok], yo[ok] - 1] = pof["p_end_of_life"].to_numpy()[ok]
    if np.isnan(M).any():
        bad = int(np.isnan(M).any(axis=1).sum())
        raise ValueError(f"pof_forecast is missing years for {bad:,} assets (need year_offset 1..{H})")
    return M


def trajectory(P: np.ndarray, classes: np.ndarray, new_curves: dict, replace_year: np.ndarray, years: int) -> dict:
    """Expected events per year for a schedule, analytically (no Monte Carlo): the plan's outcome over time.

    replace_year[i] = plan year (1-based) the asset is replaced planned if still original, or 0 = never (do nothing).
    Returns (N, years) arrays:
      eol       expected end-of-life events in each year (original unit, then its replacements; renewal included)
      planned   probability the planned replacement happens that year (the original is still there, S(t-1))
    An original that reaches end of life before its planned year is replaced then (and the planned job is not needed).
    """
    N, H = P.shape
    Y = min(years, H)
    S = np.concatenate([np.ones((N, 1)), np.cumprod(1 - P, axis=1)[:, :-1]], axis=1)
    n = S * P                                            # first end of life of the original in year h
    t = np.where(replace_year > 0, replace_year, H + 1)  # 1-based; H+1 = never within the horizon
    eol = np.zeros((N, Y))
    planned = np.zeros((N, Y))
    for cls in np.unique(classes):
        m = np.nonzero(classes == cls)[0]
        r = renewal(new_curves[cls], H)
        nm, tm = n[m], t[m]
        for h in range(Y):                                # year h+1
            orig = np.where(h + 1 < tm, nm[:, h], 0.0)     # original still in service (not yet planned out)
            # renewals of originals that reached end of life in an earlier year j (j < h, and j < t)
            ren = np.zeros(len(m))
            for j in range(h):
                ren += np.where(j + 1 < tm, nm[:, j], 0.0) * r[h - j - 1]
            # the planned replacement installed at the start of year t: its own end of life in year h
            k = h + 1 - tm                                # years since the planned install (0 = the install year)
            sv = np.where((tm <= H), S[m, np.clip(tm - 1, 0, H - 1)], 0.0)
            newu = np.where(k >= 0, sv * r[np.clip(k, 0, H - 1)], 0.0)
            eol[m, h] = orig + ren + newu
            planned[m, h] = np.where(tm == h + 1, sv, 0.0)
    return {"eol": eol, "planned": planned}
