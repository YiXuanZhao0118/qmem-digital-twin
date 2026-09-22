"""Mode-match service (Phase 3b + Start/range/multi-solution), DB-free.

Fabricates a minimal forward trace (feeder → lens → TA, plus an off-reverse-path
endpoint mirror) so run_mode_match exercises Start/End range handling, Method-1
auto-detection, and the multi-solution output without touching the DB.
"""

import math
from types import SimpleNamespace

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from app.optical import anchor_ops  # noqa: F401
from app.optical.anchor_tracer import (
    LabSegment, V3Anchor, V3AnchorBindingSlot, V3AnchorScene,
    V3AssetAnchorSnapshot,
)
from app.optical.beam_ray import Vec3
from app.optical import mode_match_service
from app.optical.mode_match_model import LensConfig, move_transform, rigid_motion
from app.optical.mode_match_optimize import DOFSpec
from app.optical.mode_match_service import _range_specs, absolute_pose, run_mode_match
from app.optical.pose import V3Pose, V3Transform, compose_transforms, pose_to_transform

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


# ── absolute target poses (2026-09-22) ──────────────────────────────────────

def _close_transform(a: V3Transform, b: V3Transform) -> None:
    assert (a.origin.x, a.origin.y, a.origin.z) == pytest.approx(
        (b.origin.x, b.origin.y, b.origin.z), abs=2e-6)  # 1 nm storage grid
    assert np.abs(a.rotation.as_matrix() - b.rotation.as_matrix()).max() < 1e-9


@pytest.mark.parametrize("roll_deg", [0.0, 37.0, -90.0])
def test_absolute_pose_lands_every_slot_where_the_model_put_it(roll_deg):
    """The returned pose, re-read through the tracer's own chain
    (SceneObject pose ∘ binding transform), puts the lens slot exactly where
    ``ModeMatchProblem`` moved it while scoring — whatever the object's
    rotation, the binding offset, or the roll."""
    so = V3Pose(x_mm=-120.5, y_mm=44.25, z_mm=908.8, rx_deg=12.0, ry_deg=-30.0, rz_deg=45.0)
    binding = V3Transform(origin=Vec3(3.0, -7.5, 11.0),
                          rotation=Rotation.from_euler("xyz", [10, -20, 30], degrees=True))
    slot_t = compose_transforms(pose_to_transform(so), binding)
    axis = np.array([0.6, 0.0, 0.8])
    e2 = np.array([0.0, 1.0, 0.0])
    e3 = np.cross(axis, e2)
    pivot = np.array([-118.0, 40.0, 915.0])  # the optical centre, off the origins
    cfg = LensConfig(d_axial=4.25, d_e2=-0.5, d_e3=0.125, roll_deg=roll_deg)
    roll, t = rigid_motion(cfg, axis, e2, e3)

    pose = absolute_pose(so, roll, t, pivot)
    got = compose_transforms(pose_to_transform(V3Pose(
        pose["xMm"], pose["yMm"], pose["zMm"], pose["rxDeg"], pose["ryDeg"], pose["rzDeg"])), binding)
    _close_transform(got, move_transform(slot_t, roll, t, pivot))
    if roll_deg == 0.0:  # a pure translation keeps the stored angles verbatim
        assert (pose["rxDeg"], pose["ryDeg"], pose["rzDeg"]) == (12.0, -30.0, 45.0)


def test_moves_carry_pivot_and_absolute_pose():
    poses = {"lens0": V3Pose(z_mm=LENS_Z), "m5": V3Pose(z_mm=200.0)}
    out = run_mode_match(_scene(), _forward(), movable_ids=["lens0"], start_id="bs",
                         endpoint_id="m5", eta_target=0.5, object_poses=poses, **_kw())
    moves = [m for s in out["solutions"] for m in s["moves"]]
    assert moves, "the optimizer moved nothing — the test would prove nothing"
    for m in moves:
        # The lens's intercept_in sits at its body origin here, so the pivot
        # is the lens's own position on the axis.
        assert m["pivotWorldMm"] == pytest.approx({"x": 0.0, "y": 0.0, "z": LENS_Z})
        # The pose is the move's own fields applied to the current pose:
        # rotate about the pivot, then translate — what a client would do.
        t = m["translateWorldMm"]
        roll = (Rotation.from_rotvec(np.array(list(m["rotateAxisWorld"].values()))
                                     * np.radians(m["rotateDeg"])) if m["rotateDeg"] else None)
        expected = move_transform(pose_to_transform(poses[m["objectId"]]), roll,
                                  np.array([t["x"], t["y"], t["z"]]),
                                  np.array(list(m["pivotWorldMm"].values())))
        p = m["pose"]
        _close_transform(pose_to_transform(V3Pose(
            p["xMm"], p["yMm"], p["zMm"], p["rxDeg"], p["ryDeg"], p["rzDeg"])), expected)
    # Without poses the delta fields are all there is (the web's contract).
    bare = run_mode_match(_scene(), _forward(), movable_ids=["lens0"], start_id="bs",
                          endpoint_id="m5", eta_target=0.5, **_kw())
    assert all(m["pose"] is None for s in bare["solutions"] for m in s["moves"])


# ── the length knobs: endpointLocked / axialMm / lMaxMm (2026-09-22) ─────────
# Accepted and ignored from the Start/range rewrite (2026-08-25) until now.
# Here Start (bs) is hit at z = −30 and the End (m5) at z = +60: a 90 mm
# section. m5's slot sits off the reverse path, so moving it costs no η —
# which isolates what the knobs themselves do.

SPAN = 90.0


@pytest.fixture
def optimize_calls(monkeypatch):
    """Every ``optimize`` call ``run_mode_match`` makes, as (specs, kwargs)."""
    calls: list[tuple[dict, dict]] = []
    real = mode_match_service.optimize

    def spy(problem, *, specs, **kw):
        calls.append((dict(specs), kw))
        return real(problem, specs=specs, **kw)

    monkeypatch.setattr(mode_match_service, "optimize", spy)
    return calls


def _run(**knobs):
    return run_mode_match(_scene(), _forward(), movable_ids=["lens0"], start_id="bs",
                          endpoint_id="m5", eta_target=0.3, **knobs, **_kw())


def test_default_knobs_keep_the_end_frozen_and_the_length_uncapped(optimize_calls):
    """What the web panel (which sends none of the knobs) gets: unchanged."""
    out = _run()
    assert [s["key"] for s in out["solutions"]] == ["range_maxeff", "range_shortest", "free_maxeff"]
    for s in out["solutions"]:
        assert s["endpointLocked"] is True and s["lMaxMm"] is None
        assert all(m["objectId"] != "m5" for m in s["moves"])
    for specs, kw in optimize_calls:
        assert specs["m5"] == DOFSpec()
        assert kw["endpoint_locked"] is True and kw["l_max_mm"] is None
    assert _run(endpoint_locked=True, axial_mm=20.0, l_max_mm=None) == out


def test_unlocked_end_gets_its_travel_and_the_length_limit(optimize_calls):
    out = _run(endpoint_locked=False, axial_mm=7.0, l_max_mm=SPAN + 5.0)
    by_key = {s["key"]: s for s in out["solutions"]}
    assert list(by_key) == ["range_maxeff", "range_shortest", "free_maxeff"]
    # Range column: the lenses stay between Start and the End's current
    # position, so the End may only move AWAY from Start (and optimize()
    # caps that at the limit: +5 of the +7).
    specs, kw = optimize_calls[0]
    assert specs["m5"] == DOFSpec(axial=(0.0, 7.0))
    assert kw["endpoint_locked"] is False and kw["l_max_mm"] == SPAN + 5.0
    # Free column: both ways.
    specs, kw = optimize_calls[-1]
    assert specs["m5"] == DOFSpec(axial=(-7.0, 7.0))
    assert kw["endpoint_locked"] is False and kw["l_max_mm"] == SPAN + 5.0
    # The shortest-footprint searches keep the End where it is.
    for specs, kw in optimize_calls[1:-1]:
        assert specs["m5"] == DOFSpec() and kw["endpoint_locked"] is True
    assert by_key["range_maxeff"]["endpointLocked"] is False
    assert by_key["free_maxeff"]["endpointLocked"] is False
    assert by_key["range_shortest"]["endpointLocked"] is True
    for key in ("range_maxeff", "free_maxeff"):
        s = by_key[key]
        assert s["lMaxMm"] == SPAN + 5.0
        assert s["lengthMm"] <= SPAN + 5.0 + 1e-6
        m5 = [m for m in s["moves"] if m["objectId"] == "m5"]
        d = m5[0]["translateWorldMm"]["z"] if m5 else 0.0
        assert s["lengthMm"] == pytest.approx(SPAN + d)
        assert (0.0 if key == "range_maxeff" else -7.0) - 1e-9 <= d <= 5.0 + 1e-9


def test_a_limit_below_the_frozen_section_makes_every_card_infeasible():
    out = _run(l_max_mm=SPAN - 10.0)
    # No shortest-footprint card: it keeps the End put, so it could not fit.
    assert [s["key"] for s in out["solutions"]] == ["range_maxeff", "free_maxeff"]
    for s in out["solutions"]:
        assert not s["feasible"]
        assert "80.0 mm" in s["reason"] and "locked" in s["reason"]
        assert s["moves"] == [] and s["lMaxMm"] == SPAN - 10.0


def test_an_unlocked_end_shortens_the_section_only_where_the_range_allows():
    out = _run(endpoint_locked=False, axial_mm=20.0, l_max_mm=SPAN - 10.0)
    by_key = {s["key"]: s for s in out["solutions"]}
    # The range column's End may not come back towards Start.
    assert not by_key["range_maxeff"]["feasible"]
    assert "outside its +0.0..+20.0 mm travel" in by_key["range_maxeff"]["reason"]
    # The free column's may: it moves at least 10 mm back and fits.
    free = by_key["free_maxeff"]
    assert free["feasible"] and free["lengthMm"] <= SPAN - 10.0 + 1e-6
    (m5,) = [m for m in free["moves"] if m["objectId"] == "m5"]
    assert -20.0 - 1e-9 <= m5["translateWorldMm"]["z"] <= -10.0 + 1e-9


def test_axial_mm_is_the_travel_of_a_lens_the_seed_misses():
    specs = _range_specs(["hit", "missed"], {"hit": 10.0}, -30.0, 60.0, 0.0, 0.0, 7.5)
    assert specs["missed"].axial == (-7.5, 7.5)
    assert specs["hit"].axial == (-30.0 + 6.0 - 10.0, 60.0 - 6.0 - 10.0)  # the range sets it


def test_unlocking_an_end_upstream_of_start_is_refused():
    # Start = the TA (z = 80), End = m5 (z = 60): the End is upstream.
    kw = dict(movable_ids=["lens0"], start_id="ta", endpoint_id="m5", **_kw())
    run_mode_match(_scene(), _forward(), **kw)  # locked: allowed, as before
    with pytest.raises(ValueError, match="downstream of Start"):
        run_mode_match(_scene(), _forward(), endpoint_locked=False, **kw)
