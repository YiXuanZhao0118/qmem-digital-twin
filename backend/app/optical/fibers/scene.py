"""The scene slice the fibre / pigtail flows read, and the lookups over it.

Rows are DETACHED copies (``SimpleNamespace``, every id a ``str``) so a flow
can apply one write and let the next step read it — ``resnap`` touches End A
then End B of one cable exactly as the web store does, each step seeing the
previous one — without the ORM tracking anything. The router copies what a
flow changed back onto real rows and commits once.

Lookups ported here, each from the web store:

* :func:`resolve_effective_fiber_nodes` — ``sceneStore.resolveEffectiveFiberNodes``.
* :func:`fiber_end_tip_mm` — ``sceneStore.fiberEndConnectorTipMm``, but
  measured with the loader's own ``_connector_tip_and_aperture`` so the face
  mated here is the face the solver couples through.
* :func:`collect_fiber_ports_lab` — ``sceneStore.collectFiberPortsLab``: the
  binding tree + the SceneObject pose, the chain the tracer places a port
  with (on both sides since 2026-09-22).
* :func:`pigtail_port_bindings` — ``componentBindings.pigtailPortBindings``.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    Asset3D,
    Component,
    ComponentBinding,
    ObjectBinding,
    PhysicsElement,
    SceneObject,
)
from app.optical.align.anchor_poses import (
    AlignScene,
    AnchorPoseLab,
    resolve_anchor_poses_lab,
)
from app.optical.db_scene_loader import _connector_tip_and_aperture
from app.optical.fibers.geometry import (
    FIBER_FERRULE_TIP_MM,
    is_fiber_port_connector_type,
    sync_fiber_nodes_from_kind_params,
)
from app.optical.fibers.pigtail import BindingPose, compose_binding_poses

# ``utils/connectorAnchors`` — both spellings of a connector's two anchors, the
# fibre one (alembic 0135) preferred BY ID. Same tuples as the loader's
# ``_MATING_FACE_IDS`` / ``_CABLE_ROOT_IDS``.
MATING_FACE_IDS = ("fiber_out", "connect_in")
CABLE_ROOT_IDS = ("fiber_root", "connect_out")


@dataclass
class FiberScene(AlignScene):
    """:class:`AlignScene` plus what the fibre flows also read.

    ``object_order`` is the order the objects came from the DB (the order
    ``GET /api/scene`` hands the web store, which only matters for ties).
    ``physics_elements`` is keyed by object id. ``object_bindings`` rows carry
    ``id`` / ``properties`` too, because a pigtail align upserts them."""

    object_order: list[str] = field(default_factory=list)
    physics_elements: dict[str, Any] = field(default_factory=dict)


# ─── loading ───────────────────────────────────────────────────────────────

def _copy(row: Any, cols: tuple[str, ...], ids: tuple[str, ...] = ()) -> SimpleNamespace:
    out = SimpleNamespace(**{c: getattr(row, c) for c in cols})
    for c in ids:
        v = getattr(out, c)
        setattr(out, c, None if v is None else str(v))
    return out


_OBJ_COLS = ("id", "name", "component_id", "x_mm", "y_mm", "z_mm", "rx_deg", "ry_deg",
             "rz_deg", "locked", "properties", "dynamic_sources")
_COMP_COLS = ("id", "name", "kind_id", "asset_3d_id", "properties")
_BIND_COLS = ("id", "component_id", "parent_binding_id", "target_kind", "asset_3d_id",
              "sub_component_id", "role", "local_x_mm", "local_y_mm", "local_z_mm",
              "local_rx_deg", "local_ry_deg", "local_rz_deg", "properties", "sort_order")
_OB_COLS = ("id", "object_id", "component_binding_id", "local_x_mm_delta", "local_y_mm_delta",
            "local_z_mm_delta", "local_rx_deg_delta", "local_ry_deg_delta", "local_rz_deg_delta",
            "asset_3d_id_override", "properties")
_ASSET_COLS = ("id", "name", "kind_id", "anchors", "default_params")
_PE_COLS = ("id", "object_id", "element_kind", "kind_params")


async def load_fiber_scene(session: AsyncSession) -> FiberScene:
    """One read of everything the flows touch (SELECTs only). Bindings come
    in ``GET /api/scene`` order and archived Components are left out, as in
    ``align.service.load_align_scene``."""
    objects = (await session.scalars(select(SceneObject))).all()
    components = (await session.scalars(
        select(Component).where(Component.archived_at.is_(None))
    )).all()
    bindings = (await session.scalars(
        select(ComponentBinding).order_by(
            ComponentBinding.component_id,
            ComponentBinding.sort_order,
            ComponentBinding.created_at,
        )
    )).all()
    object_bindings = (await session.scalars(
        select(ObjectBinding).order_by(ObjectBinding.created_at)
    )).all()
    assets = (await session.scalars(select(Asset3D))).all()
    pes = (await session.scalars(select(PhysicsElement))).all()

    by_component: dict[str, list[Any]] = {}
    for b in bindings:
        row = _copy(b, _BIND_COLS, ("id", "component_id", "parent_binding_id", "asset_3d_id",
                                    "sub_component_id"))
        row.properties = dict(row.properties or {})
        by_component.setdefault(row.component_id, []).append(row)
    ob_by_object: dict[str, dict[str, Any]] = {}
    for ob in object_bindings:
        row = _copy(ob, _OB_COLS, ("id", "object_id", "component_binding_id", "asset_3d_id_override"))
        row.properties = dict(row.properties or {})
        ob_by_object.setdefault(row.object_id, {})[row.component_binding_id] = row
    objs = {}
    order = []
    for o in objects:
        row = _copy(o, _OBJ_COLS, ("id", "component_id"))
        row.properties = dict(row.properties or {})
        objs[row.id] = row
        order.append(row.id)
    return FiberScene(
        objects=objs,
        components={
            str(c.id): _copy(c, _COMP_COLS, ("id", "asset_3d_id")) for c in components
        },
        bindings_by_component=by_component,
        object_bindings=ob_by_object,
        assets={str(a.id): _copy(a, _ASSET_COLS, ("id",)) for a in assets},
        object_order=order,
        physics_elements={
            str(pe.object_id): _copy(pe, _PE_COLS, ("id", "object_id")) for pe in pes
        },
    )


# ─── small readers ─────────────────────────────────────────────────────────

def norm_id(value: str) -> str:
    """A UUID in the canonical lower-case form the scene is keyed by (any
    other string unchanged, so it simply finds nothing)."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        return str(value)


def props_of(row: Any) -> dict:
    p = getattr(row, "properties", None)
    return p if isinstance(p, dict) else {}


def js_falsy(v: Any) -> bool:
    """JS ``!v`` — an empty dict / list is TRUTHY, unlike Python."""
    if v is None or v is False:
        return True
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v == 0 or v != v
    return isinstance(v, str) and v == ""


def find_anchor_by_ids(anchors: Any, ids: tuple[str, ...]) -> dict | None:
    """``connectorAnchors.findByIds``: ordered by id, not array position."""
    for wanted in ids:
        for a in anchors or []:
            if isinstance(a, dict) and a.get("id") == wanted:
                return a
    return None


def _nodes_ok(nodes: Any) -> bool:
    return isinstance(nodes, list) and len(nodes) >= 2


# ─── fibre nodes / tip ─────────────────────────────────────────────────────

def resolve_effective_fiber_nodes(scene: FiberScene, obj: Any) -> list[dict] | None:
    """``resolveEffectiveFiberNodes``: the per-instance
    ``properties.fiberNodes`` (≥2), else the Component's (≥2), else the two
    endpoints rebuilt from the fibre PE's ``kindParams.endA/endB`` — which is
    how a freshly placed connector-component fibre (kindParams only) is
    alignable at all. None when nothing is usable."""
    nodes = props_of(obj).get("fiberNodes")
    if _nodes_ok(nodes):
        return nodes
    comp = scene.component_of(obj)
    comp_nodes = props_of(comp).get("fiberNodes") if comp is not None else None
    if _nodes_ok(comp_nodes):
        return comp_nodes
    pe = scene.physics_elements.get(obj.id)
    if pe is None or pe.element_kind != "fiber":
        return None
    kp = pe.kind_params if isinstance(pe.kind_params, dict) else {}
    end_a, end_b = kp.get("endA"), kp.get("endB")
    if js_falsy(end_a) and js_falsy(end_b):
        return None
    return sync_fiber_nodes_from_kind_params(end_a, end_b)


def fiber_end_tip_mm(scene: FiberScene, obj: Any, end: str) -> float:
    """Junction -> optical-face distance of one end's connector.

    WHICH binding is that end is ``fiberEndConnectorTipMm`` /
    ``_synth_fiber_slot._connector_asset`` (they agree): the first asset
    binding whose ``properties.splineEnd`` is the end letter or whose role is
    ``end_a`` / ``end_b``. The distance is the loader's own
    ``_connector_tip_and_aperture``, so the face this mates is the face the
    solver couples through. (The TS helper returns the 36.28 mm FC constant
    when the connector lacks its cable-root anchor; the loader measures from
    the asset origin then. No catalog connector lacks one.)"""
    comp = scene.component_of(obj)
    if comp is None:
        return FIBER_FERRULE_TIP_MM
    role = "end_a" if end == "A" else "end_b"
    for b in scene.bindings_by_component.get(comp.id, []):
        if b.target_kind != "asset":
            continue
        if props_of(b).get("splineEnd") == end or b.role == role:
            asset = scene.assets.get(b.asset_3d_id) if b.asset_3d_id else None
            return _connector_tip_and_aperture(asset, FIBER_FERRULE_TIP_MM, 0.125)[0]
    return FIBER_FERRULE_TIP_MM


# ─── anchors in lab, through the tracer's chain ────────────────────────────

def owned_anchors_lab(scene: FiberScene, obj: Any) -> list[AnchorPoseLab]:
    """Every anchor of ``obj``'s binding tree placed in lab —
    ``anchor_poses.resolve_anchor_poses_lab``, the backend twin of the TS
    ``anchorPose.resolveAnchorPosesLab`` (which ``collectFiberPortsLab`` and
    ``resnapFibersLinkedTo`` use since 2026-09-22): the binding chain with
    this instance's ObjectBinding deltas, then the SceneObject pose — the
    chain the tracer places the port with. ``axis_x_lab`` is unit, or None
    when the anchor declares no direction."""
    comp = scene.component_of(obj)
    if comp is None:
        return []
    return resolve_anchor_poses_lab(scene, comp, obj)


def _port_of(obj: Any, a: AnchorPoseLab) -> dict:
    return {
        "labPosMm": [a.pos_lab.x, a.pos_lab.y, a.pos_lab.z],
        "labAxisX": [a.axis_x_lab.x, a.axis_x_lab.y, a.axis_x_lab.z],
        "targetName": obj.name,
        "targetObjectId": obj.id,
        "targetAnchorName": a.anchor_name,
        "targetAnchorId": a.anchor_id,
    }


def collect_fiber_ports_lab(
    scene: FiberScene, exclude_object_id: str | None, only_object_id: str | None = None,
) -> list[dict]:
    """``collectFiberPortsLab``: every fibre RECEPTACLE — an anchor declaring
    a female fibre ``connectorType`` AND a mating axis — of every object but
    ``exclude_object_id``, in scene order, as ``FiberPortLab`` dicts."""
    ports: list[dict] = []
    for oid in scene.object_order:
        obj = scene.objects[oid]
        if oid == exclude_object_id:
            continue
        if only_object_id is not None and oid != only_object_id:
            continue
        for a in owned_anchors_lab(scene, obj):
            if is_fiber_port_connector_type(a.anchor.get("connectorType")) and a.axis_x_lab is not None:
                ports.append(_port_of(obj, a))
    return ports


def find_owned_anchor(scene: FiberScene, obj: Any, anchor_id: str, anchor_name: str) -> AnchorPoseLab | None:
    """The anchor a fibre link names (id AND ``name ?? id``), first in tree
    order — the ``resnapFibersLinkedTo`` lookup, which does not re-check the
    connector type."""
    for a in owned_anchors_lab(scene, obj):
        if a.anchor_id == anchor_id and a.anchor_name == anchor_name:
            return a
    return None


# ─── pigtail ports ─────────────────────────────────────────────────────────

def _num(v: Any) -> float:
    """``_effectiveTransform``'s ``num``: a finite number, else 0."""
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return float(v)
    return 0.0


def base_pose(b: Any) -> BindingPose:
    return {
        "localXMm": b.local_x_mm, "localYMm": b.local_y_mm, "localZMm": b.local_z_mm,
        "localRxDeg": b.local_rx_deg, "localRyDeg": b.local_ry_deg, "localRzDeg": b.local_rz_deg,
    }


def effective_pose(b: Any, ob: Any | None) -> BindingPose:
    """``_effectiveTransform``: baseline + this instance's delta per axis."""
    return {
        "localXMm": b.local_x_mm + _num(getattr(ob, "local_x_mm_delta", None)),
        "localYMm": b.local_y_mm + _num(getattr(ob, "local_y_mm_delta", None)),
        "localZMm": b.local_z_mm + _num(getattr(ob, "local_z_mm_delta", None)),
        "localRxDeg": b.local_rx_deg + _num(getattr(ob, "local_rx_deg_delta", None)),
        "localRyDeg": b.local_ry_deg + _num(getattr(ob, "local_ry_deg_delta", None)),
        "localRzDeg": b.local_rz_deg + _num(getattr(ob, "local_rz_deg_delta", None)),
    }


@dataclass
class PigtailPort:
    """``PigtailPortBinding`` — one port connector of a pigtailed instrument."""

    end: str
    port_anchor: str
    binding: Any
    connector: Any
    connect_in: dict
    connect_out: dict | None
    base_pose: BindingPose
    effective_pose: BindingPose
    object_binding: Any | None
    parent_chain: list[BindingPose]

    def placement(self) -> dict:
        return {
            "pose": self.effective_pose,
            "parentPose": compose_binding_poses(self.parent_chain),
            "connectIn": self.connect_in,
        }


def pigtail_port_bindings(scene: FiberScene, comp: Any, obj: Any) -> list[PigtailPort]:
    """``pigtailPortBindings``: the Component's ``fiber_connector`` bindings
    tagged ``properties.portAnchor`` = intercept_in / intercept_out, End A
    first — the same data signal ``_port_connector_anchors`` re-seats on, so
    the ends offered are exactly the ones whose port the solver moves.

    Like the TS (and ``anchor_poses``), the binding's own ``asset3dId`` is
    read and an ``ObjectBinding.asset_3d_id_override`` is not."""
    overrides = scene.object_bindings.get(obj.id, {}) if obj is not None else {}
    binding_by_id = {
        b.id: b for rows in scene.bindings_by_component.values() for b in rows
    }
    out: list[PigtailPort] = []
    for b in scene.bindings_by_component.get(comp.id, []):
        if b.target_kind != "asset" or not b.asset_3d_id:
            continue
        port_anchor = props_of(b).get("portAnchor")
        if port_anchor not in ("intercept_in", "intercept_out"):
            continue
        connector = scene.assets.get(b.asset_3d_id)
        if connector is None or connector.kind_id != "fiber_connector":
            continue
        connect_in = find_anchor_by_ids(connector.anchors, MATING_FACE_IDS)
        if connect_in is None:
            continue
        chain: list[BindingPose] = []
        seen = {b.id}
        parent_id = b.parent_binding_id
        while parent_id and parent_id not in seen:
            seen.add(parent_id)
            parent = binding_by_id.get(parent_id)
            if parent is None:
                break
            chain.insert(0, effective_pose(parent, overrides.get(parent.id)))
            parent_id = parent.parent_binding_id
        out.append(PigtailPort(
            end="B" if port_anchor == "intercept_out" else "A",
            port_anchor=port_anchor,
            binding=b,
            connector=connector,
            connect_in=connect_in,
            connect_out=find_anchor_by_ids(connector.anchors, CABLE_ROOT_IDS),
            base_pose=base_pose(b),
            effective_pose=effective_pose(b, overrides.get(b.id)),
            object_binding=overrides.get(b.id),
            parent_chain=chain,
        ))
    out.sort(key=lambda p: p.end)
    return out


def object_pose_json(obj: Any) -> dict:
    """A SceneObject row's pose in the TS ``V3Pose`` field names."""
    return {
        "xMm": float(obj.x_mm), "yMm": float(obj.y_mm), "zMm": float(obj.z_mm),
        "rxDeg": float(obj.rx_deg), "ryDeg": float(obj.ry_deg), "rzDeg": float(obj.rz_deg),
    }
