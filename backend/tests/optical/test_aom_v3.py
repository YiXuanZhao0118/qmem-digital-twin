"""Pytest for v3 AOM op (mirrors frontend aom-v3/physics.test.ts)."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.aom_v3.physics import (
    bragg_angle_rad,
    order_efficiency,
    order_from_context,
    parse_order_from_face_id,
)
from app.optical.registry import Face, PhysicsOpContext, get_op


L = 1.6

FACE_A1 = Face(id="A1",
               position_mm_body_local=Vec3(0, 0, -L / 2),
               normal_body_local=Vec3(0, 0, -1),
               aperture_mm=1.0, aperture_shape="circle")
FACE_B1 = Face(id="B1",
               position_mm_body_local=Vec3(0, 0, L / 2),
               normal_body_local=Vec3(0, 0, 1),
               aperture_mm=1.0, aperture_shape="circle")
FACE_A2 = Face(id="A2",
               position_mm_body_local=Vec3(0, 0, L / 2),
               normal_body_local=Vec3(0, 0, 1),
               aperture_mm=1.0, aperture_shape="circle")
FACE_B2 = Face(id="B2",
               position_mm_body_local=Vec3(0, 0, -L / 2),
               normal_body_local=Vec3(0, 0, -1),
               aperture_mm=1.0, aperture_shape="circle")
FACE_A_LEGACY = Face(id="A",
                     position_mm_body_local=Vec3(0, 0, -L / 2),
                     normal_body_local=Vec3(0, 0, -1),
                     aperture_mm=1.0, aperture_shape="circle")


def legacy_face_b(order: int) -> Face:
    sign = "+" if order > 0 else ""
    return Face(id=f"B{sign}{order}",
                position_mm_body_local=Vec3(0, 0, L / 2),
                normal_body_local=Vec3(0, 0, 1),
                aperture_mm=1.0, aperture_shape="circle")


def make_forward_ray() -> BeamRay:
    return make_beam_ray(
        origin=Vec3(0, 0, -L / 2),
        direction=Vec3(0, 0, 1),
        wavelength_nm=780,
        power_mw=1.0,
    )


def make_reverse_ray() -> BeamRay:
    return make_beam_ray(
        origin=Vec3(0, 0, L / 2),
        direction=Vec3(0, 0, -1),
        wavelength_nm=780,
        power_mw=1.0,
    )


def ctx_for_faces(
    face_in: Face,
    face_out: Face,
    dynamic: dict[str, object] | None = None,
    **overrides,
) -> PhysicsOpContext:
    params = {
        "centerFreqMhz": 80,
        "acousticVelocityMps": 4200,
        "refractiveIndex": 2.26,
        "crystalLengthMm": L,
        "baseEfficiency": 0.85,
    }
    params.update(overrides)
    return PhysicsOpContext(
        face_in=face_in,
        face_out=face_out,
        params=params,
        dynamic=dynamic,
    )


def ctx_for(order: int, **overrides) -> PhysicsOpContext:
    if order == 1:
        return ctx_for_faces(FACE_A1, FACE_B1, **overrides)
    if order == -1:
        return ctx_for_faces(FACE_A2, FACE_B2, **overrides)
    return ctx_for_faces(FACE_A1, FACE_B1, order=order, **overrides)


def legacy_ctx_for(order: int) -> PhysicsOpContext:
    return ctx_for_faces(FACE_A_LEGACY, legacy_face_b(order))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_parse_order():
    assert parse_order_from_face_id("B0") == 0
    assert parse_order_from_face_id("B+1") == 1
    assert parse_order_from_face_id("B-2") == -2


def test_parse_order_invalid():
    with pytest.raises(ValueError):
        parse_order_from_face_id("A")


def test_order_from_context():
    assert order_from_context(ctx_for_faces(FACE_A1, FACE_B1)) == 1
    assert order_from_context(ctx_for_faces(FACE_A2, FACE_B2)) == -1
    assert order_from_context(ctx_for_faces(FACE_A1, FACE_B1, order=0)) == 0
    assert order_from_context(legacy_ctx_for(1)) == 1


def test_bragg_angle():
    theta = bragg_angle_rad(780, 80, 4200, 2.26)
    assert theta == pytest.approx(7.429e-3, abs=1e-6)


def test_order_efficiency():
    assert order_efficiency(1, 0.85) == 0.85
    assert order_efficiency(0, 0.85) == pytest.approx(0.15, abs=1e-12)
    assert order_efficiency(-1, 0.85) == pytest.approx(0.0085, abs=1e-12)
    assert order_efficiency(2, 0.85) == 0.0


# ---------------------------------------------------------------------------
# Op behavior
# ---------------------------------------------------------------------------

def test_registered():
    op = get_op("aom", "diffract_aom")
    assert callable(op)


def test_zero_order_unchanged_direction():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_forward_ray(), ctx_for(0))
    assert out.direction.x == pytest.approx(0, abs=1e-12)
    assert out.direction.z == pytest.approx(1, abs=1e-12)
    assert out.power_mw == pytest.approx(0.15, abs=1e-12)


def test_a1_to_b1_plus1_order_follows_rf_side():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_forward_ray(), ctx_for(1))
    theta_b = bragg_angle_rad(780, 80, 4200, 2.26)
    assert out.direction.x == pytest.approx(math.sin(2 * theta_b), abs=1e-9)
    assert out.direction.z == pytest.approx(math.cos(2 * theta_b), abs=1e-9)
    assert out.power_mw == pytest.approx(0.85, abs=1e-12)


def test_a2_to_b2_minus1_order_exits_opposite_optical_side():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_reverse_ray(), ctx_for(-1))
    theta_b = bragg_angle_rad(780, 80, 4200, 2.26)
    assert out.direction.x == pytest.approx(-math.sin(2 * theta_b), abs=1e-9)
    assert out.direction.z == pytest.approx(-math.cos(2 * theta_b), abs=1e-9)
    assert out.power_mw == pytest.approx(0.0085, abs=1e-12)


def test_rf_direction_controls_plus1_side():
    op = get_op("aom", "diffract_aom")
    [out] = op(
        make_forward_ray(),
        ctx_for_faces(
            FACE_A1,
            FACE_B1,
            dynamic={"rfPropagationDirectionBodyLocal": [-1, 0, 0]},
        ),
    )
    theta_b = bragg_angle_rad(780, 80, 4200, 2.26)
    assert out.direction.x == pytest.approx(-math.sin(2 * theta_b), abs=1e-9)


def test_rejects_rf_vectors_not_perpendicular_to_a_b_axis():
    op = get_op("aom", "diffract_aom")
    with pytest.raises(ValueError, match="perpendicular"):
        op(
            make_forward_ray(),
            ctx_for_faces(
                FACE_A1,
                FACE_B1,
                dynamic={"rfPropagationDirectionBodyLocal": [0, 0, 1]},
            ),
        )


def test_dynamic_overrides_center_freq():
    op = get_op("aom", "diffract_aom")
    base = ctx_for(1)
    ctx = PhysicsOpContext(
        face_in=base.face_in, face_out=base.face_out, params=base.params,
        dynamic={"aomFreqMhz": 110},
    )
    [out] = op(make_forward_ray(), ctx)
    theta_b_110 = bragg_angle_rad(780, 110, 4200, 2.26)
    assert out.direction.x == pytest.approx(math.sin(2 * theta_b_110), abs=1e-9)


def test_requires_rf_drive_gates_first_order_off():
    op = get_op("aom", "diffract_aom")
    [plus] = op(make_forward_ray(), ctx_for(1, requiresRfDrive=True))
    [zero] = op(make_forward_ray(), ctx_for(0, requiresRfDrive=True))
    assert plus.power_mw == pytest.approx(0.0, abs=1e-12)
    assert zero.power_mw == pytest.approx(1.0, abs=1e-12)


def test_uses_post_chain_rf_drive_power_for_closed_form_efficiency():
    op = get_op("aom", "diffract_aom")
    base = ctx_for(
        1,
        figureOfMeritM2=1e-10,
        acousticBeamWidthMm=1.5,
        rfPowerMaxW=0.01,
    )
    ctx = PhysicsOpContext(
        face_in=base.face_in,
        face_out=base.face_out,
        params=base.params,
        dynamic={"rfDrivePowerW": 0.1},
    )
    [out] = op(make_forward_ray(), ctx)
    theta = bragg_angle_rad(780, 80, 4200, 2.26)
    lambda_m = 780e-9
    l_m = L * 1e-3
    w_m = 1.5e-3
    expected = math.sin(
        ((math.pi * l_m) / (2 * lambda_m * math.cos(theta)))
        * math.sqrt((2 * 1e-10 * 0.01) / w_m)
    ) ** 2
    assert out.power_mw == pytest.approx(expected, abs=1e-12)


def test_q_propagates_by_L_over_n():
    op = get_op("aom", "diffract_aom")
    r = make_forward_ray()
    [out] = op(r, ctx_for(0))
    b_expected = L / 2.26
    assert out.qx.real == pytest.approx(r.qx.real + b_expected, abs=1e-9)


def test_exit_at_face_out():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_forward_ray(), ctx_for(1))
    assert out.origin.z == pytest.approx(L / 2, abs=1e-12)


def test_jones_unchanged():
    op = get_op("aom", "diffract_aom")
    r = make_forward_ray()
    [out] = op(r, ctx_for(1))
    assert out.jones == r.jones
