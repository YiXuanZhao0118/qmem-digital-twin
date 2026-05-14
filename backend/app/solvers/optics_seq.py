"""Optics sequential ray-trace solver — multiphysics SolverRunner adapter.

Wraps the existing ``app.solvers.optical_solver.solve_chain`` into the shape
expected by the multiphysics runner abstraction:

- ``hydrate_laser_kind_params`` is the V2 Phase 3 (alembic 0029) translator
  boundary. It used to live in ``app.routers.simulations`` as a private
  helper; it has been promoted here so both the legacy
  ``POST /api/simulations/optical/run`` endpoint and the new multiphysics
  ``POST /api/simulation-runs`` flow can share one source of truth.

- ``run`` is the SolverRunner-callable entrypoint. It mutates the queued
  ``SimulationRun`` row in place (status / progress / warnings / result_summary
  / finished_at / error_message) and persists ``BeamSegment`` rows pointing
  at this run. The caller (the runner) commits.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import (
    BeamSegment,
    PhysicsElement,
    OpticalLink,
    SceneObject,
    SimulationRun,
)
from app.solvers.optical_solver import solve_chain
from app.v2_bindings import get_optical_source, legacy_laser_kind_params_from_beam
from app.websocket import manager


def hydrate_laser_kind_params(
    elements: list[PhysicsElement],
    objects_by_id: dict,
) -> None:
    """V2 Phase 3 (alembic 0029) translator boundary.

    The solver's emit-from-laser path still consumes the legacy laser
    kindParams shape. After Phase 3 the DB no longer stores those fields —
    the V2 source of truth is ``objects.properties.opticalSources[].beam``.
    Right before invoking solve_chain we translate the V2 source back into
    the legacy shape and overwrite the in-memory PhysicsElement.kind_params
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


# AD9959 single-ended into 50 Ω at default Rset has ~1.0 Vpp full-scale.
# Keep this in sync with `VPP_FULL_SCALE` in frontend RfLinkPanel.tsx and
# any solver that assumes Vpp ↔ amplitude_scale conversion.
_AD9959_VPP_FULL_SCALE = 1.0
_RF_LOAD_Z_OHM = 50.0


def hydrate_aom_rf_drive(
    elements: list[PhysicsElement],
    objects_by_id: dict,
) -> None:
    """Phase B (RF link single-source-of-truth) translator.

    The AOM's RF carrier frequency and drive power are no longer stored on
    the AOM itself — they are resolved at solve time from the upstream
    rf_source channel via the AOM's rf_in ``rfCableEndpoints`` link. This
    helper walks every rf_cable SceneObject in the scene, identifies cables
    whose endpoints span an rf_source ↔ AOM pair, and injects the matching
    channel's ``frequencyMhz`` + Vpp-derived ``rfDrivePowerW`` into the
    AOM's in-memory ``kind_params``. ``apply_aom`` then reads them as if
    they were stored fields.

    Vpp ↔ W conversion: Vpp = amp × 1.0 V_full_scale; P = Vpp²/(8·Z).

    AOMs whose rf_in has no upstream cable get no injection; their
    ``apply_aom`` falls back to the 80 MHz / baseEfficiency code path
    (mirrors the pre-Phase-B default behaviour for orphan AOMs).

    Mutation is in-memory only — DB rows stay clean of these fields.
    """
    aom_object_ids: set = {
        e.object_id for e in elements if e.element_kind == "aom"
    }
    if not aom_object_ids:
        return
    # Index rf_source channels by (object_id, anchor_name) for O(1) lookup.
    channel_by_source_anchor: dict[tuple, dict] = {}
    for e in elements:
        if e.element_kind != "rf_source":
            continue
        for ch in (e.kind_params or {}).get("channels") or []:
            name = ch.get("anchorName")
            if name is None:
                continue
            channel_by_source_anchor[(e.object_id, name)] = ch
    # Walk every rf_cable SceneObject. A cable's `rfCableEndpoints.{A,B}`
    # are the bidirectional link records (target_object_id + target_anchor).
    # Cables that don't bridge a source→AOM pair are ignored.
    for obj in objects_by_id.values():
        props = getattr(obj, "properties", None) or {}
        eps = props.get("rfCableEndpoints") if isinstance(props, dict) else None
        if not isinstance(eps, dict):
            continue
        a = eps.get("A")
        b = eps.get("B")
        if not isinstance(a, dict) or not isinstance(b, dict):
            continue
        # Coerce id strings to uuid via objects_by_id key type.
        for src, tgt in ((a, b), (b, a)):
            try:
                tgt_id = type(next(iter(objects_by_id.keys())))(tgt["targetObjectId"])
                src_id = type(next(iter(objects_by_id.keys())))(src["targetObjectId"])
            except (KeyError, ValueError, StopIteration):
                continue
            if tgt_id not in aom_object_ids:
                continue
            ch = channel_by_source_anchor.get((src_id, src.get("targetAnchorName")))
            if ch is None:
                continue
            freq_mhz = float(ch.get("frequencyMhz", 80.0))
            amp_scale = float(ch.get("amplitudeScale", 1.0))
            vpp = amp_scale * _AD9959_VPP_FULL_SCALE
            drive_power_w = (vpp * vpp) / (8.0 * _RF_LOAD_Z_OHM)
            # Find the AOM PhysicsElement and inject.
            for e in elements:
                if e.object_id != tgt_id or e.element_kind != "aom":
                    continue
                merged = {
                    **(e.kind_params or {}),
                    "centerFreqMhz": freq_mhz,
                    "rfDrivePowerW": drive_power_w,
                }
                # Clamp to safety max if specified.
                rf_max = merged.get("rfPowerMaxW")
                if isinstance(rf_max, (int, float)) and rf_max > 0:
                    merged["rfDrivePowerW"] = min(merged["rfDrivePowerW"], float(rf_max))
                e.kind_params = merged
                break


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
    """Run the sequential ray-trace solver against the current scene state.

    Mutates ``sim_run`` in place. Persists fresh ``BeamSegment`` rows
    referencing ``sim_run.id`` (replacing any prior segments for the same
    optical_links so the table doesn't grow unbounded).

    On error: sets status='failed' + error_message + finished_at, broadcasts
    the status change, and re-raises so the runner sees it. The caller
    (runner) is responsible for committing the session in BOTH success and
    failure branches.
    """
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast_status(sim_run)

    try:
        elements = list((await session.scalars(select(PhysicsElement))).all())
        links = list((await session.scalars(select(OpticalLink))).all())
        objects_by_id = {
            obj.id: obj
            for obj in (await session.scalars(select(SceneObject))).all()
        }
        hydrate_laser_kind_params(elements, objects_by_id)
        hydrate_aom_rf_drive(elements, objects_by_id)

        result = solve_chain(elements, links, run_id=sim_run.id)

        sim_run.warnings = list(result.warnings)

        if result.errors:
            sim_run.status = "failed"
            sim_run.error_message = "; ".join(result.errors)
        else:
            link_ids = [link.id for link in links]
            if link_ids:
                await session.execute(
                    delete(BeamSegment).where(BeamSegment.optical_link_id.in_(link_ids))
                )
            for segment in result.segments:
                session.add(BeamSegment(**segment))
            sim_run.status = "completed"
            sim_run.progress = 1.0
            sim_run.result_summary = {
                "segmentCount": len(result.segments),
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
