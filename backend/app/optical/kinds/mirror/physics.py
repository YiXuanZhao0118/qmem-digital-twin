"""Mirror PhysicsOp (Python mirror of frontend kinds/mirror/physics.ts).

Op name: reflect_specular
Kind: mirror
Required: face_in.normal_body_local
"""

from __future__ import annotations

from app.optical.beam_ray import BeamRay, Vec3
from app.optical.jones import rotate_jones_into_new_frame
from app.optical.registry import (
    KindEntry,
    PhysicsOpContext,
    register_kind,
)


def reflect_direction(d: Vec3, n: Vec3) -> Vec3:
    """d' = d - 2 (d·n) n"""
    dot_dn = d.dot(n)
    return d - n * (2.0 * dot_dn)


def reflect_specular_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    n = ctx.face_in.normal_body_local
    if n is None:
        raise ValueError("reflect_specular: face_in.normal_body_local is required")

    d_new = reflect_direction(ray_in.direction, n)
    reflectivity = float(ctx.params.get("reflectivity", 1.0))
    new_jones = rotate_jones_into_new_frame(ray_in.jones, ray_in.direction, d_new)

    return [ray_in.replaced(
        direction=d_new,
        jones=new_jones,
        power_mw=ray_in.power_mw * reflectivity,
    )]


register_kind("mirror", KindEntry(
    ops={"reflect_specular": reflect_specular_op},
    needs_aperture=True,
))
