"""Q-matrix frame transport (Step 2a of the general-astigmatism upgrade).

Step 1 gave the algebra; this adds the *frame* — Q is carried in the same
beam-local (s, p) basis as the Jones vector, so every rotation here is the
identical angle the Jones twin computes, and the polarization frame and the
astigmatism frame can never drift apart.

These tests pin down the frame primitives themselves. 2b then wired them into
the ops and 2c extended the same rotation to the readout tensors; the invariant
they all rest on is that Q, the width-multiplier tensor and the M2 tensor turn
by ONE angle, together (see test_readout_tensor.py).
"""

import math

import pytest

from app.optical.beam_ray import (
    Mat2,
    QMatrix,
    Vec3,
    q_after_thin_element,
    q_matrix_after_abcd,
    q_matrix_principal_widths,
    q_power_tensor,
    q_rotate,
)
from app.optical.jones import (
    beam_local_sp,
    q_axis_to_beam,
    q_beam_to_axis,
    q_frame_angle_to_axis,
    sp_rotation_between_directions,
    rotate_jones,
)

WL = 852.347
LAM_MM = WL * 1e-6
Q_ASTIG = QMatrix(complex(-188.8, 1792.6), complex(-626.0, 1232.6))


def _collimated(w_mm):
    """q of a collimated beam at its waist."""
    return complex(0.0, math.pi * w_mm * w_mm / LAM_MM)


# --------------------------------------------------------------------------
# q_rotate
# --------------------------------------------------------------------------

def test_zero_rotation_is_the_same_object():
    """Exact identity, so an all-aligned scene stays bit-unchanged."""
    assert q_rotate(Q_ASTIG, 0.0) is Q_ASTIG


def test_quarter_turn_swaps_the_axes():
    out = q_rotate(Q_ASTIG, math.pi / 2)
    assert out.xx == pytest.approx(Q_ASTIG.yy, rel=1e-12)
    assert out.yy == pytest.approx(Q_ASTIG.xx, rel=1e-12)
    assert abs(out.xy) < 1e-12


@pytest.mark.parametrize("phi_deg", [9.22, 45.0, 137.0, -60.0])
def test_rotation_round_trips(phi_deg):
    phi = math.radians(phi_deg)
    back = q_rotate(q_rotate(Q_ASTIG, phi), -phi)
    assert back.xx == pytest.approx(Q_ASTIG.xx, rel=1e-12)
    assert back.yy == pytest.approx(Q_ASTIG.yy, rel=1e-12)
    assert abs(back.xy) < 1e-11


@pytest.mark.parametrize("phi_deg", [0.0, 17.0, 45.0, 90.0])
def test_rotation_preserves_widths_and_turns_the_azimuth(phi_deg):
    phi = math.radians(phi_deg)
    maj0, min0, az0 = q_matrix_principal_widths(Q_ASTIG, WL)
    maj1, min1, az1 = q_matrix_principal_widths(q_rotate(Q_ASTIG, phi), WL)
    assert maj1 == pytest.approx(maj0, rel=1e-11)
    assert min1 == pytest.approx(min0, rel=1e-11)
    assert (az1 - (az0 - phi)) % math.pi == pytest.approx(0.0, abs=1e-9)


def test_q_and_jones_share_the_rotation_convention():
    """A linear polarization lying along Q's major axis must still lie along it
    after both are re-expressed in a rotated basis — the whole reason Q reuses
    rotate_jones' angle rather than inventing its own."""
    phi = math.radians(31.7)
    _, _, az = q_matrix_principal_widths(Q_ASTIG, WL)
    jones = (complex(math.cos(az)), complex(math.sin(az)))

    _, _, az_r = q_matrix_principal_widths(q_rotate(Q_ASTIG, phi), WL)
    e_s, e_p = rotate_jones(jones, phi)
    pol_angle = math.atan2(e_p.real, e_s.real)
    assert (pol_angle - az_r) % math.pi == pytest.approx(0.0, abs=1e-9)


# --------------------------------------------------------------------------
# power tensor
# --------------------------------------------------------------------------

@pytest.mark.parametrize("phi_deg", [0.0, 30.0, 45.0, 90.0])
def test_spherical_power_tensor_is_isotropic(phi_deg):
    p = q_power_tensor(1 / 100.0, 1 / 100.0, math.radians(phi_deg))
    assert p.xx == pytest.approx(1 / 100.0, rel=1e-14)
    assert p.yy == pytest.approx(1 / 100.0, rel=1e-14)
    assert abs(p.xy) < 1e-15


@pytest.mark.parametrize("phi_deg", [0.0, 22.5, 45.0, 73.0])
def test_thin_element_subtracts_the_power_tensor(phi_deg):
    """Q'^-1 = Q^-1 - P is the defining identity of a thin element."""
    p = q_power_tensor(1 / 40.0, 0.0, math.radians(phi_deg))
    out = q_after_thin_element(Q_ASTIG, p)
    inv_in = Q_ASTIG.as_mat2().inverse()
    inv_out = out.as_mat2().inverse()
    assert inv_out.xx == pytest.approx(inv_in.xx - p.xx, rel=1e-10)
    assert inv_out.yy == pytest.approx(inv_in.yy - p.yy, rel=1e-10)
    assert inv_out.xy == pytest.approx(inv_in.xy - p.xy, rel=1e-10, abs=1e-15)


def test_rotated_cylinder_equals_rotating_the_frame():
    """Applying a cylinder rotated by phi == rotating into its frame, applying
    the axis-aligned cylinder, and rotating back."""
    phi, f = math.radians(37.0), 40.0
    direct = q_after_thin_element(Q_ASTIG, q_power_tensor(1 / f, 0.0, phi))
    viaframe = q_rotate(
        q_after_thin_element(q_rotate(Q_ASTIG, phi), q_power_tensor(1 / f, 0.0, 0.0)),
        -phi,
    )
    assert direct.xx == pytest.approx(viaframe.xx, rel=1e-11)
    assert direct.yy == pytest.approx(viaframe.yy, rel=1e-11)
    assert direct.xy == pytest.approx(viaframe.xy, rel=1e-11, abs=1e-12)


# --------------------------------------------------------------------------
# the payoff: a cylindrical Galilean telescope at an arbitrary azimuth
# --------------------------------------------------------------------------

def _cyl_telescope(q, f1, f2, phi):
    """The two-lens anamorphic shaper: f1 (negative) then f2 at separation
    f1+f2, both with power along azimuth ``phi``. Magnification |f2/f1| on
    that axis only."""
    q = q_after_thin_element(q, q_power_tensor(1.0 / f1, 0.0, phi))
    q = q_matrix_after_abcd(
        q, Mat2.identity(), Mat2.scalar(complex(f1 + f2)),
        Mat2.scalar(0j), Mat2.identity(),
    )
    return q_after_thin_element(q, q_power_tensor(1.0 / f2, 0.0, phi))


@pytest.mark.parametrize("phi_deg", [0.0, 30.0, 45.0, 90.0, 115.0])
def test_cylindrical_telescope_expands_along_its_own_azimuth(phi_deg):
    """THE case the scalar (qx, qy) pair could not model: a 2x anamorphic
    telescope mounted at an arbitrary roll angle. The beam must come out
    elliptical with its major axis along the telescope's own azimuth."""
    phi = math.radians(phi_deg)
    w_in = 0.65
    q_in = QMatrix(_collimated(w_in), _collimated(w_in))     # round, collimated

    out = _cyl_telescope(q_in, -25.0, 50.0, phi)
    major, minor, azim = q_matrix_principal_widths(out, WL)

    assert major / minor == pytest.approx(2.0, rel=2e-3)     # M = |50/-25|
    assert minor == pytest.approx(w_in, rel=2e-3)            # untouched axis
    assert (azim - phi) % math.pi == pytest.approx(0.0, abs=1e-6)


def test_telescope_off_axis_needs_the_off_diagonal():
    """Motivation check: at 45 deg the output Q genuinely carries a non-zero
    off-diagonal, i.e. the pre-Step-1 state could not have held it."""
    w_in = 0.65
    q_in = QMatrix(_collimated(w_in), _collimated(w_in))
    out = _cyl_telescope(q_in, -25.0, 50.0, math.radians(45.0))
    assert abs(out.xy) > 1e-3


# --------------------------------------------------------------------------
# frame transport against real geometry
# --------------------------------------------------------------------------

@pytest.mark.parametrize("roll_deg", [0.0, 12.0, 45.0, 90.0])
def test_axis_beam_converters_are_inverses(roll_deg):
    direction = Vec3(1.0, 0.0, 0.0)
    s_beam, p_beam = beam_local_sp(direction)
    c, s = math.cos(math.radians(roll_deg)), math.sin(math.radians(roll_deg))
    axis_y = Vec3(
        s_beam.x * c + p_beam.x * s,
        s_beam.y * c + p_beam.y * s,
        s_beam.z * c + p_beam.z * s,
    )
    assert q_frame_angle_to_axis(axis_y, direction) == pytest.approx(
        math.radians(roll_deg), abs=1e-12)

    there = q_beam_to_axis(Q_ASTIG, axis_y, direction)
    back = q_axis_to_beam(there, axis_y, direction)
    assert back.xx == pytest.approx(Q_ASTIG.xx, rel=1e-12)
    assert back.yy == pytest.approx(Q_ASTIG.yy, rel=1e-12)
    assert abs(back.xy) < 1e-11


def test_frame_angle_ignores_the_longitudinal_component():
    """An anchor axisY need only be *approximately* perpendicular; its
    component along the propagation direction must not tilt the answer."""
    direction = Vec3(1.0, 0.0, 0.0)
    s_beam, _ = beam_local_sp(direction)
    tilted = Vec3(s_beam.x + 0.3, s_beam.y, s_beam.z)
    assert q_frame_angle_to_axis(tilted, direction) == pytest.approx(
        q_frame_angle_to_axis(s_beam, direction), abs=1e-12)


def test_bend_rotation_is_exactly_zero_for_an_unbent_ray():
    """A ray that is not deflected must produce an EXACT zero angle, so
    rotated_frame short-circuits and the whole transverse state is untouched."""
    d = Vec3(0.3, -0.7, 0.2).normalized()
    assert sp_rotation_between_directions(d, d) == 0.0
    assert q_rotate(Q_ASTIG, sp_rotation_between_directions(d, d)) is Q_ASTIG
