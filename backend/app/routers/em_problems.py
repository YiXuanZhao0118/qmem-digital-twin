"""EM problems CRUD router — Phase C.1.

One row = one EM analysis problem definition (scene object + mesh +
ports + boundary conditions + frequency sweep). Solver runs key off
``params.emProblemId`` on the multiphysics SimulationRun.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import EmProblem
from app.schemas import EmProblemCreate, EmProblemOut, EmProblemUpdate


router = APIRouter()


@router.get("", response_model=list[EmProblemOut])
async def list_em_problems(
    session: AsyncSession = Depends(get_session),
    scene_object_id: uuid.UUID | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[EmProblem]:
    stmt = select(EmProblem).order_by(EmProblem.updated_at.desc()).limit(limit)
    if scene_object_id is not None:
        stmt = stmt.where(EmProblem.scene_object_id == scene_object_id)
    return list((await session.scalars(stmt)).all())


@router.get("/{em_id}", response_model=EmProblemOut)
async def get_em_problem(
    em_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> EmProblem:
    em = await session.get(EmProblem, em_id)
    if em is None:
        raise HTTPException(status_code=404, detail="EmProblem not found")
    return em


@router.post("", response_model=EmProblemOut, status_code=status.HTTP_201_CREATED)
async def create_em_problem(
    payload: EmProblemCreate,
    session: AsyncSession = Depends(get_session),
) -> EmProblem:
    em = EmProblem(
        name=payload.name,
        scene_object_id=payload.scene_object_id,
        mesh_id=payload.mesh_id,
        ports=[p.model_dump(by_alias=False) for p in payload.ports],
        boundary_conditions=payload.boundary_conditions.model_dump(by_alias=False),
        freq_range_ghz=(
            payload.freq_range_ghz.model_dump(by_alias=False)
            if payload.freq_range_ghz is not None
            else {}
        ),
    )
    session.add(em)
    await session.commit()
    await session.refresh(em)
    return em


@router.patch("/{em_id}", response_model=EmProblemOut)
async def update_em_problem(
    em_id: uuid.UUID,
    patch: EmProblemUpdate,
    session: AsyncSession = Depends(get_session),
) -> EmProblem:
    em = await session.get(EmProblem, em_id)
    if em is None:
        raise HTTPException(status_code=404, detail="EmProblem not found")

    data = patch.model_dump(exclude_unset=True, by_alias=False)
    for field, value in data.items():
        if field in {"ports", "boundary_conditions", "freq_range_ghz"}:
            # Pydantic gave us model instances or list of them; flatten to
            # JSON-compatible form before writing the JSONB column.
            if value is None:
                setattr(em, field, [] if field == "ports" else {})
            elif isinstance(value, list):
                setattr(em, field, [
                    v.model_dump(by_alias=False) if hasattr(v, "model_dump") else v
                    for v in value
                ])
            elif hasattr(value, "model_dump"):
                setattr(em, field, value.model_dump(by_alias=False))
            else:
                setattr(em, field, value)
        else:
            setattr(em, field, value)
    em.updated_at = datetime.now(timezone.utc)

    await session.commit()
    await session.refresh(em)
    return em


@router.delete("/{em_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_em_problem(
    em_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> None:
    em = await session.get(EmProblem, em_id)
    if em is None:
        raise HTTPException(status_code=404, detail="EmProblem not found")
    await session.delete(em)
    await session.commit()
