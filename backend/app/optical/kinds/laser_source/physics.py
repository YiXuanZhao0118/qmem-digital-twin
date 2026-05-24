"""Laser source v3 PhysicsOp (Python mirror of frontend kind).

Op name: emit_laser_source
Kind: laser_source

A laser source is a scene emitter, not a passive element. Its Asset3D should
expose one optical face, normally ``out``; the face normal is the emitted
chief-ray direction in asset body coordinates.
"""

from __future__ import annotations

import math
from typing import Optional

from app.optical.beam_ray import BeamRay, Vec3, q_at_waist
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def _finite_number(value) -> Optional[float]:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def _positive_finite_number(value) -> Optional[float]:
    n = _finite_number(value)
    if n is not None and n > 0:
        return n
    return None


def _read_path(obj, path: list[str]):
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _first_positive(ctx: PhysicsOpContext, paths: list[list[str]], fallback: float) -> float:
    dynamic = ctx.dynamic or {}
    for path in paths:
        d = _positive_finite_number(_read_path(dynamic, path))
        if d is not None:
            return d
    for path in paths:
        p = _positive_finite_number(_read_path(ctx.params, path))
        if p is not None:
            return p
    return fallback


def _first_finite(ctx: PhysicsOpContext, paths: list[list[str]], fallback: float) -> float:
    dynamic = ctx.dynamic or {}
    for path in paths:
        d = _finite_number(_read_path(dynamic, path))
        if d is not None:
            return d
    for path in paths:
        p = _finite_number(_read_path(ctx.params, path))
        if p is not None:
            return p
    return fallback


def _complex_from_unknown(value) -> Optional[complex]:
    if not isinstance(value, dict):
        return None
    re = _finite_number(value.get("re"))
    im = _finite_number(value.get("im")) or 0.0
    if re is None:
        return None
    return complex(re, im)


def _jones_from_unknown(value) -> Optional[tuple[complex, complex]]:
    if isinstance(value, list) and len(value) >= 2:
        a = _complex_from_unknown(value[0])
        b = _complex_from_unknown(value[1])
        if a is not None and b is not None:
            return (a, b)
    if isinstance(value, dict):
        nested = _jones_from_unknown(value.get("jones"))
        if nested is not None:
            return nested
        ex_re = _finite_number(value.get("exRe"))
        ey_re = _finite_number(value.get("eyRe"))
        if ex_re is not None and ey_re is not None:
            return (
                complex(ex_re, _finite_number(value.get("exIm")) or 0.0),
                complex(ey_re, _finite_number(value.get("eyIm")) or 0.0),
            )
    return None


def _read_jones(ctx: PhysicsOpContext) -> tuple[complex, complex]:
    dynamic = ctx.dynamic or {}
    for candidate in (
        dynamic.get("jones"),
        dynamic.get("polarization"),
        _read_path(dynamic, ["beam", "jones"]),
        _read_path(dynamic, ["beam", "polarization"]),
        ctx.params.get("jones"),
        ctx.params.get("polarization"),
    ):
        parsed = _jones_from_unknown(candidate)
        if parsed is not None:
            return parsed
    return (complex(1, 0), complex(0, 0))


def _q_from_mode(waist_um: float, waist_z_offset_mm: float, wavelength_nm: float) -> complex:
    waist_mm = waist_um / 1000.0
    lambda_mm = wavelength_nm * 1e-6
    q = q_at_waist(waist_mm, lambda_mm)
    return complex(-waist_z_offset_mm, q.imag)


def emit_laser_source_ray(ctx: PhysicsOpContext) -> BeamRay:
    wavelength_nm = _first_positive(ctx, [
        ["centerWavelengthNm"],
        ["spectrum", "centerWavelengthNm"],
        ["beam", "centerWavelengthNm"],
        ["beam", "spectrum", "centerWavelengthNm"],
    ], 780.241)
    power_mw = _first_finite(ctx, [
        ["laserPowerMw"],
        ["powerMw"],
        ["nominalPowerMw"],
        ["beam", "laserPowerMw"],
        ["beam", "powerMw"],
        ["beam", "nominalPowerMw"],
    ], 1.0)

    waist_x_um = _first_positive(ctx, [
        ["spatialModeX", "waistUm"],
        ["spatialEnvelope", "waistXUm"],
        ["spatialEnvelope", "waistUm"],
        ["spatialEnvelope", "transverseProfile", "x", "waistRadiusUm"],
        ["waistUm"],
        ["beam", "spatialModeX", "waistUm"],
        ["beam", "spatialEnvelope", "waistXUm"],
        ["beam", "spatialEnvelope", "waistUm"],
        ["beam", "spatialEnvelope", "transverseProfile", "x", "waistRadiusUm"],
        ["beam", "waistUm"],
    ], 250.0)
    waist_y_um = _first_positive(ctx, [
        ["spatialModeY", "waistUm"],
        ["spatialEnvelope", "waistYUm"],
        ["spatialEnvelope", "waistUm"],
        ["spatialEnvelope", "transverseProfile", "y", "waistRadiusUm"],
        ["waistUm"],
        ["beam", "spatialModeY", "waistUm"],
        ["beam", "spatialEnvelope", "waistYUm"],
        ["beam", "spatialEnvelope", "waistUm"],
        ["beam", "spatialEnvelope", "transverseProfile", "y", "waistRadiusUm"],
        ["beam", "waistUm"],
    ], waist_x_um)
    waist_x_offset_mm = _first_finite(ctx, [
        ["spatialModeX", "waistZOffsetMm"],
        ["spatialEnvelope", "waistXOffsetMm"],
        ["spatialEnvelope", "waistZOffsetMm"],
        ["spatialEnvelope", "propagation", "x", "waistZOffsetMm"],
        ["beam", "spatialModeX", "waistZOffsetMm"],
        ["beam", "spatialEnvelope", "waistXOffsetMm"],
        ["beam", "spatialEnvelope", "waistZOffsetMm"],
        ["beam", "spatialEnvelope", "propagation", "x", "waistZOffsetMm"],
    ], 0.0)
    waist_y_offset_mm = _first_finite(ctx, [
        ["spatialModeY", "waistZOffsetMm"],
        ["spatialEnvelope", "waistYOffsetMm"],
        ["spatialEnvelope", "waistZOffsetMm"],
        ["spatialEnvelope", "propagation", "y", "waistZOffsetMm"],
        ["beam", "spatialModeY", "waistZOffsetMm"],
        ["beam", "spatialEnvelope", "waistYOffsetMm"],
        ["beam", "spatialEnvelope", "waistZOffsetMm"],
        ["beam", "spatialEnvelope", "propagation", "y", "waistZOffsetMm"],
    ], waist_x_offset_mm)

    direction = (ctx.face_out.normal_body_local or Vec3(0, 0, 1)).normalized()
    return BeamRay(
        origin=ctx.face_out.position_mm_body_local,
        direction=direction,
        qx=_q_from_mode(waist_x_um, waist_x_offset_mm, wavelength_nm),
        qy=_q_from_mode(waist_y_um, waist_y_offset_mm, wavelength_nm),
        wavelength_nm=wavelength_nm,
        power_mw=max(0.0, power_mw),
        jones=_read_jones(ctx),
    )


def emit_laser_source_op(_ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    return [emit_laser_source_ray(ctx)]


register_kind("laser_source", KindEntry(
    ops={"emit_laser_source": emit_laser_source_op},
    needs_aperture=False,
))
