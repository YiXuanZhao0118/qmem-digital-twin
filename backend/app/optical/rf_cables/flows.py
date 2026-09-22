"""The web's RF-cable / PPG store flows as pure plans over an :class:`RfScene`.

Each ``plan_*`` answers "what would the web app write?" without touching
the DB; :mod:`.service` applies the answer in one transaction. Ports of
``store/sceneStore.ts``:

=========================  ==================================================
``plan_connect``           ``createRfCableBetweenPorts`` behind the RF Link
                           panel's drop gate (``RfLinkPanel.tsx`` :1525)
``plan_resnap``            ``resnapRfCablesLinkedTo``
``align_candidates``       ``findRfCableAlignmentCandidates``
``plan_align``             ``applyRfCableAlignmentCandidate`` on one of them
``plan_delete_objects``    ``deleteObjects``' cascade (cable -> dangling
                           cables, instrument -> plugged-in PPGs, legacy
                           orphan PPGs)
``plan_ppg_attach``        ``createPpgAtPort`` + ``createProgrammablePulse
                           Generator`` behind ``canSpawnPpgHere`` (:1910)
``plan_ppg_mounts``        backend addition — the mounted pose of every PPG a
                           resnap touches (the web re-derives it at render)
=========================  ==================================================

A rule the web refuses raises :class:`RuleError` with a stable ``code``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.optical.align.frames import AlignPose
from app.optical.pose import V3Pose
from app.optical.rf_cables.geometry import (
    CABLE_KIND_IDS,
    AlignmentCandidate,
    RfPortLab,
    T3,
    body_dir_to_lab,
    body_to_lab,
    build_rf_cable_alignment_props,
    cable_nodes,
    connector_tip_mm_from_anchors,
    find_rf_cable_endpoint_alignment_candidates,
    js_truthy,
    pose_of,
    resolve_linked_rf_cable_endpoint,
)
from app.optical.rf_cables.ports import (
    PPG_KIND,
    PanelPort,
    RfScene,
    anchor_name,
    anchor_pos,
    anchors_in_binding_tree,
    cable_end_connector_asset,
    cable_end_family,
    find_anchor_in_binding_tree,
    occupied_port_keys,
    panel_ports_of,
    ppg_attachments,
    primary_asset,
    primary_dir,
    props_of,
)
from app.optical.rf_cables.ppg_mount import compute_ppg_mounted_pose


class RuleError(Exception):
    """A request the web app would refuse. ``code`` is stable (clients may
    branch on it); ``status`` is the HTTP status the router answers with."""

    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class PortRef:
    """A port as a request names it: the object plus ``anchor.name ?? anchor.id``
    (``anchor_id`` disambiguates two anchors sharing a name)."""

    object_id: str
    anchor_name: str
    anchor_id: str | None = None


def _v3(v: Any) -> T3:
    return (float(v.x), float(v.y), float(v.z))


def _pose_json(p: V3Pose | AlignPose) -> dict:
    return {"xMm": p.x_mm, "yMm": p.y_mm, "zMm": p.z_mm, "rxDeg": p.rx_deg, "ryDeg": p.ry_deg, "rzDeg": p.rz_deg}


def find_port(scene: RfScene, ref: PortRef) -> PanelPort:
    """The panel port a request names; 404 / 422 when there is none."""
    obj = scene.object_by_id.get(ref.object_id)
    if obj is None:
        raise RuleError("object_not_found", f"SceneObject {ref.object_id} not found.", 404)
    hits = [
        p for p in panel_ports_of(scene, ref.object_id)
        if p.anchor_name == ref.anchor_name and (ref.anchor_id is None or p.anchor_id == ref.anchor_id)
    ]
    if not hits:
        raise RuleError(
            "port_not_found",
            f"{obj.name} has no RF Link port {ref.anchor_name!r}"
            + (f" (anchor {ref.anchor_id!r})" if ref.anchor_id else "") + ".",
        )
    if len(hits) > 1:
        raise RuleError(
            "ambiguous_port",
            f"{obj.name} has several ports named {ref.anchor_name!r} "
            f"({', '.join(p.anchor_id for p in hits)}); name the anchorId.",
        )
    return hits[0]


def _busy_error(scene: RfScene, port: PanelPort) -> RuleError:
    name = scene.object_by_id[port.object_id].name
    return RuleError("port_busy", f"{name} · {port.anchor_name} already has a cable or PPG on it.", 409)


# ─── connect ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class ConnectPlan:
    component_id: str
    swapped: bool
    pose: V3Pose
    properties: dict


def connect_gate(scene: RfScene, a: PortRef, b: PortRef) -> tuple[PanelPort, PanelPort]:
    """The RF Link panel's drop gate (``RfLinkPanel.tsx`` :1525-1534), in a
    fixed order, plus the busy SOURCE port the panel's cursor refuses but its
    pointer-down does not. Returns ``(src, tgt)`` with the OUT port as src,
    which is how the panel calls the store (:1535)."""
    pa = find_port(scene, a)
    pb = find_port(scene, b)
    if pa.object_id == pb.object_id:
        raise RuleError("same_object", "Both ports are on the same object.")
    if pa.role == pb.role:
        raise RuleError("role_mismatch", f"Both ports are {pa.role}puts; a cable joins an output to an input.")
    if not pa.connector_family or not pb.connector_family:
        missing = pa if not pa.connector_family else pb
        raise RuleError(
            "connector_undefined",
            f"{scene.object_by_id[missing.object_id].name} · {missing.anchor_name} declares no SMA/BNC connectorType.",
        )
    if pa.domain != pb.domain:
        raise RuleError("domain_mismatch", f"Signal domains differ ({pa.domain} vs {pb.domain}).")
    occupied = occupied_port_keys(scene)
    for p in (pa, pb):
        if p.key in occupied:
            raise _busy_error(scene, p)
    return (pa, pb) if pa.role == "out" else (pb, pa)


def plan_connect(scene: RfScene, a: PortRef, b: PortRef) -> ConnectPlan:
    """``createRfCableBetweenPorts``: pick the catalog cable whose end A / B
    connector families match (direct, else A/B swapped, else the first
    rf_cable), place it at the two ports' midpoint with identity rotation,
    and mate each end's connector face onto its port."""
    src, tgt = connect_gate(scene, a, b)

    def resolve(port: PanelPort) -> tuple[Any, dict, T3]:
        obj = scene.object_by_id[port.object_id]
        comp = scene.component_of(obj)
        owned = find_anchor_in_binding_tree(scene, comp, port.anchor_id, port.anchor_name)
        assert owned is not None, "a panel port is always in its own binding tree"
        _, anchor = owned
        pos = anchor_pos(anchor)
        pos_body: T3 = _v3(pos) if pos is not None else (0.0, 0.0, 0.0)
        return obj, anchor, pos_body

    src_obj, src_anchor, src_pos = resolve(src)
    tgt_obj, tgt_anchor, tgt_pos = resolve(tgt)

    rf_cables = [c for c in scene.components if c.kind_id in CABLE_KIND_IDS and not getattr(c, "archived_at", None)]
    s_fam, t_fam = src.connector_family, tgt.connector_family
    pick: tuple[Any, bool] | None = None
    for c in rf_cables:
        if cable_end_family(scene, c, "endAConnector") == s_fam and cable_end_family(scene, c, "endBConnector") == t_fam:
            pick = (c, False)
            break
    if pick is None:
        for c in rf_cables:
            if cable_end_family(scene, c, "endAConnector") == t_fam and cable_end_family(scene, c, "endBConnector") == s_fam:
                pick = (c, True)
                break
    if pick is None:
        fallback = rf_cables[0] if rf_cables else None
        if fallback is None:
            fallback = next((c for c in scene.components if c.kind_id == "rf_cable"), None)
        if fallback is None:
            fallback = next((c for c in scene.components if c.kind_id == "sma_cable"), None)
        if fallback is None:
            raise RuleError("no_cable_component", "The catalog has no rf_cable Component to create.")
        pick = (fallback, False)
    cable_comp, swapped = pick

    src_lab = body_to_lab(src_pos, pose_of(src_obj))
    tgt_lab = body_to_lab(tgt_pos, pose_of(tgt_obj))
    cable_pose = V3Pose(
        x_mm=(src_lab[0] + tgt_lab[0]) / 2,
        y_mm=(src_lab[1] + tgt_lab[1]) / 2,
        z_mm=(src_lab[2] + tgt_lab[2]) / 2,
    )

    def tip(end: str) -> float:
        conn = cable_end_connector_asset(scene, str(cable_comp.id), end)
        return connector_tip_mm_from_anchors(conn.anchors if conn is not None else None, None)

    properties: dict = {}
    ends = (("A", tgt, tgt_obj, tgt_anchor, tgt_pos), ("B", src, src_obj, src_anchor, src_pos)) if swapped else (
        ("A", src, src_obj, src_anchor, src_pos), ("B", tgt, tgt_obj, tgt_anchor, tgt_pos))
    for end, port, obj, anchor, pos in ends:
        d = primary_dir(anchor)
        linked = resolve_linked_rf_cable_endpoint(
            cable_pose=cable_pose,
            target_pose=pose_of(obj),
            target_anchor_pos_body_mm=pos,
            target_anchor_dir_body=_v3(d) if d is not None else (1.0, 0.0, 0.0),
            connector_tip_mm=tip(end),
        )
        if linked is None:
            continue  # a degenerate port direction leaves that end unlinked, as in the TS
        properties = build_rf_cable_alignment_props(
            properties, cable_comp.properties, end,
            new_pos_mm_body=linked.pos_mm_body, new_handle_mm_body=linked.handle_mm_body,
            target_object_id=port.object_id, target_anchor_id=port.anchor_id,
            target_anchor_name=port.anchor_name,
        )
    return ConnectPlan(component_id=str(cable_comp.id), swapped=swapped, pose=cable_pose, properties=properties)


# ─── resnap ─────────────────────────────────────────────────────────────────

def plan_resnap(scene: RfScene, moved_object_ids: list[str]) -> dict[str, dict]:
    """``resnapRfCablesLinkedTo``: for every cable end linked to a moved
    object, the re-mated node (the connect math, with the bound connector's
    own tip), folded into one properties dict per cable. ``{cable id:
    properties}`` in scene order; ends whose link no longer resolves are
    left alone."""
    moved = set(moved_object_ids)
    out: dict[str, dict] = {}
    if not moved:
        return out
    for cable in scene.objects:
        comp = scene.component_of(cable)
        if comp is None or comp.kind_id not in CABLE_KIND_IDS:
            continue
        endpoints = props_of(cable).get("rfCableEndpoints")
        if not js_truthy(endpoints):
            continue
        for end in ("A", "B"):
            link = endpoints.get(end) if isinstance(endpoints, dict) else None
            if not js_truthy(link) or not isinstance(link, dict) or link.get("targetObjectId") not in moved:
                continue
            target = scene.object_by_id.get(str(link["targetObjectId"]))
            if target is None:
                continue
            target_comp = scene.component_of(target)
            if target_comp is None:
                continue
            owned = find_anchor_in_binding_tree(
                scene, target_comp, link.get("targetAnchorId"), link.get("targetAnchorName"),
            )
            if owned is None:
                continue
            _, anchor = owned
            d = primary_dir(anchor)
            pos = anchor_pos(anchor)
            conn = cable_end_connector_asset(scene, str(comp.id), end)
            linked = resolve_linked_rf_cable_endpoint(
                cable_pose=pose_of(cable),
                target_pose=pose_of(target),
                target_anchor_pos_body_mm=_v3(pos) if pos is not None else (0.0, 0.0, 0.0),
                target_anchor_dir_body=_v3(d) if d is not None else (1.0, 0.0, 0.0),
                connector_tip_mm=connector_tip_mm_from_anchors(conn.anchors if conn is not None else None, None),
            )
            if linked is None:
                continue
            cid = str(cable.id)
            out[cid] = build_rf_cable_alignment_props(
                out.get(cid, cable.properties), comp.properties, end,
                new_pos_mm_body=linked.pos_mm_body, new_handle_mm_body=linked.handle_mm_body,
                target_object_id=link.get("targetObjectId"), target_anchor_id=link.get("targetAnchorId"),
                target_anchor_name=link.get("targetAnchorName"),
            )
    return out


def plan_ppg_mounts(scene: RfScene, moved_object_ids: list[str]) -> dict[str, AlignPose | None]:
    """The mounted pose of every PPG plugged into a moved object, or moved
    itself (``None`` when the mount does not resolve). Not a web flow: the
    web re-derives the mount at render time, so persisting it is what keeps
    a stored-pose client (Blender) in step. Same math as the attach."""
    moved = set(moved_object_ids)
    out: dict[str, AlignPose | None] = {}
    for ppg, att in ppg_attachments(scene):
        if att["targetObjectId"] not in moved and str(ppg.id) not in moved:
            continue
        out[str(ppg.id)] = compute_ppg_mounted_pose(scene, ppg, scene.component_of(ppg))
    return out


# ─── align ──────────────────────────────────────────────────────────────────

def cable_row(scene: RfScene, cable_id: str) -> tuple[Any, Any]:
    """The cable SceneObject and its Component; 404 / 422 otherwise."""
    cable = scene.object_by_id.get(cable_id)
    if cable is None:
        raise RuleError("object_not_found", f"SceneObject {cable_id} not found.", 404)
    comp = scene.component_of(cable)
    if comp is None or comp.kind_id not in CABLE_KIND_IDS:
        raise RuleError("not_an_rf_cable", f"{cable.name} is not an rf_cable.")
    return cable, comp


def align_candidates(scene: RfScene, cable_id: str, end: str, tolerance_mm: float) -> list[AlignmentCandidate]:
    """``findRfCableAlignmentCandidates``: every ``rf_in`` / ``rf_out`` anchor
    on any OTHER object's binding tree within ``tolerance_mm`` of this end,
    nearest first, measured and mated with the end's bound connector length
    (as connect and resnap)."""
    cable, comp = cable_row(scene, cable_id)
    nodes = cable_nodes(cable.properties, comp.properties)
    ports: list[RfPortLab] = []
    for other in scene.objects:
        if str(other.id) == cable_id:
            continue
        other_comp = scene.component_of(other)
        if other_comp is None:
            continue
        pose = pose_of(other)
        for _, a in anchors_in_binding_tree(scene, other_comp):
            if a.get("id") not in ("rf_in", "rf_out"):
                continue
            pos = anchor_pos(a)
            if pos is None:
                continue
            d = primary_dir(a)
            ports.append(RfPortLab(
                lab_pos_mm=body_to_lab(_v3(pos), pose),
                lab_dir_outward=body_dir_to_lab(_v3(d) if d is not None else (1.0, 0.0, 0.0), pose),
                target_name=other.name,
                target_object_id=str(other.id),
                target_anchor_name=anchor_name(a),
                target_anchor_id=a["id"],
            ))
    if not ports:
        return []
    conn = cable_end_connector_asset(scene, str(comp.id), end)
    return find_rf_cable_endpoint_alignment_candidates(
        endpoint=end, cable_pose=pose_of(cable), cable_nodes=nodes, ports=ports, tolerance_mm=tolerance_mm,
        connector_tip_mm=connector_tip_mm_from_anchors(conn.anchors if conn is not None else None, None),
    )


def plan_align(scene: RfScene, cable_id: str, end: str, target: PortRef, tolerance_mm: float) -> dict:
    """``applyRfCableAlignmentCandidate`` with the candidate for ``target``
    (the nearest one when two share a name and no anchorId is given). 422
    when that port is not within ``tolerance_mm``."""
    cable, comp = cable_row(scene, cable_id)
    for cand in align_candidates(scene, cable_id, end, tolerance_mm):
        if cand.target_object_id != target.object_id or cand.target_anchor_name != target.anchor_name:
            continue
        if target.anchor_id is not None and cand.target_anchor_id != target.anchor_id:
            continue
        return build_rf_cable_alignment_props(
            cable.properties, comp.properties, end,
            new_pos_mm_body=cand.new_pos_mm_body, new_handle_mm_body=cand.new_handle_mm_body,
            target_object_id=cand.target_object_id, target_anchor_id=cand.target_anchor_id,
            target_anchor_name=cand.target_anchor_name,
        )
    raise RuleError(
        "target_not_in_range",
        f"{target.anchor_name} on {target.object_id} is not an rf_in / rf_out port within "
        f"{tolerance_mm} mm of end {end}.",
    )


# ─── delete ─────────────────────────────────────────────────────────────────

def _target_of(link: Any) -> str | None:
    """``link?.targetObjectId`` — only a string can name a doomed object."""
    v = link.get("targetObjectId") if isinstance(link, dict) else None
    return v if isinstance(v, str) else None


def plan_delete_objects(scene: RfScene, object_ids: list[str]) -> list[str]:
    """``deleteObjects``' doomed set, in the order the web issues the
    DELETEs: the requested (unlocked) objects, then every object whose
    ``rfCableEndpoints`` points at a doomed one (one pass, scene order),
    every PPG plugged into a doomed object, and every LEGACY PPG whose
    cables are all doomed."""
    to_delete: list[str] = []
    seen: set[str] = set()
    for oid in object_ids:
        if oid in seen:
            continue
        seen.add(oid)
        target = scene.object_by_id.get(oid)
        if target is not None and not target.locked:
            to_delete.append(oid)
    if not to_delete:
        return []
    doomed = set(to_delete)
    for obj in scene.objects:
        oid = str(obj.id)
        if oid in doomed:
            continue
        eps = props_of(obj).get("rfCableEndpoints")
        if not js_truthy(eps):
            continue
        a_target = _target_of(eps.get("A")) if isinstance(eps, dict) else None
        b_target = _target_of(eps.get("B")) if isinstance(eps, dict) else None
        if (js_truthy(a_target) and a_target in doomed) or (js_truthy(b_target) and b_target in doomed):
            to_delete.append(oid)
            doomed.add(oid)
    # `ppgsAttachedTo` is evaluated once, against the set as it stands here.
    attached = [str(ppg.id) for ppg, att in ppg_attachments(scene) if att["targetObjectId"] in doomed]
    for ppg_id in attached:
        if ppg_id in doomed:
            continue
        to_delete.append(ppg_id)
        doomed.add(ppg_id)
    pe_by_object: dict[str, Any] = {}
    for pe in scene.physics_elements:
        pe_by_object[str(pe.object_id)] = pe  # a Map built in a loop: last wins
    cables_per_ppg: dict[str, list[str]] = {}
    for obj in scene.objects:
        pe = pe_by_object.get(str(obj.id))
        if pe is None or pe.element_kind != "rf_cable":
            continue
        eps = props_of(obj).get("rfCableEndpoints")
        for end in ("A", "B"):
            target_id = _target_of(eps.get(end)) if isinstance(eps, dict) else None
            if not js_truthy(target_id):
                continue
            target_pe = pe_by_object.get(str(target_id))
            if target_pe is None or target_pe.element_kind != PPG_KIND:
                continue
            cables_per_ppg.setdefault(str(target_id), []).append(str(obj.id))
    for obj in scene.objects:
        oid = str(obj.id)
        if oid in doomed:
            continue
        pe = pe_by_object.get(oid)
        if pe is None or pe.element_kind != PPG_KIND:
            continue
        cables = cables_per_ppg.get(oid, [])
        if not cables:
            continue  # a cable-less PPG lives by its attachment, not by cables
        if all(c in doomed for c in cables):
            to_delete.append(oid)
            doomed.add(oid)
    return to_delete


def disconnect_link(scene: RfScene, cable_id: str, end: str) -> Any:
    """``clearRfCableEndpointLink``'s precondition: the link record on this
    end, or ``None`` when there is none (then the web does nothing — a
    destructive action only on a fact positively established)."""
    cable, _ = cable_row(scene, cable_id)
    eps = props_of(cable).get("rfCableEndpoints")
    link = eps.get(end) if isinstance(eps, dict) else None
    return link if js_truthy(link) else None


def timing_programs_of(scene: RfScene, object_ids: list[str]) -> list[str]:
    """The TimingProgram ids bound to the PPGs among ``object_ids``
    (``kindParams.timingProgramId``) — what deleting them cascades to."""
    out: list[str] = []
    for oid in object_ids:
        pe = scene.pe_by_object.get(oid)
        if pe is None or pe.element_kind != PPG_KIND:
            continue
        tp = (pe.kind_params or {}).get("timingProgramId")
        if isinstance(tp, str) and tp:
            out.append(tp)
    return out


# ─── PPG attach ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PpgAttachPlan:
    component_id: str
    name: str
    program_name: str
    connector_type: str
    attachment: dict
    mounted_pose: AlignPose


def ppg_gate(scene: RfScene, ref: PortRef) -> PanelPort:
    """``RfLinkPanel.canSpawnPpgHere`` (:1910): an empty ``ttl_in`` /
    ``trigger_in`` with a defined SMA/BNC connector."""
    port = find_port(scene, ref)
    if port.role != "in" or port.domain not in ("ttl", "trigger"):
        raise RuleError(
            "not_a_gate_input",
            f"{port.anchor_name} is a {port.domain} {port.role}put; a PPG plugs into a ttl_in / trigger_in.",
        )
    if not port.connector_family:
        raise RuleError(
            "connector_undefined",
            f"{scene.object_by_id[port.object_id].name} · {port.anchor_name} declares no SMA/BNC connectorType.",
        )
    if port.key in occupied_port_keys(scene):
        raise _busy_error(scene, port)
    return port


def ppg_has_usable_asset(scene: RfScene, component: Any) -> bool:
    """``ppgHasUsableAsset``: a primary asset carrying an ``rf_out``."""
    asset = primary_asset(scene, component)
    return (
        asset is not None and isinstance(asset.anchors, list)
        and any(isinstance(a, dict) and a.get("id") == "rf_out" for a in asset.anchors)
    )


def plan_ppg_attach(scene: RfScene, ref: PortRef) -> PpgAttachPlan:
    """``createPpgAtPort`` + ``createProgrammablePulseGenerator``: the first
    PPG catalog Component whose ``connectorType`` equals the port's family
    and that has a usable asset, named ``CH<number of PPGs>`` (object and
    TimingProgram alike), attached to the port, at its mounted pose."""
    port = ppg_gate(scene, ref)
    family = port.connector_family
    ppg_count = sum(1 for pe in scene.physics_elements if pe.element_kind == PPG_KIND)
    name = f"CH{ppg_count}"
    component = next(
        (
            c for c in scene.components
            if c.kind_id == PPG_KIND and props_of(c).get("connectorType") == family and ppg_has_usable_asset(scene, c)
        ),
        None,
    )
    if component is None:
        raise RuleError(
            "no_ppg_component",
            f"No Programmable Pulse Generator catalog Component with connectorType {family!r} "
            "and an asset carrying rf_out.",
        )
    attachment = {
        "targetObjectId": port.object_id,
        "targetAnchorId": port.anchor_id,
        "targetAnchorName": port.anchor_name,
    }
    mounted = compute_ppg_mounted_pose(scene, None, component, peer=attachment)
    # The gate found this port in the target's binding tree and the component
    # has an rf_out on its primary asset: the mount resolves the same anchor.
    assert mounted is not None
    return PpgAttachPlan(
        component_id=str(component.id), name=name, program_name=name, connector_type=family,
        attachment=attachment, mounted_pose=mounted,
    )


def ppg_kind_params(connector_type: str, timing_program_id: str) -> dict:
    """The PhysicsElement ``kindParams`` ``createProgrammablePulseGenerator``
    writes (before the schema normalises them)."""
    return {
        "connectorType": connector_type,
        "timingProgramId": timing_program_id,
        "outputDomain": "rfout",
        "highVoltageV": 3.2,
    }


def pose_json(p: V3Pose | AlignPose | None) -> dict | None:
    return None if p is None else _pose_json(p)
