"""AOM Bragg positioning — was ``frontend/src/utils/aomAlign.ts``.

Body frame (MT80-A1.5-IR in brackets): D1 = optical axis = intercept_out -
intercept_in [+Y]; D2 = acoustic axis (``acoustic_axis`` anchor, else the
``rfPropagationDirectionBodyLocal`` / ``acousticAxisBodyLocal`` param),
re-orthogonalised against D1 [-X]; D3 = D1 x D2, the Bragg rotation axis [+Z].

Two stages: (1) the interaction centre on the beam with D1 along +/-beam —
the ordinary point + direction align; (2) a ``+m * theta_B`` turn about D3
around that centre (CONV-2, lab-fixed: "+1" always tilts the same way, so a
cell run backwards Bragg-matches -m, which ``aom_bragg_readout`` reports).
See ``docs/aom-model.md`` and the AOM align section of
``docs/introduce/component.md``.

The efficiency numbers come from the backend's own AOM physics
(``aom_physics.acoustic_incidence_rad`` / ``bragg_matched_incidence_rad`` /
``bragg_order_detune``) — the functions the tracer's AOM op runs, and which
``frontend/src/optical/kinds/aom/physics.ts`` mirrors.

Pure (no DB). Pinned to the TypeScript by
``backend/tests/fixtures/align/aom_bragg.json``.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.optical.align.anchor_poses import anchor_primary_dir
from app.optical.align.frames import (
    AlignPose,
    cad_to_lab,
    rotate_lab_dir,
    scene_object_euler_from_quaternion,
    scene_object_to_quaternion,
)
from app.optical.align.point_dir import ExtraTilt, compute_point_dir_align_pose
from app.optical.align.ts_compat import (
    V,
    js_round,
    q_from_axis_angle,
    q_multiply,
    read_xyz,
    v3_apply_quaternion,
    v3_normalize,
)
from app.optical.aom_physics import (
    acoustic_incidence_rad,
    bragg_matched_incidence_rad,
    bragg_order_detune,
)
from app.optical.pose import V3Pose


@dataclass(frozen=True)
class AomBraggFrame:
    """Body/CAD-frame Bragg triad + the interaction centre (the pivot)."""

    D1: V
    D2: V
    D3: V
    centre_mm: V


def _unit(v: V) -> V | None:
    m = math.hypot(v.x, v.y, v.z)
    return None if m < 1e-9 else V(v.x / m, v.y / m, v.z / m)


def _cross(a: V, b: V) -> V:
    return V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)


def _dot(a: V, b: V) -> float:
    return a.x * b.x + a.y * b.y + a.z * b.z


def _read_vec3(raw: Any) -> V | None:
    """The TS ``readVec3``: a >= 3-element array of finite numbers, or an
    ``{x, y, z}`` object."""
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        head = raw[:3]
        if all(isinstance(n, (int, float)) and not isinstance(n, bool) and math.isfinite(n) for n in head):
            return V(float(head[0]), float(head[1]), float(head[2]))
    return read_xyz(raw)


def resolve_aom_bragg_frame(anchors: list[dict] | None, default_params: dict | None) -> AomBraggFrame | None:
    """TS ``resolveAomBraggFrame(asset)`` from the asset's ``anchors`` and
    ``default_params``. ``None`` without an intercept pair or a usable
    acoustic direction."""
    anchors = [a for a in (anchors or []) if isinstance(a, dict)]
    in_anchor = next((a for a in anchors if a.get("id") == "intercept_in"), None)
    out_anchor = next((a for a in anchors if a.get("id") == "intercept_out"), None)
    if in_anchor is None or out_anchor is None:
        return None
    p_in = read_xyz(in_anchor.get("positionMmBodyLocal"))
    p_out = read_xyz(out_anchor.get("positionMmBodyLocal"))
    if p_in is None or p_out is None:
        return None
    d1 = _unit(V(p_out.x - p_in.x, p_out.y - p_in.y, p_out.z - p_in.z))
    if d1 is None:
        return None

    acoustic_anchor = next((a for a in anchors if a.get("id") == "acoustic_axis"), None)
    params = default_params if isinstance(default_params, dict) else {}
    raw = anchor_primary_dir(acoustic_anchor) if acoustic_anchor is not None else None
    if raw is None:
        raw = _read_vec3(params.get("rfPropagationDirectionBodyLocal"))
    if raw is None:
        raw = _read_vec3(params.get("acousticAxisBodyLocal"))
    acoustic = _unit(raw) if raw is not None else None
    if acoustic is None:
        return None

    par = _dot(acoustic, d1)
    d2 = _unit(V(acoustic.x - d1.x * par, acoustic.y - d1.y * par, acoustic.z - d1.z * par))
    if d2 is None:
        return None
    d3 = _unit(_cross(d1, d2))
    if d3 is None:
        return None
    return AomBraggFrame(
        D1=d1,
        D2=d2,
        D3=d3,
        centre_mm=V((p_in.x + p_out.x) / 2, (p_in.y + p_out.y) / 2, (p_in.z + p_out.z) / 2),
    )


def bragg_tilt_rad(order: int, theta_b_rad: float) -> float:
    """Stage-2 rotation for ``order`` under CONV-2: ``+m * theta_B``."""
    return order * theta_b_rad


def compute_aom_bragg_align_pose(
    *,
    frame: AomBraggFrame,
    scene_object: V3Pose,
    beam_dir: V,
    beam_ref: V,
    reverse: bool = False,
    roll_deg: float | None = None,
    tilt_rad: float,
) -> AlignPose | None:
    """Stage 1 + stage 2. ``tilt_rad`` is the FULL stage-2 angle
    (``bragg_tilt_rad(order, theta_B)`` + fine tune)."""
    return compute_point_dir_align_pose(
        point_cad_mm=frame.centre_mm,
        dir_cad_mm=frame.D1,
        scene_object=scene_object,
        beam_dir=beam_dir,
        beam_ref=beam_ref,
        reverse=reverse,
        roll_deg=roll_deg,
        extra_tilt=ExtraTilt(axis_cad_mm=frame.D3, angle_rad=tilt_rad),
    )


def compute_aom_tilt_nudge_pose(*, frame: AomBraggFrame, scene_object: V3Pose, delta_rad: float) -> AlignPose:
    """Turn the CURRENT pose by ``delta_rad`` about the lab-frame D3,
    pivoting on the interaction centre (the software rotation stage)."""
    axis_lab = rotate_lab_dir(frame.D3, scene_object)
    axis = v3_normalize(axis_lab)
    delta = q_from_axis_angle(axis, delta_rad)
    quat = q_multiply(delta, scene_object_to_quaternion(scene_object))

    pivot = cad_to_lab(frame.centre_mm, scene_object)
    arm = v3_apply_quaternion(
        V(pivot.x - scene_object.x_mm, pivot.y - scene_object.y_mm, pivot.z - scene_object.z_mm),
        delta,
    )
    rx, ry, rz = scene_object_euler_from_quaternion(quat)
    return AlignPose(
        x_mm=pivot.x - arm.x,
        y_mm=pivot.y - arm.y,
        z_mm=pivot.z - arm.z,
        rx_deg=rx,
        ry_deg=ry,
        rz_deg=rz,
    )


@dataclass(frozen=True)
class AomOrderReadout:
    order: int
    mismatch_rad: float
    phase_match: float


@dataclass(frozen=True)
class AomBraggReadout:
    theta_in_rad: float
    matched_order: int
    orders: list[AomOrderReadout]


def aom_bragg_readout(
    *,
    frame: AomBraggFrame,
    scene_object: V3Pose,
    beam_dir: V,
    theta_b_rad: float,
    wavelength_nm: float,
    freq_mhz: float,
    acoustic_velocity_mps: float,
    refractive_index: float,
    crystal_length_mm: float,
    orders: list[int] | None = None,
) -> AomBraggReadout | None:
    """Where the pose sits against the Bragg condition, measured from the
    geometry (so a hand-dragged cell reads correctly too)."""
    beam = _unit(beam_dir)
    if beam is None:
        return None
    theta_in = acoustic_incidence_rad(
        tuple(beam),
        tuple(rotate_lab_dir(frame.D2, scene_object)),
        tuple(rotate_lab_dir(frame.D1, scene_object)),
    )
    if theta_in is None:
        return None
    readouts = [
        AomOrderReadout(
            order=order,
            mismatch_rad=theta_in - bragg_matched_incidence_rad(order, theta_b_rad),
            phase_match=bragg_order_detune(
                order, theta_in, theta_b_rad, wavelength_nm, freq_mhz,
                acoustic_velocity_mps, refractive_index, crystal_length_mm,
            ),
        )
        for order in (orders if orders is not None else [1, -1])
    ]
    matched = js_round(-theta_in / theta_b_rad) if theta_b_rad > 0 else 0
    return AomBraggReadout(theta_in_rad=theta_in, matched_order=matched, orders=readouts)
