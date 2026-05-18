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
    Asset3D,
    BeamSegment,
    Component,
    DeviceState,
    PhysicsElement,
    OpticalLink,
    SceneObject,
    SimulationRun,
    TimingProgram,
)
from app.solvers.optical_solver import solve_chain
from app.solvers.rf_propagation import (
    AD9959_VPP_FULL_SCALE,
    RF_LOAD_Z_OHM,
    anchor_lookup_name,
    build_rf_propagation,
    find_anchor_by_role,
    vpp_to_power_w,
)
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


# Backwards-compat aliases. New code should import these from
# ``app.solvers.rf_propagation`` directly. Kept here so consumers that
# pinned to the old optics_seq module path keep working.
_AD9959_VPP_FULL_SCALE = AD9959_VPP_FULL_SCALE
_RF_LOAD_Z_OHM = RF_LOAD_Z_OHM


def hydrate_waveplate_fast_axis(
    elements: list[PhysicsElement],
    objects_by_id: dict,
    components_by_id: dict | None = None,
    assets_by_id: dict | None = None,
) -> None:
    """2026-05-18 refactor: fast-axis composition for waveplates.

    Effective Jones-frame angle = Asset3D.intercept_in.fast_axis_deg_body_local
    (PHY Editor → Optical → Components) + SceneObject.properties.
    rotationAroundBeamAxisDeg (Object pane knob). The solver's
    apply_waveplate consumes ``kindParams.fastAxisDegBeamLocal``; we
    synthesise that key here so the solver runs unchanged.

    Mutation is in-memory only — DB rows stay clean of these fields.
    """
    for e in elements:
        if e.element_kind != "waveplate":
            continue
        scene_object = objects_by_id.get(e.object_id)
        if scene_object is None:
            continue
        comp = (components_by_id or {}).get(getattr(scene_object, "component_id", None))
        asset = (assets_by_id or {}).get(getattr(comp, "asset_3d_id", None)) if comp is not None else None
        anchors = list(getattr(asset, "anchors", None) or [])
        base = 0.0
        for a in anchors:
            anchor_id = a.get("id") if isinstance(a, dict) else getattr(a, "id", None)
            if anchor_id != "intercept_in":
                continue
            raw = a.get("fastAxisDegBodyLocal") if isinstance(a, dict) else getattr(a, "fast_axis_deg_body_local", None)
            if isinstance(raw, (int, float)):
                base = float(raw)
            break
        props = getattr(scene_object, "properties", None) or {}
        rot = props.get("rotationAroundBeamAxisDeg") if isinstance(props, dict) else None
        instance = float(rot) if isinstance(rot, (int, float)) else 0.0
        merged = {**(e.kind_params or {}), "fastAxisDegBeamLocal": base + instance}
        e.kind_params = merged


def hydrate_aom_rf_drive(
    elements: list[PhysicsElement],
    objects_by_id: dict,
    components_by_id: dict | None = None,
    assets_by_id: dict | None = None,
    timing_programs_by_id: dict | None = None,
    device_states: list | None = None,
) -> None:
    """Phase B (RF link single-source-of-truth) translator, Phase 1 multi-hop.

    The AOM's RF carrier frequency and drive power are not stored on the
    AOM itself — they are resolved at solve time from the upstream
    rf_source channel by walking the rf_cable graph. Phase 1 generalised
    the walk from "direct source→AOM only" to a full BFS through any
    number of passthrough nodes (rf_amplifier today); the traversal lives
    in ``app.solvers.rf_propagation`` and this helper just looks up the
    AOM's rf_in port in the resulting signal map.

    Vpp ↔ W conversion: Vpp = amp × 1.0 V_full_scale; P = Vpp²/(8·Z).

    AOMs whose rf_in has no upstream cable get no injection; their
    ``apply_aom`` falls back to the 80 MHz / baseEfficiency code path
    (mirrors the pre-Phase-B default behaviour for orphan AOMs).

    Multi-hop fallback: when ``components_by_id`` / ``assets_by_id`` are
    not supplied (legacy callers), the propagation degrades to "no
    passthroughs known", which still handles direct source→AOM cables
    correctly. The full multi-hop behaviour requires both maps so
    amplifier output anchors can be resolved.

    Mutation is in-memory only — DB rows stay clean of these fields.
    """
    aom_object_ids: set = {
        e.object_id for e in elements if e.element_kind == "aom"
    }
    if not aom_object_ids:
        return
    # Instrument Power panel cascade: an rf_source / rf_amplifier / rf_switch
    # whose DeviceState.state.power is False produces / passes no signal.
    # Computed here (not inside build_rf_propagation) so the propagation
    # solver stays oblivious to the DB row format.
    powered_off_object_ids: set = set()
    for ds in device_states or []:
        power = ((getattr(ds, "state", None) or {}) or {}).get("power")
        if power is False:
            powered_off_object_ids.add(getattr(ds, "object_id", None))
    prop = build_rf_propagation(
        objects_by_id=objects_by_id,
        elements=elements,
        components_by_id=components_by_id or {},
        assets_by_id=assets_by_id or {},
        timing_programs_by_id=timing_programs_by_id,
        powered_off_object_ids=powered_off_object_ids,
    )
    for e in elements:
        if e.element_kind != "aom":
            continue
        # Resolve the AOM's rf_in anchor name from its asset anchors —
        # falls back to literal "rf_in" if the asset isn't loaded, which
        # matches the most common asset author convention.
        comp = (components_by_id or {}).get(getattr(objects_by_id.get(e.object_id), "component_id", None))
        asset = (assets_by_id or {}).get(getattr(comp, "asset_3d_id", None)) if comp is not None else None
        anchors = list(getattr(asset, "anchors", None) or [])
        rf_in = find_anchor_by_role(anchors, "rf_in")
        rf_in_name = anchor_lookup_name(rf_in) if rf_in is not None else "rf_in"
        signal = prop.signal_at_port.get((e.object_id, rf_in_name))
        if signal is None:
            continue
        drive_power_w = vpp_to_power_w(signal.vpp)
        merged = {
            **(e.kind_params or {}),
            "centerFreqMhz": signal.frequency_mhz,
            "rfDrivePowerW": drive_power_w,
        }
        # Clamp to safety max if specified — keeps Bragg solver from
        # blowing past the crystal damage threshold even when an upstream
        # ZHL-1-2W could in principle deliver more.
        rf_max = merged.get("rfPowerMaxW")
        if isinstance(rf_max, (int, float)) and rf_max > 0:
            merged["rfDrivePowerW"] = min(merged["rfDrivePowerW"], float(rf_max))
        e.kind_params = merged


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
        # Components + Assets are needed by the multi-hop RF propagation
        # (it resolves rf_in/rf_out anchor names from the asset). Loading
        # all rows is fine — the catalog is bounded (tens of rows for a
        # typical scene) and we already load the whole PhysicsElement set.
        components_by_id = {
            c.id: c for c in (await session.scalars(select(Component))).all()
        }
        assets_by_id = {
            a.id: a for a in (await session.scalars(select(Asset3D))).all()
        }
        # TimingPrograms feed the rf_switch TTL steady-state resolver:
        # when a switch's ttl_in is wired to a PPG, the PPG's bound program
        # at t=0 decides HIGH/LOW which in turn picks the active throw.
        timing_programs_by_id = {
            p.id: p for p in (await session.scalars(select(TimingProgram))).all()
        }
        # DeviceStates carry the Instrument Power panel toggle (state.power).
        # Loaded here so the RF propagation can gate AD9959 / ZHL / ZYSWA at
        # solve time when the user has switched them off.
        device_states = list((await session.scalars(select(DeviceState))).all())
        hydrate_laser_kind_params(elements, objects_by_id)
        hydrate_aom_rf_drive(
            elements,
            objects_by_id,
            components_by_id,
            assets_by_id,
            timing_programs_by_id=timing_programs_by_id,
            device_states=device_states,
        )

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
