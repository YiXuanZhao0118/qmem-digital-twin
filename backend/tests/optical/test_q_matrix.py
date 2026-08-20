"""Q-matrix representation (Step 1 of the general-astigmatism upgrade).

The contract of this step is that NOTHING changes numerically: qx/qy are now
the diagonal of a complex symmetric ``QMatrix`` whose off-diagonal is still
zero everywhere, and the matrix propagation law must reproduce the historical
scalar arithmetic BIT-FOR-BIT. The rotated-cylindrical tests then pin down the
general path that Step 2 will start writing into.
"""

import cmath
import math

import pytest

from app.optical.anchor_ops.lens import _q_after_abcd, _q_after_lens
from app.optical.aperture import gaussian_width_mm
from app.optical.beam_ray import (
    Mat2,
    QMatrix,
    Vec3,
    make_beam_ray,
    q_matrix_after_abcd,
    q_matrix_principal_widths,
)

WL = 852.347
ZERO = Mat2.scalar(0j)
IDENT = Mat2.identity()

Q_CASES = [
    QMatrix(complex(-188.8, 1792.6), complex(-626.0, 1232.6)),
    QMatrix(complex(0.0, 0.000923), complex(0.006, 0.0155)),
    QMatrix(complex(1e4, 3.0), complex(-7.5, 0.25)),
]


def _free_space(d):
    return IDENT, Mat2.scalar(complex(d)), ZERO, IDENT


def _thin_lens(fx, fy):
    return IDENT, ZERO, Mat2.diag(complex(-1.0 / fx), complex(-1.0 / fy)), IDENT


# --------------------------------------------------------------------------
# bit-identity with the pre-refactor scalar path
# --------------------------------------------------------------------------

@pytest.mark.parametrize("q", Q_CASES)
@pytest.mark.parametrize("d", [0.0, 22.5, 1000.0, -4.51])
def test_free_space_bit_identical(q, d):
    got = q_matrix_after_abcd(q, *_free_space(d))
    assert got.xx == _q_after_abcd(q.xx, 1.0, d, 0.0, 1.0)
    assert got.yy == _q_after_abcd(q.yy, 1.0, d, 0.0, 1.0)
    assert got.xy == 0j


@pytest.mark.parametrize("q", Q_CASES)
@pytest.mark.parametrize("f", [4.51, 100.0, -75.0])
def test_spherical_lens_bit_identical(q, f):
    """Bit-identity is against the ABCD form, which is what the matrix law
    generalises. See test_lens_shortcut_agrees_only_to_ulp for why
    ``_q_after_lens`` is not the right reference."""
    got = q_matrix_after_abcd(q, *_thin_lens(f, f))
    assert got.xx == _q_after_abcd(q.xx, 1.0, 0.0, -1.0 / f, 1.0)
    assert got.yy == _q_after_abcd(q.yy, 1.0, 0.0, -1.0 / f, 1.0)
    assert got.xy == 0j


@pytest.mark.parametrize("q", Q_CASES)
@pytest.mark.parametrize("f", [4.51, 100.0, -75.0])
def test_lens_shortcut_agrees_only_to_ulp(q, f):
    """``anchor_ops.lens._q_after_lens`` evaluates ``q / (1 - q/f)`` while the
    ABCD form evaluates ``q / ((-1/f)*q + 1)``. Algebraically identical, but
    the divide-by-f and the multiply-by-(-1/f) round differently, so the two
    can disagree in the last ULP (f = -75 with Q_CASES[0] does).

    Step 2 must therefore keep lens.py's own expression when it migrates, or
    accept ULP-level movement in the optical golden fixtures. Pinning it here
    so that choice is deliberate rather than discovered.
    """
    for a, b in ((q.xx, _q_after_lens(q.xx, f)), (q.yy, _q_after_lens(q.yy, f))):
        assert cmath.isclose(_q_after_abcd(a, 1.0, 0.0, -1.0 / f, 1.0), b,
                             rel_tol=1e-15, abs_tol=0.0)


@pytest.mark.parametrize("q", Q_CASES)
def test_cylindrical_lens_bit_identical(q):
    fy = 40.0
    got = q_matrix_after_abcd(q, IDENT, ZERO, Mat2.diag(0j, complex(-1.0 / fy)), IDENT)
    assert got.xx == q.xx
    assert got.yy == _q_after_abcd(q.yy, 1.0, 0.0, -1.0 / fy, 1.0)
    assert got.xy == 0j


@pytest.mark.parametrize("q", Q_CASES)
def test_thick_lens_abcd_bit_identical(q):
    a, b, c, d = 0.987, 2.373, -0.0194, 1.0
    got = q_matrix_after_abcd(
        q, Mat2.scalar(complex(a)), Mat2.scalar(complex(b)),
        Mat2.scalar(complex(c)), Mat2.scalar(complex(d)),
    )
    assert got.xx == _q_after_abcd(q.xx, a, b, c, d)
    assert got.yy == _q_after_abcd(q.yy, a, b, c, d)


def test_degenerate_denominator_guard_matches():
    q = QMatrix(complex(0.0, 1.0), complex(0.0, 1.0))
    got = q_matrix_after_abcd(q, IDENT, ZERO, Mat2.scalar(0j), Mat2.scalar(0j))
    assert got.xx == q.xx and got.yy == q.yy


@pytest.mark.parametrize("q", Q_CASES)
def test_widths_match_gaussian_width_mm(q):
    major, minor, azim = q_matrix_principal_widths(q, WL)
    wx = gaussian_width_mm(q.xx, WL)
    wy = gaussian_width_mm(q.yy, WL)
    assert {major, minor} == {wx, wy}
    assert azim == (0.0 if wx >= wy else math.pi / 2.0)


# --------------------------------------------------------------------------
# the general path Step 2 needs
# --------------------------------------------------------------------------

def _rot(theta):
    c, s = math.cos(theta), math.sin(theta)
    return Mat2(complex(c), complex(s), complex(-s), complex(c))


def _transpose(m):
    return Mat2(m.xx, m.yx, m.xy, m.yy)


def _conj(q, r):
    """Q expressed in a frame rotated by R:  Q -> R.Q.R^T."""
    return QMatrix.from_mat2(r @ q.as_mat2() @ _transpose(r))


def _cyl_power(theta, f):
    c, s = math.cos(theta), math.sin(theta)
    return Mat2(complex(c * c / f), complex(c * s / f),
                complex(c * s / f), complex(s * s / f))


def _neg(m):
    return Mat2(-m.xx, -m.xy, -m.yx, -m.yy)


@pytest.mark.parametrize("theta_deg", [0.0, 9.22, 30.0, 45.0, 90.0, 123.4])
def test_rotated_cylindrical_matches_frame_conjugation(theta_deg):
    """A cylindrical lens whose power axis is rotated by theta can be applied
    either as a rotated power TENSOR, or by rotating into the lens frame,
    applying the diagonal lens and rotating back. The two must agree."""
    theta, f = math.radians(theta_deg), 40.0
    q0 = Q_CASES[0]

    direct = q_matrix_after_abcd(q0, IDENT, ZERO, _neg(_cyl_power(theta, f)), IDENT)

    r = _rot(theta)
    in_frame = q_matrix_after_abcd(
        _conj(q0, r), IDENT, ZERO, Mat2.diag(complex(-1.0 / f), 0j), IDENT,
    )
    conj_back = _conj(in_frame, _transpose(r))

    assert cmath.isclose(direct.xx, conj_back.xx, rel_tol=1e-11, abs_tol=1e-11)
    assert cmath.isclose(direct.yy, conj_back.yy, rel_tol=1e-11, abs_tol=1e-11)
    assert cmath.isclose(direct.xy, conj_back.xy, rel_tol=1e-11, abs_tol=1e-11)


def test_thin_lens_leaves_the_intensity_ellipse_alone():
    """``Q'^-1 = Q^-1 - P`` with P REAL, so Im(Q^-1) — and therefore the spot
    shape — is invariant across a thin lens, however the lens is rotated.
    Only the wavefront changes. This is a sharp check on the matrix law."""
    q0 = Q_CASES[0]
    p = _cyl_power(math.radians(45.0), 40.0)
    out = q_matrix_after_abcd(q0, IDENT, ZERO, _neg(p), IDENT)
    before = q_matrix_principal_widths(q0, WL)
    after = q_matrix_principal_widths(out, WL)
    assert after[0] == pytest.approx(before[0], rel=1e-11)
    assert after[1] == pytest.approx(before[1], rel=1e-11)

    inv_in = q0.as_mat2().inverse()
    inv_out = out.as_mat2().inverse()
    for got, exp in ((inv_out.xx, inv_in.xx - p.xx), (inv_out.yy, inv_in.yy - p.yy),
                     (inv_out.xy, inv_in.xy - p.xy)):
        assert cmath.isclose(got, exp, rel_tol=1e-11, abs_tol=1e-15)


def test_rotated_cylindrical_needs_the_off_diagonal():
    """The whole point of Step 1: a cylindrical lens at 45 deg followed by
    free space gives a beam whose principal axes are rotated away from the
    element frame — a state the old scalar (qx, qy) pair could not hold."""
    out = q_matrix_after_abcd(
        Q_CASES[0], IDENT, ZERO, _neg(_cyl_power(math.radians(45.0), 40.0)), IDENT,
    )
    assert abs(out.xy) > 1e-6
    out = q_matrix_after_abcd(out, *_free_space(200.0))

    major, minor, azim = q_matrix_principal_widths(out, WL)
    assert major > minor > 0.0
    assert math.degrees(abs(azim)) > 1.0        # genuinely off-axis


def test_widths_are_rotation_covariant():
    q, theta = Q_CASES[0], math.radians(37.0)
    maj0, min0, az0 = q_matrix_principal_widths(q, WL)
    maj1, min1, az1 = q_matrix_principal_widths(_conj(q, _rot(theta)), WL)
    assert maj1 == pytest.approx(maj0, rel=1e-11)
    assert min1 == pytest.approx(min0, rel=1e-11)
    assert (az1 - (az0 - theta)) % math.pi == pytest.approx(0.0, abs=1e-9)


# --------------------------------------------------------------------------
# the ray carries it
# --------------------------------------------------------------------------

def test_ray_off_diagonal_defaults_zero_and_round_trips():
    ray = make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=WL, power_mw=1.0,
    )
    assert ray.qxy == 0j
    assert ray.q_matrix == QMatrix(ray.qx, ray.qy, 0j)
    assert ray.with_q_matrix(ray.q_matrix) == ray

    spun = ray.with_q_matrix(QMatrix(ray.qx, ray.qy, complex(1.5, -2.5)))
    assert spun.qxy == complex(1.5, -2.5)
    assert spun.replaced(power_mw=9.0).qxy == complex(1.5, -2.5)
