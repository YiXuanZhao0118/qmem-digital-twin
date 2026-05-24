"""Pytest for PBS ops (mirrors frontend pbs/physics.test.ts)."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.registry import Face, PhysicsOpContext, get_op


D = 10.0
SQRT_HALF = math.sqrt(0.5)

FACE_BACK = Face(id="back",
                 position_mm_body_local=Vec3(0, 0, -D / 2),
                 normal_body_local=Vec3(0, 0, -1),
                 aperture_mm=D / 2, aperture_shape="rectangle")
FACE_FRONT = Face(id="front",
                  position_mm_body_local=Vec3(0, 0, D / 2),
                  normal_body_local=Vec3(0, 0, 1),
                  aperture_mm=D / 2, aperture_shape="rectangle")
FACE_RIGHT = Face(id="right",
                  position_mm_body_local=Vec3(D / 2, 0, 0),
                  normal_body_local=Vec3(1, 0, 0),
                  aperture_mm=D / 2, aperture_shape="rectangle")
# Internal Brewster plate at 45 deg, normal pointing to back-up corner.
# Reflects back->right and front->left.
FACE_B1 = Face(id="B1", position_mm_body_local=Vec3(0, 0, 0),
               normal_body_local=Vec3(-SQRT_HALF, 0, SQRT_HALF),
               aperture_mm=D * math.sqrt(2) / 2, aperture_shape="rectangle")


def ray_with_jones(jones: tuple[complex, complex], power_mw: float = 1.0) -> BeamRay:
    base = make_beam_ray(
        origin=Vec3(0, 0, -D / 2),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780, power_mw=power_mw,
    )
    return base.replaced(jones=jones)


def ctx_transmit(**overrides) -> PhysicsOpContext:
    params = {"cubeSizeMm": D, "refractiveIndex": 1.5168}
    params.update(overrides)
    return PhysicsOpContext(
        face_in=FACE_BACK, face_out=FACE_FRONT, params=params,
        face_via=(FACE_B1,),
    )


def ctx_reflect(**overrides) -> PhysicsOpContext:
    params = {"cubeSizeMm": D, "refractiveIndex": 1.5168}
    params.update(overrides)
    return PhysicsOpContext(
        face_in=FACE_BACK, face_out=FACE_RIGHT, params=params,
        face_via=(FACE_B1,),
    )


# ---------------------------------------------------------------------------
# pbs_transmit_p
# ---------------------------------------------------------------------------

def test_transmit_registered():
    op = get_op("pbs", "pbs_transmit_p")
    assert callable(op)


def test_transmit_pure_s_full_power():
    op = get_op("pbs", "pbs_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_transmit_pure_p_blocked():
    op = get_op("pbs", "pbs_transmit_p")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_transmit_45_linear_half_power():
    op = get_op("pbs", "pbs_transmit_p")
    a = math.sqrt(0.5)
    ray = ray_with_jones((complex(a, 0), complex(a, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.power_mw == pytest.approx(0.5, abs=1e-12)


def test_transmit_direction_unchanged():
    op = get_op("pbs", "pbs_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.direction == ray.direction


def test_transmit_exits_at_front_face():
    op = get_op("pbs", "pbs_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.origin.z == pytest.approx(D / 2, abs=1e-12)


# ---------------------------------------------------------------------------
# pbs_reflect_s
# ---------------------------------------------------------------------------

def test_reflect_registered():
    op = get_op("pbs", "pbs_reflect_s")
    assert callable(op)


def test_reflect_pure_p_full_power():
    op = get_op("pbs", "pbs_reflect_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_reflect())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_reflect_pure_s_blocked():
    op = get_op("pbs", "pbs_reflect_s")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_reflect())
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_reflect_45_linear_half_power():
    op = get_op("pbs", "pbs_reflect_s")
    a = math.sqrt(0.5)
    ray = ray_with_jones((complex(a, 0), complex(a, 0)))
    [out] = op(ray, ctx_reflect())
    assert out.power_mw == pytest.approx(0.5, abs=1e-12)


def test_reflect_direction_from_mirror_formula():
    """Beam from back (k=+z) reflects off plate normal (-0.7071,0,0.7071)
    via k_out = k_in - 2(k.n)n = (1,0,0) = +x (right face)."""
    op = get_op("pbs", "pbs_reflect_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_reflect())
    assert out.direction.x == pytest.approx(1, abs=1e-12)
    assert out.direction.y == pytest.approx(0, abs=1e-12)
    assert out.direction.z == pytest.approx(0, abs=1e-12)


def test_reflect_exits_at_right_face():
    op = get_op("pbs", "pbs_reflect_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_reflect())
    assert out.origin.x == pytest.approx(D / 2, abs=1e-12)
    assert out.origin.z == pytest.approx(0, abs=1e-12)


def test_reflect_requires_via_face():
    """pbs_reflect_s without via=[B1] should fail clearly."""
    op = get_op("pbs", "pbs_reflect_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    bad_ctx = PhysicsOpContext(
        face_in=FACE_BACK, face_out=FACE_RIGHT,
        params={"cubeSizeMm": D, "refractiveIndex": 1.5168},
        face_via=(),  # missing!
    )
    with pytest.raises(ValueError, match="via"):
        op(ray, bad_ctx)


# ---------------------------------------------------------------------------
# q-parameter slab
# ---------------------------------------------------------------------------

def test_q_propagates_by_d_over_n():
    op = get_op("pbs", "pbs_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    b_expected = D / 1.5168
    qx_in = ray.qx
    [out] = op(ray, ctx_transmit())
    assert out.qx.real == pytest.approx(qx_in.real + b_expected, abs=1e-9)
    assert out.qx.imag == pytest.approx(qx_in.imag, abs=1e-12)
