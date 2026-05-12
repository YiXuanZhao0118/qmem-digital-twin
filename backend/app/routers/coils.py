"""Coils CRUD router — Phase F+ Magnetics."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import Coil
from app.schemas import CoilCreate, CoilOut, CoilUpdate


router = APIRouter()


@router.get("", response_model=list[CoilOut])
async def list_coils(
    session: AsyncSession = Depends(get_session),
    scene_object_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[Coil]:
    stmt = select(Coil).order_by(Coil.updated_at.desc()).limit(limit)
    if scene_object_id is not None:
        stmt = stmt.where(Coil.scene_object_id == scene_object_id)
    return list((await session.scalars(stmt)).all())


@router.get("/{coil_id}", response_model=CoilOut)
async def get_coil(coil_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> Coil:
    coil = await session.get(Coil, coil_id)
    if coil is None:
        raise HTTPException(status_code=404, detail="Coil not found")
    return coil


@router.post("", response_model=CoilOut, status_code=status.HTTP_201_CREATED)
async def create_coil(
    payload: CoilCreate, session: AsyncSession = Depends(get_session)
) -> Coil:
    coil = Coil(
        name=payload.name,
        shape=payload.shape,
        params=payload.params,
        current_a=payload.current_a,
        scene_object_id=payload.scene_object_id,
    )
    session.add(coil)
    await session.commit()
    await session.refresh(coil)
    return coil


@router.patch("/{coil_id}", response_model=CoilOut)
async def update_coil(
    coil_id: uuid.UUID,
    patch: CoilUpdate,
    session: AsyncSession = Depends(get_session),
) -> Coil:
    coil = await session.get(Coil, coil_id)
    if coil is None:
        raise HTTPException(status_code=404, detail="Coil not found")
    data = patch.model_dump(exclude_unset=True, by_alias=False)
    for field, value in data.items():
        setattr(coil, field, value)
    coil.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(coil)
    return coil


@router.delete("/{coil_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_coil(
    coil_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> None:
    coil = await session.get(Coil, coil_id)
    if coil is None:
        raise HTTPException(status_code=404, detail="Coil not found")
    await session.delete(coil)
    await session.commit()
