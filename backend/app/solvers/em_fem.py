"""EM FEM solver — Phase C.5.

Mock-mode palace adapter. The real palace dispatch (over SSH to a WSL2
workstation running ``docker run awslabs/palace:latest``) lands in
Phase C.4 once the workstation runner agent is up.

For now ``run`` accepts an EmProblem id, samples its frequency sweep,
and writes a synthetic Lorentzian S-parameter response into
``sim_run.result_summary`` in the same shape Phase B.7's Touchstone
parser produces — so the frontend Smith chart + magnitude plot can
visualize EM runs without any palace install.

When palace lands, this file's ``run`` becomes a thin wrapper that
delegates to ``SshWorkstationRunner``; the result_summary contract
stays unchanged.
"""

from __future__ import annotations

import math
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import EmProblem, SimulationRun
from app.websocket import manager


class EmSolverError(Exception):
    """Raised when the EM problem isn't solveable as configured."""


# ---- public entrypoint -----------------------------------------------------


async def run(session: AsyncSession, sim_run: SimulationRun) -> None:
    """Mock palace run.

    Required ``sim_run.params``:
        emProblemId  (str | UUID): which EmProblem row to solve.
    """
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)

    try:
        em = await _load_em_problem(session, sim_run.params or {})

        sweep = em.freq_range_ghz or {}
        start_ghz = float(sweep.get("startGhz") or sweep.get("start_ghz") or 1.0)
        stop_ghz = float(sweep.get("stopGhz") or sweep.get("stop_ghz") or 10.0)
        n_points = int(sweep.get("points") or 51)
        scale = sweep.get("scale", "linear")

        if stop_ghz <= start_ghz:
            raise EmSolverError("freqRangeGhz.stopGhz must be > startGhz")
        if n_points < 2 or n_points > 10001:
            raise EmSolverError(f"freqRangeGhz.points out of range: {n_points}")

        ports = list(em.ports or [])
        n_ports = max(1, len(ports))

        freq_hz = _build_freq_axis(start_ghz, stop_ghz, n_points, scale)
        s_params = _mock_s_matrix(freq_hz, n_ports, start_ghz, stop_ghz)

        sim_run.status = "completed"
        sim_run.progress = 1.0
        sim_run.warnings = []
        sim_run.result_summary = {
            "emProblemId": str(em.id),
            "emProblemName": em.name,
            "solverNote": "Phase C.5 mock palace output (synthetic Lorentzian)",
            "nPorts": n_ports,
            "z0": (
                float(ports[0].get("impedanceOhm", 50.0)) if ports else 50.0
            ),
            "freqHz": freq_hz,
            "sParams": s_params,
            "ports": ports,
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


async def _load_em_problem(session: AsyncSession, params: dict) -> EmProblem:
    raw_id = params.get("emProblemId") or params.get("em_problem_id")
    if not raw_id:
        raise EmSolverError("params.emProblemId is required")
    try:
        em_uuid = uuid.UUID(str(raw_id))
    except (ValueError, AttributeError) as exc:
        raise EmSolverError(f"invalid emProblemId: {raw_id!r} ({exc})") from exc
    em = await session.get(EmProblem, em_uuid)
    if em is None:
        raise EmSolverError(f"EmProblem {em_uuid} not found")
    return em


def _build_freq_axis(
    start_ghz: float, stop_ghz: float, n_points: int, scale: str
) -> list[float]:
    if scale == "log":
        log_start = math.log10(start_ghz * 1e9)
        log_stop = math.log10(stop_ghz * 1e9)
        step = (log_stop - log_start) / (n_points - 1)
        return [10.0 ** (log_start + i * step) for i in range(n_points)]
    step = (stop_ghz - start_ghz) * 1e9 / (n_points - 1)
    return [start_ghz * 1e9 + i * step for i in range(n_points)]


def _mock_s_matrix(
    freq_hz: list[float],
    n_ports: int,
    start_ghz: float,
    stop_ghz: float,
) -> dict[str, list[list[float]]]:
    """Synthetic single-pole resonance: peak in |S21|, dip in |S11| at f0.

    Good enough to exercise the Smith chart + magnitude plot pipeline
    without involving palace at all.
    """
    f0 = (start_ghz + stop_ghz) * 0.5e9  # resonance at sweep midpoint
    bw = (stop_ghz - start_ghz) * 0.1e9  # ~10% sweep span
    s_params: dict[str, list[list[float]]] = {}

    for i in range(n_ports):
        for j in range(n_ports):
            key = f"s{i + 1}{j + 1}"
            row: list[list[float]] = []
            for f in freq_hz:
                # Lorentzian denominator centered on f0.
                denom_re = 1.0
                denom_im = (f - f0) / max(bw, 1.0)
                denom_mag2 = denom_re * denom_re + denom_im * denom_im
                if i == j:
                    # Reflection: dip near f0, asymptotes to ~0.5 magnitude.
                    re_part = 0.5 - (1.0 / denom_mag2) * 0.4
                    im_part = -(denom_im / denom_mag2) * 0.4
                else:
                    # Transmission: peak near f0 reaching ~1.0 mag, falls
                    # off to small value off-resonance.
                    re_part = (1.0 / denom_mag2) * 0.9
                    im_part = -(denom_im / denom_mag2) * 0.9
                row.append([round(re_part, 6), round(im_part, 6)])
            s_params[key] = row
    return s_params


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
