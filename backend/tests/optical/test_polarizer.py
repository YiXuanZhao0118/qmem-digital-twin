"""Pytest for polarizer PhysicsOp."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.polarizer.physics import apply_linear_polarizer
from app.optical.registry import Face, PhysicsOpContext, get_op


FACE_IN = Face(
    id="A1", position_mm_body_local=Vec3(0, 0, -3.75),
    aperture_mm=6, aperture_shape="rectangle",
)
FACE_OUT = Face(
    id="B1", position_mm_body_local=Vec3(0, 0, +3.75),
    aperture_mm=6, aperture_shape="rectangle",
)


def ray_with_jones(jones: tuple[complex, complex], power_mw: float = 1.0) -> BeamRay:
    base = make_beam_ray(
        origin=Vec3(0, 0, -3.75),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
        power_mw=power_mw,
    )
    return base.replaced(jones=jones)


def ctx_at(axis_deg: float) -> PhysicsOpContext:
    return PhysicsOpContext(
        face_in=FACE_IN, face_out=FACE_OUT,
        params={"transmissionAxisDegBeamLocal": axis_deg},
    )


def test_registered():
    op = get_op("polarizer", "jones_polarizer")
    assert callable(op)


def test_axis_0_pure_s_passes():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)), 1.0)
    [out] = op(ray, ctx_at(0))
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)
    assert out.jones[0].real == pytest.approx(1, abs=1e-12)
    assert out.jones[1].real == pytest.approx(0, abs=1e-12)


def test_axis_0_pure_p_blocked():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)), 1.0)
    [out] = op(ray, ctx_at(0))
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_axis_0_45deg_malus_half():
    op = get_op("polarizer", "jones_polarizer")
    a = math.sqrt(0.5)
    ray = ray_with_jones((complex(a, 0), complex(a, 0)), 1.0)
    [out] = op(ray, ctx_at(0))
    assert out.power_mw == pytest.approx(0.5, abs=1e-12)


def test_axis_90_pure_s_blocked():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)), 1.0)
    [out] = op(ray, ctx_at(90))
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_axis_30_malus_cos_squared():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)), 1.0)
    [out] = op(ray, ctx_at(30))
    assert out.power_mw == pytest.approx(0.75, abs=1e-12)


def test_chief_ray_propagates():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_at(0))
    assert out.origin.z == pytest.approx(3.75, abs=1e-12)
    assert out.path_length_mm == pytest.approx(7.5, abs=1e-12)


def test_preserves_wavelength_qx_qy_direction():
    op = get_op("polarizer", "jones_polarizer")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_at(0))
    assert out.wavelength_nm == ray.wavelength_nm
    assert out.qx == ray.qx
    assert out.qy == ray.qy
    assert out.direction == ray.direction


def test_renormalizes_jones_to_unit():
    op = get_op("polarizer", "jones_polarizer")
    a = math.sqrt(0.5)
    ray = ray_with_jones((complex(a, 0), complex(a, 0)), 1.0)
    [out] = op(ray, ctx_at(0))
    mag = (out.jones[0].real ** 2 + out.jones[0].imag ** 2
           + out.jones[1].real ** 2 + out.jones[1].imag ** 2)
    assert mag == pytest.approx(1, abs=1e-12)


def test_apply_linear_polarizer_helper():
    out = apply_linear_polarizer((complex(0.6, 0), complex(0.8, 0)), 0)
    assert out[0].real == pytest.approx(0.6, abs=1e-12)
    assert out[1].real == pytest.approx(0, abs=1e-12)
