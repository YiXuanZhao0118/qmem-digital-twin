"""Pytest for Faraday rotator op."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.registry import Face, PhysicsOpContext, get_op


FACE_A1 = Face(id="A1", position_mm_body_local=Vec3(0, 0, -9),
               normal_body_local=Vec3(0, 0, -1), aperture_mm=4, aperture_shape="circle")
FACE_B1 = Face(id="B1", position_mm_body_local=Vec3(0, 0, 9),
               normal_body_local=Vec3(0, 0, 1), aperture_mm=4, aperture_shape="circle")
FACE_A2 = Face(id="A2", position_mm_body_local=Vec3(0, 0, 9),
               normal_body_local=Vec3(0, 0, 1), aperture_mm=4, aperture_shape="circle")
FACE_B2 = Face(id="B2", position_mm_body_local=Vec3(0, 0, -9),
               normal_body_local=Vec3(0, 0, -1), aperture_mm=4, aperture_shape="circle")


def ray_with_jones(jones: tuple[complex, complex],
                   origin: Vec3 = Vec3(0, 0, -9),
                   direction: Vec3 = Vec3(0, 0, 1)) -> BeamRay:
    base = make_beam_ray(origin=origin, direction=direction,
                        wavelength_nm=850, power_mw=1.0)
    return base.replaced(jones=jones)


def ctx_forward(**overrides) -> PhysicsOpContext:
    params = {"rotationDeg": 45, "lengthMm": 18, "refractiveIndex": 1.95}
    params.update(overrides)
    return PhysicsOpContext(face_in=FACE_A1, face_out=FACE_B1, params=params)


def ctx_reverse(**overrides) -> PhysicsOpContext:
    params = {"rotationDeg": 45, "lengthMm": 18, "refractiveIndex": 1.95}
    params.update(overrides)
    return PhysicsOpContext(face_in=FACE_A2, face_out=FACE_B2, params=params)


def test_registered():
    op = get_op("faraday_rotator", "faraday_rotate")
    assert callable(op)


def test_rotate_pure_s_by_45():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_forward())
    a = math.sqrt(0.5)
    assert out.jones[0].real == pytest.approx(a, abs=1e-12)
    assert out.jones[1].real == pytest.approx(a, abs=1e-12)


def test_rotate_pure_p_by_45():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_forward())
    a = math.sqrt(0.5)
    assert out.jones[0].real == pytest.approx(-a, abs=1e-12)
    assert out.jones[1].real == pytest.approx(a, abs=1e-12)


def test_direction_aware_sign():
    """Forward rotates +45° in s/p; reverse rotates -45° in s/p (equals
    +45° in lab because p axis flips). Full isolator non-reciprocity
    emerges only in the scene tracer which re-bases jones across
    direction changes."""
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [fwd] = op(ray, ctx_forward())
    a = math.sqrt(0.5)
    assert fwd.jones[0].real == pytest.approx(a, abs=1e-12)
    assert fwd.jones[1].real == pytest.approx(a, abs=1e-12)

    rev_ray = fwd.replaced(direction=Vec3(0, 0, -1))
    [rt] = op(rev_ray, ctx_reverse())
    # Reverse direction reverts the rotation in s/p frame.
    assert rt.jones[0].real == pytest.approx(1, abs=1e-9)
    assert rt.jones[1].real == pytest.approx(0, abs=1e-9)


def test_power_preserved():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_forward())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_ar_loss_per_face():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_forward(arResidualR=0.005))
    expected = 1.0 * (1 - 0.005) ** 2
    assert out.power_mw == pytest.approx(expected, abs=1e-12)


def test_q_propagates_by_L_over_n():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    B_expected = 18 / 1.95
    qx_in = ray.qx
    [out] = op(ray, ctx_forward())
    assert out.qx.real == pytest.approx(qx_in.real + B_expected, abs=1e-9)
    assert out.qx.imag == pytest.approx(qx_in.imag, abs=1e-12)


def test_chief_ray_propagates():
    op = get_op("faraday_rotator", "faraday_rotate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_forward())
    assert out.origin.z == pytest.approx(9, abs=1e-9)
    assert out.path_length_mm == pytest.approx(18, abs=1e-9)
