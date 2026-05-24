"""Pytest for lens PhysicsOp (Python mirror of frontend physics.test.ts)."""

import math

import pytest

from app.optical import kinds  # noqa: F401  ensures registration
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.registry import Face, PhysicsOpContext, get_op


FACE_IN = Face(
    id="A",
    position_mm_body_local=Vec3(0, 0, -1.5),
    aperture_mm=12.7,
    aperture_shape="circle",
)
FACE_OUT = Face(
    id="B",
    position_mm_body_local=Vec3(0, 0, +1.5),
    aperture_mm=12.7,
    aperture_shape="circle",
)


def make_on_axis_ray() -> BeamRay:
    return make_beam_ray(
        origin=Vec3(0, 0, -1.5),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
        waist_radius_mm=0.5,
        power_mw=1.0,
    )


def test_registered():
    op = get_op("lens", "abcd_thin_lens")
    assert callable(op)


def test_throws_on_missing_focal():
    op = get_op("lens", "abcd_thin_lens")
    ray = make_on_axis_ray()
    with pytest.raises(ValueError, match="focalLengthMm"):
        op(ray, PhysicsOpContext(face_in=FACE_IN, face_out=FACE_OUT, params={}))


def test_chief_ray_propagates():
    op = get_op("lens", "abcd_thin_lens")
    ray = make_on_axis_ray()
    [out] = op(ray, PhysicsOpContext(
        face_in=FACE_IN, face_out=FACE_OUT, params={"focalLengthMm": 50}
    ))
    assert out.origin.z == pytest.approx(1.5, abs=1e-9)
    assert out.path_length_mm == pytest.approx(3.0, abs=1e-9)


def test_q_transformation():
    op = get_op("lens", "abcd_thin_lens")
    ray = make_on_axis_ray()
    # Set qx,qy real part to 0 (at-waist)
    ray = ray.replaced(qx=complex(0, ray.qx.imag), qy=complex(0, ray.qy.imag))
    [out] = op(ray, PhysicsOpContext(
        face_in=FACE_IN, face_out=FACE_OUT, params={"focalLengthMm": 50}
    ))
    f = 50.0
    z_r = ray.qx.imag
    # Expected q' = q / (1 - q/f) with q = i*zR
    denom = complex(1.0, -z_r / f)
    expected = complex(0.0, z_r) / denom
    assert out.qx.real == pytest.approx(expected.real, abs=1e-9)
    assert out.qx.imag == pytest.approx(expected.imag, abs=1e-9)


def test_preserves_jones_power_wavelength_direction():
    op = get_op("lens", "abcd_thin_lens")
    ray = make_on_axis_ray()
    [out] = op(ray, PhysicsOpContext(
        face_in=FACE_IN, face_out=FACE_OUT, params={"focalLengthMm": 50}
    ))
    assert out.jones == ray.jones
    assert out.power_mw == ray.power_mw
    assert out.wavelength_nm == ray.wavelength_nm
    assert out.direction == ray.direction


def test_returns_single_ray():
    op = get_op("lens", "abcd_thin_lens")
    ray = make_on_axis_ray()
    outs = op(ray, PhysicsOpContext(
        face_in=FACE_IN, face_out=FACE_OUT, params={"focalLengthMm": 50}
    ))
    assert len(outs) == 1
