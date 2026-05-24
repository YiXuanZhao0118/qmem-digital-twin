"""Lens PhysicsOp (Python mirror of frontend/src/optical/kinds/lens/physics.ts).

Op name: abcd_thin_lens
Kind: lens
Required params: focalLengthMm
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.registry import (
    KindEntry,
    PhysicsOp,
    PhysicsOpContext,
    register_kind,
)
from app.solvers.generalized_abcd import m_thin_lens


def apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    """q_out = (A*q + B) / (C*q + D)."""
    return (A * q + B) / (C * q + D)


def abcd_thin_lens_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    # Prefer the transition's explicit 5x5 matrix when supplied — this is
    # how plano-convex lenses encode their direction-aware thick-lens
    # matrices (convex→flat vs flat→convex produce different BFL).
    M = None
    if ctx.transfer_matrix is not None and ctx.transfer_matrix[0] == "matrix5x5":
        flat = ctx.transfer_matrix[1]
        import numpy as np
        # Accept either flat list-of-25 (row-major) or list-of-5-rows.
        if isinstance(flat[0], (list, tuple)):
            M = np.array(flat, dtype=float)
        else:
            M = np.array(flat, dtype=float).reshape(5, 5)
    if M is None:
        focal_mm = ctx.params.get("focalLengthMm") or ctx.params.get("focalMm")
        if not isinstance(focal_mm, (int, float)) or not math.isfinite(focal_mm) or focal_mm == 0:
            raise ValueError(
                f"abcd_thin_lens: needs transition matrix5x5 OR valid focalLengthMm; got {focal_mm!r}"
            )
        M = m_thin_lens(float(focal_mm))
    # x sub-block (rows 0/1, cols 0/1)
    Ax, Bx = M[0, 0], M[0, 1]
    Cx, Dx = M[1, 0], M[1, 1]
    # y sub-block (rows 2/3, cols 2/3)
    Ay, By = M[2, 2], M[2, 3]
    Cy, Dy = M[3, 2], M[3, 3]

    qx_out = apply_abcd_to_q(Ax, Bx, Cx, Dx, ray_in.qx)
    qy_out = apply_abcd_to_q(Ay, By, Cy, Dy, ray_in.qy)

    # Propagate chief ray from face_in to face_out (thin-lens approximation).
    thickness_mm = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    new_origin = ray_in.origin + ray_in.direction * thickness_mm

    return [ray_in.replaced(
        origin=new_origin,
        qx=qx_out,
        qy=qy_out,
        path_length_mm=ray_in.path_length_mm + thickness_mm,
    )]


# Registration (runs on import of this module)
register_kind("lens", KindEntry(
    ops={"abcd_thin_lens": abcd_thin_lens_op},
    needs_aperture=True,
))
