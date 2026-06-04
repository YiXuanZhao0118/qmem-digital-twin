"""Waveplate anchor op (Phase 9.3).

Single primary anchor: ``intercept_in``.
  axisX = optical axis (propagation through slab)
  axisY = fast axis (backfilled from default_params.fastAxisDegBeamLocal;
                     rotation of the base transverse around axisX)
  axisZ = slow axis (= axisX × axisY)

Physics — Jones retardance applied in the (fast, slow) basis:
  Rotate the beam-local (s, p) Jones into the waveplate's fast/slow frame,
  delay the SLOW component by δ = retardance, rotate back:
      W = R(−θ) · diag(1, e^{iδ}) · R(θ)
  where θ is the signed angle from the beam's s-axis to the fast axis,
  measured in the beam's transverse plane. With θ = 0 the fast axis is s and
  the op reduces to the old (basis-naive) behaviour; for a fast axis at 45°
  a quarter-wave plate correctly turns linear into circular light.

  Slab ABCD: identity on offset, propagate L/n. q' = q + L/n. Power preserved.
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
from app.optical.beam_ray import BeamRay, Vec3
from app.optical.jones import beam_local_sp, jones_rotation_angle, rotate_jones


def _fast_axis_body(ctx: AnchorOpContext) -> Vec3:
    """Effective fast-axis direction (body frame): the anchor's axisY (already
    carries the asset's fastAxisDegBeamLocal) rotated by an optional per-object
    ``fastAxisDeg`` about the optical axis (axisY → axisZ)."""
    raw = ctx.params.get("fastAxisDeg")
    fa = math.radians(float(raw)) if isinstance(raw, (int, float)) else 0.0
    ay, az = ctx.anchor.axis_y_body, ctx.anchor.axis_z_body
    c, s = math.cos(fa), math.sin(fa)
    return Vec3(ay.x * c + az.x * s, ay.y * c + az.y * s, ay.z * c + az.z * s)


def _jones_after_waveplate(
    jones: tuple[complex, complex],
    fast_body: Vec3,
    beam_dir: Vec3,
    retardance_rad: float,
) -> tuple[complex, complex]:
    """Apply the waveplate retardance to a beam-local (s, p) Jones vector, with
    the fast axis at ``fast_body`` (body frame). Delays the SLOW component."""
    d = beam_dir.normalized()
    s, _ = beam_local_sp(d)
    f_dot_d = fast_body.dot(d)
    f_perp = Vec3(
        fast_body.x - d.x * f_dot_d,
        fast_body.y - d.y * f_dot_d,
        fast_body.z - d.z * f_dot_d,
    )
    if f_perp.length() < 1e-9:
        theta = 0.0
    else:
        theta = jones_rotation_angle(s, f_perp.normalized(), d)
    # Into the fast/slow frame, delay the slow component, rotate back.
    e_fast, e_slow = rotate_jones(jones, theta)
    phase = complex(math.cos(retardance_rad), math.sin(retardance_rad))
    return rotate_jones((e_fast, e_slow * phase), -theta)


def waveplate_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("lengthMm", 1.0))
    n = float(ctx.params.get("refractiveIndex", 1.5435))
    L_over_n = L / n

    # Slab propagation through the waveplate body.
    y_out, ty_out, z_out, tz_out = apply_slab_state(y, theta_y, z, theta_z, L_over_n)

    ret_deg = float(ctx.params.get("retardanceDeg", 180.0))
    new_jones = _jones_after_waveplate(
        ray_in.jones, _fast_axis_body(ctx), ray_in.direction, math.radians(ret_deg),
    )

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
