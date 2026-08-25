"""Closed-form Gaussian mode overlap (mode-matching Phase 1).

Pins the general-astigmatism power-coupling formula against the cases whose
answers are known independently: identical beams (η=1), the per-axis product
for aligned astigmatism, waist-size and waist-location mismatch against the
textbook 1-D formula, frame invariance (rotating BOTH beams together leaves η
unchanged), and rotational sensitivity (rotating ONE astigmatic beam drops η).
"""

import math

import pytest

from app.optical.beam_ray import QMatrix, q_at_waist, q_rotate

WL_NM = 780.0
WL_MM = WL_NM * 1e-6


def _q_waist(w0_mm: float) -> complex:
    return q_at_waist(w0_mm, WL_MM)


def _prop(q: complex, d: float) -> complex:
    """Free-space propagate a scalar q by d mm."""
    return q + d


def eta_1d(q1: complex, q2: complex) -> float:
    """Textbook 1-D power overlap 2√(Im(1/q1)Im(1/q2))/|1/q1* - 1/q2|."""
    a1, a2 = 1.0 / q1, 1.0 / q2
    return 2.0 * math.sqrt(a1.imag * a2.imag) / abs(a1.conjugate() - a2)


from app.optical.mode_match import gaussian_mode_overlap


def test_identical_beam_is_unity():
    q = QMatrix(_q_waist(0.5), _q_waist(0.5))
    assert gaussian_mode_overlap(q, q) == pytest.approx(1.0, abs=1e-12)


def test_identical_astigmatic_beam_is_unity():
    q = QMatrix(_q_waist(0.3), _q_waist(0.9))
    assert gaussian_mode_overlap(q, q) == pytest.approx(1.0, abs=1e-12)


def test_factorizes_into_per_axis_product():
    q1 = QMatrix(_q_waist(0.3), _q_waist(0.9))
    q2 = QMatrix(_prop(_q_waist(0.4), 5.0), _prop(_q_waist(0.8), -3.0))
    expect = eta_1d(q1.xx, q2.xx) * eta_1d(q1.yy, q2.yy)
    assert gaussian_mode_overlap(q1, q2) == pytest.approx(expect, rel=1e-10)


def test_waist_size_mismatch_matches_1d():
    # Circular beams, both at waist, different sizes: η = (2 w1 w2/(w1²+w2²))
    w1, w2 = 0.5, 0.7
    q1 = QMatrix(_q_waist(w1), _q_waist(w1))
    q2 = QMatrix(_q_waist(w2), _q_waist(w2))
    analytic_1d = 2.0 * w1 * w2 / (w1 * w1 + w2 * w2)
    assert gaussian_mode_overlap(q1, q2) == pytest.approx(analytic_1d ** 2, rel=1e-10)


def test_defocus_reduces_overlap():
    q0 = QMatrix(_q_waist(0.5), _q_waist(0.5))
    q_def = QMatrix(_prop(_q_waist(0.5), 20.0), _prop(_q_waist(0.5), 20.0))
    eta = gaussian_mode_overlap(q0, q_def)
    assert 0.0 < eta < 1.0


def test_symmetric_in_arguments():
    q1 = QMatrix(_q_waist(0.3), _q_waist(0.9))
    q2 = QMatrix(_prop(_q_waist(0.4), 5.0), _prop(_q_waist(0.8), -3.0))
    assert gaussian_mode_overlap(q1, q2) == pytest.approx(
        gaussian_mode_overlap(q2, q1), rel=1e-12
    )


def test_common_frame_rotation_invariant():
    """Rotating BOTH beams by the same angle leaves η unchanged (η is a
    frame-independent overlap)."""
    q1 = QMatrix(_q_waist(0.3), _q_waist(0.9))
    q2 = QMatrix(_prop(_q_waist(0.4), 5.0), _prop(_q_waist(0.8), -3.0))
    base = gaussian_mode_overlap(q1, q2)
    for phi in (0.1, 0.7, 1.3):
        r1 = q_rotate(q1, phi)
        r2 = q_rotate(q2, phi)
        assert gaussian_mode_overlap(r1, r2) == pytest.approx(base, rel=1e-9)


def test_relative_astig_axis_rotation_drops_overlap():
    """Rotating ONE astigmatic beam relative to the other reduces η; a 90°
    relative rotation (axes swapped) is a genuine mismatch < 1."""
    q = QMatrix(_q_waist(0.3), _q_waist(0.9))
    e45 = gaussian_mode_overlap(q, q_rotate(q, math.pi / 4))
    e90 = gaussian_mode_overlap(q, q_rotate(q, math.pi / 2))
    assert e45 < 1.0
    assert 0.0 < e90 < 1.0


def test_degenerate_beam_returns_zero():
    good = QMatrix(_q_waist(0.5), _q_waist(0.5))
    degenerate = QMatrix(0j, 0j)
    assert gaussian_mode_overlap(good, degenerate) == 0.0
