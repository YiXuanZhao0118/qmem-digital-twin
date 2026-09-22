"""Patch-cable endpoint maths — a port of ``frontend/src/utils/fiberAlignment.ts``
and the endpoint half of ``utils/fiberAnchorResolver.ts``.

A fibre is one SceneObject whose spline nodes are in its own body frame. The
node at each end is the JUNCTION at the back of the connector; the optical
face sits ``tip_mm`` further out along the end's outward direction
(``outward = -unit(handle)``). Aligning an end means choosing where the FACE
goes and backing the node out from it:

* onto a beam segment — the face lands on the projection of its current
  position, End A facing back up the beam, End B along it;
* into a fibre receptacle — the face lands ``FIBER_MATING_GAP_MM`` short of
  the port plane, End A facing ``-axisX`` and End B ``+axisX`` (an optical
  anchor's axisX is a propagation direction, so this is NOT the RF
  anti-parallel rule).

Every function is a line-for-line port of the TS it names; the operation order
is kept so the two copies agree to float noise (pinned at 1e-9 by
``backend/tests/fixtures/fibers/``). The fibre's own body<->lab transforms use
the backend's ``app.optical.pose`` — the SceneObject convention the tracer
uses and the TS ``optical/pose`` mirrors.

Nodes, vectors and candidates are plain JSON-shaped values (lists / dicts in
the TS field names), because the nodes are persisted verbatim and the
candidates are returned verbatim.
"""

from __future__ import annotations

import math
import re
from typing import Any

from app.optical.beam_ray import Vec3
from app.optical.pose import (
    V3Pose,
    dir_lab_to_body,
    point_body_to_lab,
    point_lab_to_body,
)

T3 = tuple[float, float, float]

# ``utils/fiberAnchorResolver.FIBER_FERRULE_TIP_MM`` — the Thorlabs 30126A9 FC
# housing length, used when an end has no bound connector asset. Same value as
# ``db_scene_loader.FIBER_FERRULE_TIP_MM``.
FIBER_FERRULE_TIP_MM = 36.28

# ``utils/fiberAnchorResolver.FIBER_MATING_GAP_MM``: a mated face sits this far
# SHORT of the port plane, because a ray emitted exactly on the receiving
# plane reaches it at t = 0 and ``nearest_anchor_hit`` drops it (t_min 1e-9).
# ``backend/tests/optical/test_fiber_port_mating_gap.py`` pins why.
FIBER_MATING_GAP_MM = 0.01

# ``isFiberPortConnectorType``'s ``/^(fc|sc|lc|st)_.*_female$/``. JS ``.``
# excludes every line terminator, Python's only ``\n``; spelled out so the two
# agree on any string.
_FIBER_PORT_RE = re.compile(r"(fc|sc|lc|st)_[^\n\r  ]*_female")


def is_fiber_port_connector_type(connector_type: Any) -> bool:
    """``isFiberPortConnectorType``: a FEMALE fibre bulkhead. ``*_male`` is a
    cable or pigtail plug and is never a port — the port sweep filters on this
    predicate alone, so a gender-blind test would let two cables plug into
    each other."""
    return isinstance(connector_type, str) and _FIBER_PORT_RE.fullmatch(connector_type) is not None


# ─── small helpers ─────────────────────────────────────────────────────────

def is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def as_t3(v: Any) -> T3 | None:
    """A ``[x, y, z]`` of numbers (the persisted node / kindParams shape)."""
    if isinstance(v, (list, tuple)) and len(v) == 3 and all(is_num(n) for n in v):
        return (float(v[0]), float(v[1]), float(v[2]))
    return None


def _to_lab(pose: V3Pose, v: T3) -> T3:
    p = point_body_to_lab(Vec3(v[0], v[1], v[2]), pose)
    return (p.x, p.y, p.z)


def _to_body(pose: V3Pose, v: T3) -> T3:
    p = point_lab_to_body(Vec3(v[0], v[1], v[2]), pose)
    return (p.x, p.y, p.z)


def _dir_to_body(pose: V3Pose, v: T3) -> T3:
    d = dir_lab_to_body(Vec3(v[0], v[1], v[2]), pose)
    return (d.x, d.y, d.z)


def _handle(node: dict, key: str) -> T3 | None:
    return as_t3(node.get(key))


def js_str(v: Any) -> str:
    """How a JS template literal prints a scalar (``${1}`` is ``1``, not
    ``1.0``) — used in the store's dedup keys."""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e21:
        return str(int(v))
    return str(v)


# ─── endpoint read ─────────────────────────────────────────────────────────

def endpoint_outward_body(nodes: list[dict], end: str) -> T3:
    """``endpointOutwardBody``: −unit(handle) when the end's handle is
    non-zero, else the direction away from the neighbour node, else +Y."""
    idx = 0 if end == "A" else len(nodes) - 1
    neighbour = 1 if end == "A" else len(nodes) - 2
    node = nodes[idx]
    handle = _handle(node, "handleOutMm" if end == "A" else "handleInMm")
    if handle is not None and handle[0] ** 2 + handle[1] ** 2 + handle[2] ** 2 > 1e-9:
        m = math.hypot(*handle)
        return (-handle[0] / m, -handle[1] / m, -handle[2] / m)
    pos = as_t3(node.get("posMm")) or (0.0, 0.0, 0.0)
    npos = as_t3(nodes[neighbour].get("posMm")) or (0.0, 0.0, 0.0)
    dx, dy, dz = pos[0] - npos[0], pos[1] - npos[1], pos[2] - npos[2]
    m = math.hypot(dx, dy, dz)
    return (dx / m, dy / m, dz / m) if m > 1e-9 else (0.0, 1.0, 0.0)


def _end_geometry(nodes: list[dict], end: str) -> tuple[T3, T3, float]:
    """(endpoint node pos, outward, default handle length) — the preamble the
    beam and port finders share (``max(20, 0.33 · |node − neighbour|)``)."""
    idx = 0 if end == "A" else len(nodes) - 1
    neighbour = 1 if end == "A" else len(nodes) - 2
    ep = as_t3(nodes[idx].get("posMm")) or (0.0, 0.0, 0.0)
    old_n = as_t3(nodes[neighbour].get("posMm")) or (0.0, 0.0, 0.0)
    seg_len = math.hypot(old_n[0] - ep[0], old_n[1] - ep[1], old_n[2] - ep[2])
    return ep, endpoint_outward_body(nodes, end), max(20.0, seg_len * 0.33)


def _put(out: dict, key: str, value: Any) -> None:
    """Set ``key`` only when the TS would (an ``undefined`` field vanishes in
    JSON)."""
    if value is not None:
        out[key] = value


# ─── candidates ────────────────────────────────────────────────────────────

def beam_candidate_meta(seg: dict, out: dict) -> dict:
    """The label fields a candidate copies off its beam segment verbatim."""
    _put(out, "displayLabel", seg.get("displayLabel"))
    _put(out, "emitterObjectId", seg.get("emitterObjectId"))
    out["aomOrder"] = seg.get("aomOrder")
    _put(out, "branch", seg.get("branch"))
    _put(out, "wavelengthNm", seg.get("wavelengthNm"))
    return out


def find_fiber_end_alignment_candidates(
    *,
    end: str,
    nodes: list[dict],
    pose: V3Pose,
    beam_segments: list[dict],
    tolerance_mm: float | None,
    tip_mm: float = FIBER_FERRULE_TIP_MM,
) -> list[dict]:
    """``findFiberEndAlignmentCandidates``: every beam segment within
    ``tolerance_mm`` of the end's optical face, closest first, each carrying
    the new body-local node + handle. ``tolerance_mm=None`` (a caller that
    named one segment) skips the distance filter.

    ``tip_mm`` is the end's connector length — the flows pass
    ``scene.fiber_end_tip_mm``, as the web store does since 2026-09-22 — so
    the traced face (``node + outward·tip``, ``_synth_fiber_slot``) lands on
    the projected point. The FC-constant default is right only for a fibre
    with no bound connector.
    """
    if len(nodes) < 2:
        return []
    ep, outward, handle_len = _end_geometry(nodes, end)
    anchor_lab = _to_lab(pose, (
        ep[0] + outward[0] * tip_mm,
        ep[1] + outward[1] * tip_mm,
        ep[2] + outward[2] * tip_mm,
    ))
    handle_sign = 1 if end == "A" else -1

    results: list[dict] = []
    for seg in beam_segments:
        a = as_t3(seg.get("aMm"))
        b = as_t3(seg.get("bMm"))
        if a is None or b is None:
            continue
        ab = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        len_sq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
        if len_sq < 1e-6:
            continue
        t = (
            (anchor_lab[0] - a[0]) * ab[0]
            + (anchor_lab[1] - a[1]) * ab[1]
            + (anchor_lab[2] - a[2]) * ab[2]
        ) / len_sq
        tc = max(0.0, min(1.0, t))
        projected = (a[0] + tc * ab[0], a[1] + tc * ab[1], a[2] + tc * ab[2])
        dist = math.hypot(
            anchor_lab[0] - projected[0],
            anchor_lab[1] - projected[1],
            anchor_lab[2] - projected[2],
        )
        if tolerance_mm is not None and dist > tolerance_mm:
            continue
        tan_len = math.sqrt(len_sq)
        tangent = (ab[0] / tan_len, ab[1] / tan_len, ab[2] / tan_len)
        projected_body = _to_body(pose, projected)
        tan_body = _dir_to_body(pose, tangent)
        new_outward = (
            (-tan_body[0], -tan_body[1], -tan_body[2]) if end == "A" else tan_body
        )
        results.append(beam_candidate_meta(seg, {
            "beamId": seg.get("beamId"),
            "distMm": dist,
            "projectedPortLab": list(projected),
            "newPosMmBody": [
                projected_body[0] - new_outward[0] * tip_mm,
                projected_body[1] - new_outward[1] * tip_mm,
                projected_body[2] - new_outward[2] * tip_mm,
            ],
            "newHandleMmBody": [
                handle_sign * tan_body[0] * handle_len,
                handle_sign * tan_body[1] * handle_len,
                handle_sign * tan_body[2] * handle_len,
            ],
            "newOutwardBody": list(new_outward),
        }))
    results.sort(key=lambda c: c["distMm"])
    return results


def port_link(port: dict) -> dict:
    """A port's identity — what ``fiberEndpoints[end]`` / ``pigtailEndpoints``
    persist (the TS ``FiberPortLink``)."""
    return {
        "targetObjectId": port["targetObjectId"],
        "targetAnchorId": port["targetAnchorId"],
        "targetAnchorName": port["targetAnchorName"],
    }


def port_display_label(port: dict) -> str:
    return f"🔌 {port['targetName']} · {port['targetAnchorName']}"


def find_fiber_port_alignment_candidates(
    *,
    end: str,
    nodes: list[dict],
    pose: V3Pose,
    ports: list[dict],
    tolerance_mm: float | None,
    tip_mm: float | None = None,
) -> list[dict]:
    """``findFiberPortAlignmentCandidates``: every receptacle within
    ``tolerance_mm`` of the end's optical face, closest first. The face lands
    one mating gap short of the port plane; End A faces −axisX, End B +axisX.

    ``ports`` are ``FiberPortLab`` dicts (``labPosMm``, ``labAxisX``,
    ``targetName``, ``targetObjectId``, ``targetAnchorId``,
    ``targetAnchorName``)."""
    if len(nodes) < 2:
        return []
    tip = FIBER_FERRULE_TIP_MM if tip_mm is None else tip_mm
    ep, outward, handle_len = _end_geometry(nodes, end)
    face_lab = _to_lab(pose, (
        ep[0] + outward[0] * tip,
        ep[1] + outward[1] * tip,
        ep[2] + outward[2] * tip,
    ))

    results: list[dict] = []
    for port in ports:
        pos = port["labPosMm"]
        axis = port["labAxisX"]
        dist = math.hypot(pos[0] - face_lab[0], pos[1] - face_lab[1], pos[2] - face_lab[2])
        if tolerance_mm is not None and dist > tolerance_mm:
            continue
        m = math.hypot(axis[0], axis[1], axis[2])
        if m < 1e-9:
            continue
        sign = -1 if end == "A" else 1
        new_outward_lab = ((sign * axis[0]) / m, (sign * axis[1]) / m, (sign * axis[2]) / m)
        new_outward = _dir_to_body(pose, new_outward_lab)
        port_body = _to_body(pose, (pos[0], pos[1], pos[2]))
        back_off = tip + FIBER_MATING_GAP_MM
        results.append({
            "beamId": f"port:{port['targetObjectId']}:{port['targetAnchorId']}",
            "distMm": dist,
            "projectedPortLab": [pos[0], pos[1], pos[2]],
            "newPosMmBody": [
                port_body[0] - new_outward[0] * back_off,
                port_body[1] - new_outward[1] * back_off,
                port_body[2] - new_outward[2] * back_off,
            ],
            # The handle points INTO the cable body — the sign
            # endpoint_outward_body reads back out.
            "newHandleMmBody": [
                -new_outward[0] * handle_len,
                -new_outward[1] * handle_len,
                -new_outward[2] * handle_len,
            ],
            "newOutwardBody": list(new_outward),
            "displayLabel": port_display_label(port),
            "port": port_link(port),
        })
    results.sort(key=lambda c: c["distMm"])
    return results


def dedup_fiber_candidates(candidates: list[dict]) -> list[dict]:
    """``findFiberAlignmentCandidates``' dedup: one entry per logical beam
    chain (emitter, AOM order, branch — every ``trace:`` segment of a chain
    shares one key), keeping the closest, then closest first. A port keeps
    its own key."""
    by_key: dict[str, dict] = {}
    for c in candidates:
        beam_id = str(c.get("beamId"))
        emitter = c.get("emitterObjectId")
        order = c.get("aomOrder")
        branch = c.get("branch")
        key = (
            f"{'?' if emitter is None else js_str(emitter)}"
            f":o{'x' if order is None else js_str(order)}"
            f":{'' if branch is None else js_str(branch)}"
            f":{'trace' if beam_id.startswith('trace:') else beam_id}"
        )
        prev = by_key.get(key)
        if prev is None or c["distMm"] < prev["distMm"]:
            by_key[key] = c
    return sorted(by_key.values(), key=lambda c: c["distMm"])


# ─── the linked-end resolver ───────────────────────────────────────────────

def resolve_linked_fiber_endpoint(
    *,
    end: str,
    fiber_pose: V3Pose,
    port_lab: T3,
    port_axis_lab: T3,
    tip_mm: float = FIBER_FERRULE_TIP_MM,
    handle_magnitude_mm: float = 30.0,
) -> tuple[list[float], list[float]] | None:
    """``resolveLinkedFiberEndpoint``: re-derive a plugged end's node + handle
    from the port's LIVE lab pose — what ``resnapFibersLinkedTo`` persists
    when the instrument moves. Returns ``(posMmBody, handleMmBody)``, or None
    on a degenerate port direction.

    Takes the port already in lab, as the TS does since 2026-09-22 — the
    caller resolves it through the target's binding tree and pose. The handle
    is a fixed ``handle_magnitude_mm`` (30), NOT the aligner's
    ``max(20, 0.33·seg)`` — a re-snap therefore re-lengthens the handle,
    exactly as the web does."""
    m = math.hypot(port_axis_lab[0], port_axis_lab[1], port_axis_lab[2])
    if m < 1e-9:
        return None
    sign = -1 if end == "A" else 1
    outward = (
        (sign * port_axis_lab[0]) / m,
        (sign * port_axis_lab[1]) / m,
        (sign * port_axis_lab[2]) / m,
    )
    back_off = tip_mm + FIBER_MATING_GAP_MM
    node_lab = (
        port_lab[0] - outward[0] * back_off,
        port_lab[1] - outward[1] * back_off,
        port_lab[2] - outward[2] * back_off,
    )
    pos_body = _to_body(fiber_pose, node_lab)
    outward_body = _dir_to_body(fiber_pose, outward)
    return (
        list(pos_body),
        [
            -outward_body[0] * handle_magnitude_mm,
            -outward_body[1] * handle_magnitude_mm,
            -outward_body[2] * handle_magnitude_mm,
        ],
    )


# ─── nodes <-> kindParams ──────────────────────────────────────────────────

def sync_fiber_nodes_from_kind_params(end_a: Any, end_b: Any) -> list[dict]:
    """``syncFiberNodesFromKindParams(endA, endB, undefined)``: the two
    endpoint nodes a fibre with no cached ``fiberNodes`` is drawn (and
    aligned) from — ``posMm`` = the junction, the handle = ``tensionHandleMm``,
    with the TS's fallbacks (0 / 300 mm on X, ±10 mm handles)."""

    def endpoint(params: Any, handle_key: str, fb_pos: list, fb_tau: list) -> dict:
        p = params if isinstance(params, dict) else {}
        pos = p.get("posMm")
        tau = p.get("tensionHandleMm")
        return {
            "posMm": list(pos) if isinstance(pos, list) and len(pos) == 3 else list(fb_pos),
            handle_key: list(tau) if isinstance(tau, list) and len(tau) == 3 else list(fb_tau),
        }

    return [
        endpoint(end_a, "handleOutMm", [0, 0, 0], [10, 0, 0]),
        endpoint(end_b, "handleInMm", [300, 0, 0], [-10, 0, 0]),
    ]


def stitch_endpoint(nodes: list[dict], end: str, new_pos: list, new_handle: list) -> list[dict]:
    """``applyFiberAlignmentCandidate``'s node write: the touched endpoint gets
    the new ``posMm`` and its body-side handle (``handleOutMm`` at A,
    ``handleInMm`` at B); its OTHER handle is carried over when present, and
    every other node is untouched. The rest of the node's keys are dropped,
    as the TS builds the node from these three fields alone."""
    idx = 0 if end == "A" else len(nodes) - 1
    old = nodes[idx]
    node: dict = {"posMm": [float(x) for x in new_pos]}
    if end == "B":
        node["handleInMm"] = [float(x) for x in new_handle]
    elif isinstance(old.get("handleInMm"), list):
        node["handleInMm"] = list(old["handleInMm"])
    if end == "A":
        node["handleOutMm"] = [float(x) for x in new_handle]
    elif isinstance(old.get("handleOutMm"), list):
        node["handleOutMm"] = list(old["handleOutMm"])
    out = list(nodes)
    out[idx] = node
    return out


def fiber_end_kind_params(kind_params: Any, end: str, nodes: list[dict]) -> dict | None:
    """``syncFiberEndpointToKindParams``: the fibre PE's kindParams with the
    touched end's ``posMm`` (= the junction node) and ``tensionHandleMm``
    (= its body-side handle) replaced, every other key kept. None when the
    node has no such handle (the TS skips the write)."""
    idx = 0 if end == "A" else len(nodes) - 1
    node = nodes[idx]
    tau = node.get("handleOutMm" if end == "A" else "handleInMm")
    if not isinstance(tau, list) or len(tau) < 3:
        return None
    kp = dict(kind_params) if isinstance(kind_params, dict) else {}
    key = "endA" if end == "A" else "endB"
    existing = kp.get(key)
    merged = dict(existing) if isinstance(existing, dict) else {}
    pos = node["posMm"]
    merged["posMm"] = [pos[0], pos[1], pos[2]]
    merged["tensionHandleMm"] = [tau[0], tau[1], tau[2]]
    kp[key] = merged
    return kp
