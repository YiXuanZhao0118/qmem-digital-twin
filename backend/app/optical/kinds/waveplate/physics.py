"""Waveplate PhysicsOp (Python mirror of frontend/src/optical/kinds/waveplate/physics.ts).

Op name: jones_waveplate
Kind: waveplate
Params:
  - retardanceDeg (default 90 = QWP). HWP: 180.
  - fastAxisDegBeamLocal (default 0)
  - lengthMm, refractiveIndex (for slab q propagation)

Jones matrix: J(δ, θ) = R(-θ) · diag(1, e^(iδ)) · R(θ)
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


def _apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    return (A * q + B) / (C * q + D)


def apply_waveplate(
    jones: tuple[complex, complex],
    retardance_rad: float,
    fast_axis_rad: float,
) -> tuple[complex, complex]:
    """J(δ, θ) = R(-θ) · diag(1, e^iδ) · R(θ) applied to (E_s, E_p)."""
    # 1. Rotate s/p → fast/slow
    e_f, e_sl = rotate_jones(jones, fast_axis_rad)
    # 2. Phase delay on slow axis
    phase_slow = complex(math.cos(retardance_rad), math.sin(retardance_rad))
    e_sl_shifted = phase_slow * e_sl
    # 3. Rotate fast/slow → s/p
    return rotate_jones((e_f, e_sl_shifted), -fast_axis_rad)


def jones_waveplate_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    ret_deg = float(ctx.params.get("retardanceDeg", 90.0))
    retardance_rad = math.radians(ret_deg)
    fast_deg = float(
        ctx.params.get("fastAxisDegBeamLocal")
        or ctx.params.get("fastAxisDegBodyLocal")
        or 0.0
    )
    fast_axis_rad = math.radians(fast_deg)

    new_jones = apply_waveplate(ray_in.jones, retardance_rad, fast_axis_rad)

    L = ctx.params.get("lengthMm", ctx.params.get("thicknessMm"))
    n = float(ctx.params.get("refractiveIndex", 1.0))
    if isinstance(L, (int, float)) and L > 0:
        B = float(L) / n
    else:
        B = vec3_distance(
            ctx.face_in.position_mm_body_local,
            ctx.face_out.position_mm_body_local,
        )

    qx_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qy)

    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    new_origin = ray_in.origin + ray_in.direction * thickness

    return [ray_in.replaced(
        origin=new_origin,
        jones=new_jones,
        qx=qx_out,
        qy=qy_out,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("waveplate", KindEntry(
    ops={"jones_waveplate": jones_waveplate_op},
    needs_aperture=True,
))
