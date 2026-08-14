"""AOM Bragg-diffraction anchor op (Phase 9.5).

Single primary anchor: ``interaction_center`` (the acoustic-optic
interaction region in the crystal).
  axisX = beam axis (direction of propagation through the crystal)
  axisY = acoustic propagation direction (the s_ac vector)
  axisZ = (axisX × axisY)

Physics — pure v1 Bragg formula, no face raytracing inside the crystal:
  Bragg angle:  θ_B = arcsin(λ · f_RF / (2 · v_acoustic · n))
  Diffraction order m kicks the beam by 2·m·θ_B along the acoustic axis.
  Diffraction efficiency for order m:
      η_m = η_peak(RF) · sinc²(dk_m·L/2), where the mismatch is measured
      from ORDER m's Bragg-matched incidence θ_in = −m·θ_B (signed about
      the acoustic axis). So +1 and −1 peak at tilts 2·θ_B apart and the
      cell has to be rotated to the right side to get the order you asked
      for — see ``aom_physics.bragg_order_detune``.

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
    acoustic_incidence_rad,
    bragg_detuning_sinc2,
    bragg_order_detune,
    first_order_efficiency,
    read_rf_drive_power_w,
    read_rf_frequency_mhz,
)
from app.optical.aom_sideband import (
    phase_modulation_depth,
    sideband_intensities_on_bragg,
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


def _acoustic_transverse_unit(ctx: AnchorOpContext) -> Vec3 | None:
    """The acoustic direction projected perpendicular to the optical axis
    (anchor axisX) and normalised, in body frame — the axis the diffraction
    orders fan along AND the axis the Bragg incidence angle is measured about.

    Returns None when no acoustic vector is given or it is parallel to the
    optical axis; callers fall back to the legacy axisY behaviour.
    """
    a = _read_acoustic_dir(ctx)
    if a is None:
        return None
    ax = ctx.anchor.axis_x_body
    a_par = a.dot(ax)
    a_perp = Vec3(a.x - ax.x * a_par, a.y - ax.y * a_par, a.z - ax.z * a_par)
    length = a_perp.length()
    if length < 1e-9:
        return None
    return Vec3(a_perp.x / length, a_perp.y / length, a_perp.z / length)


def _acoustic_kick_components(ctx: AnchorOpContext) -> tuple[float, float]:
    """Return (ky, kz): how a deflection of magnitude ``kick`` toward the
    acoustic direction distributes onto the anchor's (axisY, axisZ) slopes.

    The acoustic direction comes from the ``acoustic_axis`` anchor (or the
    legacy param) — NOT the anchor's transverse basis: axisY/axisZ are a
    derived up-reference (Gram-Schmidt), not the acoustic axis, so for many
    assets axisY is perpendicular to the real acoustic direction (e.g. MT80:
    axisY = +y, acoustic = +x).

    Falls back to (1, 0) — deflect along axisY, the legacy behaviour — when
    the acoustic direction is unusable.
    """
    a_perp = _acoustic_transverse_unit(ctx)
    if a_perp is None:
        return 1.0, 0.0
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
    L = float(ctx.params.get("crystalLengthMm", 22.4))
    n = float(ctx.params.get("refractiveIndex", 2.2))
    L_over_n = L / n

    # RF frequency via the shared reader (dynamic aomFreqMhz wins, then the
    # asset's centerFreqMhz, then the 80 MHz rated default) so the anchor op,
    # the v3 op, and the panel all agree on the operating point — the AOM shows
    # its rated diffraction even before an RF link is wired up. "Off" is the
    # requiresRfDrive gate, not a 0 Hz default.
    freq_mhz = read_rf_frequency_mhz(ctx.params, ctx.dynamic)
    v_ac = float(ctx.params.get("acousticVelocityMps", 4200.0))
    # baseEfficiency = the datasheet PEAK first-order efficiency (η at the rated
    # drive); the model scales it by sin²((π/2)√(P/P_peak)) and the carrier-freq
    # factor (see first_order_efficiency).
    peak_eff_raw = ctx.params.get("baseEfficiency")
    peak_efficiency = float(peak_eff_raw) if isinstance(peak_eff_raw, (int, float)) else 0.85

    def _int_param(key: str, default: int, lo: int, hi: int) -> int:
        v = ctx.params.get(key, default)
        v = int(v) if isinstance(v, (int, float)) else default
        return max(lo, min(hi, v))

    def _float_param(key: str, default: float) -> float:
        v = ctx.params.get(key, default)
        return float(v) if isinstance(v, (int, float)) and v > 0 else default

    selected_order = _int_param("diffractionOrder", 1, -1, 1)
    max_order = _int_param("maxDiffractionOrder", 3, 1, 10)
    threshold = ctx.params.get("sidebandVisibilityThreshold", 0.01)
    threshold = float(threshold) if isinstance(threshold, (int, float)) else 0.01
    threshold = max(0.0, min(1.0, threshold))

    theta_b = _bragg_angle_rad(ray_in.wavelength_nm, float(freq_mhz), v_ac, n)

    # On-Bragg first-order efficiency from the RF drive (power + carrier freq).
    # The per-order angle detune (below) then scales each diffracted order by
    # how far the cell is from ITS Bragg-matched tilt.
    rf_power_w = read_rf_drive_power_w(ctx.params, ctx.dynamic)
    eta_peak = first_order_efficiency(
        wavelength_nm=ray_in.wavelength_nm,
        freq_mhz=float(freq_mhz),
        rf_power_w=rf_power_w,
        peak_efficiency=peak_efficiency,
        rf_power_for_peak_w=_float_param("rfPowerForPeakW", 2.2),
        peak_ref_wavelength_nm=_float_param("peakRefWavelengthNm", 1100.0),
        center_freq_mhz=_float_param("centerFreqMhz", 80.0),
        freq_shift_bandwidth_mhz=_float_param("freqShiftBandwidthMhz", 15.0),
        requires_rf_drive=ctx.params.get("requiresRfDrive") is True,
    )
    # Signed incidence about the acoustic axis — the only angle the Bragg
    # condition constrains. Order m is matched at theta_in = -m·theta_B, so
    # +1 and -1 peak at opposite tilts (2·theta_B apart) and "rotate the AOM
    # for maximum diffraction" behaves like the real cell. A ray traversing
    # the crystal backwards sees the same condition (it constrains k̂·â only),
    # so no traversal sign appears here.
    a_perp = _acoustic_transverse_unit(ctx)
    theta_in = None
    if a_perp is not None:
        theta_in = acoustic_incidence_rad(
            (ray_in.direction.x, ray_in.direction.y, ray_in.direction.z),
            (a_perp.x, a_perp.y, a_perp.z),
            (ctx.anchor.axis_x_body.x, ctx.anchor.axis_x_body.y, ctx.anchor.axis_x_body.z),
        )
    if theta_in is None:
        # No usable acoustic axis: fall back to the unsigned off-axis angle,
        # i.e. the legacy "matched on the optical axis" behaviour.
        theta_in = 0.0
        legacy_dtheta = math.acos(max(-1.0, min(1.0, ctx.hit.cos_incidence)))
    else:
        legacy_dtheta = None

    def _detune(m: int) -> float:
        if legacy_dtheta is not None:
            return bragg_detuning_sinc2(
                legacy_dtheta, ray_in.wavelength_nm, float(freq_mhz), v_ac, n, L,
            )
        return bragg_order_detune(
            m, theta_in, theta_b, ray_in.wavelength_nm, float(freq_mhz), v_ac, n, L,
        )

    if theta_b == 0.0 or eta_peak <= 1e-12:
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

    # Multi-order sideband intensities — the SHARED model that the Object Panel
    # table also uses (single source). On-Bragg fractions, then EACH diffracted
    # order scaled by its own angle detune; the 0 order takes the rest.
    v_depth = phase_modulation_depth(first_order_efficiency=eta_peak)
    on_bragg = sideband_intensities_on_bragg(selected_order, eta_peak, v_depth, max_order)
    intensity: dict[int, float] = {}
    diffracted_sum = 0.0
    for o, f in on_bragg.items():
        if o == 0:
            continue
        df = f * _detune(o)
        intensity[o] = df
        diffracted_sum += df
    intensity[0] = max(0.0, 1.0 - diffracted_sum)

    out_rays: list[BeamRay] = []
    freq_hz = float(freq_mhz) * 1e6
    # Diffraction orders fan out along the acoustic direction (projected onto
    # the anchor's transverse basis), NOT blindly along axisY.
    ky, kz = _acoustic_kick_components(ctx)
    for m in range(-max_order, max_order + 1):
        inten = intensity.get(m, 0.0)
        always = m == 0 or m == selected_order
        # Hidden orders (below the visibility threshold) don't draw a ray; the
        # 0 order and the selected order always do (mirrors the panel table).
        if not always and inten < threshold:
            continue
        if inten <= 0.0 and not always:
            continue
        kick = 2.0 * float(m) * theta_b
        y_out, ty_out, z_out, tz_out = apply_slab_state(
            y, theta_y + kick * ky, z, theta_z + kick * kz, L_over_n,
        )
        out_ray = out_ray_from_state(
            ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
            flip_propagation=False,
        )
        out_rays.append(out_ray.replaced(
            power_mw=ray_in.power_mw * inten,
            qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
            qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
            path_length_mm=ray_in.path_length_mm + L,
            # Doppler shift: order m diffracts off the f_RF acoustic wave,
            # shifting the optical frequency by m·f_RF (sideband per order).
            freq_offset_hz=ray_in.freq_offset_hz + float(m) * freq_hz,
        ))
    return out_rays


register_anchor_op("aom", aom_anchor_op)
