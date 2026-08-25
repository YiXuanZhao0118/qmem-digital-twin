"""Tapered amplifier v3 model — saturated gain + unseeded ASE (decision 6b).

See docs/tapered-amplifier-model.md.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

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

def _ta_slot(obj_id: str, anchors=None):
    return SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={"aseForwardMw": 5.0, "aseBackwardMw": 5.0},
            anchors=anchors or [],
        ),
        scene_object_id=obj_id,
        binding_id="binding",
        effective_transform=None,
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
        emission_visuals=None,
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
        emission_visuals=None,
    )
    rays = emit_ta_ase_rays(SimpleNamespace(slots=[slot]), set())
    assert len(rays) == 1                                   # backward suppressed
    assert rays[0][0].power_mw == 8.0
    assert round(rays[0][0].direction.z) == 1               # forward (+axisX) only


def test_hidden_laser_emits_nothing():
    """`emissionVisuals.main.visible = false` drops the emission itself, not
    just its rendering — same contract as the TA's per-facet gate."""
    from app.optical.anchor_ops.emit_laser_source import emit_anchor_source_rays
    laser = SimpleNamespace(
        asset=SimpleNamespace(
            kind="laser_source", default_params={},
            anchors=[_anchor("intercept_out", (0.0, 0.0, 0.0), (1.0, 0.0, 0.0))],
        ),
        scene_object_id="laser-1", binding_id="src",
        effective_transform=_identity_transform(),
        dynamic_sources=None, emission_visuals={"main": {"visible": False}},
    )
    assert emit_anchor_source_rays(SimpleNamespace(slots=[laser])) == []

    # …and it still emits (tagged "main") when visible is left alone.
    laser.emission_visuals = {"main": {"colorHex": "#00ff00"}}
    [(_ray, _emitter, _source, key)] = emit_anchor_source_rays(
        SimpleNamespace(slots=[laser]),
    )
    assert key == "main"


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
        effective_transform=_identity_transform(),
        emission_visuals=None,
    )
    rays = emit_ta_ase_rays(SimpleNamespace(slots=[slot]), set())
    assert len(rays) == 2
    by_power = {round(r[0].power_mw): r for r in rays}
    fwd, bwd = by_power[200], by_power[80]          # aseSamples @ 2000 mA
    assert fwd[0].origin.x == 60.0 and round(fwd[0].direction.x) == 1
    assert bwd[0].origin.x == -80.0 and round(bwd[0].direction.x) == -1
    # Each facet is tagged with its own emission key, so the frontend can
    # colour the two independently.
    assert (fwd[3], bwd[3]) == ("forward", "backward")


def test_hidden_ase_facet_is_not_emitted():
    """`emissionVisuals.backward.visible = false` (Visualization card) drops
    the whole emission, not just its rendering — downstream optics must stop
    reflecting a beam the user hid."""
    slot = SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={
                "ase": {"powerMw": 5.0},
                "centerWavelengthNm": 780.0,
            },
            anchors=[
                _anchor("intercept_in", (-80.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
                _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
            ],
        ),
        scene_object_id="ta-hidden", binding_id="b",
        effective_transform=_identity_transform(),
        emission_visuals={"backward": {"visible": False}},
    )
    [(ray, _emitter, _source, key)] = emit_ta_ase_rays(
        SimpleNamespace(slots=[slot]), set(),
    )
    assert key == "forward"
    assert ray.origin.x == 60.0                     # only the output facet


# --- Output mode: all three GaussianMode fields are honoured ---------------

def _ta_out_ray(mode_x, mode_y, wl=852.0):
    from app.optical.anchor_tracer import get_anchor_op
    from app.optical import anchor_ops  # noqa: F401  (registers ops)

    anchors = [
        _anchor("intercept_in", (0.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
        _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
    ]
    params = {
        "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
        "centerWavelengthNm": wl,
        "outputSpatialModeX": mode_x, "outputSpatialModeY": mode_y,
    }
    [out] = get_anchor_op("tapered_amplifier")(_seed_ray(), _op_ctx(anchors, params))
    return out


def test_output_mode_honours_waist_offset_and_m_squared():
    """Regression: the op built q from waistUm alone, discarding
    waistZOffsetMm and mSquared, so every TA output was pinned to an M²=1
    waist sitting exactly on the output facet."""
    import math

    out = _ta_out_ray(
        {"waistUm": 100.0, "waistZOffsetMm": -500.0, "mSquared": 4.0},
        {"waistUm": 200.0, "waistZOffsetMm": 250.0, "mSquared": 1.0},
    )
    # Since Step 2b, Q is carried in the beam-local (s, p) basis, not the
    # anchor's. For this geometry s = world +z while the anchor's axisY is
    # world +y, so outputSpatialMode**X** (defined along axisY) lands on
    # **qy** and vice versa. The optics is unchanged; only the labelling of
    # which scalar holds which axis is now frame-correct.
    # Re(q) = -waistZOffsetMm: the waist sits z_offset mm downstream.
    assert out.qy.real == 500.0
    assert out.qx.real == -250.0
    # Im(q) = zR, reduced by M² (embedded-Gaussian convention).
    assert out.qy.imag == pytest.approx(math.pi * 0.1**2 / (4.0 * 852e-6), rel=1e-9)
    assert out.qx.imag == pytest.approx(math.pi * 0.2**2 / (1.0 * 852e-6), rel=1e-9)

    # Step 2c closed the gap this test used to pin open: m2 and width_mult are
    # carried as symmetric TENSORS and turn with the frame alongside Q, so they
    # swap here in lockstep with qx/qy above — M² stays attached to the axis it
    # describes instead of to a fixed slot. (Before 2c these read (4.0, 1.0),
    # i.e. M²=4 annotating the axis whose q had moved to the other slot.)
    assert (out.m2x, out.m2y) == (1.0, 4.0)
    assert out.width_mult_x == pytest.approx(1.0)
    assert out.width_mult_y == pytest.approx(2.0)
    # A 90° frame turn is a clean swap, so no cross term is generated.
    assert out.m2xy == pytest.approx(0.0, abs=1e-12)
    assert out.width_mult_xy == pytest.approx(0.0, abs=1e-12)


def test_output_mode_reproduces_measured_sacher_beam():
    """The stored sacher_tec400_852nm_ta fit (WFS30-5C, OUT_1520) must trace
    back to the measured 3.5 mm radius 15 mm past intercept_out on both
    axes — the beam is astigmatic there only in curvature, not in size."""
    import math

    from app.optical.aperture import gaussian_width_mm

    out = _ta_out_ray(
        {"waistUm": 78.8, "waistZOffsetMm": 1031.3, "mSquared": 1.0},
        {"waistUm": 140.8, "waistZOffsetMm": -1800.9, "mSquared": 1.0},
    )
    wx = gaussian_width_mm(out.qx + 15.0, 852.0) * math.sqrt(out.m2x)
    wy = gaussian_width_mm(out.qy + 15.0, 852.0) * math.sqrt(out.m2y)
    assert wx == pytest.approx(3.5, abs=0.01)
    assert wy == pytest.approx(3.5, abs=0.01)


# --- Seeded backward re-emission (input facet) ------------------------------

def _seeded_backward(params):
    """Run the op on a two-anchor TA and return (forward, backward) rays."""
    from app.optical.anchor_tracer import get_anchor_op
    from app.optical import anchor_ops  # noqa: F401  (registers ops)

    anchors = [
        _anchor("intercept_in", (-80.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
        _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
    ]
    rays = get_anchor_op("tapered_amplifier")(_seed_ray(), _op_ctx(anchors, params))
    fwd = [r for r in rays if r.emission_key is None]
    bwd = [r for r in rays if r.emission_key == "backward"]
    return fwd, bwd


def test_seeded_ta_emits_backward_from_input_facet():
    """A seeded TA radiates from its INPUT facet too, back along the seed
    path — power from gainSamples' backward column."""
    fwd, bwd = _seeded_backward({
        "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
        "driveCurrentMa": 2400.0,
        "gainSamples": [
            {"inputPowerMw": 1.0, "driveCurrentMa": 2400.0,
             "forwardPowerMw": 1800.0, "backwardPowerMw": 80.0},
        ],
    })
    assert len(fwd) == 1 and len(bwd) == 1
    [back] = bwd
    assert back.power_mw == pytest.approx(80.0)
    # Leaves intercept_in along that anchor's outward normal (back at the seed).
    assert back.origin.x == -80.0
    assert round(back.direction.x) == -1
    # …while the amplified beam still leaves the output facet forward.
    assert fwd[0].origin.x == 60.0 and round(fwd[0].direction.x) == 1


def test_no_backward_power_configured_emits_only_forward():
    """No gainSamples and no ASE keys → nothing to radiate backward, so the
    op's output is unchanged from before this feature."""
    fwd, bwd = _seeded_backward(
        {"smallSignalGainDb": 20.0, "saturationPowerMw": 50.0},
    )
    assert len(fwd) == 1 and bwd == []


def test_backward_falls_back_to_unseeded_ase_power():
    """With no gain table the input facet still radiates, using the same
    backward-ASE ladder the unseeded emitter uses."""
    _fwd, [back] = _seeded_backward({
        "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
        "driveCurrentMa": 2000.0,
        "aseSamples": [
            {"driveCurrentMa": 0.0, "forwardPowerMw": 0.0, "backwardPowerMw": 0.0},
            {"driveCurrentMa": 2000.0, "forwardPowerMw": 200.0, "backwardPowerMw": 80.0},
        ],
    })
    assert back.power_mw == pytest.approx(80.0)


def test_seeded_backward_profile_matches_unseeded_backward_ase():
    """Item 1 == item 3: the backward beam a SEEDED chip emits carries the
    same transverse profile as the backward ASE the same facet emits when
    unseeded — both are inputSpatialModeX/Y, so mode-matching the input side
    needs only one profile."""
    mode = {
        "inputSpatialModeX": {"waistUm": 1.0, "mSquared": 1.5},
        "inputSpatialModeY": {"waistUm": 3.0, "mSquared": 2.0},
        "centerWavelengthNm": 780.0,
    }
    _fwd, [seeded_back] = _seeded_backward({
        **mode, "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
        "aseBackwardMw": 5.0,
    })

    slot = SimpleNamespace(
        asset=SimpleNamespace(
            kind="tapered_amplifier",
            default_params={**mode, "aseBackwardMw": 5.0, "aseForwardMw": 0.0},
            anchors=[
                _anchor("intercept_in", (-80.0, 0.0, 0.0), (-1.0, 0.0, 0.0)),
                _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0)),
            ],
        ),
        scene_object_id="ta-u", binding_id="b",
        effective_transform=_identity_transform(),
        emission_visuals=None,
    )
    [(unseeded_back, _e, _s, key)] = emit_ta_ase_rays(
        SimpleNamespace(slots=[slot]), set(),
    )
    assert key == "backward"
    # Same waist/M² state on both axes — the two backward beams are one profile.
    assert seeded_back.qx == pytest.approx(unseeded_back.qx)
    assert seeded_back.qy == pytest.approx(unseeded_back.qy)
    assert (seeded_back.m2x, seeded_back.m2y) == (
        unseeded_back.m2x, unseeded_back.m2y,
    )
    assert seeded_back.width_mult_x == pytest.approx(unseeded_back.width_mult_x)
    assert seeded_back.width_mult_y == pytest.approx(unseeded_back.width_mult_y)


# --- Emitter provenance: a seeded TA re-emits -------------------------------

def test_amplified_beam_is_emitted_by_the_ta_not_the_seed_laser():
    """The amplified beam is the chip's own waveguide mode, so every segment
    downstream of the output facet must be attributed to the TA. Before this,
    the seed laser's id ran through the whole chain and the TA's per-instance
    presentation (``properties.emissionVisuals``) could never take effect."""
    from app.optical import anchor_ops  # noqa: F401  (registers ops)
    from app.optical.anchor_tracer import (
        AnchorTraceOptions, V3AnchorBindingSlot, V3AnchorScene,
        V3AssetAnchorSnapshot, trace_ray_anchor_scene,
    )

    slot = V3AnchorBindingSlot(
        scene_object_id="ta-1", binding_id="b0",
        asset=V3AssetAnchorSnapshot(
            catalog_id="ta", kind="tapered_amplifier",
            # Gain axis (axisY) along the seed's polarization, so the TE
            # fraction is ~1 and the amplified ray clears the tracer's power
            # threshold instead of dying at the facet.
            anchors=[
                _anchor("intercept_in", (0.0, 0.0, 0.0), (-1.0, 0.0, 0.0),
                        axis_y=(0.0, 0.0, 1.0)),
                _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                        axis_y=(0.0, 0.0, 1.0)),
            ],
            default_params={"smallSignalGainDb": 20.0, "saturationPowerMw": 50.0},
        ),
        effective_transform=_identity_transform(),
    )
    res = trace_ray_anchor_scene(
        _seed_ray(), V3AnchorScene(slots=[slot]), AnchorTraceOptions(),
        emitter_scene_object_id="laser-1", source_scene_object_id="laser-1",
        emission_key="main",
    )

    seed_leg = next(s for s in res.lab_segments if not s.is_terminal)
    assert seed_leg.emitter_scene_object_id == "laser-1"
    assert seed_leg.emission_key == "main"

    amplified = next(s for s in res.lab_segments if s.is_terminal)
    assert amplified.emitter_scene_object_id == "ta-1"
    assert amplified.source_scene_object_id == "ta-1"
    # …and it is the TA's FORWARD emission, so it takes that colour.
    assert amplified.emission_key == "forward"


def test_seeded_backward_beam_is_tagged_backward_through_the_tracer():
    """The seeded input-facet beam must reach the renderer as the TA's
    BACKWARD emission — same key as the unseeded backward ASE — so the
    frontend colours and hides it with that facet, not with the forward one."""
    from app.optical import anchor_ops  # noqa: F401  (registers ops)
    from app.optical.anchor_tracer import (
        AnchorTraceOptions, V3AnchorBindingSlot, V3AnchorScene,
        V3AssetAnchorSnapshot, trace_ray_anchor_scene,
    )

    slot = V3AnchorBindingSlot(
        scene_object_id="ta-1", binding_id="b0",
        asset=V3AssetAnchorSnapshot(
            catalog_id="ta", kind="tapered_amplifier",
            anchors=[
                _anchor("intercept_in", (0.0, 0.0, 0.0), (-1.0, 0.0, 0.0),
                        axis_y=(0.0, 0.0, 1.0)),
                _anchor("intercept_out", (60.0, 0.0, 0.0), (1.0, 0.0, 0.0),
                        axis_y=(0.0, 0.0, 1.0)),
            ],
            default_params={
                "smallSignalGainDb": 20.0, "saturationPowerMw": 50.0,
                "aseBackwardMw": 40.0,
            },
        ),
        effective_transform=_identity_transform(),
    )
    res = trace_ray_anchor_scene(
        _seed_ray(), V3AnchorScene(slots=[slot]), AnchorTraceOptions(),
        emitter_scene_object_id="laser-1", source_scene_object_id="laser-1",
        emission_key="main",
    )
    keys = {s.emission_key for s in res.lab_segments if s.is_terminal}
    assert keys == {"forward", "backward"}
    # The backward leg travels back along −x from the input facet, and the
    # TA owns it.
    back = next(s for s in res.lab_segments
                if s.is_terminal and s.emission_key == "backward")
    assert back.emitter_scene_object_id == "ta-1"
    assert back.end.x < back.start.x
