"""The Python align ports equal the TypeScript they were ported from.

``backend/tests/fixtures/align/*.json`` are written by the REAL TypeScript
(``frontend/src/utils/__tests__/alignParity.test.ts`` — which also fails when
they go stale, so a TS change forces a regeneration, which then fails here
until the port follows). Every case below feeds a fixture's input to the
Python and compares with what the TS returned.

Tolerance: 1e-9 on every number. Two refinements, both about what a number
MEANS rather than about loosening it:

* Euler angles are compared modulo 360 deg, and are allowed one extra
  quantum of the 1e-9 deg storage grid (``pose_quantize``) — a value within
  float noise of a rounding boundary may land on either neighbour.
* Near gimbal lock (|cos ry| < 1e-6), where rx and rz are individually
  meaningless and only their combination is determined, a pose is compared
  as the rotation matrix it denotes (still 1e-9) instead of angle by angle.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.optical.align.anchor_poses import AlignScene, resolve_anchor_poses_lab, resolve_binding_tree
from app.optical.align.aom_bragg import (
    AomBraggFrame,
    aom_bragg_readout,
    compute_aom_bragg_align_pose,
    compute_aom_tilt_nudge_pose,
    resolve_aom_bragg_frame,
)
from app.optical.align.mirror_coupling import (
    MirrorFacts,
    Ray,
    check_mirror_touch,
    current_target_miss_mm,
    plan_mirror_coupling,
    pose_mirror_to,
    solve_coupling_geometry,
)
from app.optical.align.point_dir import (
    ExtraTilt,
    RoleCentre,
    collect_role_centres,
    compute_isolator_align_pose,
    compute_point_dir_align_pose,
    compute_translate_only_pose,
    pick_polariser_centre,
)
from app.optical.align.frames import scene_object_euler_from_quaternion
from app.optical.align.service import mirror_facts_from_object
from app.optical.align.ts_compat import to_json, v_from_json
from app.optical.kinds.aom.physics import bragg_angle_rad
from app.optical.pose import V3Pose, _rotation_of

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "align"
TOL = 1e-9
ANGLE_TOL = 1e-9 + 1e-9 * 1.001  # one storage quantum on top of 1e-9
POSE_KEYS = {"xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"}


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ─── comparison ────────────────────────────────────────────────────────────

def _matrix(p: dict):
    return _rotation_of(V3Pose(rx_deg=p["rxDeg"], ry_deg=p["ryDeg"], rz_deg=p["rzDeg"])).as_matrix()


def _close_pose(actual: dict, expected: dict, path: str) -> None:
    assert set(actual) == set(expected), f"{path}: keys {sorted(actual)} != {sorted(expected)}"
    for k in ("xMm", "yMm", "zMm"):
        assert abs(actual[k] - expected[k]) <= TOL, f"{path}.{k}: {actual[k]} != {expected[k]}"
    if abs(math.cos(math.radians(expected["ryDeg"]))) < 1e-6:
        diff = abs(_matrix(actual) - _matrix(expected)).max()
        assert diff <= TOL, f"{path}: near-gimbal rotation differs by {diff}"
        return
    for k in ("rxDeg", "ryDeg", "rzDeg"):
        d = (actual[k] - expected[k] + 180.0) % 360.0 - 180.0
        assert abs(d) <= ANGLE_TOL, f"{path}.{k}: {actual[k]} != {expected[k]}"


def assert_close(actual, expected, path: str = "$") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected an object, got {actual!r}"
        if set(expected) == POSE_KEYS:
            _close_pose(actual, expected, path)
            return
        assert set(actual) == set(expected), f"{path}: keys {sorted(actual)} != {sorted(expected)}"
        for k in expected:
            assert_close(actual[k], expected[k], f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), \
            f"{path}: {actual!r} != {expected!r}"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_close(a, e, f"{path}[{i}]")
    elif isinstance(expected, bool) or expected is None or isinstance(expected, str):
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"
    else:
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), \
            f"{path}: expected a number, got {actual!r}"
        assert abs(actual - expected) <= TOL, f"{path}: {actual} != {expected}"


# ─── fixture JSON -> Python inputs ─────────────────────────────────────────

def _v(d):
    return v_from_json(d)


def _pose(d: dict) -> V3Pose:
    return V3Pose(
        x_mm=d["xMm"], y_mm=d["yMm"], z_mm=d["zMm"],
        rx_deg=d["rxDeg"], ry_deg=d["ryDeg"], rz_deg=d["rzDeg"],
    )


def _ray(d: dict) -> Ray:
    return Ray(origin=_v(d["origin"]), dir=_v(d["dir"]))


def _facts(d: dict) -> MirrorFacts:
    return MirrorFacts(
        object_id=d["objectId"], name=d["name"], scene_object=_pose(d["sceneObject"]),
        centre_cad=_v(d["centreCad"]), normal_cad=_v(d["normalCad"]),
        centre_lab=_v(d["centreLab"]), normal_lab=_v(d["normalLab"]),
        aperture_mm=d["apertureMm"],
    )


def _frame(d: dict) -> AomBraggFrame:
    return AomBraggFrame(D1=_v(d["D1"]), D2=_v(d["D2"]), D3=_v(d["D3"]), centre_mm=_v(d["centreMm"]))


def _scene(d: dict, objects: list[dict]) -> AlignScene:
    """The TS scene slice (camelCase) as row-like objects (snake_case), the
    shape ``load_align_scene`` hands the solvers."""
    comps = {
        c["id"]: SimpleNamespace(
            id=c["id"], kind_id=c.get("kindId"), asset_3d_id=c.get("asset3dId"),
            properties=c.get("properties") or {},
        )
        for c in d["components"]
    }
    by_comp: dict[str, list] = {}
    for b in d["componentBindings"]:
        by_comp.setdefault(b["componentId"], []).append(SimpleNamespace(
            id=b["id"], component_id=b["componentId"], parent_binding_id=b["parentBindingId"],
            target_kind=b["targetKind"], asset_3d_id=b["asset3dId"],
            sub_component_id=b["subComponentId"], role=b["role"],
            local_x_mm=b["localXMm"], local_y_mm=b["localYMm"], local_z_mm=b["localZMm"],
            local_rx_deg=b["localRxDeg"], local_ry_deg=b["localRyDeg"], local_rz_deg=b["localRzDeg"],
            properties=b.get("properties") or {}, sort_order=b.get("sortOrder", 0),
        ))
    obs: dict[str, dict] = {}
    for ob in d["objectBindings"]:
        obs.setdefault(ob["objectId"], {})[ob["componentBindingId"]] = SimpleNamespace(
            local_x_mm_delta=ob["localXMmDelta"], local_y_mm_delta=ob["localYMmDelta"],
            local_z_mm_delta=ob["localZMmDelta"], local_rx_deg_delta=ob["localRxDegDelta"],
            local_ry_deg_delta=ob["localRyDegDelta"], local_rz_deg_delta=ob["localRzDegDelta"],
            asset_3d_id_override=ob.get("asset3dIdOverride"),
        )
    assets = {
        a["id"]: SimpleNamespace(
            id=a["id"], kind_id=a.get("kindId"), anchors=a.get("anchors") or [],
            default_params=a.get("defaultParams") or {},
        )
        for a in d["assets"]
    }
    objs = {o["id"]: _object(o) for o in objects}
    return AlignScene(
        objects=objs, components=comps, bindings_by_component=by_comp,
        object_bindings=obs, assets=assets,
    )


def _object(o: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id=o["id"], name=o["name"], component_id=o["componentId"],
        x_mm=o["xMm"], y_mm=o["yMm"], z_mm=o["zMm"],
        rx_deg=o["rxDeg"], ry_deg=o["ryDeg"], rz_deg=o["rzDeg"],
        properties=o.get("properties") or {}, dynamic_sources=o.get("dynamicSources"),
        locked=o.get("locked", False),
    )


def _cases(data: dict, key: str):
    return [pytest.param(c, id=f"{key}[{i}]") for i, c in enumerate(data[key])]


# ─── anchor poses ──────────────────────────────────────────────────────────

ANCHOR_POSES = _load("anchor_poses.json")


@pytest.mark.parametrize("entry", ANCHOR_POSES, ids=[e["name"] for e in ANCHOR_POSES])
def test_anchor_poses_and_role_centres(entry) -> None:
    """``resolveAnchorPosesLab`` / ``collectRoleCentres`` vs the backend's own
    transform chain over the same rows."""
    scene = _scene(entry["scene"], entry["objects"])
    for result in entry["results"]:
        so = scene.objects[result["objectId"]]
        comp = scene.component_of(so)
        got = []
        for a in resolve_anchor_poses_lab(scene, comp, so):
            j = to_json(a)
            j.pop("anchor")
            got.append(j)
        assert_close(got, result["anchors"], f"{entry['name']}/{so.id}.anchors")

        centres: list[RoleCentre] = []
        collect_role_centres(resolve_binding_tree(scene, comp, so.id), centres)
        assert_close(to_json(centres), result["roleCentres"], f"{entry['name']}/{so.id}.roleCentres")
        assert_close(to_json(pick_polariser_centre(centres, "front")), result["front"], "front")
        assert_close(to_json(pick_polariser_centre(centres, "back")), result["back"], "back")

        # ``primaryAssetForObject``: the align paths' main asset, override-aware.
        primary = scene.primary_asset(comp, so.id)
        assert (str(primary.id) if primary is not None else None) == result["primaryAssetId"], \
            f"{entry['name']}/{so.id}.primaryAssetId"


# ─── mirror coupling ───────────────────────────────────────────────────────

MIRROR = _load("mirror_coupling.json")


@pytest.mark.parametrize("case", _cases(MIRROR, "facts"))
def test_mirror_facts_from_the_scene(case) -> None:
    scene = _scene(MIRROR["scene"], [case["object"]])
    so = scene.objects[case["object"]["id"]]
    assert_close(to_json(mirror_facts_from_object(scene, so)), case["output"])


@pytest.mark.parametrize("case", _cases(MIRROR, "solve"))
def test_solve_coupling_geometry(case) -> None:
    i = case["input"]
    got = solve_coupling_geometry(
        in_ray=_ray(i["inRay"]), target_ray=_ray(i["targetRay"]),
        current_a=_v(i["currentA"]), current_b=_v(i["currentB"]),
        fold_mm=i.get("foldMm"), aperture_a_mm=i.get("apertureAMm"),
        aperture_b_mm=i.get("apertureBMm"),
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(MIRROR, "pairs"))
def test_touch_plan_and_miss(case) -> None:
    i = case["input"]
    in_ray, target_ray = _ray(i["inRay"]), _ray(i["targetRay"])
    a, b = _facts(i["a"]), _facts(i["b"])
    assert_close(to_json(check_mirror_touch(in_ray=in_ray, target_ray=target_ray, a=a, b=b)), case["touch"], "touch")
    assert_close(
        to_json(plan_mirror_coupling(in_ray=in_ray, target_ray=target_ray, a=a, b=b, fold_mm=i.get("foldMm"))),
        case["plan"], "plan",
    )
    assert_close(current_target_miss_mm(in_ray, target_ray, a, b), case["miss"], "miss")


@pytest.mark.parametrize("case", _cases(MIRROR, "pose"))
def test_pose_mirror_to(case) -> None:
    i = case["input"]
    got = pose_mirror_to(_facts(i["mirror"]), _v(i["centreLab"]), _v(i["normalLab"]))
    assert_close(to_json(got), case["output"])


# ─── point + direction ─────────────────────────────────────────────────────

POINT_DIR = _load("point_dir.json")


@pytest.mark.parametrize("case", _cases(POINT_DIR, "pointDir"))
def test_point_dir_align_pose(case) -> None:
    i = case["input"]
    tilt = i.get("extraTilt")
    got = compute_point_dir_align_pose(
        point_cad_mm=_v(i["pointCadMm"]), dir_cad_mm=_v(i["dirCadMm"]),
        scene_object=_pose(i["sceneObject"]), beam_dir=_v(i["beamDir"]), beam_ref=_v(i["beamRef"]),
        reverse=bool(i.get("reverse", False)), roll_deg=i.get("rollDeg"),
        extra_tilt=ExtraTilt(axis_cad_mm=_v(tilt["axisCadMm"]), angle_rad=tilt["angleRad"]) if tilt else None,
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(POINT_DIR, "isolator"))
def test_isolator_align_pose(case) -> None:
    i = case["input"]
    got = compute_isolator_align_pose(
        front_cad_mm=_v(i["frontCadMm"]), back_cad_mm=_v(i["backCadMm"]),
        scene_object=_pose(i["sceneObject"]), beam_dir=_v(i["beamDir"]), beam_ref=_v(i["beamRef"]),
        reverse=bool(i.get("reverse", False)), roll_deg=i.get("rollDeg"),
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(POINT_DIR, "translateOnly"))
def test_translate_only_pose(case) -> None:
    i = case["input"]
    got = compute_translate_only_pose(
        point_cad_mm=_v(i["pointCadMm"]), scene_object=_pose(i["sceneObject"]),
        beam_dir=_v(i["beamDir"]), beam_ref=_v(i["beamRef"]),
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(POINT_DIR, "pick"))
def test_pick_polariser_centre(case) -> None:
    i = case["input"]
    centres = [RoleCentre(role=c["role"], is_sub=c["isSub"], pos_mm=_v(c["posMm"])) for c in i["centres"]]
    assert_close(to_json(pick_polariser_centre(centres, i["side"])), case["output"])


# ─── AOM Bragg ─────────────────────────────────────────────────────────────

AOM = _load("aom_bragg.json")


@pytest.mark.parametrize("case", _cases(AOM, "frame"))
def test_aom_bragg_frame(case) -> None:
    i = case["input"]
    assert_close(to_json(resolve_aom_bragg_frame(i["anchors"], i["defaultParams"])), case["output"])


@pytest.mark.parametrize("case", _cases(AOM, "thetaB"))
def test_bragg_angle(case) -> None:
    i = case["input"]
    assert_close(bragg_angle_rad(i["lambdaNm"], i["freqMhz"], i["v"]), case["output"])


@pytest.mark.parametrize("case", _cases(AOM, "align"))
def test_aom_bragg_align_pose(case) -> None:
    i = case["input"]
    got = compute_aom_bragg_align_pose(
        frame=_frame(i["frame"]), scene_object=_pose(i["sceneObject"]),
        beam_dir=_v(i["beamDir"]), beam_ref=_v(i["beamRef"]),
        reverse=bool(i.get("reverse", False)), roll_deg=i.get("rollDeg"), tilt_rad=i["tiltRad"],
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(AOM, "nudge"))
def test_aom_tilt_nudge_pose(case) -> None:
    i = case["input"]
    got = compute_aom_tilt_nudge_pose(
        frame=_frame(i["frame"]), scene_object=_pose(i["sceneObject"]), delta_rad=i["deltaRad"],
    )
    assert_close(to_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(AOM, "readout"))
def test_aom_bragg_readout(case) -> None:
    i = case["input"]
    got = aom_bragg_readout(
        frame=_frame(i["frame"]), scene_object=_pose(i["sceneObject"]), beam_dir=_v(i["beamDir"]),
        theta_b_rad=i["thetaBRad"], wavelength_nm=i["wavelengthNm"], freq_mhz=i["freqMhz"],
        acoustic_velocity_mps=i["acousticVelocityMps"], refractive_index=i["refractiveIndex"],
        crystal_length_mm=i["crystalLengthMm"], orders=i.get("orders"),
    )
    assert_close(to_json(got), case["output"])


# ─── pose decomposition near the gimbal pole ───────────────────────────────

EULER = _load("euler.json")


@pytest.mark.parametrize("case", _cases(EULER, "cases"))
def test_scene_object_euler_from_quaternion(case) -> None:
    """``frames.sceneObjectEulerFromQuaternion``, including ry within
    1e-3 ... 1e-9 deg of +-90 and exactly at it (compared as a rotation there,
    where only rx +- rz is defined)."""
    q = case["input"]["q"]
    rx, ry, rz = scene_object_euler_from_quaternion((q["x"], q["y"], q["z"], q["w"]))
    assert_close({"xMm": 0, "yMm": 0, "zMm": 0, "rxDeg": rx, "ryDeg": ry, "rzDeg": rz}, case["output"])


def test_every_fixture_case_is_exercised() -> None:
    """A fixture section the Python never reads would be a silent hole."""
    assert set(MIRROR) == {"scene", "facts", "solve", "pairs", "pose"}
    assert set(POINT_DIR) == {"pointDir", "isolator", "translateOnly", "pick"}
    assert set(AOM) == {"frame", "thetaB", "align", "nudge", "readout"}
    assert set(EULER) == {"cases"}
