from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db import AsyncSessionLocal
from app.routers import (
    agent_sessions,
    app_settings,
    assembly_relations,
    assets,
    beam_paths,
    circuits,
    collection_templates,
    collections,
    components,
    connections,
    device_states,
    coils,
    em_problems,
    magnetics_problems,
    meshes,
    rf_chains,
    objects,
    physics_elements,
    optical_links,
    optics_cavity,
    optics_crystal,
    revisions,
    scene,
    scene_views,
    simulation_runs,
    simulations,
    timing_programs,
    touchstone,
)
from app.routers.collections import get_master_collection
from app.services.agent_session import scan_for_abandoned
from app.websocket import router as websocket_router


_log = logging.getLogger(__name__)
_SWEEPER_INTERVAL_SEC = 60


app = FastAPI(title="Quantum Memory Digital Twin API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

settings.asset_root.mkdir(parents=True, exist_ok=True)
app.mount("/assets", StaticFiles(directory=str(settings.asset_root)), name="assets")

app.include_router(assets.router, prefix="/api/assets", tags=["assets"])
app.include_router(components.router, prefix="/api/components", tags=["components"])
app.include_router(objects.router, prefix="/api/objects", tags=["objects"])
app.include_router(connections.router, prefix="/api/connections", tags=["connections"])
app.include_router(assembly_relations.router, prefix="/api/assembly-relations", tags=["assembly_relations"])
app.include_router(beam_paths.router, prefix="/api/beam-paths", tags=["beam_paths"])
app.include_router(device_states.router, prefix="/api/device-states", tags=["device_states"])
app.include_router(physics_elements.router, prefix="/api/physics-elements", tags=["physics_elements"])
app.include_router(optical_links.router, prefix="/api/optical-links", tags=["optical_links"])
app.include_router(simulations.router, prefix="/api/simulations", tags=["simulations"])
app.include_router(simulation_runs.router, prefix="/api/simulation-runs", tags=["simulation_runs"])
app.include_router(circuits.router, prefix="/api/circuits", tags=["circuits"])
app.include_router(touchstone.router, prefix="/api/touchstone", tags=["touchstone"])
app.include_router(meshes.router, prefix="/api/meshes", tags=["meshes"])
app.include_router(em_problems.router, prefix="/api/em-problems", tags=["em_problems"])
app.include_router(coils.router, prefix="/api/coils", tags=["coils"])
app.include_router(magnetics_problems.router, prefix="/api/magnetics-problems", tags=["magnetics_problems"])
app.include_router(rf_chains.router, prefix="/api/rf-chains", tags=["rf_chains"])
app.include_router(optics_cavity.router, prefix="/api/optics-cavity", tags=["optics_cavity"])
app.include_router(optics_crystal.router, prefix="/api/optics-crystal", tags=["optics_crystal"])
app.include_router(revisions.router, prefix="/api/revisions", tags=["revisions"])
app.include_router(scene_views.router, prefix="/api/scene-views", tags=["scene_views"])
app.include_router(collections.router, prefix="/api/collections", tags=["collections"])
app.include_router(
    collection_templates.router,
    prefix="/api/collection-templates",
    tags=["collection_templates"],
)
app.include_router(
    timing_programs.router, prefix="/api/timing-programs", tags=["timing_programs"]
)
app.include_router(app_settings.router, prefix="/api/app-settings", tags=["app_settings"])
app.include_router(scene.router, prefix="/api", tags=["scene"])
app.include_router(
    agent_sessions.router, prefix="/api/agent-sessions", tags=["agent_sessions"]
)
app.include_router(websocket_router, prefix="/ws", tags=["websocket"])


@app.on_event("startup")
async def _ensure_master_collection() -> None:
    async with AsyncSessionLocal() as session:
        await get_master_collection(session)


async def _sweep_abandoned_sessions_loop() -> None:
    """Periodically reaps AI binding sessions whose heartbeat has lapsed.

    First sweep runs immediately so a backend restart after a crash
    cleans up zombie 'running' rows before any user could start a new
    session. Thereafter the loop sleeps ``_SWEEPER_INTERVAL_SEC``
    seconds between sweeps.

    Each sweep gets its own DB session — the long-running loop must
    not hold a single connection open for hours.
    """
    while True:
        try:
            async with AsyncSessionLocal() as session:
                abandoned = await scan_for_abandoned(session)
            if abandoned:
                _log.info(
                    "agent_session_sweeper: rolled back %d abandoned session(s): %s",
                    len(abandoned),
                    [str(sid) for sid in abandoned],
                )
        except Exception:
            # A bad sweep must not kill the loop — the next tick gets
            # a fresh DB session and tries again.
            _log.exception("agent_session_sweeper: sweep failed")
        await asyncio.sleep(_SWEEPER_INTERVAL_SEC)


@app.on_event("startup")
async def _start_agent_session_sweeper() -> None:
    # fire-and-forget — the task lives for the lifetime of the FastAPI
    # process; uvicorn shutdown cancels it cleanly when the loop closes.
    asyncio.create_task(_sweep_abandoned_sessions_loop())


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}
