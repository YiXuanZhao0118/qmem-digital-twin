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

import json
import math
import shlex
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import EmProblem, Mesh, SimulationRun
from app.solvers.palace_io import build_palace_config, parse_palace_sparams
from app.websocket import manager


class EmSolverError(Exception):
    """Raised when the EM problem isn't solveable as configured."""


# ---- public entrypoint -----------------------------------------------------


async def run(session: AsyncSession, sim_run: SimulationRun) -> None:
    """Dispatch an EM run.

    If ``sim_run.runner_kind == 'ssh_workstation'`` AND
    ``settings.workstation_host`` is set, runs real palace over SSH +
    Docker on the lab workstation. Otherwise falls back to the mock
    Lorentzian generator that ships with Phase C.5 (so the UI is
    exercisable without the workstation).

    Required ``sim_run.params``:
        emProblemId  (str | UUID): which EmProblem row to solve.
    """
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)

    use_real_palace = (
        sim_run.runner_kind == "ssh_workstation"
        and bool(settings.workstation_host)
    )

    try:
        em = await _load_em_problem(session, sim_run.params or {})

        if use_real_palace:
            await _run_real_palace_via_ssh(session, sim_run, em)
        else:
            await _run_mock_palace(session, sim_run, em)
    except Exception as exc:
        sim_run.status = "failed"
        sim_run.error_message = f"{type(exc).__name__}: {exc}"
        sim_run.finished_at = datetime.now(timezone.utc)
        await session.flush()
        await _broadcast(sim_run)
        raise


# ---- mock palace -----------------------------------------------------------


async def _run_mock_palace(
    session: AsyncSession, sim_run: SimulationRun, em: EmProblem
) -> None:
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
        "field": _mock_field_payload(start_ghz, stop_ghz),
    }
    sim_run.finished_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)


# ---- real palace via SSH ---------------------------------------------------


async def _run_real_palace_via_ssh(
    session: AsyncSession, sim_run: SimulationRun, em: EmProblem
) -> None:
    """Drive palace on the workstation: build config, scp, docker run, scp back, parse."""
    if em.mesh_id is None:
        raise EmSolverError(
            "real palace dispatch requires a mesh: set EmProblem.mesh_id"
        )
    mesh = await session.get(Mesh, em.mesh_id)
    if mesh is None or not Path(mesh.file_path).exists():
        raise EmSolverError(f"mesh file not found on backend disk: {mesh and mesh.file_path}")

    # Lazy import — keep asyncssh out of the import path on dev machines
    # that never use ssh_workstation.
    try:
        import asyncssh
    except ImportError as exc:
        raise EmSolverError("asyncssh not installed (pip install asyncssh)") from exc

    host = settings.workstation_host
    key_path = settings.workstation_key_path
    image = settings.workstation_palace_image
    timeout_sec = settings.em_solver_timeout_sec

    palace_config = build_palace_config(em, mesh_path="/work/mesh.msh")

    connect_kwargs: dict[str, Any] = {"known_hosts": None}
    if key_path:
        connect_kwargs["client_keys"] = [key_path]

    async with asyncssh.connect(host, **connect_kwargs) as conn:
        # Make a remote work dir under /tmp.
        remote_dir = f"/tmp/qmem-em-{sim_run.id}"
        await conn.run(f"mkdir -p {shlex.quote(remote_dir)}", check=True)

        # SCP mesh + config.
        await asyncssh.scp(
            mesh.file_path,
            (conn, f"{remote_dir}/mesh.msh"),
        )
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as cfg_fh:
            json.dump(palace_config, cfg_fh, indent=2)
            local_cfg = cfg_fh.name
        try:
            await asyncssh.scp(
                local_cfg, (conn, f"{remote_dir}/config.json")
            )
        finally:
            try:
                Path(local_cfg).unlink()
            except OSError:
                pass

        sim_run.progress = 0.2
        await session.flush()
        await _broadcast(sim_run)

        # Run palace in Docker on the workstation. -v mounts the
        # remote_dir into /work inside the container.
        docker_cmd = (
            f"docker run --rm "
            f"-v {shlex.quote(remote_dir)}:/work "
            f"{shlex.quote(image)} "
            f"/work/config.json"
        )
        try:
            result = await asyncio_wait_for(
                conn.run(docker_cmd, check=False),
                timeout_sec,
            )
        except TimeoutError as exc:
            raise EmSolverError(
                f"palace timed out after {timeout_sec}s on {host}"
            ) from exc

        if result.exit_status != 0:
            stderr_tail = (result.stderr or "")[-1000:]
            raise EmSolverError(
                f"palace exit={result.exit_status} on {host}: {stderr_tail!r}"
            )

        sim_run.progress = 0.8
        await session.flush()
        await _broadcast(sim_run)

        # Pull palace's S-parameter CSV back. palace writes it to
        # ``postpro/port-S.csv`` relative to the Output dir set in
        # config (which we set to "postpro" -> ends up at
        # /work/postpro/port-S.csv inside container,
        # /tmp/.../postpro/port-S.csv on the host filesystem).
        with tempfile.TemporaryDirectory() as local_pull:
            local_csv = Path(local_pull) / "port-S.csv"
            try:
                await asyncssh.scp(
                    (conn, f"{remote_dir}/postpro/port-S.csv"),
                    str(local_csv),
                )
            except (OSError, asyncssh.SFTPError) as exc:
                raise EmSolverError(
                    f"palace S-param CSV not found on {host}: {exc}"
                ) from exc
            csv_text = local_csv.read_text(encoding="utf-8")

        parsed = parse_palace_sparams(csv_text)

        # Best-effort cleanup; ignore failures.
        try:
            await conn.run(f"rm -rf {shlex.quote(remote_dir)}", check=False)
        except Exception:  # noqa: BLE001
            pass

    sim_run.status = "completed"
    sim_run.progress = 1.0
    sim_run.warnings = []
    sim_run.result_summary = {
        "emProblemId": str(em.id),
        "emProblemName": em.name,
        "solverNote": f"palace via SSH on {host} (image: {image})",
        "nPorts": parsed["nPorts"],
        "z0": (
            float(em.ports[0].get("impedanceOhm", 50.0))
            if em.ports else 50.0
        ),
        "freqHz": parsed["freqHz"],
        "sParams": parsed["sParams"],
        "ports": list(em.ports or []),
        # Field payload carries enough metadata for the vtk.js viewer
        # to fetch the .pvtu via a separate result_blob_path endpoint.
        # Phase C.8+ wires the actual ParaView pull-down; for now just
        # tag the run with where the field lives on the workstation.
        "field": {
            "available": False,
            "format": "pvtu",
            "remoteHost": host,
            "remotePath": f"{remote_dir}/postpro/paraview",
            "note": "ParaView output pull-down lands in Phase C.8 follow-up",
        },
    }
    sim_run.finished_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)


# Local re-export — saves an `import asyncio` in the public surface.
async def asyncio_wait_for(awaitable, timeout):
    import asyncio as _aio
    return await _aio.wait_for(awaitable, timeout=timeout)


# ---- helpers ---------------------------------------------------------------


def _mock_field_payload(start_ghz: float, stop_ghz: float) -> dict[str, Any]:
    """Synthetic |E|^2 field on a 16x16x16 grid for the Phase C.8 viewer.

    Plain Python list-of-lists so JSONB storage works without numpy on
    the wire. Frontend vtk.js viewer reads ``data`` as flat array of
    n^3 scalars + ``dim`` as the grid size.
    """
    n = 16
    f0 = (start_ghz + stop_ghz) * 0.5
    cx = cy = cz = (n - 1) / 2
    sigma = n / 4.0
    data = []
    for k in range(n):
        for j in range(n):
            for i in range(n):
                r2 = ((i - cx) ** 2 + (j - cy) ** 2 + (k - cz) ** 2)
                # Gaussian blob — peak at centre, taper to zero at edges.
                val = math.exp(-r2 / (2.0 * sigma * sigma))
                data.append(round(val, 4))
    return {
        "available": True,
        "format": "scalar-grid",
        "dim": [n, n, n],
        "spacingMm": [1.0, 1.0, 1.0],
        "originMm": [-cx, -cy, -cz],
        "data": data,
        "label": f"|E|^2 (mock, peak ~{f0:.1f} GHz)",
    }


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
