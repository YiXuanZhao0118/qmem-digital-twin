"""Doppler shift on the production (anchor-op) AOM path.

The optical-link / beam-scope trace runs through ``anchor_ops/aom.py``
(anchor tracer), NOT the v3 kind PhysicsOp. This pins that each spawned
diffraction order m carries freq_offset_hz = m * f_RF so the +1 / -1
sidebands show distinct frequencies.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
from app.optical.aom_physics import bragg_detuning_sinc2
from app.optical.anchor_tracer import (
    AnchorHit,
    AnchorOpContext,
    V3Anchor,
    V3AssetAnchorSnapshot,
    get_anchor_op,
)
from app.optical.beam_ray import Vec3, make_beam_ray

ANCHOR = V3Anchor(
    id="interaction_center",
    position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(1, 0, 0),   # beam axis
    axis_y_body=Vec3(0, 1, 0),   # acoustic direction
    axis_z_body=Vec3(0, 0, 1),
    aperture_mm=1.0,
)


def _ctx(orders, freq_mhz=80.0, cos_incidence=1.0) -> AnchorOpContext:
    hit = AnchorHit(
        slot=None, anchor=ANCHOR, t_lab=1.0,
        hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=cos_incidence,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="aa_mt80_a1_5_ir", kind="aom", anchors=[ANCHOR],
    )
    params = {
        "centerFreqMhz": freq_mhz,
        "baseEfficiency": 0.85,
        "crystalLengthMm": 1.6,
        "refractiveIndex": 2.26,
        "acousticVelocityMps": 4200.0,
        "diffractionOrders": orders,
    }
    return AnchorOpContext(asset=asset, anchor=ANCHOR, hit=hit, params=params, dynamic={})


def _ray():
    return make_beam_ray(
        origin=Vec3(-1, 0, 0), direction=Vec3(1, 0, 0),
        wavelength_nm=780, power_mw=1.0,
    )


def test_plus1_minus1_orders_get_distinct_doppler_shifts():
    op = get_anchor_op("aom")
    outs = op(_ray(), _ctx([1, -1]))
    offsets = sorted(r.freq_offset_hz for r in outs)
    assert offsets == [-80e6, 80e6]


def test_doppler_accumulates_onto_existing_offset():
    op = get_anchor_op("aom")
    r = _ray().replaced(freq_offset_hz=80e6)
    [out] = op(r, _ctx([1]))
    assert out.freq_offset_hz == 160e6


def test_dynamic_freq_overrides_center_freq():
    op = get_anchor_op("aom")
    ctx = _ctx([1])
    ctx = AnchorOpContext(
        asset=ctx.asset, anchor=ctx.anchor, hit=ctx.hit,
        params=ctx.params, dynamic={"aomFreqMhz": 110},
    )
    [out] = op(_ray(), ctx)
    assert out.freq_offset_hz == 110e6


def test_no_rf_drive_passthrough_has_no_shift():
    op = get_anchor_op("aom")
    outs = op(_ray(), _ctx([1, -1], freq_mhz=0.0))
    assert all(r.freq_offset_hz == 0.0 for r in outs)


# ---------------------------------------------------------------------------
# Deflection DIRECTION: orders fan along the acoustic direction
# (rfPropagationDirectionBodyLocal), not along the anchor's axisY.
# MT80-like frame: optical axis +z, axisY = +y (derived up), acoustic = +x.
# ---------------------------------------------------------------------------

MT80_ANCHOR = V3Anchor(
    id="interaction_center",
    position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(0, 0, 1),    # optical axis +z
    axis_y_body=Vec3(0, 1, 0),    # derived "up" — NOT acoustic
    axis_z_body=Vec3(-1, 0, 0),   # = axisX × axisY
    aperture_mm=1.0,
)


def _ctx_mt80(orders) -> AnchorOpContext:
    hit = AnchorHit(
        slot=None, anchor=MT80_ANCHOR, t_lab=1.0,
        hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="aa_mt80_a1_5_ir", kind="aom", anchors=[MT80_ANCHOR],
    )
    params = {
        "centerFreqMhz": 80.0, "baseEfficiency": 0.85,
        "crystalLengthMm": 1.6, "refractiveIndex": 2.26,
        "acousticVelocityMps": 4200.0, "diffractionOrders": orders,
        "rfPropagationDirectionBodyLocal": [1, 0, 0],   # acoustic = +x
    }
    return AnchorOpContext(asset=asset, anchor=MT80_ANCHOR, hit=hit, params=params, dynamic={})


def _ray_along_z():
    return make_beam_ray(
        origin=Vec3(0, 0, -1), direction=Vec3(0, 0, 1),
        wavelength_nm=780, power_mw=1.0,
    )


def test_orders_fan_along_acoustic_not_axisY():
    op = get_anchor_op("aom")
    outs = op(_ray_along_z(), _ctx_mt80([1, -1]))
    for o in outs:
        # Deflection is in the acoustic (x) direction, NOT axisY (y).
        assert abs(o.direction.x) > 1e-4
        assert abs(o.direction.y) < 1e-9
    # +1 → +x (toward acoustic propagation), -1 → -x.
    xs = sorted(o.direction.x for o in outs)
    assert xs[0] < 0 < xs[1]


# ---------------------------------------------------------------------------
# Per-order efficiency: on-axis = baseEfficiency; off-axis drops via sinc^2
# Bragg detuning (so rotating the AOM changes the split).
# ---------------------------------------------------------------------------

def test_on_axis_plus1_power_is_base_efficiency():
    op = get_anchor_op("aom")
    [out] = op(_ray(), _ctx([1]))  # cos_incidence = 1.0 → detune 1
    assert out.power_mw == pytest.approx(0.85, abs=1e-9)


def test_minus1_order_is_suppressed():
    op = get_anchor_op("aom")
    [out] = op(_ray(), _ctx([-1]))
    assert out.power_mw == pytest.approx(0.85 * 0.01, abs=1e-9)


def test_zero_order_is_undiffracted_leftover():
    op = get_anchor_op("aom")
    [out] = op(_ray(), _ctx([0]))
    assert out.power_mw == pytest.approx(1.0 - 0.85, abs=1e-9)


def test_efficiency_drops_when_incidence_off_axis():
    op = get_anchor_op("aom")
    dtheta = 0.02  # 20 mrad off the optical axis
    cos_i = math.cos(dtheta)
    [out] = op(_ray(), _ctx([1], cos_incidence=cos_i))
    detune = bragg_detuning_sinc2(dtheta, 780, 80, 4200, 2.26, 1.6)
    assert out.power_mw == pytest.approx(0.85 * detune, abs=1e-9)
    assert out.power_mw < 0.85  # off-axis → less efficient than on-axis


def test_acoustic_axis_anchor_overrides_param():
    """When a dedicated acoustic_axis anchor exists it is the source of truth
    for the fan direction, overriding rfPropagationDirectionBodyLocal."""
    op = get_anchor_op("aom")
    ic = MT80_ANCHOR  # interaction_center: optical axis = +z
    acoustic = V3Anchor(
        id="acoustic_axis", position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 1, 0),    # acoustic = +y (NOT the param's +x)
        axis_y_body=Vec3(0, 0, 1), axis_z_body=Vec3(1, 0, 0), aperture_mm=0.0,
    )
    hit = AnchorHit(
        slot=None, anchor=ic, t_lab=1.0, hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="aa_mt80_a1_5_ir", kind="aom", anchors=[ic, acoustic],
    )
    params = {
        "centerFreqMhz": 80.0, "baseEfficiency": 0.85, "crystalLengthMm": 1.6,
        "refractiveIndex": 2.26, "acousticVelocityMps": 4200.0,
        "diffractionOrders": [1, -1],
        "rfPropagationDirectionBodyLocal": [1, 0, 0],  # param says +x; anchor wins
    }
    ctx = AnchorOpContext(asset=asset, anchor=ic, hit=hit, params=params, dynamic={})
    outs = op(_ray_along_z(), ctx)
    for o in outs:
        assert abs(o.direction.y) > 1e-4   # deflects along +y (acoustic_axis)
        assert abs(o.direction.x) < 1e-9   # NOT +x (the param)
