"""Polarizer PhysicsOp (Python mirror of frontend kinds/polarizer/physics.ts).

Op name: jones_polarizer
Kind: polarizer
Required params: transmissionAxisDegBeamLocal (defaults 0)
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def apply_linear_polarizer(
    jones: tuple[complex, complex], theta_rad: float
) -> tuple[complex, complex]:
    """J(theta) = [[c², cs], [cs, s²]]  applied to (E_s, E_p)."""
    c = math.cos(theta_rad)
    s = math.sin(theta_rad)
    cc, cs, ss = c * c, c * s, s * s
    e_s, e_p = jones
    return (cc * e_s + cs * e_p, cs * e_s + ss * e_p)


def _jones_mag_sq(jones: tuple[complex, complex]) -> float:
    e_s, e_p = jones
    return (e_s.real * e_s.real + e_s.imag * e_s.imag
            + e_p.real * e_p.real + e_p.imag * e_p.imag)


def jones_polarizer_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    axis_deg = float(
        ctx.params.get("transmissionAxisDegBeamLocal")
        or ctx.params.get("transmissionAxisDegBodyLocal")
        or 0.0
    )
    theta = math.radians(axis_deg)

    jones_proj = apply_linear_polarizer(ray_in.jones, theta)
    mag_sq_in = _jones_mag_sq(ray_in.jones)
    mag_sq_out = _jones_mag_sq(jones_proj)

    t = mag_sq_out / mag_sq_in if mag_sq_in > 1e-30 else 0.0
    new_power = ray_in.power_mw * t

    if mag_sq_out > 1e-30:
        norm = 1.0 / math.sqrt(mag_sq_out)
        new_jones = (jones_proj[0] * norm, jones_proj[1] * norm)
    else:
        new_jones = ray_in.jones

    thickness_mm = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    new_origin = ray_in.origin + ray_in.direction * thickness_mm

    return [ray_in.replaced(
        origin=new_origin,
        jones=new_jones,
        power_mw=new_power,
        path_length_mm=ray_in.path_length_mm + thickness_mm,
    )]


register_kind("polarizer", KindEntry(
    ops={"jones_polarizer": jones_polarizer_op},
    needs_aperture=True,
))
