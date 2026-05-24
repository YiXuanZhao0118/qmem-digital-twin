"""Pytest for Glan-Laser variant ops (PBS-like routing) with mirror-formula
reject and Snell at side exit. See asset-physics-model.md §3.3."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.registry import Face, PhysicsOpContext, get_op


# Glan-Laser IO-5 geometry (same physics as IO-3, just longer).
FACE_A1 = Face(id="A1", position_mm_body_local=Vec3(0, 0, -3.75),
               normal_body_local=Vec3(0, 0, -1),
               aperture_mm=2.5, aperture_shape="circle")
FACE_A2 = Face(id="A2", position_mm_body_local=Vec3(0, 0, 3.75),
               normal_body_local=Vec3(0, 0, 1),
               aperture_mm=2.5, aperture_shape="circle")
FACE_A3 = Face(id="A3", position_mm_body_local=Vec3(3.25, 0, 0),
               normal_body_local=Vec3(1, 0, 0),
               aperture_mm=3.0, aperture_shape="rectangle")
# B1 gap interface at 38.5 deg from optical axis, outward toward source side.
# n = (sin 38.5, 0, -cos 38.5) ~ (0.6225, 0, -0.7826)
FACE_B1 = Face(id="B1", position_mm_body_local=Vec3(0, 0, 0),
               normal_body_local=Vec3(0.6225146366081256, 0, -0.7826238278611087),
               aperture_mm=5.0, aperture_shape="rectangle")
FACE_B2 = Face(id="B2", position_mm_body_local=Vec3(0, 0, 0.15),
               normal_body_local=Vec3(0.6225146366081256, 0, -0.7826238278611087),
               aperture_mm=5.0, aperture_shape="rectangle")


def ray_with_jones(jones: tuple[complex, complex], power: float = 1.0) -> BeamRay:
    base = make_beam_ray(
        origin=Vec3(0, 0, -3.75),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780, power_mw=power,
    )
    return base.replaced(jones=jones)


def ctx_transmit() -> PhysicsOpContext:
    return PhysicsOpContext(
        face_in=FACE_A1, face_out=FACE_A2,
        params={"lengthMm": 7.5, "refractiveIndex_e": 1.48},
        face_via=(FACE_B1, FACE_B2),
    )


def ctx_reject() -> PhysicsOpContext:
    return PhysicsOpContext(
        face_in=FACE_A1, face_out=FACE_A3,
        params={"lengthMm": 7.5, "refractiveIndex_e": 1.48,
                "refractiveIndex_o": 1.66},
        face_via=(FACE_B1,),
    )


def test_registered():
    assert callable(get_op("pbs", "glan_transmit_p"))
    assert callable(get_op("pbs", "glan_reject_s"))
    assert callable(get_op("pbs", "pbs_transmit_p"))
    assert callable(get_op("pbs", "pbs_reflect_s"))
    assert callable(get_op("polarizer", "jones_polarizer"))


def test_transmit_pure_s_full_power():
    op = get_op("pbs", "glan_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_transmit_pure_p_blocked():
    op = get_op("pbs", "glan_transmit_p")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_transmit())
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_reject_pure_p_full_power_out_side():
    """s-pol (labeled +p in our Jones basis) undergoes TIR at B1 (gap) +
    Snell at A3 (side exit). Physically-correct Glan-Laser TIR sends
    reject beam BACKWARD in z (negative z component) -- opposite of the
    old hard-coded forward direction.
    """
    op = get_op("pbs", "glan_reject_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    [out] = op(ray, ctx_reject())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)
    # B1 mirror: (0,0,1) - 2*(-0.7826)*(0.6225,0,-0.7826) = (0.9745,0,-0.2253) in crystal
    # A3 Snell n_o=1.66 -> 1: result ~ (0.928, 0, -0.374) in air.
    assert out.direction.x == pytest.approx(0.928, abs=2e-3)
    assert out.direction.y == pytest.approx(0.0, abs=1e-12)
    assert out.direction.z == pytest.approx(-0.374, abs=2e-3)


def test_reject_pure_s_blocked():
    op = get_op("pbs", "glan_reject_s")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    [out] = op(ray, ctx_reject())
    assert out.power_mw == pytest.approx(0, abs=1e-12)


def test_power_conservation_transmit_plus_reject():
    """At any input polarization, p-transmit + s-reject = full power."""
    t_op = get_op("pbs", "glan_transmit_p")
    r_op = get_op("pbs", "glan_reject_s")
    a = math.sqrt(0.5)
    ray = ray_with_jones((complex(a, 0), complex(a, 0)))  # 45 deg linear
    p_t = t_op(ray, ctx_transmit())[0].power_mw
    p_r = r_op(ray, ctx_reject())[0].power_mw
    assert p_t + p_r == pytest.approx(1, abs=1e-12)
    assert p_t == pytest.approx(0.5, abs=1e-12)
    assert p_r == pytest.approx(0.5, abs=1e-12)


def test_transmit_5x5_matrix_overrides_l_n():
    """If transition supplies matrix5x5, B_x/B_y come from it (not L/n_e)."""
    op = get_op("pbs", "glan_transmit_p")
    ray = ray_with_jones((complex(1, 0), complex(0, 0)))
    M5 = (
        (1, 5.12, 0, 0, 0),
        (0, 1,    0, 0, 0),
        (0, 0,    1, 5.07, 0),
        (0, 0,    0, 1, 0),
        (0, 0,    0, 0, 1),
    )
    ctx = PhysicsOpContext(
        face_in=FACE_A1, face_out=FACE_A2,
        params={"lengthMm": 7.5, "refractiveIndex_e": 1.48},
        face_via=(FACE_B1, FACE_B2),
        transfer_matrix=("matrix5x5", M5),
    )
    qx_in = ray.qx
    [out] = op(ray, ctx)
    assert out.qx.real == pytest.approx(qx_in.real + 5.12, abs=1e-9)
    assert out.qy.real == pytest.approx(qx_in.real + 5.07, abs=1e-9)


def test_reject_requires_via_face():
    """glan_reject_s without via=[B1] should fail clearly."""
    op = get_op("pbs", "glan_reject_s")
    ray = ray_with_jones((complex(0, 0), complex(1, 0)))
    bad_ctx = PhysicsOpContext(
        face_in=FACE_A1, face_out=FACE_A3,
        params={"refractiveIndex_o": 1.66},
        face_via=(),  # missing!
    )
    with pytest.raises(ValueError, match="via"):
        op(ray, bad_ctx)
