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
from app.optical.beam_ray import BeamRay


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
    theta = math.radians(rot_deg)
    c, s = math.cos(theta), math.sin(theta)
    # Jones rotation by θ around beam axis (axis-fixed):
    #   E_s' = c·E_s − s·E_p
    #   E_p' = s·E_s + c·E_p
    es, ep = ray_in.jones
    new_jones = (c * es - s * ep, s * es + c * ep)
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


def tapered_amplifier_anchor_op(
    ray_in: BeamRay, ctx: AnchorOpContext,
) -> list[BeamRay]:
    """Seeded forward amplification (A→B). Polarization is gain-axis selective:
    only the component along the gain axis (anchor axisY = jones[0]) is
    amplified, and the output is linearly polarized along the gain axis with a
    finite extinction leak. Saturated single-pass gain. A seeded TA emits no
    ASE — unseeded ASE is injected by the emitter post-pass (decision 6b; see
    docs/tapered-amplifier-model.md)."""
    if ctx.anchor.id != "intercept_in":
        return [ray_in]

    out_ray = _slab_passthrough(ray_in, ctx)

    # Couple only the gain-axis (axisY = jones[0]) component into the gain.
    mag_in = _jones_mag2(ray_in.jones)
    e_gain = ray_in.jones[0]
    frac_coupled = (
        (e_gain.real * e_gain.real + e_gain.imag * e_gain.imag) / mag_in
        if mag_in > 1e-30 else 0.0
    )
    p_out = ta_saturated_power_mw(ray_in.power_mw * frac_coupled, ctx.params)

    # Output is linearly polarized along the gain axis (axisY) with a small
    # orthogonal (axisZ) leak set by the extinction ratio.
    leak = math.sqrt(10.0 ** (-float(ctx.params.get("polarizationExtinctionDb", 20.0)) / 10.0))
    out_jones = (complex(1.0, 0.0), complex(leak, 0.0))

    return [out_ray.replaced(jones=out_jones, power_mw=p_out)]


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
