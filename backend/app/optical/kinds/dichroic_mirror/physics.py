"""Dichroic mirror PhysicsOps (Python mirror of frontend kinds/dichroic-mirror/physics.ts).

Ops: dichroic_transmit (λ < cutoff: pass), dichroic_reflect (λ > cutoff: reflect).
Asset declares both transitions; tracer fires both per hit and T(λ)
determines the power split.

Params:
  cutoffWavelengthNm (default 700)
  isShortPass (default True)
  transitionWidthNm (default 0 = hard edge)
  substrateThicknessMm (default 6), refractiveIndex (default 1.4585)
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, Vec3, vec3_distance
from app.optical.geometry import reflect as _reflect_direction
from app.optical.jones import rotate_jones_into_new_frame
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def _apply_abcd_to_q(A: float, B: float, C: float, D: float, q: complex) -> complex:
    return (A * q + B) / (C * q + D)


def transmittance(
    lambda_nm: float,
    cutoff_nm: float,
    is_short_pass: bool,
    transition_width_nm: float = 0.0,
) -> float:
    if transition_width_nm <= 0:
        if is_short_pass:
            return 1.0 if lambda_nm < cutoff_nm else 0.0
        return 1.0 if lambda_nm > cutoff_nm else 0.0
    x = (lambda_nm - cutoff_nm) / transition_width_nm
    sigmoid = 1.0 / (1.0 + math.exp(4 * x))
    return sigmoid if is_short_pass else 1.0 - sigmoid


def _read_dichroic_params(ctx: PhysicsOpContext) -> tuple[float, bool, float]:
    return (
        float(ctx.params.get("cutoffWavelengthNm", 700)),
        bool(ctx.params.get("isShortPass", True)),
        float(ctx.params.get("transitionWidthNm", 0)),
    )


def _slab_b(ctx: PhysicsOpContext) -> float:
    L = float(ctx.params.get("substrateThicknessMm", 6))
    n = float(ctx.params.get("refractiveIndex", 1.4585))
    return L / n


def dichroic_transmit_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    cutoff, short_pass, width = _read_dichroic_params(ctx)
    T = transmittance(ray_in.wavelength_nm, cutoff, short_pass, width)
    new_power = ray_in.power_mw * T

    B = _slab_b(ctx)
    qx_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qy)

    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        qx=qx_out,
        qy=qy_out,
        power_mw=new_power,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


def dichroic_reflect_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    """λ < cutoff fraction reflects off internal dichroic coating B1.
    Exit direction = mirror formula on B1's real surface normal (typically
    at 45° from optical axis). See asset-physics-model.md §3.3.
    """
    cutoff, short_pass, width = _read_dichroic_params(ctx)
    T = transmittance(ray_in.wavelength_nm, cutoff, short_pass, width)
    new_power = ray_in.power_mw * (1.0 - T)

    if not ctx.face_via:
        raise ValueError(
            "dichroic_reflect: transition.via must include the internal coating "
            "(typically [B1]); see asset-physics-model.md §3.3"
        )
    b1 = ctx.face_via[0]
    if b1.normal_body_local is None:
        raise ValueError(f"dichroic_reflect: face '{b1.id}' missing normal")

    dir_out = _reflect_direction(ray_in.direction, b1.normal_body_local)
    new_jones = rotate_jones_into_new_frame(ray_in.jones, ray_in.direction, dir_out)

    B = _slab_b(ctx)
    qx_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qx)
    qy_out = _apply_abcd_to_q(1, B, 0, 1, ray_in.qy)

    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )

    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        direction=dir_out,
        jones=new_jones,
        qx=qx_out,
        qy=qy_out,
        power_mw=new_power,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("dichroic_mirror", KindEntry(
    ops={
        "dichroic_transmit": dichroic_transmit_op,
        "dichroic_reflect": dichroic_reflect_op,
    },
    needs_aperture=True,
))
