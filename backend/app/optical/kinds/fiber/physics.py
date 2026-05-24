"""Fiber PhysicsOp — STUB.

Real fiber physics (Marcuse mode-overlap coupling at each facet, Fresnel
facet loss, length-dependent attenuation in dB/km, integrated Marcuse
curvature bend loss along the spline, polarization tracking through PM /
SM cores) is TODO. The v2 frontend implementation at
``frontend/src/optical/fiber/`` has the algorithms — port to v3 op.

Current stub: pass-through with optional power attenuation from params.

Op name: fiber_propagate
Kind: fiber
"""

from __future__ import annotations

import math

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.registry import KindEntry, PhysicsOpContext, register_kind


def fiber_propagate_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    length_m = float(ctx.params.get("lengthMm", thickness)) / 1000.0
    att_db_per_km = float(ctx.params.get("attenuationDbPerKm", 0.0))
    att_db = att_db_per_km * length_m / 1000.0  # km
    att = math.pow(10.0, -att_db / 10.0)

    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        power_mw=ray_in.power_mw * att,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("fiber", KindEntry(
    ops={"fiber_propagate": fiber_propagate_op},
    needs_aperture=True,
))
