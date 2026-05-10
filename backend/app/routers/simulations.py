from __future__ import annotations

import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db import get_session
from app.models import (
    BeamSegment,
    OpticalElement,
    OpticalLink,
    SceneObject,
    SimulationRun,
    TimingProgram,
)
from app.schemas import CamelModel
from app.solvers.optical_solver import solve_chain
from app.timing_program import evaluate_program_at
from app.v2_bindings import get_optical_source, legacy_laser_kind_params_from_beam
from app.websocket import manager


def _hydrate_laser_kind_params(
    elements: list[OpticalElement],
    objects_by_id: dict,
) -> None:
    """V2 Phase 3 (alembic 0029) translator boundary.

    The solver's emit-from-laser path still consumes the legacy laser
    kindParams shape. After Phase 3 the DB no longer stores those fields —
    the V2 source of truth is ``objects.properties.opticalSources[].beam``.
    Right before invoking solve_chain we translate the V2 source back into
    the legacy shape and overwrite the in-memory OpticalElement.kind_params
    so the rest of the solver runs unchanged.

    Mutation is in-memory only; SQLAlchemy session changes are not flushed
    here, and the actual DB row stays empty.
    """
    for element in elements:
        if element.element_kind != "laser_source":
            continue
        scene_object = objects_by_id.get(element.object_id)
        if scene_object is None:
            continue
        source = get_optical_source(scene_object)
        if source is None:
            continue
        beam = source.get("beam") if isinstance(source, dict) else None
        if not isinstance(beam, dict):
            continue
        legacy = legacy_laser_kind_params_from_beam(beam)
        # Preserve any residual non-V2 keys the user may have set.
        merged = {**(element.kind_params or {}), **legacy}
        element.kind_params = merged


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
    objects_by_id = {
        obj.id: obj for obj in (await session.scalars(select(SceneObject))).all()
    }
    _hydrate_laser_kind_params(elements, objects_by_id)

    result = solve_chain(elements, links)

    if not result.errors:
        # V2 Phase 1 (alembic 0027) added a FK from
        # beam_segments.simulation_run_id → simulation_runs.id, so any
        # segment we persist must reference a real SimulationRun row.
        # solve_chain still makes up an in-memory uuid for `result.run_id`;
        # promote it to a persisted SimulationRun row here so the FK is
        # satisfied. Status defaults to "completed" and warnings are
        # stashed verbatim — keeps the route audit-friendly without
        # pulling the solver into the DB layer.
        sim_run = SimulationRun(
            id=result.run_id,
            status="completed",
            warnings=list(result.warnings),
        )
        session.add(sim_run)
        await session.flush()  # ensure simulation_runs row exists before FK check on beam_segments
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
    # Trigger every connected client to re-pull /api/scene so the new
    # beam_segments show up.
    if not result.errors:
        await manager.broadcast("scene.reload", {"reason": "optical_simulation"})
    return payload


# =============================================================================
# Transient (time-domain) optical run
# =============================================================================
#
# Walks a uniform time grid `[t_start_ns, t_end_ns)` at step `dt_ns`,
# evaluates every component's TimingProgram at each step, and re-solves the
# optical chain with the resulting program factors. Each step's segments
# are stamped with `sequence_t_ms = t_ns / 1e6` so the front end can
# reconstruct per-link power/profile traces.


class TransientRunRequest(CamelModel):
    t_start_ns: float = Field(default=0.0, ge=0.0)
    t_end_ns: float = Field(gt=0.0)
    dt_ns: float = Field(default=100.0, gt=0.0)
    persist_segments: bool = Field(
        default=False,
        description=(
            "Wipe & insert beam_segments for every timestep. Default False to "
            "avoid blowing up the table; the response carries the per-component "
            "trace inline so most callers don't need persisted segments."
        ),
    )


class TransientTracePoint(CamelModel):
    t_ns: float
    value: float
    kind: str
    label: str | None = None


class TransientObjectTrace(CamelModel):
    object_id: uuid.UUID
    points: list[TransientTracePoint] = Field(default_factory=list)


class TransientRunResponse(CamelModel):
    run_id: uuid.UUID
    sample_count: int
    segment_count: int
    object_traces: list[TransientObjectTrace] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


@router.post(
    "/optical/transient/run",
    response_model=TransientRunResponse,
    status_code=status.HTTP_200_OK,
)
async def run_optical_transient(
    payload: TransientRunRequest,
    session: AsyncSession = Depends(get_session),
) -> TransientRunResponse:
    if payload.t_end_ns <= payload.t_start_ns:
        raise HTTPException(
            status_code=400, detail="t_end_ns must be > t_start_ns"
        )
    span = payload.t_end_ns - payload.t_start_ns
    n_steps = int(math.ceil(span / payload.dt_ns))
    if n_steps > 10_000:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Transient grid too dense: {n_steps} steps. Cap is 10 000 to "
                "protect the DB; loosen dt_ns."
            ),
        )

    elements = list((await session.scalars(select(OpticalElement))).all())
    links = list((await session.scalars(select(OpticalLink))).all())
    objects_by_id = {
        obj.id: obj for obj in (await session.scalars(select(SceneObject))).all()
    }
    _hydrate_laser_kind_params(elements, objects_by_id)
    programs = list(
        (
            await session.scalars(
                select(TimingProgram).options(selectinload(TimingProgram.blocks))
            )
        ).all()
    )
    blocks_by_object: dict[uuid.UUID, list] = {
        program.object_id: list(program.blocks) for program in programs
    }

    run_id = uuid.uuid4()
    all_segments: list[dict] = []
    object_traces: dict[uuid.UUID, list[TransientTracePoint]] = {
        program.object_id: [] for program in programs
    }
    errors: set[str] = set()
    warnings: set[str] = set()

    for step in range(n_steps):
        t_ns = payload.t_start_ns + step * payload.dt_ns
        t_ms = t_ns / 1.0e6

        # Evaluate every object's program at t and collect (factor, trace point).
        factors: dict[uuid.UUID, float] = {}
        for object_id, blocks in blocks_by_object.items():
            res = evaluate_program_at(blocks, t_ns)
            factors[object_id] = float(res.value)
            object_traces[object_id].append(
                TransientTracePoint(
                    t_ns=t_ns,
                    value=res.value,
                    kind=res.kind,
                    label=res.label,
                )
            )

        result = solve_chain(
            elements,
            links,
            run_id=run_id,
            program_factor_by_object=factors,
            sequence_t_ms=t_ms,
        )
        all_segments.extend(result.segments)
        errors.update(result.errors)
        warnings.update(result.warnings)

    if payload.persist_segments and not errors:
        # Same SimulationRun bootstrap as run_optical — see comment there.
        sim_run = SimulationRun(
            id=run_id,
            status="completed",
            warnings=sorted(warnings),
        )
        session.add(sim_run)
        # Wipe prior segments belonging to this run-id's links; we keep CW runs
        # untouched so the user can compare. (CW run uses a different run_id.)
        link_ids = [link.id for link in links]
        if link_ids:
            await session.execute(
                delete(BeamSegment).where(BeamSegment.optical_link_id.in_(link_ids))
            )
        for segment in all_segments:
            session.add(BeamSegment(**segment))
        await session.commit()

    response = TransientRunResponse(
        run_id=run_id,
        sample_count=n_steps,
        segment_count=len(all_segments),
        object_traces=[
            TransientObjectTrace(object_id=oid, points=points)
            for oid, points in object_traces.items()
        ],
        errors=sorted(errors),
        warnings=sorted(warnings),
    )
    await manager.broadcast(
        "optical_transient.completed",
        response.model_dump(mode="json", by_alias=True),
    )
    if payload.persist_segments and not errors:
        await manager.broadcast("scene.reload", {"reason": "optical_transient"})
    return response
