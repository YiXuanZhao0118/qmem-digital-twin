"""AOM Bragg-diffraction anchor op (Phase 9.5).

Single primary anchor: ``interaction_center`` (the acoustic-optic
interaction region in the crystal).
  axisX = beam axis (direction of propagation through the crystal)
  axisY = acoustic propagation direction (the s_ac vector)
  axisZ = (axisX × axisY)

Physics — pure v1 Bragg formula, no face raytracing inside the crystal:
  Bragg angle:  θ_B = arcsin(λ · f_RF / (2 · v_acoustic · n))
  Diffraction order m kicks the beam by 2·m·θ_B along axisY.
  Diffraction efficiency for order m:
      η_m = baseEfficiency · sinc²(Δ · L) (Bragg matching factor),
      with detune Δ ∝ (sin θ_in − m·θ_B). v1 stays simple: full base
      efficiency on the requested order, zero elsewhere.

  RF freq + power come from ``dynamic_sources.aomFreqMhz`` and
  ``dynamic_sources.aomRfPowerDbm`` (with sensible defaults from
  ``default_params.centerFreqMhz`` / ``baseEfficiency``).

  q-parameter: slab propagation through crystal length.

The op spawns N rays — one per `(diffractionOrders)` entry in
default_params (e.g. ``[1]`` for +1 only, ``[1, -1]`` for both orders).
If no RF drive (``aomFreqMhz`` not present and no default), output the
zeroth order with full input power (passthrough).
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
from app.optical.aom_physics import (
    bragg_detuning_sinc2,
    first_order_efficiency,
    order_efficiency,
    read_rf_drive_power_w,
)
from app.optical.beam_ray import BeamRay, Vec3


def _read_acoustic_dir(ctx: AnchorOpContext) -> Vec3 | None:
    """Acoustic propagation direction (body frame), single source of truth for
    the Bragg fan direction. Priority:

      1. The dedicated ``acoustic_axis`` anchor's axisX (kind-level anchor,
         authored perpendicular to the optical axis — NOT rf_in, the cable
         connector).
      2. Legacy ``rfPropagationDirectionBodyLocal`` / ``acousticAxisBodyLocal``
         param.
    """
    for an in (ctx.asset.anchors or []):
        if getattr(an, "id", None) == "acoustic_axis":
            return an.axis_x_body
    raw = ctx.params.get("rfPropagationDirectionBodyLocal") or ctx.params.get("acousticAxisBodyLocal")
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        try:
            return Vec3(float(raw[0]), float(raw[1]), float(raw[2]))
        except (TypeError, ValueError):
            pass
    return None


def _acoustic_kick_components(ctx: AnchorOpContext) -> tuple[float, float]:
    """Return (ky, kz): how a deflection of magnitude ``kick`` toward the
    acoustic direction distributes onto the anchor's (axisY, axisZ) slopes.

    The acoustic direction comes from the ``acoustic_axis`` anchor (or the
    legacy param) — NOT the anchor's transverse basis: axisY/axisZ are a
    derived up-reference (Gram-Schmidt), not the acoustic axis, so for many
    assets axisY is perpendicular to the real acoustic direction (e.g. MT80:
    axisY = +y, acoustic = +x). We project the acoustic direction transverse to
    the optical axis (axisX) and decompose onto (axisY, axisZ).

    Falls back to (1, 0) — deflect along axisY, the legacy behaviour — when no
    acoustic vector is given or it is parallel to the optical axis.
    """
    a = _read_acoustic_dir(ctx)
    if a is None:
        return 1.0, 0.0
    ax = ctx.anchor.axis_x_body
    a_par = a.dot(ax)
    a_perp = Vec3(a.x - ax.x * a_par, a.y - ax.y * a_par, a.z - ax.z * a_par)
    length = a_perp.length()
    if length < 1e-9:
        return 1.0, 0.0
    a_perp = Vec3(a_perp.x / length, a_perp.y / length, a_perp.z / length)
    return a_perp.dot(ctx.anchor.axis_y_body), a_perp.dot(ctx.anchor.axis_z_body)


def _bragg_angle_rad(
    wavelength_nm: float, freq_mhz: float, v_acoustic: float, n_crystal: float,
) -> float:
    """External Bragg half-angle: asin(lambda * f / (2 * v)).

    This is the LAB/geometric angle of the chief ray (in air), so the full
    0->+1 deflection 2*theta_B = lambda*f/v matches an AO deflector's spec.
    n is intentionally NOT here — it only enters the slab q-propagation (L/n)
    and internal phase-matching, not the external ray deflection. (Matches the
    v3 kind op.)
    """
    _ = n_crystal
    if freq_mhz <= 0 or v_acoustic <= 0:
        return 0.0
    lam_m = wavelength_nm * 1e-9
    freq_hz = freq_mhz * 1e6
    arg = lam_m * freq_hz / (2.0 * v_acoustic)
    arg = max(-1.0, min(1.0, arg))
    return math.asin(arg)


def aom_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "interaction_center":
        return [ray_in]

    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("crystalLengthMm", 1.6))
    n = float(ctx.params.get("refractiveIndex", 2.2))
    L_over_n = L / n

    freq_mhz = ctx.dynamic.get("aomFreqMhz")
    if not isinstance(freq_mhz, (int, float)):
        freq_mhz = float(ctx.params.get("centerFreqMhz", 0.0))
    v_ac = float(ctx.params.get("acousticVelocityMps", 4200.0))
    eta_base = float(ctx.params.get("baseEfficiency", 0.85))
    orders = ctx.params.get("diffractionOrders") or [1, -1]
    if not isinstance(orders, list):
        orders = [1, -1]

    theta_b = _bragg_angle_rad(ray_in.wavelength_nm, float(freq_mhz), v_ac, n)

    # First-order (peak) efficiency from the RF drive power, modulated by the
    # Bragg detuning (how far the incident beam is off the matched angle, so
    # tilting/rotating the AOM changes the split). RF freq + power arrive via
    # dynamic — a manual override or the resolved RF-link drive.
    m2 = ctx.params.get("figureOfMeritM2")
    w_mm = ctx.params.get("acousticBeamWidthMm")
    dtheta_ext = math.acos(max(-1.0, min(1.0, ctx.hit.cos_incidence)))
    detune = bragg_detuning_sinc2(
        dtheta_ext, ray_in.wavelength_nm, float(freq_mhz), v_ac, n, L,
    )
    eta1 = first_order_efficiency(
        ray_in.wavelength_nm, theta_b,
        rf_power_w=read_rf_drive_power_w(ctx.params, ctx.dynamic),
        m2=m2 if isinstance(m2, (int, float)) and m2 > 0 else None,
        l_mm=L,
        w_mm=w_mm if isinstance(w_mm, (int, float)) and w_mm > 0 else None,
        base_efficiency=eta_base,
        requires_rf_drive=ctx.params.get("requiresRfDrive") is True,
    ) * detune

    if theta_b == 0.0 or eta1 <= 1e-12:
        # No diffraction (no RF drive / gated off / fully off-Bragg) — the beam
        # passes straight through as the 0 order at full power (never vanishes).
        y_out, ty_out, z_out, tz_out = apply_slab_state(
            y, theta_y, z, theta_z, L_over_n,
        )
        out_ray = out_ray_from_state(
            ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
            flip_propagation=False,
        )
        return [out_ray.replaced(
            qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
            qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
            path_length_mm=ray_in.path_length_mm + L,
        )]

    out_rays: list[BeamRay] = []
    freq_hz = float(freq_mhz) * 1e6
    # Diffraction orders fan out along the acoustic direction (projected onto
    # the anchor's transverse basis), NOT blindly along axisY.
    ky, kz = _acoustic_kick_components(ctx)
    for m in orders:
        kick = 2.0 * float(m) * theta_b
        y_out, ty_out, z_out, tz_out = apply_slab_state(
            y, theta_y + kick * ky, z, theta_z + kick * kz, L_over_n,
        )
        out_ray = out_ray_from_state(
            ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
            flip_propagation=False,
        )
        out_rays.append(out_ray.replaced(
            power_mw=ray_in.power_mw * order_efficiency(m, eta1),
            qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
            qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
            path_length_mm=ray_in.path_length_mm + L,
            # Doppler shift: order m diffracts off the f_RF acoustic wave,
            # shifting the optical frequency by m·f_RF (sideband per order).
            freq_offset_hz=ray_in.freq_offset_hz + float(m) * freq_hz,
        ))
    return out_rays


register_anchor_op("aom", aom_anchor_op)
