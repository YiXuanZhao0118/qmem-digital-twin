"""The Python RF-cable / PPG ports equal the TypeScript they were ported from.

``backend/tests/fixtures/rf_cables/*.json`` are written by the REAL
TypeScript (``frontend/src/utils/__tests__/rfCableParity.test.ts`` — which
also fails when they go stale, so a TS change forces a regeneration, which
then fails here until the port follows):

* ``pure.json`` — the pure utils (``resolveLinkedRfCableEndpoint``,
  ``findRfCableEndpointAlignmentCandidates``, ``connectorTipMmFromAnchors``,
  the port-domain tables, ``computePpgMountedThreePose``);
* ``flows.json`` — the store flows (``createRfCableBetweenPorts``,
  ``resnapRfCablesLinkedTo``, ``findRfCableAlignmentCandidates`` +
  ``applyRfCableAlignmentCandidate``, ``clearRfCableEndpointLink``,
  ``deleteObjects``, ``createPpgAtPort``) run against a recording fake of
  ``api/client``, on a lab-shaped scene and seeded-random ones.

Numbers agree within 1e-9 (poses: Euler angles modulo 360 deg plus one
1e-9 deg storage quantum, compared as rotation matrices near gimbal lock);
choices agree exactly — cable variant, PPG component, rule-rejection code,
delete set and its order.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.optical.pose import V3Pose, _rotation_of
from app.optical.rf_cables import flows
from app.optical.rf_cables.flows import PortRef, RuleError
from app.optical.rf_cables.geometry import (
    RfPortLab,
    connector_tip_mm_from_anchors,
    find_rf_cable_endpoint_alignment_candidates,
    resolve_linked_rf_cable_endpoint,
)
from app.optical.rf_cables.ports import (
    RfScene,
    connector_family_from_anchor,
    kind_participates_in_rf_link,
    resolve_rf_link_port_domain,
    rf_link_role_anchors,
)
from app.optical.rf_cables.ppg_mount import compute_ppg_mounted_pose

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "rf_cables"
TOL = 1e-9
ANGLE_TOL = 1e-9 + 1e-9 * 1.001  # one storage quantum on top of 1e-9
POSE_KEYS = {"xMm", "yMm", "zMm", "rxDeg", "ryDeg", "rzDeg"}


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


PURE = _load("pure.json")
FLOWS = _load("flows.json")


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


# ─── fixture JSON -> Python inputs ─────────────────────────────────────────

def _pose(d: dict) -> V3Pose:
    return V3Pose(
        x_mm=d["xMm"], y_mm=d["yMm"], z_mm=d["zMm"],
        rx_deg=d["rxDeg"], ry_deg=d["ryDeg"], rz_deg=d["rzDeg"],
    )


def rf_scene(d: dict) -> RfScene:
    """The TS scene slice (camelCase) as ORM-like rows (snake_case), in the
    same order — the shape ``service.load_rf_scene`` hands the flows."""
    return RfScene(
        objects=[
            SimpleNamespace(
                id=o["id"], name=o["name"], component_id=o["componentId"],
                x_mm=o["xMm"], y_mm=o["yMm"], z_mm=o["zMm"],
                rx_deg=o["rxDeg"], ry_deg=o["ryDeg"], rz_deg=o["rzDeg"],
                properties=o.get("properties") or {}, locked=o.get("locked", False),
            )
            for o in d["objects"]
        ],
        components=[
            SimpleNamespace(
                id=c["id"], name=c["name"], kind_id=c.get("kindId"), asset_3d_id=c.get("asset3dId"),
                properties=c.get("properties") or {}, archived_at=None,
            )
            for c in d["components"]
        ],
        bindings=[
            SimpleNamespace(
                id=b["id"], component_id=b["componentId"], parent_binding_id=b["parentBindingId"],
                target_kind=b["targetKind"], asset_3d_id=b["asset3dId"],
                sub_component_id=b["subComponentId"], role=b["role"],
                local_x_mm=b["localXMm"], local_y_mm=b["localYMm"], local_z_mm=b["localZMm"],
                local_rx_deg=b["localRxDeg"], local_ry_deg=b["localRyDeg"], local_rz_deg=b["localRzDeg"],
                properties=b.get("properties") or {}, sort_order=b.get("sortOrder", 0),
            )
            for b in d["componentBindings"]
        ],
        assets=[
            SimpleNamespace(
                id=a["id"], kind_id=a.get("kindId"), anchors=a.get("anchors") or [],
                default_params=a.get("defaultParams") or {},
            )
            for a in d["assets"]
        ],
        physics_elements=[
            SimpleNamespace(object_id=p["objectId"], element_kind=p["elementKind"], kind_params=p.get("kindParams") or {})
            for p in d["physicsElements"]
        ],
    )


def _ref(d: dict) -> PortRef:
    return PortRef(object_id=d["objectId"], anchor_name=d["anchorName"], anchor_id=d.get("anchorId"))


def _cases(data: list, key: str):
    return [pytest.param(c, id=f"{key}[{i}]") for i, c in enumerate(data)]


# ─── pure functions ────────────────────────────────────────────────────────

@pytest.mark.parametrize("case", _cases(PURE["resolveLinked"], "resolveLinked"))
def test_resolve_linked_rf_cable_endpoint(case):
    i = case["input"]
    out = resolve_linked_rf_cable_endpoint(
        cable_pose=_pose(i["cablePose"]),
        target_pose=_pose(i["targetPose"]),
        target_anchor_pos_body_mm=tuple(i["targetAnchorPosBodyMm"]),
        target_anchor_dir_body=tuple(i["targetAnchorDirBody"]),
        connector_tip_mm=i.get("connectorTipMm"),
        handle_magnitude_mm=i.get("handleMagnitudeMm"),
    )
    actual = None if out is None else {"posMmBody": list(out.pos_mm_body), "handleMmBody": list(out.handle_mm_body)}
    assert_close(actual, case["output"])


@pytest.mark.parametrize("case", _cases(PURE["alignCandidates"], "alignCandidates"))
def test_find_alignment_candidates(case):
    i = case["input"]
    ports = [
        RfPortLab(
            lab_pos_mm=tuple(p["labPosMm"]), lab_dir_outward=tuple(p["labDirOutward"]),
            target_name=p["targetName"], target_object_id=p["targetObjectId"],
            target_anchor_name=p["targetAnchorName"], target_anchor_id=p["targetAnchorId"],
        )
        for p in i["ports"]
    ]
    out = find_rf_cable_endpoint_alignment_candidates(
        endpoint=i["endpoint"], cable_pose=_pose(i["cablePose"]), cable_nodes=i["cableNodes"],
        ports=ports, tolerance_mm=i["toleranceMm"], handle_magnitude_mm=i.get("handleMagnitudeMm"),
        connector_tip_mm=i.get("connectorTipMm"),
    )
    assert_close([c.as_json() for c in out], case["output"])


@pytest.mark.parametrize("case", _cases(PURE["connectorTip"], "connectorTip"))
def test_connector_tip(case):
    i = case["input"]
    assert_close(connector_tip_mm_from_anchors(i["anchors"], i["family"]), case["output"])


@pytest.mark.parametrize("case", _cases(PURE["portDomains"], "portDomains"))
def test_port_domains_follow_the_plugin_contracts(case):
    kind = case["kind"]
    assert kind_participates_in_rf_link(kind) == case["participates"]
    for anchor_id, domain in case["domains"].items():
        assert resolve_rf_link_port_domain(kind, anchor_id) == domain, anchor_id
    assert [{"anchorId": a, "domain": d} for a, d in rf_link_role_anchors(kind)] == case["roleAnchors"]


def test_connector_family():
    for c in PURE["connectorFamily"]:
        anchor = {} if c["connectorType"] is None else {"connectorType": c["connectorType"]}
        assert connector_family_from_anchor(anchor) == c["family"], c


@pytest.mark.parametrize("case", _cases(PURE["ppgMount"], "ppgMount"))
def test_ppg_mounted_pose(case):
    scene = rf_scene(case["scene"])
    ppg = scene.object_by_id[case["ppgObjectId"]]
    pose = compute_ppg_mounted_pose(scene, ppg, scene.component_of(ppg))
    assert_close(flows.pose_json(pose), case["output"])


# ─── the store flows ───────────────────────────────────────────────────────

_SCENES = [s["scene"] for s in FLOWS["scenes"]]


def _run(op: str, scene: RfScene, req: dict) -> dict:
    if op == "connect":
        try:
            plan = flows.plan_connect(scene, _ref(req["a"]), _ref(req["b"]))
        except RuleError as err:
            return {"ok": False, "code": err.code}
        return {
            "ok": True, "componentId": plan.component_id,
            "pose": flows.pose_json(plan.pose), "properties": plan.properties,
        }
    if op == "resnap":
        moved = req["movedObjectIds"]
        return {
            "patches": flows.plan_resnap(scene, moved),
            "ppgMounts": {k: flows.pose_json(v) for k, v in flows.plan_ppg_mounts(scene, moved).items()},
        }
    if op == "align":
        cands = flows.align_candidates(scene, req["cableId"], req["end"], req["toleranceMm"])
        return {"candidates": [c.as_json() for c in cands]}
    if op in ("disconnect", "ppgDetach"):
        if op == "disconnect":
            linked = flows.disconnect_link(scene, req["cableId"], req["end"]) is not None
            deleted = flows.plan_delete_objects(scene, [req["cableId"]]) if linked else []
        else:
            deleted = flows.plan_delete_objects(scene, [req["ppgId"]])
        return {"deleted": deleted, "deletedPrograms": flows.timing_programs_of(scene, deleted)}
    if op == "ppgAttach":
        try:
            plan = flows.plan_ppg_attach(scene, _ref(req["target"]))
        except RuleError as err:
            return {"ok": False, "code": err.code}
        kp = flows.ppg_kind_params(plan.connector_type, "tp")
        del kp["timingProgramId"]
        return {
            "ok": True, "componentId": plan.component_id, "name": plan.name,
            "programName": plan.program_name, "programIntervals": [],
            "elementKind": "programmable_pulse_generator", "kindParams": kp,
            "attachment": plan.attachment, "mountedPose": flows.pose_json(plan.mounted_pose),
        }
    raise AssertionError(op)


@pytest.mark.parametrize(
    "case", [pytest.param(c, id=f"{i}-{c['op']}-{c['label']}") for i, c in enumerate(FLOWS["cases"])],
)
def test_store_flow(case):
    scene = rf_scene(_SCENES[case["scene"]])
    expected = case["expected"]
    actual = _run(case["op"], scene, case["request"])
    if case["op"] == "align" and "picked" in expected:
        picked = expected["picked"]
        actual["picked"] = picked
        actual["properties"] = flows.plan_align(
            scene, case["request"]["cableId"], case["request"]["end"],
            PortRef(object_id=picked["objectId"], anchor_name=picked["anchorName"], anchor_id=picked["anchorId"]),
            case["request"]["toleranceMm"],
        )
    assert_close(actual, expected)


def test_fixtures_cover_every_outcome():
    """Guard against a fixture regeneration that silently stops exercising a
    branch: every rule code and every flow must still have cases."""
    seen: set[tuple[str, str]] = set()
    for c in FLOWS["cases"]:
        e = c["expected"]
        if c["op"] in ("connect", "ppgAttach"):
            seen.add((c["op"], "ok" if e["ok"] else e["code"]))
        elif c["op"] == "resnap" and e["patches"]:
            seen.add(("resnap", "patched"))
        elif c["op"] == "align" and "properties" in e:
            seen.add(("align", "applied"))
        elif c["op"] in ("disconnect", "ppgDetach") and len(e["deleted"]) > 1:
            seen.add((c["op"], "cascade"))
    for code in (
        "ok", "object_not_found", "port_not_found", "same_object", "role_mismatch",
        "connector_undefined", "domain_mismatch", "port_busy", "no_cable_component",
    ):
        assert ("connect", code) in seen, code
    for code in ("ok", "not_a_gate_input", "connector_undefined", "port_busy", "no_ppg_component"):
        assert ("ppgAttach", code) in seen, code
    for key in (("resnap", "patched"), ("align", "applied"), ("disconnect", "cascade"), ("ppgDetach", "cascade")):
        assert key in seen, key
