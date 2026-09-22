"""The fibre / pigtail flows, ported from the web store action by action.

Each flow here is the Python twin of one ``sceneStore`` action:

========================================  ==========================================
``fiber_candidates``                      ``findFiberAlignmentCandidates``
``fiber_apply_candidate``                 ``applyFiberAlignmentCandidate`` (+ ``updateFiberNodes``,
                                          ``syncFiberEndpointToKindParams``)
``fiber_clear_link``                      ``clearFiberEndpointLink``
``fiber_resnap``                          ``resnapFibersLinkedTo``
``pigtail_candidates``                    ``findPigtailAlignmentCandidates``
``pigtail_apply_candidate``               ``applyPigtailAlignmentCandidate``
``pigtail_clear_link``                    ``clearPigtailEndpointLink``
``pigtail_resnap``                        ``resnapPigtailsLinkedTo``
========================================  ==========================================

They run on a :class:`~app.optical.fibers.scene.FiberScene` of DETACHED rows,
mutate it the way the store mutates its state (so a later step sees an
earlier write), and record in :class:`Writes` what changed — the router
copies exactly that back to the database in one transaction. What a flow
writes is what the web writes, field for field:

* a fibre end: ``SceneObject.properties.fiberNodes`` (the whole array, the
  touched endpoint re-derived), ``properties.fiberEndpoints[end]`` set (a
  receptacle) or removed (a beam), and the fibre PE's
  ``kindParams.endA/endB.posMm`` + ``tensionHandleMm`` — the write-through the
  solver actually reads (``_synth_fiber_slot``);
* a pigtail end: the connector binding's ``ObjectBinding`` delta (never the
  ComponentBinding — that is the catalog baseline), the pigtail spline's last
  node in ``properties.bindingFiberNodes[bindingId]``, and
  ``properties.pigtailEndpoints[portAnchor]`` set or removed.

Nothing here deletes anything or unlinks on its own initiative: a re-snap
skips a link it cannot resolve (the target or its anchor is missing) rather
than clearing it, and only an explicit disconnect or a beam placement drops a
link (``docs/introduce/rf.md`` §7 — destructive clean-up acts only on facts
positively established).

Beam segments are the CALLER's (the ``BeamSegmentLab`` shape the web builds
from its live trace): which beam a face goes onto is the user's pick, as in
the ``/api/v3/align`` endpoints.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from app.optical.align.anchor_poses import object_pose
from app.optical.fibers.geometry import (
    dedup_fiber_candidates,
    fiber_end_kind_params,
    find_fiber_end_alignment_candidates,
    find_fiber_port_alignment_candidates,
    resolve_linked_fiber_endpoint,
    stitch_endpoint,
)
from app.optical.fibers.pigtail import (
    binding_pose_delta,
    compute_connector_align_pose,
    connector_port_lab,
    dedup_pigtail_candidates,
    find_pigtail_beam_candidates,
    find_pigtail_port_candidates,
    mated_face_lab,
    pigtail_nodes_following_connector,
)
from app.optical.fibers.scene import (
    FiberScene,
    PigtailPort,
    collect_fiber_ports_lab,
    fiber_end_tip_mm,
    find_owned_anchor,
    js_falsy,
    object_pose_json,
    pigtail_port_bindings,
    props_of,
    resolve_effective_fiber_nodes,
)

ENDS = ("A", "B")
DEFAULT_TOLERANCE_MM = 25.0


class FiberError(Exception):
    """A request a flow cannot serve; ``status`` is the HTTP code."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class Writes:
    """What a flow changed, keyed so the router can write each row once.

    ``objects``: object ids whose ``properties`` changed. ``fiber_elements``:
    object ids whose fibre PE ``kind_params`` changed. ``object_bindings``:
    ``(object_id, component_binding_id)`` of each upserted ``ObjectBinding``.
    The new values live on the scene rows themselves."""

    objects: list[str] = field(default_factory=list)
    fiber_elements: list[str] = field(default_factory=list)
    object_bindings: list[tuple[str, str]] = field(default_factory=list)

    def touch_object(self, oid: str) -> None:
        if oid not in self.objects:
            self.objects.append(oid)

    def touch_fiber_element(self, oid: str) -> None:
        if oid not in self.fiber_elements:
            self.fiber_elements.append(oid)

    def touch_object_binding(self, key: tuple[str, str]) -> None:
        if key not in self.object_bindings:
            self.object_bindings.append(key)


def _beams_excluding(beam_segments: list[dict], object_id: str) -> list[dict]:
    """``collectBeamSegmentsLab(scene, objectId)``: a part never snaps to a
    segment it emitted itself (``sourceObjectId``)."""
    return [s for s in beam_segments if s.get("sourceObjectId") != object_id]


def _set_properties(scene: FiberScene, writes: Writes, obj: Any, props: dict) -> None:
    obj.properties = props
    writes.touch_object(obj.id)


# ─── fibres ────────────────────────────────────────────────────────────────

def fiber_candidates(
    scene: FiberScene,
    object_id: str,
    end: str,
    tolerance_mm: float | None = DEFAULT_TOLERANCE_MM,
    beam_segments: list[dict] | None = None,
) -> list[dict]:
    """``findFiberAlignmentCandidates``: beam segments and fibre receptacles
    within ``tolerance_mm`` of the end's optical face, one entry per beam
    chain, closest first. A receptacle candidate carries ``port``."""
    obj = scene.objects.get(object_id)
    if obj is None:
        return []
    nodes = resolve_effective_fiber_nodes(scene, obj)
    if not nodes or len(nodes) < 2:
        return []
    pose = object_pose(obj)
    # One tip for both finders: the bound connector's, where the solver puts
    # the traced face.
    tip = fiber_end_tip_mm(scene, obj, end)
    ports = find_fiber_port_alignment_candidates(
        end=end, nodes=nodes, pose=pose,
        ports=collect_fiber_ports_lab(scene, obj.id),
        tolerance_mm=tolerance_mm,
        tip_mm=tip,
    )
    beams = find_fiber_end_alignment_candidates(
        end=end, nodes=nodes, pose=pose,
        beam_segments=_beams_excluding(beam_segments or [], obj.id),
        tolerance_mm=tolerance_mm,
        tip_mm=tip,
    )
    return dedup_fiber_candidates(beams + ports)


def fiber_apply_candidate(
    scene: FiberScene, writes: Writes, object_id: str, end: str, candidate: dict,
) -> bool:
    """``applyFiberAlignmentCandidate``: stitch the candidate's node + handle
    into the fibre's nodes, set (receptacle) or clear (beam) the end's link,
    and write the endpoint through to the fibre PE's kindParams. False when
    the fibre has no usable spline (the store returns without writing)."""
    obj = scene.objects.get(object_id)
    if obj is None:
        return False
    nodes = resolve_effective_fiber_nodes(scene, obj)
    if not nodes or len(nodes) < 2:
        return False
    next_nodes = stitch_endpoint(
        nodes, end, candidate["newPosMmBody"], candidate["newHandleMmBody"],
    )

    # updateFiberNodes(objectId, nextNodes, port ? undefined : end): a beam
    # placement escapes the link (manual override beats link).
    props = dict(props_of(obj))
    port = candidate.get("port")
    if not port and isinstance(props.get("fiberEndpoints"), dict):
        endpoints = dict(props["fiberEndpoints"])
        endpoints.pop(end, None)
        props["fiberEndpoints"] = endpoints
    props["fiberNodes"] = next_nodes
    if port:
        existing = props.get("fiberEndpoints")
        merged = dict(existing) if isinstance(existing, dict) else {}
        merged[end] = port
        props["fiberEndpoints"] = merged
    _set_properties(scene, writes, obj, props)

    # syncFiberEndpointToKindParams — the write the solver reads.
    pe = scene.physics_elements.get(obj.id)
    if pe is not None and pe.element_kind == "fiber":
        kp = fiber_end_kind_params(pe.kind_params, end, next_nodes)
        if kp is not None:
            pe.kind_params = kp
            writes.touch_fiber_element(obj.id)
    return True


def fiber_clear_link(scene: FiberScene, writes: Writes, object_id: str, end: str) -> bool:
    """``clearFiberEndpointLink``: unplug in place — only the link record
    goes, the spline stays exactly where it is (a patch cable dangling off a
    bulkhead is a real bench state; contrast the coax contract, which deletes
    the cable). False when there was no link at that end (nothing written)."""
    obj = scene.objects.get(object_id)
    if obj is None:
        return False
    props = props_of(obj)
    endpoints = props.get("fiberEndpoints")
    if not isinstance(endpoints, dict) or js_falsy(endpoints.get(end)):
        return False
    nxt = dict(endpoints)
    nxt.pop(end, None)
    _set_properties(scene, writes, obj, {**props, "fiberEndpoints": nxt})
    return True


def fiber_resnap(scene: FiberScene, writes: Writes, moved_object_ids: list[str]) -> list[dict]:
    """``resnapFibersLinkedTo``: re-derive every plugged fibre end whose
    target is among ``moved_object_ids`` from the port's live pose, and write
    it through the normal apply path (nodes + kindParams + the same link).
    Returns what moved. A link whose target or anchor cannot be resolved is
    SKIPPED, never cleared."""
    if not moved_object_ids:
        return []
    moved = set(moved_object_ids)
    done: list[dict] = []
    for oid in list(scene.object_order):
        obj = scene.objects[oid]
        links = props_of(obj).get("fiberEndpoints")
        if js_falsy(links) or not isinstance(links, dict):
            continue
        for end in ENDS:
            link = links.get(end)
            if not isinstance(link, dict) or link.get("targetObjectId") not in moved:
                continue
            target = scene.objects.get(link["targetObjectId"])
            if target is None or scene.component_of(target) is None:
                continue
            owned = find_owned_anchor(
                scene, target, link.get("targetAnchorId"), link.get("targetAnchorName"),
            )
            if owned is None or owned.axis_x_lab is None:
                continue
            nodes = resolve_effective_fiber_nodes(scene, obj)
            if not nodes or len(nodes) < 2:
                continue
            resolved = resolve_linked_fiber_endpoint(
                end=end,
                fiber_pose=object_pose(obj),
                port_lab=tuple(owned.pos_lab),
                port_axis_lab=tuple(owned.axis_x_lab),
                tip_mm=fiber_end_tip_mm(scene, obj, end),
            )
            if resolved is None:
                continue
            fiber_apply_candidate(scene, writes, obj.id, end, {
                "beamId": f"port:{link['targetObjectId']}:{link.get('targetAnchorId')}",
                "distMm": 0,
                "projectedPortLab": [0, 0, 0],
                "newPosMmBody": resolved[0],
                "newHandleMmBody": resolved[1],
                "newOutwardBody": [0, 0, 0],
                "port": link,
            })
            done.append({"objectId": obj.id, "end": end, **_link_fields(link)})
    return done


def _link_fields(link: dict) -> dict:
    return {
        "targetObjectId": link.get("targetObjectId"),
        "targetAnchorId": link.get("targetAnchorId"),
        "targetAnchorName": link.get("targetAnchorName"),
    }


# ─── pigtails ──────────────────────────────────────────────────────────────

def pigtail_port(scene: FiberScene, obj: Any, end: str) -> PigtailPort | None:
    comp = scene.component_of(obj)
    if comp is None:
        return None
    for ref in pigtail_port_bindings(scene, comp, obj):
        if ref.end == end:
            return ref
    return None


def pigtail_port_lab(scene: FiberScene, obj: Any, ref: PigtailPort) -> dict | None:
    return connector_port_lab(ref.placement(), object_pose_json(obj))


def pigtail_candidates(
    scene: FiberScene,
    object_id: str,
    end: str,
    tolerance_mm: float | None = DEFAULT_TOLERANCE_MM,
    beam_segments: list[dict] | None = None,
) -> list[dict]:
    """``findPigtailAlignmentCandidates``: beams and receptacles within
    ``tolerance_mm`` of the port CONNECTOR's face (the face the loader
    re-seats the device's port onto), one entry per beam chain, closest
    first."""
    obj = scene.objects.get(object_id)
    if obj is None or scene.component_of(obj) is None:
        return []
    ref = pigtail_port(scene, obj, end)
    if ref is None:
        return []
    port_lab = pigtail_port_lab(scene, obj, ref)
    if port_lab is None:
        return []
    return dedup_pigtail_candidates(
        find_pigtail_beam_candidates(
            port_lab=port_lab,
            beam_segments=_beams_excluding(beam_segments or [], obj.id),
            tolerance_mm=tolerance_mm,
        )
        + find_pigtail_port_candidates(
            end=end, port_lab=port_lab,
            ports=collect_fiber_ports_lab(scene, obj.id),
            tolerance_mm=tolerance_mm,
        )
    )


def pigtail_apply_candidate(
    scene: FiberScene, writes: Writes, object_id: str, end: str, candidate: dict,
) -> bool:
    """``applyPigtailAlignmentCandidate``: move the port connector so its face
    lands on the candidate (an ``ObjectBinding`` delta, the housing stays
    put), drag the pigtail's last node along, set (receptacle) or clear
    (beam) the link keyed by the port anchor. False when there is nothing to
    move (no such port, or its face has no axis triad)."""
    obj = scene.objects.get(object_id)
    if obj is None or scene.component_of(obj) is None:
        return False
    ref = pigtail_port(scene, obj, end)
    if ref is None:
        return False
    new_pose = compute_connector_align_pose(
        placement=ref.placement(),
        object_pose=object_pose_json(obj),
        target_pos_lab=candidate["targetPosLab"],
        target_axis_x_lab=candidate["targetAxisXLab"],
    )
    if new_pose is None:
        return False

    # The per-INSTANCE delta — the ComponentBinding row is the catalog
    # baseline every EOM shares. The upsert replaces the whole row, so the
    # override asset and the row's properties are carried through.
    delta = binding_pose_delta(new_pose, ref.base_pose)
    ob = ref.object_binding
    by_binding = scene.object_bindings.setdefault(obj.id, {})
    row = by_binding.get(ref.binding.id)
    if row is None:
        row = SimpleNamespace(
            id=None, object_id=obj.id, component_binding_id=ref.binding.id,
            asset_3d_id_override=None, properties={},
        )
        by_binding[ref.binding.id] = row
    row.local_x_mm_delta = delta["localXMmDelta"]
    row.local_y_mm_delta = delta["localYMmDelta"]
    row.local_z_mm_delta = delta["localZMmDelta"]
    row.local_rx_deg_delta = delta["localRxDegDelta"]
    row.local_ry_deg_delta = delta["localRyDegDelta"]
    row.local_rz_deg_delta = delta["localRzDegDelta"]
    row.asset_3d_id_override = getattr(ob, "asset_3d_id_override", None) if ob is not None else None
    row.properties = copy.deepcopy(ob.properties) if ob is not None and ob.properties is not None else {}
    writes.touch_object_binding((obj.id, ref.binding.id))

    props = dict(props_of(obj))
    by_nodes = props.get("bindingFiberNodes")
    by_nodes = by_nodes if isinstance(by_nodes, dict) else {}
    nodes = by_nodes.get(ref.binding.id)
    if nodes is None:
        nodes = props_of(ref.binding).get("fiberNodes")
    root = ref.connect_out.get("positionMmBodyLocal") if ref.connect_out else None
    if (
        ref.connect_out is not None
        and isinstance(nodes, list) and len(nodes) >= 2
        and isinstance(root, dict)
    ):
        props["bindingFiberNodes"] = {
            **by_nodes,
            ref.binding.id: pigtail_nodes_following_connector(
                nodes=nodes,
                old_pose=ref.effective_pose,
                new_pose=new_pose,
                connect_out_pos_mm=[root.get("x"), root.get("y"), root.get("z")],
            ),
        }
    links_raw = props.get("pigtailEndpoints")
    links = dict(links_raw) if isinstance(links_raw, dict) else {}
    if candidate.get("port"):
        links[ref.port_anchor] = candidate["port"]
    else:
        links.pop(ref.port_anchor, None)
    props["pigtailEndpoints"] = links
    _set_properties(scene, writes, obj, props)
    return True


def pigtail_clear_link(scene: FiberScene, writes: Writes, object_id: str, end: str) -> bool:
    """``clearPigtailEndpointLink``: drop one end's link without moving the
    connector. False when that port has no link (nothing written)."""
    obj = scene.objects.get(object_id)
    if obj is None or scene.component_of(obj) is None:
        return False
    ref = pigtail_port(scene, obj, end)
    if ref is None:
        return False
    props = props_of(obj)
    links_raw = props.get("pigtailEndpoints")
    links = dict(links_raw) if isinstance(links_raw, dict) else {}
    if ref.port_anchor not in links:
        return False
    links.pop(ref.port_anchor)
    _set_properties(scene, writes, obj, {**props, "pigtailEndpoints": links})
    return True


def pigtail_resnap(scene: FiberScene, writes: Writes, moved_object_ids: list[str]) -> list[dict]:
    """``resnapPigtailsLinkedTo``: re-mate every pigtail end plugged into a
    receptacle on one of ``moved_object_ids``. The receptacles are resolved
    once, up front, as the store does. Unresolvable links are skipped, never
    cleared."""
    if not moved_object_ids:
        return []
    moved = set(moved_object_ids)
    ports = collect_fiber_ports_lab(scene, None)
    done: list[dict] = []
    for oid in list(scene.object_order):
        obj = scene.objects[oid]
        links = props_of(obj).get("pigtailEndpoints")
        if js_falsy(links) or not isinstance(links, dict):
            continue
        for port_anchor, link in list(links.items()):
            if not isinstance(link, dict) or link.get("targetObjectId") not in moved:
                continue
            port = next(
                (p for p in ports
                 if p["targetObjectId"] == link["targetObjectId"]
                 and p["targetAnchorId"] == link.get("targetAnchorId")),
                None,
            )
            if port is None:
                continue
            end = "B" if port_anchor == "intercept_out" else "A"
            mated = mated_face_lab(port, end)
            if mated is None:
                continue
            if pigtail_apply_candidate(scene, writes, obj.id, end, {
                "key": f"port:{link['targetObjectId']}:{link.get('targetAnchorId')}",
                "distMm": 0,
                **mated,
                "port": link,
            }):
                done.append({"objectId": obj.id, "end": end, "portAnchor": port_anchor, **_link_fields(link)})
    return done


# ─── request-level helpers (what the routers call) ─────────────────────────
#
# The web app never needs these: its picker only ever offers candidates the
# finder produced. An API caller names a TARGET instead, so the candidate for
# exactly that target is recomputed here — the same finder, restricted to the
# one port / segment — and applied. A bad target is a 4xx with the reason.

def _object_or_404(scene: FiberScene, object_id: str) -> Any:
    obj = scene.objects.get(object_id)
    if obj is None:
        raise FiberError(404, f"SceneObject {object_id} not found.")
    return obj


def require_fiber(scene: FiberScene, object_id: str) -> tuple[Any, list[dict]]:
    """The fibre and its effective nodes, or 404 / 422."""
    obj = _object_or_404(scene, object_id)
    nodes = resolve_effective_fiber_nodes(scene, obj)
    if not nodes or len(nodes) < 2:
        raise FiberError(422, (
            f"{obj.name} has no fibre spline to move: no properties.fiberNodes, no Component "
            "fiberNodes, and no fibre PhysicsElement with kindParams.endA / endB."
        ))
    for i, node in enumerate(nodes):
        if not isinstance(node, dict) or not isinstance(node.get("posMm"), list) or len(node["posMm"]) != 3:
            raise FiberError(422, f"{obj.name}: fibre node {i} has no [x, y, z] posMm.")
    return obj, nodes


def resolve_port_target(
    scene: FiberScene, own_object_id: str, target_object_id: str,
    anchor_name: str, anchor_id: str | None,
) -> dict:
    """The receptacle a request names — found the way the port sweep finds
    it (a female fibre ``connectorType`` on the target's binding tree),
    matched on ``anchor.name ?? anchor.id`` and, when given, the anchor id."""
    target = _object_or_404(scene, target_object_id)
    if target.id == own_object_id:
        raise FiberError(422, f"{target.name}: a part cannot be plugged into its own port.")
    ports = collect_fiber_ports_lab(scene, own_object_id, only_object_id=target.id)
    matches = [
        p for p in ports
        if p["targetAnchorName"] == anchor_name and (anchor_id is None or p["targetAnchorId"] == anchor_id)
    ]
    if not matches:
        have = ", ".join(f"{p['targetAnchorName']} ({p['targetAnchorId']})" for p in ports) or "none"
        raise FiberError(422, (
            f"{target.name} has no fibre port {anchor_name!r}"
            + (f" with id {anchor_id!r}" if anchor_id else "")
            + f" — a port is an anchor declaring a female fibre connectorType. Its fibre ports: {have}."
        ))
    if len(matches) > 1:
        raise FiberError(422, (
            f"{target.name} has {len(matches)} fibre ports named {anchor_name!r}; "
            "pass target.anchorId to pick one."
        ))
    return matches[0]


def _one_candidate(found: list[dict], unlimited: list[dict], what: str, tolerance_mm: float | None) -> dict:
    if found:
        return found[0]
    if unlimited:
        raise FiberError(422, (
            f"{what} is {unlimited[0]['distMm']:.3f} mm from the face, beyond toleranceMm={tolerance_mm}."
        ))
    raise FiberError(422, f"{what} gives no alignment (a zero-length beam segment or a port with no direction).")


def fiber_target_candidate(
    scene: FiberScene, object_id: str, end: str, target: dict, tolerance_mm: float | None,
) -> dict:
    """The candidate ``findFiberAlignmentCandidates`` would list for exactly
    this target: ``{"objectId", "anchorName", "anchorId"?}`` (a receptacle)
    or ``{"beam": BeamSegmentLab}``."""
    obj, nodes = require_fiber(scene, object_id)
    pose = object_pose(obj)
    tip = fiber_end_tip_mm(scene, obj, end)
    if "beam" in target:
        seg = target["beam"]
        if seg.get("sourceObjectId") == obj.id:
            raise FiberError(422, f"{obj.name}: a part never aligns onto a beam it emits itself.")

        def run(tol: float | None) -> list[dict]:
            return find_fiber_end_alignment_candidates(
                end=end, nodes=nodes, pose=pose, beam_segments=[seg], tolerance_mm=tol, tip_mm=tip,
            )
        return _one_candidate(run(tolerance_mm), run(None), f"Beam {seg.get('beamId')!r}", tolerance_mm)
    port = resolve_port_target(
        scene, obj.id, target["objectId"], target["anchorName"], target.get("anchorId"),
    )

    def run_port(tol: float | None) -> list[dict]:
        return find_fiber_port_alignment_candidates(
            end=end, nodes=nodes, pose=pose, ports=[port], tolerance_mm=tol, tip_mm=tip,
        )
    return _one_candidate(
        run_port(tolerance_mm), run_port(None),
        f"Port {port['targetName']} · {port['targetAnchorName']}", tolerance_mm,
    )


def require_pigtail(scene: FiberScene, object_id: str, end: str) -> tuple[Any, PigtailPort, dict]:
    """The instrument, its port connector for ``end`` and that face's lab
    pose, or 404 / 422."""
    obj = _object_or_404(scene, object_id)
    if scene.component_of(obj) is None:
        raise FiberError(422, f"{obj.name}: Component row not in the scene.")
    ref = pigtail_port(scene, obj, end)
    if ref is None:
        anchor = "intercept_in" if end == "A" else "intercept_out"
        raise FiberError(422, (
            f"{obj.name} has no pigtail connector for End {end} — a fiber_connector binding tagged "
            f"properties.portAnchor = {anchor!r}."
        ))
    port_lab = pigtail_port_lab(scene, obj, ref)
    if port_lab is None:
        raise FiberError(422, (
            f"{obj.name} End {end}: the connector's mating face ({ref.connect_in.get('id')}) has no "
            "axisX / axisY triad to align."
        ))
    return obj, ref, port_lab


def pigtail_target_candidate(
    scene: FiberScene, object_id: str, end: str, target: dict, tolerance_mm: float | None,
) -> dict:
    """The candidate ``findPigtailAlignmentCandidates`` would list for
    exactly this target."""
    obj, _ref, port_lab = require_pigtail(scene, object_id, end)
    if "beam" in target:
        seg = target["beam"]
        if seg.get("sourceObjectId") == obj.id:
            raise FiberError(422, f"{obj.name}: a part never aligns onto a beam it emits itself.")

        def run(tol: float | None) -> list[dict]:
            return find_pigtail_beam_candidates(port_lab=port_lab, beam_segments=[seg], tolerance_mm=tol)
        return _one_candidate(run(tolerance_mm), run(None), f"Beam {seg.get('beamId')!r}", tolerance_mm)
    port = resolve_port_target(
        scene, obj.id, target["objectId"], target["anchorName"], target.get("anchorId"),
    )

    def run_port(tol: float | None) -> list[dict]:
        return find_pigtail_port_candidates(end=end, port_lab=port_lab, ports=[port], tolerance_mm=tol)
    return _one_candidate(
        run_port(tolerance_mm), run_port(None),
        f"Port {port['targetName']} · {port['targetAnchorName']}", tolerance_mm,
    )
