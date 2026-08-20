"""Fiber dual-anchor Marcuse coupling op (Phase 9.6).

Two anchors per fiber Asset3D: ``tip_a`` and ``tip_b``. Either can receive
the input beam; the OTHER tip emits the coupled output. The op detects
which tip was hit via ``ctx.anchor.id`` and finds the paired anchor in
``ctx.asset.anchors``.

Physics — closed-form v1 mode coupling, no internal raytracing:
  η_mode    = exp(-r²/w₀²) · exp(-θ²/θ_NA²)
              Marcuse Gaussian overlap with the fiber mode-field radius
              w₀ = MFD / 2 (taken from default_params.coreMfdUm).
  η_Fresnel = (1 - R)² for two normal-incidence air-glass interfaces
              with R = ((n-1)/(n+1))²
  η_α       = 10^(−α·L/10) Beer-Lambert attenuation with
              α = default_params.attenuationDbPerKm (dB/km) and
              L = default_params.lengthM (m).

  Total coupling η = η_mode · η_Fresnel · η_α.

  Output beam emerges from the OTHER tip at the fiber-defined waist:
  w₀_out = MFD/2 (mode field diameter), q-parameter reset to imag-only
  (waist at exit face).

Power: ray.power_mw × η.
Direction: aligned with the OUT anchor's +axisX (fiber doesn't preserve
incoming tilt — it imposes the fundamental mode at the output).
"""

from __future__ import annotations

import math

from app.optical.anchor_tracer import (
    AnchorOpContext,
    register_anchor_op,
    V3Anchor,
)
from app.optical.beam_ray import BeamRay, Vec3


def _other_tip(asset_anchors, hit_id: str) -> V3Anchor | None:
    target = "intercept_out" if hit_id == "intercept_in" else "intercept_in"
    return next((a for a in asset_anchors if a.id == target), None)


def _fresnel_normal(n_glass: float) -> float:
    """Single-interface Fresnel reflectance at normal incidence (air-glass)."""
    r = (n_glass - 1.0) / (n_glass + 1.0)
    return r * r


def _q_at_waist(w0_um: float, wavelength_nm: float) -> complex:
    """q-parameter at the beam waist: q(z=0) = i · zR with zR = π·w₀²/λ."""
    if w0_um <= 0:
        return complex(0.0, 0.0)
    zR_um = math.pi * w0_um * w0_um / wavelength_nm * 1000.0  # convert λ nm → mm consistent units
    return complex(0.0, zR_um / 1000.0)  # back to mm


def fiber_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id not in ("intercept_in", "intercept_out"):
        return [ray_in]

    out_anchor = _other_tip(ctx.asset.anchors, ctx.anchor.id)
    if out_anchor is None:
        # Mal-formed asset — terminate
        return []

    # Beam at IN anchor: offset & tilt determine coupling efficiency.
    n_x = ctx.anchor.axis_x_body
    n_y = ctx.anchor.axis_y_body
    n_z = ctx.anchor.axis_z_body
    d = ray_in.direction
    dx = d.dot(n_x)
    if abs(dx) < 1e-9:
        return []  # ray parallel to fiber face — no coupling
    theta_y = d.dot(n_y) / dx
    theta_z = d.dot(n_z) / dx
    theta_in_rad = math.sqrt(theta_y * theta_y + theta_z * theta_z)
    r_in_mm = math.sqrt(
        ctx.hit.offset_y_body ** 2 + ctx.hit.offset_z_body ** 2,
    )
    r_in_um = r_in_mm * 1000.0

    # Mode-field radius w₀ (µm)
    mfd_um = float(ctx.params.get("coreMfdUm", 5.3))
    w0_um = mfd_um / 2.0

    # Numerical aperture half-angle (NA / n_clad → θ_NA in air)
    na = float(ctx.params.get("numericalAperture", 0.13))
    theta_na = math.asin(na)

    # η_mode = exp(-r²/w₀²) · exp(-θ²/θ_NA²)
    eta_pos = math.exp(-(r_in_um ** 2) / (w0_um ** 2)) if w0_um > 0 else 0.0
    eta_ang = math.exp(-(theta_in_rad ** 2) / (theta_na ** 2)) if theta_na > 0 else 0.0
    eta_mode = eta_pos * eta_ang

    # η_Fresnel — two normal-incidence air-glass interfaces
    n_glass = float(ctx.params.get("coreRefractiveIndex", 1.46))
    R = _fresnel_normal(n_glass)
    eta_fresnel = (1.0 - R) * (1.0 - R)

    # η_α — Beer-Lambert attenuation
    alpha_db_km = float(ctx.params.get("attenuationDbPerKm", 4.0))
    length_m = float(ctx.params.get("lengthM", 1.0))
    eta_atten = 10.0 ** (-alpha_db_km * length_m / 10000.0)  # dB/km × km

    eta_total = eta_mode * eta_fresnel * eta_atten

    # Output ray: emitted from out_anchor along its axisX, with fundamental
    # mode (w₀, no tilt).
    out_origin = out_anchor.position_body
    out_dir = out_anchor.axis_x_body
    new_q = _q_at_waist(w0_um, ray_in.wavelength_nm)

    return [ray_in.replaced(
        origin=out_origin,
        direction=out_dir,
        power_mw=ray_in.power_mw * eta_total,
        qx=new_q,
        qy=new_q,
        # The fibre mode is round, so it is the same in every transverse
        # frame -- but the cross term the incoming beam carried must not
        # survive into it.
        qxy=0j,
        path_length_mm=ray_in.path_length_mm + length_m * 1000.0,
    )]


register_anchor_op("fiber", fiber_anchor_op)
register_anchor_op("fiber_coupler", fiber_anchor_op)
