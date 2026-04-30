from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import delete, or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import BeamPath, Component, Connection, Placement
from app.websocket import manager


router = APIRouter()


def component_payload(component: Component) -> dict[str, object]:
    return schemas.ComponentOut.model_validate(component).model_dump(mode="json", by_alias=True)


def is_component_locked(component: Component) -> bool:
    return component.properties.get("locked") is True


@router.get("", response_model=list[schemas.ComponentOut])
async def list_components(session: AsyncSession = Depends(get_session)) -> list[Component]:
    return await crud.list_all(session, Component)


@router.post("", response_model=schemas.ComponentOut, status_code=status.HTTP_201_CREATED)
async def create_component(
    payload: schemas.ComponentCreate, session: AsyncSession = Depends(get_session)
) -> Component:
    component = Component(**payload.model_dump())
    session.add(component)
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.created", component_payload(component))
    return component


@router.get("/{component_id}", response_model=schemas.ComponentOut)
async def get_component(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Component:
    return await crud.get_or_404(session, Component, component_id)


@router.put("/{component_id}", response_model=schemas.ComponentOut)
async def update_component(
    component_id: uuid.UUID,
    payload: schemas.ComponentUpdate,
    session: AsyncSession = Depends(get_session),
) -> Component:
    component = await crud.get_or_404(session, Component, component_id)
    crud.apply_updates(component, payload.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(component)
    await manager.broadcast("component.updated", component_payload(component))
    return component


@router.delete("/{component_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_component(
    component_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    component = await crud.get_or_404(session, Component, component_id)
    if is_component_locked(component):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Component is locked.")
    await session.execute(
        delete(BeamPath).where(
            or_(
                BeamPath.source_component_id == component_id,
                BeamPath.target_component_id == component_id,
            )
        )
    )
    await session.execute(
        delete(Connection).where(
            or_(
                Connection.from_component_id == component_id,
                Connection.to_component_id == component_id,
            )
        )
    )
    await session.execute(
        update(Placement)
        .where(Placement.parent_component_id == component_id)
        .values(parent_component_id=None)
    )
    await session.delete(component)
    await session.commit()
    await manager.broadcast(
        "component.deleted",
        {"id": str(component_id), "componentId": str(component_id)},
    )
    await manager.broadcast("scene.reload", {})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
