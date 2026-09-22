"""The Python fibre / pigtail ports equal the TypeScript they were ported from.

``backend/tests/fixtures/fibers/*.json`` are written by the REAL TypeScript
(``frontend/src/utils/__tests__/fiberParity.test.ts``, which also fails when
they go stale): the pure helpers called directly, and the store flows run
through the real zustand store with the REST layer mocked. Every case here
feeds a fixture's input to the Python and compares with what the TS returned.

Tolerance: 1e-9 on every number; choices (which candidates, their order, the
link written, which key is present) must match exactly. Euler angles are
compared modulo 360 deg, and near gimbal lock (|cos ry| < 1e-6), where rx and
rz are individually meaningless, a binding pose is compared as the rotation
it denotes.

The store scenes stay inside the pose set where the store's port sweep
agrees with the tracer (see the fixture generator's header and
``docs/introduce/fiber.md``); ``test_fiber_endpoints.py`` pins the backend's
behaviour outside it against the tracer itself.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.optical.beam_ray import Vec3
from app.optical.fibers.geometry import (
    endpoint_outward_body,
    find_fiber_end_alignment_candidates,
    find_fiber_port_alignment_candidates,
    is_fiber_port_connector_type,
    resolve_linked_fiber_endpoint,
    sync_fiber_nodes_from_kind_params,
)
from app.optical.fibers.pigtail import (
    binding_pose_delta,
    compose_binding_poses,
    compute_connector_align_pose,
    connector_port_lab,
    find_pigtail_beam_candidates,
    find_pigtail_port_candidates,
    mated_face_lab,
    pigtail_nodes_following_connector,
    pose_to_matrix,
)
from app.optical.fibers.scene import (
    FiberScene,
    pigtail_port_bindings,
    resolve_effective_fiber_nodes,
)
from app.optical.fibers.service import (
    Writes,
    fiber_apply_candidate,
    fiber_candidates,
    fiber_clear_link,
    fiber_resnap,
    pigtail_apply_candidate,
    pigtail_candidates,
    pigtail_clear_link,
    pigtail_resnap,
)
from app.optical.pose import V3Pose, dir_body_to_lab, point_body_to_lab

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "fibers"
TOL = 1e-9
ANGLE_KEYS = {"localRxDeg", "localRyDeg", "localRzDeg"}
DELTA_ANGLE_KEYS = {"localRxDegDelta", "localRyDegDelta", "localRzDegDelta"}
BINDING_POSE_KEYS = {"localXMm", "localYMm", "localZMm"} | ANGLE_KEYS


def _load(name: str):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# ─── comparison ────────────────────────────────────────────────────────────

def _angle_close(a: float, e: float) -> bool:
    return abs((a - e + 180.0) % 360.0 - 180.0) <= TOL


def _close_binding_pose(actual: dict, expected: dict, path: str) -> None:
    assert set(actual) == set(expected), f"{path}: keys {sorted(actual)} != {sorted(expected)}"
    for k in ("localXMm", "localYMm", "localZMm"):
        assert abs(actual[k] - expected[k]) <= TOL, f"{path}.{k}: {actual[k]} != {expected[k]}"
    if abs(math.cos(math.radians(expected["localRyDeg"]))) < 1e-6:
        ma, me = pose_to_matrix(actual), pose_to_matrix(expected)
        diff = max(abs(x - y) for x, y in zip(ma, me))
        assert diff <= TOL, f"{path}: near-gimbal rotation differs by {diff}"
        return
    for k in ANGLE_KEYS:
        assert _angle_close(actual[k], expected[k]), f"{path}.{k}: {actual[k]} != {expected[k]}"


def assert_close(actual, expected, path: str = "$") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path}: expected an object, got {actual!r}"
        if set(expected) == BINDING_POSE_KEYS:
            _close_binding_pose(actual, expected, path)
            return
        assert set(actual) == set(expected), f"{path}: keys {sorted(actual)} != {sorted(expected)}"
        for k in expected:
            if k in DELTA_ANGLE_KEYS and isinstance(expected[k], (int, float)) and isinstance(actual[k], (int, float)):
                assert _angle_close(actual[k], expected[k]), f"{path}.{k}: {actual[k]} != {expected[k]}"
                continue
            assert_close(actual[k], expected[k], f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, (list, tuple)) and len(actual) == len(expected), \
            f"{path}: {actual!r} != {expected!r}"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_close(a, e, f"{path}[{i}]")
    elif isinstance(expected, bool) or expected is None or isinstance(expected, str):
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"
    else:
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), \
            f"{path}: expected a number, got {actual!r}"
        assert abs(actual - expected) <= TOL, f"{path}: {actual} != {expected}"


def _json(x):
    """Python values in the TS JSON shape (tuples -> lists)."""
    return json.loads(json.dumps(x))


def _pose(d: dict) -> V3Pose:
    return V3Pose(
        x_mm=d["xMm"], y_mm=d["yMm"], z_mm=d["zMm"],
        rx_deg=d["rxDeg"], ry_deg=d["ryDeg"], rz_deg=d["rzDeg"],
    )


def _cases(data: dict, key: str):
    return [pytest.param(c, id=f"{key}[{i}]") for i, c in enumerate(data[key])]


# ─── TS scene JSON -> FiberScene ───────────────────────────────────────────

def scene_from_ts(d: dict) -> FiberScene:
    """The TS scene slice (camelCase) as the detached rows (snake_case)
    ``load_fiber_scene`` builds."""
    comps = {
        c["id"]: SimpleNamespace(
            id=c["id"], name=c.get("name"), kind_id=c.get("kindId"),
            asset_3d_id=c.get("asset3dId"), properties=json.loads(json.dumps(c.get("properties") or {})),
        )
        for c in d.get("components") or []
    }
    by_comp: dict[str, list] = {}
    for b in d.get("componentBindings") or []:
        by_comp.setdefault(b["componentId"], []).append(SimpleNamespace(
            id=b["id"], component_id=b["componentId"], parent_binding_id=b.get("parentBindingId"),
            target_kind=b["targetKind"], asset_3d_id=b.get("asset3dId"),
            sub_component_id=b.get("subComponentId"), role=b.get("role"),
            local_x_mm=b["localXMm"], local_y_mm=b["localYMm"], local_z_mm=b["localZMm"],
            local_rx_deg=b["localRxDeg"], local_ry_deg=b["localRyDeg"], local_rz_deg=b["localRzDeg"],
            properties=json.loads(json.dumps(b.get("properties") or {})), sort_order=b.get("sortOrder", 0),
        ))
    obs: dict[str, dict] = {}
    for ob in d.get("objectBindings") or []:
        obs.setdefault(ob["objectId"], {})[ob["componentBindingId"]] = SimpleNamespace(
            id=ob.get("id"), object_id=ob["objectId"], component_binding_id=ob["componentBindingId"],
            local_x_mm_delta=ob.get("localXMmDelta"), local_y_mm_delta=ob.get("localYMmDelta"),
            local_z_mm_delta=ob.get("localZMmDelta"), local_rx_deg_delta=ob.get("localRxDegDelta"),
            local_ry_deg_delta=ob.get("localRyDegDelta"), local_rz_deg_delta=ob.get("localRzDegDelta"),
            asset_3d_id_override=ob.get("asset3dIdOverride"),
            properties=json.loads(json.dumps(ob.get("properties") or {})),
        )
    assets = {
        a["id"]: SimpleNamespace(
            id=a["id"], name=a.get("name"), kind_id=a.get("kindId"), anchors=a.get("anchors") or [],
            default_params=a.get("defaultParams") or {},
        )
        for a in d.get("assets") or []
    }
    objects = {}
    order = []
    for o in d.get("objects") or []:
        objects[o["id"]] = SimpleNamespace(
            id=o["id"], name=o["name"], component_id=o["componentId"],
            x_mm=o["xMm"], y_mm=o["yMm"], z_mm=o["zMm"],
            rx_deg=o["rxDeg"], ry_deg=o["ryDeg"], rz_deg=o["rzDeg"],
            locked=o.get("locked", False),
            properties=json.loads(json.dumps(o.get("properties") or {})),
            dynamic_sources=o.get("dynamicSources"),
        )
        order.append(o["id"])
    pes = {
        pe["objectId"]: SimpleNamespace(
            id=None, object_id=pe["objectId"], element_kind=pe["elementKind"],
            kind_params=json.loads(json.dumps(pe.get("kindParams"))),
        )
        for pe in d.get("physicsElements") or []
    }
    return FiberScene(
        objects=objects, components=comps, bindings_by_component=by_comp,
        object_bindings=obs, assets=assets, object_order=order, physics_elements=pes,
    )


def snapshot(scene: FiberScene) -> dict:
    """The TS ``snapshot()``: every object's properties, every PE's
    kindParams, every ObjectBinding's payload fields."""
    obs = []
    for oid, rows in scene.object_bindings.items():
        for cb, row in rows.items():
            obs.append({
                "objectId": oid,
                "componentBindingId": cb,
                "localXMmDelta": row.local_x_mm_delta,
                "localYMmDelta": row.local_y_mm_delta,
                "localZMmDelta": row.local_z_mm_delta,
                "localRxDegDelta": row.local_rx_deg_delta,
                "localRyDegDelta": row.local_ry_deg_delta,
                "localRzDegDelta": row.local_rz_deg_delta,
                "asset3dIdOverride": row.asset_3d_id_override,
                "properties": row.properties or {},
            })
    return _json({
        "objects": {oid: scene.objects[oid].properties for oid in scene.object_order},
        "physicsElements": {oid: pe.kind_params for oid, pe in scene.physics_elements.items()},
        "objectBindings": obs,
    })


def _sorted_obs(snap: dict) -> dict:
    return {**snap, "objectBindings": sorted(
        snap["objectBindings"], key=lambda b: (b["objectId"], b["componentBindingId"]),
    )}


# ─── geometry.json ─────────────────────────────────────────────────────────

GEOMETRY = _load("geometry.json")


@pytest.mark.parametrize("case", _cases(GEOMETRY, "isPort"))
def test_is_fiber_port_connector_type(case) -> None:
    assert is_fiber_port_connector_type(case["input"]) is case["output"]


@pytest.mark.parametrize("case", _cases(GEOMETRY, "outward"))
def test_endpoint_outward_body(case) -> None:
    i = case["input"]
    assert_close(list(endpoint_outward_body(i["nodes"], i["end"])), case["output"])


@pytest.mark.parametrize("case", _cases(GEOMETRY, "beam"))
def test_fiber_beam_candidates(case) -> None:
    i = case["input"]
    got = find_fiber_end_alignment_candidates(
        end=i["end"], nodes=i["nodes"], pose=_pose(i["pose"]),
        beam_segments=i["beamSegmentsLab"], tolerance_mm=i["toleranceMm"],
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(GEOMETRY, "port"))
def test_fiber_port_candidates(case) -> None:
    i = case["input"]
    got = find_fiber_port_alignment_candidates(
        end=i["end"], nodes=i["nodes"], pose=_pose(i["pose"]), ports=i["ports"],
        tolerance_mm=i["toleranceMm"], tip_mm=i.get("tipMm"),
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(GEOMETRY, "linked"))
def test_resolve_linked_fiber_endpoint(case) -> None:
    """The port is lifted into lab by the TRACER's pose here; the fixture
    poses are in the set where the TS's local copy agrees."""
    i = case["input"]
    target = _pose(i["targetPose"])
    p = point_body_to_lab(Vec3(*i["targetAnchorPosBodyMm"]), target)
    d = dir_body_to_lab(Vec3(*i["targetAnchorDirBody"]), target)
    kwargs = {}
    if "tipMm" in i:
        kwargs["tip_mm"] = i["tipMm"]
    if "handleMagnitudeMm" in i:
        kwargs["handle_magnitude_mm"] = i["handleMagnitudeMm"]
    got = resolve_linked_fiber_endpoint(
        end=i["endpoint"], fiber_pose=_pose(i["fiberPose"]),
        port_lab=(p.x, p.y, p.z), port_axis_lab=(d.x, d.y, d.z), **kwargs,
    )
    expected = case["output"]
    if expected is None:
        assert got is None
    else:
        assert_close({"posMmBody": got[0], "handleMmBody": got[1]}, expected)


@pytest.mark.parametrize("case", _cases(GEOMETRY, "syncNodes"))
def test_sync_fiber_nodes_from_kind_params(case) -> None:
    i = case["input"]
    assert_close(_json(sync_fiber_nodes_from_kind_params(i.get("endA"), i.get("endB"))), case["output"])


@pytest.mark.parametrize("case", _cases(GEOMETRY, "effectiveNodes"))
def test_resolve_effective_fiber_nodes(case) -> None:
    i = case["input"]
    if i["obj"] is None:
        # The TS keys the PE by the object — no object, nothing. The Python
        # flows never ask without one.
        assert case["output"] is None
        return
    comp = i.get("component")
    obj = {"id": i["obj"]["id"], "name": "o", "componentId": "c1" if comp is not None else "missing",
           "xMm": 0, "yMm": 0, "zMm": 0, "rxDeg": 0, "ryDeg": 0, "rzDeg": 0,
           "properties": i["obj"].get("properties") or {}}
    scene = scene_from_ts({
        "objects": [obj],
        "components": [{"id": "c1", "kindId": "fiber", "properties": comp.get("properties") or {}}] if comp is not None else [],
        "physicsElements": [
            {"objectId": pe["objectId"], "elementKind": pe["elementKind"], "kindParams": pe.get("kindParams")}
            for pe in i["physicsElements"]
        ],
    })
    got = resolve_effective_fiber_nodes(scene, scene.objects[obj["id"]])
    assert_close(_json(got), case["output"])


# ─── pigtail.json ──────────────────────────────────────────────────────────

PIGTAIL = _load("pigtail.json")


def _placement(p: dict) -> dict:
    return {"pose": p["pose"], "parentPose": p.get("parentPose"), "connectIn": p["connectIn"]}


@pytest.mark.parametrize("case", _cases(PIGTAIL, "portLab"))
def test_connector_port_lab(case) -> None:
    i = case["input"]
    assert_close(_json(connector_port_lab(_placement(i["placement"]), i["objectPose"])), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "align"))
def test_compute_connector_align_pose(case) -> None:
    i = case["input"]
    got = compute_connector_align_pose(
        placement=_placement(i["placement"]), object_pose=i["objectPose"],
        target_pos_lab=i["targetPosLab"], target_axis_x_lab=i["targetAxisXLab"],
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "compose"))
def test_compose_binding_poses(case) -> None:
    assert_close(_json(compose_binding_poses(case["input"])), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "delta"))
def test_binding_pose_delta(case) -> None:
    """Exact on the wrap: (−180, 180], so +180 stays +180 and −180 becomes
    +180 — the value is stored, not just its rotation."""
    i = case["input"]
    got = binding_pose_delta(i["target"], i["baseline"])
    assert set(got) == set(case["output"])
    for k, v in case["output"].items():
        assert abs(got[k] - v) <= TOL, f"{k}: {got[k]} != {v}"


@pytest.mark.parametrize("case", _cases(PIGTAIL, "follow"))
def test_pigtail_nodes_following_connector(case) -> None:
    i = case["input"]
    got = pigtail_nodes_following_connector(
        nodes=i["nodes"], old_pose=i["oldPose"], new_pose=i["newPose"],
        connect_out_pos_mm=i["connectOutPosMm"],
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "beam"))
def test_pigtail_beam_candidates(case) -> None:
    i = case["input"]
    got = find_pigtail_beam_candidates(
        port_lab=i["portLab"], beam_segments=i["beamSegmentsLab"], tolerance_mm=i["toleranceMm"],
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "ports"))
def test_pigtail_port_candidates(case) -> None:
    i = case["input"]
    got = find_pigtail_port_candidates(
        end=i["end"], port_lab=i["portLab"], ports=i["ports"], tolerance_mm=i["toleranceMm"],
    )
    assert_close(_json(got), case["output"])


@pytest.mark.parametrize("case", _cases(PIGTAIL, "mated"))
def test_mated_face_lab(case) -> None:
    i = case["input"]
    assert_close(_json(mated_face_lab(i["port"], i["end"])), case["output"])


# ─── port_bindings.json ────────────────────────────────────────────────────

FLOWS = _load("flows.json")
FLOW_BY_NAME = {f["name"]: f for f in FLOWS}
PORT_BINDINGS = _load("port_bindings.json")


@pytest.mark.parametrize(
    "case", PORT_BINDINGS, ids=[f"{c['flow']}/{c['objectId']}" for c in PORT_BINDINGS],
)
def test_pigtail_port_bindings(case) -> None:
    scene = scene_from_ts(FLOW_BY_NAME[case["flow"]]["scene"])
    obj = scene.objects[case["objectId"]]
    got = [
        {
            "end": p.end,
            "portAnchor": p.port_anchor,
            "bindingId": p.binding.id,
            "connectorId": p.connector.id,
            "connectInId": p.connect_in.get("id"),
            "connectOutId": p.connect_out.get("id") if p.connect_out else None,
            "basePose": p.base_pose,
            "effectivePose": p.effective_pose,
            "objectBindingId": p.object_binding.id if p.object_binding is not None else None,
            "parentChain": p.parent_chain,
        }
        for p in pigtail_port_bindings(scene, scene.component_of(obj), obj)
    ]
    assert_close(_json(got), case["ports"])


# ─── flows.json — the store actions, step by step ──────────────────────────

def _find(scene: FiberScene, step: dict, beams: list[dict]) -> list[dict]:
    fn = fiber_candidates if step["kind"] == "fiber" else pigtail_candidates
    return fn(scene, step["objectId"], step["end"], step["toleranceMm"], beams)


@pytest.mark.parametrize("flow", FLOWS, ids=[f["name"] for f in FLOWS])
def test_store_flow(flow) -> None:
    """Replay every find / apply / clear / move / resnap the store ran, on
    the same scene, and compare candidates and the persisted state after
    each write."""
    scene = scene_from_ts(flow["scene"])
    beams = flow["beamSegments"]
    for n, step in enumerate(flow["steps"]):
        where = f"{flow['name']}#{n}:{step['op']}"
        writes = Writes()
        if step["op"] == "find":
            assert_close(_json(_find(scene, step, beams)), step["candidates"], f"{where}.candidates")
            continue
        if step["op"] == "move":
            obj = scene.objects[step["objectId"]]
            p = step["pose"]
            obj.x_mm, obj.y_mm, obj.z_mm = p["xMm"], p["yMm"], p["zMm"]
            obj.rx_deg, obj.ry_deg, obj.rz_deg = p["rxDeg"], p["ryDeg"], p["rzDeg"]
            continue
        if step["op"] == "apply":
            every = _find(scene, step, beams)
            pick = step.get("pick")
            listed = every if pick is None else [c for c in every if (pick == "port") == bool(c.get("port"))]
            cand = listed[step["index"]]
            assert_close(_json(cand), step["candidate"], f"{where}.candidate")
            apply = fiber_apply_candidate if step["kind"] == "fiber" else pigtail_apply_candidate
            assert apply(scene, writes, step["objectId"], step["end"], cand)
        elif step["op"] == "clear":
            clear = fiber_clear_link if step["kind"] == "fiber" else pigtail_clear_link
            clear(scene, writes, step["objectId"], step["end"])
        elif step["op"] == "resnap":
            resnap = fiber_resnap if step["kind"] == "fiber" else pigtail_resnap
            resnap(scene, writes, step["movedObjectIds"])
        assert_close(_sorted_obs(snapshot(scene)), _sorted_obs(step["state"]), f"{where}.state")
