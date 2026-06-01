"""Optics solver — multiphysics SolverRunner adapter (v3 anchor tracer).

Phase 9.8 retirement: the legacy ``solve_chain`` / per-object
``physics_elements.kind_params`` path is gone. This adapter now drives the
**v3 anchor tracer**, which reads physics from ``Asset3D.default_params`` and
per-instance overrides from ``SceneObject.dynamic_sources``.

``run`` is the SolverRunner-callable entrypoint behind
``POST /api/simulation-runs`` (module="optics_seq", the Lab "Run" button). It
mutates the queued ``SimulationRun`` row in place (status / progress /
warnings / result_summary / finished_at / error_message); the caller (runner)
commits. No ``BeamSegment`` rows are written — the 3D lab beam is rendered by
the frontend straight from ``/api/v3/solver/run-from-db``.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import SimulationRun
from app.websocket import manager


async def _broadcast_status(sim_run: SimulationRun) -> None:
    await manager.broadcast(
        "simulation_run.status_changed",
        {
            "id": str(sim_run.id),
            "module": sim_run.module,
            "status": sim_run.status,
            "progress": sim_run.progress,
            "errorMessage": sim_run.error_message,
        },
    )


async def run(
    session: AsyncSession,
    sim_run: SimulationRun,
) -> None:
    """Run the v3 anchor tracer against the current scene; mutate ``sim_run``.

    On error: sets status='failed' + error_message + finished_at, broadcasts
    the status change, and re-raises so the runner sees it. The caller
    (runner) commits the session in BOTH success and failure branches.
    """
    from app.optical import anchor_ops  # noqa: F401 — registers anchor ops
    from app.optical.anchor_tracer import AnchorTraceOptions
    from app.optical.db_scene_loader import load_anchor_scene_from_db
    from app.optical.solver import solve_anchor_scene

    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast_status(sim_run)

    try:
        scene = await load_anchor_scene_from_db(session)
        result = solve_anchor_scene(scene, [], AnchorTraceOptions())

        sim_run.warnings = list(result.warnings)
        if result.errors:
            sim_run.status = "failed"
            sim_run.error_message = "; ".join(result.errors)
        else:
            sim_run.status = "completed"
            sim_run.progress = 1.0
            sim_run.result_summary = {
                "segmentCount": len(result.lab_segments),
                "warningCount": len(result.warnings),
            }

        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast_status(sim_run)

        if not result.errors:
            await manager.broadcast(
                "scene.reload",
                {"reason": "simulation_run", "runId": str(sim_run.id)},
            )
    except Exception as exc:
        sim_run.status = "failed"
        sim_run.error_message = f"{type(exc).__name__}: {exc}"
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast_status(sim_run)
        raise
