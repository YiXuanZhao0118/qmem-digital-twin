"""Anchor poses in lab mm, through a Component's binding tree — the backend
counterpart of ``frontend/src/utils/anchorPose.ts`` (``resolveAnchorPosesLab``)
and ``componentBindings.resolveBindingTree``.

Every align solver needs "where, in lab mm, is this object's
``intercept_face`` and which way does it point". The walk (roots in stored
order, a node's own anchors before its children, a sub-Component's roots
spliced in as extra children with no per-instance overrides, anchors deduped
by ``id|name`` first-wins) mirrors the TS so both clients pick the SAME
anchor; the transforms are the backend's own chain —
``db_scene_loader._binding_tree_transform`` (raw XYZ binding Euler plus the
``ObjectBinding`` deltas) composed with ``pose.pose_to_transform`` (the
SceneObject pose) — which is what the tracer places anchors with and what
``docs/introduce/anchors.md`` says the TS equals.

Rows are duck-typed (ORM rows in the service, ``SimpleNamespace`` in tests),
so everything here is pure.

``ObjectBinding.asset_3d_id_override`` (a per-instance asset swap) is honoured
where the tracer's loader honours it — an asset binding of the object's own
Component resolves to the override when one is set (``effective_asset_id``) —
by ``resolve_anchor_poses_lab`` and by ``AlignScene.primary_asset`` given an
``object_id``, mirroring ``resolveAnchorPosesLab`` / ``primaryAssetForObject``.
``resolve_binding_tree`` takes it as an opt-in, like its TS twin. The RF
resolver's ``_primary_asset_id`` deliberately stays override-blind
(``docs/introduce/rf.md`` §4).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from app.optical.align.frames import cad_to_lab, rotate_lab_dir
from app.optical.align.ts_compat import V, read_xyz
from app.optical.beam_ray import Vec3
from app.optical.db_scene_loader import _binding_tree_transform
from app.optical.pose import (
    V3Pose,
    V3Transform,
    compose_transforms,
    dir_body_to_lab_t,
    point_body_to_lab_t,
)
from app.optical.rf_resolve import _primary_asset_id


@dataclass
class AlignScene:
    """The scene slice the align solvers read, keyed by ``str(id)``.

    ``bindings_by_component`` lists each Component's bindings in stored order
    (``sort_order``, then ``created_at`` — the order ``GET /api/scene`` hands
    the frontend). ``components`` excludes archived rows, as the scene
    snapshot does. ``object_bindings`` is ``{object_id: {binding.id: row}}``.
    """

    objects: dict[str, Any]
    components: dict[str, Any]
    bindings_by_component: dict[str, list[Any]]
    object_bindings: dict[str, dict[Any, Any]]
    assets: dict[str, Any]

    def component_of(self, scene_object: Any) -> Any | None:
        return self.components.get(str(scene_object.component_id))

    def primary_asset(self, component: Any, object_id: str | None = None) -> Any | None:
        """TS ``componentBindings.primaryAsset`` — one root asset binding, else
        the legacy ``component.asset_3d_id`` (``rf_resolve._primary_asset_id``,
        the RF BFS's port of the same function).

        With ``object_id`` it is ``primaryAssetForObject`` instead: the root
        binding's asset is that instance's ``asset_3d_id_override`` when set,
        as the tracer's loader resolves it."""
        bindings = self.bindings_by_component.get(str(component.id), [])
        if object_id is None:
            asset_id = _primary_asset_id(component, bindings)
            return self.assets.get(str(asset_id)) if asset_id else None
        roots = [b for b in bindings if b.parent_binding_id is None]
        if len(roots) == 1 and roots[0].target_kind == "asset":
            asset_id = effective_asset_id(
                roots[0], self.object_bindings.get(str(object_id), {}).get(roots[0].id),
            )
            if asset_id:
                return self.assets.get(str(asset_id))
        return self.assets.get(str(component.asset_3d_id)) if component.asset_3d_id else None


def effective_asset_id(binding: Any, object_binding: Any | None) -> Any | None:
    """The asset an asset binding resolves to for one instance — the override
    when set, else the binding's own — exactly the loader's rule
    (``db_scene_loader.load_anchor_scene_from_db``); TS
    ``effectiveBindingAssetId``."""
    override = getattr(object_binding, "asset_3d_id_override", None) if object_binding else None
    return override if override is not None else binding.asset_3d_id


@dataclass
class BindingNode:
    """One resolved binding (TS ``ResolvedBindingNode``), carrying its
    Component-CAD-frame transform instead of the raw local pose."""

    binding: Any
    target_kind: str  # "asset" | "subcomponent" | "empty" | "missing"
    asset: Any | None
    transform: V3Transform
    children: list[BindingNode] = field(default_factory=list)


def _resolve_target(
    scene: AlignScene, b: Any, asset_id: Any | None,
) -> tuple[str, Any | None, Any | None]:
    if b.target_kind == "asset":
        asset = scene.assets.get(str(asset_id)) if asset_id else None
        return ("asset", asset, None) if asset is not None else ("missing", None, None)
    if b.target_kind == "empty":
        return "empty", None, None
    sub = scene.components.get(str(b.sub_component_id)) if b.sub_component_id else None
    return ("subcomponent", None, sub) if sub is not None else ("missing", None, None)


def _resolve_level(
    scene: AlignScene,
    bindings: list[Any],
    owner_bindings: list[Any],
    overrides: dict[Any, Any],
    offset: V3Transform | None,
    visited: frozenset[str],
    memo: dict,
    honour_asset_override: bool,
) -> list[BindingNode]:
    binding_by_id = {b.id: b for b in owner_bindings}
    out: list[BindingNode] = []
    for b in bindings:
        asset_id = (
            effective_asset_id(b, overrides.get(b.id))
            if honour_asset_override else b.asset_3d_id
        )
        kind, asset, sub = _resolve_target(scene, b, asset_id)
        chain = _binding_tree_transform(b, binding_by_id, overrides, memo, set())
        transform = chain if offset is None else compose_transforms(offset, chain)
        children = _resolve_level(
            scene,
            [c for c in owner_bindings if c.parent_binding_id == b.id],
            owner_bindings, overrides, offset, visited, memo, honour_asset_override,
        )
        if kind == "subcomponent" and str(sub.id) not in visited:
            sub_bindings = scene.bindings_by_component.get(str(sub.id), [])
            children = children + _resolve_level(
                scene,
                [c for c in sub_bindings if c.parent_binding_id is None],
                sub_bindings, {}, transform, visited | {str(sub.id)}, {},
                honour_asset_override,
            )
        out.append(BindingNode(b, kind, asset, transform, children))
    return out


def resolve_binding_tree(
    scene: AlignScene,
    component: Any,
    object_id: str | None,
    *,
    honour_asset_override: bool = False,
) -> list[BindingNode]:
    """TS ``resolveBindingTree(component, sceneObject, scene, options)``.
    ``object_id`` selects the per-instance ``ObjectBinding`` deltas (``None``
    = catalog); ``honour_asset_override`` also swaps each asset binding's
    target for that instance's ``asset_3d_id_override`` (the loader's rule),
    off by default like the TS option."""
    owner = scene.bindings_by_component.get(str(component.id), [])
    overrides = scene.object_bindings.get(object_id, {}) if object_id else {}
    return _resolve_level(
        scene,
        [b for b in owner if b.parent_binding_id is None],
        owner, overrides, None, frozenset({str(component.id)}), {},
        honour_asset_override,
    )


@dataclass(frozen=True)
class AnchorPoseLab:
    """TS ``AnchorPoseLab`` minus the object references (``asset_id`` names
    the owning asset; ``anchor`` is its raw JSON)."""

    anchor_id: str
    anchor_name: str
    asset_id: str
    anchor: dict
    pos_cad: V
    axis_x_cad: V | None
    pos_lab: V
    axis_x_lab: V | None
    aperture_mm: float | None


def _unit(v: V) -> V | None:
    """``anchorPose.ts``'s ``unit``: hypot, 1e-9 floor, plain division."""
    m = math.hypot(v.x, v.y, v.z)
    return None if m < 1e-9 else V(v.x / m, v.y / m, v.z / m)


def anchor_primary_dir(anchor: dict) -> V | None:
    """``anchorObjectLocalPrimaryDir``: axisX, else legacy directionBodyLocal."""
    axis = read_xyz(anchor.get("axisXBodyLocal"))
    return axis if axis is not None else read_xyz(anchor.get("directionBodyLocal"))


def anchor_display_name(anchor: dict) -> str:
    """``anchor.name ?? anchor.id`` (only a MISSING name falls back)."""
    name = anchor.get("name")
    return str(name) if name is not None else str(anchor.get("id"))


def _aperture(anchor: dict) -> float | None:
    a = anchor.get("apertureMm")
    if isinstance(a, bool) or not isinstance(a, (int, float)):
        return None
    return float(a) if a > 0 else None


def resolve_anchor_poses_lab(
    scene: AlignScene, component: Any, scene_object: Any,
) -> list[AnchorPoseLab]:
    """TS ``resolveAnchorPosesLab``: every anchor in the binding tree, in the
    Component CAD frame and in lab mm under ``scene_object``'s pose."""
    collected: list[tuple[Any, dict, V, V | None]] = []
    seen: set[str] = set()

    def walk(nodes: list[BindingNode]) -> None:
        for node in nodes:
            if node.target_kind == "asset":
                for anchor in node.asset.anchors or []:
                    if not isinstance(anchor, dict):
                        continue
                    key = f"{anchor.get('id')}|{anchor_display_name(anchor)}"
                    if key in seen:
                        continue
                    seen.add(key)
                    p = read_xyz(anchor.get("positionMmBodyLocal"))
                    if p is None:
                        continue  # malformed anchor: nothing to place
                    pc = point_body_to_lab_t(Vec3(p.x, p.y, p.z), node.transform)
                    d = anchor_primary_dir(anchor)
                    axis = None
                    if d is not None:
                        dc = dir_body_to_lab_t(Vec3(d.x, d.y, d.z), node.transform)
                        axis = _unit(V(dc.x, dc.y, dc.z))
                    collected.append((node.asset, anchor, V(pc.x, pc.y, pc.z), axis))
            if node.children:
                walk(node.children)

    # Per-instance asset swaps count, as they do in the tracer's loader.
    walk(resolve_binding_tree(
        scene, component, str(scene_object.id), honour_asset_override=True,
    ))

    if not collected and component.asset_3d_id:
        asset = scene.assets.get(str(component.asset_3d_id))
        if asset is not None:
            for anchor in asset.anchors or []:
                if not isinstance(anchor, dict):
                    continue
                p = read_xyz(anchor.get("positionMmBodyLocal"))
                if p is None:
                    continue
                d = anchor_primary_dir(anchor)
                collected.append((asset, anchor, p, _unit(d) if d is not None else None))

    pose = object_pose(scene_object)
    out: list[AnchorPoseLab] = []
    for asset, anchor, pos_cad, axis_cad in collected:
        out.append(AnchorPoseLab(
            anchor_id=str(anchor.get("id")),
            anchor_name=anchor_display_name(anchor),
            asset_id=str(asset.id),
            anchor=anchor,
            pos_cad=pos_cad,
            axis_x_cad=axis_cad,
            pos_lab=cad_to_lab(pos_cad, pose),
            axis_x_lab=_unit(rotate_lab_dir(axis_cad, pose)) if axis_cad is not None else None,
            aperture_mm=_aperture(anchor),
        ))
    return out


def object_pose(scene_object: Any) -> V3Pose:
    """A SceneObject row's pose as the backend's ``V3Pose``."""
    return V3Pose(
        x_mm=float(scene_object.x_mm), y_mm=float(scene_object.y_mm),
        z_mm=float(scene_object.z_mm), rx_deg=float(scene_object.rx_deg),
        ry_deg=float(scene_object.ry_deg), rz_deg=float(scene_object.rz_deg),
    )
