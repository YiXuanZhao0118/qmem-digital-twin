"""Routes backing the "Collection Drift" feature.

A *CollectionTemplate* is a reusable snapshot of a Collection subtree: the
tree shape (with sub-collections), every descendant SceneObject's component
reference, and each object's pose stored *relative to the subtree's
geometric centroid* at save time. Connections, optical / RF links and
physics_element details are intentionally not snapshotted; instantiation
produces clean, unconnected objects whose relative geometry exactly
matches what was captured.

See ``CollectionTemplate`` in app/models.py and alembic 0053 for the
on-disk schema. The on-instantiate placement target (``targetXMm`` /
``targetYMm`` / ``targetZMm`` in the request) becomes the new subtree's
centroid in lab frame — frontends typically pass the 3D cursor position.
"""

from __future__ import annotations

import uuid
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import (
    Collection,
    CollectionMember,
    CollectionTemplate,
    Component,
    SceneObject,
)
from app.routers.collections import _payload as collection_payload
from app.routers.collections import get_master_collection
from app.routers.objects import (
    next_object_name,
    object_payload,
)
from app.websocket import manager


router = APIRouter()


def _template_payload(template: CollectionTemplate) -> dict[str, object]:
    return schemas.CollectionTemplateOut.model_validate(template).model_dump(
        mode="json", by_alias=True
    )


async def _descendant_collection_ids(
    session: AsyncSession, root_id: uuid.UUID
) -> list[uuid.UUID]:
    """Return ``root_id`` followed by every transitive descendant collection id,
    in BFS order. Used by the save path to gather every SceneObject that should
    land in the snapshot."""

    ordered: list[uuid.UUID] = [root_id]
    frontier: list[uuid.UUID] = [root_id]
    while frontier:
        result = await session.scalars(
            select(Collection.id).where(Collection.parent_id.in_(frontier))
        )
        next_layer = list(result.all())
        if not next_layer:
            break
        ordered.extend(next_layer)
        frontier = next_layer
    return ordered


async def _build_template_tree(
    session: AsyncSession,
    root: Collection,
) -> dict[str, Any]:
    """Walk ``root``'s subtree and produce the JSONB tree stored on the row.

    Pose offsets are computed relative to the centroid of *every* descendant
    SceneObject across the whole subtree (not per-sub-collection), so the
    instantiated copy sits as a single rigid bundle whose centroid lands on
    the user-supplied target point.
    """

    descendant_ids = await _descendant_collection_ids(session, root.id)
    if not descendant_ids:
        return {
            "name": root.name,
            "color": root.color,
            "visible": root.visible,
            "rigidTransform": root.rigid_transform,
            "sortOrder": root.sort_order,
            "properties": root.properties,
            "members": [],
            "children": [],
        }

    members_result = await session.scalars(
        select(CollectionMember).where(CollectionMember.collection_id.in_(descendant_ids))
    )
    members = list(members_result.all())
    object_ids = list({member.object_id for member in members})
    objects: dict[uuid.UUID, SceneObject] = {}
    if object_ids:
        objects_result = await session.scalars(
            select(SceneObject).where(SceneObject.id.in_(object_ids))
        )
        objects = {obj.id: obj for obj in objects_result.all()}

    # Phase 2026-05-16: rf_cable / sma_cable / programmable_pulse_generator
    # are connectivity artifacts (re-created via the RF Link panel each
    # time), not template-worthy topology. Drop them from the saved
    # member list AND from the centroid calculation so subsequent
    # instantiations land at the geometric centre of the actual
    # instruments, not skewed by free-floating cables. The user re-
    # connects PPG / cable inside the RF Link panel after dropping a
    # template.
    EXCLUDED_COMPONENT_TYPES = {"rf_cable", "sma_cable", "programmable_pulse_generator"}
    component_ids = {obj.component_id for obj in objects.values()}
    components_by_id: dict[uuid.UUID, Component] = {}
    if component_ids:
        comp_result = await session.scalars(
            select(Component).where(Component.id.in_(component_ids))
        )
        components_by_id = {c.id: c for c in comp_result.all()}

    def is_excluded(obj: SceneObject) -> bool:
        comp = components_by_id.get(obj.component_id)
        return comp is not None and comp.component_type in EXCLUDED_COMPONENT_TYPES

    snapshotable_objects = {
        oid: obj for oid, obj in objects.items() if not is_excluded(obj)
    }

    if snapshotable_objects:
        cx = sum(obj.x_mm for obj in snapshotable_objects.values()) / len(snapshotable_objects)
        cy = sum(obj.y_mm for obj in snapshotable_objects.values()) / len(snapshotable_objects)
        cz = sum(obj.z_mm for obj in snapshotable_objects.values()) / len(snapshotable_objects)
    else:
        cx = cy = cz = 0.0

    # Index sub-collections by parent_id once for a single recursive sweep.
    collections_by_parent: dict[uuid.UUID | None, list[Collection]] = {}
    if len(descendant_ids) > 1:
        sub_result = await session.scalars(
            select(Collection).where(Collection.id.in_(descendant_ids[1:]))
        )
        for sub in sub_result.all():
            collections_by_parent.setdefault(sub.parent_id, []).append(sub)
        for parent_id in collections_by_parent:
            collections_by_parent[parent_id].sort(
                key=lambda c: (c.sort_order, c.created_at)
            )

    members_by_collection: dict[uuid.UUID, list[CollectionMember]] = {}
    for member in members:
        members_by_collection.setdefault(member.collection_id, []).append(member)
    for collection_id in members_by_collection:
        members_by_collection[collection_id].sort(
            key=lambda m: (m.sort_order, m.added_at)
        )

    def serialize_member(member: CollectionMember) -> dict[str, Any]:
        obj = snapshotable_objects.get(member.object_id)
        # `obj is None` covers two cases: the member's object was deleted
        # (defensive), and the object is excluded from the snapshot
        # (rf_cable / sma_cable / programmable_pulse_generator — see
        # EXCLUDED_COMPONENT_TYPES above). Either way the entry collapses
        # to {} which the caller drops in the comprehension below.
        if obj is None:
            return {}
        return {
            "componentId": str(obj.component_id),
            "relativeXMm": float(obj.x_mm - cx),
            "relativeYMm": float(obj.y_mm - cy),
            "relativeZMm": float(obj.z_mm - cz),
            "rxDeg": float(obj.rx_deg),
            "ryDeg": float(obj.ry_deg),
            "rzDeg": float(obj.rz_deg),
            "visible": bool(obj.visible),
            "properties": dict(obj.properties or {}),
            "sortOrder": int(member.sort_order),
        }

    def serialize_node(node: Collection) -> dict[str, Any]:
        node_members = [
            serialized
            for member in members_by_collection.get(node.id, [])
            if (serialized := serialize_member(member))
        ]
        node_children = [
            serialize_node(child) for child in collections_by_parent.get(node.id, [])
        ]
        return {
            "name": node.name,
            "color": node.color,
            "visible": node.visible,
            "rigidTransform": node.rigid_transform,
            "sortOrder": node.sort_order,
            "properties": dict(node.properties or {}),
            "members": node_members,
            "children": node_children,
        }

    return serialize_node(root)


async def _unique_collection_name(session: AsyncSession, base: str) -> str:
    """Return ``base1``, ``base2``, … — the first name not already in use.

    Mirrors the auto-numbering convention applied to instantiated objects
    (``COMPONENT_TYPE`` + index) so collection names follow the same
    "stamp" pattern when a template is dropped in multiple times.
    """

    stripped = (base or "Collection").strip() or "Collection"
    index = 1
    while True:
        candidate = f"{stripped}{index}"
        existing = await session.scalar(
            select(Collection.id).where(Collection.name == candidate)
        )
        if existing is None:
            return candidate
        index += 1


async def _instantiate_tree(
    session: AsyncSession,
    node: dict[str, Any],
    parent_collection_id: uuid.UUID,
    target_x: float,
    target_y: float,
    target_z: float,
    is_root: bool,
    component_cache: dict[uuid.UUID, Component],
    created_collections: list[Collection],
    created_objects: list[SceneObject],
    created_members: list[tuple[uuid.UUID, uuid.UUID]],
) -> Collection:
    # Lazy import to mirror create_object's circular-dependency dodge.
    from app.routers.components import (
        auto_create_physics_element_for_object,
        physics_element_payload,  # noqa: F401  (re-exported elsewhere)
    )

    base_name = str(node.get("name") or "Collection")
    # Only the root collection gets the unique-name dance — nested children
    # reuse their saved names. The tree shape stays identical to what the
    # user saved; only the visible root suffix is bumped so repeated drops
    # produce A1 / A2 / A3 with each having its own (identical) sub-tree.
    new_name = await _unique_collection_name(session, base_name) if is_root else base_name
    new_collection = Collection(
        name=new_name,
        parent_id=parent_collection_id,
        color=str(node.get("color") or "#0f766e"),
        visible=bool(node.get("visible", True)),
        rigid_transform=bool(node.get("rigidTransform", False)),
        sort_order=int(node.get("sortOrder", 0) or 0),
        properties=dict(node.get("properties") or {}),
    )
    session.add(new_collection)
    await session.flush()
    created_collections.append(new_collection)

    for member in node.get("members", []) or []:
        component_id_raw = member.get("componentId")
        if not component_id_raw:
            continue
        try:
            component_id = uuid.UUID(str(component_id_raw))
        except ValueError:
            continue
        component = component_cache.get(component_id)
        if component is None:
            component = await session.get(Component, component_id)
            if component is None:
                # Component referenced by the template was deleted since save —
                # skip the member rather than blow up the whole instantiation.
                continue
            component_cache[component_id] = component

        # Defensive filter for pre-fix templates: even if a legacy
        # template still has rf_cable / sma_cable / programmable_pulse_
        # generator members baked in, skip them at instantiation —
        # connectivity is re-built via the RF Link panel after the
        # template lands. New templates (post 2026-05-16) already
        # drop these on save; this guard keeps idempotency.
        if component.component_type in {
            "rf_cable",
            "sma_cable",
            "programmable_pulse_generator",
        }:
            continue

        new_object = SceneObject(
            component_id=component.id,
            name=await next_object_name(session, component),
            x_mm=target_x + float(member.get("relativeXMm", 0.0) or 0.0),
            y_mm=target_y + float(member.get("relativeYMm", 0.0) or 0.0),
            z_mm=target_z + float(member.get("relativeZMm", 0.0) or 0.0),
            rx_deg=float(member.get("rxDeg", 0.0) or 0.0),
            ry_deg=float(member.get("ryDeg", 0.0) or 0.0),
            rz_deg=float(member.get("rzDeg", 0.0) or 0.0),
            visible=bool(member.get("visible", True)),
            locked=False,
            properties=dict(member.get("properties") or {}),
        )
        session.add(new_object)
        await session.flush()
        created_objects.append(new_object)

        membership = CollectionMember(
            collection_id=new_collection.id,
            object_id=new_object.id,
            sort_order=int(member.get("sortOrder", 0) or 0),
        )
        session.add(membership)
        created_members.append((new_collection.id, new_object.id))

        await auto_create_physics_element_for_object(session, new_object, component)

    for child in node.get("children", []) or []:
        await _instantiate_tree(
            session=session,
            node=child,
            parent_collection_id=new_collection.id,
            target_x=target_x,
            target_y=target_y,
            target_z=target_z,
            is_root=False,
            component_cache=component_cache,
            created_collections=created_collections,
            created_objects=created_objects,
            created_members=created_members,
        )

    return new_collection


@router.get("", response_model=list[schemas.CollectionTemplateOut])
async def list_templates(
    session: AsyncSession = Depends(get_session),
) -> list[CollectionTemplate]:
    result = await session.scalars(
        select(CollectionTemplate).order_by(CollectionTemplate.created_at.desc())
    )
    return list(result.all())


@router.get("/{template_id}", response_model=schemas.CollectionTemplateOut)
async def get_template(
    template_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> CollectionTemplate:
    return await crud.get_or_404(session, CollectionTemplate, template_id)


@router.post(
    "/from-collection/{collection_id}",
    response_model=schemas.CollectionTemplateOut,
    status_code=status.HTTP_201_CREATED,
)
async def save_collection_as_template(
    collection_id: uuid.UUID,
    payload: schemas.CollectionTemplateCreate,
    session: AsyncSession = Depends(get_session),
) -> CollectionTemplate:
    collection = await crud.get_or_404(session, Collection, collection_id)
    tree = await _build_template_tree(session, collection)
    template = CollectionTemplate(
        name=(payload.name or "").strip() or collection.name,
        description=payload.description,
        tree=tree,
    )
    session.add(template)
    await session.commit()
    await session.refresh(template)
    return template


@router.post(
    "/{template_id}/instantiate",
    status_code=status.HTTP_201_CREATED,
)
async def instantiate_template(
    template_id: uuid.UUID,
    payload: schemas.CollectionTemplateInstantiate,
    session: AsyncSession = Depends(get_session),
) -> dict[str, object]:
    template = await crud.get_or_404(session, CollectionTemplate, template_id)
    tree = cast(dict[str, Any], template.tree or {})
    if not tree:
        raise HTTPException(status_code=400, detail="Template has an empty tree.")

    if payload.parent_collection_id is None:
        parent = await get_master_collection(session)
    else:
        parent = await crud.get_or_404(session, Collection, payload.parent_collection_id)

    component_cache: dict[uuid.UUID, Component] = {}
    created_collections: list[Collection] = []
    created_objects: list[SceneObject] = []
    created_members: list[tuple[uuid.UUID, uuid.UUID]] = []

    root_collection = await _instantiate_tree(
        session=session,
        node=tree,
        parent_collection_id=parent.id,
        target_x=payload.target_x_mm,
        target_y=payload.target_y_mm,
        target_z=payload.target_z_mm,
        is_root=True,
        component_cache=component_cache,
        created_collections=created_collections,
        created_objects=created_objects,
        created_members=created_members,
    )

    await session.commit()
    for collection in created_collections:
        await session.refresh(collection)
    for scene_object in created_objects:
        await session.refresh(scene_object)

    for collection in created_collections:
        await manager.broadcast("collection.updated", collection_payload(collection))
    for scene_object in created_objects:
        await manager.broadcast("object.updated", object_payload(scene_object))
    for collection_id, object_id in created_members:
        await manager.broadcast(
            "collection_member.updated",
            {
                "collectionId": str(collection_id),
                "objectId": str(object_id),
                "sortOrder": 0,
            },
        )

    return {
        "rootCollectionId": str(root_collection.id),
        "createdCollectionIds": [str(c.id) for c in created_collections],
        "createdObjectIds": [str(o.id) for o in created_objects],
    }


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    template = await crud.get_or_404(session, CollectionTemplate, template_id)
    await session.delete(template)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
