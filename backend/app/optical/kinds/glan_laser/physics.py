"""Glan-Laser Calcite Prism PhysicsOps (Python mirror of
frontend/src/optical/kinds/glan-laser/physics.ts).

Physically-correct multi-hop topology (see asset-physics-model.md §3.3):

  Faces:  A1 (input), A2 (transmit out), A3 (reject side exit),
          B1, B2 (gap interfaces — real surface normals)
  Transitions:
    A1 → A2  via [B1, B2]   op = glan_transmit_p   (p Snell across gap)
    A1 → A3  via [B1]       op = glan_reject_s     (s TIR at gap, Snell at A3)
    A2 → A1  via [B2, B1]   op = glan_transmit_p   (reverse p)
    A2 → A3  via [B2]       op = glan_reject_s     (reverse reject, rarely fired)

Polarization: o-ray (s-pol) undergoes TIR at the air gap, e-ray (p-pol)
transmits. Exit direction at A3 emerges from mirror+Snell — NOT hard-coded.
Registers ops under "pbs" kind via register_ops.
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.geometry import reflect, refract
# Force pbs (host kind) and polarizer (provides apply_linear_polarizer
# helper) to register before we add ops.
from app.optical.kinds import pbs  # noqa: F401
from app.optical.kinds import polarizer  # noqa: F401
from app.optical.kinds.polarizer.physics import apply_linear_polarizer
from app.optical.registry import (
    PhysicsOpContext,
    register_ops,
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


def glan_transmit_p_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    """p polarization transmits through both gap surfaces (B1, B2). For
    a thin parallel-plate gap, the two Snell refractions cancel and the
    beam exits A2 parallel to A1 with only a small lateral shift —
    encoded in the 5×5 matrix via E_x / B_x corrections.
    """
    jones, power = _project_and_update(ray_in.jones, ray_in.power_mw, 0.0)

    bx = by = 0.0
    if ctx.transfer_matrix is not None and ctx.transfer_matrix[0] == "matrix5x5":
        flat = ctx.transfer_matrix[1]
        if isinstance(flat[0], (list, tuple)):
            M = flat
            bx = float(M[0][1])
            by = float(M[2][3])
        else:
            bx = float(flat[0 * 5 + 1])
            by = float(flat[2 * 5 + 3])
    else:
        L = ctx.params.get("lengthMm")
        if not isinstance(L, (int, float)):
            L = vec3_distance(
                ctx.face_in.position_mm_body_local,
                ctx.face_out.position_mm_body_local,
            )
        ne = float(
            ctx.params.get("refractiveIndex_e")
            or ctx.params.get("refractiveIndex", 1.48)
        )
        bx = float(L) / ne
        by = float(L) / ne

    qx_out = _apply_abcd_to_q(1, bx, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, by, 0, 1, ray_in.qy)

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


def glan_reject_s_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    """s polarization undergoes TIR at B1 (gap interface), then refracts
    through A3 (side exit) into air. Output direction emerges from
    mirror+Snell using the *actual* B1 and A3 surface normals."""
    jones, power = _project_and_update(ray_in.jones, ray_in.power_mw, 90.0)

    if not ctx.face_via:
        raise ValueError(
            "glan_reject_s: transition.via must include the gap interface "
            "(typically [B1]); see asset-physics-model.md §3.3"
        )
    b1 = ctx.face_via[0]
    if b1.normal_body_local is None:
        raise ValueError(f"glan_reject_s: face '{b1.id}' missing normal")
    if ctx.face_out.normal_body_local is None:
        raise ValueError(f"glan_reject_s: face '{ctx.face_out.id}' missing normal")

    # 1) TIR reflect at the gap (beam still in crystal).
    dir_in_crystal = reflect(ray_in.direction, b1.normal_body_local)

    # 2) Snell-refract through A3 from crystal (n_o for o-ray = s pol) to air.
    # Calcite o-ray index ≈ 1.66 (vs n_e ≈ 1.48 for e-ray which transmits via B1+B2).
    n_o = float(ctx.params.get("refractiveIndex_o", 1.66))
    dir_air = refract(dir_in_crystal, ctx.face_out.normal_body_local, n_o, 1.0)

    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        direction=dir_air,
        jones=jones,
        power_mw=power,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_ops("pbs", {
    "glan_transmit_p": glan_transmit_p_op,
    "glan_reject_s": glan_reject_s_op,
})
