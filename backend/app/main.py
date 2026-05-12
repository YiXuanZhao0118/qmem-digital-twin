from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db import AsyncSessionLocal
from app.routers import (
    assembly_relations,
    assets,
    beam_paths,
    circuits,
    collections,
    components,
    connections,
    device_states,
    objects,
    optical_elements,
    optical_links,
    revisions,
    scene,
    scene_views,
    simulation_runs,
    simulations,
    timing_programs,
)
from app.routers.collections import get_master_collection
from app.websocket import router as websocket_router


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
app.include_router(optical_elements.router, prefix="/api/optical-elements", tags=["optical_elements"])
app.include_router(optical_links.router, prefix="/api/optical-links", tags=["optical_links"])
app.include_router(simulations.router, prefix="/api/simulations", tags=["simulations"])
app.include_router(simulation_runs.router, prefix="/api/simulation-runs", tags=["simulation_runs"])
app.include_router(circuits.router, prefix="/api/circuits", tags=["circuits"])
app.include_router(revisions.router, prefix="/api/revisions", tags=["revisions"])
app.include_router(scene_views.router, prefix="/api/scene-views", tags=["scene_views"])
app.include_router(collections.router, prefix="/api/collections", tags=["collections"])
app.include_router(
    timing_programs.router, prefix="/api/timing-programs", tags=["timing_programs"]
)
app.include_router(scene.router, prefix="/api", tags=["scene"])
app.include_router(websocket_router, prefix="/ws", tags=["websocket"])


@app.on_event("startup")
async def _ensure_master_collection() -> None:
    async with AsyncSessionLocal() as session:
        await get_master_collection(session)


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}
