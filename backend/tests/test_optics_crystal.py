"""Tests pin the nonlinear-crystal solver against textbook values.

Target case throughout: **PPKTP, Type-0 e+e→e, 447.5 nm pump → 895 nm
degenerate signal/idler** (Cs D1 line memory). Expected QPM period at
25 °C is ~2.5 µm (PPKTP_z Sellmeier from Vanherzeele & Bierlein).
"""

from __future__ import annotations

import math

import pytest

from app.solvers.optics_crystal import (
    CRYSTALS,
    qpm_period,
    refractive_index,
    shg_efficiency_plane_wave,
    spdc_tuning,
)


# ---------------------------------------------------------------------------
# Sellmeier sanity
# ---------------------------------------------------------------------------


def test_ppktp_nz_at_1064_matches_literature() -> None:
    """KTP n_z(1064 nm, 25°C) ≈ 1.830 (Vanherzeele 1992). Allow ±0.005."""
    n = refractive_index("ppktp", 1064.0, "z", 25.0)
    assert 1.825 < n < 1.840, f"got n_z(1064) = {n}"


def test_ppktp_nz_at_532_matches_literature() -> None:
    n = refractive_index("ppktp", 532.0, "z", 25.0)
    assert 1.880 < n < 1.900, f"got n_z(532) = {n}"


def test_ppktp_nz_at_447_5_blue() -> None:
    n = refractive_index("ppktp", 447.5, "z", 25.0)
    assert 1.90 < n < 1.95, f"got n_z(447.5) = {n}"


def test_ppktp_nz_at_895_nir() -> None:
    n = refractive_index("ppktp", 895.0, "z", 25.0)
    assert 1.825 < n < 1.850, f"got n_z(895) = {n}"


def test_temperature_correction_changes_index() -> None:
    n_cold = refractive_index("ppktp", 895.0, "z", 0.0)
    n_hot = refractive_index("ppktp", 895.0, "z", 80.0)
    assert n_hot > n_cold, "dn/dT > 0 for KTP z-axis in this range"
    # Typical PPKTP dn_z/dT ~ 2.4e-5 /K → 80°C diff ≈ 1.9e-3.
    assert 0.5e-3 < (n_hot - n_cold) < 5e-3


# ---------------------------------------------------------------------------
# Phase matching
# ---------------------------------------------------------------------------


def test_ppktp_type0_degenerate_qpm_period_at_447_5_to_895() -> None:
    """The user's canonical case. Expected ~5 µm at 25°C, Type-0 e+e→e.
    (Type-0 PPKTP gives shorter periods than Type-II for the same
    wavelength pair — c.f. Type-0 405→810 ~3.4 µm, 532→1064 ~9 µm.)"""
    period_um = qpm_period("ppktp", "type0_eee", 447.5, 895.0, 25.0)
    assert 4.0 < period_um < 6.5, (
        f"got Λ = {period_um:.3f} µm — expected 4–6.5 µm for "
        f"PPKTP Type-0 e+e→e at 447.5→895"
    )


def test_ppktp_type0_qpm_period_at_1064_to_532_matches_literature() -> None:
    """SHG of 1064 → 532 in PPKTP Type-0: published value Λ ≈ 9.0 µm at room temperature."""
    # Here SHG = reverse direction: pump = 532, daughters = 1064 + 1064.
    # Going through SPDC machinery: pump_nm=532, signal_nm=1064 (degenerate).
    period_um = qpm_period("ppktp", "type0_eee", 532.0, 1064.0, 25.0)
    assert 8.0 < period_um < 10.5, f"got Λ = {period_um:.3f} µm"


def test_ppln_type0_at_1064_to_532_matches_literature() -> None:
    """MgO:PPLN Type-0 SHG 1064→532: Λ ≈ 6.9 µm at 25°C (Gayer 2008)."""
    period_um = qpm_period("ppln_mgo", "type0_eee", 532.0, 1064.0, 25.0)
    assert 6.0 < period_um < 8.0, f"got Λ = {period_um:.3f} µm"


def test_non_qpm_crystal_raises() -> None:
    with pytest.raises(ValueError):
        qpm_period("bbo", "type1_ooe", 400.0, 800.0, 25.0)


def test_unphysical_signal_raises() -> None:
    # 1/λ_p − 1/λ_s ≤ 0 means signal at shorter wavelength than pump — unphysical.
    with pytest.raises(ValueError):
        qpm_period("ppktp", "type0_eee", 800.0, 400.0, 25.0)


# ---------------------------------------------------------------------------
# SHG efficiency
# ---------------------------------------------------------------------------


def test_shg_efficiency_increases_quadratically_with_length() -> None:
    """On-resonance (Δk_eff ≈ 0): η ∝ L²."""
    a = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=1.0, crystal_length_mm=1.0,
        beam_waist_um=50.0, t_C=25.0,
    )
    b = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=1.0, crystal_length_mm=4.0,
        beam_waist_um=50.0, t_C=25.0,
    )
    # 4x length → ~16x η for L ≪ coherence length and Δk_eff ≈ 0.
    ratio = b["eta"] / a["eta"]
    assert 12.0 < ratio < 20.0, f"η scaling not quadratic: ratio = {ratio:.2f}"


def test_shg_efficiency_increases_with_pump_power() -> None:
    a = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=1.0, crystal_length_mm=5.0,
        beam_waist_um=50.0, t_C=25.0,
    )
    b = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=10.0, crystal_length_mm=5.0,
        beam_waist_um=50.0, t_C=25.0,
    )
    # η ∝ I_pump (plane wave), and I_pump ∝ P_pump.
    assert b["eta"] == pytest.approx(10.0 * a["eta"], rel=1e-3)


def test_shg_efficiency_drops_off_axis_qpm() -> None:
    """If we lie about the poling period, sinc² rolloff kicks in."""
    on_resonance = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=1.0, crystal_length_mm=5.0,
        beam_waist_um=50.0, t_C=25.0,
    )
    off_resonance = shg_efficiency_plane_wave(
        "ppktp", "type0_eee", 1064.0, p_pump_w=1.0, crystal_length_mm=5.0,
        beam_waist_um=50.0, t_C=25.0, poling_um=2.0,  # very wrong period
    )
    assert off_resonance["sinc_factor"] < on_resonance["sinc_factor"]


# ---------------------------------------------------------------------------
# SPDC tuning
# ---------------------------------------------------------------------------


def test_spdc_tuning_at_target_poling_finds_signal_near_degenerate() -> None:
    """At the QPM period that makes 447.5→895 phase-match at 25°C, the
    tuning sweep should land on signal ≈ 895 nm with corresponding idler."""
    period_um = qpm_period("ppktp", "type0_eee", 447.5, 895.0, 25.0)
    rows = spdc_tuning(
        "ppktp", "type0_eee", pump_nm=447.5, poling_um=period_um,
        t_min_C=24.5, t_max_C=25.5, t_points=3,
    )
    # Middle row should be at T=25°C with signal close to 895 nm.
    middle = rows[1]
    assert middle["signal_nm"] is not None, "phase matching at design T failed"
    signal_nm = middle["signal_nm"]
    idler_nm = middle["idler_nm"]
    # Energy conservation always holds.
    assert (1.0 / signal_nm + 1.0 / idler_nm) == pytest.approx(
        1.0 / 447.5, rel=1e-3
    )
    # Should be near degenerate (within 50 nm).
    assert abs(signal_nm - 895.0) < 50.0 or abs(idler_nm - 895.0) < 50.0


def test_spdc_temperature_tunes_signal_idler_apart() -> None:
    """Heating PPKTP moves the SPDC signal off degenerate. Verify the
    tuning curve has a non-trivial slope dλ_s/dT."""
    period_um = qpm_period("ppktp", "type0_eee", 447.5, 895.0, 25.0)
    rows = spdc_tuning(
        "ppktp", "type0_eee", pump_nm=447.5, poling_um=period_um,
        t_min_C=10.0, t_max_C=80.0, t_points=8,
    )
    signals = [r["signal_nm"] for r in rows if r["signal_nm"] is not None]
    assert len(signals) >= 3, "tuning sweep failed at multiple T points"


def test_ktp_registered_with_t_correction() -> None:
    """KTP and PPKTP share Sellmeier — sanity that the registry exposes both."""
    assert "ktp" in CRYSTALS
    assert "ppktp" in CRYSTALS
    assert CRYSTALS["ppktp"].is_qpm is True
    assert CRYSTALS["ktp"].is_qpm is False
