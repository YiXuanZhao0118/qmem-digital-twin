"""Anchor-centric ray tracer (Phase 9.2).

Replaces the face-based ray-plane dispatch with anchor-based dispatch:
each Asset3D has one or more anchors; each anchor carries its own local
tri-axis (axisX = propagation/normal, axisY = transverse 1, axisZ =
transverse 2). Beam state at an anchor hit is the 5×5 augmented vector
[y, θ_y, z, θ_z, 1] in the anchor's local frame, where:

    y, z  = perpendicular offset of the hit point from anchor centre
    θ_y, θ_z = ray direction tilt relative to axisX, decomposed onto axisY/Z

Per-kind ops take (ray_in_body, asset, anchor_hit, ctx) and return a
list of out_rays (in body frame). Multi-output ops (PBS p/s branch,
AOM ±1 orders) return ≥ 2 rays.

Runs in parallel with the legacy face-based ``trace_ray_scene`` until
Phase 9.8 cleanup.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Optional

from app.optical.aperture import (
    LENS_KINDS,
    gaussian_circular_aperture_fraction,
    gaussian_width_mm,
)
from app.optical.beam_ray import BeamRay, QMatrix, Vec3, vec3_distance
from app.optical.jones import (
    jones_body_to_lab,
    jones_lab_to_body,
    sp_rotation_between_directions,
    sp_rotation_body_to_lab,
    sp_rotation_lab_to_body,
)
from app.optical.pose import (
    V3Pose, V3Transform, compose_transforms, pose_to_transform,
    point_body_to_lab_t, point_lab_to_body_t,
    dir_body_to_lab_t, dir_lab_to_body_t,
)


# ─── Snapshot types ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class V3Anchor:
    """Anchor on an Asset3D in body-local coordinates with explicit tri-axis."""
    id: str
    position_body: Vec3
    axis_x_body: Vec3                  # propagation / normal direction
    axis_y_body: Vec3                  # transverse 1 (fast axis / s-pol / etc.)
    axis_z_body: Vec3                  # transverse 2 (= axisX × axisY)
    aperture_mm: float
    aperture_shape: str = "circle"


@dataclass(frozen=True)
class V3AssetAnchorSnapshot:
    """Asset3D with anchor-centric data for the new tracer."""
    catalog_id: str
    kind: str
    anchors: list[V3Anchor]
    default_params: dict = field(default_factory=dict)


@dataclass(frozen=True)
class V3AnchorBindingSlot:
    """One placed instance of an Asset3D in scene (after binding tree flatten)."""
    scene_object_id: str
    binding_id: str
    asset: V3AssetAnchorSnapshot
    effective_transform: V3Transform
    dynamic_sources: Optional[dict] = None
    # Instrument power panel: False when the owning SceneObject's
    # device_states.state.power is False. Emitters (laser_source, TA ASE) skip
    # powered-off slots so the beam disappears on power-off.
    powered_on: bool = True
    # `SceneObject.properties.emissionVisuals` verbatim — per-emission
    # presentation overrides keyed "main" / "forward" / "backward" (see
    # schemas.EmissionVisualOverride). Only `visible` is read here: an
    # emission the user hid is never emitted, so downstream optics stop
    # reflecting it too. Colour is a pure frontend concern.
    emission_visuals: Optional[dict] = None


@dataclass(frozen=True)
class V3AnchorScene:
    """A scene snapshot ready for anchor-based tracing. Built from DB by
    ``app.optical.db_scene_loader.load_anchor_scene_from_db``."""
    slots: list[V3AnchorBindingSlot]


# ─── Anchor hit ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AnchorHit:
    slot: V3AnchorBindingSlot
    anchor: V3Anchor
    t_lab: float                       # parametric distance along ray (lab mm)
    hit_point_body: Vec3               # where the ray crosses anchor's plane (body frame)
    offset_y_body: float               # perpendicular offset along axisY (body mm)
    offset_z_body: float               # perpendicular offset along axisZ
    cos_incidence: float               # |ray.direction · axisX| (1 = head-on)


def intersect_anchor(
    origin_body: Vec3, direction_body: Vec3, anchor: V3Anchor,
    *, t_min: float = 1e-9,
) -> Optional[tuple[float, Vec3, float, float, float]]:
    """Ray-plane intersection at the plane perpendicular to anchor.axisX
    through anchor.position. Returns (t, hit_point, off_y, off_z, cos_inc)
    or None if parallel / out of aperture / behind origin.
    """
    n = anchor.axis_x_body
    denom = direction_body.dot(n)
    if abs(denom) < 1e-12:
        return None
    diff = anchor.position_body - origin_body
    t = diff.dot(n) / denom
    if t < t_min:
        return None
    hit = origin_body + direction_body * t

    offset = hit - anchor.position_body
    off_y = offset.dot(anchor.axis_y_body)
    off_z = offset.dot(anchor.axis_z_body)
    # Aperture check (assume circular semi-axis for now;
    # rectangular aperture treated as inscribed circle for v1)
    r = math.sqrt(off_y * off_y + off_z * off_z)
    if anchor.aperture_mm > 0 and r > anchor.aperture_mm + 1e-9:
        return None
    return t, hit, off_y, off_z, abs(denom)


# ─── Scene flatten ─────────────────────────────────────────────────────────


# Primary anchor IDs that the tracer considers during ray-plane
# intersection. After Phase 9.8 anchor naming cleanup, the canonical
# names come straight from kind.anchor_template — every optical asset
# carries one or more of `intercept_in / intercept_out / intercept_face`
# (plus rf_in/out/ttl_in for RF). Two derived/special anchors stay:
#   - interaction_center: synthesized at load time for AOM from the
#                          midpoint of intercept_in and intercept_out.
#   - optical_center:     used only by faraday_rotator (single-anchor
#                          kind defined separately from the spec).
PRIMARY_ANCHOR_IDS = frozenset({
    "intercept_in",            # transmissive entry face (lens, waveplate, eom, polarizer,
                               # nonlinear, saturable, beam_dump, camera, detector, wavemeter,
                               # fiber-in, glan_polarizer, TA-in)
    "intercept_out",           # transmissive exit face (laser_source, fiber-out, TA-out)
    "intercept_face",          # reflective / coating face (mirror, dichroic_mirror,
                               # PBS / beam_splitter)
    "interaction_center",      # AOM (synthesized at load from intercept_in/out midpoint)
    "optical_center",          # faraday_rotator (single-anchor non-reciprocal element)
})


def nearest_anchor_hit(
    ray_lab: BeamRay,
    slots: list[V3AnchorBindingSlot],
    *,
    exclude_anchor_key: Optional[str] = None,
) -> Optional[AnchorHit]:
    """Find the nearest PRIMARY anchor along the ray.

    Secondary anchors (intercept_in / intercept_out / port_*) are align
    hints (Phase 9.7) and not considered for trace intersection. Honour
    exclude_anchor_key to avoid re-hitting the anchor a ray just
    emerged from.
    """
    best: Optional[AnchorHit] = None
    for slot in slots:
        origin_body = point_lab_to_body_t(ray_lab.origin, slot.effective_transform)
        dir_body = dir_lab_to_body_t(ray_lab.direction, slot.effective_transform)
        for anchor in slot.asset.anchors:
            if anchor.id not in PRIMARY_ANCHOR_IDS:
                continue
            slot_anchor_key = (
                f"{slot.scene_object_id}/{slot.binding_id}/{anchor.id}"
            )
            if exclude_anchor_key == slot_anchor_key:
                continue
            res = intersect_anchor(origin_body, dir_body, anchor)
            if res is None:
                continue
            t, hit, off_y, off_z, cos_inc = res
            if best is None or t < best.t_lab:
                best = AnchorHit(
                    slot=slot, anchor=anchor, t_lab=t,
                    hit_point_body=hit,
                    offset_y_body=off_y, offset_z_body=off_z,
                    cos_incidence=cos_inc,
                )
    return best


# ─── Op registry ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AnchorOpContext:
    """Context passed to per-kind anchor ops.

    Contains everything an op needs to compute its output: the asset's
    constant data (default_params, kind), the specific anchor that was
    hit (with tri-axis local frame), the ray's state in that anchor's
    local frame, and any dynamic per-instance overrides.
    """
    asset: V3AssetAnchorSnapshot
    anchor: V3Anchor
    hit: AnchorHit
    params: dict                       # merged default_params ⊕ dynamic_sources
    dynamic: dict


AnchorOp = Callable[[BeamRay, AnchorOpContext], list[BeamRay]]

_ANCHOR_OPS: dict[str, AnchorOp] = {}


def register_anchor_op(kind: str, op: AnchorOp) -> None:
    if kind in _ANCHOR_OPS:
        raise ValueError(f"anchor op for kind {kind!r} already registered")
    _ANCHOR_OPS[kind] = op


def get_anchor_op(kind: str) -> Optional[AnchorOp]:
    return _ANCHOR_OPS.get(kind)


# ─── ABCD helpers ──────────────────────────────────────────────────────────


def beam_state_from_anchor_hit(
    ray_body: BeamRay, hit: AnchorHit,
) -> tuple[float, float, float, float]:
    """Extract (y, θ_y, z, θ_z) in the anchor's local frame from a ray
    that's just landed on the anchor.

    Beam state convention (paraxial 5×5):
        y     = perpendicular offset along axisY
        θ_y   = ray.direction.axisY / |ray.direction.axisX| (slope)
        z     = perpendicular offset along axisZ
        θ_z   = ray.direction.axisZ / |ray.direction.axisX|

    Uses |dx| so θ_y / θ_z keep their geometric sign regardless of whether
    the ray hits the anchor head-on (d·axisX > 0) or anti-parallel
    (d·axisX < 0). The propagation-direction sign is recovered from the
    input direction in ``out_ray_from_state``.
    """
    n_x = hit.anchor.axis_x_body
    n_y = hit.anchor.axis_y_body
    n_z = hit.anchor.axis_z_body
    d = ray_body.direction
    abs_dx = abs(d.dot(n_x))
    if abs_dx < 1e-12:
        return hit.offset_y_body, 0.0, hit.offset_z_body, 0.0
    return (
        hit.offset_y_body,
        d.dot(n_y) / abs_dx,
        hit.offset_z_body,
        d.dot(n_z) / abs_dx,
    )


def out_ray_from_state(
    base_ray: BeamRay,
    anchor: V3Anchor,
    y: float, theta_y: float, z: float, theta_z: float,
    *,
    flip_propagation: bool = False,
) -> BeamRay:
    """Reconstruct an out-going BeamRay (still in body frame) from a
    post-op (y, θ_y, z, θ_z) state.

    Output propagation direction follows the input ray's incidence sign:
      - Transmission (flip_propagation=False): same axial direction as
        input (beam passes through the slab forward).
      - Reflection (flip_propagation=True): reversed axial direction
        (mirror reflects back through whichever face it entered).

    This makes slab/lens/polarizer ops symmetric — anchors whose axisX
    happens to point "back" toward the upstream emitter (after R_body /
    scene rotation) still transmit forward instead of bouncing back.
    """
    inc_dot = (
        base_ray.direction.x * anchor.axis_x_body.x
        + base_ray.direction.y * anchor.axis_x_body.y
        + base_ray.direction.z * anchor.axis_x_body.z
    )
    incidence_sign = 1.0 if inc_dot >= 0 else -1.0
    out_sign = incidence_sign * (-1.0 if flip_propagation else 1.0)

    n_x = Vec3(
        anchor.axis_x_body.x * out_sign,
        anchor.axis_x_body.y * out_sign,
        anchor.axis_x_body.z * out_sign,
    )
    new_origin = Vec3(
        anchor.position_body.x + y * anchor.axis_y_body.x + z * anchor.axis_z_body.x,
        anchor.position_body.y + y * anchor.axis_y_body.y + z * anchor.axis_z_body.y,
        anchor.position_body.z + y * anchor.axis_y_body.z + z * anchor.axis_z_body.z,
    )
    # direction = signed axisX + θ_y · axisY + θ_z · axisZ (then normalize)
    dx, dy, dz = n_x.x, n_x.y, n_x.z
    dx += theta_y * anchor.axis_y_body.x + theta_z * anchor.axis_z_body.x
    dy += theta_y * anchor.axis_y_body.y + theta_z * anchor.axis_z_body.y
    dz += theta_y * anchor.axis_y_body.z + theta_z * anchor.axis_z_body.z
    mag = math.sqrt(dx * dx + dy * dy + dz * dz)
    if mag < 1e-12:
        new_dir = n_x
    else:
        new_dir = Vec3(dx / mag, dy / mag, dz / mag)
    return base_ray.replaced(origin=new_origin, direction=new_dir)


def apply_thin_lens_state(
    y: float, theta_y: float, z: float, theta_z: float, f_mm: float,
) -> tuple[float, float, float, float]:
    """Thin-lens 5×5: identity on (y, z), kick on (θ_y, θ_z): θ' = θ - y/f."""
    return y, theta_y - y / f_mm, z, theta_z - z / f_mm


def apply_abcd_state(
    y: float, theta_y: float, z: float, theta_z: float,
    a: float, b: float, c: float, d: float,
) -> tuple[float, float, float, float]:
    """General per-axis ABCD: (y', θ') = [[a,b],[c,d]]·(y, θ) on both
    transverse axes. Generalises ``apply_thin_lens_state`` (a=d=1, b=0,
    c=-1/f) for thick-lens / multi-surface elements."""
    return (
        a * y + b * theta_y, c * y + d * theta_y,
        a * z + b * theta_z, c * z + d * theta_z,
    )


def apply_slab_state(
    y: float, theta_y: float, z: float, theta_z: float, L_over_n_mm: float,
) -> tuple[float, float, float, float]:
    """Free-space (or glass) slab of effective length L/n: y' = y + (L/n)·θ_y."""
    return (
        y + L_over_n_mm * theta_y, theta_y,
        z + L_over_n_mm * theta_z, theta_z,
    )


# ─── Lab segment for rendering ─────────────────────────────────────────────


@dataclass
class LabSegment:
    start: Vec3
    end: Vec3
    wavelength_nm: float
    power_mw: float
    scene_object_id: Optional[str]
    binding_id: Optional[str]
    asset_catalog_id: Optional[str]
    anchor_id: Optional[str]
    op_kind: Optional[str]
    is_terminal: bool
    emitter_scene_object_id: Optional[str] = None
    source_scene_object_id: Optional[str] = None
    # Which of the emitter's emissions this segment descends from — "main"
    # (laser_source), "forward" / "backward" (TA). Keys match
    # `SceneObject.properties.emissionVisuals`, so the frontend can colour a
    # TA's two facets independently. Propagates down the chain untouched.
    emission_key: Optional[str] = None
    # Phase 7-style ray state at segment start (for frontend adapter +
    # OpticalLinkViewerPanel's waist / polarisation displays).
    jones_re_x: float = 1.0
    jones_im_x: float = 0.0
    jones_re_y: float = 0.0
    jones_im_y: float = 0.0
    qx_re_at_start: float = 0.0
    qx_im_at_start: float = 0.0
    qy_re_at_start: float = 0.0
    qy_im_at_start: float = 0.0
    # Off-diagonal of the transverse beam matrix Q at segment start. Non-zero
    # once an element rolled about the optical axis has acted on the beam —
    # i.e. astigmatism whose principal axes are not the frame axes.
    qxy_re_at_start: float = 0.0
    qxy_im_at_start: float = 0.0
    path_length_mm_at_start: float = 0.0
    freq_offset_hz_at_start: float = 0.0
    # Embedded-Gaussian width multiplier at segment start (M² + transverse
    # mode). Real width = (q-derived embedded width) × this. See BeamRay.
    width_mult_x_at_start: float = 1.0
    width_mult_y_at_start: float = 1.0
    # Off-diagonals of the two readout tensors (Step 2c).
    width_mult_xy_at_start: float = 0.0
    m2_xy_at_start: float = 0.0
    # Per-axis M² at segment start (for the non-paraxial width correction).
    m2_x_at_start: float = 1.0
    m2_y_at_start: float = 1.0
    # Clear-aperture clipping at this segment's END optic (lens kinds only).
    # None when the end optic has no finite aperture / isn't a lens. Keys:
    # apertureMm, wEffMm, transmittedFraction, transmittance, combinedFraction.
    aperture_truncation: Optional[dict] = None


@dataclass
class AnchorTraceResult:
    final_rays: list[BeamRay] = field(default_factory=list)
    lab_segments: list[LabSegment] = field(default_factory=list)
    terminated: str = "escaped"        # 'escaped' | 'max_steps' | 'power_threshold'


@dataclass(frozen=True)
class AnchorTraceOptions:
    # 96: enough for a forward + retro-reflected return pass through a full
    # bench (isolator + lens + AOM multi-order + waveplate + mirror), so a
    # mirror-returned beam reaches the isolator instead of being truncated
    # mid-flight by the step cap.
    max_steps: int = 96
    power_threshold_mw: float = 1e-9
    escape_distance_mm: float = 1000.0


# ─── Main trace loop ───────────────────────────────────────────────────────


def trace_ray_anchor_scene(
    initial_ray: BeamRay,
    scene: V3AnchorScene,
    options: AnchorTraceOptions = AnchorTraceOptions(),
    *,
    emitter_scene_object_id: Optional[str] = None,
    source_scene_object_id: Optional[str] = None,
    emission_key: Optional[str] = None,
) -> AnchorTraceResult:
    """BFS-style ray trace using anchor-based dispatch.

    Each dequeued (ray, source_id, emitter_id) tuple is intersected
    against all anchors in the scene; nearest hit fires that kind's
    anchor op; out_rays go back on the queue. Lab-frame segments are
    accumulated for rendering.
    """
    result = AnchorTraceResult()
    queue: list[
        tuple[BeamRay, Optional[str], Optional[str], Optional[str]]
    ] = [
        (initial_ray, source_scene_object_id, emitter_scene_object_id,
         emission_key),
    ]
    total_steps = 0

    while queue:
        if total_steps >= options.max_steps:
            result.terminated = "max_steps"
            result.final_rays.extend(r for r, _s, _e, _k in queue)
            break
        ray, source_id, emitter_id, emission_id = queue.pop(0)
        if ray.power_mw < options.power_threshold_mw:
            result.terminated = "power_threshold"
            continue

        hit = nearest_anchor_hit(
            ray, scene.slots,
            exclude_anchor_key=ray.exclude_face_key,
        )

        if hit is None:
            # Escape — render tail
            tail_end = Vec3(
                ray.origin.x + ray.direction.x * options.escape_distance_mm,
                ray.origin.y + ray.direction.y * options.escape_distance_mm,
                ray.origin.z + ray.direction.z * options.escape_distance_mm,
            )
            result.lab_segments.append(LabSegment(
                start=ray.origin, end=tail_end,
                wavelength_nm=ray.wavelength_nm, power_mw=ray.power_mw,
                scene_object_id=None, binding_id=None,
                asset_catalog_id=None, anchor_id=None, op_kind=None,
                is_terminal=True,
                emitter_scene_object_id=emitter_id,
                source_scene_object_id=source_id,
                emission_key=emission_id,
                jones_re_x=ray.jones[0].real, jones_im_x=ray.jones[0].imag,
                jones_re_y=ray.jones[1].real, jones_im_y=ray.jones[1].imag,
                qx_re_at_start=ray.qx.real, qx_im_at_start=ray.qx.imag,
                qxy_re_at_start=ray.qxy.real,
                qxy_im_at_start=ray.qxy.imag,
                qy_re_at_start=ray.qy.real, qy_im_at_start=ray.qy.imag,
                path_length_mm_at_start=ray.path_length_mm,
                freq_offset_hz_at_start=ray.freq_offset_hz,
                width_mult_x_at_start=ray.width_mult_x,
                width_mult_y_at_start=ray.width_mult_y,
                width_mult_xy_at_start=ray.width_mult_xy,
                m2_xy_at_start=ray.m2xy,
                m2_x_at_start=ray.m2x, m2_y_at_start=ray.m2y,
            ))
            result.final_rays.append(ray)
            continue

        slot = hit.slot
        anchor = hit.anchor
        hit_lab = point_body_to_lab_t(hit.hit_point_body, slot.effective_transform)

        # Lab-frame segment from ray start → this hit
        entry_seg = LabSegment(
            start=ray.origin, end=hit_lab,
            wavelength_nm=ray.wavelength_nm, power_mw=ray.power_mw,
            scene_object_id=slot.scene_object_id,
            binding_id=slot.binding_id,
            asset_catalog_id=slot.asset.catalog_id,
            anchor_id=anchor.id,
            op_kind=slot.asset.kind,
            is_terminal=False,
            emitter_scene_object_id=emitter_id,
            source_scene_object_id=source_id,
            emission_key=emission_id,
            jones_re_x=ray.jones[0].real, jones_im_x=ray.jones[0].imag,
            jones_re_y=ray.jones[1].real, jones_im_y=ray.jones[1].imag,
            qx_re_at_start=ray.qx.real, qx_im_at_start=ray.qx.imag,
                qxy_re_at_start=ray.qxy.real,
                qxy_im_at_start=ray.qxy.imag,
            qy_re_at_start=ray.qy.real, qy_im_at_start=ray.qy.imag,
            path_length_mm_at_start=ray.path_length_mm,
            freq_offset_hz_at_start=ray.freq_offset_hz,
            width_mult_x_at_start=ray.width_mult_x,
            width_mult_y_at_start=ray.width_mult_y,
            width_mult_xy_at_start=ray.width_mult_xy,
            m2_xy_at_start=ray.m2xy,
            m2_x_at_start=ray.m2x, m2_y_at_start=ray.m2y,
        )
        result.lab_segments.append(entry_seg)

        # Dispatch op
        op = get_anchor_op(slot.asset.kind)
        if op is None:
            # No physics op for this kind — treat as terminal sink
            result.final_rays.append(ray.replaced(power_mw=0))
            continue

        # Transform ray into body frame for op
        dir_body = dir_lab_to_body_t(ray.direction, slot.effective_transform)
        jones_body = jones_lab_to_body(
            ray.jones, ray.direction, dir_body,
            lambda v: dir_lab_to_body_t(v, slot.effective_transform),
        )
        # Free-space Gaussian propagation is Q' = Q + L*I: diagonal-only, so
        # it commutes with the frame rotation that follows.
        ray_gap = ray.replaced(
            qx=complex(ray.qx.real + hit.t_lab, ray.qx.imag),
            qy=complex(ray.qy.real + hit.t_lab, ray.qy.imag),
        )
        # ONE angle rotates Q and both readout tensors together.
        ray_gap = ray_gap.rotated_frame(sp_rotation_lab_to_body(
            ray.direction, dir_body,
            lambda v: dir_lab_to_body_t(v, slot.effective_transform),
        ))
        ray_at_anchor = ray_gap.replaced(
            origin=hit.hit_point_body,
            direction=dir_body,
            jones=jones_body,
            # Free-space Gaussian-q propagation across the gap from the previous
            # element to this hit: q' = q + L (the [[1,L],[0,1]] ABCD). Without
            # this the beam profile only ever accumulated each element's slab
            # L/n ("glass, never air"), so waist / focus were wrong. Each op
            # then adds its own slab on top of this incoming q. Mirrors the
            # legacy face tracer (ray_tracer.py).
            path_length_mm=ray.path_length_mm + hit.t_lab,
        )

        merged_dynamic = dict(slot.dynamic_sources or {})
        merged_params = {**slot.asset.default_params, **merged_dynamic}
        ctx = AnchorOpContext(
            asset=slot.asset, anchor=anchor, hit=hit,
            params=merged_params, dynamic=merged_dynamic,
        )

        # Record the clear-aperture clipping the lens op is about to apply, so
        # the frontend can show "beam clipped X%" / render diffraction rings
        # (Stage 1 energy half). Uses ray_at_anchor's propagated q = spot at
        # the lens; the op recomputes the same factor to attenuate power.
        if slot.asset.kind in LENS_KINDS and anchor.aperture_mm > 0:
            wl = ray_at_anchor.wavelength_nm
            w_eff = (
                gaussian_width_mm(ray_at_anchor.qx, wl)
                * gaussian_width_mm(ray_at_anchor.qy, wl)
            ) ** 0.5
            # Same radial decenter the lens op feeds to the aperture fraction,
            # so the displayed combinedFraction matches the power the op
            # actually attenuates for a misaligned (off-axis) beam.
            r_c = math.hypot(hit.offset_y_body, hit.offset_z_body)
            t_ap = gaussian_circular_aperture_fraction(w_eff, anchor.aperture_mm, r_c)
            transmittance = float(merged_params.get("transmittance", 1.0))
            entry_seg.aperture_truncation = {
                "apertureMm": anchor.aperture_mm,
                "wEffMm": w_eff,
                "decenterMm": r_c,
                "transmittedFraction": t_ap,
                "transmittance": transmittance,
                "combinedFraction": t_ap * transmittance,
                # Focal length so the frontend can request the focal-plane Airy
                # pattern (POP) for this lens via /api/v3/pop.
                "focalLengthMm": float(merged_params.get("focalLengthMm", 0.0)),
            }

        out_rays_body = op(ray_at_anchor, ctx)

        # A seeded tapered_amplifier RE-EMITS: the amplified beam is the chip's
        # own waveguide mode (the seed's q / polarization are discarded by
        # `tapered_amplifier_anchor_op`), so from the output facet onwards the
        # TA — not the upstream laser — is the emitter. Downstream consumers key
        # per-source presentation on `emitter_scene_object_id`, so without this
        # the TA's own beam-colour override (`properties.emissionVisuals`) could
        # never take effect: every segment past the TA still carried the seed
        # laser's id. Only the amplifying pass (seed entering `intercept_in`)
        # re-tags — a ray merely passing through the output facet keeps the
        # emitter it arrived with.
        ta_reemits = (
            slot.asset.kind == "tapered_amplifier" and anchor.id == "intercept_in"
        )
        next_emitter_id = slot.scene_object_id if ta_reemits else emitter_id
        # The amplified beam is the TA's FORWARD emission, so it takes that
        # emission's colour — not the seed's "main".
        next_emission_id = "forward" if ta_reemits else emission_id

        # Transform each out ray back to lab + push to queue
        for out_body in out_rays_body:
            out_dir_lab = dir_body_to_lab_t(out_body.direction, slot.effective_transform)
            # Any op that BENDS the beam (mirror, PBS reflection, AOM order,
            # lens deflection) hands back its transverse state still expressed
            # in the INCOMING beam-local frame. Re-express it once, here, so no
            # op has to remember to — the Jones twin lives inside each op.
            out_rot = out_body.rotated_frame(sp_rotation_between_directions(
                ray_at_anchor.direction, out_body.direction,
            )).rotated_frame(sp_rotation_body_to_lab(
                out_body.direction, out_dir_lab,
                lambda v: dir_body_to_lab_t(v, slot.effective_transform),
            ))
            jones_lab = jones_body_to_lab(
                out_body.jones, out_body.direction, out_dir_lab,
                lambda v: dir_body_to_lab_t(v, slot.effective_transform),
            )
            out_lab = out_body.replaced(
                origin=point_body_to_lab_t(out_body.origin, slot.effective_transform),
                direction=out_dir_lab,
                jones=jones_lab,
                qx=out_rot.qx, qy=out_rot.qy, qxy=out_rot.qxy,
                width_mult_x=out_rot.width_mult_x,
                width_mult_y=out_rot.width_mult_y,
                width_mult_xy=out_rot.width_mult_xy,
                m2x=out_rot.m2x, m2y=out_rot.m2y, m2xy=out_rot.m2xy,
                exclude_face_key=f"{slot.scene_object_id}/{slot.binding_id}/{anchor.id}",
            )
            if out_lab.power_mw < options.power_threshold_mw:
                result.final_rays.append(out_lab)
            else:
                queue.append((
                    out_lab, slot.scene_object_id, next_emitter_id,
                    next_emission_id,
                ))

        total_steps += 1

    return result
