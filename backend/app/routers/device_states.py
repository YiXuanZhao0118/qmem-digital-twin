from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Component, DeviceState
from app.websocket import manager


router = APIRouter()


def device_state_payload(device_state: DeviceState) -> dict[str, object]:
    return schemas.DeviceStateOut.model_validate(device_state).model_dump(mode="json", by_alias=True)


@router.get("", response_model=list[schemas.DeviceStateOut])
async def list_device_states(session: AsyncSession = Depends(get_session)) -> list[DeviceState]:
    return await crud.list_all(session, DeviceState)


@router.put("/{component_id}", response_model=schemas.DeviceStateOut)
async def upsert_device_state(
    component_id: uuid.UUID,
    payload: schemas.DeviceStateUpdate,
    session: AsyncSession = Depends(get_session),
) -> DeviceState:
    await crud.get_or_404(session, Component, component_id)
    result = await session.scalars(select(DeviceState).where(DeviceState.component_id == component_id))
    device_state = result.first()
    if device_state is None:
        device_state = DeviceState(component_id=component_id)
        session.add(device_state)

    device_state.state = payload.state
    await session.commit()
    await session.refresh(device_state)
    await manager.broadcast("device_state.updated", device_state_payload(device_state))
    return device_state

