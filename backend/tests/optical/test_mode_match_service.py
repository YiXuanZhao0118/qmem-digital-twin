"""Mode-match service (Phase 3b + Start/range/multi-solution), DB-free.

Fabricates a minimal forward trace (feeder → lens → TA, plus an off-reverse-path
endpoint mirror) so run_mode_match exercises Start/End range handling, Method-1
auto-detection, and the multi-solution output without touching the DB.
"""

import math
from types import SimpleNamespace

import pytest

from app.optical import anchor_ops  # noqa: F401
from app.optical.anchor_tracer import (
    LabSegment, V3Anchor, V3AnchorBindingSlot, V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical.mode_match_service import run_mode_match
from app.optical.pose import V3Transform

WL = 852.0
LENS_Z = 0.0
TA_Z = 80.0


def _seg(oid, start, end, kind, *, qx=0j, qy=0j, plen=0.0):
    return LabSegment(
        start=start, end=end, wavelength_nm=WL, power_mw=1.0,
        scene_object_id=oid, binding_id="b", asset_catalog_id="c",
        anchor_id="intercept_in", op_kind=kind, is_terminal=False,
        emitter_scene_object_id="seed",
        qx_re_at_start=qx.real, qx_im_at_start=qx.imag,
        qy_re_at_start=qy.real, qy_im_at_start=qy.imag,
        path_length_mm_at_start=plen,
    )


def _anchor(aid, ap=25.4):
    return V3Anchor(id=aid, position_body=Vec3(0, 0, 0), axis_x_body=Vec3(0, 0, 1),
                    axis_y_body=Vec3(0, 1, 0), axis_z_body=Vec3(1, 0, 0), aperture_mm=ap)


def _scene():
    lens = V3AnchorBindingSlot(
        scene_object_id="lens0", binding_id="b",
        asset=V3AssetAnchorSnapshot(catalog_id="l", kind="lens", anchors=[_anchor("intercept_in")],
                                    default_params={"focalLengthMm": 60.0, "transmittance": 1.0}),
        effective_transform=V3Transform(origin=Vec3(0, 0, LENS_Z)))
    ta = V3AnchorBindingSlot(
        scene_object_id="ta", binding_id="b",
        asset=V3AssetAnchorSnapshot(catalog_id="ta", kind="tapered_amplifier", anchors=[_anchor("intercept_in", 3.0)],
            default_params={"inputSpatialModeX": {"waistUm": 120.0, "waistZOffsetMm": -40.0},
                            "inputSpatialModeY": {"waistUm": 80.0, "waistZOffsetMm": 30.0}}),
        effective_transform=V3Transform(origin=Vec3(0, 0, TA_Z)))
    m5 = V3AnchorBindingSlot(  # off the reverse path (z=200) so the trace is unaffected
        scene_object_id="m5", binding_id="b",
        asset=V3AssetAnchorSnapshot(catalog_id="m", kind="mirror", anchors=[_anchor("intercept_face", 12.7)],
                                    default_params={"reflectivity": 0.99}),
        effective_transform=V3Transform(origin=Vec3(0, 0, 200.0)))
    return V3AnchorScene(slots=[lens, ta, m5])


def _forward():
    zr = math.pi * 0.4 * 0.4 / (WL * 1e-6)
    q = complex(0.0, zr)
    return SimpleNamespace(lab_segments=[
        _seg("bs", Vec3(0, 0, -30), Vec3(0, 0, LENS_Z), "beam_splitter", qx=q, qy=q),
        _seg("lens0", Vec3(0, 0, LENS_Z), Vec3(0, 0, 30), "lens", qx=q, qy=q, plen=30.0),
        _seg("m5", Vec3(0, 0, 60), Vec3(0, 0, 61), "mirror", plen=95.0),
        _seg("ta", Vec3(0, 0, TA_Z), Vec3(0, 0, TA_Z + 5), "tapered_amplifier", plen=110.0),
    ])


def _kw():
    return dict(seed_emitter_id="seed", ta_object_id="ta", wavelength_nm=WL,
               object_names={"lens0": "LENS0", "m5": "MIRROR_END"})


def test_method2_multi_solution_shape():
    out = run_mode_match(_scene(), _forward(), movable_ids=["lens0"],
                         start_id="bs", endpoint_id="m5", eta_target=0.5, **_kw())
    assert out["mode"] == 2
    keys = {s["key"] for s in out["solutions"]}
    assert "range_maxeff" in keys and "free_maxeff" in keys
    cols = {s["column"] for s in out["solutions"]}
    assert cols == {"range", "free"} or cols == {"range"} | {"free"}
    for s in out["solutions"]:
        assert 0.0 <= s["eta"] <= 1.0
        assert isinstance(s["moves"], list)
        assert isinstance(s["feasible"], bool)


def test_method1_autodetects_in_range_lenses():
    out = run_mode_match(_scene(), _forward(), movable_ids=[],
                         start_id="bs", endpoint_id="m5", eta_target=0.5, **_kw())
    assert out["mode"] == 1
    assert out["detectedLenses"] == ["LENS0"]
    assert any(s["key"] == "range_maxeff" for s in out["solutions"])
    # a range-constrained move keeps lens0 within [Start,End]
    assert all(s["column"] == "range" for s in out["solutions"])


def test_method1_requires_both_endpoints():
    with pytest.raises(ValueError):
        run_mode_match(_scene(), _forward(), movable_ids=[], start_id="bs",
                       endpoint_id=None, eta_target=0.5, **_kw())
