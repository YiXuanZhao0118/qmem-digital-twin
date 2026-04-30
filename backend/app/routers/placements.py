from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.assembly_solver import apply_relations_for_object
from app.db import get_session
from app.models import Component, Placement
from app.websocket import manager


router = APIRouter()


def placement_payload(placement: Placement) -> dict[str, object]:
    return schemas.PlacementOut.model_validate(placement).model_dump(mode="json", by_alias=True)


async def broadcast_placement(placement: Placement) -> None:
    payload = placement_payload(placement)
    await manager.broadcast("placement.updated", payload)
    await manager.broadcast("object.updated", payload)


async def next_object_name(session: AsyncSession, component: Component) -> str:
    result = await session.scalar(
        select(func.count(Placement.id)).where(Placement.component_id == component.id)
    )
    return f"{component.name}_object_{int(result or 0) + 1}"


@router.get("", response_model=list[schemas.PlacementOut])
async def list_placements(session: AsyncSession = Depends(get_session)) -> list[Placement]:
    return await crud.list_all(session, Placement)


@router.post("", response_model=schemas.PlacementOut, status_code=status.HTTP_201_CREATED)
async def create_placement(
    payload: schemas.PlacementCreate,
    session: AsyncSession = Depends(get_session),
) -> Placement:
    component = await crud.get_or_404(session, Component, payload.component_id)
    values = payload.model_dump()
    if not values.get("object_name"):
        values["object_name"] = await next_object_name(session, component)
    placement = Placement(**values)
    session.add(placement)
    await session.commit()
    await session.refresh(placement)
    await manager.broadcast("placement.updated", placement_payload(placement))
    await manager.broadcast("object.updated", placement_payload(placement))
    return placement


@router.put("/objects/{placement_id}", response_model=schemas.PlacementOut)
async def update_placement_object(
    placement_id: uuid.UUID,
    payload: schemas.PlacementUpdate,
    session: AsyncSession = Depends(get_session),
) -> Placement:
    placement = await crud.get_or_404(session, Placement, placement_id)
    crud.apply_updates(placement, payload.model_dump(exclude_unset=True))
    changed = await apply_relations_for_object(session, placement)
    await session.commit()
    await session.refresh(placement)
    await broadcast_placement(placement)
    for item in changed:
        await session.refresh(item)
        await broadcast_placement(item)
    return placement


@router.delete("/objects/{placement_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_placement_object(
    placement_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Response:
    placement = await crud.get_or_404(session, Placement, placement_id)
    await session.delete(placement)
    await session.commit()
    await manager.broadcast("object.deleted", {"id": str(placement_id), "objectId": str(placement_id)})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/{component_id}", response_model=schemas.PlacementOut)
async def upsert_placement(
    component_id: uuid.UUID,
    payload: schemas.PlacementUpdate,
    session: AsyncSession = Depends(get_session),
) -> Placement:
    await crud.get_or_404(session, Component, component_id)
    result = await session.scalars(select(Placement).where(Placement.component_id == component_id))
    placement = result.first()
    if placement is None:
        component = await crud.get_or_404(session, Component, component_id)
        placement = Placement(component_id=component_id, object_name=await next_object_name(session, component))
        session.add(placement)

    crud.apply_updates(placement, payload.model_dump(exclude_unset=True))
    changed = await apply_relations_for_object(session, placement)
    await session.commit()
    await session.refresh(placement)
    await broadcast_placement(placement)
    for item in changed:
        await session.refresh(item)
        await broadcast_placement(item)
    return placement
