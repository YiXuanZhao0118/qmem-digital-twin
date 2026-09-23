"""Point + direction align — was ``frontend/src/utils/isolatorAlign.ts``.

Rotate a SceneObject so a Component-frame direction lies along a beam (or
against it), optionally rolled about the beam and tilted off it, then
translate so a Component-frame point lands on the beam line. The isolator
case feeds it the front / back polariser centres; every other pass-through
optic feeds it the Component's ``alignSpec`` or its entry anchor (see
``service.resolve_align_point_dir``).

Pure: no DB. Pinned by ``backend/tests/fixtures/align/point_dir.json`` — the
frozen record of what that TypeScript answered, kept after it was deleted
(2026-09-23) and now a one-way regression pin. Changing behaviour here means
re-recording the affected fixture entries deliberately.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.optical.align.anchor_poses import BindingNode
from app.optical.align.frames import (
    AlignPose,
    cad_to_lab,
    scene_object_euler_from_quaternion,
)
from app.optical.align.ts_compat import (
    DEG2RAD,
    V,
    q_from_axis_angle,
    q_from_unit_vectors,
    q_multiply,
    v3_apply_quaternion,
    v3_length,
    v3_length_sq,
    v3_normalize,
    v_neg,
)
from app.optical.pose import V3Pose


@dataclass(frozen=True)
class RoleCentre:
    role: str
    is_sub: bool
    pos_mm: V


@dataclass(frozen=True)
class ExtraTilt:
    """An off-beam tilt applied last, about a Component-frame axis."""

    axis_cad_mm: V
    angle_rad: float


def collect_role_centres(nodes: list[BindingNode], out: list[RoleCentre]) -> None:
    """Every role-labelled binding node's ORIGIN in the Component CAD frame,
    depth first (TS ``collectRoleCentres``). The node transforms are the
    backend's binding chain (``anchor_poses.resolve_binding_tree``), which the
    TS walk (raw XYZ Euler, parent CAD frame) mirrors.

    The role is ``properties.role_label`` (migration-seeded TORNOS / HP) or
    else the binding's own ``role``."""
    for node in nodes:
        props = node.binding.properties if isinstance(node.binding.properties, dict) else {}
        role_label = props.get("role_label")
        role = (role_label if isinstance(role_label, str) and role_label else None) \
            or node.binding.role or ""
        if role:
            o = node.transform.origin
            out.append(RoleCentre(role=role, is_sub=node.target_kind == "subcomponent",
                                  pos_mm=V(o.x, o.y, o.z)))
        if node.children:
            collect_role_centres(node.children, out)


_POLARISER_RE = re.compile(r"glan|pbs|polari")


def pick_polariser_centre(centres: list[RoleCentre], side: str) -> V | None:
    """Front / back polariser centre, never the housing piece (TS
    ``pickPolariserCentre``): exact role == side, else a polariser-ish
    non-"piece" role (or a sub-component), else any sub-component, else the
    first non-"piece" match, else the first match."""
    matches = [c for c in centres if side in c.role.lower()]
    if not matches:
        return None

    def is_piece(c: RoleCentre) -> bool:
        return "piece" in c.role.lower()

    exact = next((c for c in matches if c.role.lower() == side), None)
    if exact is not None:
        return exact.pos_mm
    polariser = next(
        (c for c in matches
         if not is_piece(c) and (c.is_sub or _POLARISER_RE.search(c.role.lower()))),
        None,
    )
    if polariser is not None:
        return polariser.pos_mm
    sub = next((c for c in matches if c.is_sub), None)
    if sub is not None:
        return sub.pos_mm
    return (next((c for c in matches if not is_piece(c)), None) or matches[0]).pos_mm


def compute_isolator_align_pose(
    *,
    front_cad_mm: V,
    back_cad_mm: V,
    scene_object: V3Pose,
    beam_dir: V,
    beam_ref: V,
    reverse: bool = False,
    roll_deg: float | None = None,
) -> AlignPose | None:
    """Front -> back bore parallel to the beam, front centre on it."""
    return compute_point_dir_align_pose(
        point_cad_mm=front_cad_mm,
        dir_cad_mm=V(
            back_cad_mm.x - front_cad_mm.x,
            back_cad_mm.y - front_cad_mm.y,
            back_cad_mm.z - front_cad_mm.z,
        ),
        scene_object=scene_object,
        beam_dir=beam_dir,
        beam_ref=beam_ref,
        reverse=reverse,
        roll_deg=roll_deg,
    )


def compute_point_dir_align_pose(
    *,
    point_cad_mm: V,
    dir_cad_mm: V,
    scene_object: V3Pose,
    beam_dir: V,
    beam_ref: V,
    reverse: bool = False,
    roll_deg: float | None = None,
    extra_tilt: ExtraTilt | None = None,
) -> AlignPose | None:
    """TS ``computePointDirAlignPose``. ``None`` when ``dir_cad_mm`` is
    degenerate (|d| < 1e-6).

    ``reverse`` points the direction along -beam; ``roll_deg`` turns the body
    clockwise about the chosen direction; ``extra_tilt`` (the AOM's Bragg
    stage) tilts it last about a Component-frame axis carried through the
    rotation so far, pivoting on ``point_cad_mm``."""
    if v3_length(dir_cad_mm) < 1e-6:
        return None
    dir_unit = v3_normalize(dir_cad_mm)
    beam_unit = v3_normalize(beam_dir)
    target_dir = v_neg(beam_unit) if reverse else beam_unit

    quat = q_from_unit_vectors(v3_normalize(dir_unit), v3_normalize(target_dir))
    roll = roll_deg * DEG2RAD if roll_deg is not None else 0.0
    if abs(roll) > 1e-9:
        axis = v3_normalize(target_dir)
        quat = q_multiply(q_from_axis_angle(axis, roll), quat)
    if extra_tilt is not None and abs(extra_tilt.angle_rad) > 1e-12:
        tilt_axis = v3_apply_quaternion(v3_normalize(extra_tilt.axis_cad_mm), quat)
        if v3_length_sq(tilt_axis) > 1e-18:
            quat = q_multiply(q_from_axis_angle(tilt_axis, extra_tilt.angle_rad), quat)

    point_lab = cad_to_lab(point_cad_mm, scene_object)
    t = (
        (point_lab.x - beam_ref.x) * beam_unit.x
        + (point_lab.y - beam_ref.y) * beam_unit.y
        + (point_lab.z - beam_ref.z) * beam_unit.z
    )
    foot = V(
        beam_ref.x + beam_unit.x * t,
        beam_ref.y + beam_unit.y * t,
        beam_ref.z + beam_unit.z * t,
    )
    rotated_point = v3_apply_quaternion(point_cad_mm, quat)
    rx, ry, rz = scene_object_euler_from_quaternion(quat)
    return AlignPose(
        x_mm=foot.x - rotated_point.x,
        y_mm=foot.y - rotated_point.y,
        z_mm=foot.z - rotated_point.z,
        rx_deg=rx,
        ry_deg=ry,
        rz_deg=rz,
    )


def compute_translate_only_pose(
    *,
    point_cad_mm: V,
    scene_object: V3Pose,
    beam_dir: V,
    beam_ref: V,
) -> AlignPose:
    """TS ``computeTranslateOnlyPose``: keep the rotation, slide the body so
    ``point_cad_mm`` lands on the beam line (the reflective / pass-through
    re-centre)."""
    beam_unit = v3_normalize(beam_dir)
    point_lab = cad_to_lab(point_cad_mm, scene_object)
    t = (
        (point_lab.x - beam_ref.x) * beam_unit.x
        + (point_lab.y - beam_ref.y) * beam_unit.y
        + (point_lab.z - beam_ref.z) * beam_unit.z
    )
    foot = V(
        beam_ref.x + beam_unit.x * t,
        beam_ref.y + beam_unit.y * t,
        beam_ref.z + beam_unit.z * t,
    )
    return AlignPose(
        x_mm=scene_object.x_mm + (foot.x - point_lab.x),
        y_mm=scene_object.y_mm + (foot.y - point_lab.y),
        z_mm=scene_object.z_mm + (foot.z - point_lab.z),
        rx_deg=scene_object.rx_deg,
        ry_deg=scene_object.ry_deg,
        rz_deg=scene_object.rz_deg,
    )
