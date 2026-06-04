"""Parity test: the Python AOM sideband model must match the frontend panel.

Golden values are the panel's sideband table for η=0.85 (override), max ±3,
selected +1, no closed-form params (fallback v = 2*sqrt(η)):
  +1 ≈ 79.2%, ±2 ≈ 9.3%, ±3 ≈ 1.0%, -1 ≈ 0.093%, 0 ≈ 0%.
"""

import pytest

from app.optical.aom_sideband import (
    bessel_j,
    phase_modulation_depth,
    sideband_intensities_on_bragg,
)


def test_bessel_edge_cases():
    assert bessel_j(0, 0.0) == 1.0
    assert bessel_j(2, 0.0) == 0.0
    # J_-2 = J_2 (even), J_-3 = -J_3 (odd)
    assert bessel_j(-2, 1.84) == pytest.approx(bessel_j(2, 1.84), abs=1e-12)
    assert bessel_j(-3, 1.84) == pytest.approx(-bessel_j(3, 1.84), abs=1e-12)


def test_phase_mod_depth_from_efficiency():
    # v = 2*sqrt(eta_first); collapses to 0 when the drive (eta) is off.
    assert phase_modulation_depth(first_order_efficiency=0.85) == pytest.approx(
        2.0 * (0.85 ** 0.5), abs=1e-9)
    assert phase_modulation_depth(first_order_efficiency=0.0) == 0.0


def test_matches_panel_golden_values():
    eta = 0.85
    v = phase_modulation_depth(first_order_efficiency=eta)
    s = sideband_intensities_on_bragg(1, eta, v, 3)
    assert s[1] == pytest.approx(0.792, abs=0.01)
    assert s[2] == pytest.approx(0.093, abs=0.006)
    assert s[-2] == pytest.approx(0.093, abs=0.006)
    assert s[3] == pytest.approx(0.010, abs=0.004)
    assert s[-1] == pytest.approx(0.00093, abs=0.0004)
    assert s[0] == pytest.approx(0.0, abs=0.006)
    assert sum(s.values()) == pytest.approx(1.0, abs=1e-9)


def test_zero_order_selected_passes_through():
    s = sideband_intensities_on_bragg(0, 0.85, 1.84, 3)
    assert s[0] == pytest.approx(1.0, abs=1e-9)
    assert all(v == pytest.approx(0.0, abs=1e-12) for k, v in s.items() if k != 0)
