"""EOM (electro-optic modulator) PhysicsOp — STUB.

Real Pockels-effect physics (RF-driven index modulation, Jones phase shift
on the modulated axis) is TODO. Current stub: pass-through slab — beam
exits A2 unchanged except for path length update. Allows catalog entry +
PHY Editor display + ray-tracer doesn't crash; solver results through an
EOM are NOT physically meaningful yet.

Op name: eom_passthrough
Kind: eom
"""

from __future__ import annotations

from app.optical.beam_ray import BeamRay, vec3_distance
from app.optical.registry import KindEntry, PhysicsOpContext, register_kind


def eom_passthrough_op(ray_in: BeamRay, ctx: PhysicsOpContext) -> list[BeamRay]:
    thickness = vec3_distance(
        ctx.face_in.position_mm_body_local,
        ctx.face_out.position_mm_body_local,
    )
    return [ray_in.replaced(
        origin=ctx.face_out.position_mm_body_local,
        path_length_mm=ray_in.path_length_mm + thickness,
    )]


register_kind("eom", KindEntry(
    ops={"eom_passthrough": eom_passthrough_op},
    needs_aperture=True,
))
