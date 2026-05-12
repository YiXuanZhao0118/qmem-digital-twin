"""Routes that drive the Blender-style Outliner.

A *Collection* is purely organizational: it never changes an object's
transform, it only decides which Outliner branch the object appears in and
whether the renderer should consider it visible. Geometry stays the
exclusive concern of ``AssemblyRelation``.
"""

from __future__ import annotations

import uuid
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Collection, CollectionMember, SceneObject
from app.websocket import manager


router = APIRouter()

MASTER_COLLECTION_NAME = "Master Collection"


def _payload(collection: Collection) -> dict[str, object]:
    return schemas.CollectionOut.model_validate(collection).model_dump(
        mode="json", by_alias=True
    )


def _membership_payload(member: CollectionMember) -> dict[str, object]:
    return schemas.CollectionMemberOut.model_validate(member).model_dump(
        mode="json", by_alias=True
    )


async def _ensure_no_cycle(
    session: AsyncSession, collection_id: uuid.UUID, new_parent_id: uuid.UUID | None
) -> None:
    """Walk up from ``new_parent_id`` and refuse if we hit ``collection_id``."""

    if new_parent_id is None:
        return
    if new_parent_id == collection_id:
        raise HTTPException(status_code=400, detail="A collection cannot be its own parent.")
    cursor = new_parent_id
    visited: set[uuid.UUID] = set()
    while cursor is not None:
        if cursor == collection_id:
            raise HTTPException(
                status_code=400,
                detail="Reparent rejected: would create a cycle in the collection tree.",
            )
        if cursor in visited:
            # Defensive: malformed pre-existing cycle. Stop walking.
            break
        visited.add(cursor)
        next_parent = await session.scalar(
            select(Collection.parent_id).where(Collection.id == cursor)
        )
        cursor = cast(uuid.UUID | None, next_parent)


async def get_master_collection(session: AsyncSession) -> Collection:
    """Return the singleton Master Collection, creating it if absent."""

    result = await session.scalars(
        select(Collection)
        .where(Collection.parent_id.is_(None))
        .order_by(Collection.created_at.asc())
        .limit(1)
    )
    master = result.first()
    if master is not None:
        return master
    master = Collection(
        name=MASTER_COLLECTION_NAME,
        parent_id=None,
        properties={"isMaster": True},
    )
    session.add(master)
    await session.commit()
    await session.refresh(master)
    return master


def _collection_depths(collections: list[Collection]) -> dict[uuid.UUID, int]:
    by_id = {collection.id: collection for collection in collections}
    cache: dict[uuid.UUID, int] = {}

    def depth(collection_id: uuid.UUID, seen: set[uuid.UUID]) -> int:
        if collection_id in cache:
            return cache[collection_id]
        if collection_id in seen:
            return 0
        collection = by_id.get(collection_id)
        if collection is None or collection.parent_id is None:
            cache[collection_id] = 0
            return 0
        value = depth(collection.parent_id, seen | {collection_id}) + 1
        cache[collection_id] = value
        return value

    return {collection.id: depth(collection.id, set()) for collection in collections}


def canonical_collection_members(
    collections: list[Collection],
    members: list[CollectionMember],
) -> list[CollectionMember]:
    """Return the single display/home membership for every object.

    When old data still has several memberships for one object, the deepest
    collection wins (Master < child < grandchild). This keeps an object moved
    into QM/Trapping under Trapping instead of showing it again in parents.
    """

    depths = _collection_depths(collections)
    collection_ids = set(depths)
    by_object: dict[uuid.UUID, CollectionMember] = {}

    def score(member: CollectionMember) -> tuple[int, object, int, str]:
        return (
            depths.get(member.collection_id, 0),
            member.added_at,
            member.sort_order,
            str(member.collection_id),
        )

    for member in members:
        if member.collection_id not in collection_ids:
            continue
        current = by_object.get(member.object_id)
        if current is None or score(member) > score(current):
            by_object[member.object_id] = member

    return sorted(
        by_object.values(),
        key=lambda member: (str(member.collection_id), member.sort_order, member.added_at),
    )


@router.get("", response_model=list[schemas.CollectionOut])
async def list_collections(
    session: AsyncSession = Depends(get_session),
) -> list[Collection]:
    await get_master_collection(session)
    result = await session.scalars(
        select(Collection).order_by(Collection.sort_order.asc(), Collection.created_at.asc())
    )
    return list(result.all())


@router.get("/members", response_model=list[schemas.CollectionMemberOut])
async def list_all_memberships(
    session: AsyncSession = Depends(get_session),
) -> list[CollectionMember]:
    collections = list(
        (
            await session.scalars(
                select(Collection).order_by(
                    Collection.sort_order.asc(), Collection.created_at.asc()
                )
            )
        ).all()
    )
    result = await session.scalars(
        select(CollectionMember).order_by(
            CollectionMember.collection_id.asc(), CollectionMember.sort_order.asc()
        )
    )
    return canonical_collection_members(collections, list(result.all()))


@router.post("", response_model=schemas.CollectionOut, status_code=status.HTTP_201_CREATED)
async def create_collection(
    payload: schemas.CollectionCreate, session: AsyncSession = Depends(get_session)
) -> Collection:
    master = await get_master_collection(session)
    values = payload.model_dump()
    # Enforce the single-root invariant: any creation without an explicit parent
    # is auto-reparented under Master. The Outliner is therefore guaranteed to
    # render exactly one tree.
    if values.get("parent_id") is None:
        values["parent_id"] = master.id
    else:
        await crud.get_or_404(session, Collection, values["parent_id"])
    collection = Collection(**values)
    session.add(collection)
    await session.commit()
    await session.refresh(collection)
    await manager.broadcast("collection.updated", _payload(collection))
    return collection


@router.get("/{collection_id}", response_model=schemas.CollectionOut)
async def get_collection(
    collection_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Collection:
    return await crud.get_or_404(session, Collection, collection_id)


@router.put("/{collection_id}", response_model=schemas.CollectionOut)
async def update_collection(
    collection_id: uuid.UUID,
    payload: schemas.CollectionUpdate,
    session: AsyncSession = Depends(get_session),
) -> Collection:
    collection = await crud.get_or_404(session, Collection, collection_id)
    updates = payload.model_dump(exclude_unset=True)
    if "parent_id" in updates:
        await _ensure_no_cycle(session, collection_id, updates["parent_id"])
    if collection.parent_id is None and "parent_id" in updates and updates["parent_id"] is not None:
        raise HTTPException(
            status_code=400,
            detail="The Master Collection must remain the tree root.",
        )
    crud.apply_updates(collection, updates)
    await session.commit()
    await session.refresh(collection)
    await manager.broadcast("collection.updated", _payload(collection))
    return collection


@router.put("/{collection_id}/move", response_model=schemas.CollectionOut)
async def move_collection(
    collection_id: uuid.UUID,
    payload: schemas.CollectionMoveRequest,
    session: AsyncSession = Depends(get_session),
) -> Collection:
    collection = await crud.get_or_404(session, Collection, collection_id)
    if collection.parent_id is None:
        raise HTTPException(status_code=400, detail="The Master Collection cannot be moved.")
    await _ensure_no_cycle(session, collection_id, payload.parent_id)
    if payload.parent_id is not None:
        await crud.get_or_404(session, Collection, payload.parent_id)
    collection.parent_id = payload.parent_id
    if payload.sort_order is not None:
        collection.sort_order = payload.sort_order
    await session.commit()
    await session.refresh(collection)
    await manager.broadcast("collection.updated", _payload(collection))
    return collection


@router.delete("/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_collection(
    collection_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    collection = await crud.get_or_404(session, Collection, collection_id)
    if collection.parent_id is None:
        raise HTTPException(status_code=400, detail="The Master Collection cannot be deleted.")
    await session.delete(collection)
    await session.commit()
    await manager.broadcast(
        "collection.updated", {"id": str(collection_id), "deleted": True}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{collection_id}/members", response_model=list[schemas.CollectionMemberOut])
async def list_collection_members(
    collection_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> list[CollectionMember]:
    await crud.get_or_404(session, Collection, collection_id)
    collections = list(
        (
            await session.scalars(
                select(Collection).order_by(
                    Collection.sort_order.asc(), Collection.created_at.asc()
                )
            )
        ).all()
    )
    result = await session.scalars(
        select(CollectionMember).order_by(
            CollectionMember.collection_id.asc(), CollectionMember.sort_order.asc()
        )
    )
    return [
        member
        for member in canonical_collection_members(collections, list(result.all()))
        if member.collection_id == collection_id
    ]


@router.post(
    "/{collection_id}/objects/{object_id}",
    response_model=schemas.CollectionMemberOut,
    status_code=status.HTTP_201_CREATED,
)
async def move_object_to_collection(
    collection_id: uuid.UUID,
    object_id: uuid.UUID,
    payload: schemas.CollectionMembershipRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> CollectionMember:
    await crud.get_or_404(session, Collection, collection_id)
    scene_object = await crud.get_or_404(session, SceneObject, object_id)
    # Locked objects are frozen across the board: pose mutation
    # (strip_locked_transform_updates), deletion (delete_object), and now
    # outliner reparent. Same defense-in-depth pattern — frontend filters
    # locked ids out of multi-select drag, this 409 protects against direct
    # API calls that bypass the UI.
    if scene_object.locked:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Object is locked. Unlock it before moving to another collection.",
        )

    result = await session.scalars(
        select(CollectionMember).where(CollectionMember.object_id == object_id)
    )
    memberships = list(result.all())
    member = next((m for m in memberships if m.collection_id == collection_id), None)
    removed_payloads = [
        {
            "collectionId": str(m.collection_id),
            "objectId": str(m.object_id),
            "deleted": True,
        }
        for m in memberships
        if m.collection_id != collection_id
    ]

    # The `uq_collection_members_object_home` UNIQUE constraint enforces
    # "each object lives in at most one collection". So MOVE = mutate the
    # existing row's collection_id rather than delete-then-insert. Tried
    # delete-flush-insert first; asyncpg's transaction visibility kept the
    # to-be-deleted row visible to the unique-constraint check during the
    # subsequent INSERT, so it still exploded. UPDATE on the existing row
    # sidesteps the constraint entirely.
    other_membership = next(
        (m for m in memberships if m.collection_id != collection_id),
        None,
    )
    if member is None and other_membership is not None:
        other_membership.collection_id = collection_id
        if payload and payload.sort_order is not None:
            other_membership.sort_order = payload.sort_order
        member = other_membership
    elif member is None:
        member = CollectionMember(
            collection_id=collection_id,
            object_id=object_id,
            sort_order=payload.sort_order if payload else 0,
        )
        session.add(member)
    else:
        if payload and payload.sort_order is not None:
            member.sort_order = payload.sort_order

    await session.commit()
    await session.refresh(member)
    for removed in removed_payloads:
        await manager.broadcast("collection_member.updated", removed)
    await manager.broadcast("collection_member.updated", _membership_payload(member))
    return member


@router.delete(
    "/{collection_id}/objects/{object_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unlink_object(
    collection_id: uuid.UUID,
    object_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    member = await session.get(CollectionMember, (collection_id, object_id))
    if member is None:
        raise HTTPException(status_code=404, detail="Membership not found")
    other_count = await session.scalar(
        select(CollectionMember.object_id).where(
            CollectionMember.object_id == object_id,
            CollectionMember.collection_id != collection_id,
        )
    )
    if other_count is None:
        master = await get_master_collection(session)
        if master.id != collection_id:
            member.collection_id = master.id
            member.sort_order = 0
            await session.commit()
            await manager.broadcast(
                "collection_member.updated",
                {
                    "collectionId": str(master.id),
                    "objectId": str(object_id),
                    "sortOrder": 0,
                },
            )
            await manager.broadcast(
                "collection_member.updated",
                {
                    "collectionId": str(collection_id),
                    "objectId": str(object_id),
                    "deleted": True,
                },
            )
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        else:
            raise HTTPException(
                status_code=400,
                detail="An object must belong to at least one collection.",
            )
    await session.delete(member)
    await session.commit()
    await manager.broadcast(
        "collection_member.updated",
        {
            "collectionId": str(collection_id),
            "objectId": str(object_id),
            "deleted": True,
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/by-object/{object_id}", response_model=list[schemas.CollectionMemberOut])
async def list_memberships_for_object(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> list[CollectionMember]:
    await crud.get_or_404(session, SceneObject, object_id)
    collections = list(
        (
            await session.scalars(
                select(Collection).order_by(
                    Collection.sort_order.asc(), Collection.created_at.asc()
                )
            )
        ).all()
    )
    result = await session.scalars(
        select(CollectionMember)
        .order_by(CollectionMember.added_at.asc())
    )
    return [
        member
        for member in canonical_collection_members(collections, list(result.all()))
        if member.object_id == object_id
    ]


@router.delete(
    "/by-object/{object_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def clear_memberships_for_object(
    object_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    """Remove all collection memberships for an object except its membership in
    the Master Collection (which is recreated if absent)."""

    await crud.get_or_404(session, SceneObject, object_id)
    master = await get_master_collection(session)
    result = await session.scalars(
        select(CollectionMember).where(CollectionMember.object_id == object_id)
    )
    memberships = list(result.all())
    existing = next((member for member in memberships if member.collection_id == master.id), None)
    if existing is not None:
        for member in memberships:
            if member.collection_id != master.id:
                await session.delete(member)
    elif memberships:
        primary = memberships[0]
        primary.collection_id = master.id
        primary.sort_order = 0
        for member in memberships[1:]:
            await session.delete(member)
    else:
        session.add(CollectionMember(collection_id=master.id, object_id=object_id))
    await session.commit()
    await manager.broadcast(
        "collection_member.updated",
        {"objectId": str(object_id), "resetToMaster": True},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
