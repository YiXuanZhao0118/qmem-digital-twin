"""SolverRunner abstraction for multiphysics modules.

Three runner implementations are planned (see docs/MULTIPHYSICS_PLAN.md §4):

- ``InProcessRunner``       — runs the solver as an awaited coroutine inside
                              the FastAPI worker. Right for fast / lightweight
                              solvers (Phase A optics_seq, possibly Phase B
                              SPICE).
- ``ContainerRunner``       — subprocess inside the backend Docker container,
                              output captured via stdout/stderr. (Phase B
                              ngspice / Phase D MEEP if running locally.)
- ``SshWorkstationRunner``  — SSH to a lab workstation, spawn the solver
                              there, poll status / scp results back. (Phase C
                              palace / Phase D MEEP for big jobs.)

Phase A only ships ``InProcessRunner``. The other two arrive in their own
phases. The router treats the runner as a black box behind the
``SolverRunner`` Protocol.

Adding a new module = (1) write the solver coroutine, (2) register it in
``MODULE_DISPATCH``, (3) set its default runner kind in
``MODULE_DEFAULT_RUNNER``.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Awaitable, Callable, Protocol

from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.models import SimulationRun
from app.schemas import SimulationModule
from app.config import settings
from app.solvers import em_fem, optics_seq, spice


logger = logging.getLogger(__name__)


# Solver coroutine signature: (session, sim_run) → mutates sim_run in place,
# returns when done. Caller commits.
SolverCallable = Callable[[AsyncSession, SimulationRun], Awaitable[None]]


# Per-module solver coroutine. Phase A: optics_seq. Phase B: spice.
# Phase C.5: em_fem (mock palace until C.4 workstation comes online).
MODULE_DISPATCH: dict[SimulationModule, SolverCallable] = {
    "optics_seq": optics_seq.run,
    "spice": spice.run,
    "em_fem": em_fem.run,
}


# Default runner kind per module. Used when POST /api/simulation-runs comes
# in without an explicit runner_kind.
#
# Phase A: everything inproc. Future phases override:
#   Phase B: spice → 'container' (after ContainerRunner ships)
#   Phase C: em_fem → 'ssh_workstation'
#   Phase D: optics_fdtd → 'ssh_workstation'
MODULE_DEFAULT_RUNNER: dict[SimulationModule, str] = {
    "optics_seq": "inproc",
    "optics_fdtd": "inproc",
    "spice": "inproc",
    "em_fem": "inproc",
}


class SolverRunner(Protocol):
    async def submit(self, sim_run: SimulationRun) -> None: ...


class SshWorkstationRunner:
    """Phase C.3 stub for the lab-workstation SSH dispatch path.

    The actual SSH client + workstation-side runner agent land in
    Phase C.4 (Windows + WSL2 + ``docker pull awslabs/palace:latest`` on
    the workstation). Until then this class exists so MODULE_DEFAULT_RUNNER
    can reference 'ssh_workstation' without crashing — but ``submit``
    raises NotImplementedError to surface the missing piece clearly if
    something tries to dispatch a real job before workstation setup.
    """

    def __init__(
        self,
        host: str | None,
        key_path: str | None,
        palace_image: str,
    ) -> None:
        self.host = host
        self.key_path = key_path
        self.palace_image = palace_image

    async def submit(self, sim_run: SimulationRun) -> None:
        if not self.host:
            raise NotImplementedError(
                "SshWorkstationRunner: settings.workstation_host is unset. "
                "Configure WORKSTATION_HOST + WORKSTATION_KEY_PATH and stand "
                "up the workstation runner agent (Phase C.4) before dispatching "
                "ssh_workstation runs."
            )
        # Phase C.4 will replace this with: open asyncssh client, scp the
        # job spec + mesh, exec `docker run awslabs/palace:latest`,
        # poll a status file, scp results back, parse, fill sim_run.
        raise NotImplementedError(
            f"SshWorkstationRunner: workstation runner agent on {self.host!r} "
            "not yet implemented (Phase C.4)."
        )


class InProcessRunner:
    """Runs the solver inside the FastAPI worker via ``asyncio.create_task``.

    A fresh ``AsyncSession`` is opened inside the background task because the
    request session that created ``sim_run`` is closed by the time the task
    runs. Strong references to the spawned tasks are held in
    ``self._tasks`` so the asyncio loop doesn't garbage-collect them mid-run.

    Progress / completion is observable through the ``simulation_runs`` table
    and the WebSocket ``simulation_run.status_changed`` events emitted by
    each module's solver.
    """

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    async def submit(self, sim_run: SimulationRun) -> None:
        run_id = sim_run.id
        module = sim_run.module
        task = asyncio.create_task(_run_in_background(run_id, module))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


async def _run_in_background(run_id: uuid.UUID, module: SimulationModule) -> None:
    """Open a fresh session, re-load the SimulationRun, dispatch to the
    module's solver, commit.

    Errors are recorded on the row itself (status='failed', error_message
    populated by the solver before it re-raised) and then committed; this
    coroutine never bubbles an exception because there's no caller to
    receive it.
    """
    solver = MODULE_DISPATCH.get(module)

    async with AsyncSessionLocal() as session:
        sim_run = await session.get(SimulationRun, run_id)
        if sim_run is None:
            logger.warning("InProcessRunner: SimulationRun %s vanished before dispatch", run_id)
            return

        if solver is None:
            sim_run.status = "failed"
            sim_run.error_message = f"No solver registered for module={module!r}"
            await session.commit()
            return

        try:
            await solver(session, sim_run)
            await session.commit()
        except Exception:
            # Solver already wrote status='failed' + error_message via
            # session.flush() before re-raising. Persist those mutations.
            logger.exception("InProcessRunner: solver crashed for run %s (module=%s)", run_id, module)
            try:
                await session.commit()
            except Exception:
                logger.exception("InProcessRunner: failed to commit error state for run %s", run_id)


# Phase A: inproc. Phase C.3: ssh_workstation stub (real wiring in C.4).
RUNNERS: dict[str, SolverRunner] = {
    "inproc": InProcessRunner(),
    "ssh_workstation": SshWorkstationRunner(
        host=settings.workstation_host,
        key_path=settings.workstation_key_path,
        palace_image=settings.workstation_palace_image,
    ),
}
