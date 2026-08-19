"""Tapered amplifier v3 model — saturated gain + unseeded ASE (decision 6b).

See docs/tapered-amplifier-model.md.
"""

from __future__ import annotations

from types import SimpleNamespace

from app.optical.anchor_ops.emit_laser_source import emit_ta_ase_rays
from app.optical.anchor_ops.misc_ops import ta_saturated_power_mw


# --- Saturated single-pass gain --------------------------------------------

def test_small_signal_is_approximately_linear_gain():
    # P_coupled << P_sat → P_out ≈ P_coupled · G0 (G0 = 10^(20/10) = 100).
    params = {"saturationPowerMw": 50.0, "smallSignalGainDb": 20.0}
    out = ta_saturated_power_mw(0.001, params)
    assert abs(out - 0.001 * 100.0) / (0.001 * 100.0) < 0.05


def test_saturates_below_small_signal_for_large_seed():
    params = {"saturationPowerMw": 50.0, "smallSignalGainDb": 20.0}
    p_in = 10.0
    out = ta_saturated_power_mw(p_in, params)
    assert out > p_in              # still amplifies
    assert out < p_in * 100.0      # but below the small-signal gain (saturated)


def test_clamps_to_output_power_max():
    params = {
        "saturationPowerMw": 50.0, "smallSignalGainDb": 20.0,
        "outputPowerMaxMw": 100.0,
    }
    assert ta_saturated_power_mw(1000.0, params) == 100.0


def test_zero_input_gives_zero():
    assert ta_saturated_power_mw(0.0, {"saturationPowerMw": 50.0}) == 0.0


# --- Unseeded ASE emission (decision 6b) -----------------------------------

def _ta_slot(obj_id: str, anchors=None, powered_on: bool = True):
    return SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={"aseForwardMw": 5.0, "aseBackwardMw": 5.0},
            anchors=anchors or [],
        ),
        scene_object_id=obj_id,
        binding_id="binding",
        effective_transform=None,
        powered_on=powered_on,
    )


def test_ase_suppressed_for_seeded_ta():
    scene = SimpleNamespace(slots=[_ta_slot("ta-1")])
    # ta-1 received a seed → no ASE.
    assert emit_ta_ase_rays(scene, {"ta-1"}) == []


def test_ase_skips_non_ta_slots():
    mirror = SimpleNamespace(
        asset=SimpleNamespace(kind="mirror", default_params={}, anchors=[]),
        scene_object_id="m-1", binding_id="b", effective_transform=None,
    )
    scene = SimpleNamespace(slots=[mirror])
    assert emit_ta_ase_rays(scene, set()) == []


def test_ase_noop_when_ta_has_no_intercept_in_anchor():
    # Unseeded TA but missing the intercept_in anchor → nothing to emit from.
    scene = SimpleNamespace(slots=[_ta_slot("ta-2", anchors=[])])
    assert emit_ta_ase_rays(scene, set()) == []


def _ta_emit_anchor():
    from app.optical.beam_ray import Vec3
    return SimpleNamespace(
        id="intercept_in",
        position_body=Vec3(0.0, 0.0, 0.0),
        axis_x_body=Vec3(0.0, 0.0, 1.0),
        axis_y_body=Vec3(0.0, 1.0, 0.0),
    )


def _identity_transform():
    from app.optical.pose import V3Pose, pose_to_transform
    return pose_to_transform(V3Pose(
        x_mm=0.0, y_mm=0.0, z_mm=0.0, rx_deg=0.0, ry_deg=0.0, rz_deg=0.0,
    ))


def test_ase_emits_both_facets_from_nested_ase_powermw():
    # Catalog shape: nested ``ase.powerMw`` and NO flat aseForwardMw/Backward.
    # Regression for the key-contract drift where a catalog TA emitted 0 ASE.
    slot = SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={
                "ase": {"powerMw": 5.0, "bandwidthNm": 1.0, "centerOffsetNm": 0.0},
                "centerWavelengthNm": 780.0,
            },
            anchors=[_ta_emit_anchor()],
        ),
        scene_object_id="ta-nested",
        binding_id="b",
        effective_transform=_identity_transform(),
        powered_on=True,
    )
    rays = emit_ta_ase_rays(SimpleNamespace(slots=[slot]), set())
    assert len(rays) == 2                                   # forward + backward
    assert sorted(r[0].power_mw for r in rays) == [5.0, 5.0]
    assert {round(r[0].direction.z) for r in rays} == {1, -1}  # ±axisX


def test_flat_ase_keys_override_nested():
    # Explicit flat keys win over the nested default (per-direction asymmetry).
    slot = SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={
                "ase": {"powerMw": 5.0},
                "aseForwardMw": 8.0,        # overrides nested for the +axisX facet
                "aseBackwardMw": 0.0,       # suppresses the −axisX facet
                "centerWavelengthNm": 780.0,
            },
            anchors=[_ta_emit_anchor()],
        ),
        scene_object_id="ta-flat",
        binding_id="b",
        effective_transform=_identity_transform(),
        powered_on=True,
    )
    rays = emit_ta_ase_rays(SimpleNamespace(slots=[slot]), set())
    assert len(rays) == 1                                   # backward suppressed
    assert rays[0][0].power_mw == 8.0
    assert round(rays[0][0].direction.z) == 1               # forward (+axisX) only


# --- Instrument power gating -----------------------------------------------

def test_ase_suppressed_when_ta_powered_off():
    # Unseeded TA but device power is OFF → no ASE (anchor present so the only
    # thing stopping emission is the power gate).
    anchor = SimpleNamespace(id="intercept_in")
    scene = SimpleNamespace(slots=[_ta_slot("ta-3", anchors=[anchor], powered_on=False)])
    assert emit_ta_ase_rays(scene, set()) == []


def test_powered_off_laser_emits_nothing():
    from app.optical.anchor_ops.emit_laser_source import emit_anchor_source_rays
    laser = SimpleNamespace(
        asset=SimpleNamespace(kind="laser_source", default_params={}, anchors=[]),
        scene_object_id="laser-1", binding_id="src",
        effective_transform=None, powered_on=False,
    )
    scene = SimpleNamespace(slots=[laser])
    assert emit_anchor_source_rays(scene) == []


# --- Output geometry: the amplified beam leaves from intercept_out ----------

def _op_ctx(anchors, params=None):
    """AnchorOpContext for an op-level call landing on intercept_in."""
    from app.optical.anchor_tracer import (
        AnchorHit, AnchorOpContext, V3AssetAnchorSnapshot,
    )

    in_a = next(a for a in anchors if a.id == "intercept_in")
    hit = AnchorHit(
        slot=None, anchor=in_a, t_lab=1.0, hit_point_body=in_a.position_body,
        offset_y_body=0.0, offset_z_body=0.0, cos_incidence=1.0,
    )
    asset = V3AssetAnchorSnapshot(
        catalog_id="ta", kind="tapered_amplifier", anchors=list(anchors),
    )
    return AnchorOpContext(
        asset=asset, anchor=in_a, hit=hit,
        params=params or {"smallSignalGainDb": 20.0, "saturationPowerMw": 50.0},
        dynamic={},
    )
    del Vec3


def _anchor(anchor_id, pos, axis_x, axis_y=(0.0, 1.0, 0.0)):
    from app.optical.anchor_tracer import V3Anchor
    from app.optical.beam_ray import Vec3
    ax = Vec3(*axis_x)
    ay = Vec3(*axis_y)
    az = Vec3(
        ax.y * ay.z - ax.z * ay.y,
        ax.z * ay.x - ax.x * ay.z,
        ax.x * ay.y - ax.y * ay.x,
    )
    return V3Anchor(
        id=anchor_id, position_body=Vec3(*pos),
        axis_x_body=ax, axis_y_body=ay, axis_z_body=az, aperture_mm=3.0,
    )


def _seed_ray(direction=(1.0, 0.0, 0.0)):
    from app.optical.beam_ray import Vec3, make_beam_ray
    return make_beam_ray(
        origin=Vec3(-10.0, 0.0, 0.0), direction=Vec3(*direction),
        wavelength_nm=780.0, power_mw=1.0,
    )


def test_amplified_output_leaves_from_intercept_out():
    """Regression: the op used to emit from intercept_in via a slab
    passthrough, so the amplified beam started inside the chip and ran on
    through the housing. It must start at the OUTPUT facet."""
    from app.optical.anchor_tracer import get_anchor_op
    from app.optical import anchor_ops  # noqa: F401  (registers ops)

    anchors = [
        _anchor("intercept_in", (-80.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
        _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
    ]
    [out] = get_anchor_op("tapered_amplifier")(_seed_ray(), _op_ctx(anchors))
    assert (out.origin.x, out.origin.y, out.origin.z) == (60.0, 0.0, 0.0)
    assert out.direction.x == 1.0
    # Facet-to-facet separation is added to the optical path length.
    assert out.path_length_mm == 140.0


def test_output_direction_ignores_seed_incidence():
    """Side-output TA: the waveguide sets the exit direction, so a seed
    arriving along +X still leaves along intercept_out's own axisX."""
    from app.optical.anchor_tracer import get_anchor_op
    from app.optical import anchor_ops  # noqa: F401

    anchors = [
        _anchor("intercept_in", (0.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
        # exit facet rotated 90° away from the seed axis
        _anchor("intercept_out", (0.0, 30.0, 0.0), (0.0, 1.0, 0.0),
                axis_y=(0.0, 0.0, 1.0)),
    ]
    [out] = get_anchor_op("tapered_amplifier")(_seed_ray(), _op_ctx(anchors))
    assert (round(out.direction.x), round(out.direction.y)) == (0, 1)


def test_falls_back_to_slab_when_no_intercept_out():
    """Un-migrated single-anchor assets keep the legacy behaviour."""
    from app.optical.anchor_tracer import get_anchor_op
    from app.optical import anchor_ops  # noqa: F401

    anchors = [_anchor("intercept_in", (0.0, 0.0, 0.0), (-1.0, 0.0, 0.0))]
    [out] = get_anchor_op("tapered_amplifier")(_seed_ray(), _op_ctx(anchors))
    assert round(out.direction.x) == 1          # still transmits forward
    assert abs(out.origin.x) < 1.0              # at intercept_in, not 60 mm away


# --- Measured tables --------------------------------------------------------

def test_ase_table_interpolates_and_clamps():
    from app.optical.anchor_ops.misc_ops import ta_ase_table_mw
    rows = [
        {"driveCurrentMa": 0.0, "forwardPowerMw": 0.0, "backwardPowerMw": 0.0},
        {"driveCurrentMa": 1000.0, "forwardPowerMw": 25.0, "backwardPowerMw": 5.0},
        {"driveCurrentMa": 2000.0, "forwardPowerMw": 200.0, "backwardPowerMw": 80.0},
    ]
    assert ta_ase_table_mw(rows, 500.0) == (12.5, 2.5)      # midpoint
    assert ta_ase_table_mw(rows, 9999.0) == (200.0, 80.0)   # clamped high
    assert ta_ase_table_mw(rows, -1.0) == (0.0, 0.0)        # clamped low
    assert ta_ase_table_mw([], 2400.0) is None


def test_gain_table_wins_over_closed_form():
    from app.optical.anchor_ops.misc_ops import (
        ta_forward_power_mw, ta_saturated_power_mw,
    )
    params = {
        "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
        "driveCurrentMa": 2400.0,
        "gainSamples": [
            {"inputPowerMw": 10.0, "driveCurrentMa": 2400.0,
             "forwardPowerMw": 1800.0, "backwardPowerMw": 80.0},
        ],
    }
    assert ta_forward_power_mw(10.0, params) == 1800.0
    # …and the closed form still applies when no table is configured.
    bare = {k: v for k, v in params.items() if k != "gainSamples"}
    assert ta_forward_power_mw(10.0, bare) == ta_saturated_power_mw(10.0, bare)


def test_ase_forward_emits_from_intercept_out():
    """Forward ASE must leave the OUTPUT facet, backward the INPUT facet —
    each along its own outward normal."""
    in_a = _anchor("intercept_in", (-80.0, 0.0, 0.0), (-1.0, 0.0, 0.0))
    out_a = _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0))
    slot = SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={
                "centerWavelengthNm": 852.0,
                "driveCurrentMa": 2000.0,
                "aseSamples": [
                    {"driveCurrentMa": 0.0, "forwardPowerMw": 0.0, "backwardPowerMw": 0.0},
                    {"driveCurrentMa": 2000.0, "forwardPowerMw": 200.0, "backwardPowerMw": 80.0},
                ],
            },
            anchors=[in_a, out_a],
        ),
        scene_object_id="ta-2anchor", binding_id="b",
        effective_transform=_identity_transform(), powered_on=True,
    )
    rays = emit_ta_ase_rays(SimpleNamespace(slots=[slot]), set())
    assert len(rays) == 2
    by_power = {round(r[0].power_mw): r[0] for r in rays}
    fwd, bwd = by_power[200], by_power[80]          # aseSamples @ 2000 mA
    assert fwd.origin.x == 60.0 and round(fwd.direction.x) == 1
    assert bwd.origin.x == -80.0 and round(bwd.direction.x) == -1
