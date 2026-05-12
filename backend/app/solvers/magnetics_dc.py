"""DC magnetostatic solver — Phase F+.

Wraps magpylib (Biot-Savart for arbitrary current sources) into the
SolverRunner contract. Reads a MagneticsProblem (eval region + list of
Coil ids), builds magpylib sources from each Coil + linked SceneObject
pose, computes the net B-field on the eval grid, writes the result into
``sim_run.result_summary.field`` in the same shape Phase C.8 mock palace
uses — so the existing FieldViewer (vtk.js volume) renders it without
any change.

Vector field components (Bx/By/Bz) are kept alongside the |B| scalar so
the frontend can also render streamlines (Phase F+ frontend addition).

magpylib uses SI units (m, A, mT). We convert mm → m on the way in and
emit mT → mT (no conversion) so |B| values are intuitively scaled.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone
from typing import Any

import numpy as np
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Coil, MagneticsProblem, SceneObject, SimulationRun
from app.websocket import manager


class MagneticsSolverError(Exception):
    pass


# ---- public entrypoint -----------------------------------------------------


async def run(session: AsyncSession, sim_run: SimulationRun) -> None:
    """Run the magpylib DC magnetostatic solver.

    Required ``sim_run.params``:
        magneticsProblemId  (str | UUID)
    """
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)

    try:
        try:
            import magpylib as magpy
        except ImportError as exc:
            raise MagneticsSolverError(
                "magpylib not installed (pip install magpylib)"
            ) from exc

        problem = await _load_problem(session, sim_run.params or {})
        coils = await _load_coils(session, problem.coil_ids or [])
        if not coils:
            raise MagneticsSolverError("no coils selected for this problem")

        # Build magpylib Collection from coils + linked SceneObject poses.
        sources = []
        scene_objects: dict[uuid.UUID, SceneObject] = {}
        scene_obj_ids = [c.scene_object_id for c in coils if c.scene_object_id]
        if scene_obj_ids:
            rows = (
                await session.scalars(
                    select(SceneObject).where(SceneObject.id.in_(scene_obj_ids))
                )
            ).all()
            scene_objects = {row.id: row for row in rows}

        for coil in coils:
            scene_obj = (
                scene_objects.get(coil.scene_object_id)
                if coil.scene_object_id
                else None
            )
            sources.extend(_build_magpylib_sources(coil, scene_obj, magpy))

        if not sources:
            raise MagneticsSolverError(
                "no magpylib sources built — check coil shape / params"
            )

        coll = magpy.Collection(sources)

        # Eval grid in mm (frontend-facing) → magpylib needs metres.
        region = problem.eval_region or {}
        center = tuple(
            float(v) for v in (region.get("centerMm") or region.get("center_mm") or (0, 0, 0))
        )
        size = tuple(
            float(v) for v in (region.get("sizeMm") or region.get("size_mm") or (200, 200, 200))
        )
        grid = tuple(
            int(v) for v in (region.get("gridDim") or region.get("grid_dim") or (24, 24, 24))
        )
        nx, ny, nz = grid
        if min(grid) < 2 or max(grid) > 96:
            raise MagneticsSolverError(
                f"gridDim out of range: {grid} (each axis must be 2..96)"
            )

        cx, cy, cz = center
        sx, sy, sz = size
        # Linspace endpoints inclusive — first/last cell are at the box edges.
        xs_mm = np.linspace(cx - sx * 0.5, cx + sx * 0.5, nx)
        ys_mm = np.linspace(cy - sy * 0.5, cy + sy * 0.5, ny)
        zs_mm = np.linspace(cz - sz * 0.5, cz + sz * 0.5, nz)

        # Row-major flatten so the data array index = (k * ny + j) * nx + i.
        # That matches vtk.js ImageData scalar layout when dim = [nx, ny, nz].
        positions_mm = np.stack(
            np.meshgrid(xs_mm, ys_mm, zs_mm, indexing="ij"), axis=-1
        ).reshape(-1, 3)
        positions_m = positions_mm * 1e-3

        # magpylib v5 returns Tesla. Convert to mT for human-readable lab
        # values (typical Helmholtz, MOT-coil fields are mT–µT range).
        try:
            B_T = coll.getB(positions_m)
        except Exception as exc:  # noqa: BLE001
            raise MagneticsSolverError(f"magpylib getB failed: {exc}") from exc

        B_T = np.asarray(B_T)
        if B_T.ndim != 2 or B_T.shape[1] != 3:
            raise MagneticsSolverError(
                f"unexpected B shape from magpylib: {B_T.shape!r}"
            )
        B_mT = B_T * 1000.0  # T → mT

        bx = B_mT[:, 0].tolist()
        by = B_mT[:, 1].tolist()
        bz = B_mT[:, 2].tolist()
        bmag = np.linalg.norm(B_mT, axis=1).tolist()

        # Scalar grid for FieldViewer volume + vector arrays for streamlines.
        # Keep the same flat layout (k*ny+j)*nx+i across all four arrays.
        sim_run.status = "completed"
        sim_run.progress = 1.0
        sim_run.warnings = []
        sim_run.result_summary = {
            "magneticsProblemId": str(problem.id),
            "magneticsProblemName": problem.name,
            "coilCount": len(coils),
            "solverNote": "magpylib Biot-Savart (DC magnetostatic)",
            "field": {
                "available": True,
                "format": "scalar-grid",
                "dim": [nx, ny, nz],
                "spacingMm": [
                    sx / max(nx - 1, 1),
                    sy / max(ny - 1, 1),
                    sz / max(nz - 1, 1),
                ],
                "originMm": [cx - sx * 0.5, cy - sy * 0.5, cz - sz * 0.5],
                "data": [round(v, 6) for v in bmag],
                "label": "|B| (mT)",
                "vectors": {
                    "bx": [round(v, 6) for v in bx],
                    "by": [round(v, 6) for v in by],
                    "bz": [round(v, 6) for v in bz],
                },
            },
        }
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast(sim_run)
    except Exception as exc:
        sim_run.status = "failed"
        sim_run.error_message = f"{type(exc).__name__}: {exc}"
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast(sim_run)
        raise


# ---- helpers ---------------------------------------------------------------


async def _load_problem(
    session: AsyncSession, params: dict[str, Any]
) -> MagneticsProblem:
    raw_id = params.get("magneticsProblemId") or params.get("magnetics_problem_id")
    if not raw_id:
        raise MagneticsSolverError("params.magneticsProblemId is required")
    try:
        problem_uuid = uuid.UUID(str(raw_id))
    except (ValueError, AttributeError) as exc:
        raise MagneticsSolverError(f"invalid magneticsProblemId: {raw_id!r}") from exc
    problem = await session.get(MagneticsProblem, problem_uuid)
    if problem is None:
        raise MagneticsSolverError(f"MagneticsProblem {problem_uuid} not found")
    return problem


async def _load_coils(
    session: AsyncSession, coil_ids: list[Any]
) -> list[Coil]:
    parsed: list[uuid.UUID] = []
    for raw in coil_ids:
        try:
            parsed.append(uuid.UUID(str(raw)))
        except (ValueError, AttributeError):
            continue
    if not parsed:
        return []
    rows = (
        await session.scalars(select(Coil).where(Coil.id.in_(parsed)))
    ).all()
    return list(rows)


def _build_magpylib_sources(coil: Coil, scene_obj: SceneObject | None, magpy) -> list:
    """Build magpylib sources for one Coil. Multi-turn = stack N loops at
    the same place (current * N is also valid; stacking is more honest)."""
    params = coil.params or {}
    if scene_obj is not None:
        position_mm = (
            float(scene_obj.x_mm or 0.0),
            float(scene_obj.y_mm or 0.0),
            float(scene_obj.z_mm or 0.0),
        )
    else:
        pm = params.get("positionMm") or [0.0, 0.0, 0.0]
        position_mm = (float(pm[0]), float(pm[1]), float(pm[2]))
    position_m = tuple(p * 1e-3 for p in position_mm)

    # magpylib v5 has both Loop and Polyline under magpylib.current.
    # For circular_loop use Loop; for solenoid build a helix Polyline;
    # for polyline use the explicit point list.
    sources: list = []
    shape = (coil.shape or "circular_loop").lower()

    if shape == "circular_loop":
        radius_mm = float(params.get("radiusMm", 50.0))
        turns = int(params.get("turns", 1))
        diameter_m = 2 * radius_mm * 1e-3
        for _ in range(max(turns, 1)):
            sources.append(
                magpy.current.Circle(
                    current=float(coil.current_a),
                    diameter=diameter_m,
                    position=position_m,
                )
            )
    elif shape == "solenoid":
        radius_mm = float(params.get("radiusMm", 50.0))
        length_mm = float(params.get("lengthMm", 100.0))
        turns = int(params.get("turns", 50))
        # Build a helix polyline along +Z, centred on position_m.
        z_start = position_m[2] - length_mm * 0.5e-3
        z_end = position_m[2] + length_mm * 0.5e-3
        n_segments = max(turns * 24, 24)
        ts = np.linspace(0, turns * 2 * math.pi, n_segments)
        zs = np.linspace(z_start, z_end, n_segments)
        r_m = radius_mm * 1e-3
        pts = [
            (
                position_m[0] + r_m * math.cos(t),
                position_m[1] + r_m * math.sin(t),
                z,
            )
            for t, z in zip(ts, zs)
        ]
        sources.append(
            magpy.current.Polyline(
                current=float(coil.current_a),
                vertices=pts,
            )
        )
    elif shape == "polyline":
        raw_pts = params.get("pointsMm") or []
        pts = [(float(p[0]) * 1e-3, float(p[1]) * 1e-3, float(p[2]) * 1e-3) for p in raw_pts]
        if len(pts) < 2:
            raise MagneticsSolverError(
                f"polyline coil {coil.id} needs >=2 points"
            )
        sources.append(
            magpy.current.Polyline(
                current=float(coil.current_a),
                vertices=pts,
            )
        )
    else:
        raise MagneticsSolverError(f"unsupported coil shape: {coil.shape!r}")

    return sources


async def _broadcast(sim_run: SimulationRun) -> None:
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
