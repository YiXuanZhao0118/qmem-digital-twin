"""Waveplate anchor op (Phase 9.3).

Single primary anchor: ``optical_center``.
  axisX = optical axis (propagation through slab)
  axisY = fast axis (taken from default_params.fastAxisDegBodyLocal at
                     backfill time; rotation of axisY around axisX)
  axisZ = slow axis (= axisX × axisY)

Physics:
  Jones rotation:
      E_fast' = E_fast
      E_slow' = e^(i·δ) · E_slow
    where E_fast = jones · axisY, E_slow = jones · axisZ in the beam-local
    s/p basis (after lab → body → anchor-local change of basis).

  Slab ABCD: identity on offset, propagate L/n in θ direction (lateral
  shift if ray off-axis). 5×5:
      M = [[1, L/n, 0, 0, 0], [0,1,0,0,0], [0,0,1,L/n,0], [0,0,0,1,0],
           [0,0,0,0,1]]

  q-parameter: q' = q + L/n (slab propagation).

  Power: preserved (lossless waveplate; AR-coating absorption optional).
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


def _jones_after_waveplate(
    jones: tuple[complex, complex], retardance_rad: float,
) -> tuple[complex, complex]:
    """Apply waveplate retardance assuming jones is already in (fast, slow)
    basis. Phase delay δ on slow component."""
    e_fast, e_slow = jones
    phase = complex(math.cos(retardance_rad), math.sin(retardance_rad))
    return (e_fast, e_slow * phase)


def waveplate_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "optical_center":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("lengthMm", 1.0))
    n = float(ctx.params.get("refractiveIndex", 1.5435))
    L_over_n = L / n

    # Slab propagation through the waveplate body.
    y_out, ty_out, z_out, tz_out = apply_slab_state(y, theta_y, z, theta_z, L_over_n)

    ret_deg = float(ctx.params.get("retardanceDeg", 180.0))
    new_jones = _jones_after_waveplate(ray_in.jones, math.radians(ret_deg))

    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return [out_ray.replaced(
        jones=new_jones,
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + L,
    )]


register_anchor_op("waveplate", waveplate_anchor_op)
