"""PBS (Polarizing Beam Splitter) PhysicsOps (Python mirror of
frontend/src/optical/kinds/pbs/physics.ts).

Multi-hop topology (see asset-physics-model.md §3.3):

  Faces:  A1..A4 external (back/front/left/right cube faces),
          B1 internal Brewster plate (45° diagonal)
  Transitions:
    A1 → A_opposite via [B1]   pbs_transmit_p   (p through plate)
    A1 → A_side     via [B1]   pbs_reflect_s    (s mirror reflect at B1)

pbs_reflect_s computes exit direction via mirror formula
``k_out = k_in − 2(k·n̂_B1)n̂_B1`` using face_via[0]'s real surface normal.
The single-plate geometry pairs back↔front and left↔right for transmit,
back↔right (+ front↔left) for reflect with one plate orientation.
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.geometry import reflect
from app.optical.kinds.polarizer.physics import apply_linear_polarizer
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def _apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    return (A * q + B) / (C * q + D)


def _jones_mag_sq(jones: tuple[complex, complex]) -> float:
    e_s, e_p = jones
    return (e_s.real * e_s.real + e_s.imag * e_s.imag
            + e_p.real * e_p.real + e_p.imag * e_p.imag)


def _project_and_update(
    jones_in: tuple[complex, complex], power_in: float, axis_deg_beam_local: float,
) -> tuple[tuple[complex, complex], float]:
    projected = apply_linear_polarizer(jones_in, math.radians(axis_deg_beam_local))
    mag_in = _jones_mag_sq(jones_in)
    mag_out = _jones_mag_sq(projected)
    t = mag_out / mag_in if mag_in > 1e-30 else 0.0
    power = power_in * t
    if mag_out > 1e-30:
        norm = 1.0 / math.sqrt(mag_out)
        return (projected[0] * norm, projected[1] * norm), power
    return jones_in, power


def _slab_b(ctx: PhysicsOpContext) -> float:
    d = ctx.params.get("cubeSizeMm")
    if not isinstance(d, (int, float)):
        d = vec3_distance(
            ctx.face_in.position_mm_body_local,
            ctx.face_out.position_mm_body_local,
        )
    n = float(ctx.params.get("refractiveIndex", 1.5168))
    return float(d) / n


def pbs_transmit_p_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    jones, power = _project_and_update(ray_in.jones, ray_in.power_mw, 0.0)
    B = _slab_b(ctx)
    qx_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qy)
    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        jones=jones,
        qx=qx_out,
        qy=qy_out,
        power_mw=power,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


def pbs_reflect_s_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    """s polarization reflects off the internal Brewster plate (B1).
    Exit direction computed via mirror formula on B1's real surface normal.
    """
    jones, power = _project_and_update(ray_in.jones, ray_in.power_mw, 90.0)
    B = _slab_b(ctx)
    qx_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qy)

    if not ctx.face_via:
        raise ValueError(
            "pbs_reflect_s: transition.via must include the internal Brewster "
            "plate (typically [B1]); see asset-physics-model.md §3.3"
        )
    b1 = ctx.face_via[0]
    if b1.normal_body_local is None:
        raise ValueError(f"pbs_reflect_s: face '{b1.id}' missing normal")

    dir_out = reflect(ray_in.direction, b1.normal_body_local)

    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        direction=dir_out,
        jones=jones,
        qx=qx_out,
        qy=qy_out,
        power_mw=power,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("pbs", KindEntry(
    ops={
        "pbs_transmit_p": pbs_transmit_p_op,
        "pbs_reflect_s": pbs_reflect_s_op,
    },
    needs_aperture=True,
))
