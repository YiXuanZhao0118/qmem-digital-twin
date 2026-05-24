"""Pytest for mirror PhysicsOp."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.mirror.physics import reflect_direction
from app.optical.registry import Face, PhysicsOpContext, get_op


def face_with_normal(nx: float, ny: float, nz: float) -> Face:
    return Face(
        id="A",
        position_mm_body_local=Vec3(0, 0, 0),
        normal_body_local=Vec3(nx, ny, nz),
        aperture_mm=12.7,
        aperture_shape="circle",
    )


def make_incoming_ray(dx: float, dy: float, dz: float) -> BeamRay:
    return make_beam_ray(
        origin=Vec3(0, 0, 0),
        direction=Vec3(dx, dy, dz),
        wavelength_nm=780,
    )


def test_registered():
    op = get_op("mirror", "reflect_specular")
    assert callable(op)


def test_throws_without_normal():
    op = get_op("mirror", "reflect_specular")
    ray = make_incoming_ray(0, 0, -1)
    face = Face(
        id="A", position_mm_body_local=Vec3(0, 0, 0),
        normal_body_local=None, aperture_mm=12.7, aperture_shape="circle",
    )
    with pytest.raises(ValueError, match="normal_body_local"):
        op(ray, PhysicsOpContext(face_in=face, face_out=face, params={}))


def test_normal_incidence():
    op = get_op("mirror", "reflect_specular")
    face = face_with_normal(0, 0, 1)
    ray = make_incoming_ray(0, 0, -1)
    [out] = op(ray, PhysicsOpContext(face_in=face, face_out=face, params={}))
    assert out.direction.x == pytest.approx(0, abs=1e-12)
    assert out.direction.y == pytest.approx(0, abs=1e-12)
    assert out.direction.z == pytest.approx(1, abs=1e-12)


def test_45_degrees():
    op = get_op("mirror", "reflect_specular")
    face = face_with_normal(0, 0, 1)
    a = math.sqrt(0.5)
    ray = make_incoming_ray(a, 0, -a)
    [out] = op(ray, PhysicsOpContext(face_in=face, face_out=face, params={}))
    assert out.direction.x == pytest.approx(a, abs=1e-12)
    assert out.direction.y == pytest.approx(0, abs=1e-12)
    assert out.direction.z == pytest.approx(a, abs=1e-12)


def test_reflectivity():
    op = get_op("mirror", "reflect_specular")
    face = face_with_normal(0, 0, 1)
    ray = make_incoming_ray(0, 0, -1)
    [out] = op(ray, PhysicsOpContext(
        face_in=face, face_out=face, params={"reflectivity": 0.97}
    ))
    assert out.power_mw == pytest.approx(ray.power_mw * 0.97, abs=1e-12)


def test_preserves_origin_qx_qy_wavelength():
    op = get_op("mirror", "reflect_specular")
    face = face_with_normal(0, 0, 1)
    ray = make_incoming_ray(0, 0, -1)
    [out] = op(ray, PhysicsOpContext(face_in=face, face_out=face, params={}))
    assert out.origin == ray.origin
    assert out.wavelength_nm == ray.wavelength_nm
    assert out.qx == ray.qx
    assert out.qy == ray.qy


def test_returns_single_ray():
    op = get_op("mirror", "reflect_specular")
    face = face_with_normal(0, 0, 1)
    ray = make_incoming_ray(0, 0, -1)
    outs = op(ray, PhysicsOpContext(face_in=face, face_out=face, params={}))
    assert len(outs) == 1


def test_reflect_direction_helper():
    d = Vec3(1, 2, 3)
    n = Vec3(0, 0, 1)
    d_prime = reflect_direction(d, n)
    assert d_prime.x == pytest.approx(1, abs=1e-12)
    assert d_prime.y == pytest.approx(2, abs=1e-12)
    assert d_prime.z == pytest.approx(-3, abs=1e-12)
