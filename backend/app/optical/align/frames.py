"""SceneObject pose <-> quaternion / Euler, for the align ports.

Two jobs, kept apart on purpose:

* **Placing a point or direction** under a SceneObject pose (``cad_to_lab``,
  ``rotate_lab_dir``) goes through the backend's OWN transform chain,
  ``app.optical.pose`` — the same code the tracer places anchors with. The
  frontend's ``frames.rotateLabDir`` is the same matrix, and
  ``docs/introduce/anchors.md`` pins the two to each other; using the
  backend's copy here means an align solved on the backend lands exactly
  where the backend's tracer will look.
* **Synthesising a new pose** (quaternion algebra, then Euler) mirrors
  ``frontend/src/optical/frames.ts`` line for line (``sceneObjectToQuaternion``
  / ``sceneObjectEulerFromQuaternion``), because the decomposition is branchy
  (the gimbal test) and the TS is what the parity fixtures pin.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from app.optical.align.ts_compat import (
    DEG2RAD,
    RAD2DEG,
    V,
    Quat,
    m4_rotation_elements,
    q_from_rotation_matrix,
    q_normalize,
)
from app.optical.beam_ray import Vec3
from app.optical.pose import V3Pose, dir_body_to_lab, point_body_to_lab
from app.pose_quantize import quantize_deg


@dataclass(frozen=True)
class AlignPose:
    """A proposed SceneObject pose — the TS ``AlignPose`` (lab mm / deg)."""

    x_mm: float
    y_mm: float
    z_mm: float
    rx_deg: float
    ry_deg: float
    rz_deg: float

    def as_v3_pose(self) -> V3Pose:
        return V3Pose(
            x_mm=self.x_mm, y_mm=self.y_mm, z_mm=self.z_mm,
            rx_deg=self.rx_deg, ry_deg=self.ry_deg, rz_deg=self.rz_deg,
        )


def cad_to_lab(cad: V, pose: V3Pose) -> V:
    """Component CAD-frame point -> lab mm (the TS ``cadToLab``),
    via the backend's ``pose.point_body_to_lab``."""
    p = point_body_to_lab(Vec3(cad.x, cad.y, cad.z), pose)
    return V(p.x, p.y, p.z)


def rotate_lab_dir(d: V, pose: V3Pose) -> V:
    """Component CAD-frame direction -> lab (TS ``frames.rotateLabDir``), via
    the backend's ``pose.dir_body_to_lab``."""
    r = dir_body_to_lab(Vec3(d.x, d.y, d.z), pose)
    return V(r.x, r.y, r.z)


def scene_object_to_quaternion(pose: V3Pose) -> Quat:
    """``frames.sceneObjectToQuaternion``: the documented XYZ row matrix,
    transposed for column vectors, through ``setFromRotationMatrix``."""
    alpha = pose.rx_deg * DEG2RAD
    beta = pose.ry_deg * DEG2RAD
    gamma = pose.rz_deg * DEG2RAD
    ca = math.cos(alpha)
    sa = math.sin(alpha)
    cb = math.cos(beta)
    sb = math.sin(beta)
    cg = math.cos(gamma)
    sg = math.sin(gamma)
    return q_from_rotation_matrix(
        cb * cg, sa * sb * cg + ca * sg, -ca * sb * cg + sa * sg,
        -cb * sg, -sa * sb * sg + ca * cg, ca * sb * sg + sa * cg,
        sb, -sa * cb, ca * cb,
    )


# ``frames.GIMBAL_COS_TOL``: below this |cos ry| the matrix does not say how
# the pole's free angle splits between rx and rz, so rz is pinned to 0 (moves
# the orientation by at most pi*tol ~ 3e-15 rad).
GIMBAL_COS_TOL = 4 * 2.0 ** -52


def scene_object_euler_rad_from_quaternion(q: Quat) -> tuple[float, float, float]:
    """``frames.sceneObjectEulerRadFromQuaternion``: ``(alpha, beta, gamma)``
    in radians, unquantized, conditioned for the pole.

    ``beta = atan2(r20, hypot(r00, r10))`` is well-conditioned everywhere
    (``asin(r20)``, used until 2026-09-22, lost half the digits at +-90 deg);
    ``gamma`` comes from the entries of size cos(beta), pinned to 0 at the
    pole; ``alpha`` from the O(1) entries GIVEN gamma, through the exact
    identities ``sin a = sin g*r02 + cos g*r12`` and ``cos a = sin g*r01 +
    cos g*r11`` — so it absorbs whatever gamma cannot resolve and the
    recomposed rotation equals the input to rounding."""
    te = m4_rotation_elements(q_normalize(q))
    r00 = te[0]
    r10 = te[1]
    r20 = te[2]
    r01 = te[4]
    r11 = te[5]
    r02 = te[8]
    r12 = te[9]

    cb = math.hypot(r00, r10)
    beta = math.atan2(r20, cb)
    gamma = math.atan2(-r10, r00) if cb > GIMBAL_COS_TOL else 0.0
    sg = math.sin(gamma)
    cg = math.cos(gamma)
    alpha = math.atan2(sg * r02 + cg * r12, sg * r01 + cg * r11)
    return alpha, beta, gamma


def scene_object_euler_from_quaternion(q: Quat) -> tuple[float, float, float]:
    """``frames.sceneObjectEulerFromQuaternion`` -> quantized
    ``(rx_deg, ry_deg, rz_deg)`` (see
    :func:`scene_object_euler_rad_from_quaternion` for the pole)."""
    alpha, beta, gamma = scene_object_euler_rad_from_quaternion(q)
    return (
        quantize_deg(alpha * RAD2DEG),
        quantize_deg(beta * RAD2DEG),
        quantize_deg(gamma * RAD2DEG),
    )
