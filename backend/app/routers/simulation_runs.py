"""Multi-physics simulation runs router.

V2 Phase 1 shipped only the read-only GETs; multiphysics Phase A.1
(this file) adds POST. Clients dispatch a solver run by module name;
the router creates the ``simulation_runs`` row, hands it to the matching
``SolverRunner``, and returns the row immediately. Completion is observable
either by polling GET /{run_id} or by subscribing to the
``simulation_run.status_changed`` WebSocket event emitted by the solver.

The legacy ``POST /api/simulations/optical/run`` endpoint
(``app.routers.simulations``) is left in place for backward compatibility
and shares the optics_seq solver via
``app.solvers.optics_seq.hydrate_laser_kind_params``.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import SimulationRun
from app.schemas import (
    MultiphysicsSimulationRunCreate,
    SimulationModule,
    V2SimulationRunOut,
)
from app.solvers.runner import (
    MODULE_DEFAULT_RUNNER,
    MODULE_DISPATCH,
    RUNNERS,
)


router = APIRouter()


@router.get("", response_model=list[V2SimulationRunOut])
async def list_simulation_runs(
    session: AsyncSession = Depends(get_session),
    module: SimulationModule | None = Query(
        default=None, description="Filter by simulation module"
    ),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[SimulationRun]:
    stmt = (
        select(SimulationRun)
        .order_by(SimulationRun.started_at.desc())
        .limit(limit)
    )
    if module is not None:
        stmt = stmt.where(SimulationRun.module == module)
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


@router.post(
    "",
    response_model=V2SimulationRunOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_simulation_run(
    payload: MultiphysicsSimulationRunCreate,
    session: AsyncSession = Depends(get_session),
) -> SimulationRun:
    """Create a queued SimulationRun and dispatch via the appropriate runner.

    Returns immediately with status='queued' (the background task may have
    already flipped it to 'running' by the time the response serializes —
    but the response is a one-shot snapshot, not a live stream). Clients
    track completion via:
      - GET /api/simulation-runs/{run_id}, or
      - WebSocket ``simulation_run.status_changed`` event.

    Returns 501 if the requested module or runner_kind is reserved in the
    schema but not yet wired up (Phase A only ships optics_seq + inproc).
    """
    if payload.module not in MODULE_DISPATCH:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                f"module={payload.module!r} is reserved but not yet "
                f"implemented; supported in this build: "
                f"{sorted(MODULE_DISPATCH.keys())}"
            ),
        )

    runner_kind = payload.runner_kind or MODULE_DEFAULT_RUNNER[payload.module]
    runner = RUNNERS.get(runner_kind)
    if runner is None:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail=(
                f"runner_kind={runner_kind!r} is reserved but not yet "
                f"implemented; supported in this build: "
                f"{sorted(RUNNERS.keys())}"
            ),
        )

    sim_run = SimulationRun(
        module=payload.module,
        runner_kind=runner_kind,
        status="queued",
        params=payload.params,
        progress=0.0,
    )
    session.add(sim_run)
    # Commit before dispatch: the background task opens its own session and
    # must SELECT this row.
    await session.commit()
    # Refresh to pick up the server-generated started_at default which the
    # response model requires.
    await session.refresh(sim_run)

    await runner.submit(sim_run)

    return sim_run
