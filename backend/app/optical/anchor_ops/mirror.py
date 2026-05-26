"""Mirror anchor op (Phase 9.3).

Single anchor: ``reflection_surface``.
  axisX = outward face normal (the side the beam hits from).
  axisY/axisZ = transverse axes in the mirror plane (mirror is
                rotation-symmetric around axisX so the choice within
                the plane only matters for ABCD computations).

Physics:
  - Reflection: ``out_dir = in_dir - 2(in_dir·axisX)·axisX``.
  - ABCD: 5×5 is identity on (y, θ_y, z, θ_z) — a flat mirror neither
    focuses nor displaces the chief ray. (Curved mirrors would have a
    focal-power term here; deferred until needed.)
  - q-parameter: unchanged by a flat mirror.
  - Power: scaled by ``default_params.reflectivity`` (defaults to 0.99).
  - Jones: preserved (with optional sign flip per polarisation if the
    mirror is metallic; ignored for v1 paraxial).

The mirror reflects: the out-ray's propagation flips relative to
axisX, so we use ``out_ray_from_state(..., flip_propagation=True)``.
"""

from __future__ import annotations

from app.optical.anchor_tracer import (
    AnchorOpContext,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.beam_ray import BeamRay


def mirror_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    # Flat mirror: identity ABCD on transverse state.
    out = out_ray_from_state(
        ray_in, ctx.anchor,
        y=y, theta_y=theta_y, z=z, theta_z=theta_z,
        flip_propagation=True,
    )
    reflectivity = float(ctx.params.get("reflectivity", 0.99))
    return [out.replaced(power_mw=ray_in.power_mw * reflectivity)]


register_anchor_op("mirror", mirror_anchor_op)
# Dichroic mirror: same paraxial behaviour at the passband edge it
# reflects. Wavelength branching is a Phase 9.3 follow-up.
register_anchor_op("dichroic_mirror", mirror_anchor_op)
