# QMEM Digital Twin

Quantum memory optical-table digital twin MVP.

## Stack

- Frontend: Vite + React + TypeScript + Three.js
- Backend: Python FastAPI + WebSocket
- Database: PostgreSQL
- 3D assets: glTF / GLB, with primitive geometry fallback
- CAD source: Onshape metadata sync reserved for phase 2

## Start PostgreSQL

```powershell
docker compose up -d
```

Adminer runs at http://localhost:8080.

Database defaults:

- database: `qmem_twin`
- user: `qmem`
- password: `qmem_password`
- port: `5432`

If Docker is not installed but PostgreSQL is installed locally, start an isolated
project database on port `55432`:

```powershell
.\scripts\start-local-postgres.ps1
cd backend
alembic upgrade head
python .\scripts\seed.py
```

This writes a local `.env` that points the backend at:

```text
postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin
```

Stop the local project database with:

```powershell
.\scripts\stop-local-postgres.ps1
```

## Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
python .\scripts\seed.py
uvicorn app.main:app --reload --port 8000
```

Useful URLs:

- Health: http://localhost:8000/api/health
- OpenAPI docs: http://localhost:8000/docs
- Full scene payload: http://localhost:8000/api/scene
- WebSocket: `ws://localhost:8000/ws/scene`

The seed script creates:

- `optical_table_1`
- `vacuum_chamber_1`
- `laser_852nm_1`
- `laser_894nm_1`
- `mirror_001`
- `mirror_002`
- `lens_001`
- `aom_001`
- `eom_9ghz_001`
- `rf_generator_001`
- `rf_amp_001`

## Frontend

```powershell
cd frontend
npm install
npm run dev
```

The app runs at http://localhost:5173.

Optional environment overrides:

```powershell
$env:VITE_API_BASE_URL="http://localhost:8000"
$env:VITE_WS_URL="ws://localhost:8000/ws/scene"
```

## API Summary

REST:

- `GET /api/scene`
- `GET|POST /api/assets`
- `GET|PUT|DELETE /api/assets/{id}`
- `GET|POST /api/components`
- `GET|PUT|DELETE /api/components/{id}`
- `GET /api/placements`
- `PUT /api/placements/{component_id}`
- `GET|POST /api/connections`
- `DELETE /api/connections/{id}`
- `GET|POST /api/beam-paths`
- `PUT|DELETE /api/beam-paths/{id}`
- `GET /api/device-states`
- `PUT /api/device-states/{component_id}`

WebSocket events:

- `component.created`
- `component.updated`
- `component.deleted`
- `placement.updated`
- `beam_path.updated`
- `connection.updated`
- `device_state.updated`
- `scene.reload`

## Coordinates

Database coordinates use millimeters. The frontend maps them to Three.js as:

- lab X -> Three.js X
- lab Y -> Three.js -Z
- lab Z -> Three.js Y
- `1 Three.js unit = 100 mm`

## Assets

Manual GLB/glTF assets can be placed under `assets/gltf`. Store their API path in
`assets_3d.file_path`, for example:

```text
gltf/my_mount.glb
```

FastAPI serves the folder at:

```text
http://localhost:8000/assets/gltf/my_mount.glb
```

If no GLB/glTF is present, the frontend uses primitive geometry based on
`component_type` and `properties`.

## Phase 2

Onshape API integration is intentionally not active in the MVP. The placeholder
client lives at `backend/app/services/onshape_client.py`; add the metadata-link
table and `/api/onshape/*` routes after the scene, placement, asset, and
WebSocket loop is stable.
