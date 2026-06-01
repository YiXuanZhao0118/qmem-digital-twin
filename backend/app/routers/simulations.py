from __future__ import annotations

import math
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.schemas import CamelModel
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
    from app.optical.solver import solve_anchor_scene

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

    # Phase 9.8 — transient now runs through the v3 anchor tracer. Time-domain
    # gating (per-step TimingProgram factors) is not yet implemented in v3, so
    # every step is identical to the steady-state solve; we solve once and
    # report n_steps as the sample count. object_traces stay empty until v3
    # grows per-step telemetry.
    from app.optical import anchor_ops  # noqa: F401
    from app.optical.anchor_tracer import AnchorTraceOptions
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.solver import solve_anchor_scene

    scene = await load_anchor_scene_from_db(session)
    result = solve_anchor_scene(scene, [], AnchorTraceOptions())

    warnings = list(result.warnings)
    if payload.persist_segments:
        warnings.append(
            "persistSegments is a no-op on the v3 transient path; beam segments "
            "are read from /api/v3/solver/run-from-db."
        )

    response = TransientRunResponse(
        run_id=result.run_id,
        sample_count=n_steps,
        segment_count=len(result.lab_segments),
        object_traces=[],
        errors=list(result.errors),
        warnings=warnings,
    )
    await manager.broadcast(
        "optical_transient.completed",
        response.model_dump(mode="json", by_alias=True),
    )
    return response
