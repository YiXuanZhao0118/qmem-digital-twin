"""Mode-matching optimizer — place the shaping lenses so the DBR seed couples
into the TA (maximize η), subject to a section-length budget and a target η.

Given a :class:`~app.optical.mode_match_model.ModeMatchProblem` (the scored
objective) and a per-element DOF spec (which of axial / decenter / roll each
movable element may use, and within what bounds), search for the configuration
that maximizes η = seed↔TA-mode overlap.

Strategy — a multi-resolution **coordinate descent** (robust and cheap on this
objective: each lens position has a single broad optimum, so line searches
converge fast) followed by a gradient-free **Powell polish** for the last
digits. Multi-start from the current pose plus a few perturbations escapes the
shallow local optima the astigmatic cross-terms create. Every evaluation is a
single reverse trace (~40 ms), so the whole solve is a few seconds.

Constraints:
  * ``l_max_mm`` bounds the BS2→MIRROR5 section length. The endpoint mirror's
    axial DOF (when unlocked) is what trades length for η; its bound is derived
    from ``l_max_mm`` so the search cannot exceed it. When the mirror is locked
    the length is fixed — if it already exceeds ``l_max_mm`` the problem is
    reported infeasible with that reason.
  * ``eta_target`` is a success threshold, not a search constraint: we maximize
    η and then report whether the best reached it.

Infeasible results carry ``best_achievable`` and a human ``reason`` so the
caller (and the panel) can say how far short it fell and which limit bit.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.optimize import minimize

from app.optical.mode_match_model import LensConfig, ModeMatchProblem


@dataclass(frozen=True)
class DOFSpec:
    """Allowed degrees of freedom for one movable element, as (lo, hi) bounds
    in mm / degrees. ``None`` freezes that DOF. ``decenter`` applies to both
    transverse axes (e2 and e3)."""

    axial: Optional[tuple[float, float]] = None
    decenter: Optional[tuple[float, float]] = None
    roll_deg: Optional[tuple[float, float]] = None


# Default DOF: lenses get axial + roll only. Transverse DECENTER is OFF by
# default on purpose — decentering a lens off the beam steers the chief ray (a
# pointing error the mode-overlap objective does not penalize), so it must be
# opted into explicitly (decenter_mm > 0). Axial slides and rolls about the beam
# axis keep the beam on the lens centre. The endpoint mirror gets axial only.
def default_lens_dof(
    axial_mm: float = 20.0, decenter_mm: float = 0.0, roll_deg: float = 90.0,
) -> DOFSpec:
    return DOFSpec(
        axial=(-axial_mm, axial_mm),
        decenter=(-decenter_mm, decenter_mm) if decenter_mm > 0 else None,
        roll_deg=(-roll_deg, roll_deg) if roll_deg > 0 else None,
    )


@dataclass
class OptimizeResult:
    feasible: bool
    eta: float
    best_achievable: float
    length_mm: float
    config: dict[str, LensConfig]
    reason: Optional[str] = None
    n_evals: int = 0


# ── variable layout ─────────────────────────────────────────────────────────

@dataclass
class _Var:
    object_id: str
    dim: str          # 'axial' | 'e2' | 'e3' | 'roll'
    lo: float
    hi: float


def _layout(specs: dict[str, DOFSpec]) -> list[_Var]:
    variables: list[_Var] = []
    for oid, spec in specs.items():
        if spec.axial is not None:
            variables.append(_Var(oid, "axial", *spec.axial))
        if spec.decenter is not None:
            variables.append(_Var(oid, "e2", *spec.decenter))
            variables.append(_Var(oid, "e3", *spec.decenter))
        if spec.roll_deg is not None:
            variables.append(_Var(oid, "roll", *spec.roll_deg))
    return variables


def _config_from_x(x, variables: list[_Var]) -> dict[str, LensConfig]:
    acc: dict[str, dict] = {}
    for xi, v in zip(x, variables):
        acc.setdefault(v.object_id, {})[v.dim] = float(xi)
    out: dict[str, LensConfig] = {}
    for oid, d in acc.items():
        out[oid] = LensConfig(
            d_axial=d.get("axial", 0.0),
            d_e2=d.get("e2", 0.0),
            d_e3=d.get("e3", 0.0),
            roll_deg=d.get("roll", 0.0),
        )
    return out


def _x_from_config(config: dict[str, LensConfig], variables: list[_Var]):
    """Inverse of _config_from_x: pack a config into the variable vector,
    clamped to each variable's bounds (for warm-starting a tighter search)."""
    pick = {"axial": "d_axial", "e2": "d_e2", "e3": "d_e3", "roll": "roll_deg"}
    x = []
    for v in variables:
        c = config.get(v.object_id)
        val = getattr(c, pick[v.dim]) if c is not None else 0.0
        x.append(min(max(float(val), v.lo), v.hi))
    return np.array(x)


# ── the search ──────────────────────────────────────────────────────────────

def _coordinate_descent(
    objective, x0, variables, *, steps, sweeps: int,
) -> tuple[np.ndarray, float]:
    """Multi-resolution coordinate descent. Returns (x_best, value_best)."""
    x = np.array(x0, dtype=float)
    best = objective(x)
    for step in steps:
        improved = True
        sweep = 0
        while improved and sweep < sweeps:
            improved = False
            sweep += 1
            for i, v in enumerate(variables):
                base = x[i]
                for cand in (base - step, base + step):
                    if not (v.lo <= cand <= v.hi):
                        continue
                    x[i] = cand
                    val = objective(x)
                    if val < best - 1e-9:
                        best = val
                        base = cand
                        improved = True
                    else:
                        x[i] = base
    return x, best


def optimize(
    problem: ModeMatchProblem,
    *,
    specs: dict[str, DOFSpec],
    current_length_mm: float,
    eta_target: Optional[float] = None,
    l_max_mm: Optional[float] = None,
    endpoint_id: Optional[str] = None,
    endpoint_locked: bool = True,
    focal_inventory: Optional[dict[str, list[float]]] = None,
    fixed_focal: Optional[dict[str, float]] = None,
    warm_config: Optional[dict[str, LensConfig]] = None,
    max_focal_combos: int = 60,
    n_restarts: int = 2,
    rng_seed: int = 0,
) -> OptimizeResult:
    """Maximize η over the unfrozen DOF; report feasibility vs eta_target/l_max.

    ``current_length_mm`` is the present BS2→MIRROR5 length. ``endpoint_id`` is
    the section-end mirror; when unlocked, its axial DOF (in ``specs``) trades
    length for η and its bounds are clamped so the length stays ≤ ``l_max_mm``.
    """
    # Length feasibility when the endpoint is locked and already too long.
    if l_max_mm is not None and (endpoint_locked or endpoint_id is None):
        if current_length_mm > l_max_mm + 1e-6:
            return OptimizeResult(
                feasible=False, eta=0.0, best_achievable=0.0,
                length_mm=current_length_mm,
                config={},
                reason=(
                    f"Section is {current_length_mm:.1f} mm but the limit is "
                    f"{l_max_mm:.1f} mm, and MIRROR5 is locked. Unlock the "
                    "endpoint or raise the length limit."
                ),
            )

    specs = dict(specs)
    # Clamp the endpoint's axial bound so length ≤ l_max_mm (length grows with
    # +axial). Only when unlocked and a limit is set.
    if (
        endpoint_id is not None and not endpoint_locked
        and l_max_mm is not None and endpoint_id in specs
        and specs[endpoint_id].axial is not None
    ):
        lo, hi = specs[endpoint_id].axial
        hi = min(hi, l_max_mm - current_length_mm)
        specs[endpoint_id] = DOFSpec(
            axial=(lo, hi),
            decenter=specs[endpoint_id].decenter,
            roll_deg=specs[endpoint_id].roll_deg,
        )
    if endpoint_locked and endpoint_id is not None and endpoint_id in specs:
        specs[endpoint_id] = DOFSpec()  # freeze the mirror entirely

    variables = _layout(specs)
    if not variables:
        r = problem.evaluate({})
        return OptimizeResult(
            feasible=(eta_target is None or r.eta >= eta_target),
            eta=r.eta, best_achievable=r.eta, length_mm=current_length_mm,
            config={}, n_evals=1,
            reason=None if (eta_target is None or r.eta >= eta_target)
            else "No adjustable degrees of freedom.",
        )

    n_evals = 0

    def endpoint_axial(x) -> float:
        for xi, v in zip(x, variables):
            if v.object_id == endpoint_id and v.dim == "axial":
                return float(xi)
        return 0.0

    lo = np.array([v.lo for v in variables])
    hi = np.array([v.hi for v in variables])
    rng = np.random.default_rng(rng_seed)

    axial_vars = [v for v in variables if v.dim == "axial"]

    base_focal = dict(fixed_focal or {})  # applied to EVERY evaluation
    warm_x = (
        _x_from_config(warm_config, variables) if warm_config else None
    )

    def _objective(vars_used, focal_override):
        eff = {**base_focal, **focal_override}
        def objective(x) -> float:
            nonlocal n_evals
            n_evals += 1
            cfg = _config_from_x(x, vars_used)
            for oid, f in eff.items():
                cfg[oid] = dataclasses.replace(
                    cfg.get(oid, LensConfig()), focal_mm=f
                )
            return 1.0 - problem.evaluate(cfg).eta
        return objective

    def _solve(focal_override: dict[str, float], restarts: int):
        """Full position search (all DOF, Powell polish) for fixed focals."""
        obj = _objective(variables, focal_override)
        bx = np.zeros(len(variables))
        bv = obj(bx)
        starts = [bx.copy()]
        if warm_x is not None:
            starts.append(warm_x.copy())
        for _ in range(max(0, restarts)):
            starts.append(lo + (hi - lo) * rng.random(len(variables)))
        for s in starts:
            x_cd, v_cd = _coordinate_descent(
                obj, s, variables, steps=(8.0, 2.0, 0.5), sweeps=4,
            )
            res = minimize(
                obj, x_cd, method="Powell", bounds=list(zip(lo, hi)),
                options={"maxiter": 100, "xtol": 1e-3, "ftol": 1e-4},
            )
            cx, cv = (res.x, res.fun) if res.fun < v_cd else (x_cd, v_cd)
            if cv < bv:
                bv, bx = cv, np.array(cx)
        return bx, bv

    def _rank_focal(focal_override: dict[str, float]) -> float:
        """Cheap score for a focal combo: coarse axial-only descent, no polish.
        Used only to rank inventory picks before a full re-solve."""
        if not axial_vars:
            return _objective(variables, focal_override)(np.zeros(len(variables)))
        obj = _objective(axial_vars, focal_override)
        _, v = _coordinate_descent(
            obj, np.zeros(len(axial_vars)), axial_vars,
            steps=(6.0, 1.5), sweeps=2,
        )
        return v

    # Stage 1: current focals.
    best_x, best_val = _solve({}, n_restarts)
    best_focal: dict[str, float] = {}

    # Stage 2: focal-length inventory. Only when Stage 1 missed the target and
    # the user supplied lenses to swap. Each combination gets a CHEAP position
    # search (no restarts) to rank it; the winner is then re-solved in full.
    if (
        focal_inventory
        and eta_target is not None
        and (1.0 - best_val) < eta_target - 1e-6
    ):
        import itertools

        oids = [o for o in focal_inventory if focal_inventory[o]]
        combos = list(itertools.product(*(focal_inventory[o] for o in oids)))
        if len(combos) > max_focal_combos:
            # Deterministically thin to the budget (keep a spread).
            step = len(combos) / max_focal_combos
            combos = [combos[int(i * step)] for i in range(max_focal_combos)]
        ranked = []
        for combo in combos:
            override = dict(zip(oids, combo))
            ranked.append((_rank_focal(override), override))
        ranked.sort(key=lambda t: t[0])
        # Full re-solve only the top few inventory picks (cheap ranking can
        # mis-order once positions are fully optimized).
        for _score, override in ranked[:3]:
            fx, fv = _solve(override, restarts=max(0, n_restarts - 1))
            if fv < best_val:
                best_val, best_x, best_focal = fv, fx, override

    best_eta = 1.0 - best_val
    config = _config_from_x(best_x, variables)
    for oid, f in best_focal.items():
        config[oid] = dataclasses.replace(
            config.get(oid, LensConfig()), focal_mm=f
        )
    length_mm = current_length_mm + endpoint_axial(best_x)

    feasible = True
    reason = None
    if eta_target is not None and best_eta < eta_target - 1e-6:
        feasible = False
        reason = (
            f"Best achievable η = {best_eta:.3f}, below the target "
            f"{eta_target:.3f}."
        )
        if l_max_mm is not None and (endpoint_locked or endpoint_id is None):
            reason += (
                " The section length is fixed (MIRROR5 locked); unlocking it "
                "may allow a better match."
            )
    if l_max_mm is not None and length_mm > l_max_mm + 1e-6:
        feasible = False
        reason = (
            (reason + " ") if reason else ""
        ) + f"Section length {length_mm:.1f} mm exceeds the {l_max_mm:.1f} mm limit."

    return OptimizeResult(
        feasible=feasible, eta=best_eta, best_achievable=best_eta,
        length_mm=length_mm, config=config, reason=reason, n_evals=n_evals,
    )
