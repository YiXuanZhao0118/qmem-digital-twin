from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, status
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import BeamSegment, OpticalElement, OpticalLink
from app.schemas import CamelModel
from app.solvers.optical_solver import solve_chain
from app.websocket import manager


router = APIRouter()


class OpticalRunResponse(CamelModel):
    run_id: uuid.UUID
    segment_count: int
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


@router.post("/optical/run", response_model=OpticalRunResponse, status_code=status.HTTP_200_OK)
async def run_optical(session: AsyncSession = Depends(get_session)) -> OpticalRunResponse:
    elements = list((await session.scalars(select(OpticalElement))).all())
    links = list((await session.scalars(select(OpticalLink))).all())

    result = solve_chain(elements, links)

    if not result.errors:
        # Replace any prior segments for these links so the table doesn't grow
        # unbounded across runs (a future runs table will switch this to append).
        link_ids = [link.id for link in links]
        if link_ids:
            await session.execute(delete(BeamSegment).where(BeamSegment.optical_link_id.in_(link_ids)))
        for segment in result.segments:
            session.add(BeamSegment(**segment))
        await session.commit()

    payload = OpticalRunResponse(
        run_id=result.run_id,
        segment_count=len(result.segments),
        errors=result.errors,
        warnings=result.warnings,
    )
    await manager.broadcast(
        "optical_simulation.completed",
        payload.model_dump(mode="json", by_alias=True),
    )
    return payload
