"""Polarizer anchor op (Phase 9.3).

Single anchor: ``transmission_plane`` (uses ``optical_center`` after the
Phase 9.1 backfill).
  axisX = optical axis (propagation)
  axisY = transmission axis
  axisZ = blocked axis

Physics:
  Jones project onto axisY direction; the orthogonal component is
  attenuated by extinction ratio (default_params.extinctionDb).

  Power scales by |E_transmit|² / |E_in|² (Malus' law in Jones picture).

  Slab ABCD applied (thin polarizer ≈ 1 mm).
"""

from __future__ import annotations

import math

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_slab_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.beam_ray import BeamRay


def _jones_mag2(j: tuple[complex, complex]) -> float:
    e0, e1 = j
    return (e0.real * e0.real + e0.imag * e0.imag
            + e1.real * e1.real + e1.imag * e1.imag)


def polarizer_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("lengthMm", 1.0))
    n = float(ctx.params.get("refractiveIndex", 1.5))
    L_over_n = L / n
    y_out, ty_out, z_out, tz_out = apply_slab_state(y, theta_y, z, theta_z, L_over_n)

    # In anchor local basis: jones[0] = E along axisY (transmit),
    # jones[1] = E along axisZ (blocked).
    ext_db = float(ctx.params.get("extinctionDb", 30.0))
    attenuation = 10.0 ** (-ext_db / 10.0)
    e_pass, e_block = ray_in.jones
    new_jones = (e_pass, complex(e_block.real * math.sqrt(attenuation),
                                 e_block.imag * math.sqrt(attenuation)))

    mag_in = _jones_mag2(ray_in.jones)
    mag_out = _jones_mag2(new_jones)
    t = mag_out / mag_in if mag_in > 1e-30 else 0.0

    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return [out_ray.replaced(
        jones=new_jones,
        power_mw=ray_in.power_mw * t,
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + L,
    )]


register_anchor_op("polarizer", polarizer_anchor_op)
register_anchor_op("glan_polarizer", polarizer_anchor_op)
