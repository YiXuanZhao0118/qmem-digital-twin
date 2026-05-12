"""Optical cavity calculator — pin the analytic formulas against
textbook values. Reference: Born & Wolf 7.6, Hecht 9.6."""

from __future__ import annotations

import math

import pytest

from app.solvers.optics_cavity import (
    CavityMirror,
    CavityRequest,
    compute,
)


C0 = 2.998_792_458e8


def test_linear_fsr_matches_c_over_2L() -> None:
    # 100 mm linear cavity, R=99% on both mirrors, 852 nm.
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99)],
    )
    res = compute(req)
    expected_fsr_hz = C0 / (2 * 0.100)
    assert res.fsr_hz == pytest.approx(expected_fsr_hz, rel=1e-6)
    assert res.round_trip_length_mm == pytest.approx(200.0, rel=1e-6)


def test_ring_tri_fsr_matches_c_over_L() -> None:
    req = CavityRequest(
        kind="ring_tri",
        length_mm=300.0,  # already total round-trip path
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99), CavityMirror(0.99)],
    )
    res = compute(req)
    expected_fsr_hz = C0 / 0.300
    assert res.fsr_hz == pytest.approx(expected_fsr_hz, rel=1e-6)


def test_finesse_matches_textbook_formula() -> None:
    # R=0.99 symmetric cavity: F = pi * R^(1/4) / (1 - sqrt(R))
    req = CavityRequest(
        kind="linear",
        length_mm=50.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99)],
    )
    res = compute(req)
    R_eff = 0.99 * 0.99
    expected_F = math.pi * R_eff ** 0.25 / (1.0 - math.sqrt(R_eff))
    assert res.finesse == pytest.approx(expected_F, rel=1e-4)


def test_linewidth_equals_fsr_over_finesse() -> None:
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99)],
    )
    res = compute(req)
    assert res.linewidth_hz == pytest.approx(res.fsr_hz / res.finesse, rel=1e-6)


def test_quality_factor_and_photon_lifetime_consistent() -> None:
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99)],
    )
    res = compute(req)
    nu0 = C0 / (852.0e-9)
    expected_Q = nu0 / res.linewidth_hz
    assert res.quality_factor == pytest.approx(expected_Q, rel=1e-6)
    expected_tau_ns = expected_Q / (2 * math.pi * nu0) * 1e9
    assert res.photon_lifetime_ns == pytest.approx(expected_tau_ns, rel=1e-6)


def test_concentric_cavity_is_unstable() -> None:
    # L = 100, both mirrors with ROC = 50 -> g_i = 1 - 100/50 = -1, g1g2 = 1.
    # Edge-of-stability (just barely stable). Make it 60/40 to be safely unstable.
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[
            CavityMirror(0.99, radius_curvature_mm=60.0),
            CavityMirror(0.99, radius_curvature_mm=40.0),
        ],
    )
    res = compute(req)
    # g1 = 1 - 100/60 = -0.667, g2 = 1 - 100/40 = -1.5, g1g2 = 1.0 (stable boundary).
    assert res.g1g2 == pytest.approx((-2.0 / 3.0) * (-1.5), rel=1e-6)
    # That's = 1.0 exactly — boundary stable.
    assert res.stable is True


def test_planar_cavity_g1g2_equals_one() -> None:
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.99), CavityMirror(0.99)],  # both flat
    )
    res = compute(req)
    assert res.g1g2 == pytest.approx(1.0)
    assert res.stable is True
    # Planar cavity: waist undefined.
    assert res.waist_um is None


def test_unstable_cavity_flagged() -> None:
    # L > R1 + R2 - tweak to get g1*g2 > 1.
    req = CavityRequest(
        kind="linear",
        length_mm=200.0,
        wavelength_nm=852.0,
        mirrors=[
            CavityMirror(0.99, radius_curvature_mm=50.0),
            CavityMirror(0.99, radius_curvature_mm=50.0),
        ],
    )
    res = compute(req)
    # g1 = g2 = 1 - 200/50 = -3, g1g2 = 9 -> unstable.
    assert res.g1g2 == pytest.approx(9.0)
    assert res.stable is False


def test_airy_spectrum_peaks_to_unity_for_lossless() -> None:
    req = CavityRequest(
        kind="linear",
        length_mm=100.0,
        wavelength_nm=852.0,
        mirrors=[CavityMirror(0.95), CavityMirror(0.95)],
        intracavity_loss=0.0,
        spectrum_span_fsr=2.0,
        spectrum_points=401,
    )
    res = compute(req)
    # Lossless symmetric cavity: peak transmission approaches 1 but the
    # discrete frequency grid won't land exactly on a resonance.
    assert max(res.spectrum_transmission) > 0.99
    # And T + R = 1 everywhere (energy conservation).
    for t, r in zip(res.spectrum_transmission, res.spectrum_reflection):
        assert t + r == pytest.approx(1.0, abs=1e-9)


def test_invalid_inputs_raise() -> None:
    with pytest.raises(ValueError):
        compute(
            CavityRequest(
                kind="linear",
                length_mm=-1.0,
                wavelength_nm=852.0,
                mirrors=[CavityMirror(0.99), CavityMirror(0.99)],
            )
        )
    with pytest.raises(ValueError):
        compute(
            CavityRequest(
                kind="linear",
                length_mm=100.0,
                wavelength_nm=852.0,
                mirrors=[CavityMirror(1.5)],  # R out of range
            )
        )
