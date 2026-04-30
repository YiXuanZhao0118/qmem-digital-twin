from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app import crud, schemas
from app.db import get_session
from app.models import BeamPath
from app.websocket import manager


router = APIRouter()


def beam_path_payload(beam_path: BeamPath) -> dict[str, object]:
    return schemas.BeamPathOut.model_validate(beam_path).model_dump(mode="json", by_alias=True)


@router.get("", response_model=list[schemas.BeamPathOut])
async def list_beam_paths(session: AsyncSession = Depends(get_session)) -> list[BeamPath]:
    return await crud.list_all(session, BeamPath)


@router.post("", response_model=schemas.BeamPathOut, status_code=status.HTTP_201_CREATED)
async def create_beam_path(
    payload: schemas.BeamPathCreate, session: AsyncSession = Depends(get_session)
) -> BeamPath:
    beam_path = BeamPath(**payload.model_dump())
    session.add(beam_path)
    await session.commit()
    await session.refresh(beam_path)
    await manager.broadcast("beam_path.updated", beam_path_payload(beam_path))
    return beam_path


@router.put("/{beam_path_id}", response_model=schemas.BeamPathOut)
async def update_beam_path(
    beam_path_id: uuid.UUID,
    payload: schemas.BeamPathUpdate,
    session: AsyncSession = Depends(get_session),
) -> BeamPath:
    beam_path = await crud.get_or_404(session, BeamPath, beam_path_id)
    crud.apply_updates(beam_path, payload.model_dump(exclude_unset=True))
    await session.commit()
    await session.refresh(beam_path)
    await manager.broadcast("beam_path.updated", beam_path_payload(beam_path))
    return beam_path


@router.delete("/{beam_path_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_beam_path(
    beam_path_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> Response:
    beam_path = await crud.get_or_404(session, BeamPath, beam_path_id)
    await session.delete(beam_path)
    await session.commit()
    await manager.broadcast("beam_path.updated", {"id": str(beam_path_id), "deleted": True})
    return Response(status_code=status.HTTP_204_NO_CONTENT)

