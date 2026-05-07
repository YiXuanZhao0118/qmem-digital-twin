from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import Connection, SceneObject
from app.websocket import manager


router = APIRouter()


def connection_payload(connection: Connection) -> dict[str, object]:
    return schemas.ConnectionOut.model_validate(connection).model_dump(mode="json", by_alias=True)


@router.get("", response_model=list[schemas.ConnectionOut])
async def list_connections(session: AsyncSession = Depends(get_session)) -> list[Connection]:
    return await crud.list_all(session, Connection)


@router.post("", response_model=schemas.ConnectionOut, status_code=status.HTTP_201_CREATED)
async def create_connection(
    payload: schemas.ConnectionCreate, session: AsyncSession = Depends(get_session)
) -> Connection:
    await crud.get_or_404(session, SceneObject, payload.from_object_id)
    await crud.get_or_404(session, SceneObject, payload.to_object_id)
    connection = Connection(**payload.model_dump())
    session.add(connection)
    await session.commit()
    await session.refresh(connection)
    await manager.broadcast("connection.updated", connection_payload(connection))
    return connection


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    connection = await crud.get_or_404(session, Connection, connection_id)
    await session.delete(connection)
    await session.commit()
    await manager.broadcast("connection.updated", {"id": str(connection_id), "deleted": True})
    return Response(status_code=status.HTTP_204_NO_CONTENT)

