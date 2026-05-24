"""Faraday rotator PhysicsOp (Python mirror of frontend kinds/faraday-rotator/physics.ts).

Op name: faraday_rotate
Kind: faraday_rotator
Required params: rotationDeg (default 45), lengthMm, refractiveIndex (default 1)
Optional: arResidualR (per-face Fresnel), reciprocal (informational)
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.jones import rotate_jones
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    return (A * q + B) / (C * q + D)


def _derive_slab_b(ctx: PhysicsOpContext) -> float:
    """B parameter (q' = q + B for slab) from transition matrix or
    lengthMm / refractiveIndex params, falling back to face separation."""
    tm = ctx.transfer_matrix
    if tm is not None:
        kind = tm[0]
        if kind == "matrix5x5":
            return float(tm[1][0 * 5 + 1])  # type: ignore[index]
        if kind == "abcd":
            return float(tm[1][0][1])       # type: ignore[index]
    L = ctx.params.get("lengthMm")
    n = ctx.params.get("refractiveIndex", 1.0)
    if isinstance(L, (int, float)) and math.isfinite(L) and L > 0:
        return float(L) / float(n)
    return vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )


def faraday_rotate_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    rotation_deg = float(ctx.params.get("rotationDeg", 45.0))
    rotation_rad = math.radians(rotation_deg)

    # Faraday rotation is fixed in LAB frame (around B-field axis ≈ body +z).
    # For reverse-going beams the beam-local p axis flips sign, so to keep
    # the LAB rotation consistent we flip the s/p-frame sign when
    # ray.direction.z < 0. This is what makes the round trip add 2× in lab.
    # `rotate_jones` is a BASIS rotation by +phi (vector rotation by -phi).
    direction_sign = 1.0 if ray_in.direction.z >= 0 else -1.0
    new_jones = rotate_jones(ray_in.jones, -direction_sign * rotation_rad)

    B = _derive_slab_b(ctx)
    qx_out = apply_abcd_to_q(1.0, B, 0.0, 1.0, ray_in.qx)
    qy_out = apply_abcd_to_q(1.0, B, 0.0, 1.0, ray_in.qy)

    ar_r = float(ctx.params.get("arResidualR", 0.0))
    transmittance = (1 - ar_r) * (1 - ar_r)
    new_power = ray_in.power_mw * transmittance

    thickness_mm = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    new_origin = ray_in.origin + ray_in.direction * thickness_mm

    return [ray_in.replaced(
        origin=new_origin,
        jones=new_jones,
        qx=qx_out,
        qy=qy_out,
        power_mw=new_power,
        path_length_mm=ray_in.path_length_mm + thickness_mm,
    )]


register_kind("faraday_rotator", KindEntry(
    ops={"faraday_rotate": faraday_rotate_op},
    needs_aperture=True,
))
