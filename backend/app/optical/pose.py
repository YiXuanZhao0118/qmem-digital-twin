"""V3Pose — lab↔body Vec3 transforms (Python mirror of frontend/src/optical/pose.ts).

Uses the SAME Euler convention as frames.ts:

    THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ")

In scipy.Rotation terms (uppercase = intrinsic):

    Rotation.from_euler("YXZ", [rzDeg, rxDeg, -ryDeg], degrees=True)

Frontend / backend numerical parity is enforced by Phase 3b tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.spatial.transform import Rotation

from app.optical.beam_ray import Vec3


@dataclass(frozen=True)
class V3Pose:
    x_mm: float = 0.0
    y_mm: float = 0.0
    z_mm: float = 0.0
    rx_deg: float = 0.0
    ry_deg: float = 0.0
    rz_deg: float = 0.0


def _rotation_of(pose: V3Pose) -> Rotation:
    """Build scipy.Rotation matching THREE.Euler(rx, rz, -ry, 'YXZ')."""
    return Rotation.from_euler(
        "YXZ",
        [pose.rz_deg, pose.rx_deg, -pose.ry_deg],
        degrees=True,
    )


# ---------------------------------------------------------------------------
# Point transforms (include translation)
# ---------------------------------------------------------------------------

def point_lab_to_body(point_lab: Vec3, pose: V3Pose) -> Vec3:
    """p_body = q⁻¹ · (p_lab − origin_lab)."""
    rot = _rotation_of(pose).inv()
    arr = np.array([
        point_lab.x - pose.x_mm,
        point_lab.y - pose.y_mm,
        point_lab.z - pose.z_mm,
    ])
    out = rot.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))


def point_body_to_lab(point_body: Vec3, pose: V3Pose) -> Vec3:
    """p_lab = q · p_body + origin_lab."""
    rot = _rotation_of(pose)
    arr = np.array([point_body.x, point_body.y, point_body.z])
    out = rot.apply(arr)
    return Vec3(
        float(out[0]) + pose.x_mm,
        float(out[1]) + pose.y_mm,
        float(out[2]) + pose.z_mm,
    )


# ---------------------------------------------------------------------------
# Direction transforms (rotation only)
# ---------------------------------------------------------------------------

def dir_lab_to_body(dir_lab: Vec3, pose: V3Pose) -> Vec3:
    rot = _rotation_of(pose).inv()
    arr = np.array([dir_lab.x, dir_lab.y, dir_lab.z])
    out = rot.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))


def dir_body_to_lab(dir_body: Vec3, pose: V3Pose) -> Vec3:
    rot = _rotation_of(pose)
    arr = np.array([dir_body.x, dir_body.y, dir_body.z])
    out = rot.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))


# ---------------------------------------------------------------------------
# V3Transform — quaternion + translation (closed under composition).
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class V3Transform:
    origin: Vec3
    rotation: Rotation = field(default_factory=Rotation.identity)


def pose_to_transform(pose: V3Pose) -> V3Transform:
    return V3Transform(
        origin=Vec3(pose.x_mm, pose.y_mm, pose.z_mm),
        rotation=_rotation_of(pose),
    )


def identity_transform() -> V3Transform:
    return V3Transform(origin=Vec3(0, 0, 0), rotation=Rotation.identity())


def compose_transforms(parent: V3Transform, child: V3Transform) -> V3Transform:
    """parent ∘ child:  p_lab = parent.q · (child.q · p_child + child.origin) + parent.origin.

    composed.rotation = parent.q * child.q  (parent applied after child)
    composed.origin   = parent.q · child.origin + parent.origin
    """
    composed_rot = parent.rotation * child.rotation
    child_origin_rot = parent.rotation.apply(
        np.array([child.origin.x, child.origin.y, child.origin.z])
    )
    return V3Transform(
        origin=Vec3(
            float(child_origin_rot[0]) + parent.origin.x,
            float(child_origin_rot[1]) + parent.origin.y,
            float(child_origin_rot[2]) + parent.origin.z,
        ),
        rotation=composed_rot,
    )


def point_lab_to_body_t(point_lab: Vec3, t: V3Transform) -> Vec3:
    inv = t.rotation.inv()
    arr = np.array([
        point_lab.x - t.origin.x,
        point_lab.y - t.origin.y,
        point_lab.z - t.origin.z,
    ])
    out = inv.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))


def point_body_to_lab_t(point_body: Vec3, t: V3Transform) -> Vec3:
    arr = np.array([point_body.x, point_body.y, point_body.z])
    out = t.rotation.apply(arr)
    return Vec3(
        float(out[0]) + t.origin.x,
        float(out[1]) + t.origin.y,
        float(out[2]) + t.origin.z,
    )


def dir_lab_to_body_t(dir_lab: Vec3, t: V3Transform) -> Vec3:
    inv = t.rotation.inv()
    arr = np.array([dir_lab.x, dir_lab.y, dir_lab.z])
    out = inv.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))


def dir_body_to_lab_t(dir_body: Vec3, t: V3Transform) -> Vec3:
    arr = np.array([dir_body.x, dir_body.y, dir_body.z])
    out = t.rotation.apply(arr)
    return Vec3(float(out[0]), float(out[1]), float(out[2]))
