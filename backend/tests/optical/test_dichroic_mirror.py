"""Pytest for dichroic mirror ops (mirrors frontend dichroic-mirror/physics.test.ts)."""

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.dichroic_mirror.physics import transmittance
from app.optical.registry import Face, PhysicsOpContext, get_op


import math

SQRT_HALF = math.sqrt(0.5)

FACE_A = Face(id="A",
              position_mm_body_local=Vec3(0, 0, -12.5),
              normal_body_local=Vec3(0, 0, -1),
              aperture_mm=12.7, aperture_shape="circle")
FACE_T = Face(id="Bt",
              position_mm_body_local=Vec3(0, 0, 12.5),
              normal_body_local=Vec3(0, 0, 1),
              aperture_mm=12.7, aperture_shape="circle")
FACE_R = Face(id="Br",
              position_mm_body_local=Vec3(12.5, 0, 0),
              normal_body_local=Vec3(1, 0, 0),
              aperture_mm=12.7, aperture_shape="circle")
# Internal 45 deg coating, normal toward back-up corner -> reflects +z beam to +x.
FACE_B1 = Face(id="B1",
               position_mm_body_local=Vec3(0, 0, 0),
               normal_body_local=Vec3(-SQRT_HALF, 0, SQRT_HALF),
               aperture_mm=17.68, aperture_shape="rectangle")


def make_ray(wavelength_nm: float) -> BeamRay:
    return make_beam_ray(
        origin=Vec3(0, 0, -5),
        direction=Vec3(0, 0, 1),
        wavelength_nm=wavelength_nm,
        power_mw=1.0,
    )


def ctx_transmit(**overrides) -> PhysicsOpContext:
    params = {
        "cutoffWavelengthNm": 700,
        "isShortPass": True,
        "substrateThicknessMm": 6,
        "refractiveIndex": 1.4585,
    }
    params.update(overrides)
    return PhysicsOpContext(
        face_in=FACE_A, face_out=FACE_T, params=params,
        face_via=(FACE_B1,),
    )


def ctx_reflect(**overrides) -> PhysicsOpContext:
    params = {
        "cutoffWavelengthNm": 700,
        "isShortPass": True,
        "substrateThicknessMm": 6,
        "refractiveIndex": 1.4585,
    }
    params.update(overrides)
    return PhysicsOpContext(
        face_in=FACE_A, face_out=FACE_R, params=params,
        face_via=(FACE_B1,),
    )


# ---------------------------------------------------------------------------
# transmittance helper
# ---------------------------------------------------------------------------

def test_transmittance_shortpass_hard():
    assert transmittance(650, 700, True) == 1.0
    assert transmittance(750, 700, True) == 0.0


def test_transmittance_longpass_hard():
    assert transmittance(650, 700, False) == 0.0
    assert transmittance(750, 700, False) == 1.0


def test_transmittance_smooth_midpoint():
    assert transmittance(700, 700, True, 20) == pytest.approx(0.5, abs=1e-9)


def test_transmittance_smooth_far_below():
    assert transmittance(500, 700, True, 20) == pytest.approx(1, abs=1e-9)


# ---------------------------------------------------------------------------
# dichroic_transmit
# ---------------------------------------------------------------------------

def test_transmit_registered():
    op = get_op("dichroic_mirror", "dichroic_transmit")
    assert callable(op)


def test_transmit_band_full_power():
    op = get_op("dichroic_mirror", "dichroic_transmit")
    [out] = op(make_ray(650), ctx_transmit())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_transmit_reflect_band_blocked():
    op = get_op("dichroic_mirror", "dichroic_transmit")
    [out] = op(make_ray(800), ctx_transmit())
    assert out.power_mw == pytest.approx(0.0, abs=1e-12)


def test_transmit_direction_unchanged():
    op = get_op("dichroic_mirror", "dichroic_transmit")
    r = make_ray(650)
    [out] = op(r, ctx_transmit())
    assert out.direction == r.direction


def test_transmit_exits_at_face_out():
    op = get_op("dichroic_mirror", "dichroic_transmit")
    [out] = op(make_ray(650), ctx_transmit())
    assert out.origin.z == pytest.approx(12.5, abs=1e-12)


# ---------------------------------------------------------------------------
# dichroic_reflect
# ---------------------------------------------------------------------------

def test_reflect_registered():
    op = get_op("dichroic_mirror", "dichroic_reflect")
    assert callable(op)


def test_reflect_band_full_power():
    op = get_op("dichroic_mirror", "dichroic_reflect")
    [out] = op(make_ray(800), ctx_reflect())
    assert out.power_mw == pytest.approx(1.0, abs=1e-12)


def test_reflect_transmit_band_blocked():
    op = get_op("dichroic_mirror", "dichroic_reflect")
    [out] = op(make_ray(650), ctx_reflect())
    assert out.power_mw == pytest.approx(0.0, abs=1e-12)


def test_reflect_direction_90_deg_via_b1():
    """Beam (0,0,1) reflects off B1 (normal (-0.7071,0,0.7071)) to (1,0,0)
    — physically-correct 90 deg dichroic deflection toward Br at +x."""
    op = get_op("dichroic_mirror", "dichroic_reflect")
    [out] = op(make_ray(800), ctx_reflect())
    assert out.direction.x == pytest.approx(1, abs=1e-12)
    assert out.direction.y == pytest.approx(0, abs=1e-12)
    assert out.direction.z == pytest.approx(0, abs=1e-12)


def test_reflect_requires_via_face():
    op = get_op("dichroic_mirror", "dichroic_reflect")
    r = make_ray(800)
    ctx = PhysicsOpContext(
        face_in=FACE_A, face_out=FACE_R,
        params={"cutoffWavelengthNm": 700, "isShortPass": True},
        face_via=(),  # missing!
    )
    with pytest.raises(ValueError, match="via"):
        op(r, ctx)


# ---------------------------------------------------------------------------
# Power conservation: T + R = 1
# ---------------------------------------------------------------------------

def test_t_plus_r_at_650():
    t_op = get_op("dichroic_mirror", "dichroic_transmit")
    r_op = get_op("dichroic_mirror", "dichroic_reflect")
    r = make_ray(650)
    p_t = t_op(r, ctx_transmit())[0].power_mw
    p_r = r_op(r, ctx_reflect())[0].power_mw
    assert p_t + p_r == pytest.approx(1, abs=1e-12)


def test_t_plus_r_at_800():
    t_op = get_op("dichroic_mirror", "dichroic_transmit")
    r_op = get_op("dichroic_mirror", "dichroic_reflect")
    r = make_ray(800)
    p_t = t_op(r, ctx_transmit())[0].power_mw
    p_r = r_op(r, ctx_reflect())[0].power_mw
    assert p_t + p_r == pytest.approx(1, abs=1e-12)


def test_t_plus_r_at_cutoff_smooth():
    t_op = get_op("dichroic_mirror", "dichroic_transmit")
    r_op = get_op("dichroic_mirror", "dichroic_reflect")
    r = make_ray(700)
    p_t = t_op(r, ctx_transmit(transitionWidthNm=20))[0].power_mw
    p_r = r_op(r, ctx_reflect(transitionWidthNm=20))[0].power_mw
    assert p_t + p_r == pytest.approx(1, abs=1e-9)
    assert p_t == pytest.approx(0.5, abs=1e-9)
    assert p_r == pytest.approx(0.5, abs=1e-9)
