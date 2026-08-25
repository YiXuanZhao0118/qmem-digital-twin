"""Mode-match service — glue between a loaded scene and the optimizer, shaped
into a JSON-friendly plan the frontend can preview and apply.

DB-independent on purpose (takes an already-loaded ``scene`` + one
``forward_result``), so it is unit-testable without Postgres; the router does
the loading and calls :func:`run_mode_match`.

The plan reports each moved element as a WORLD-space delta — a translation plus
an optional roll about the section axis through the element's centre — because
that is what the frontend applies to the SceneObject pose (translating /
rotating an object root moves its whole binding subtree rigidly, exactly like
``MirrorCouplingPanel`` does). Focal swaps ride along as ``focalMm``.
"""

from __future__ import annotations

from typing import Optional

import numpy as np

from app.optical.aperture import gaussian_width_mm
from app.optical.beam_ray import QMatrix
from app.optical.mode_match_model import ModeMatchProblem, build_problem
from app.optical.mode_match_optimize import (
    DOFSpec, OptimizeResult, default_lens_dof, optimize,
)


def _w_um(q: complex, wavelength_nm: float) -> Optional[float]:
    try:
        return gaussian_width_mm(q, wavelength_nm) * 1000.0
    except Exception:
        return None


def _widths(qm: QMatrix, wavelength_nm: float) -> dict:
    return {
        "xUm": _w_um(qm.xx, wavelength_nm),
        "yUm": _w_um(qm.yy, wavelength_nm),
    }


LENS_KINDS = {"lens", "lens_biconvex", "lens_plano_convex", "lens_cylindrical"}
# Keep-off margin (mm) so lenses don't sit exactly on the Start/End planes.
_RANGE_MARGIN_MM = 6.0


def _seed_hit_axials(
    forward_result, seed_emitter_id: str, axis: np.ndarray,
) -> dict[str, float]:
    """object id → axial coordinate where the seed first hits it."""
    out: dict[str, float] = {}
    for s in forward_result.lab_segments:
        if s.emitter_scene_object_id == seed_emitter_id and s.scene_object_id:
            a = float(np.array([s.start.x, s.start.y, s.start.z]) @ axis)
            out.setdefault(s.scene_object_id, a)
    return out


def _endpoint_face_axial(
    forward_result, endpoint_id: str, seed_emitter_id: str,
    axis: np.ndarray,
) -> Optional[float]:
    """Axial coordinate of the section-end mirror's face, from the forward
    seed segment that hits it. ``None`` if the seed never reaches it."""
    return _seed_hit_axials(forward_result, seed_emitter_id, axis).get(endpoint_id)


def _kind_map(scene) -> dict[str, str]:
    return {s.scene_object_id: s.asset.kind for s in scene.slots}


def _section_axis(forward_result, seed_emitter_id: str, ref_id: str) -> Optional[np.ndarray]:
    """Unit beam direction from the seed segment that hits ``ref_id``."""
    for s in forward_result.lab_segments:
        if s.emitter_scene_object_id == seed_emitter_id and s.scene_object_id == ref_id:
            d = np.array([s.end.x - s.start.x, s.end.y - s.start.y, s.end.z - s.start.z])
            n = np.linalg.norm(d)
            if n > 1e-9:
                return d / n
    return None


def _range_specs(
    movable_ids, hits, lo_axial, hi_axial, decenter_mm, roll_deg,
) -> dict[str, DOFSpec]:
    """Per-lens axial bounds that keep each lens's beam-hit within
    ``[lo_axial + margin, hi_axial - margin]`` (bounds are on d_axial, the delta
    from the lens's current position)."""
    m = _RANGE_MARGIN_MM
    base = default_lens_dof(0.0, decenter_mm, roll_deg)  # borrow decenter/roll
    specs: dict[str, DOFSpec] = {}
    for oid in movable_ids:
        p = hits.get(oid)
        if p is None:
            axial = (-20.0, 20.0)
        else:
            a, b = (lo_axial + m) - p, (hi_axial - m) - p
            axial = (min(a, b), max(a, b))
        specs[oid] = DOFSpec(axial=axial, decenter=base.decenter, roll_deg=base.roll_deg)
    return specs


def _shape_plan(
    problem, result, baseline, axis, e2, e3, names, wavelength_nm,
    *, key, label, column, eta_target, l_max_mm, endpoint_locked,
) -> dict:
    """Turn one OptimizeResult into a JSON solution card."""
    final = problem.evaluate(result.config) if result.config else baseline
    moves = []
    for oid, c in result.config.items():
        translate = c.d_axial * axis + c.d_e2 * e2 + c.d_e3 * e3
        if not (abs(c.d_axial) + abs(c.d_e2) + abs(c.d_e3) + abs(c.roll_deg) > 1e-9
                or c.focal_mm is not None):
            continue
        moves.append({
            "objectId": oid,
            "name": names.get(oid, oid),
            "translateWorldMm": {"x": float(translate[0]), "y": float(translate[1]), "z": float(translate[2])},
            "rotateAxisWorld": {"x": float(axis[0]), "y": float(axis[1]), "z": float(axis[2])},
            "rotateDeg": float(c.roll_deg),
            "focalMm": c.focal_mm,
        })
    return {
        "key": key, "label": label, "column": column,
        "feasible": result.feasible, "eta": result.eta,
        "etaBaseline": baseline.eta, "bestAchievable": result.best_achievable,
        "etaTarget": eta_target, "lengthMm": result.length_mm, "lMaxMm": l_max_mm,
        "reason": result.reason, "nEvals": result.n_evals, "endpointLocked": endpoint_locked,
        "moves": moves,
        "diagnostic": {
            "seedWidth": _widths(final.seed_q, wavelength_nm),
            "refWidthFinal": _widths(final.ref_q, wavelength_nm),
        },
    }


def run_mode_match(
    scene,
    forward_result,
    *,
    seed_emitter_id: str,
    ta_object_id: str,
    movable_ids: list[str],
    start_id: Optional[str] = None,
    endpoint_id: Optional[str] = None,
    endpoint_locked: bool = True,
    axial_mm: float = 20.0,
    decenter_mm: float = 0.0,  # OFF by default — decenter steers the beam
    roll_deg: float = 90.0,
    eta_target: Optional[float] = None,
    l_max_mm: Optional[float] = None,
    focal_inventory: Optional[dict[str, list[float]]] = None,
    wavelength_nm: float = 852.0,
    object_names: Optional[dict[str, str]] = None,
) -> dict:
    """Build the problem, optimize, and shape a JSON plan.

    ``movable_ids`` are the shaping lenses in path order. ``endpoint_id`` (e.g.
    MIRROR5) is added to the movable set as an axial-only endpoint; frozen
    unless ``endpoint_locked`` is False.
    """
    names = object_names or {}
    kinds = _kind_map(scene)

    # Section axis + geometry from Start (fallback End) — needed before we know
    # the lens set (Method 1 auto-detects lenses from it).
    ref = start_id or endpoint_id
    axis_np = _section_axis(forward_result, seed_emitter_id, ref) if ref else None
    if axis_np is None:
        # Fall back to any lens/endpoint the seed hits, via a throwaway problem.
        raise ValueError("Pick a Start and/or Endpoint element on the beam path.")
    hits = _seed_hit_axials(forward_result, seed_emitter_id, axis_np)
    start_axial = hits.get(start_id) if start_id else None
    end_axial = hits.get(endpoint_id) if endpoint_id else None

    method = 2 if movable_ids else 1
    detected: list[str] = []
    if not movable_ids:
        # Method 1: use the existing lenses currently between Start and End.
        if start_axial is None or end_axial is None:
            raise ValueError("Method 1 needs BOTH a Start and an Endpoint element.")
        lo, hi = min(start_axial, end_axial), max(start_axial, end_axial)
        movable_ids = sorted(
            (oid for oid, a in hits.items()
             if lo <= a <= hi and kinds.get(oid) in LENS_KINDS),
            key=lambda oid: hits[oid],
        )
        detected = [names.get(o, o) for o in movable_ids]
        if not movable_ids:
            raise ValueError("No lenses found between Start and Endpoint.")

    movable_ids = sorted(movable_ids, key=lambda oid: hits.get(oid, float("inf")))
    all_movable = list(movable_ids)
    if endpoint_id and endpoint_id not in all_movable:
        all_movable.append(endpoint_id)

    problem = build_problem(
        scene, forward_result=forward_result,
        seed_emitter_id=seed_emitter_id, ta_object_id=ta_object_id,
        movable_ids=all_movable, wavelength_nm=wavelength_nm,
    )
    axis = np.array([problem.axis.x, problem.axis.y, problem.axis.z])
    e2 = np.array([problem.e2.x, problem.e2.y, problem.e2.z])
    e3 = np.array([problem.e3.x, problem.e3.y, problem.e3.z])
    hits = _seed_hit_axials(forward_result, seed_emitter_id, axis)  # in problem axis
    start_axial = hits.get(start_id) if start_id else None
    end_axial = hits.get(endpoint_id) if endpoint_id else None
    cmp_axial = float(np.array([problem.compare_point.x, problem.compare_point.y,
                                problem.compare_point.z]) @ axis)
    lo_axial = start_axial if start_axial is not None else cmp_axial
    span = (end_axial - lo_axial) if end_axial is not None else 0.0
    baseline = problem.evaluate({})

    def shape(res, key, label, col, tgt, lmax, ep_locked):
        return _shape_plan(problem, res, baseline, axis, e2, e3, names, wavelength_nm,
                           key=key, label=label, column=col, eta_target=tgt,
                           l_max_mm=lmax, endpoint_locked=ep_locked)

    solutions: list[dict] = []

    # ── in-range best-efficiency ────────────────────────────────────────────
    if end_axial is not None:
        range_specs = _range_specs(movable_ids, hits, lo_axial, end_axial, decenter_mm, roll_deg)
        if endpoint_id:
            range_specs[endpoint_id] = DOFSpec()  # End fixed for max-η
        r = optimize(problem, specs=range_specs, current_length_mm=abs(span),
                     eta_target=eta_target, endpoint_id=endpoint_id,
                     endpoint_locked=True, focal_inventory=focal_inventory)
        solutions.append(shape(r, "range_maxeff", "In range · Max efficiency", "range", eta_target, None, True))

        # ── shortest lens footprint (Start → last lens) meeting the target ──
        # MIRROR5 stays put (moving a fold mirror is awkward); instead we pack
        # the lenses toward Start and find the smallest span they can occupy
        # while still hitting the target η. Focals are reused from the max-η
        # solution (single-option inventory) so the shrink search stays cheap.
        tgt = eta_target if eta_target is not None else max(0.0, r.eta * 0.98)
        best_focal = {oid: c.focal_mm for oid, c in r.config.items() if c.focal_mm is not None}
        best_short, best_cand = None, None
        if r.eta >= tgt - 1e-3:  # only worth shrinking if the target is reachable at all
            for frac in (0.8, 0.6, 0.45, 0.3):
                cand = abs(span) * frac
                sspecs = _range_specs(movable_ids, hits, lo_axial, lo_axial + cand, decenter_mm, roll_deg)
                if endpoint_id:
                    sspecs[endpoint_id] = DOFSpec()  # End FIXED
                sr = optimize(problem, specs=sspecs, current_length_mm=abs(span),
                              eta_target=tgt, endpoint_id=endpoint_id,
                              endpoint_locked=True, fixed_focal=best_focal or None,
                              warm_config=r.config, n_restarts=1)
                if sr.eta >= tgt - 1e-3:
                    best_short, best_cand = sr, cand  # shorter — keep looking
                else:
                    break
        if best_short is not None:
            plan = shape(best_short, "range_shortest", "In range · Shortest footprint", "range", tgt, None, True)
            plan["lengthMm"] = float(best_cand)  # lens footprint span (Start → last lens)
            solutions.append(plan)

    # ── Method 2: ignore Start/End (unconstrained positions) ────────────────
    if method == 2:
        wide = max(50.0, abs(span))
        free_specs = {oid: default_lens_dof(wide, decenter_mm, roll_deg) for oid in movable_ids}
        if endpoint_id:
            free_specs[endpoint_id] = DOFSpec()
        fr = optimize(problem, specs=free_specs, current_length_mm=abs(span),
                      eta_target=eta_target, endpoint_id=endpoint_id,
                      endpoint_locked=True, focal_inventory=focal_inventory)
        solutions.append(shape(fr, "free_maxeff", "Ignore range · Max efficiency", "free", eta_target, None, True))

    return {
        "mode": method,
        "detectedLenses": detected,
        "axis": {"x": float(axis[0]), "y": float(axis[1]), "z": float(axis[2])},
        "spanMm": abs(span),
        "solutions": solutions,
    }
