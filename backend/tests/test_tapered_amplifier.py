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
