"""Faraday / EOM / tapered_amplifier / terminal-sink ops (Phase 9.3+).

Faraday rotator — single anchor, Jones rotation non-reciprocal in 5×5
sense (axis-fixed rotationDeg regardless of beam direction).

EOM — like waveplate but retardance from dynamic_sources.driveVoltageV
(linear electro-optic effect).

Tapered amplifier — single anchor on chip centre; gain on transmit,
output beam with reshaped mode (default_params.outputSpatialModeX/Y).
Backward ASE emission left out of v1 — single-direction forward gain.

Terminal sinks (beam_dump, detector, camera, spectrometer, wavemeter,
horn_antenna): return [] so the segment renders as terminal with no
continuation.
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
from app.optical.beam_ray import BeamRay, Vec3, nonparaxial_fundamental_waist_mm
from app.optical.jones import beam_local_sp, jones_rotation_angle, rotate_jones


def _slab_passthrough(ray_in: BeamRay, ctx: AnchorOpContext) -> BeamRay:
    """Just propagate through a slab of length L/n."""
    y, theta_y, z, theta_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    L = float(ctx.params.get("lengthMm", 1.0))
    n = float(ctx.params.get("refractiveIndex", 1.5))
    L_over_n = L / n
    y_out, ty_out, z_out, tz_out = apply_slab_state(y, theta_y, z, theta_z, L_over_n)
    out_ray = out_ray_from_state(
        ray_in, ctx.anchor, y_out, ty_out, z_out, tz_out,
        flip_propagation=False,
    )
    return out_ray.replaced(
        qx=complex(ray_in.qx.real + L_over_n, ray_in.qx.imag),
        qy=complex(ray_in.qy.real + L_over_n, ray_in.qy.imag),
        path_length_mm=ray_in.path_length_mm + L,
    )


# ── Faraday rotator ────────────────────────────────────────────────────────

def faraday_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "optical_center":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    rot_deg = float(ctx.params.get("rotationDeg", 45.0))
    # Faraday rotation is fixed about the lab B-field axis (the rod's
    # optical axis = anchor axisX), NOT the beam-local frame. beam_local_sp
    # keeps ŝ but flips p̂ on reversal, so a direction-independent matrix
    # reads as R(−θ) on the return pass and CANCELS the forward rotation —
    # a reciprocal optical-activity rotator that defeats the isolator.
    # Flip θ by the sign of travel along axisX so both passes have the same
    # handedness in lab and a round trip accumulates 2θ (non-reciprocal).
    # Handedness REVERSED 2026-06-12 (per request): forward pass now rotates
    # −rotationDeg about axisX (was +rotationDeg), so both passes are R(−θ)
    # in lab and a round trip accumulates −2θ. Non-reciprocity is unchanged;
    # only the rotation sense is flipped.
    fwd = 1.0 if ray_in.direction.dot(ctx.anchor.axis_x_body) >= 0.0 else -1.0
    theta = -math.radians(rot_deg) * fwd
    c, s = math.cos(theta), math.sin(theta)
    #   E_s' = c·E_s + s·E_p
    #   E_p' = −s·E_s + c·E_p
    es, ep = ray_in.jones
    new_jones = (c * es + s * ep, -s * es + c * ep)
    return [out_ray.replaced(jones=new_jones)]


register_anchor_op("faraday_rotator", faraday_anchor_op)


# ── EOM ────────────────────────────────────────────────────────────────────

def eom_anchor_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    if ctx.anchor.id != "intercept_in":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    # Dynamic retardance from drive voltage (linear EO):
    #   δ = π · V / V_pi
    v_drive = float(ctx.dynamic.get("driveVoltageV", 0.0))
    v_pi = float(ctx.params.get("vPiV", 5.0))
    delta = math.pi * v_drive / max(1e-9, v_pi)
    phase = complex(math.cos(delta), math.sin(delta))
    e_fast, e_slow = ray_in.jones
    return [out_ray.replaced(jones=(e_fast, e_slow * phase))]


register_anchor_op("eom", eom_anchor_op)


# ── Tapered amplifier ──────────────────────────────────────────────────────

def _jones_mag2(j: tuple[complex, complex]) -> float:
    e0, e1 = j
    return (e0.real * e0.real + e0.imag * e0.imag
            + e1.real * e1.real + e1.imag * e1.imag)


def ta_saturated_power_mw(p_coupled_mw: float, params: dict) -> float:
    """Single-pass saturated gain (see docs/tapered-amplifier-model.md §5):
        P_out = P_sat · ln(1 + (P_coupled / P_sat)·(G0 − 1)),  clamp outputPowerMaxMw.
    Falls back to linear small-signal gain if P_sat is unset."""
    p_sat = float(params.get("saturationPowerMw", 0.0))
    g0 = 10.0 ** (float(params.get("smallSignalGainDb", 30.0)) / 10.0)
    if p_sat > 0.0 and p_coupled_mw > 0.0:
        p_out = p_sat * math.log1p((p_coupled_mw / p_sat) * (g0 - 1.0))
    else:
        p_out = p_coupled_mw * g0
    p_max = float(params.get("outputPowerMaxMw", 0.0))
    if p_max > 0.0:
        p_out = min(p_out, p_max)
    return max(0.0, p_out)


def _gaussian_waist_mm(q: complex, wavelength_nm: float) -> float:
    """Beam radius w at the facet from the complex q-parameter:
    1/q = 1/R − iλ/(πw²)  ⇒  w² = λ·|q|² / (π·Im q). Returns +inf when the
    mode is ill-defined (Im q ≤ 0) so a degenerate seed couples nothing."""
    im = q.imag
    if im <= 0.0 or wavelength_nm <= 0.0:
        return math.inf
    lam_mm = wavelength_nm * 1e-6
    return math.sqrt(lam_mm * (q.real * q.real + im * im) / (math.pi * im))


def _overlap_1d(w_seed: float, w_mode: float, offset_mm: float) -> float:
    """Power coupling between two 1-D Gaussians of waists ``w_seed`` /
    ``w_mode`` with a transverse ``offset``:
        η = [2·w1·w2/(w1²+w2²)] · exp(−2·d²/(w1²+w2²)).
    Captures waist mismatch (focus / divergence) and lateral misalignment —
    the two dominant terms in the TA-input overlap integral."""
    if not math.isfinite(w_seed) or w_seed <= 0.0 or w_mode <= 0.0:
        return 0.0
    sum_sq = w_seed * w_seed + w_mode * w_mode
    match = 2.0 * w_seed * w_mode / sum_sq
    return match * math.exp(-2.0 * offset_mm * offset_mm / sum_sq)


def _mode_match_eta(ray_in: BeamRay, ctx: AnchorOpContext) -> float:
    """Overlap integral η between the seed beam and the TA input waveguide
    mode (≈1 µm × 3 µm ridge). Computed as the separable product of the two
    transverse 1-D overlaps — seed waist (from qx/qy) vs the kind's
    ``inputSpatialModeX/Y.waistUm``, with the lateral offset taken from the
    anchor hit. Astigmatic axis alignment is approximated as seed-X ↔ mode-X.
    Returns η ∈ [0, 1]; uncoupled field becomes radiation modes (lost)."""
    p = ctx.params
    wl = float(p.get("centerWavelengthNm", ray_in.wavelength_nm or 780.0))
    mode_x = (p.get("inputSpatialModeX") or {})
    mode_y = (p.get("inputSpatialModeY") or {})
    wm_x = float(mode_x.get("waistUm", 0.0)) / 1000.0
    wm_y = float(mode_y.get("waistUm", 0.0)) / 1000.0
    if wm_x <= 0.0 or wm_y <= 0.0:
        return 1.0  # mode unspecified — skip the penalty rather than zero out

    # Real seed waist = non-paraxial fundamental width × transverse-mode
    # factor (mode_factor = width_mult / √M²). Non-paraxial so a high-NA seed
    # (tight TA facet / fiber-fed) couples with the correct, bounded spot.
    mode_fac_x = ray_in.width_mult_x / math.sqrt(ray_in.m2x) if ray_in.m2x > 0 else ray_in.width_mult_x
    mode_fac_y = ray_in.width_mult_y / math.sqrt(ray_in.m2y) if ray_in.m2y > 0 else ray_in.width_mult_y
    w_seed_x = nonparaxial_fundamental_waist_mm(ray_in.qx.real, ray_in.qx.imag, ray_in.m2x, wl)[0] * mode_fac_x
    w_seed_y = nonparaxial_fundamental_waist_mm(ray_in.qy.real, ray_in.qy.imag, ray_in.m2y, wl)[0] * mode_fac_y
    _, off_y, _, off_z = beam_state_from_anchor_hit(ray_in, ctx.hit)
    eta = _overlap_1d(w_seed_x, wm_x, off_y) * _overlap_1d(w_seed_y, wm_y, off_z)
    return max(0.0, min(1.0, eta))


def _jones_in_axis_basis(
    ray_in: BeamRay, axis_y: Vec3, dir_body: Vec3,
) -> tuple[complex, complex]:
    """Re-express the incoming Jones vector (stored in the beam-local s/p
    frame) in the anchor's (axisY, axisZ) basis, so component [0] is the TE
    (gain-axis) field and [1] is the TM field."""
    s_current, _ = beam_local_sp(dir_body)
    phi = jones_rotation_angle(s_current, axis_y, dir_body)
    return rotate_jones(ray_in.jones, phi)


def _q_at_waist_mm(w0_um: float, wavelength_nm: float) -> complex:
    if w0_um <= 0.0 or wavelength_nm <= 0.0:
        return complex(0.0, 0.0)
    w0_mm = w0_um / 1000.0
    lam_mm = wavelength_nm * 1e-6
    return complex(0.0, math.pi * w0_mm * w0_mm / lam_mm)


def tapered_amplifier_anchor_op(
    ray_in: BeamRay, ctx: AnchorOpContext,
) -> list[BeamRay]:
    """Seeded forward amplification (A→B). The amount of amplification depends
    on four physical factors (see docs/tapered-amplifier-model.md):

    1. Polarization — TE selection by the quantum-well strain. Only the seed
       component along the gain axis (anchor **axisY** = TE) is amplified; the
       orthogonal (TM) component sees ~no gain. ``frac_te`` is computed by
       re-expressing the seed Jones in the anchor (axisY, axisZ) basis.
    2. Seed intensity — gain saturation ``P_out = P_sat·ln(1+(P_c/P_sat)(G0−1))``.
       Weak seed → linear, poor extraction, high ASE; strong seed → saturated,
       max output, ASE suppressed.
    3. Mode matching — overlap integral ``η`` between the seed beam and the
       input-facet waveguide mode (waist mismatch + lateral offset).
    4. Current-driver quality — a steady-state extraction-efficiency factor
       ``driverQualityFactor`` ∈ [0,1]. NOTE: the *dynamic* driver effects
       (α-parameter AM→PM noise, self-focusing / filamentation, M² collapse)
       are time-/M²-domain phenomena not representable in this steady-state
       Gaussian trace — they belong to the §9 time-domain module.

    Coupled seed power = ``P_in · frac_te · η``. The output is linearly
    polarized along the gain axis (axisY) with a finite extinction leak, and
    its transverse mode is reshaped to ``outputSpatialModeX/Y``. A seeded TA
    emits no ASE — unseeded ASE is injected separately (decision 6b)."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    out_ray = _slab_passthrough(ray_in, ctx)
    p = ctx.params

    # (1) Polarization: TE = axisY component of the seed.
    jones_local = _jones_in_axis_basis(ray_in, ctx.anchor.axis_y_body, ray_in.direction)
    mag_in = _jones_mag2(ray_in.jones)
    e_te = jones_local[0]
    frac_te = (
        (e_te.real * e_te.real + e_te.imag * e_te.imag) / mag_in
        if mag_in > 1e-30 else 0.0
    )

    # (3) Mode matching: seed↔waveguide overlap integral.
    eta_mode = _mode_match_eta(ray_in, ctx)

    # (2) Gain saturation on the coupled seed power.
    p_coupled = ray_in.power_mw * frac_te * eta_mode
    p_out = ta_saturated_power_mw(p_coupled, p)

    # (4) Current-driver quality: steady-state extraction-efficiency penalty.
    driver_q = float(p.get("driverQualityFactor", 1.0))
    p_out *= max(0.0, min(1.0, driver_q))

    # Output: linearly polarized along the gain axis (axisY) with extinction
    # leak, re-expressed in the OUTPUT ray's beam-local s/p frame.
    leak = math.sqrt(10.0 ** (-float(p.get("polarizationExtinctionDb", 20.0)) / 10.0))
    s_out, _ = beam_local_sp(out_ray.direction)
    phi_out = jones_rotation_angle(ctx.anchor.axis_y_body, s_out, out_ray.direction)
    out_jones = rotate_jones((complex(1.0, 0.0), complex(leak, 0.0)), phi_out)

    # Reshape the transverse mode to the chip's output facet (the input beam's
    # q is discarded — the amplified beam takes the waveguide's output mode).
    wl = float(p.get("centerWavelengthNm", ray_in.wavelength_nm or 780.0))
    out_mode_x = (p.get("outputSpatialModeX") or {})
    out_mode_y = (p.get("outputSpatialModeY") or {})
    qx_out = out_ray.qx
    qy_out = out_ray.qy
    if float(out_mode_x.get("waistUm", 0.0)) > 0.0:
        qx_out = _q_at_waist_mm(float(out_mode_x["waistUm"]), wl)
    if float(out_mode_y.get("waistUm", 0.0)) > 0.0:
        qy_out = _q_at_waist_mm(float(out_mode_y["waistUm"]), wl)

    return [out_ray.replaced(
        jones=out_jones, power_mw=p_out, qx=qx_out, qy=qy_out,
    )]


register_anchor_op("tapered_amplifier", tapered_amplifier_anchor_op)


# ── Terminal sinks ─────────────────────────────────────────────────────────

def _terminal_sink_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Absorb the beam — no output."""
    return []


register_anchor_op("beam_dump", _terminal_sink_op)
register_anchor_op("detector", _terminal_sink_op)
register_anchor_op("camera", _terminal_sink_op)
register_anchor_op("spectrometer", _terminal_sink_op)
register_anchor_op("wavemeter", _terminal_sink_op)


# ── Nonlinear crystal / saturable absorber (Phase 9.4+; v1 stubs) ──────────

def nonlinear_crystal_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """SHG / OPO stub: passthrough, no wavelength conversion in v1."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]
    return [_slab_passthrough(ray_in, ctx)]


register_anchor_op("nonlinear_crystal", nonlinear_crystal_op)


def saturable_absorber_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Intensity-dependent transmission T(I) = T0 + (Tsat-T0)·I/(I+Isat).
    v1 approximation — beam treated as having intensity = power / (π·w₀²)."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    T0 = float(ctx.params.get("smallSignalTransmittance", 0.5))
    Tsat = float(ctx.params.get("saturatedTransmittance", 0.95))
    I_sat = float(ctx.params.get("saturationIntensityMwMm2", 100.0))
    # Crude intensity estimate
    I = ray_in.power_mw  # mW (assume unit beam area for v1)
    T = T0 + (Tsat - T0) * I / (I + I_sat)
    return [out_ray.replaced(power_mw=ray_in.power_mw * T)]


register_anchor_op("saturable_absorber", saturable_absorber_op)
