from __future__ import annotations

import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models import (
    Asset3D,
    BeamSegment,
    Component,
    DeviceState,
    PhysicsElement,
    OpticalLink,
    SceneObject,
    SimulationRun,
)
from app.schemas import CamelModel
from app.solvers.optical_solver import solve_chain
from app.solvers.optics_seq import (
    hydrate_aom_rf_drive,
    hydrate_laser_kind_params,
    hydrate_waveplate_fast_axis,
)
from app.websocket import manager


router = APIRouter()


class OpticalRunResponse(CamelModel):
    run_id: uuid.UUID
    segment_count: int
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


@router.post("/optical/run", response_model=OpticalRunResponse, status_code=status.HTTP_200_OK)
async def run_optical(session: AsyncSession = Depends(get_session)) -> OpticalRunResponse:
    """Run the production optical simulation (Phase 7.4: now v3-backed).

    The endpoint contract is preserved (run_id + segment_count + errors +
    warnings) but the underlying solver is now ``solve_v3_scene``. Old
    PhysicsElement.kind_params hydrators are bypassed because v3 reads
    physics directly from Asset3D faces / transitions / default_params
    (and per-instance overrides via dynamic_sources).

    BeamSegment persistence is skipped: the legacy table is keyed on
    optical_link_id, but v3 has no optical_link concept (the tracer is
    pure geometric). Persisting v3 results to a new table is a follow-up.
    A warning is emitted so callers know not to expect new
    beam_segments rows.
    """
    # Phase 9.8 — production simulation now runs through anchor tracer.
    from app.optical import anchor_ops  # noqa: F401
    from app.optical.anchor_tracer import AnchorTraceOptions
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.solver_v3 import solve_anchor_scene

    scene = await load_anchor_scene_from_db(session)
    result = solve_anchor_scene(scene, [], AnchorTraceOptions())

    payload = OpticalRunResponse(
        run_id=result.run_id,
        segment_count=len(result.lab_segments),
        errors=list(result.errors),
        warnings=list(result.warnings) + [
            "v3 endpoint — BeamSegment table persistence is deferred; "
            "consumers should read /api/v3/solver/run-from-db instead.",
        ],
    )
    await manager.broadcast(
        "optical_simulation.completed",
        payload.model_dump(mode="json", by_alias=True),
    )
    # No DB writes happen on this path anymore; skip the scene.reload
    # broadcast so clients don't churn waiting for non-existent rows.
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

    elements = list((await session.scalars(select(PhysicsElement))).all())
    links = list((await session.scalars(select(OpticalLink))).all())
    objects_by_id = {
        obj.id: obj for obj in (await session.scalars(select(SceneObject))).all()
    }
    components_by_id = {
        c.id: c for c in (await session.scalars(select(Component))).all()
    }
    assets_by_id = {
        a.id: a for a in (await session.scalars(select(Asset3D))).all()
    }
    device_states = list((await session.scalars(select(DeviceState))).all())
    hydrate_laser_kind_params(elements, objects_by_id)
    hydrate_aom_rf_drive(elements, objects_by_id, device_states=device_states)
    hydrate_waveplate_fast_axis(
        elements, objects_by_id, components_by_id=components_by_id, assets_by_id=assets_by_id,
    )

    # alembic 0045: TimingProgram is no longer per-object. Per-object gating
    # factors now come from each object's properties.rfSources[].signal.gateBinding
    # (or laser equivalent), which resolves a TimingProgram by id. That binding
    # resolver hasn't landed yet — until it does, the transient path runs
    # ungated (factor = 1.0 everywhere) and emits empty object_traces.
    run_id = uuid.uuid4()
    all_segments: list[dict] = []
    object_traces: dict[uuid.UUID, list[TransientTracePoint]] = {}
    errors: set[str] = set()
    warnings: set[str] = set()

    for step in range(n_steps):
        t_ns = payload.t_start_ns + step * payload.dt_ns
        t_ms = t_ns / 1.0e6

        factors: dict[uuid.UUID, float] = {obj_id: 1.0 for obj_id in objects_by_id}

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
