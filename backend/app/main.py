from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.routers import (
    assembly_relations,
    assets,
    beam_paths,
    components,
    connections,
    device_states,
    placements,
    scene,
)
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
app.include_router(placements.router, prefix="/api/placements", tags=["placements"])
app.include_router(connections.router, prefix="/api/connections", tags=["connections"])
app.include_router(assembly_relations.router, prefix="/api/assembly-relations", tags=["assembly_relations"])
app.include_router(beam_paths.router, prefix="/api/beam-paths", tags=["beam_paths"])
app.include_router(device_states.router, prefix="/api/device-states", tags=["device_states"])
app.include_router(scene.router, prefix="/api", tags=["scene"])
app.include_router(websocket_router, prefix="/ws", tags=["websocket"])


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}
