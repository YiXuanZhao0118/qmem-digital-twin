"""Pytest for waveplate op (mirrors frontend waveplate/physics.test.ts)."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.waveplate.physics import apply_waveplate
from app.optical.registry import Face, PhysicsOpContext, get_op


FACE_A = Face(id="A", position_mm_body_local=Vec3(0, 0, -0.5),
              normal_body_local=Vec3(0, 0, -1),
              aperture_mm=12.5, aperture_shape="rectangle")
FACE_B = Face(id="B", position_mm_body_local=Vec3(0, 0, 0.5),
              normal_body_local=Vec3(0, 0, 1),
              aperture_mm=12.5, aperture_shape="rectangle")


def ray_with_jones(jones: tuple[complex, complex]) -> BeamRay:
    base = make_beam_ray(
        origin=Vec3(0, 0, -0.5),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780, power_mw=1.0,
    )
    return base.replaced(jones=jones)


def ctx(ret_deg: float, fast_deg: float) -> PhysicsOpContext:
    return PhysicsOpContext(
        face_in=FACE_A, face_out=FACE_B,
        params={
            "retardanceDeg": ret_deg,
            "fastAxisDegBeamLocal": fast_deg,
            "lengthMm": 1.0, "refractiveIndex": 1.5,
        },
    )


def test_registered():
    op = get_op("waveplate", "jones_waveplate")
    assert callable(op)


def test_hwp_theta0_s_preserved():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx(180, 0))
    assert out.jones[0].real == pytest.approx(1, abs=1e-12)
    assert out.jones[1].real == pytest.approx(0, abs=1e-12)
    assert out.power_mw == pytest.approx(1, abs=1e-12)


def test_hwp_theta0_p_phase_flipped():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx(180, 0))
    assert out.jones[1].real == pytest.approx(-1, abs=1e-12)
    assert out.jones[1].imag == pytest.approx(0, abs=1e-12)


def test_hwp_theta45_s_to_p():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx(180, 45))
    assert out.jones[0].real == pytest.approx(0, abs=1e-9)
    assert out.jones[1].real == pytest.approx(1, abs=1e-9)


def test_hwp_22_5deg_rotates_to_45_linear():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx(180, 22.5))
    a = math.sqrt(0.5)
    assert out.jones[0].real == pytest.approx(a, abs=1e-9)
    assert out.jones[1].real == pytest.approx(a, abs=1e-9)


def test_qwp_theta45_makes_circular():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx(90, 45))
    mag_s = out.jones[0].real ** 2 + out.jones[0].imag ** 2
    mag_p = out.jones[1].real ** 2 + out.jones[1].imag ** 2
    assert mag_s == pytest.approx(0.5, abs=1e-9)
    assert mag_p == pytest.approx(0.5, abs=1e-9)
    phase_s = math.atan2(out.jones[0].imag, out.jones[0].real)
    phase_p = math.atan2(out.jones[1].imag, out.jones[1].real)
    diff = phase_s - phase_p
    normalized = ((diff + math.pi) % (2 * math.pi)) - math.pi
    assert abs(abs(normalized) - math.pi / 2) < 1e-9


def test_power_conservation_unitary():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(0.6, 0), complex(0.8, 0)))
    [out] = op(ray, ctx(90, 30))
    mag_out = (out.jones[0].real ** 2 + out.jones[0].imag ** 2
               + out.jones[1].real ** 2 + out.jones[1].imag ** 2)
    assert mag_out == pytest.approx(1, abs=1e-12)
    assert out.power_mw == pytest.approx(1, abs=1e-12)


def test_q_slab_propagation():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    b_expected = 1 / 1.5
    qx_in = ray.qx
    [out] = op(ray, ctx(180, 0))
    assert out.qx.real == pytest.approx(qx_in.real + b_expected, abs=1e-9)


def test_q_slab_propagation_accepts_thickness_alias():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, PhysicsOpContext(
        face_in=FACE_A,
        face_out=FACE_B,
        params={
            "retardanceDeg": 180.0,
            "fastAxisDegBeamLocal": 0.0,
            "thicknessMm": 2.0,
            "refractiveIndex": 1.5,
        },
    ))
    assert out.qx.real == pytest.approx(ray.qx.real + 2.0 / 1.5, abs=1e-9)


def test_chief_ray_propagates():
    op = get_op("waveplate", "jones_waveplate")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx(180, 0))
    assert out.origin.z == pytest.approx(0.5, abs=1e-12)
    assert out.path_length_mm == pytest.approx(1, abs=1e-12)


def test_apply_waveplate_helper_hwp_45():
    out = apply_waveplate(
        (complex(1, 0), complex(0, 0)),
        math.pi, math.pi / 4,
    )
    assert out[0].real == pytest.approx(0, abs=1e-9)
    assert out[1].real == pytest.approx(1, abs=1e-9)
