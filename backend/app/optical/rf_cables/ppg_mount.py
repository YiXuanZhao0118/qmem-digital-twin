"""Where a Programmable Pulse Generator sits when it is plugged into a port —
port of ``frontend/src/utils/ppgMounting.ts``
(``computePpgMountedThreePose``).

A PPG plugs straight into an instrument's coax port: its own ``rf_out``
anchor lands on the target anchor, facing into it, then backs off by the
PPG's plug protrusion (``defaultParams.matingProtrusionMm``) so the plug's
TIP, not the anchor, meets the port face. Both plugs are posed through their
binding chains (:func:`ports.port_poses`) — each in its owner's Component
CAD frame — not read in their own asset's frame (exact only on an identity
root binding; until 2026-09-22).

The web app re-derives this pose at render time and never stores it; the
backend stores it as the PPG's SceneObject pose (on attach and on a resnap),
so a client that reads stored poses sees the PPG on its port. The result is
converted the way the web converts a three pose back to a SceneObject pose:
position ``threeToLabMm``, rotation ``sceneObjectEulerFromQuaternion``.

Transcribed with the three.js primitives in :mod:`app.optical.align.ts_compat`
(``setFromUnitVectors``' anti-parallel branch picks WHICH 180 deg turn — a
different axis is a different pose). Pinned by the ``ppgMount`` cases in
``backend/tests/fixtures/rf_cables/pure.json``.
"""

from __future__ import annotations

import math
from typing import Any

from app.optical.align.anchor_poses import anchor_display_name
from app.optical.align.frames import AlignPose, scene_object_euler_from_quaternion, scene_object_to_quaternion
from app.optical.align.ts_compat import V, q_from_unit_vectors, v3_apply_quaternion, v3_normalize
from app.optical.rf_cables.geometry import js_truthy, pose_of
from app.optical.rf_cables.ports import (
    PortPose,
    RfScene,
    find_port_pose,
    port_poses,
    ppg_attachment_of,
    primary_asset,
    props_of,
)

MM_PER_THREE_UNIT = 100


def mating_protrusion_mm(asset: Any) -> float:
    """``matingProtrusionMm``: a positive finite number, else 0."""
    dp = asset.default_params if asset is not None and isinstance(asset.default_params, dict) else {}
    raw = dp.get("matingProtrusionMm")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.0
    return float(raw) if math.isfinite(raw) and raw > 0 else 0.0


def _three_pos(port: PortPose) -> V:
    """``portPosThree``: CAD mm -> three units (``mmToThree`` = /100)."""
    p = port.pos_cad
    return V(p.x / MM_PER_THREE_UNIT, p.y / MM_PER_THREE_UNIT, p.z / MM_PER_THREE_UNIT)


def _three_dir(port: PortPose) -> V:
    """``portDirThree``: the posed outward direction, normalised."""
    return v3_normalize(port.dir_cad)


def _mating_peer(scene: RfScene, ppg: Any) -> dict | None:
    """``findMatingPort``: the attachment record, else (legacy scenes) the
    far end of an rf_cable wired to the PPG."""
    att = ppg_attachment_of(ppg)
    if att is not None:
        return att
    ppg_id = str(ppg.id)
    for obj in scene.objects:
        if scene.kind_of(str(obj.id)) != "rf_cable":
            continue
        eps = props_of(obj).get("rfCableEndpoints")
        if not isinstance(eps, dict):
            continue
        a, b = eps.get("A"), eps.get("B")
        if isinstance(a, dict) and a.get("targetObjectId") == ppg_id and js_truthy(b):
            return b if isinstance(b, dict) else {}
        if isinstance(b, dict) and b.get("targetObjectId") == ppg_id and js_truthy(a):
            return a if isinstance(a, dict) else {}
    return None


def _target_anchor(scene: RfScene, peer: dict) -> tuple[Any, PortPose] | None:
    """``ppgMounting.findAnchor``: the target's port anywhere in its binding
    tree, so a multi-root instrument such as the EOM mounts its PPG too,
    posed through its binding chain (``resolveRfPortPose``)."""
    obj = scene.object_by_id.get(str(peer.get("targetObjectId")))
    if obj is None:
        return None
    placed = find_port_pose(scene, obj, peer.get("targetAnchorId"), peer.get("targetAnchorName"))
    return (obj, placed) if placed is not None else None


def compute_ppg_mounted_pose(
    scene: RfScene, ppg: Any, ppg_component: Any, peer: dict | None = None,
) -> AlignPose | None:
    """The PPG SceneObject pose that mates its ``rf_out`` onto its peer port,
    or ``None`` when the PPG asset has no ``rf_out``, the PPG is plugged into
    nothing, or the peer anchor does not resolve (the web then draws the
    stored pose). ``peer`` overrides the PPG's own record (the attach flow
    computes the pose before the row exists)."""
    ppg_asset = primary_asset(scene, ppg_component) if ppg_component is not None else None
    if ppg_asset is None or not isinstance(ppg_asset.anchors, list):
        return None
    ppg_anchor = next((a for a in ppg_asset.anchors if isinstance(a, dict) and a.get("id") == "rf_out"), None)
    if ppg_anchor is None:
        return None
    # The PPG's own plug, posed in ITS Component CAD frame through its binding
    # chain (the instance's, or the catalog's before the row exists) — the
    # frame the PPG's tree is drawn and traced in under this pose. None when
    # the instance's tree no longer holds that anchor of that asset (a swap).
    ppg_name = anchor_display_name(ppg_anchor)
    ppg_port = next(
        (
            p for p in port_poses(scene, ppg_component, ppg)
            if p.asset_id == str(ppg_asset.id) and p.anchor_id == "rf_out" and p.anchor_name == ppg_name
        ),
        None,
    )
    if ppg_port is None:
        return None
    if peer is None:
        peer = _mating_peer(scene, ppg)
    if peer is None:
        return None
    resolved = _target_anchor(scene, peer)
    if resolved is None:
        return None
    target_obj, target_anchor = resolved

    # targetAnchorLabPose
    q_target = scene_object_to_quaternion(pose_of(target_obj))
    origin = V(
        float(target_obj.x_mm) / MM_PER_THREE_UNIT,
        float(target_obj.y_mm) / MM_PER_THREE_UNIT,
        float(target_obj.z_mm) / MM_PER_THREE_UNIT,
    )
    p = v3_apply_quaternion(_three_pos(target_anchor), q_target)
    pos_lab = V(p.x + origin.x, p.y + origin.y, p.z + origin.z)
    dir_lab = v3_normalize(v3_apply_quaternion(_three_dir(target_anchor), q_target))

    mating = v3_normalize(V(-dir_lab.x, -dir_lab.y, -dir_lab.z))
    quat = q_from_unit_vectors(_three_dir(ppg_port), mating)
    back = mating_protrusion_mm(ppg_asset) / MM_PER_THREE_UNIT
    r = v3_apply_quaternion(_three_pos(ppg_port), quat)
    position = V(
        (pos_lab.x - r.x) - mating.x * back,
        (pos_lab.y - r.y) - mating.y * back,
        (pos_lab.z - r.z) - mating.z * back,
    )
    rx, ry, rz = scene_object_euler_from_quaternion(quat)
    return AlignPose(
        x_mm=position.x * MM_PER_THREE_UNIT,
        y_mm=position.y * MM_PER_THREE_UNIT,
        z_mm=position.z * MM_PER_THREE_UNIT,
        rx_deg=rx, ry_deg=ry, rz_deg=rz,
    )
