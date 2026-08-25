"""Mode-matching section model — the objective the optimizer drives.

Physical problem (see docs / the mode-matching memory): a DBR seed must be
shaped by a train of lenses so that, at the tapered-amplifier (TA) input
facet, it matches the TA's own input mode — TA **seed-injection** mode
matching. Perfect match ⇒ the seed and the (reverse-propagated) TA mode have
the same spot everywhere along the shaping section, which is exactly the
coupling the bench procedure walks in by hand.

How this file computes the coupling η, and why it is cheap enough to optimize:

* The **forward seed** q at a plane just upstream of the first shaping lens is
  FIXED — it is set by the source + upstream isolators, none of which the
  optimizer touches. One forward trace gives it, once.
* The **reverse reference** is a virtual beam launched at the TA input facet
  carrying the TA's declared ``inputSpatialModeX/Y``, propagating back OUT
  along −(the seed's inbound direction). It passes back through the very
  lenses we are optimizing.
* By reversibility, η between the fixed forward seed and the back-propagated
  reference, evaluated at that single upstream plane, **equals the power
  coupled into the TA**; η = 1 ⇔ the two profiles coincide at every plane in
  between. So the optimizer needs ONE reverse trace per evaluation, not a
  scan of the whole section.

Re-posing without the DB: ``load_anchor_scene_from_db``'s ``dynamic_overrides``
can override an object's params (``focalLengthMm``) but cannot move it — pose
lives on the SceneObject. The tracer, however, applies ``slot.effective_transform``
at trace time, so we move a lens by rebuilding its (frozen) slot with a shifted
transform and re-run the exact tracer. No analytic lens model to drift from the
authoritative physics; no DB round-trip.

Units: mm, nm (wavelength), degrees (roll). All lab-frame.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.spatial.transform import Rotation

from app.optical.anchor_tracer import (
    AnchorTraceOptions,
    LabSegment,
    V3AnchorScene,
    trace_ray_anchor_scene,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3
from app.optical.mode_match import gaussian_mode_overlap
from app.optical.pose import V3Transform

# Cylindrical lens kinds roll matters for; spherical kinds it does not (used
# only to flag DOF in the returned metadata — the tracer handles the physics).
_CYLINDRICAL_KINDS = {"lens_cylindrical"}


def _v(a: np.ndarray) -> Vec3:
    return Vec3(float(a[0]), float(a[1]), float(a[2]))


def _np(v: Vec3) -> np.ndarray:
    return np.array([v.x, v.y, v.z], dtype=float)


def _unit(a: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(a))
    if n < 1e-12:
        raise ValueError("mode_match_model: degenerate direction")
    return a / n


def _q_of_segment(ls: LabSegment) -> QMatrix:
    return QMatrix(
        complex(ls.qx_re_at_start, ls.qx_im_at_start),
        complex(ls.qy_re_at_start, ls.qy_im_at_start),
        complex(ls.qxy_re_at_start, ls.qxy_im_at_start),
    )


def _prop_q_freespace(q: QMatrix, d_mm: float) -> QMatrix:
    """Free-space propagate a beam matrix by ``d_mm`` (Q' = Q + d·I)."""
    return QMatrix(q.xx + d_mm, q.yy + d_mm, q.xy)


def _zr_mm(waist_um: float, wavelength_nm: float) -> float:
    w_mm = waist_um / 1000.0
    return math.pi * w_mm * w_mm / (wavelength_nm * 1e-6)


# ── per-lens configuration (the optimizer's variables) ─────────────────────

@dataclass(frozen=True)
class LensConfig:
    """One movable lens's displacement from its baseline pose + optional focal.

    ``d_axial`` slides along the section axis; ``d_e2``/``d_e3`` decenter in the
    transverse plane; ``roll_deg`` rotates about the section axis through the
    lens centre (only meaningful for a cylindrical lens). ``focal_mm`` overrides
    ``focalLengthMm`` (Stage-2 inventory search); ``None`` keeps the asset's.
    """

    d_axial: float = 0.0
    d_e2: float = 0.0
    d_e3: float = 0.0
    roll_deg: float = 0.0
    focal_mm: Optional[float] = None


@dataclass(frozen=True)
class MovableLens:
    scene_object_id: str
    name: str
    kind: str
    base_transform: V3Transform
    base_focal_mm: Optional[float]

    @property
    def is_cylindrical(self) -> bool:
        return self.kind in _CYLINDRICAL_KINDS


@dataclass(frozen=True)
class EvalResult:
    eta: float
    seed_q: QMatrix
    ref_q: QMatrix
    reached: bool  # reverse ray actually crossed the comparison plane


class ModeMatchProblem:
    """Everything needed to score a lens configuration for one seed→TA couple.

    Build with :func:`build_problem`; call :meth:`evaluate` per candidate.
    """

    def __init__(
        self,
        *,
        scene: V3AnchorScene,
        lenses: list[MovableLens],
        reverse_ray: BeamRay,
        seed_q: QMatrix,
        compare_point: Vec3,
        axis: Vec3,
        e2: Vec3,
        e3: Vec3,
        wavelength_nm: float,
        trace_options: Optional[AnchorTraceOptions] = None,
    ) -> None:
        self.scene = scene
        # Prune the reverse trace: it splits at every beam splitter, but only
        # the strong main path reaches the comparison plane (~0.95 of launch
        # power). A 1% threshold kills the dim branches — ~5× fewer segments,
        # same η — which is what makes the optimizer's inner loop cheap.
        self.trace_options = trace_options or AnchorTraceOptions(
            power_threshold_mw=1e-7
        )
        self.lenses = lenses
        self.reverse_ray = reverse_ray
        self.seed_q = seed_q
        self.compare_point = compare_point
        self.axis = axis
        self.e2 = e2
        self.e3 = e3
        self.wavelength_nm = wavelength_nm
        self._movable_ids = {ln.scene_object_id for ln in lenses}
        self._other_slots = [
            s for s in scene.slots if s.scene_object_id not in self._movable_ids
        ]
        self._slot_by_id = {s.scene_object_id: s for s in scene.slots}
        self._axis_np = _np(axis)
        self._e2_np = _np(e2)
        self._e3_np = _np(e3)
        self._cmp_np = _np(compare_point)

    # -- scene mutation ------------------------------------------------------

    def _build_scene(self, config: dict[str, LensConfig]) -> V3AnchorScene:
        slots = list(self._other_slots)
        for ln in self.lenses:
            c = config.get(ln.scene_object_id, LensConfig())
            base = ln.base_transform
            origin = (
                _np(base.origin)
                + c.d_axial * self._axis_np
                + c.d_e2 * self._e2_np
                + c.d_e3 * self._e3_np
            )
            rot = base.rotation
            if c.roll_deg:
                # Roll about the section axis THROUGH the lens centre. The lens
                # centre is its transform origin (the intercept anchor sits at
                # body 0), so the origin is unchanged and we only premultiply.
                rot = Rotation.from_rotvec(
                    self._axis_np * math.radians(c.roll_deg)
                ) * rot
            slot = self._slot_by_id[ln.scene_object_id]
            dynamic = dict(slot.dynamic_sources or {})
            if c.focal_mm is not None:
                dynamic["focalLengthMm"] = c.focal_mm
            slots.append(
                dataclasses.replace(
                    slot,
                    effective_transform=V3Transform(
                        origin=_v(origin), rotation=rot
                    ),
                    dynamic_sources=dynamic,
                )
            )
        return V3AnchorScene(slots=slots)

    # -- reverse readout -----------------------------------------------------

    def _ref_q_at_compare(self, segments: list[LabSegment]) -> Optional[QMatrix]:
        """The reverse beam's q propagated onto the comparison plane.

        Picks the reverse segment that (a) runs along the section axis line and
        (b) spans the comparison plane, then free-space-propagates its
        start-of-segment q to the plane. ``None`` if the reverse ray never
        crossed it (e.g. a decenter walked it off the aperture)."""
        best = None
        best_perp = 1e9
        s_cmp = float(self._cmp_np @ self._axis_np)  # plane coordinate
        for ls in segments:
            a = _np(ls.start)
            b = _np(ls.end)
            sa = float(a @ self._axis_np)
            sb = float(b @ self._axis_np)
            lo, hi = (sa, sb) if sa <= sb else (sb, sa)
            if not (lo - 1.0 <= s_cmp <= hi + 1.0):
                continue
            # perpendicular distance of the segment's midpoint from the axis
            mid = 0.5 * (a + b) - self._cmp_np
            perp = float(
                np.hypot(mid @ self._e2_np, mid @ self._e3_np)
            )
            if perp < best_perp:
                best_perp = perp
                best = ls
        if best is None:
            return None
        a = _np(best.start)
        b = _np(best.end)
        seg_len = float(np.linalg.norm(b - a))
        d_axis = float((b - a) @ self._axis_np)
        if abs(d_axis) < 1e-9:
            return None
        t = (s_cmp - (a @ self._axis_np)) / d_axis * seg_len
        return _prop_q_freespace(_q_of_segment(best), t)

    # -- public --------------------------------------------------------------

    def evaluate(self, config: dict[str, LensConfig]) -> EvalResult:
        scene = self._build_scene(config)
        trace = trace_ray_anchor_scene(
            self.reverse_ray, scene, self.trace_options
        )
        ref_q = self._ref_q_at_compare(trace.lab_segments)
        if ref_q is None:
            return EvalResult(0.0, self.seed_q, self.seed_q, reached=False)
        eta = gaussian_mode_overlap(self.seed_q, ref_q)
        return EvalResult(eta, self.seed_q, ref_q, reached=True)


# ── builder from a loaded scene ─────────────────────────────────────────────

def _seed_segments(fwd_lab_segments, seed_emitter_id: str) -> list[LabSegment]:
    segs = [
        s for s in fwd_lab_segments
        if s.emitter_scene_object_id == seed_emitter_id
    ]
    segs.sort(key=lambda s: s.path_length_mm_at_start)
    return segs


def build_problem(
    scene: V3AnchorScene,
    *,
    forward_result,
    seed_emitter_id: str,
    ta_object_id: str,
    movable_ids: list[str],
    wavelength_nm: float = 852.0,
) -> ModeMatchProblem:
    """Assemble a :class:`ModeMatchProblem` from a loaded scene + one forward
    trace (``forward_result`` = ``solve_anchor_scene(scene)``).

    ``movable_ids`` are the shaping-lens SceneObject ids in path order (first =
    nearest the seed side). Geometry (section axis, comparison plane) is derived
    from the forward seed's own segments; the reverse mode from the TA asset's
    ``inputSpatialModeX/Y``.
    """
    seed_segs = _seed_segments(forward_result.lab_segments, seed_emitter_id)
    if not seed_segs:
        raise ValueError(f"no seed segments for emitter {seed_emitter_id!r}")

    slot_by_id = {s.scene_object_id: s for s in scene.slots}
    first_id = movable_ids[0]

    # Feeder segment into the first lens: the seed segment that LEAVES the first
    # lens is the one tagged with its object id; the feeder is the segment just
    # before it, i.e. the last seed segment upstream of the first lens on the
    # path. Its START is the section-entry plane (free space, upstream of every
    # shaping lens) and its direction is the section axis. Comparing there means
    # the forward seed q is exact — no propagation, no dependence on where a
    # lens's transform origin happens to sit relative to its optical centre.
    first_leaving = next(
        (s for s in seed_segs if s.scene_object_id == first_id), None
    )
    if first_leaving is None:
        raise ValueError(f"seed never reaches first lens {first_id!r}")
    # The feeder is the seed segment whose END coincides with where the
    # first-lens segment STARTS (its hit point). Matched by geometry, not list
    # order — the path is a tree, so the previous entry by path length may be a
    # dead-end beam-splitter branch, not the leg actually feeding the lens.
    first_start = _np(first_leaving.start)
    feeder = min(
        (s for s in seed_segs if s is not first_leaving),
        key=lambda s: np.linalg.norm(_np(s.end) - first_start),
    )
    if np.linalg.norm(_np(feeder.end) - first_start) > 1.0:
        raise ValueError(
            f"no upstream segment feeds first lens {first_id!r} "
            "(cannot anchor the comparison plane)"
        )
    axis = _unit(_np(feeder.end) - _np(feeder.start))
    cmp_pt = _np(feeder.start)
    seed_q = _q_of_segment(feeder)

    # Transverse basis orthonormal to the axis.
    tmp = np.array([0.0, 0.0, 1.0])
    if abs(float(tmp @ axis)) > 0.9:
        tmp = np.array([0.0, 1.0, 0.0])
    e2 = _unit(np.cross(axis, tmp))
    e3 = _unit(np.cross(axis, e2))

    # TA facet + inbound direction: the seed segment inside the TA (pass-through
    # stub) has start = facet and start→end = the inbound direction.
    ta_seg = next(
        (s for s in seed_segs if s.scene_object_id == ta_object_id), None
    )
    if ta_seg is None:
        raise ValueError(f"seed never reaches TA object {ta_object_id!r}")
    inbound = _unit(_np(ta_seg.end) - _np(ta_seg.start))

    ta_slot = slot_by_id[ta_object_id]
    dp = ta_slot.asset.default_params
    mode_x = dp.get("inputSpatialModeX")
    mode_y = dp.get("inputSpatialModeY")
    if not mode_x or not mode_y:
        raise ValueError(
            f"TA {ta_object_id!r} declares no inputSpatialModeX/Y "
            "(needed as the mode-match target)"
        )
    # Reverse beam: waist real-part flips sign vs the input-beam convention
    # (`laser_source._q_from_mode` uses q_re = -waistZOffset for the +inbound
    # beam; reversing propagation negates that, so q_re = +waistZOffset).
    qx = complex(
        float(mode_x["waistZOffsetMm"]),
        _zr_mm(float(mode_x["waistUm"]), wavelength_nm),
    )
    qy = complex(
        float(mode_y["waistZOffsetMm"]),
        _zr_mm(float(mode_y["waistUm"]), wavelength_nm),
    )
    reverse_ray = BeamRay(
        origin=ta_seg.start,
        direction=_v(-inbound),
        qx=qx,
        qy=qy,
        wavelength_nm=wavelength_nm,
        power_mw=1.0,
        jones=(complex(1.0, 0.0), complex(0.0, 0.0)),
    )

    # Prune the scene to just the objects the reverse ray actually visits
    # (~15 of ~40). Only the reverse trace runs in the optimizer inner loop
    # (the forward seed q is fixed and captured above), so dropping optics the
    # reverse ray never touches is exact for η and cuts the per-step slot
    # iteration several-fold. Movable lenses are kept unconditionally; small
    # search moves stay on the same path, so no new object comes into play.
    probe = trace_ray_anchor_scene(
        reverse_ray, scene, AnchorTraceOptions(power_threshold_mw=1e-7)
    )
    keep_ids = {s.scene_object_id for s in probe.lab_segments if s.scene_object_id}
    keep_ids |= set(movable_ids)
    pruned = V3AnchorScene(
        slots=[s for s in scene.slots if s.scene_object_id in keep_ids]
    )

    lenses: list[MovableLens] = []
    for oid in movable_ids:
        slot = slot_by_id[oid]
        lenses.append(
            MovableLens(
                scene_object_id=oid,
                name=oid,
                kind=slot.asset.kind,
                base_transform=slot.effective_transform,
                base_focal_mm=(
                    slot.asset.default_params.get("focalLengthMm")
                ),
            )
        )

    return ModeMatchProblem(
        scene=pruned,
        lenses=lenses,
        reverse_ray=reverse_ray,
        seed_q=seed_q,
        compare_point=_v(cmp_pt),
        axis=_v(axis),
        e2=_v(e2),
        e3=_v(e3),
        wavelength_nm=wavelength_nm,
    )
