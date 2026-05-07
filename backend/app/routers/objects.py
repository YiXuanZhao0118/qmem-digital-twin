from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Collection, CollectionMember, Component, SceneObject
from app.routers.collections import get_master_collection
from app.websocket import manager


router = APIRouter()


OBJECT_TRANSFORM_UPDATE_FIELDS = frozenset(
    {"x_mm", "y_mm", "z_mm", "rx_deg", "ry_deg", "rz_deg"}
)


def strip_locked_transform_updates(
    scene_object: SceneObject, updates: dict[str, object]
) -> dict[str, object]:
    if not scene_object.locked and updates.get("locked") is not True:
        return updates
    return {
        key: value
        for key, value in updates.items()
        if key not in OBJECT_TRANSFORM_UPDATE_FIELDS
    }


def object_payload(scene_object: SceneObject) -> dict[str, object]:
    return schemas.SceneObjectOut.model_validate(scene_object).model_dump(mode="json", by_alias=True)


async def broadcast_object(scene_object: SceneObject) -> None:
    await manager.broadcast("object.updated", object_payload(scene_object))


def normalize_object_name(name: str | None) -> str:
    normalized = (name or "").strip()
    if not normalized:
        raise HTTPException(status_code=400, detail="Object name cannot be empty.")
    return normalized


async def object_name_exists(
    session: AsyncSession,
    name: str,
    exclude_object_id: uuid.UUID | None = None,
) -> bool:
    stmt = select(SceneObject.id).where(func.lower(SceneObject.name) == name.lower())
    if exclude_object_id is not None:
        stmt = stmt.where(SceneObject.id != exclude_object_id)
    return await session.scalar(stmt) is not None


async def require_unique_object_name(
    session: AsyncSession,
    name: str | None,
    exclude_object_id: uuid.UUID | None = None,
) -> str:
    normalized = normalize_object_name(name)
    if await object_name_exists(session, normalized, exclude_object_id):
        raise HTTPException(
            status_code=409,
            detail=f'Object name "{normalized}" already exists.',
        )
    return normalized


async def next_object_name(session: AsyncSession, component: Component) -> str:
    index = 1
    while True:
        candidate = f"{component.name}_object_{index}"
        if not await object_name_exists(session, candidate):
            return candidate
        index += 1


@router.get("", response_model=list[schemas.SceneObjectOut])
async def list_objects(session: AsyncSession = Depends(get_session)) -> list[SceneObject]:
    return await crud.list_all(session, SceneObject)


@router.post("", response_model=schemas.SceneObjectOut, status_code=status.HTTP_201_CREATED)
async def create_object(
    payload: schemas.SceneObjectCreate,
    session: AsyncSession = Depends(get_session),
) -> SceneObject:
    # Lazy import avoids a circular components ↔ objects router dependency.
    from app.routers.components import (
        auto_create_optical_element_for_object,
        optical_element_payload,
    )

    component = await crud.get_or_404(session, Component, payload.component_id)
    values = payload.model_dump()
    target_collection_id = values.pop("collection_id", None)
    requested_name = values.get("name")
    if requested_name and requested_name.strip():
        values["name"] = await require_unique_object_name(session, requested_name)
    else:
        values["name"] = await next_object_name(session, component)
    scene_object = SceneObject(**values)
    session.add(scene_object)
    await session.flush()

    if target_collection_id is not None:
        target = await crud.get_or_404(session, Collection, target_collection_id)
        target_id = target.id
    else:
        master = await get_master_collection(session)
        target_id = master.id
    session.add(CollectionMember(collection_id=target_id, object_id=scene_object.id))

    # Per-object optical participation: when the user spawns an object of an
    # optical kind (mirror, laser_source, etc.), auto-create the OpticalElement
    # for THIS specific instance with default kind_params. They can edit those
    # params per-object after.
    optical_element = await auto_create_optical_element_for_object(
        session, scene_object, component
    )

    await session.commit()
    await session.refresh(scene_object)
    if optical_element is not None:
        await session.refresh(optical_element)
    await manager.broadcast("object.updated", object_payload(scene_object))
    await manager.broadcast(
        "collection_member.updated",
        {
            "collectionId": str(target_id),
            "objectId": str(scene_object.id),
            "sortOrder": 0,
        },
    )
    if optical_element is not None:
        await manager.broadcast("optical_element.updated", optical_element_payload(optical_element))
    return scene_object


@router.put("/{object_id}", response_model=schemas.SceneObjectOut)
async def update_object(
    object_id: uuid.UUID,
    payload: schemas.SceneObjectUpdate,
    session: AsyncSession = Depends(get_session),
) -> SceneObject:
    # NOTE: assembly relations are intentionally NOT auto-enforced here. The
    # product decision (2026-05-02) is to treat AssemblyRelation rows as
    # one-shot positioning aids — the user clicks "Apply" once via
    # POST /api/assembly-relations/{id}/apply-once which writes the relation's
    # computed pose to the driven object and deletes the relation. Persistent
    # relation enforcement on every object update was making it impossible to
    # nudge components freely.
    scene_object = await crud.get_or_404(session, SceneObject, object_id)
    updates = strip_locked_transform_updates(
        scene_object, payload.model_dump(exclude_unset=True)
    )
    if "name" in updates:
        updates["name"] = await require_unique_object_name(
            session,
            updates["name"] if isinstance(updates["name"], str) else None,
            scene_object.id,
        )
    if updates:
        crud.apply_updates(scene_object, updates)
    await session.commit()
    await session.refresh(scene_object)
    await broadcast_object(scene_object)
    return scene_object


@router.delete("/{object_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_object(
    object_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    scene_object = await crud.get_or_404(session, SceneObject, object_id)
    await session.delete(scene_object)
    await session.commit()
    await manager.broadcast("object.deleted", {"id": str(object_id), "objectId": str(object_id)})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/by-component/{component_id}", response_model=schemas.SceneObjectOut)
async def upsert_object_for_component(
    component_id: uuid.UUID,
    payload: schemas.SceneObjectUpdate,
    session: AsyncSession = Depends(get_session),
) -> SceneObject:
    await crud.get_or_404(session, Component, component_id)
    result = await session.scalars(select(SceneObject).where(SceneObject.component_id == component_id))
    scene_object = result.first()
    is_new = scene_object is None
    if scene_object is None:
        component = await crud.get_or_404(session, Component, component_id)
        scene_object = SceneObject(component_id=component_id, name=await next_object_name(session, component))
        session.add(scene_object)
        await session.flush()

    updates = strip_locked_transform_updates(
        scene_object, payload.model_dump(exclude_unset=True)
    )
    if "name" in updates:
        updates["name"] = await require_unique_object_name(
            session,
            updates["name"] if isinstance(updates["name"], str) else None,
            scene_object.id,
        )
    if updates:
        crud.apply_updates(scene_object, updates)
    # See note on update_object — relations are no longer auto-enforced.

    new_member: CollectionMember | None = None
    if is_new:
        master = await get_master_collection(session)
        new_member = CollectionMember(
            collection_id=master.id, object_id=scene_object.id
        )
        session.add(new_member)

    await session.commit()
    await session.refresh(scene_object)
    await broadcast_object(scene_object)
    if new_member is not None:
        await session.refresh(new_member)
        await manager.broadcast(
            "collection_member.updated",
            {
                "collectionId": str(new_member.collection_id),
                "objectId": str(new_member.object_id),
                "sortOrder": new_member.sort_order,
            },
        )
    return scene_object
