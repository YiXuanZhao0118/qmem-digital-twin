"""V2 Phase 1: read-only access to simulation_runs.

POSTing a new simulation run is still done by ``POST /api/simulations/optical/run``
which currently does not yet write a SimulationRun row. That wiring lands in
Phase 3 once the solver itself is V2-aware.

Phase 1 ships only GET endpoints so the frontend can list / inspect existing
runs once they start being written.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import SimulationRun
from app.schemas import V2SimulationRunOut


router = APIRouter()


@router.get("", response_model=list[V2SimulationRunOut])
async def list_simulation_runs(
    session: AsyncSession = Depends(get_session),
    limit: int = 100,
) -> list[SimulationRun]:
    stmt = (
        select(SimulationRun)
        .order_by(SimulationRun.started_at.desc())
        .limit(limit)
    )
    return list((await session.scalars(stmt)).all())


@router.get("/{run_id}", response_model=V2SimulationRunOut)
async def get_simulation_run(
    run_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> SimulationRun:
    run = await session.get(SimulationRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="SimulationRun not found")
    return run
