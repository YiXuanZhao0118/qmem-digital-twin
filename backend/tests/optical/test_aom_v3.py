"""Pytest for v3 AOM op (mirrors frontend aom-v3/physics.test.ts)."""

import math

import pytest

from app.optical import kinds  # noqa: F401
from app.optical.beam_ray import BeamRay, Vec3, make_beam_ray
from app.optical.kinds.aom.physics import (
    bragg_acceptance_mrad,
    bragg_angle_rad,
    bragg_detuning_factor,
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


# Bragg-matched inputs. Order m peaks at signed incidence -m*theta_B about the
# acoustic axis (+x in this fixture), so a matched ray is tilted, NOT on-axis.
THETA_B = bragg_angle_rad(780, 80, 4200)


def matched_ray(order: int) -> BeamRay:
    """Forward ray (toward +z) at the Bragg-matched tilt for `order`."""
    a = -order * THETA_B
    return make_beam_ray(
        origin=Vec3(0, 0, -L / 2),
        direction=Vec3(math.sin(a), 0, math.cos(a)),
        wavelength_nm=780,
        power_mw=1.0,
    )


def matched_reverse_ray(order: int) -> BeamRay:
    """Reverse ray (toward -z) at the Bragg-matched tilt for `order`. The Bragg
    condition constrains only k_hat . a_hat, so the matched tilt is the same
    -m*theta_B regardless of which face the beam enters."""
    a = -order * THETA_B
    return make_beam_ray(
        origin=Vec3(0, 0, L / 2),
        direction=Vec3(math.sin(a), 0, -math.cos(a)),
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
    # baseEfficiency=None means "override off" — drop it so the closed form runs.
    if params.get("baseEfficiency") is None:
        params.pop("baseEfficiency", None)
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
    # Matched input at -theta_B -> the +1 order leaves at +theta_B (the
    # symmetric Bragg geometry), i.e. 2*theta_B away from the 0 order.
    [out] = op(matched_ray(1), ctx_for(1))
    assert out.direction.x == pytest.approx(math.sin(THETA_B), abs=1e-9)
    assert out.direction.z == pytest.approx(math.cos(THETA_B), abs=1e-9)
    assert out.power_mw == pytest.approx(0.85, abs=1e-12)


def test_a2_to_b2_minus1_order_exits_opposite_optical_side():
    op = get_op("aom", "diffract_aom")
    [out] = op(matched_reverse_ray(-1), ctx_for(-1))
    assert out.direction.x == pytest.approx(-math.sin(THETA_B), abs=1e-9)
    assert out.direction.z == pytest.approx(-math.cos(THETA_B), abs=1e-9)
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


def _ctx_with_dynamic(order, dynamic, **overrides):
    base = ctx_for(order, **overrides)
    return PhysicsOpContext(
        face_in=base.face_in, face_out=base.face_out,
        params=base.params, dynamic=dynamic,
    )


def test_efficiency_scales_with_rf_drive_power():
    op = get_op("aom", "diffract_aom")
    # No RF source -> rated operating point -> peak (baseEfficiency) on +1.
    [rated] = op(matched_ray(1), ctx_for(1))
    assert rated.power_mw == pytest.approx(0.85, abs=1e-9)
    # A small RF drive power sits well below the rated peak.
    [low] = op(matched_ray(1), _ctx_with_dynamic(1, {"rfDrivePowerW": 0.05}))
    assert 0.0 < low.power_mw < 0.85
    # RF explicitly OFF (power 0) -> no diffraction.
    [off] = op(matched_ray(1), _ctx_with_dynamic(1, {"rfDrivePowerW": 0.0}))
    assert off.power_mw == pytest.approx(0.0, abs=1e-12)


def test_efficiency_drops_off_centre_frequency():
    op = get_op("aom", "diffract_aom")
    [centre] = op(matched_ray(1), ctx_for(1))  # 80 MHz (design centre)
    # Drive +15 MHz off centre -> RF bandwidth factor G ~= 0.75 -> lower eta.
    [off] = op(matched_ray(1), _ctx_with_dynamic(1, {"aomFreqMhz": 95}))
    assert off.power_mw < centre.power_mw
    assert off.power_mw == pytest.approx(0.85 * 0.75, abs=0.02)


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


# ---------------------------------------------------------------------------
# Doppler frequency shift (tracked as freq_offset_hz; wavelength_nm untouched)
# ---------------------------------------------------------------------------

def test_doppler_plus1_order():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_forward_ray(), ctx_for(1))
    assert out.freq_offset_hz == pytest.approx(80e6, abs=1.0)


def test_doppler_zero_order():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_forward_ray(), ctx_for(0))
    assert out.freq_offset_hz == pytest.approx(0.0, abs=1e-6)


def test_doppler_minus1_order():
    op = get_op("aom", "diffract_aom")
    [out] = op(make_reverse_ray(), ctx_for(-1))
    assert out.freq_offset_hz == pytest.approx(-80e6, abs=1.0)


def test_doppler_accumulates():
    op = get_op("aom", "diffract_aom")
    r = make_forward_ray().replaced(freq_offset_hz=80e6)
    [out] = op(r, ctx_for(1))
    assert out.freq_offset_hz == pytest.approx(160e6, abs=1.0)


def test_doppler_uses_dynamic_freq():
    op = get_op("aom", "diffract_aom")
    base = ctx_for(1)
    ctx = PhysicsOpContext(
        face_in=base.face_in, face_out=base.face_out, params=base.params,
        dynamic={"aomFreqMhz": 110},
    )
    [out] = op(make_forward_ray(), ctx)
    assert out.freq_offset_hz == pytest.approx(110e6, abs=1.0)


def test_wavelength_left_on_nominal_carrier():
    op = get_op("aom", "diffract_aom")
    r = make_forward_ray()
    [out] = op(r, ctx_for(1))
    assert out.wavelength_nm == r.wavelength_nm


# ---------------------------------------------------------------------------
# Bragg detuning sinc^2 (off-axis incidence reduces diffraction efficiency)
# ---------------------------------------------------------------------------

def tilted_ray(angle_rad: float) -> BeamRay:
    """Forward ray tilted by angle_rad from the optical axis, in the RF (x-z)
    plane."""
    return make_beam_ray(
        origin=Vec3(0, 0, -L / 2),
        direction=Vec3(math.sin(angle_rad), 0, math.cos(angle_rad)),
        wavelength_nm=780,
        power_mw=1.0,
    )


def test_acceptance_matches_physics():
    # External half-width to first null: n*v/(f*L) = 2.26*4200/(80e6*1.6e-3).
    assert bragg_acceptance_mrad(80, 4200, 2.26, L) == pytest.approx(74.16, abs=0.1)


def detune_for(order: int, tilt_rad: float) -> float:
    """Phase-matching factor for `order` with the beam tilted `tilt_rad` from
    the optical axis toward the acoustic axis (+x here)."""
    return bragg_detuning_factor(
        tilted_ray(tilt_rad), ctx_for(order), order, THETA_B, 80, 4200, 2.26, L,
    )


def test_detuning_unity_at_matched_tilt():
    # Order m peaks at incidence -m*theta_B, NOT on the optical axis.
    assert detune_for(1, -THETA_B) == pytest.approx(1.0, abs=1e-12)
    assert detune_for(-1, +THETA_B) == pytest.approx(1.0, abs=1e-12)


def test_detuning_below_unity_on_axis():
    # On-axis is off-Bragg by theta_B for both first orders (symmetric).
    on_axis = detune_for(1, 0.0)
    assert on_axis < 1.0
    assert on_axis == pytest.approx(detune_for(-1, 0.0), abs=1e-12)


def test_detuning_zero_at_first_null():
    null_rad = bragg_acceptance_mrad(80, 4200, 2.26, L) * 1e-3
    assert detune_for(1, -THETA_B + null_rad) == pytest.approx(0.0, abs=1e-9)


def test_detuning_half_null_is_sinc_half():
    null_rad = bragg_acceptance_mrad(80, 4200, 2.26, L) * 1e-3
    f = detune_for(1, -THETA_B + null_rad / 2)
    # ~sinc^2(pi/2); the cos(theta_B) factor shifts it by ~5e-6 from the ideal.
    assert f == pytest.approx((2 / math.pi) ** 2, abs=1e-4)


def test_detuning_reduces_first_order_power():
    op = get_op("aom", "diffract_aom")
    null_rad = bragg_acceptance_mrad(80, 4200, 2.26, L) * 1e-3
    [out] = op(tilted_ray(-THETA_B + null_rad / 2), ctx_for(1))
    # base 0.85 first-order * sinc^2(pi/2) ~ 0.85 * 0.405.
    assert out.power_mw == pytest.approx(0.85 * (2 / math.pi) ** 2, abs=1e-4)
