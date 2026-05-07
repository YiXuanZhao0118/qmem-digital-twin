"""Tests for the optical pulse envelope and dispersive propagation.

These cover Phase 1b (PulseEnvelopeArrays + Beam.envelope wiring) and
Phase 1c (propagate_envelope GVD/TOD via split-step Fourier).

Reference: see docs/PHYSICS_TIME_DESIGN.md and PHYSICS_TIME_CHECKPOINT.md.
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from app.solvers.optical_solver import (
    Beam,
    PulseEnvelopeArrays,
    cw_envelope_from_polarization,
    propagate_envelope,
    q_at_z,
)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------


def fwhm(t: np.ndarray, intensity: np.ndarray) -> float:
    """Full-width-half-max of `intensity` sampled at `t`. Same units as t."""
    half = intensity.max() / 2
    above = intensity > half
    if not above.any():
        return 0.0
    idx = np.where(above)[0]
    return float(t[idx[-1]] - t[idx[0]])


# ----------------------------------------------------------------------------
# Phase 1b: PulseEnvelopeArrays + Beam.envelope
# ----------------------------------------------------------------------------


def test_cw_envelope_default():
    env = PulseEnvelopeArrays.cw(carrier_thz=351.7, ex=1.0 + 0j, ey=0 + 0j)
    assert env.is_cw is True
    assert env.n_samples == 1
    assert env.mean_power_mw() == pytest.approx(1.0)


def test_cw_envelope_from_polarization_preserves_power_and_direction():
    pol = (complex(1.0), complex(0.0))
    env = cw_envelope_from_polarization(carrier_thz=351.7, polarization=pol, total_power_mw=18.0)
    assert env.mean_power_mw() == pytest.approx(18.0, rel=1e-12)
    # All power in x:
    assert abs(env.e_x[0]) ** 2 == pytest.approx(18.0, rel=1e-12)
    assert abs(env.e_y[0]) ** 2 == pytest.approx(0.0, abs=1e-12)


def test_beam_with_power_scales_envelope_amplitudes_by_sqrt_factor():
    pol = (complex(1.0), complex(0.0))
    env = cw_envelope_from_polarization(carrier_thz=351.7, polarization=pol, total_power_mw=18.0)
    beam = Beam(
        spectrum={"centerThz": 351.7, "components": []},
        q_x=q_at_z(100.0, 0.0, 1.0, 852.0),
        q_y=q_at_z(100.0, 0.0, 1.0, 852.0),
        transverse_mode={},
        polarization=pol,
        power_mw=18.0,
        wavelength_nm=852.0,
        envelope=env,
    )
    after = beam.with_power(0.25)
    assert after.power_mw == pytest.approx(4.5)
    assert after.envelope is not None
    # |E|² scales by factor (E by sqrt(factor))
    assert after.envelope.mean_power_mw() == pytest.approx(4.5, rel=1e-9)


def test_pulse_schema_roundtrip_lossless():
    N = 50
    dt_ps = 5.0
    t = np.arange(N) * dt_ps
    sigma = 30.0
    ex = np.exp(-(t - 100) ** 2 / (2 * sigma**2)) + 0j
    ey = 0.5j * np.exp(-(t - 100) ** 2 / (2 * sigma**2))
    pulse = PulseEnvelopeArrays(
        is_cw=False,
        t0_ns=0.0,
        dt_ps=dt_ps,
        carrier_thz=351.7,
        e_x=ex,
        e_y=ey,
    )
    restored = PulseEnvelopeArrays.from_schema_dict(pulse.to_schema_dict())
    assert restored.n_samples == N
    assert restored.dt_ps == dt_ps
    assert restored.carrier_thz == 351.7
    assert np.max(np.abs(restored.e_x - pulse.e_x)) == 0.0
    assert np.max(np.abs(restored.e_y - pulse.e_y)) == 0.0


# ----------------------------------------------------------------------------
# Phase 1c: GVD propagation via split-step Fourier
# ----------------------------------------------------------------------------


def test_zero_gvd_passthrough_preserves_pulse():
    N = 1024
    dt_ps = 0.1
    t = (np.arange(N) - N / 2) * dt_ps
    sigma = 1.0
    ex = np.exp(-(t**2) / (2 * sigma**2)) + 0j
    env = PulseEnvelopeArrays(
        is_cw=False, t0_ns=0.0, dt_ps=dt_ps, carrier_thz=375.0, e_x=ex, e_y=np.zeros(N, dtype=np.complex128)
    )
    out = propagate_envelope(env, 100.0, refractive_index=1.45, gvd_fs2_per_mm=0.0)
    assert np.max(np.abs(out.e_x - env.e_x)) == pytest.approx(0.0, abs=1e-12)


def test_gvd_broadens_gaussian_pulse_to_textbook_value():
    """1 ps intensity-FWHM Gaussian through 100 m of fused silica @ 800 nm.

    Textbook chirped Gaussian broadening:
        τ_out = τ_in · sqrt(1 + (4·ln2·GDD/τ_in²)²)
    with β2 ≈ 36 fs²/mm at 800 nm in fused silica.
    """
    beta2_fs2_per_mm = 36.0
    L_mm = 100_000.0  # 100 m
    tau_in_ps = 1.0  # intensity FWHM target

    # Field σ chosen so |E|² FWHM = tau_in_ps:
    sigma_E_ps = tau_in_ps / (2 * math.sqrt(math.log(2)))

    N = 8192
    t_window_ps = 200.0
    dt_ps = t_window_ps / N
    t_ps = (np.arange(N) - N / 2) * dt_ps
    ex = np.exp(-(t_ps**2) / (2 * sigma_E_ps**2)) + 0j
    env = PulseEnvelopeArrays(
        is_cw=False, t0_ns=0.0, dt_ps=dt_ps, carrier_thz=375.0,
        e_x=ex, e_y=np.zeros(N, dtype=np.complex128),
    )

    out = propagate_envelope(env, L_mm, refractive_index=1.45, gvd_fs2_per_mm=beta2_fs2_per_mm)
    intensity_in = np.abs(env.e_x) ** 2
    intensity_out = np.abs(out.e_x) ** 2
    fwhm_in_fs = fwhm(t_ps, intensity_in) * 1000
    fwhm_out_fs = fwhm(t_ps, intensity_out) * 1000

    # Tolerate the discrete-grid bias on the input FWHM (~2.5%)
    assert fwhm_in_fs == pytest.approx(1000.0, rel=0.03)

    GDD_fs2 = beta2_fs2_per_mm * L_mm
    # Use the analytical input FWHM (1000 fs) — the measured value has a
    # discrete-grid bias that compounds into the analytical broadening
    # formula. The split-step propagator itself is unitary in frequency
    # space so it preserves whatever shape it gets.
    tau_in_fs = 1000.0
    expected_fs = tau_in_fs * math.sqrt(1 + (4 * math.log(2) * GDD_fs2 / tau_in_fs**2) ** 2)

    assert fwhm_out_fs == pytest.approx(expected_fs, rel=0.005)


def test_cw_envelope_group_delay_advances_t0():
    cw = PulseEnvelopeArrays.cw(carrier_thz=351.7, ex=1.0 + 0j, ey=0 + 0j)
    out = propagate_envelope(cw, distance_mm=1000.0, refractive_index=1.5, gvd_fs2_per_mm=20.0)
    expected_dt_ns = 1.5 * 1.0 / 299_792_458 * 1e9  # 1 m at n=1.5 in ns
    assert out.t0_ns == pytest.approx(expected_dt_ns, rel=1e-9)
    # CW envelope amplitudes unchanged
    assert out.e_x[0] == cw.e_x[0]
    assert out.e_y[0] == cw.e_y[0]


def test_pulse_energy_is_conserved_under_pure_gvd():
    """Total pulse energy ∫|E|² dt is invariant under unitary phase
    multiplication in frequency domain."""
    N = 2048
    dt_ps = 0.05
    t = (np.arange(N) - N / 2) * dt_ps
    sigma = 0.5
    ex = np.exp(-(t**2) / (2 * sigma**2)) + 0j
    env = PulseEnvelopeArrays(
        is_cw=False, t0_ns=0.0, dt_ps=dt_ps, carrier_thz=375.0,
        e_x=ex, e_y=np.zeros(N, dtype=np.complex128),
    )
    energy_in = float(np.sum(np.abs(env.e_x) ** 2)) * dt_ps
    out = propagate_envelope(env, 50_000.0, refractive_index=1.45, gvd_fs2_per_mm=36.0)
    energy_out = float(np.sum(np.abs(out.e_x) ** 2)) * dt_ps
    assert energy_out == pytest.approx(energy_in, rel=1e-9)
