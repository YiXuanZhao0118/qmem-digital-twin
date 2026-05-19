"""Tests for hg_modes — HG basis, decomposition, reconstruction, profiles."""

import math

import numpy as np
import pytest

from app.solvers.hg_modes import (
    decompose_field,
    hermite_h,
    hg_field_1d,
    hg_field_2d,
    reconstruct_field,
    super_gauss_field,
    tophat_field,
)
from app.solvers.generalized_abcd import q_from_waist


WAVELENGTH_NM = 780.241


# ---------- Hermite polynomials ----------


def test_hermite_h_known_values():
    x = np.array([0.0, 1.0, 2.0])
    assert np.allclose(hermite_h(0, x), [1, 1, 1])
    assert np.allclose(hermite_h(1, x), [0, 2, 4])
    # H_2(x) = 4x^2 - 2
    assert np.allclose(hermite_h(2, x), [-2, 2, 14])
    # H_3(x) = 8x^3 - 12x
    assert np.allclose(hermite_h(3, x), [0, -4, 40])


def test_hermite_h_recurrence_holds():
    """H_{n+1} = 2x·H_n - 2n·H_{n-1} should hold for arbitrary x."""
    x = np.linspace(-2, 2, 7)
    for n in range(1, 6):
        lhs = hermite_h(n + 1, x)
        rhs = 2 * x * hermite_h(n, x) - 2 * n * hermite_h(n - 1, x)
        assert np.allclose(lhs, rhs)


# ---------- HG_0 normalization ----------


def test_hg_0_norm_unit():
    """∫|HG_0(x)|² dx ≈ 1 for L²-normalised mode at waist."""
    q = q_from_waist(waist_um=200.0, waist_z_offset_mm=0.0, wavelength_nm=WAVELENGTH_NM)
    x = np.linspace(-2.0, 2.0, 2049)
    h = hg_field_1d(0, x, q, WAVELENGTH_NM)
    norm2 = np.sum(np.abs(h) ** 2) * (x[1] - x[0])
    assert math.isclose(norm2, 1.0, abs_tol=2e-3)


def test_hg_orthogonality_1d():
    """⟨HG_m | HG_n⟩ ≈ δ_mn for distinct orders."""
    q = q_from_waist(200.0, 0.0, WAVELENGTH_NM)
    x = np.linspace(-2.0, 2.0, 2049)
    dx = x[1] - x[0]
    h0 = hg_field_1d(0, x, q, WAVELENGTH_NM)
    h1 = hg_field_1d(1, x, q, WAVELENGTH_NM)
    h2 = hg_field_1d(2, x, q, WAVELENGTH_NM)
    assert abs(np.sum(np.conj(h0) * h1) * dx) < 5e-3
    assert abs(np.sum(np.conj(h0) * h2) * dx) < 5e-3
    assert abs(np.sum(np.conj(h1) * h2) * dx) < 5e-3


# ---------- HG_00 ↔ Gaussian round-trip ----------


def test_gaussian_decomposes_to_hg_00():
    """A pure Gaussian field with matching q should yield c_00 ≈ 1, others ≈ 0."""
    q = q_from_waist(200.0, 0.0, WAVELENGTH_NM)
    x = np.linspace(-1.5, 1.5, 257)
    y = np.linspace(-1.5, 1.5, 257)
    X, Y = np.meshgrid(x, y)
    # Build a normalised TEM00 field as a known reference
    field = hg_field_2d(0, 0, X, Y, q, q, WAVELENGTH_NM)
    coeffs = decompose_field(field, X, Y, q, q, WAVELENGTH_NM, max_m=2, max_n=2)
    assert abs(coeffs[0, 0] - 1.0) < 5e-3
    # All higher modes should be near zero
    for m in range(3):
        for n in range(3):
            if (m, n) == (0, 0):
                continue
            assert abs(coeffs[m, n]) < 5e-3


def test_decompose_reconstruct_roundtrip_gaussian():
    """Decompose then reconstruct a Gaussian — should recover original field."""
    q = q_from_waist(200.0, 0.0, WAVELENGTH_NM)
    x = np.linspace(-1.5, 1.5, 257)
    y = np.linspace(-1.5, 1.5, 257)
    X, Y = np.meshgrid(x, y)
    field = hg_field_2d(0, 0, X, Y, q, q, WAVELENGTH_NM)
    coeffs = decompose_field(field, X, Y, q, q, WAVELENGTH_NM, max_m=3, max_n=3)
    recon = reconstruct_field(coeffs, X, Y, q, q, WAVELENGTH_NM)
    err = np.sum(np.abs(field - recon) ** 2) * (x[1] - x[0]) ** 2
    assert err < 1e-3


# ---------- Canned profiles ----------


def test_tophat_field_inside_circle():
    """tophat = 1 inside r ≤ R, 0 outside."""
    x = np.linspace(-2.0, 2.0, 51)
    X, Y = np.meshgrid(x, x)
    field = tophat_field(0.5, X, Y)
    # Center: inside
    assert field[25, 25] == pytest.approx(1.0 + 0j)
    # Far corner: outside
    assert field[0, 0] == pytest.approx(0.0 + 0j)


def test_super_gauss_higher_order_flatter_than_gaussian():
    """Super-Gauss of high order has flatter top + sharper edge."""
    x = np.linspace(-1.0, 1.0, 101)
    X, Y = np.meshgrid(x, x)
    g1 = super_gauss_field(0.3, 1, X, Y)
    g4 = super_gauss_field(0.3, 4, X, Y)
    # At the centre both ≈ 1
    assert g1[50, 50].real == pytest.approx(1.0)
    assert g4[50, 50].real == pytest.approx(1.0)
    # Just inside r=r0 (e.g., r=0.25 mm), super-gauss order 4 is flatter
    # (closer to 1) than gauss
    idx_inside = int(50 + 0.25 / (x[1] - x[0]))
    assert g4[50, idx_inside].real > g1[50, idx_inside].real


def test_tophat_decomposition_concentrates_in_low_modes():
    """A reasonably wide top-hat decomposed onto a small HG basis should
    capture most of its power in the few lowest modes (even ones; odd
    coefficients vanish by symmetry)."""
    q = q_from_waist(400.0, 0.0, WAVELENGTH_NM)
    x = np.linspace(-1.5, 1.5, 257)
    X, Y = np.meshgrid(x, x)
    field = tophat_field(0.3, X, Y)
    coeffs = decompose_field(field, X, Y, q, q, WAVELENGTH_NM, max_m=6, max_n=6)
    # Odd m or odd n coefficients should be very small (parity)
    for m in range(7):
        for n in range(7):
            if (m % 2 == 1) or (n % 2 == 1):
                assert abs(coeffs[m, n]) < 0.05
    # Most of the energy in c_00
    total_power = np.sum(np.abs(coeffs) ** 2)
    c00_power = np.abs(coeffs[0, 0]) ** 2
    assert c00_power / max(total_power, 1e-30) > 0.5
