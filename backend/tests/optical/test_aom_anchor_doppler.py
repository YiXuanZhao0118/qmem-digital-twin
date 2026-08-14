"""Production (anchor-op) AOM path: Doppler + multi-order sideband model.

The optical-link / beam-scope trace runs through ``anchor_ops/aom.py`` (anchor
tracer), NOT the v3 kind PhysicsOp. The op spawns the same sideband orders the
Object Panel table shows (shared model in ``aom_sideband.py``): 0 + the selected
order always, plus any order above the visibility threshold; each spawned order
m carries freq_offset_hz = m * f_RF (Doppler) and deflects 2*m*theta_B along the
acoustic direction.
"""

import math

import pytest

from app.optical import anchor_ops  # noqa: F401  (registers anchor ops)
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
    axis_x_body=Vec3(1, 0, 0),   # beam / optical axis
    axis_y_body=Vec3(0, 1, 0),
    axis_z_body=Vec3(0, 0, 1),
    aperture_mm=1.0,
)


def _ctx(freq_mhz=80.0, cos_incidence=1.0, anchor=ANCHOR, extra=None,
         anchors=None) -> AnchorOpContext:
    hit = AnchorHit(
        slot=None, anchor=anchor, t_lab=1.0,
        hit_point_body=Vec3(0, 0, 0),
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=cos_incidence,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="aa_mt80_a1_5_ir", kind="aom",
        anchors=anchors if anchors is not None else [anchor],
    )
    params = {
        "centerFreqMhz": freq_mhz,
        "baseEfficiency": 0.85,
        "crystalLengthMm": 1.6,
        "refractiveIndex": 2.26,
        "acousticVelocityMps": 4200.0,
        # diffractionOrder (selected) / maxDiffractionOrder / threshold default.
    }
    if extra:
        params.update(extra)
    return AnchorOpContext(asset=asset, anchor=anchor, hit=hit, params=params, dynamic={})


def _ray(direction=Vec3(1, 0, 0), origin=Vec3(-1, 0, 0)):
    return make_beam_ray(origin=origin, direction=direction,
                         wavelength_nm=780, power_mw=1.0)


def _by_order(outs, freq_mhz=80.0):
    """Index spawned rays by diffraction order (from their Doppler shift)."""
    return {round(r.freq_offset_hz / (freq_mhz * 1e6)): r for r in outs}


# ---------------------------------------------------------------------------
# Order set: 0 + selected + visible sidebands; -1 hidden below threshold.
# ---------------------------------------------------------------------------

def test_spawns_visible_orders_with_per_order_doppler():
    op = get_anchor_op("aom")
    by = _by_order(op(_ray(), _ctx()))
    # selected +1, the 0 order, and ±2 / ±3 (above the 1% threshold) are drawn.
    assert set(by) == {-3, -2, 0, 1, 2, 3}
    for m, ray in by.items():
        assert ray.freq_offset_hz == pytest.approx(m * 80e6, abs=1.0)


def test_minus1_hidden_below_visibility_threshold():
    op = get_anchor_op("aom")
    by = _by_order(op(_ray(), _ctx()))
    assert -1 not in by  # wrong-sign order ~0.09% < 1% threshold


def test_no_rf_drive_passthrough_single_zero_order():
    # "Off" is the requiresRfDrive gate with no RF power (not a 0 Hz freq): the
    # cell stops diffracting and the beam passes straight through as the 0 order.
    op = get_anchor_op("aom")
    outs = op(_ray(), _ctx(extra={"requiresRfDrive": True}))
    assert len(outs) == 1
    assert outs[0].freq_offset_hz == 0.0


def test_doppler_accumulates_onto_existing_offset():
    op = get_anchor_op("aom")
    outs = op(_ray().replaced(freq_offset_hz=80e6), _ctx())
    offsets = {round(r.freq_offset_hz / 1e6) for r in outs}
    assert 160 in offsets  # +1 order: 80 (incoming) + 80 (m=1)
    assert 80 in offsets   # 0 order: 80 (incoming) + 0


def test_dynamic_freq_overrides_center_freq():
    op = get_anchor_op("aom")
    base = _ctx()
    ctx = AnchorOpContext(
        asset=base.asset, anchor=base.anchor, hit=base.hit,
        params=base.params, dynamic={"aomFreqMhz": 110},
    )
    by = _by_order(op(_ray(), ctx), freq_mhz=110.0)
    assert by[1].freq_offset_hz == pytest.approx(110e6, abs=1.0)


# ---------------------------------------------------------------------------
# Per-order intensities match the shared sideband model (panel golden values).
# ---------------------------------------------------------------------------

def test_sideband_powers_match_panel_model():
    op = get_anchor_op("aom")
    by = _by_order(op(_ray(), _ctx()))  # 1 mW in, eta 0.85, on-axis
    assert by[1].power_mw == pytest.approx(0.792, abs=0.01)   # selected +1
    assert by[2].power_mw == pytest.approx(0.093, abs=0.006)
    assert by[-2].power_mw == pytest.approx(0.093, abs=0.006)
    assert by[3].power_mw == pytest.approx(0.010, abs=0.004)
    assert by[0].power_mw == pytest.approx(0.0, abs=0.006)    # 0 order ~ leftover
    assert by[1].power_mw > by[2].power_mw > by[3].power_mw   # selected dominates


def test_zero_order_strengthens_off_bragg():
    op = get_anchor_op("aom")
    on = _by_order(op(_ray(), _ctx(cos_incidence=1.0)))
    off = _by_order(op(_ray(), _ctx(cos_incidence=math.cos(0.02))))
    # Off-Bragg: +1 weakens, 0 strengthens (detune moves power to passthrough).
    assert off[1].power_mw < on[1].power_mw
    assert off[0].power_mw > on[0].power_mw


# ---------------------------------------------------------------------------
# Deflection direction: diffracted orders fan along the acoustic direction.
# MT80-like: optical +z, axisY=+y (derived up), acoustic=+x.
# ---------------------------------------------------------------------------

MT80_ANCHOR = V3Anchor(
    id="interaction_center",
    position_body=Vec3(0, 0, 0),
    axis_x_body=Vec3(0, 0, 1),    # optical axis +z
    axis_y_body=Vec3(0, 1, 0),    # derived "up" — NOT acoustic
    axis_z_body=Vec3(-1, 0, 0),
    aperture_mm=1.0,
)


def _ray_along_z():
    return _ray(direction=Vec3(0, 0, 1), origin=Vec3(0, 0, -1))


def test_orders_fan_along_acoustic_not_axisY():
    op = get_anchor_op("aom")
    outs = op(_ray_along_z(), _ctx(
        anchor=MT80_ANCHOR, extra={"rfPropagationDirectionBodyLocal": [1, 0, 0]},
    ))
    diffracted = [o for o in outs if abs(o.freq_offset_hz) > 1.0]  # exclude 0 order
    assert diffracted
    for o in diffracted:
        assert abs(o.direction.x) > 1e-4   # along acoustic +x
        assert abs(o.direction.y) < 1e-9   # NOT axisY (+y)


# ---------------------------------------------------------------------------
# Order-aware Bragg matching: order m peaks at signed incidence -m*theta_B
# about the acoustic axis, so +1 and -1 are matched at opposite tilts and the
# cell has to be rotated to the correct side ("optimise the angle for +1/-1").
# ---------------------------------------------------------------------------

THETA_B_780_80 = math.asin(780e-9 * 80e6 / (2 * 4200.0))   # 7.43 mrad


def _tilted_mt80_ray(theta_rad: float, reverse: bool = False):
    """Ray through the MT80 frame (optical +z, acoustic +x) at signed
    incidence `theta_rad` about the acoustic axis."""
    zsign = -1.0 if reverse else 1.0
    return _ray(
        direction=Vec3(math.sin(theta_rad), 0, zsign * math.cos(theta_rad)),
        origin=Vec3(0, 0, -zsign),
    )


def _mt80_ctx(**extra):
    return _ctx(
        anchor=MT80_ANCHOR,
        extra={"rfPropagationDirectionBodyLocal": [1, 0, 0], **extra},
    )


def _order_power(order: int, theta_rad: float, reverse: bool = False) -> float:
    op = get_anchor_op("aom")
    outs = op(
        _tilted_mt80_ray(theta_rad, reverse),
        _mt80_ctx(diffractionOrder=order),
    )
    return _by_order(outs)[order].power_mw


def test_selected_order_peaks_at_its_matched_tilt():
    # +1 wants incidence -theta_B, -1 wants +theta_B; on-axis is off-Bragg for
    # both (this is what makes "rotate the AOM for max diffraction" real).
    assert _order_power(1, -THETA_B_780_80) > _order_power(1, 0.0)
    assert _order_power(1, -THETA_B_780_80) > _order_power(1, +THETA_B_780_80)
    assert _order_power(-1, +THETA_B_780_80) > _order_power(-1, 0.0)
    assert _order_power(-1, +THETA_B_780_80) > _order_power(-1, -THETA_B_780_80)


def test_matched_tilts_are_mirror_images():
    assert _order_power(1, -THETA_B_780_80) == pytest.approx(
        _order_power(-1, +THETA_B_780_80), rel=1e-9,
    )


def test_wrong_side_tilt_moves_power_to_zero_order():
    op = get_anchor_op("aom")
    right = _by_order(op(_tilted_mt80_ray(-THETA_B_780_80), _mt80_ctx()))
    wrong = _by_order(op(_tilted_mt80_ray(+THETA_B_780_80), _mt80_ctx()))
    assert wrong[1].power_mw < right[1].power_mw
    assert wrong[0].power_mw > right[0].power_mw


def test_matched_tilt_is_traversal_independent():
    # The Bragg condition constrains only k_hat . a_hat, so entering from the
    # far face at the same signed incidence is matched just the same.
    assert _order_power(1, -THETA_B_780_80, reverse=True) == pytest.approx(
        _order_power(1, -THETA_B_780_80), rel=1e-9,
    )


def test_no_acoustic_axis_falls_back_to_legacy_on_axis_match():
    # Assets with neither an acoustic_axis anchor nor the legacy param keep the
    # old unsigned "matched on the optical axis" behaviour.
    op = get_anchor_op("aom")
    by = _by_order(op(_ray(), _ctx()))
    assert by[1].power_mw == pytest.approx(0.792, abs=0.01)


def test_acoustic_axis_anchor_overrides_param():
    op = get_anchor_op("aom")
    acoustic = V3Anchor(
        id="acoustic_axis", position_body=Vec3(0, 0, 0),
        axis_x_body=Vec3(0, 1, 0),    # acoustic = +y (NOT the param's +x)
        axis_y_body=Vec3(0, 0, 1), axis_z_body=Vec3(1, 0, 0), aperture_mm=0.0,
    )
    ctx = _ctx(
        anchor=MT80_ANCHOR,
        anchors=[MT80_ANCHOR, acoustic],
        extra={"rfPropagationDirectionBodyLocal": [1, 0, 0]},  # anchor must win
    )
    outs = op(_ray_along_z(), ctx)
    diffracted = [o for o in outs if abs(o.freq_offset_hz) > 1.0]
    assert diffracted
    for o in diffracted:
        assert abs(o.direction.y) > 1e-4   # along acoustic_axis +y
        assert abs(o.direction.x) < 1e-9   # NOT the param's +x
