"""Magnetics problems CRUD router — Phase F+."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import MagneticsProblem
from app.schemas import (
    MagneticsProblemCreate,
    MagneticsProblemOut,
    MagneticsProblemUpdate,
)


router = APIRouter()


@router.get("", response_model=list[MagneticsProblemOut])
async def list_magnetics_problems(
    session: AsyncSession = Depends(get_session),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[MagneticsProblem]:
    stmt = (
        select(MagneticsProblem)
        .order_by(MagneticsProblem.updated_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


@router.get("/{mag_id}", response_model=MagneticsProblemOut)
async def get_magnetics_problem(
    mag_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> MagneticsProblem:
    row = await session.get(MagneticsProblem, mag_id)
    if row is None:
        raise HTTPException(status_code=404, detail="MagneticsProblem not found")
    return row


@router.post("", response_model=MagneticsProblemOut, status_code=status.HTTP_201_CREATED)
async def create_magnetics_problem(
    payload: MagneticsProblemCreate,
    session: AsyncSession = Depends(get_session),
) -> MagneticsProblem:
    row = MagneticsProblem(
        name=payload.name,
        coil_ids=[str(cid) for cid in payload.coil_ids],
        eval_region=payload.eval_region.model_dump(by_alias=False),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


@router.patch("/{mag_id}", response_model=MagneticsProblemOut)
async def update_magnetics_problem(
    mag_id: uuid.UUID,
    patch: MagneticsProblemUpdate,
    session: AsyncSession = Depends(get_session),
) -> MagneticsProblem:
    row = await session.get(MagneticsProblem, mag_id)
    if row is None:
        raise HTTPException(status_code=404, detail="MagneticsProblem not found")
    data = patch.model_dump(exclude_unset=True, by_alias=False)
    for field, value in data.items():
        if field == "coil_ids" and value is not None:
            setattr(row, field, [str(cid) for cid in value])
        elif field == "eval_region" and value is not None:
            setattr(row, field, value.model_dump(by_alias=False) if hasattr(value, "model_dump") else value)
        else:
            setattr(row, field, value)
    row.updated_at = datetime.now(timezone.utc)
    await session.commit()
    await session.refresh(row)
    return row


@router.delete("/{mag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_magnetics_problem(
    mag_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> None:
    row = await session.get(MagneticsProblem, mag_id)
    if row is None:
        raise HTTPException(status_code=404, detail="MagneticsProblem not found")
    await session.delete(row)
    await session.commit()
