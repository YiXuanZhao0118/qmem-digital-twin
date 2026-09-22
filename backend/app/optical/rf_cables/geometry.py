"""The pure RF-cable mating / alignment math — ports of
``frontend/src/utils/rfCableAnchorResolver.ts``,
``frontend/src/utils/rfCableAlignment.ts`` and
``sceneStore.buildRfCableAlignmentProps``.

Line-for-line transcriptions, not re-derivations: the fixtures in
``backend/tests/fixtures/rf_cables/pure.json`` pin them at 1e-9.

Two SceneObject rotation conventions meet here, and must not be "fixed" on
one side only:

* The canonical one (``app.optical.pose``, TS ``optical/pose.ts``) — what the
  tracer and the renderer use. ``resolve_linked_rf_cable_endpoint`` and
  ``find_rf_cable_endpoint_alignment_candidates`` place the CABLE's node with
  it.
* The store's inline ``lab = pose + Rz·Rx·Ry·body`` (:func:`store_body_to_lab`)
  — ``createRfCableBetweenPorts.resolvePort`` (the new cable's midpoint) and
  ``findRfCableAlignmentCandidates`` (the lab position of every candidate
  PORT) use it. It is NOT the canonical rotation (it is the mirror image, in
  a different order), so for a rotated instrument the align-candidate port
  positions differ from where the tracer / renderer put that port. That is
  the TypeScript's behaviour and is ported as-is; see
  ``docs/introduce/rf.md`` §7.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from app.optical.beam_ray import Vec3
from app.optical.pose import (
    V3Pose,
    dir_body_to_lab,
    dir_lab_to_body,
    point_body_to_lab,
    point_lab_to_body,
)

T3 = tuple[float, float, float]

# ``rfCableAnchorResolver.RF_CONNECTOR_TIP_MM`` / ``RF_BNC_CONNECTOR_TIP_MM``:
# the PROCEDURAL connectors' spline-node -> mating-face lengths.
RF_CONNECTOR_TIP_MM = 15.5
RF_BNC_CONNECTOR_TIP_MM = 27.0

# ``createRfCableBetweenPorts`` / ``resolveLinkedRfCableEndpoint`` default
# handle length (mm).
DEFAULT_HANDLE_MM = 30.0

# ``findRfCableAlignmentCandidates``' default snap radius (mm).
DEFAULT_ALIGN_TOLERANCE_MM = 25.0

CABLE_KIND_IDS = ("rf_cable", "sma_cable")


def js_truthy(v: Any) -> bool:
    """JavaScript truthiness for JSON values: every object / array (even an
    empty one) is truthy; ``null``, ``false``, ``0``, ``NaN`` and ``""`` are
    not."""
    if v is None or v is False:
        return False
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == v and v != 0
    if isinstance(v, str):
        return v != ""
    return True


def _num(v: Any) -> float:
    return float(v)


def _t3(v: Any) -> T3:
    return (_num(v[0]), _num(v[1]), _num(v[2]))


def _vec(t: T3) -> Vec3:
    return Vec3(t[0], t[1], t[2])


def _tup(v: Vec3) -> T3:
    return (v.x, v.y, v.z)


def pose_of(obj: Any) -> V3Pose:
    """A SceneObject row's pose as a ``V3Pose``."""
    return V3Pose(
        x_mm=float(obj.x_mm), y_mm=float(obj.y_mm), z_mm=float(obj.z_mm),
        rx_deg=float(obj.rx_deg), ry_deg=float(obj.ry_deg), rz_deg=float(obj.rz_deg),
    )


# ─── connector tip ──────────────────────────────────────────────────────────

def connector_tip_mm_for_family(family: Any) -> float:
    """``connectorTipMmForFamily``: BNC for anything reading as BNC, else SMA."""
    if isinstance(family, str) and family.lower().startswith("bnc"):
        return RF_BNC_CONNECTOR_TIP_MM
    return RF_CONNECTOR_TIP_MM


def _anchor_pos(anchors: list, anchor_id: str) -> Any:
    for a in anchors:
        if isinstance(a, dict) and a.get("id") == anchor_id:
            return a.get("positionMmBodyLocal")
    return None


def connector_tip_mm_from_anchors(anchors: Any, family: Any) -> float:
    """``connectorTipMmFromAnchors``: ``|connect_in - connect_out|`` of a
    connector asset (where the bake puts the mating face), else the family
    constant."""
    if isinstance(anchors, list):
        co = _anchor_pos(anchors, "connect_out")
        ci = _anchor_pos(anchors, "connect_in")
        if js_truthy(co) and js_truthy(ci):
            d = math.hypot(ci["x"] - co["x"], ci["y"] - co["y"], ci["z"] - co["z"])
            if d > 1e-6:
                return d
    return connector_tip_mm_for_family(family)


# ─── spline helpers ─────────────────────────────────────────────────────────

def _normalise(v: T3) -> T3:
    """``rfCableAlignment.normalise``: hypot, 1e-9 floor -> +X."""
    m = math.hypot(v[0], v[1], v[2])
    if m < 1e-9:
        return (1.0, 0.0, 0.0)
    return (v[0] / m, v[1] / m, v[2] / m)


def _endpoint_outward_body(nodes: list, end: str) -> T3:
    """``rfCableAlignment.endpointOutwardBody``: ``-handle`` at the end, else
    the segment away from the neighbour."""
    idx = 0 if end == "A" else len(nodes) - 1
    neighbour_idx = 1 if end == "A" else len(nodes) - 2
    node = nodes[idx]
    neighbour = nodes[neighbour_idx]
    handle = node.get("handleOutMm") if end == "A" else node.get("handleInMm")
    if js_truthy(handle) and handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9:
        return _normalise((-handle[0], -handle[1], -handle[2]))
    p, q = node["posMm"], neighbour["posMm"]
    return _normalise((p[0] - q[0], p[1] - q[1], p[2] - q[2]))


def default_cable_nodes(component_properties: Any) -> list[dict]:
    """The 2-node straight spline a cable without ``rfCableNodes`` gets:
    ``component.properties.lengthMm`` (number) else 150."""
    props = component_properties if isinstance(component_properties, dict) else {}
    v = props.get("lengthMm")
    length = float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 150.0
    return [
        {"posMm": [-length / 2, 0, 0]},
        {"posMm": [length / 2, 0, 0]},
    ]


def cable_nodes(object_properties: Any, component_properties: Any) -> list[dict]:
    """``objProps.rfCableNodes`` when it has >= 2 nodes, else the default."""
    props = object_properties if isinstance(object_properties, dict) else {}
    nodes = props.get("rfCableNodes")
    if isinstance(nodes, list) and len(nodes) >= 2:
        return nodes
    return default_cable_nodes(component_properties)


# ─── the store's inline rotation (see the module docstring) ────────────────

def store_body_to_lab(v: T3, pose: V3Pose, include_translation: bool = True) -> T3:
    """``lab = pose + Rz·Rx·Ry·body`` — the inline transform in
    ``createRfCableBetweenPorts.resolvePort`` and
    ``findRfCableAlignmentCandidates.makeOwnerTransforms``
    (``sceneStore.ts``). Not the canonical SceneObject rotation."""
    rxr = (pose.rx_deg * math.pi) / 180
    ryr = (pose.ry_deg * math.pi) / 180
    rzr = (pose.rz_deg * math.pi) / 180
    cx, sxr = math.cos(rxr), math.sin(rxr)
    cy, syr = math.cos(ryr), math.sin(ryr)
    cz, szr = math.cos(rzr), math.sin(rzr)
    x1 = cy * v[0] + syr * v[2]
    y1 = v[1]
    z1 = -syr * v[0] + cy * v[2]
    y2 = cx * y1 - sxr * z1
    z2 = sxr * y1 + cx * z1
    tx, ty, tz = (pose.x_mm, pose.y_mm, pose.z_mm) if include_translation else (0.0, 0.0, 0.0)
    return (tx + cz * x1 - szr * y2, ty + szr * x1 + cz * y2, tz + z2)


# ─── resolveLinkedRfCableEndpoint ───────────────────────────────────────────

@dataclass(frozen=True)
class LinkedEndpoint:
    pos_mm_body: T3
    handle_mm_body: T3


def resolve_linked_rf_cable_endpoint(
    *,
    cable_pose: V3Pose,
    target_pose: V3Pose,
    target_anchor_pos_body_mm: T3,
    target_anchor_dir_body: T3,
    connector_tip_mm: float | None = None,
    handle_magnitude_mm: float | None = None,
) -> LinkedEndpoint | None:
    """``resolveLinkedRfCableEndpoint``: the body-local node + handle that put
    this cable end's connector mating face ON the target port, facing into
    it (anti-parallel to the port's outward axis). ``None`` when the port's
    direction is degenerate.

    The TS ``nodeOffset`` / ``targetAnchorAxisYBody`` nudge is not ported:
    no flow passes it, and with it absent the nudge adds exact zeros."""
    tip = RF_CONNECTOR_TIP_MM if connector_tip_mm is None else connector_tip_mm
    anchor_lab = _tup(point_body_to_lab(_vec(target_anchor_pos_body_mm), target_pose))
    outward_lab = _tup(dir_body_to_lab(_vec(target_anchor_dir_body), target_pose))
    mag = math.hypot(*outward_lab)
    if mag < 1e-9:
        return None
    unit = (outward_lab[0] / mag, outward_lab[1] / mag, outward_lab[2] / mag)
    new_outward_lab = (-unit[0], -unit[1], -unit[2])
    new_node_lab = (
        anchor_lab[0] - new_outward_lab[0] * tip,
        anchor_lab[1] - new_outward_lab[1] * tip,
        anchor_lab[2] - new_outward_lab[2] * tip,
    )
    pos_body = _tup(point_lab_to_body(_vec(new_node_lab), cable_pose))
    new_outward_body = _tup(dir_lab_to_body(_vec(new_outward_lab), cable_pose))
    handle_mag = DEFAULT_HANDLE_MM if handle_magnitude_mm is None else handle_magnitude_mm
    handle = (
        -new_outward_body[0] * handle_mag,
        -new_outward_body[1] * handle_mag,
        -new_outward_body[2] * handle_mag,
    )
    return LinkedEndpoint(pos_mm_body=pos_body, handle_mm_body=handle)


# ─── findRfCableEndpointAlignmentCandidates ─────────────────────────────────

@dataclass(frozen=True)
class RfPortLab:
    """``rfCableAlignment.RfPortLab``."""

    lab_pos_mm: T3
    lab_dir_outward: T3
    target_name: str
    target_object_id: str
    target_anchor_name: str
    target_anchor_id: str


@dataclass(frozen=True)
class AlignmentCandidate:
    """``rfCableAlignment.RfCableAlignmentResult``."""

    dist_mm: float
    new_pos_mm_body: T3
    new_handle_mm_body: T3
    target_name: str
    target_object_id: str
    target_anchor_name: str
    target_anchor_id: str

    def as_json(self) -> dict:
        return {
            "distMm": self.dist_mm,
            "newPosMmBody": list(self.new_pos_mm_body),
            "newHandleMmBody": list(self.new_handle_mm_body),
            "targetName": self.target_name,
            "targetObjectId": self.target_object_id,
            "targetAnchorName": self.target_anchor_name,
            "targetAnchorId": self.target_anchor_id,
        }


def find_rf_cable_endpoint_alignment_candidates(
    *,
    endpoint: str,
    cable_pose: V3Pose,
    cable_nodes: list,
    ports: list[RfPortLab],
    tolerance_mm: float,
    handle_magnitude_mm: float | None = None,
) -> list[AlignmentCandidate]:
    """``findRfCableEndpointAlignmentCandidates``: every port within
    ``tolerance_mm`` of this end's CURRENT mating face (node + outward x the
    procedural 15.5 mm tip, as the TS has it), nearest first, each with the
    node + handle that would mate it."""
    if len(cable_nodes) < 2:
        return []
    idx = 0 if endpoint == "A" else len(cable_nodes) - 1
    node = cable_nodes[idx]
    outward_body = _endpoint_outward_body(cable_nodes, endpoint)
    outward_lab = _tup(dir_body_to_lab(_vec(outward_body), cable_pose))
    node_lab = _tup(point_body_to_lab(_vec(_t3(node["posMm"])), cable_pose))
    port_lab = (
        node_lab[0] + outward_lab[0] * RF_CONNECTOR_TIP_MM,
        node_lab[1] + outward_lab[1] * RF_CONNECTOR_TIP_MM,
        node_lab[2] + outward_lab[2] * RF_CONNECTOR_TIP_MM,
    )
    existing = node.get("handleOutMm") if endpoint == "A" else node.get("handleInMm")
    existing_mag = math.hypot(existing[0], existing[1], existing[2]) if js_truthy(existing) else 0.0
    if handle_magnitude_mm is not None:
        mag = handle_magnitude_mm
    else:
        mag = existing_mag if existing_mag > 1e-6 else DEFAULT_HANDLE_MM

    results: list[AlignmentCandidate] = []
    for p in ports:
        d = math.hypot(
            p.lab_pos_mm[0] - port_lab[0],
            p.lab_pos_mm[1] - port_lab[1],
            p.lab_pos_mm[2] - port_lab[2],
        )
        if d > tolerance_mm:
            continue
        target_outward = _normalise(p.lab_dir_outward)
        new_outward_lab = (-target_outward[0], -target_outward[1], -target_outward[2])
        new_node_lab = (
            p.lab_pos_mm[0] - new_outward_lab[0] * RF_CONNECTOR_TIP_MM,
            p.lab_pos_mm[1] - new_outward_lab[1] * RF_CONNECTOR_TIP_MM,
            p.lab_pos_mm[2] - new_outward_lab[2] * RF_CONNECTOR_TIP_MM,
        )
        new_pos_body = _tup(point_lab_to_body(_vec(new_node_lab), cable_pose))
        new_outward_body = _tup(dir_lab_to_body(_vec(new_outward_lab), cable_pose))
        results.append(AlignmentCandidate(
            dist_mm=d,
            new_pos_mm_body=new_pos_body,
            new_handle_mm_body=(
                -new_outward_body[0] * mag,
                -new_outward_body[1] * mag,
                -new_outward_body[2] * mag,
            ),
            target_name=p.target_name,
            target_object_id=p.target_object_id,
            target_anchor_name=p.target_anchor_name,
            target_anchor_id=p.target_anchor_id,
        ))
    results.sort(key=lambda c: c.dist_mm)  # stable, like Array.prototype.sort
    return results


# ─── buildRfCableAlignmentProps ─────────────────────────────────────────────

def build_rf_cable_alignment_props(
    object_properties: Any,
    component_properties: Any,
    end: str,
    *,
    new_pos_mm_body: T3,
    new_handle_mm_body: T3,
    target_object_id: Any,
    target_anchor_id: Any,
    target_anchor_name: Any,
) -> dict:
    """``sceneStore.buildRfCableAlignmentProps``: stitch one end's new node +
    handle into the cable's ``rfCableNodes`` (every other node and the
    node's other handle verbatim) and record the end's link in
    ``rfCableEndpoints``."""
    props = object_properties if isinstance(object_properties, dict) else {}
    nodes = cable_nodes(props, component_properties)
    idx = 0 if end == "A" else len(nodes) - 1
    old = nodes[idx]
    new_node: dict = {"posMm": list(new_pos_mm_body)}
    if end == "B":
        new_node["handleInMm"] = list(new_handle_mm_body)
    elif js_truthy(old.get("handleInMm")):
        new_node["handleInMm"] = list(old["handleInMm"])
    if end == "A":
        new_node["handleOutMm"] = list(new_handle_mm_body)
    elif js_truthy(old.get("handleOutMm")):
        new_node["handleOutMm"] = list(old["handleOutMm"])
    next_nodes = list(nodes)
    next_nodes[idx] = new_node
    existing = props.get("rfCableEndpoints")
    endpoints = dict(existing) if isinstance(existing, dict) else {}
    endpoints[end] = {
        "targetObjectId": target_object_id,
        "targetAnchorId": target_anchor_id,
        "targetAnchorName": target_anchor_name,
    }
    return {**props, "rfCableNodes": next_nodes, "rfCableEndpoints": endpoints}
