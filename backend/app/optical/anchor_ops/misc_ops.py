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
    if ctx.anchor.id != "optical_center":
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

def tapered_amplifier_anchor_op(
    ray_in: BeamRay, ctx: AnchorOpContext,
) -> list[BeamRay]:
    if ctx.anchor.id != "optical_center":
        return [ray_in]
    out_ray = _slab_passthrough(ray_in, ctx)
    # Saturable gain: P_out = P_sat · ln(1 + (e^{G0/P_sat} - 1)·(P_in / P_sat))
    # v1 simplification: linear gain clamped to saturation power.
    p_sat = float(ctx.params.get("saturationPowerMw", 500.0))
    g0_db = float(ctx.params.get("smallSignalGainDb", 30.0))
    p_out_unclamped = ray_in.power_mw * (10.0 ** (g0_db / 10.0))
    p_out = min(p_out_unclamped, p_sat)
    return [out_ray.replaced(power_mw=p_out)]


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
    if ctx.anchor.id != "optical_center":
        return [ray_in]
    return [_slab_passthrough(ray_in, ctx)]


register_anchor_op("nonlinear_crystal", nonlinear_crystal_op)


def saturable_absorber_op(ray_in: BeamRay, ctx: AnchorOpContext) -> list[BeamRay]:
    """Intensity-dependent transmission T(I) = T0 + (Tsat-T0)·I/(I+Isat).
    v1 approximation — beam treated as having intensity = power / (π·w₀²)."""
    if ctx.anchor.id != "optical_center":
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
