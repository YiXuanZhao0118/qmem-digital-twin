"""Readout tensors (Step 2c of the general-astigmatism upgrade).

Steps 1/2 made Q frame-correct. That left `width_mult_x/y` and `m2x/y` as
scalar PER-AXIS quantities riding alongside a Q that rotates — so after any
non-trivial frame change the multiplier was scaling a different axis than the
q it belongs to. 2c makes both symmetric tensors that turn with Q, in one
`BeamRay.rotated_frame` call so they cannot come apart.

The invariant worth remembering: **the real beam's principal widths must not
depend on which frame the state happens to be expressed in.**
"""

import math

import pytest

from app.optical.beam_ray import (
    QMatrix,
    Vec3,
    beam_real_widths,
    make_beam_ray,
    q_matrix_principal_widths,
    q_rotate,
    q_width_tensor,
    sym2_eig,
    sym2_rotate,
)

WL = 852.347
LAM_MM = WL * 1e-6
Q_ASTIG = QMatrix(complex(-188.8, 1792.6), complex(-626.0, 1232.6))


def _ray(**kw):
    r = make_beam_ray(
        origin=Vec3(0, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=WL, power_mw=1.0,
    )
    return r.replaced(qx=Q_ASTIG.xx, qy=Q_ASTIG.yy, **kw)


# --------------------------------------------------------------------------
# sym2 primitives
# --------------------------------------------------------------------------

@pytest.mark.parametrize("phi_deg", [0.0, 17.0, 45.0, 90.0])
def test_isotropic_tensor_is_rotation_exempt(phi_deg):
    """Not an approximation: an isotropic tensor IS the same in every frame.
    This exactness is what keeps every equal-M2 beam bit-unchanged."""
    assert sym2_rotate(2.0, 2.0, 0.0, math.radians(phi_deg)) == (2.0, 2.0, 0.0)


def test_zero_angle_is_exempt_even_when_anisotropic():
    assert sym2_rotate(4.0, 1.0, 0.3, 0.0) == (4.0, 1.0, 0.3)


def test_quarter_turn_swaps_the_diagonal():
    xx, yy, xy = sym2_rotate(4.0, 1.0, 0.0, math.pi / 2)
    assert xx == pytest.approx(1.0, rel=1e-12)
    assert yy == pytest.approx(4.0, rel=1e-12)
    assert xy == pytest.approx(0.0, abs=1e-12)


@pytest.mark.parametrize("phi_deg", [13.0, 45.0, -77.0])
def test_rotation_round_trips_and_preserves_the_eigenvalues(phi_deg):
    phi = math.radians(phi_deg)
    t = (4.0, 1.0, 0.0)
    r = sym2_rotate(*t, phi)
    assert sym2_eig(*r)[0] == pytest.approx(sym2_eig(*t)[0], rel=1e-12)
    assert sym2_eig(*r)[1] == pytest.approx(sym2_eig(*t)[1], rel=1e-12)
    back = sym2_rotate(*r, -phi)
    for got, exp in zip(back, t):
        assert got == pytest.approx(exp, rel=1e-12, abs=1e-12)


def test_sym2_eig_matches_a_known_decomposition():
    # diag(9, 1) rotated by 30 deg must eigen-decompose back to 9 and 1 at 30 deg
    xx, yy, xy = sym2_rotate(9.0, 1.0, 0.0, math.radians(30.0))
    a, b, azim = sym2_eig(xx, yy, xy)
    assert a == pytest.approx(9.0, rel=1e-12)
    assert b == pytest.approx(1.0, rel=1e-12)
    assert (azim + math.radians(30.0)) % math.pi == pytest.approx(0.0, abs=1e-12)


# --------------------------------------------------------------------------
# width tensor from Q
# --------------------------------------------------------------------------

def test_width_tensor_eigenvalues_are_the_principal_widths():
    a, b, azim = sym2_eig(*q_width_tensor(Q_ASTIG, WL))
    maj, mnr, az_q = q_matrix_principal_widths(Q_ASTIG, WL)
    assert math.sqrt(a) == pytest.approx(maj, rel=1e-11)
    assert math.sqrt(b) == pytest.approx(mnr, rel=1e-11)
    assert (azim - az_q) % math.pi == pytest.approx(0.0, abs=1e-9)


def test_unit_multiplier_reproduces_the_embedded_widths():
    maj, mnr, _ = q_matrix_principal_widths(Q_ASTIG, WL)
    rmaj, rmnr, _ = beam_real_widths(Q_ASTIG, WL)
    assert rmaj == pytest.approx(maj, rel=1e-11)
    assert rmnr == pytest.approx(mnr, rel=1e-11)


def test_diagonal_multiplier_scales_each_axis():
    """Recovers exactly the pre-2c `embedded_width * width_mult` per axis."""
    wx = math.sqrt(q_width_tensor(Q_ASTIG, WL)[0])
    wy = math.sqrt(q_width_tensor(Q_ASTIG, WL)[1])
    maj, mnr, _ = beam_real_widths(Q_ASTIG, WL, 2.0, 3.0, 0.0)
    assert {round(maj, 9), round(mnr, 9)} == {round(2.0 * wx, 9), round(3.0 * wy, 9)}


# --------------------------------------------------------------------------
# THE invariant
# --------------------------------------------------------------------------

@pytest.mark.parametrize("phi_deg", [0.0, 12.0, 45.0, 90.0, 143.0])
def test_real_widths_are_frame_independent(phi_deg):
    """An ANISOTROPIC multiplier is exactly the case that used to break: Q
    rotated, the multiplier did not, and the reported width changed with the
    frame. Rotating both together must leave the physical answer alone."""
    phi = math.radians(phi_deg)
    s0 = (2.0, 3.0, 0.0)
    maj0, min0, az0 = beam_real_widths(Q_ASTIG, WL, *s0)

    maj1, min1, az1 = beam_real_widths(
        q_rotate(Q_ASTIG, phi), WL, *sym2_rotate(*s0, phi),
    )
    assert maj1 == pytest.approx(maj0, rel=1e-11)
    assert min1 == pytest.approx(min0, rel=1e-11)
    assert (az1 - (az0 - phi)) % math.pi == pytest.approx(0.0, abs=1e-9)


@pytest.mark.parametrize("phi_deg", [12.0, 45.0, 90.0])
def test_rotating_q_alone_would_have_changed_the_answer(phi_deg):
    """Guard on the guard: if only Q turned — the pre-2c behaviour — the real
    widths WOULD move. Without this, the test above could pass vacuously."""
    phi = math.radians(phi_deg)
    s0 = (2.0, 3.0, 0.0)
    maj0, _, _ = beam_real_widths(Q_ASTIG, WL, *s0)
    maj_broken, _, _ = beam_real_widths(q_rotate(Q_ASTIG, phi), WL, *s0)
    assert abs(maj_broken - maj0) > 1e-4


# --------------------------------------------------------------------------
# BeamRay.rotated_frame
# --------------------------------------------------------------------------

def test_isotropic_multipliers_are_untouched_while_q_still_turns():
    """The live-scene case: every beam there has equal M2 on both axes. Q is
    astigmatic and must rotate; the multipliers are isotropic and must come
    through bit-identical, which is why 2c moved no numbers in that scene."""
    ray = _ray()
    out = ray.rotated_frame(0.9)
    assert out.width_mult_tensor == ray.width_mult_tensor
    assert out.m2_tensor == ray.m2_tensor
    assert out.qx != ray.qx          # Q is anisotropic, so it genuinely turns
    assert out.real_widths()[0] == pytest.approx(ray.real_widths()[0], rel=1e-11)


def test_rotated_frame_turns_all_three_together():
    ray = _ray(width_mult_x=2.0, width_mult_y=3.0, m2x=4.0, m2y=9.0)
    out = ray.rotated_frame(math.pi / 2)
    assert out.qx == pytest.approx(ray.qy, rel=1e-12)
    assert out.width_mult_x == pytest.approx(3.0, rel=1e-12)
    assert out.width_mult_y == pytest.approx(2.0, rel=1e-12)
    assert out.m2x == pytest.approx(9.0, rel=1e-12)
    assert out.m2y == pytest.approx(4.0, rel=1e-12)


@pytest.mark.parametrize("phi_deg", [23.0, 45.0, 111.0])
def test_ray_real_widths_survive_a_frame_change(phi_deg):
    ray = _ray(width_mult_x=2.0, width_mult_y=3.0, m2x=4.0, m2y=9.0)
    a = ray.real_widths()
    b = ray.rotated_frame(math.radians(phi_deg)).real_widths()
    assert b[0] == pytest.approx(a[0], rel=1e-11)
    assert b[1] == pytest.approx(a[1], rel=1e-11)


def test_zero_angle_leaves_the_ray_identical():
    ray = _ray(width_mult_x=2.0, m2x=4.0)
    assert ray.rotated_frame(0.0) == ray
