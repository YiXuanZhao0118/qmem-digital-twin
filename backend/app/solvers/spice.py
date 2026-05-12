"""SPICE solver — Phase B.2 of the multiphysics platform.

Wraps the ``ngspice`` binary (Phase B installs v41 via choco) into the
SolverRunner contract. The solver:

  1. Reads ``params.circuitId`` from the SimulationRun, looks up the
     Circuit row, grabs its ``netlist`` text.
  2. Spawns ngspice in batch mode (``-b -r raw -o log``) on a temp file.
  3. Parses ngspice's binary raw output into per-variable arrays.
  4. Stuffs the arrays into ``sim_run.result_summary['data']`` so the
     frontend SolverConsole / waveform viewer can read them via
     ``GET /api/simulation-runs/{id}``.

Phase B MVP keeps the parsed data inline in result_summary because
typical Phase B test circuits (RLC sweeps, simple op-amp transients)
fit easily in JSONB. Big runs in a future phase will switch to
``result_blob_path`` instead.

Errors flow through the same channel as ``optics_seq``: the row's
``status`` flips to ``failed`` with ``error_message`` populated, and a
WebSocket ``simulation_run.status_changed`` event fires.
"""

from __future__ import annotations

import asyncio
import shutil
import struct
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Circuit, SimulationRun
from app.websocket import manager


SPICE_TIMEOUT_SEC = 60.0
"""Hard cap on a single ngspice subprocess. Most Phase B circuits finish in
under a second; anything past 60 s is almost certainly a runaway."""


class SpiceError(Exception):
    """Raised when ngspice can't run or its output can't be parsed."""


# ---- public entrypoint -----------------------------------------------------


async def run(session: AsyncSession, sim_run: SimulationRun) -> None:
    """Run ngspice for ``sim_run`` and mutate the row in place.

    Required ``sim_run.params``:
        circuitId  (str | UUID): which Circuit to load the netlist from.

    The caller (``solvers/runner.py``) commits the session.
    """
    sim_run.status = "running"
    sim_run.progress = 0.0
    sim_run.started_at = datetime.now(timezone.utc)
    await session.flush()
    await _broadcast(sim_run)

    try:
        circuit = await _load_circuit(session, sim_run.params or {})

        with tempfile.TemporaryDirectory(prefix=f"spice_{sim_run.id}_") as tmp_str:
            tmpdir = Path(tmp_str)
            netlist_file = tmpdir / "input.cir"
            raw_file = tmpdir / "output.raw"
            log_file = tmpdir / "output.log"
            netlist_file.write_text(circuit.netlist)

            ngspice = _resolve_ngspice_path()
            # Use sync subprocess.run inside an executor instead of
            # asyncio.create_subprocess_exec — uvicorn on Windows defaults
            # to SelectorEventLoop which does not implement subprocess
            # (raises bare NotImplementedError). run_in_executor is
            # cross-platform and event-loop-agnostic.
            cmd = [
                str(ngspice),
                "-b",
                "-r", str(raw_file),
                "-o", str(log_file),
                str(netlist_file),
            ]

            def _spawn_sync() -> subprocess.CompletedProcess:
                return subprocess.run(
                    cmd,
                    capture_output=True,
                    timeout=SPICE_TIMEOUT_SEC,
                    check=False,
                )

            loop = asyncio.get_running_loop()
            try:
                completed = await loop.run_in_executor(None, _spawn_sync)
            except subprocess.TimeoutExpired:
                raise SpiceError(f"ngspice timed out after {SPICE_TIMEOUT_SEC}s")

            log_text = (
                log_file.read_text(errors="replace") if log_file.exists() else ""
            )

            if completed.returncode != 0 or not raw_file.exists():
                tail = (completed.stderr or b"").decode(errors="replace")[-500:]
                raise SpiceError(
                    f"ngspice exit={completed.returncode}; stderr_tail={tail!r}"
                )

            parsed = _parse_raw_file(raw_file.read_bytes())

        sim_run.status = "completed"
        sim_run.progress = 1.0
        sim_run.warnings = []
        sim_run.result_summary = {
            "circuitId": str(circuit.id),
            "circuitName": circuit.name,
            "analysisName": parsed["plotname"],
            "isComplex": parsed["is_complex"],
            "variables": parsed["variables"],
            "pointCount": parsed["point_count"],
            "data": parsed["data"],
            "logLineCount": len(log_text.splitlines()),
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


async def _load_circuit(session: AsyncSession, params: dict) -> Circuit:
    raw_id = params.get("circuitId") or params.get("circuit_id")
    if not raw_id:
        raise SpiceError("params.circuitId is required")
    try:
        circuit_uuid = uuid.UUID(str(raw_id))
    except (ValueError, AttributeError) as exc:
        raise SpiceError(f"invalid circuitId: {raw_id!r} ({exc})") from exc
    circuit = await session.get(Circuit, circuit_uuid)
    if circuit is None:
        raise SpiceError(f"Circuit {circuit_uuid} not found")
    if not (circuit.netlist or "").strip():
        raise SpiceError(f"Circuit {circuit_uuid} has empty netlist")
    return circuit


def _resolve_ngspice_path() -> Path:
    """Look up the ngspice binary. Settings override -> PATH."""
    configured = settings.ngspice_path
    if configured:
        p = Path(configured)
        if p.exists():
            return p
        raise SpiceError(f"NGSPICE_PATH set to {p} but the file is missing")
    found = shutil.which("ngspice")
    if found:
        return Path(found)
    raise SpiceError(
        "ngspice binary not found. Set NGSPICE_PATH env var, or install via "
        "`choco install ngspice -y` (run as Administrator)."
    )


# ---- raw-file parser -------------------------------------------------------


def _parse_raw_file(blob: bytes) -> dict:
    """Parse an ngspice batch-mode rawfile (binary or ASCII).

    Returns ``{plotname, is_complex, variables, point_count, data}`` where
    ``data`` is ``{var_name: [values]}``. For complex flags each value is a
    ``[re, im]`` 2-tuple-as-list (so it round-trips through JSONB cleanly).
    """
    # ngspice writes "Binary:\n" on POSIX and "Binary:\r\n" on Windows;
    # accept both. Find whichever marker appears first in the blob.
    sep_offset = -1
    sep_len = 0
    is_binary = False
    for marker, binary in (
        (b"Binary:\r\n", True),
        (b"Binary:\n", True),
        (b"Values:\r\n", False),
        (b"Values:\n", False),
    ):
        idx = blob.find(marker)
        if idx == -1:
            continue
        if sep_offset == -1 or idx < sep_offset:
            sep_offset = idx
            sep_len = len(marker)
            is_binary = binary
    if sep_offset == -1:
        raise SpiceError("rawfile missing Binary: / Values: separator")

    header_bytes = blob[:sep_offset]
    body = blob[sep_offset + sep_len:]
    header = header_bytes.decode(errors="replace")

    plotname = ""
    is_complex = False
    n_vars = 0
    n_points = 0
    variables: list[str] = []

    for line in header.splitlines():
        s = line.strip()
        if s.startswith("Plotname:"):
            plotname = s[len("Plotname:"):].strip()
        elif s.startswith("Flags:"):
            is_complex = "complex" in s.lower()
        elif s.startswith("No. Variables:"):
            n_vars = int(s[len("No. Variables:"):].strip())
        elif s.startswith("No. Points:"):
            n_points = int(s[len("No. Points:"):].strip())
        else:
            parts = s.split()
            if len(parts) >= 2 and parts[0].isdigit():
                variables.append(parts[1])

    if n_vars <= 0 or n_points <= 0 or len(variables) != n_vars:
        raise SpiceError(
            f"rawfile header malformed: vars={n_vars} points={n_points} "
            f"names={len(variables)}"
        )

    if is_binary:
        bytes_per_val = 16 if is_complex else 8
        expected = n_vars * n_points * bytes_per_val
        if len(body) < expected:
            raise SpiceError(
                f"rawfile body truncated: expected {expected} bytes got {len(body)}"
            )
        body = body[:expected]
        data: dict[str, list] = {v: [] for v in variables}
        if is_complex:
            count = n_vars * n_points * 2
            flat = struct.unpack(f"<{count}d", body)
            for p in range(n_points):
                for v_idx, name in enumerate(variables):
                    base = (p * n_vars + v_idx) * 2
                    data[name].append([flat[base], flat[base + 1]])
        else:
            count = n_vars * n_points
            flat = struct.unpack(f"<{count}d", body)
            for p in range(n_points):
                for v_idx, name in enumerate(variables):
                    data[name].append(flat[p * n_vars + v_idx])
    else:
        # ASCII Values: "<idx> <var0> <var1> ... <varN-1>" per point.
        # For complex flags, each token is "re,im" (single comma-separated
        # token, no whitespace inside).
        tokens = body.decode(errors="replace").split()
        data = {v: [] for v in variables}
        idx = 0
        for _ in range(n_points):
            if idx >= len(tokens):
                raise SpiceError("ASCII rawfile body truncated")
            idx += 1  # leading point index
            for v in variables:
                if idx >= len(tokens):
                    raise SpiceError("ASCII rawfile body truncated mid-point")
                token = tokens[idx]
                if is_complex:
                    if "," not in token:
                        raise SpiceError(
                            f"expected complex token 're,im' got {token!r}"
                        )
                    re_str, im_str = token.split(",", 1)
                    data[v].append([float(re_str), float(im_str)])
                else:
                    data[v].append(float(token))
                idx += 1

    return {
        "plotname": plotname,
        "is_complex": is_complex,
        "variables": variables,
        "point_count": n_points,
        "data": data,
    }


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
