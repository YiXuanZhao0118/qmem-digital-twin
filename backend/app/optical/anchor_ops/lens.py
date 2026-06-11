"""Lens anchor op (Phase 9.3).

Single primary anchor: ``optical_center`` at the lens body midpoint.
  axisX = optical axis (beam propagation through the lens body)
  axisY/axisZ = transverse axes (spherical lens is symmetric; cylindrical
                                  uses fx along axisY, fy along axisZ).

Physics — thin-lens approximation per axis:
  state' = M · state where state = (y, θ_y, z, θ_z, 1)
  for biconvex / plano-convex (spherical):
      M = [[1,0,0,0,0],
           [-1/f, 1, 0, 0, 0],
           [0, 0, 1, 0, 0],
           [0, 0, -1/f, 1, 0],
           [0, 0, 0, 0, 1]]
  for cylindrical: kick only on axisY (focusing axis), identity on axisZ.

q-parameter: 1/q' = 1/q − 1/f (applied to both qx and qy for spherical).

Power: the chief ray is on-axis at ``optical_center`` by construction, so a
beam wider than the clear aperture loses the wings — the on-axis Gaussian
fraction ``1 − exp(−2a²/w²)`` (a = ``anchor.aperture_mm``, w = √(wx·wy)).
AR-coating / Fresnel loss is the separate ``default_params.transmittance``
factor. Both are applied to ``power_mw`` (energy half of the aperture story;
the diffraction *pattern* lives in the POP field channel).
"""

from __future__ import annotations

from app.optical.anchor_tracer import (
    AnchorOpContext,
    apply_thin_lens_state,
    beam_state_from_anchor_hit,
    out_ray_from_state,
    register_anchor_op,
)
from app.optical.aperture import (
    gaussian_circular_aperture_fraction,
    gaussian_width_mm,
)
from app.optical.beam_ray import BeamRay


def _q_after_lens(q: complex, f_mm: float) -> complex:
    # q_out from ABCD A=1, B=0, C=-1/f, D=1: q' = q / (1 - q/f)
    denom = 1.0 - q / f_mm
    if abs(denom) < 1e-20:
        return q
    return q / denom


def _lens_power_factor(ray_in: BeamRay, ctx: AnchorOpContext) -> float:
    """Combined power transmission of the lens: clear-aperture clipping ×
    coating transmittance. ``ray_in`` is already propagated to the hit, so
    its qx/qy give the spot at the lens. Returns 1.0 when no aperture is
    defined (``anchor.aperture_mm`` ≤ 0)."""
    wl = ray_in.wavelength_nm
    wx = gaussian_width_mm(ray_in.qx, wl)
    wy = gaussian_width_mm(ray_in.qy, wl)
    w_eff = (wx * wy) ** 0.5
    t_ap = gaussian_circular_aperture_fraction(w_eff, ctx.anchor.aperture_mm)
    transmittance = float(ctx.params.get("transmittance", 1.0))
    return t_ap * transmittance


def lens_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    f_mm = float(ctx.params.get("focalLengthMm", 100.0))

    # Spherical thin lens: focusing on both axes equally
    y_out, ty_out, z_out, tz_out = apply_thin_lens_state(
        y, theta_y, z, theta_z, f_mm,
    )

    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return [out_ray.replaced(
        qx=_q_after_lens(ray_in.qx, f_mm),
        qy=_q_after_lens(ray_in.qy, f_mm),
        power_mw=ray_in.power_mw * _lens_power_factor(ray_in, ctx),
    )]


def lens_cylindrical_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    fy_mm = float(ctx.params.get("focalLengthMm", 100.0))
    # axisY is the focusing axis; axisZ pass-through.
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor,
        y=y, theta_y=theta_y - y / fy_mm,
        z=z, theta_z=theta_z,
        flip_propagation=False,
    )
    return [out_ray.replaced(
        qx=_q_after_lens(ray_in.qx, fy_mm),
        power_mw=ray_in.power_mw * _lens_power_factor(ray_in, ctx),
    )]


register_anchor_op("lens", lens_anchor_op)
register_anchor_op("lens_biconvex", lens_anchor_op)
register_anchor_op("lens_plano_convex", lens_anchor_op)
register_anchor_op("lens_cylindrical", lens_cylindrical_op)
