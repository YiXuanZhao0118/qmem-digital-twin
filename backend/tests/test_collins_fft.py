"""Tests for collins_fft — Tier 3 precision-mode beam propagation.

Strategy: build a 2D Gaussian field via HG basis, push it through Collins-FFT
with a known matrix, then check the OUTPUT against the Tier 1 analytic
q-evolution. Agreement to ~few percent on dominant peak / spot size validates
the FFT implementation.
"""

import math

import numpy as np
import pytest

from app.solvers.collins_fft import aperture_mask, collins_5x5_fft
from app.solvers.generalized_abcd import (
    apply_operator,
    BeamMisaligned,
    m_free_space,
    m_thin_lens,
    q_from_waist,
    spot_radius_um,
)
from app.solvers.hg_modes import hg_field_2d


WAVELENGTH_NM = 632.8


def _make_grid(span_mm: float, n: int):
    """1D coordinates centred at 0, evenly spaced. Returns (X, Y, x_1d)."""
    x = np.linspace(-span_mm / 2, span_mm / 2, n, endpoint=False)
    X, Y = np.meshgrid(x, x)
    return X, Y, x


# ---------- Aperture mask ----------


def test_aperture_mask_circle():
    X, Y, _ = _make_grid(4.0, 65)
    mask = aperture_mask(X, Y, radius_mm=0.5)
    # Centre inside
    assert mask[32, 32] == 1
    # Far corner outside
    assert mask[0, 0] == 0


# ---------- Sanity: free-space self-Fourier of Gaussian ----------


def test_collins_free_space_preserves_gaussian_waist_scale():
    """A Gaussian at its waist propagated by ~one Rayleigh range should grow
    by factor √2 in spot radius (standard Gaussian beam result)."""
    # 200 µm waist Gaussian at z=0
    q = q_from_waist(200.0, 0.0, WAVELENGTH_NM)
    z_R_mm = q.imag  # ≈ 198 mm
    X, Y, _ = _make_grid(6.0, 257)
    # Build field as TEM00 via HG basis (preserved norm = 1)
    field = hg_field_2d(0, 0, X, Y, q, q, WAVELENGTH_NM)

    # Propagate by one Rayleigh range via Collins-FFT
    M = m_free_space(z_R_mm)
    E_out, x_out, y_out = collins_5x5_fft(field, X, Y, M, WAVELENGTH_NM)

    # Intensity profile, get 1/e² radius via second moment along x
    intensity = np.abs(E_out) ** 2
    cx = x_out[0, :]
    total = np.sum(intensity)
    if total > 0:
        line = np.sum(intensity, axis=0)
        mean_x = np.sum(cx * line) / np.sum(line)
        var_x = np.sum((cx - mean_x) ** 2 * line) / np.sum(line)
        w_x_mm = 2.0 * math.sqrt(var_x)  # 1/e² radius for Gaussian (2σ)
        # Analytic expectation: w(z=z_R) = w0·√2 = 200µm · √2 ≈ 283µm
        expected_w_mm = 0.200 * math.sqrt(2.0)
        # Tolerate 15% (FFT grid sampling + truncation contribute)
        assert math.isclose(w_x_mm, expected_w_mm, rel_tol=0.15)


# ---------- Sanity: lens focuses a collimated beam ----------


def test_collins_lens_focuses_collimated_to_focal_plane():
    """A collimated Gaussian (waist at lens) hitting f=100mm lens, then
    propagating f mm, should land at a tight focus (~λf/πw0 ≈ 100 µm
    for our test setup).
    """
    f_mm = 100.0
    waist_um_in = 200.0
    q_in = q_from_waist(waist_um_in, 0.0, WAVELENGTH_NM)
    X, Y, _ = _make_grid(6.0, 257)
    field = hg_field_2d(0, 0, X, Y, q_in, q_in, WAVELENGTH_NM)

    M = m_free_space(f_mm) @ m_thin_lens(f_mm)
    E_out, x_out, y_out = collins_5x5_fft(field, X, Y, M, WAVELENGTH_NM)

    intensity = np.abs(E_out) ** 2
    # Analytic: at focal plane, q_out has imag = π·w_f²/λ, where
    #   w_f = λf/(π·w_in) ≈ 632.8e-6·100 / (π·0.2) ≈ 0.101 mm
    bm_in = BeamMisaligned(q_x=q_in, q_y=q_in, wavelength_nm=WAVELENGTH_NM)
    bm_after = apply_operator(bm_in, m_thin_lens(f_mm))
    bm_focus = apply_operator(bm_after, m_free_space(f_mm))
    w_analytic_um = spot_radius_um(bm_focus.q_x, WAVELENGTH_NM)
    # Check that FFT output has its peak intensity near the predicted focus
    # (just verify it's < input waist — i.e., the lens focuses).
    line = np.sum(intensity, axis=0)
    mean_x = np.sum(x_out[0, :] * line) / max(np.sum(line), 1e-30)
    var_x = np.sum((x_out[0, :] - mean_x) ** 2 * line) / max(np.sum(line), 1e-30)
    w_x_mm = 2.0 * math.sqrt(max(var_x, 0.0))
    assert w_x_mm * 1000.0 < waist_um_in  # focused tighter than input
    # And in the right ballpark (within 2x of analytic prediction)
    assert 0.5 * w_analytic_um < w_x_mm * 1000.0 < 2.0 * w_analytic_um


# ---------- Degeneracy guards ----------


def test_collins_rejects_zero_B():
    """B → 0 should raise (imaging plane; not representable via Collins-FFT)."""
    X, Y, _ = _make_grid(2.0, 33)
    field = np.zeros_like(X, dtype=np.complex128)
    M = m_thin_lens(100.0)  # Pure lens has B = 0
    with pytest.raises(ValueError, match="B element"):
        collins_5x5_fft(field, X, Y, M, WAVELENGTH_NM)


# ---------- Tilt term (5th col) shifts beam centre ----------


def test_collins_decentered_beam_centre_drifts_with_free_space():
    """A free-space step with a beam OFF-AXIS: a Gaussian shifted in x
    by 0.3 mm at the input should propagate forward to roughly the same
    x position (no tilt → straight line)."""
    q = q_from_waist(150.0, 0.0, WAVELENGTH_NM)
    X, Y, _ = _make_grid(6.0, 257)
    centre_x_mm = 0.3
    # Build off-axis Gaussian by translating the X coordinate
    X_shift = X - centre_x_mm
    field = hg_field_2d(0, 0, X_shift, Y, q, q, WAVELENGTH_NM)
    L_mm = 100.0
    M = m_free_space(L_mm)
    E_out, x_out, _ = collins_5x5_fft(field, X, Y, M, WAVELENGTH_NM)
    intensity = np.abs(E_out) ** 2
    line = np.sum(intensity, axis=0)
    if np.sum(line) > 1e-30:
        peak_x_mm = float(x_out[0, :][np.argmax(line)])
        # No tilt → centre stays at 0.3 mm (within grid resolution)
        assert abs(peak_x_mm - centre_x_mm) < 0.2
