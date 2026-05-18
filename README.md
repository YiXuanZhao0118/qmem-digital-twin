# QMEM Digital Twin

A live, browser-based digital twin of a quantum-memory optical table. The user
arranges real lab parts in 3D, wires their RF/TTL chains, defines their pulse
schedules, then dispatches multiphysics solvers (sequential ray-trace, RF
graph propagation, SPICE, EM FEM, DC magnetostatics) on demand. The scene is
the single source of truth — every panel reads from it, every event mutates it,
and every solver returns into it.

> **Two reading orders:**
> - This README is a top-down architectural map (backend ↔ frontend ↔ data).
> - [`docs/vibe coding.md`](docs/vibe%20coding.md) is the running notebook
>   (frame/unit conventions, per-kind ParamSchemas, align algorithms, extension
>   recipes). Updated in place as the codebase evolves — not a changelog
>   (`git log` is).
> - [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md) is the
>   long-form companion to this README.

---

## Table of Contents

1. [Glossary & domain model](#glossary--domain-model)
2. [Stack](#stack)
3. [Quick start](#quick-start)
4. [System architecture](#system-architecture)
5. [Backend deep dive](#backend-deep-dive)
6. [Frontend deep dive](#frontend-deep-dive)
7. [Coordinates & units](#coordinates--units)
8. [Assets pipeline](#assets-pipeline)
9. [WebSocket protocol](#websocket-protocol)
10. [AI binding agent (alpha)](#ai-binding-agent-alpha)
11. [Phase 2 / roadmap](#phase-2--roadmap)
12. [Troubleshooting & optimization notes](#troubleshooting--optimization-notes)

---

## Glossary & domain model

The data model has **three catalog tiers** plus a **scene graph** layered on top:

| Term | Meaning | DB table | API path |
|------|---------|----------|----------|
| **Asset** | A 3D file (`.stl` / `.glb` / `.step` / primitive) in the asset library. Owns `anchors[]`. | `assets_3d` | `/api/assets` |
| **Component** | A part type in the catalog ("AOMO 3080", "DBR-852-TOSA"). Composed of one or more bindings (asset or sub-component) in a tree. | `components` | `/api/components` |
| **ComponentBinding** | A node in a Component's composition tree. Each binding targets either an `Asset3D` (raw geometry) or another `Component` (sub-component) with a local transform; `tunable_axes` declares per-instance Euler DoFs. | `component_bindings` | `/api/components/{id}/bindings` · `/api/component-bindings/{id}` |
| **Object** | An **instance** of a Component placed in the scene. Has pose, visibility, locks, per-instance overrides (including `properties.bindingOverrides` keyed by binding id). | `objects` | `/api/objects` |

`Asset → Component → Object` is the canonical hierarchy. The same Component can
have many Objects. ComponentBinding generalises the legacy "one Component → one
Asset" pointer into a tree so e.g. a Faraday isolator can be modelled as
*body + 2 PBS sub-components + 2 end caps* with per-instance rotational DoFs
on each end cap. The left panel shows Components and Objects; underlying
Assets are managed indirectly through component upload/import.

On top of those three tiers the scene graph adds:

- **Collections** (`collections` / `collection_members`) — Blender-style nested
  groups; a `rigidTransform: true` collection moves all members together.
- **AgentSession** (`agent_sessions` / `session_mutations` / `approval_events`,
  alembic 0057+0058) — backs the in-browser AI binding agent. One conversation =
  one session that creates *draft* Asset3D + Component rows; the user
  approves the batch (locks the rows) or cancels it (reverse-replays the
  mutation log). See [AI binding agent (alpha)](#ai-binding-agent-alpha).
- **AssemblyRelation** (`assembly_relations`) — CAD-style constraints between
  objects (face_touch, distance, look_at, …) solved by `assembly_solver.py`.
- **PhysicsElement** (`physics_elements`, 1:1 with an Object) — per-instance
  physics parameters split into `intrinsic_params` (fixed) and `state_params`
  (mutable; driven by timing programs).
- **OpticalLink / RfLink** — explicit chain edges between Object ports.
- **BeamPath** — polyline cache of ray-trace output.
- **TimingProgram** — reusable interval schedule a programmable pulse generator
  emits.
- **DeviceState** (1:1 with an Object) — runtime state (power on/off,
  temperature, …) that solvers and panels consume.

> Historical note: the `objects` table was once `placements` (≤ migration 0008).
> Migration `0009_rename_objects` aligned the schema with user-facing naming;
> "placement" no longer appears as a domain term.

---

## Stack

- **Frontend:** Vite + React 18 + TypeScript + Three.js + Zustand
- **Backend:** Python 3.13, FastAPI, SQLAlchemy async, Pydantic, WebSocket,
  `anthropic` SDK (optional — drives the AI binding agent)
- **Database:** PostgreSQL (Docker or local, port 55432 in dev)
- **3D assets:** glTF / GLB / STL / STEP, with primitive geometry fallback
- **Solvers:** in-process Python for Phase A; ngspice (Phase B), Palace
  (Phase C, via SSH/Docker), magpylib (DC magnetostatics) for later phases
- **CAD source:** Onshape metadata sync reserved for Phase 2

---

## Quick start

### Option A — Docker PostgreSQL

```powershell
docker compose up -d
```

Adminer ships at http://localhost:8080. Defaults: db `qmem_twin`, user `qmem`,
password `qmem_password`, port `5432`.

### Option B — local PostgreSQL on port 55432 (preferred in this repo)

```powershell
.\scripts\start-local-postgres.ps1
cd backend
alembic upgrade head
python .\scripts\seed.py
```

This writes a `.env` pointing the backend at
`postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin`.

Stop with `.\scripts\stop-local-postgres.ps1`.

### Backend

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
python .\scripts\seed.py
uvicorn app.main:app --reload --port 8010
```

Useful URLs:

- Health: <http://localhost:8010/api/health>
- OpenAPI docs: <http://localhost:8010/docs>
- Bulk scene: <http://localhost:8010/api/scene>
- WebSocket: `ws://localhost:8010/ws`

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

App runs at <http://localhost:5173>. Optional overrides:

```powershell
$env:VITE_API_BASE_URL = "http://localhost:8010"
$env:VITE_WS_URL = "ws://localhost:8010/ws"
```

### One-shot: full stack

Invoke the `anthropic-skills:start-project` skill or just run the three
processes in the order above. The stack is reachable at the ports listed in the
[`.env`](.env).

---

## System architecture

```
                 ┌────────────────────────────────────────────────┐
   browser ◄──── │  Vite dev server   :5173                       │
                 │  React + Three.js + Zustand sceneStore         │
                 │  ▲ axios REST    ▲ WebSocket events            │
                 └────┼─────────────┼─────────────────────────────┘
                      │             │
                 ┌────▼─────────────▼─────────────────────────────┐
                 │  FastAPI                       :8010           │
                 │  /api/* (28 routers)  +  /ws (broadcast hub)   │
                 │  ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
                 │  │ routers/ │ │ services/  │ │ solvers/     │  │
                 │  └──────────┘ └────────────┘ └──────────────┘  │
                 │  SQLAlchemy async  +  Pydantic schemas         │
                 │  models/ themed package (hardware/scene/agent/ │
                 │     physics/timing/interaction/simulation/…)   │
                 └────────────────────────┬───────────────────────┘
                                          │
                 ┌────────────────────────▼───────────────────────┐
                 │  PostgreSQL    :55432   (Alembic at 0063)      │
                 │  assets_3d, components, component_bindings,    │
                 │  objects, connections, collections,            │
                 │  optical_links, rf_chain_nodes,                │
                 │  physics_elements, beam_paths, simulation_runs │
                 │  timing_programs, collection_templates,        │
                 │  agent_sessions, session_mutations, …          │
                 └────────────────────────────────────────────────┘
```

**Data flow for a typical interaction**

1. User drags an object in the viewer → `sceneStore.updateSceneObject(id, patch)`.
2. Store calls `updateObjectApi` (PUT `/api/objects/{id}`) — optimistic preview
   stays applied locally until ack.
3. Router persists the patch, computes any cascades (rigid-group transforms,
   fiber endpoint resolution), commits.
4. Backend broadcasts `object.updated` on the WebSocket.
5. Every connected client (including the originator) consumes the event via
   `sceneStore.applyEvent` and reconciles its scene slice.

**Frontend→backend kind contract**

`backend/data/kinds.json` is generated from the **frontend** plugin registry
(`frontend/src/kinds/_plugins.ts`) by
[`scripts/export_kinds_manifest.ts`](scripts/export_kinds_manifest.ts). The
backend refuses to start if the manifest is missing or unparseable, so kind
metadata cannot drift between layers.

---

## Backend deep dive

### Process

`backend/app/main.py` boots FastAPI with:

- **CORS** from `settings.cors_origins` (default `http://localhost:{5173,3000}`).
- **`/assets` static mount** serving `settings.asset_root` (default `assets/`).
- **Startup hook** `_ensure_master_collection()` bootstraps the master
  Collection so the outliner always has a root node.
- **`GET /api/health`** liveness probe.
- **`/ws`** WebSocket (see [WebSocket protocol](#websocket-protocol)).
- 28 API routers under `/api/...` (full table below). `component_bindings` mounts twice (nested at `/api/components/{id}/bindings` for tree listing/creation + top-level `/api/component-bindings/{id}` for per-row operations), counted as one router.

Config lives in `backend/app/config.py` (Pydantic Settings, reads `.env`):
`DATABASE_URL`, `CORS_ORIGINS`, `ASSET_ROOT`, plus Onshape and Palace fields
for later phases. As of alembic 0057 it also carries the AI-agent triple
`ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`) /
`ANTHROPIC_MAX_TOKENS` (default 8192). Empty key disables the orchestrator
gracefully — session lifecycle still works, only `POST /messages` returns
a friendly error.

### Background tasks

`main.py` spawns a single asyncio loop on startup, `_sweep_abandoned_sessions_loop`,
which calls `agent_session.scan_for_abandoned` every 60 s. It picks up any
`agent_sessions` row with `status='running'` whose `last_heartbeat_at` is
older than `heartbeat_timeout_sec` (default 300 s) and rolls it back —
the reverse-replay of `session_mutations` deletes the draft Asset3D /
Component rows so a crashed browser tab doesn't squat on draft state
indefinitely. The first sweep runs immediately so a backend restart
also reaps stale sessions before any user can start a new one.

### Database tables (selected)

All tables use UUID primary keys. JSONB columns are used liberally for
per-kind parameter blobs so the schema doesn't have to migrate every time a
plugin grows a field.

| Table | Purpose | Notable columns |
|---|---|---|
| `assets_3d` | 3D files & their anchors | `file_path` (post-0063 lives under `files/<ext>/…` or `agent_uploads/<session_id>/…` — anything else is rejected by `resolve_asset_path`), `unit`, `scale_factor`, `anchors` (JSONB, with `connectorType` after migration 0050; for waveplates `fastAxisDegBodyLocal` is asset-level since 0060). Post-0057 also carries `status` (`active`/`draft`), `created_by_session_id`, `ai_approved_at` |
| `components` | Catalog | `component_type`, `brand`, `model`, `asset_3d_id` (legacy single-asset pointer, kept around until all read paths move to `component_bindings`), `properties`, `physics_capabilities`, `archived_at`. Same three lifecycle columns (`status`, `created_by_session_id`, `ai_approved_at`) appended in 0057 |
| `component_bindings` | Composition tree (post-0062) | `component_id` (FK → `components.id`), `parent_binding_id` (self-FK, NULL = root), `target_kind` (`asset`\|`subcomponent`), `asset_3d_id` XOR `sub_component_id`, `role` (e.g. `body`, `end_cap_a`, `pbs_front`), `local_{x,y,z}_mm` + `local_{rx,ry,rz}_deg` (parent-binding-local pose), `tunable_axes` (JSONB declaring per-instance Euler DoFs with `frame`/`min`/`max`/`default`), `sort_order`, `properties`. Three CHECK constraints enforce the XOR target + target_kind alignment + no self-subref; cycle detection in the router walks the candidate sub-component's transitive closure |
| `objects` | Scene instances | `x/y/z_mm`, `rx/ry/rz_deg`, `visible`, `locked`, `serial_number`, `properties` (per-instance overrides, fiber/rf-cable spline, anchor bindings, emission visuals) |
| `connections` | RF/TTL/USB cables (older model) | `from_object_id`, `from_port`, `to_object_id`, `to_port`, `connection_type` |
| `assembly_relations` | CAD-style constraints | `relation_type`, `selector_a`, `selector_b`, `offset_mm`, `angle_deg`, `enabled`, `solved` |
| `beam_paths` | Polyline cache | `points` (JSONB), `wavelength_nm`, `color`, `visible` |
| `device_states` | 1:1 with object | `state` JSONB (`enabled`, `temperatureC`, …) |
| `revisions` | Scene snapshots | `snapshot` (full denormalized scene), `scene_hash` |
| `simulation_runs` | Multiphysics run records | `module`, `status`, `params`, `result_summary`, `progress` |
| `circuits` | SPICE netlists (Phase B) | `netlist`, optional `schematic` |
| `meshes` | Gmsh uploads (Phase C) | `file_path`, `element_count` |
| `em_problems` | FEM problem definition | `mesh_id`, `ports`, `boundary_conditions`, `freq_range_ghz` |
| `coils` / `magnetics_problems` | DC magnetostatics | `shape`, `current_a`, `params` / `coil_ids`, `eval_region` |
| `rf_chain_nodes` | Ordered RF chain per terminal device | `terminal_scene_object_id`, `position_in_chain`, `kind_params` |
| `physics_elements` | Per-instance physics state | `element_kind`, `intrinsic_params`, `state_params` (Phase 4 split, migration 0049) |
| `optical_links` / `rf_links` | Chain edges | `from_object_id`/`port`, `to_object_id`/`port`, free-space length |
| `scene_views` | Saved visibility/overlay snapshots | `filter_kind`, `filter_expr`, `overlay_overrides` |
| `collections` / `collection_members` | Outliner tree | `parent_id`, `rigid_transform`, `sort_order` |
| `scene_view_collection_overrides` | Per-view collection visibility | `(view_id, collection_id, visible)` |
| `beam_segments` | Ray-trace segments (V2) | per-link, time-stamped, polarization & spectrum |
| `timing_programs` | Reusable interval schedule | `intervals: [{spinCoreStartNs, spinCoreEndNs}]` (slim, post-0051) |
| `collection_templates` | Reusable subtree snapshot (post-0053) | `tree` (recursive collection + relative member poses) |
| `app_settings` | Singleton lab-wide config | `key`, `value` (e.g. `room_dimensions`) |
| `agent_sessions` | One AI binding conversation (post-0057) | `instruction`, `status`, `last_heartbeat_at`, `heartbeat_timeout_sec`, `committed_at`/`cancelled_at`/`cancellation_reason`, `messages_json` (Anthropic SDK history persisted across turns, added in 0058) |
| `session_mutations` | Append-only log of agent writes (post-0057) | `op`, `entity_type` (`asset_3d`/`component`), `entity_id`, `before`/`after` JSONB, `undone_at` |
| `approval_events` | Audit log of approve/unlock/modify_blocked/rolled_back (post-0057) | `event_type`, `entity_type`/`entity_id`, `session_id`, `metadata` (column kept as `metadata`; ORM attr is `event_metadata` because `DeclarativeBase.metadata` is reserved) |

### Routers (`backend/app/routers/`, mounted in `main.py`)

| Mount | File | Purpose |
|---|---|---|
| `/api/assets` | `assets.py` | Asset upload & CRUD; serves anchors editor. Uploads land under `assets/files/<ext>/<uuid>_<name>.<ext>` (viewer-ready: glb/gltf/obj/stl) or `assets/files/cad_sources/…` (step/stp/sldprt/dxf) after alembic 0063 unified the legacy `uploads/` bucket |
| `/api/components` | `components.py` | Catalog CRUD; archive/restore; upload-from-file. Owns `auto_create_physics_element_for_object`, which on a fresh `fiber` spawn also creates paired `fiber_end_a` + `fiber_end_b` SceneObjects (3-object cluster, mirroring migration 0052 for new placements) and joins them to the body's collection |
| `/api/components/{id}/bindings` · `/api/component-bindings/{id}` | `component_bindings.py` | **New (0062)**: ComponentBinding tree CRUD. Nested `GET` returns full binding list in `sort_order` ascending; structure is implied by `parent_binding_id` (multiple roots legal). Top-level routes operate on a single binding by id; the update path **cannot** change the binding's target — to retarget, delete + recreate (keeps cycle protection simple). Cycle protection: creating a `subcomponent`-kind binding walks the candidate sub-component's transitive sub-component closure and rejects with 400 if the container appears in it |
| `/api/objects` | `objects.py` | Instance CRUD; **bulk batch update** so multi-select doesn't trigger N broadcasts. On fresh `fiber` creation also broadcasts the auto-spawned `fiber_end_a`/`fiber_end_b` SceneObjects + PhysicsElements so the 3-object cluster lands without a page reload |
| `/api/connections` | `connections.py` | Cable graph CRUD |
| `/api/assembly-relations` | `assembly_relations.py` | Constraint CRUD + one-shot solve |
| `/api/beam-paths` | `beam_paths.py` | Polyline cache CRUD |
| `/api/device-states` | `device_states.py` | Runtime state PUT |
| `/api/physics-elements` | `physics_elements.py` | PhysicsElement CRUD; validates PPG timing; default-port bootstrap |
| `/api/optical-links` | `optical_links.py` | Optical edges; rejects self-loops + bad ports |
| `/api/rf-chains` | `rf_chains.py` | Per-terminal RF chain nodes; bulk replace |
| `/api/simulations` | `simulations.py` | Legacy Phase A optical run endpoint |
| `/api/simulation-runs` | `simulation_runs.py` | V2 multiphysics dispatch (`optics_seq`, `em_fem`, `magnetics_dc`, `spice`, `optics_cavity`, `optics_crystal`) |
| `/api/circuits` | `circuits.py` | SPICE netlist + schematic CRUD |
| `/api/touchstone` | `touchstone.py` | `.sNp` upload & parse |
| `/api/meshes` | `meshes.py` | Mesh upload (100 MB cap) |
| `/api/em-problems` | `em_problems.py` | FEM problem CRUD |
| `/api/coils` / `/api/magnetics-problems` | `coils.py`, `magnetics_problems.py` | Magnetics inputs |
| `/api/optics-cavity` / `/api/optics-crystal` | placeholder solvers |
| `/api/scene-views` | `scene_views.py` | Saved view snapshots |
| `/api/revisions` | `revisions.py` | Whole-scene snapshots |
| `/api/collections` | `collections.py` | Outliner CRUD + member reorder; bootstraps master |
| `/api/collection-templates` | `collection_templates.py` | **New (0053)**: save/instantiate collection snapshots at a target pose |
| `/api/agent-sessions` | `agent_sessions.py` | **New (0057+0058)**: AI binding session lifecycle — `POST /` start · `GET /{id}` review (session + mutations) · `POST /{id}/heartbeat` · `POST /{id}/uploads` (multipart, asset 50 MB / image 10 MB cap, stored under `assets/agent_uploads/<session>/`) · `POST /{id}/messages` (SSE-streamed agent turn — yields `assistant_chunk` / `tool_call` / `tool_result` / `done` / `error`) · `POST /{id}/undo-last` · `POST /{id}/commit` (drafts → active, `ai_approved_at` set) · `POST /{id}/cancel` (reverse-replay mutation log). 409 on any write to a terminal session |
| `/api/timing-programs` | `timing_programs.py` | TimingProgram CRUD + `/compile` to SpinCore opcodes |
| `/api/app-settings` | `app_settings.py` | Singleton settings (room dimensions, …) |
| `/api` | `scene.py` | `GET /api/scene` — single denormalized snapshot for frontend hydration |

### Solvers (`backend/app/solvers/`)

| File | What it computes |
|---|---|
| `optical_solver.py` | Core CW Gaussian-beam propagator (q-parameter, Jones polarization, spectrum lineshapes). Astigmatic X/Y. |
| `optics_seq.py` | Sequential ray-trace adapter wrapping `optical_solver.solve_chain`; persists `BeamSegment` rows per link. |
| `optics_cavity.py` / `optics_crystal.py` | Phase D placeholders (linewidth/finesse; harmonic generation / OPO). |
| `rf_propagation.py` | Forward BFS over RF chain (DDS → amp → AOM), accumulates gain/loss; mirrors frontend `rfPropagation.ts` exactly. |
| `spinapi_compile.py` | Compile `TimingProgram` intervals → SpinCore opcode stream (CONTINUE / WAIT / STOP). |
| `em_fem.py` | Phase C.5 mock or real Palace dispatch over SSH/Docker; returns S-parameters. |
| `magnetics_dc.py` | magpylib DC magnetostatics; B-field volume in vtk.js format. |
| `palace_io.py` | Palace JSON input builder + S-parameter parser. |
| `runner.py` | Dispatch abstraction (`InProcessRunner`, future `ContainerRunner`, `SshWorkstationRunner`). |
| `spice.py` | ngspice batch wrapper; parses `.raw` waveforms into `result_summary['data']`. |

### Supporting modules

- `db.py` — SQLAlchemy async engine + `get_session()` dependency.
- `crud.py` — `get_or_404`, `list_all`, `apply_updates` helpers.
- `websocket.py` — `ConnectionManager`, broadcast hub, ping/pong keep-alive.
- `kinds_manifest.py` — loads `data/kinds.json`; fail-loud on startup.
- `assembly_solver.py` — iterative constraint solver; emits standard ±x/±y/±z
  face anchors.
- `timing_program.py` — interval merging + opcode helpers (shared by
  `spinapi_compile`).
- `v2_bindings.py` — back-compat layer between legacy `Scene.beam` and modern
  per-instance `kindParams`.
- `models/` (post Stage C, was a single 1.3k-line `models.py`) — ORM split into themed
  submodules: `base.py` (`Base`, `JsonDict`, `JsonList`), `hardware.py`
  (`Asset3D` / `Component` / `ComponentBinding`), `scene.py` (`SceneObject`,
  `Collection`, `CollectionMember`, `CollectionTemplate`, `SceneView`,
  `SceneViewCollectionOverride`), `interaction.py` (`Connection`,
  `OpticalLink`, `RfLink`, `AssemblyRelation`, `BeamPath`),
  `physics.py` (`PhysicsElement`, `DeviceState`), `timing.py` (`TimingProgram`),
  `simulation.py` (`SimulationRun`, `BeamSegment`, `Revision`),
  `agent.py` (`AgentSession`, `SessionMutation`, `ApprovalEvent`),
  `settings.py` (`AppSetting`), and `modules/{electronics,em,magnetics,rf}.py`
  (`Circuit`, `EmProblem`, `Mesh`, `Coil`, `MagneticsProblem`, `RfChainNode`).
  `app.models.__init__` re-exports every name so legacy
  `from app.models import X` imports continue to resolve unchanged.
- `services/asset_converter.py` — `SUPPORTED_ASSET_EXTENSIONS`,
  `VIEWER_ASSET_EXTENSIONS`, `CAD_SOURCE_EXTENSIONS`, `subdir_for_ext`
  (ext → `files/<ext>/` mapping shared by upload endpoints and migration
  0063), `resolve_asset_path` (allowlist of `files/` and `agent_uploads/`
  prefixes; everything else, including stale `uploads/`, is rejected).
- `services/touchstone.py`, `services/instrument_polling.py`,
  `services/onshape_client.py`.
- `services/agent_session.py` (new, 0057) — pure state machine for the AI
  binding agent: `start_session`, `heartbeat`, `undo_last_mutation`,
  `commit_session`, `cancel_session`, `scan_for_abandoned`. Owns the
  reverse-replay logic for rollback (undone mutations skipped, FK
  ordering preserved) and raises `SessionNotRunningError` /
  `UndoBlockedError` / `NothingToUndoError` that the router maps to
  HTTP 4xx codes.
- `services/agent_tools.py` (new, 0057) — the *only* code path the
  agent uses to write Asset3D / Component drafts. Records every write
  to `session_mutations` so commit/cancel can apply/roll back as a
  batch. Raises `EntityLockedError` if the agent tries to touch a row
  with `ai_approved_at IS NOT NULL` (logged as
  `approval_events.event_type='modify_blocked'`).
- `services/agent_tool_schemas.py` (new, 0057) — JSON schemas exposed
  to Claude (`list_kinds`, `list_existing_assets`,
  `list_existing_components`, `create_asset`, `create_component`) plus
  the system prompt. Last tool definition carries
  `cache_control: {type: "ephemeral"}` so the full tools+system prefix
  caches across turns within a session.
- `services/agent_orchestrator.py` (new, 0057+0058) — drives the
  Anthropic SDK tool-use loop. `run_turn_streaming` is an async
  generator yielding the same events the SSE endpoint serializes.
  Persists `messages[]` to `agent_sessions.messages_json` after each
  turn so a backend restart / browser refresh resumes the
  conversation. Singleton `AsyncAnthropic` client; cap of 12
  roundtrips per user turn as a belt-and-suspenders guard against
  pathological tool-call loops.

### Alembic migrations

Currently at **revision 0063**. Recent milestones:

| Rev | Title | Purpose |
|---|---|---|
| 0049 | split_kind_params | `kind_params` → `intrinsic_params` + `state_params` (Phase 4) |
| 0050 | anchor_connector_type | Adds typed connector field (sma/bnc, male/female) to every anchor |
| 0051 | timing_program_slim | Drops `kind`/`channel_index`/`invert`; PPGs emit one "RFout" gate; positional ordering |
| 0052 | fiber_split_to_paired_ends | A fiber became 3 SceneObjects: `fiber_end_a` + body + `fiber_end_b` (reverted by 0056) |
| 0053 | collection_templates | Adds `collection_templates` table backing Collection Drift |
| 0054 | split_rf_cable_assets | Splits the shared `primitive_thorlabs_ca2906_cable` Asset3D into per-component rows (`primitive_rf_cable_sma_to_bnc`, `primitive_rf_cable_bnc_to_bnc`) so PHY Editor `rf_in`/`rf_out` anchor edits no longer clobber sibling cables |
| 0055 | wavelength_range | Phase R1/R2: rename `fiber.kindParams.operatingWavelengthRangeNm` → `wavelengthRangeNm`; back-fill `wavelengthRangeNm` on every non-emitter optical kind (visible `[400, 1100]`, NIR `[400, 1700]`, fiber `[770, 790]`); back-fill `tapered_amplifier.centerWavelengthNm = 780`; re-partition `intrinsic_params` / `state_params` against the refreshed manifest |
| 0056 | fiber_recombine_ends | **Reverses 0052.** A fiber is back to a single SceneObject; End A / End B pose hoisted into the fiber body PE.kindParams in body-local frame (`endA.{posMm,rotDeg,tensionHandleMm,polish,connectorType,…}` and `endB.…`). Moving / rotating the fiber moves the ends with it; per-end Align A / Align B buttons still adjust each end independently. Catalog Component `fiber_end_generic` is archived if no fiber_end SceneObjects remain |
| 0057 | agent_sessions | Backs the in-browser AI binding agent. Adds `agent_sessions`, `session_mutations`, `approval_events` tables, plus `status` / `created_by_session_id` / `ai_approved_at` columns on `assets_3d` and `components`. Composite indexes: `(status, last_heartbeat_at)` on sessions for the sweeper; `(session_id, undone_at, created_at)` on mutations for the undo hot path; partial `status='active'` indexes on assets_3d and components so list endpoints stay tiny as draft history grows |
| 0058 | agent_messages_json | Adds `agent_sessions.messages_json` (JSONB, nullable) for the Anthropic SDK `messages[]` array. Loaded by `agent_orchestrator` on every turn and rewritten after the turn so backend restart / browser refresh mid-session resumes the conversation |
| 0059 | drop_per_object_aperture | Reverses the V2 (0014) per-instance aperture override store. Strips `<anchorId>_apertureMm` flat keys, `perAnchorApertures` maps, and `aperture` payload fields from every `objects.properties`. Aperture is now strictly asset-level — edit on `Asset3D.anchors[].apertureMm` in PHY Editor → Optical → Components, and all SceneObjects sharing the asset share the value. Downgrade is a no-op stub (data is gone — a backup restore is needed if you need it back) |
| 0060 | waveplate_fast_axis_to_asset | Drains `fastAxisDegBeamLocal` from every waveplate `physics_elements.kind_params` / `intrinsic_params` / `state_params`. Fast-axis angle is now defined on the Asset3D anchor (`intercept_in.fastAxisDegBodyLocal`); per-instance rotation around the beam axis lives on `scene_objects.properties.rotationAroundBeamAxisDeg`. Solver composes `effective = asset + per-instance` at run time via `hydrate_waveplate_fast_axis`. Per-instance angles are discarded; re-establish with the Object panel's WaveplateAdjustControls knob |
| 0061 | tornos_dedicated_asset | Clones `primitive_box` into a dedicated `coherent_tornos_850_4_primitive` Asset3D and re-points the Coherent TORNOS-850-4 isolator at it, so PHY Editor anchor edits (e.g. `front_pbs` / `back_pbs`) only affect TORNOS rather than the ~30 other unrelated components that shared `primitive_box`. Same split pattern as 0054; idempotent. **Always clone, never share, an Asset3D across components that have user-editable anchors** |
| 0062 | component_bindings | New `component_bindings` table: polymorphic asset\|subcomponent tree per Component with `parent_binding_id`, `local_*` transform, `tunable_axes` JSONB declaring per-instance Euler DoFs (`{axis: {frame, min, max, default}}`), `role` label, `sort_order`. Three CHECK constraints (`XOR target`, `target_kind matches`, `no self-subref`) + cycle detection in the router. Backfills one root binding per Component that has a non-null `asset_3d_id` (preserves rendering through the legacy path while the new tree fills in). `Component.asset_3d_id` is *not* dropped yet — Stage G removes it once all read paths move off it. Idempotent backfill skips Components that already have ≥1 binding |
| 0063 | unify_asset_paths | Restructures `assets/` from the flat `uploads/` bucket to extension-grouped `files/<ext>/` (`glb/`, `gltf/`, `obj/`, `stl/`, `cad_sources/`). Single transaction moves files on disk + rewrites `Asset3D.file_path`; if any one file move fails, the whole thing rolls back. `agent_uploads/<session_id>/` is left alone — already per-session-scoped sandbox storage. Mapper lives in `services/asset_converter.subdir_for_ext` (single source of truth for upload endpoint + migration). `resolve_asset_path` now enforces an allowlist (`files/`, `agent_uploads/`) so stale `uploads/` references can't sneak back through a forgotten code path. Procedural rows (`primitive:*`, `procedural:*`) and rows already in `files/` are skipped. Downgrade is a full roundtrip back to `uploads/`, safe for dev |

Earlier highlights: `0027` V2 baseline (real `SimulationRun ↔ BeamSegment` FK),
`0036` multiphysics dispatch, `0042` rename of `optical_elements` →
`physics_elements`, `0044` `rf_links`, `0045` TimingProgram as reusable
schedule.

---

## Frontend deep dive

### App shell (`frontend/src/App.tsx`)

The page is a single full-viewport `.workspace-shell` with three regions:

```
┌─────────────────────────────────────────────────────────────────┐
│  <TopBar>          module switcher · scene tools · run buttons  │  (top)
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   currentModule = "optics_seq"  →  <DualViewerSplit>            │
│       + floating panels: catalog, outliner, component editor,   │
│         pulse timing, instrument power, RF link, optical link,  │
│         touch coincidence, magnetics, solver console, …         │
│                                                                 │  (center)
│   currentModule = "optics_cavity" → <OpticsHost>                │
│   currentModule = "spice"          → <ElectronicsWorkspace>     │
│   currentModule = "em_fem"         → <EmWorkspace>              │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  <ScrubTimeBar>            timeline playhead (gate override)    │  (bottom)
└─────────────────────────────────────────────────────────────────┘
```

PhyEditor takes over the whole canvas when
`sceneStore.editorMode === "phy-editor"` (full-screen anchors/spec editor).

### Page layout — floating panels

The center region is a Blender-style floating-panel canvas managed by
`workspace/WorkspaceProvider.tsx`. Every panel has `{ x, y, w, h, visible,
collapsed, z }` persisted to localStorage under
`qmem.workspaceLayout.v7` (the version suffix is bumped whenever the default
layout changes so existing users get re-seeded). Negative `x`/`y` resolve
against the viewport size at mount time, so panels stick to the right /
bottom edges regardless of window width.

Defaults (from `PANEL_DEFS` in `workspace/WorkspaceProvider.tsx`):

| Panel id | Title | Default position (px) | Size (w×h) | Visible | z |
|---|---|---|---|---|---|
| `components` | Components catalog | 16, 116 (top-left, below the Wireframe/Rendered pills + Cursor editor) | 300 × 420 | yes | 1 |
| `outliner` | Outliner | 16, 552 (under Components, +16 px gap) | 300 × 320 | yes | 1 |
| `object` | Object inspector | −340, 296 (top-right, below the XYZ gizmo + Tools pie) | 320 × 520 | yes | 1 |
| `pulse-timing` | Pulse & Timing | 332, 480 | 760 × 380 | no | 2 |
| `instrument-power` | Instrument Power | 332, 80 | 380 × 360 | no | 2 |
| `beam-scope` | Beam scope | 332, 80 | 560 × 460 | no | 2 |
| `touch-coincidence` | Touch coincidence | 332, 200 | 380 × 280 | no | 3 |
| `optical-link-viewer` | Optical link viewer | 360, 80 | 640 × 780 | no | 2 |
| `rf-link` | RF link | 360, 80 | 720 × 520 | no | 2 |
| `solver-console` | Solver console | −340, 600 (right column, below Object) | 320 × 260 | yes | 2 |
| `magnetics` | Magnetics overlay | −340, 80 | 320 × 460 | no | 2 |
| `ai-binding` | AI Binding | −340, 80 | 380 × 520 | yes (only when `VITE_ENABLE_AI_PANEL=true`) | 3 |

Layout rules:

- Panels can be dragged, resized, collapsed (header-only), and stacked
  via the `z` slot — `FloatingPanel.tsx` raises `z` on focus.
- The Window menu in `TopBar.tsx` toggles `visible`; closing a panel
  preserves its last `x/y/w/h` so re-opening lands it back in place.
- "Reset layout" in `TopBar.tsx` clears the localStorage key and
  re-seeds from `PANEL_DEFS`. Bumping `STORAGE_KEY` (currently `v7`)
  has the same effect for everyone on the next page load — use it
  whenever a default position moves so existing users don't stay
  stuck on the old one.
- The orientation gizmo, Wireframe/Rendered toggle, Cursor (mm)
  editor, and Initial Setup button live outside the floating layer
  and are not part of `PANEL_DEFS` (see `SceneToolbar.tsx`).

Bottom strip: `ScrubTimeBar.tsx` (timeline playhead) is permanently
mounted below the canvas — not a floating panel. Module-switch tabs
(top of the page) come from `ModuleSwitcher.tsx` inside `TopBar.tsx`.

Keyboard shortcuts:

| Key | Effect |
|---|---|
| `1`–`6` | Toggle overlay (components, connections, assembly_relations, optical_links, beam_segments, beam_paths) |
| `0` | Reset all overlay flags |
| `h` | Hide selected object in session |
| `s` | Solo selected object(s) |
| `Esc` | Unhide all in session / exit solo |

### Top-level components (`frontend/src/components/`)

| Region | File(s) | Role |
|---|---|---|
| Workspace shell | `workspace/TopBar.tsx`, `WorkspaceProvider.tsx`, `FloatingPanel.tsx`, `ScrubTimeBar.tsx`, `SolverConsole.tsx`, `ModuleSwitcher.tsx` | Top bar, draggable floating panel kit, scrub timeline, unified solver log, module tabs |
| 3D viewport | `DigitalTwinViewer.tsx`, `DualViewerSplit.tsx` | Three.js canvas; dual viewport with draggable split |
| Catalog & outliner | `AssetLibraryPanel.tsx` (exports `ComponentsCatalogPanel`, `OutlinerFloatingPanel`), `OutlinerPanel.tsx` | Drag-to-instantiate catalog; nested collections tree |
| Object editor | `ComponentPanel.tsx`, `IntrinsicSpecPanel.tsx` | Pose / visibility / locks / per-instance physics |
| PHY editor (full screen) | `PhyEditor.tsx`, `ComponentEditor.tsx`, `KindsEditor.tsx`, `component_editor/AnchorFaceSections.tsx` | Catalog metadata + anchor editor |
| Timing | `PulseTimingPanel.tsx` | Edit TimingProgram intervals |
| RF | `RfLinkPanel.tsx`, `ScrubTimeRfReadout.tsx` | Per-port Vpp / dBm / freq readout; chain inspector |
| Optical | `optical/OpticalLinkViewerPanel.tsx`, `optical/BeamScopePanel.tsx`, `optical/CursorMenu.tsx`, `optical/TargetLinksSection.tsx`, `optical/CapabilityPills.tsx` | Beam inspection, ray-scope viewer, cursor menu |
| Assembly | `TouchCoincidencePanel.tsx`, `AlignPanel.tsx`, `VisibilityControls.tsx` | Constraint solver UI + visibility kit |
| Per-kind physics | `physics/PhysicsElementPanel.tsx`, `LaserSourceControls.tsx`, `AomAdjustControls.tsx`, `TaperedAmplifierAdjustControls.tsx`, `SimpleAdjustControls.tsx`, `_shared.tsx` | Kind-specific inspectors, extracted from a previously 4000-line monolith |
| Power & state | `InstrumentPowerPanel.tsx` | Enabled / temperature / pressure readouts |
| DDS specifics | `DdsChassisObjectControls.tsx`, `Ad9959ObjectControls.tsx` | AD9959 chassis & per-chip UIs |
| Toolbar | `SceneToolbar.tsx`, `ToolbarHint.tsx`, `NumberField.tsx`, `CollapsibleSection.tsx` | Initial Setup button, shortcut help, shared inputs |
| AI binding (alpha) | `AIBindingPanel.tsx` | Drives the agent_orchestrator from the browser. Gated behind `VITE_ENABLE_AI_PANEL=true`. Three local states (`idle` / `running` / `terminal`) map to `agent_sessions.status`. 30 s heartbeat keeps the backend sweeper from auto-abandoning the session. Chat transcript is purely display state; the persisted source of truth for "what got created" is the `mutations` list from `GET /{id}`. Default layout is `visible: true` (post-`WorkspaceProvider` flip) — once the env flag is on, the panel opens with the workspace instead of needing a Window-menu click |

### Zustand store (`store/sceneStore.ts`)

State slices: `scene` (objects, components, assets, links, collections, beam
paths, optical/rf elements, connections, relations) · `selection` (object id +
multi-select, component, relation) · `visibility` (overlay flags + per-session
hidden/solo + active scene view) · `editing` (PHY editor mode, fiber/rf-cable
node editor, anchor editor, transform cursor & pivot mode) · `timing` (scrub
playhead, user timeline total) · `simulation` (currentModule, recent runs,
circuits, EM problems, meshes, RF chains, timing programs) · `network`
(loadStatus, socketStatus, error).

Public action groups: `loadScene/applyEvent` (I/O & WS) ·
`createObject/updateSceneObject/deleteObject` (instance ops, rigid-group aware)
· `select*` / `toggleSolo*` / `*SessionHidden*` (selection & visibility) ·
`createAssemblyRelation/applyRelationOnce/…` · `createCollection/`
`moveObjectToCollection/instantiateCollectionTemplate/…` ·
`loadTimingPrograms/createTimingProgram/…` ·
`loadRfChains/dispatchSimulationRun/…` ·
`enter/exit{Fiber,RfCable}Edit` · `updateFiberNodes/alignFiberEndToBeam/…` ·
`openPhyEditor/setPhyEditorView/updateAssetAnchors/…`.

WebSocket events feed in through `applyEvent`, which dispatches by event type
(`object.updated`, `component.created`, `beam_path.updated`, …) into the right
slice. Mutations are optimistic: the store applies the patch locally before
the network ack to keep dragging smooth.

### Kinds registry (`frontend/src/kinds/`)

Single source of truth for both UI and physics behavior. Layout:

```
kinds/
  _plugin.ts            PhysicsPlugin / PassivePlugin / ComponentPlugin interfaces
  _plugins.ts           PHYSICS_PLUGINS / PASSIVE_PLUGINS registries
  _registry.ts          AnchorId literal union, anchor contract types
  _capabilityProfile.ts (new) physics-capability tags per kind
  laser_source/index.ts
  mirror/index.ts
  aom/index.ts
  fiber/index.ts
  fiber_end/index.ts          (new, post-0052)
  rf_switch/index.ts          (new)
  programmable_pulse_generator/index.ts  (new)
  ... ~31 kinds total
```

A `PhysicsPlugin` declares: which `componentTypes` map to it, its
`elementKind`, anchor contract (required / optional / needs-direction /
needs-aperture), default kindParams, intrinsic/state key schemas, optional
`transferFunction` (for RF), a `renderer` (Three.js mesh factory) and an
optional `inspector` (React node). The backend reads the same data through
`backend/data/kinds.json`, regenerated from this registry by
[`scripts/export_kinds_manifest.ts`](scripts/export_kinds_manifest.ts).

### Three.js layer (`frontend/src/three/`)

- `loadAsset/` — formerly a single 3.5k-line `loadAsset.ts`; now a barrel
  (`loadAsset/index.ts`) that orchestrates GLTF/OBJ/STL loaders, per-componentType
  base colors, device-state overrides (overheating amp → red), per-component
  `properties.colorHex` overrides, mm scale. The split is **not** by feature
  but by what the cycle resolver needs first — `index.ts` imports every
  sub-module that contributes a binding *before* importing
  `primitive.ts`, because the latter triggers a `kinds/_plugins.ts` →
  `_renderer_bindings.ts` → `loadAsset` cycle and only the bindings declared
  before the re-entry point survive that path. Tree:
  - `materials.ts` — `createBox`, `materialFor`, shared PBR/standard
    material factories with per-kind colour tables.
  - `primitive.ts` — `createPrimitive` / `applyAssetScale`; the cycle
    trigger. Falls back to procedural geometry from `component_type` +
    `properties` when no Asset3D is present.
  - `fiber/{index,curve,spline,thorlabs_30126a9_fc_connector,types}.ts` —
    Bezier spline tube, ferrule transform helpers, FC/APC connector mesh.
  - `rf_cable/{index,cable_spline,bnc_male_connector,sma_male_connector}.ts`
    — analogous spline + jack/plug primitives for RF cables.
  - `passive/mechanical/` — clamping fork, pedestal post, post, post
    holder, TS2000A laser mount (procedural, no STL).
  - `passive/electronics/` — DDS MCU board, TCXO module, IEC C14 inlet,
    instrument chassis 1U, Mean Well IRM30, SMA bulkhead jack, USB-B
    jack (each a single file under the corresponding subdir).
  - `passive/text_annotation.ts` — 3D text overlay used by labels.
  - `stl_builders/` — per-model wrappers that load a specific STL and
    decorate it with overlays: AD9959 PCB-Z, Thorlabs BB1-E03, PBS252,
    WPHSM05/850. Used for assets where the raw STL alone isn't enough
    to communicate the part's physics (mirror coating side, PBS cement
    plane, waveplate fast-axis marker).
- `kinds/<kind>/renderer.ts` (new — split off from the old `loadAsset.ts`
  monolith) — every kind that needs more than primitive geometry now ships
  a dedicated renderer next to its plugin. Current movers: `aom/renderer.ts`,
  `tapered_amplifier/renderer.ts`, `rf_amplifier/renderer.ts`,
  `rf_source/renderer.ts`, `rf_switch/renderer.ts`. Each renderer file
  is paired with a `models/` subdirectory of per-model mesh recipes
  (`aaoptoelectronic_mt80`, `toptica_boosta_pro`, `minicircuits_zhl_1_2w_plus`,
  `analog_devices_ad9959_pcbz`, `minicircuits_zyswa_2_50dr`,
  `tapered_amplifier/models/generic_chip`). The barrel
  `kinds/_renderer_bindings.ts` collects these into a
  `RENDERER_BY_COMPONENT_TYPE` lookup that `loadAsset` consults.
- `kinds/isolator/pbsOverlay.ts` (new) — single-file home for the
  isolator's per-model PBS pose table (`ISOLATOR_PBS_DEFAULTS_BY_MODEL`),
  PBS mini-cube renderer, PBS overlay group builder (shared between TORNOS
  procedural path and the Thorlabs IO-series STL pipeline), and Thorlabs
  STL handler. `IsolatorPrismType` differentiates cement-bonded PBS cube
  (`pbs_cube`, default) from Glan-Laser air-gap calcite prisms
  (`glan_laser`, used in HP / high-power models). `yRotationDeg` is the
  recommended single-DoF rotation around body Y (every step lands on a
  physically valid face-diagonal normal); free `dir` and `rotationDeg`
  are escape hatches. `IsolatorDevPage.tsx` is a standalone dev page for
  iterating on overlay geometry without touching the main scene.
- `rayTrace.ts` — forward ray tracer running in the browser using loaded meshes.
  Emits from laser_source / tapered_amplifier along local +X, dispatches by hit
  componentType (mirror reflect, beam_splitter split, lens/waveplate/aom
  pass-through, detector/camera absorb). Bounded by 8 bounces and 1000 mm
  default path length. Output: `TraceSegment[]` cached as `BeamPath`.
- `opticalBeams.ts` — wavelength-colored cylinder meshes per segment, with
  dashed overlay for clip-at-aperture segments.
- `rfBadge.ts` / `hornFarfield.ts` — frequency/Vpp/dBm overlays on RF nodes;
  cos^n far-field lobe on horn antennas.
- `placement/` — gizmos, snap targets (anchor positions + beam intersections),
  3D-cursor pivot orbit/pan/zoom.
- `transformUtils.ts` — `labToThreeVector` / `labToThreeQuaternion`
  (ZXZ intrinsic), 1 Three.js unit = 100 mm by historical convention.

### Utility modules (`frontend/src/utils/`)

| File | Role |
|---|---|
| `rfPropagation.ts` | Forward BFS over RF graph; per-port Vpp/dBm/freq/source/saturation |
| `rfPropagationSchedule.ts` (new) | Scrub-time gate overrides into RF propagation |
| `rfLinkPorts.ts` (new) | Anchor domain & connector-family classification |
| `timingEvaluation.ts` | Evaluate TimingProgram at `tNs`; auto-fit timeline max |
| `ppgMounting.ts` (new) | Auto-instantiate a PPG + TimingProgram + rf_cable at a target ttl_in/trigger_in port |
| `fiberAlignment.ts` / `fiberAnchorResolver.ts` / `fiberBodyEndpointResolver.ts` (new) | Fiber spline + ferrule-tip math + endpoint→anchor binding |
| `rfCableAlignment.ts` / `rfCableAnchorResolver.ts` | Same for RF cables |
| `rigidGroup.ts` | Expand pose patch to all rigid-group members. `expandFiberBodyPose` adds an intrinsic fiber-body→ends cascade so moving the body translates / rotates both paired `fiber_end` SceneObjects as a unit (independent of any collection rigid_transform) |
| `beamPlacement.ts` / `beamSnap.ts` / `beamAnchor.ts` / `apertureCheck.ts` | Beam snapping, aperture clipping warnings. `findSnapToBeam` injects a virtual `tip` anchor (offset = `FIBER_END_TIP_OFFSET_MM`) for `fiber_end` SceneObjects since they render procedurally with no Asset3D anchors, so Align-to-beam can still land the ferrule tip on the ray |
| `emissionVisuals.ts` | Per-instance beam color override |
| `relationAnchors.ts` | AssemblyRelation selector → resolved Anchor |
| `v2Bindings.ts` | Per-instance overrides (mirror normal, AOM RF direction, …) |
| `visibility.ts` / `visibilityStorage.ts` | Cascade hidden state + localStorage adapters |
| `exprInput.ts` | Free-form number-expression parsing in inputs |

Tests under `frontend/src/utils/__tests__/` cover fiber alignment, RF
propagation, and the new `fiberBodyEndpointResolver`.

### Fiber single-object model (post-0056, reverses 0052)

A "fiber" in the UI is **one SceneObject** with End A / End B baked
into its PE.kindParams in the body-local frame:

```
fiber SceneObject               ← single Outliner entry; selection covers everything
  ├── tube (Bezier spline through fiberNodes — interior + endpoints)
  ├── ferrule A   posed at kindParams.endA.{posMm, rotDeg}
  └── ferrule B   posed at kindParams.endB.{posMm, rotDeg}
```

`fiber.kindParams.endA` / `endB` schema:

```ts
{
  posMm:          [x, y, z],   // body-local mm — ferrule TIP = optical port
  rotDeg:         [rx, ry, rz],// body-local Euler XYZ
  tensionHandleMm:[dx, dy, dz],// wire-extension direction in the end's
                               // body-local frame; the spline Bezier
                               // handle = rotation(rotDeg) · tensionHandleMm
  polish, connectorType, apertureDiameterMm, wavelengthRangeNm, ...
}
```

`fiberAnchorResolver.ts` resolves `intercept_in` / `intercept_out` from
`endA.posMm` (ferrule tip) and `endA.tensionHandleMm` (port direction)
when the anchor opts in via `Anchor.derivedFromFiberEndpoint`; falls
back to the stored anchor when kindParams isn't available (e.g. an
un-instantiated catalog template). `fiberBodyEndpointResolver.ts`
helpers `resolveEndpointFromKindParams` and `bodyHandleToTensionHandle`
go in the other direction — they recover spline endpoint nodes from
the kindParams so renderer, ray-tracer, and solver agree on port
position.

Aligning belongs to each end: `physics/_shared.tsx` ships a dedicated
`FiberEndAlignControls` component (rendered from `AlignToBeamSection`
for `elementKind === "fiber"`) with separate "Align End A" / "Align
End B" buttons. Each snaps the corresponding ferrule tip onto the
nearest beam by translating `kindParams.endA.posMm` /
`endB.posMm` — body lab pose and the other end stay put, and end
rotation is preserved so manual `rotDeg` isn't clobbered.

Default catalog seeding: `default_kind_params_for_component` in
`backend/app/routers/components.py` derives `endA` / `endB` from the
catalog's `fiberNodes` — `posMm` from the node position,
`tensionHandleMm` from the unit-normalised catalog tangent
(`handleOutMm` at end A, `handleInMm` at end B, scaled to 10 mm),
falling back to the end→other-end direction if the catalog handle is
missing or zero.

`kinds/_capabilityProfile.ts` falls back to the default profile (fiber
is Outliner-visible, lockable, rigid-group participant, gizmo-
attachable, Remove-able). The only override is
`endpointSplineNodesLocked: true` so spline endpoints only move via
the per-end Align buttons, not by free-dragging the endpoint anchor
sphere. Interior spline nodes stay draggable. The `fiber_end` kind is
retained in the manifest as a legacy plugin so historical data can
still be parsed, but no SceneObject of that kind can exist post-0056.

### API client (`frontend/src/api/client.ts`)

A thin axios layer over `VITE_API_BASE_URL`. Method groups:

- **Scene**: `fetchScene`, `fetchRoomDimensionsApi`, `updateRoomDimensionsApi`
- **Objects**: `createObjectApi`, `updateObjectApi`, `deleteObjectApi`,
  `upsertObjectForComponentApi`
- **Components**: `createComponentApi`, `updateComponentApi`,
  `deleteComponentApi`, `uploadComponentAssetApi`, `importLocalComponentAssetApi`
- **Component bindings (new, post-0062)**: `listComponentBindingsApi`,
  `createComponentBindingApi`, `getComponentBindingApi`,
  `updateComponentBindingApi`, `deleteComponentBindingApi`. Payload types
  `ComponentBindingCreatePayload` / `ComponentBindingUpdatePayload`
  expose `parentBindingId`, `targetKind`, `assetThreeDId`/`subComponentId`,
  `role`, `localXMm`/`localYMm`/`localZMm`/`localRxDeg`/`localRyDeg`/`localRzDeg`,
  `tunableAxes`, `sortOrder`, `properties` in camelCase (the backend
  serialises snake_case → camelCase on the way out)
- **Assets**: `updateAssetApi`
- **Assembly**: `createAssemblyRelationApi`, `updateAssemblyRelationApi`,
  `deleteAssemblyRelationApi`, `applyRelationOnceApi`
- **Collections** & **Collection templates** (new): `createCollectionApi`,
  `moveCollectionApi`, `moveObjectToCollectionApi`, `unlinkObjectFromCollectionApi`,
  `listCollectionTemplatesApi`, `saveCollectionAsTemplateApi`,
  `instantiateCollectionTemplateApi`, `deleteCollectionTemplateApi`
- **Optical (Phase A)**: `createOpticalElementApi`, `updateOpticalElementApi`,
  `deleteOpticalElementApi`, `createOpticalLinkApi`, …,
  `runOpticalSimulationApi`, `runOpticalTransientApi`, `autoRegisterOpticalApi`,
  `autoRegisterOpticalAllApi`
- **RF**: `fetchAllRfChainsApi`
- **Timing**: `listTimingProgramsApi`, `getTimingProgramApi`,
  `createTimingProgramApi`, `updateTimingProgramApi`, `deleteTimingProgramApi`
- **Device state**: `updateDeviceStateApi`
- **Scene views**: `listSceneViewsApi`, `createSceneViewApi`,
  `updateSceneViewApi`, `duplicateSceneViewApi`, `deleteSceneViewApi`
- **Simulation runs (V2)**: `fetchSimulationRunsApi`, `fetchSimulationRunApi`,
  `createSimulationRunApi`
- **Electronics (Phase B)**: `createCircuitApi`, …
- **EM (Phase C)**: `createEmProblemApi`, `uploadMeshApi`, `fetchMeshesApi`, …
- **AI binding agent (alpha, post-0057)**: `createAgentSessionApi`,
  `getAgentSessionApi`, `heartbeatAgentSessionApi`,
  `commitAgentSessionApi`, `cancelAgentSessionApi`,
  `undoLastMutationApi`, `uploadAgentFileApi`. The
  `streamAgentMessage` helper does *not* go through axios — POST
  `/api/agent-sessions/{id}/messages` returns `text/event-stream`,
  which axios doesn't unwrap incrementally, so the helper uses
  `fetch` + `ReadableStream` directly and yields `assistant_chunk`,
  `tool_call`, `tool_result`, `done`, and `error` events to the
  caller. SSE field remap: backend `tool_use_id` / `is_error` /
  `stop_reason` become `toolUseId` / `isError` / `stopReason` so the
  rest of the payload passes through camelCase

WebSocket: app shell opens a single connection to `WS_URL` on mount, pipes
events into `sceneStore.applyEvent`, tracks status, and auto-reconnects on
close.

### Top-level types (`frontend/src/types/digitalTwin.ts`)

`SceneObject` (now carries `properties.bindingOverrides`, keyed by binding
id, for per-instance ComponentBinding DoFs — and `properties.rotationAroundBeamAxisDeg`
for waveplate per-instance rotation post-0060), `ComponentItem`, `ComponentBinding`
(post-0062 — `targetKind`, `assetThreeDId`/`subComponentId`, `localXMm`…`localRzDeg`,
`tunableAxes: { [axis]: { frame, min, max, default } }`, `role`, `sortOrder`),
`Asset3D`, `Anchor` (with `connectorType`, `derivedFromFiberEndpoint`,
`derivedFromRfCableEndpoint`; waveplate fast-axis lives on
`Anchor.fastAxisDegBodyLocal` post-0060), `OpticalLink`,
`PhysicsElement`, `BeamPath`, `OpticalPort`, `Spectrum` /
`SpectrumComponent` / `GaussianMode` / `JonesVector`, per-kind param structs
(`LaserSourceParams`, `TaperedAmplifierParams`, `MirrorParams`,
`LensSphericalParams`, `WaveplateParams`, `FiberParams`, …), `AssemblyRelation` /
`RelationType` / `GeometrySelector`, `Collection` / `CollectionMember` /
`CollectionTemplate`, `TimingProgram`, `RfSourceParams` / `RfAmplifierParams` /
`RfCableEndpointLink` / `RfChainNode`, `DeviceState`, `SimulationModule` /
`SimulationRunV2`, `Circuit`, `EmProblem`, `Mesh`, `ElementKind` (union of all
~31 kind strings), `PhysicsCapability`.

---

## Coordinates & units

Lab frame (database): **millimeters**. Mapped into Three.js as:

- lab X → Three.js X
- lab Y → Three.js −Z
- lab Z → Three.js Y
- 1 Three.js unit = 100 mm (historical scale; renderers and gizmos all assume
  this)

Rotations in the DB are degrees, ZXZ intrinsic Euler (`rxDeg`, `ryDeg`,
`rzDeg`). Conversion lives in `frontend/src/three/transformUtils.ts`.

---

## Assets pipeline

Layout (post alembic 0063):

```
assets/
  files/
    glb/          viewer-ready glTF binary
    gltf/         viewer-ready glTF JSON + sidecar bin
    obj/          viewer-ready Wavefront OBJ
    stl/          viewer-ready STL (~195 files)
    cad_sources/  STEP / STP / SLDPRT / DXF (original CAD geometry — never
                  rendered directly; sits here for re-export to a
                  viewer-ready format. ~10 files)
  agent_uploads/<session_id>/<uuid-prefixed-name>
                  per-AI-binding-session sandbox; survives commit, is
                  swept on session timeout (cancel/abandon leaves orphans
                  — see janitor note in Troubleshooting)
```

Drop files under the appropriate `assets/files/<ext>/` subdir and reference
them in `assets_3d.file_path`, e.g. `files/glb/my_mount.glb`. The upload
endpoints route files automatically via `services/asset_converter.subdir_for_ext`
(the single mapper used by both `routers/assets.py` upload paths and the
0063 migration). FastAPI serves the tree at
`http://localhost:8010/assets/files/glb/my_mount.glb`. If no file is present,
the frontend falls back to primitive geometry derived from `component_type`
and `properties`.

`services/asset_converter.resolve_asset_path` enforces an allowlist
(`files/`, `agent_uploads/`); any other prefix (`uploads/…`, absolute
paths, `..` traversal) is rejected before the file is opened. This is
the post-0063 guard against stale references sneaking back in via a
forgotten code path.

For Onshape STEP → STL conversion see `scripts/convert_step_to_stl.py`.
The `backend/scripts/upsert_*.py` files generate catalog rows for specific
parts (BNC adapters, ZHL-1-2W amp, AD9959 chassis, programmable pulse
generator, …). Hardcoded `file_path` literals in those scripts were
rewritten by Stage B; new upserts should always write `files/<ext>/…`
paths.

---

## WebSocket protocol

Endpoint: `ws://<host>/ws` (the older `/ws/scene` path is gone). The hub
broadcasts JSON envelopes:

```jsonc
{ "type": "object.updated",     "payload": { ...SceneObject }   }
{ "type": "object.created",     "payload": { ...SceneObject }   }
{ "type": "object.deleted",     "payload": { "id": "..." }      }
{ "type": "component.updated",  "payload": { ...ComponentItem } }
{ "type": "beam_path.updated",  "payload": { ...BeamPath }      }
{ "type": "device_state.updated","payload":{ ...DeviceState }   }
{ "type": "connection.updated", "payload": { ...Connection }    }
{ "type": "timing_program.updated", "payload": { ...TimingProgram } }
{ "type": "collection.updated", "payload": { ...Collection }    }
{ "type": "scene.reload" }     // full re-fetch
```

Clients also receive their own emitted mutations so optimistic state is
reconciled against the authoritative payload.

---

## AI binding agent (alpha)

> **Feature flag.** Hidden by default. To enable in dev:
> 1. Set `VITE_ENABLE_AI_PANEL=true` in `frontend/.env` (or as an env var when
>    running `npm run dev`). Three frontend gates all read this flag: `App.tsx`
>    decides whether the panel component mounts at all; `WorkspaceProvider.tsx`
>    seeds the default panel layout (currently `visible: true` so the panel
>    opens with the workspace once mounted); `TopBar.tsx` decides whether
>    the Window menu lists it for re-opening. Flip the env var off + reset
>    layout to hide everywhere.
> 2. Set `ANTHROPIC_API_KEY=…` in the backend `.env`. An empty key leaves
>    session lifecycle working but makes `POST /messages` return a friendly
>    error, so the panel can render "API key not configured" instead of
>    crashing.

### Why it exists

Binding a brand-new 3D model to a catalog Component (asset upload → anchor
edit → component type tagging → physics-capability checklist) is multi-step
and easy to fumble. The AI binding agent automates the rote parts: the user
uploads a CAD file and types "this is an AOMO 3080 driven by a 100 MHz SMA
input"; the agent calls `create_asset` and `create_component` as drafts; the
user reviews the diff and clicks Approve.

### State machine

```
       start
        │
        ▼
   ┌─────────┐  commit   ┌────────────┐
   │ running │──────────▶│ committed  │  drafts → active, ai_approved_at set
   └─────────┘           └────────────┘
       │ │
       │ ├─ cancel ─────▶ cancelled   reverse-replay session_mutations
       │ │                            (cancellation_reason='user_cancelled')
       │ │
       │ └─ heartbeat lapses ▶ abandoned  same rollback, reason='abandoned_timeout'
       │                                  (driven by the 60 s sweeper loop in main.py)
       │
       └─ undo last ──▶ marks mutation.undone_at; row stays for audit
                       (`UndoBlockedError` if FK dependents not yet undone)
```

Terminal states (`committed` / `cancelled` / `abandoned`) are immutable;
any write returns HTTP 409. The frontend prompts to start a new session.

### Tool layer

The agent has exactly five tools (`backend/app/services/agent_tool_schemas.py`):

| Tool | Purpose |
|---|---|
| `list_kinds` | All valid `component_type` strings — agent is told to call this before `create_component` if unsure |
| `list_existing_assets` | All `status='active'` Asset3D rows plus drafts from the current session. Lets the agent reuse an existing `asset_3d_id` instead of duplicating |
| `list_existing_components` | Same, for Component catalog |
| `create_asset` | Register an Asset3D draft (`status='draft'`, `created_by_session_id` = this session) |
| `create_component` | Register a Component draft, optionally bound to an Asset3D id |

The last tool definition carries
`cache_control: {type: "ephemeral"}` so the full tools + system-prompt
prefix caches across turns inside one session. Adding or reordering tools
invalidates the cache; treat the schema list as stable per release.

**No update or delete.** v1 deliberately restricts the agent to `create`;
the `session_mutations.op` column and `before`/`after` JSONB columns are
already shaped for `update`/`delete` once that restriction is relaxed.
Any attempt to touch an `ai_approved_at IS NOT NULL` row raises
`EntityLockedError` and is logged as
`approval_events.event_type='modify_blocked'`.

### Commit / cancel semantics

- `POST /commit` — for every row with `created_by_session_id = this`,
  flip `status` `draft → active` and stamp `ai_approved_at = now()`.
  Returns the lists of approved asset / component ids. Approved rows
  become read-only to *future* agent sessions but are fully editable
  via the normal REST routes (the agent is the only consumer that
  honors `ai_approved_at`).
- `POST /cancel` — walk `session_mutations` in reverse order (skipping
  `undone_at IS NOT NULL` rows), DELETE each `entity_id` from its
  `entity_type` table. FK ordering matters: a Component that
  referenced an Asset created in the same session is undone before
  the Asset.
- `POST /undo-last` — finds the latest non-undone mutation, deletes
  the row from the entity table, sets `undone_at = now()` on the
  mutation row (keeps it for audit), and lets the agent try again on
  the next turn. Raises `UndoBlockedError` if undoing would violate a
  FK from a not-yet-undone later mutation.

### SSE event stream

`POST /api/agent-sessions/{id}/messages` returns `text/event-stream` with
these event types (one event per `data:` JSON blob):

```jsonc
event: assistant_chunk
data: { "text": "..." }            // streaming model text

event: tool_call
data: { "id": "...", "name": "create_asset", "input": {...} }

event: tool_result
data: { "tool_use_id": "...", "content": ..., "is_error": false }

event: done
data: { "stop_reason": "end_turn" }

event: error
data: { "message": "..." }
```

`X-Accel-Buffering: no` and `Cache-Control: no-cache` headers are set so
nginx-style proxies don't buffer the stream. The orchestrator bumps the
session heartbeat at the start of every turn so a long tool-use turn can't
get reaped mid-flight by the sweeper.

### Uploads

`POST /api/agent-sessions/{id}/uploads` accepts a multipart `file`. The
extension picks the kind: `.glb`/`.gltf`/`.obj`/`.stl`/`.step`/`.stp`/
`.sldprt`/`.dxf` are `asset_file` (50 MB cap); `.png`/`.jpg`/`.jpeg`/
`.webp`/`.gif` are `image` (10 MB cap — images get base64-encoded into
the model context). Files land under
`assets/agent_uploads/<session_id>/<uuid-prefixed-name>` and are served
back through the `/assets/*` static mount if needed. The response
metadata (`stored_name`, `file_path`, `kind`, `media_type`) is what the
frontend echoes back as `attachments[]` in the next `/messages` POST —
the backend re-derives the path from `stored_name` to prevent path
traversal.

### Persistence across restarts

`agent_sessions.messages_json` (alembic 0058) holds the Anthropic SDK
`messages[]` array. The orchestrator loads it at the start of every
turn and writes it back after the model finishes the turn, so a
backend restart or browser refresh mid-session resumes the conversation
without losing context. `NULL` means "no turns yet" (equivalent to
`[]`). Stored as JSONB (not TEXT) so future debug queries can index
into specific message indices via `messages_json -> N` operators.

---

## Phase 2 / roadmap

- **Onshape sync** — placeholder client at
  `backend/app/services/onshape_client.py`. Plan: add metadata-link table +
  `/api/onshape/*` routes once the scene/placement/assets/WS loop is stable.
- **Optics cavity & nonlinear crystal solvers** — module stubs exist
  (`routers/optics_cavity.py`, `routers/optics_crystal.py`, matching solver
  files); fill in Phase D.
- **Palace via SSH** — config exists in `settings`; current EM solver is the
  Phase C.5 mock. See `docs/PHASE_C_WORKSTATION_SETUP.md`.
- **Fiber editor full UX** — single-object model (post-0056) is in place
  and Align-A/Align-B works; node-edit UX for interior spline points is
  still rough, especially when both ends are simultaneously selected.
- **AI binding agent v2** — relax the create-only restriction
  (`session_mutations` schema already supports `update`/`delete`),
  unify the "approve" UI with the existing PHY Editor, and persist
  agent chat transcripts to their own table once the in-memory
  `chat` state grows beyond what `messages_json` already captures.
- **ComponentBinding read-path migration (Stages D → G).** 0062 added the
  table and backfilled one root binding per Component but `Component.asset_3d_id`
  is still the read source of truth for every renderer. Remaining stages:
  Stage D — frontend reads bindings instead of the legacy pointer in
  `loadAsset` / PHY Editor; Stage E — per-instance `properties.bindingOverrides`
  surfaces in the Object panel; Stage F — `IsolatorLinkedRotationGroup` /
  `pbsOverlay`'s bespoke per-model PBS pose table collapses into a
  generic binding-driven solver; Stage G — drop `Component.asset_3d_id`
  once nothing reads it. Until Stage G lands the two pointers must stay
  in sync (root binding's `asset_3d_id` mirrors the column).

---

## Troubleshooting & optimization notes

These are observations from the current codebase. Not bugs — flags worth
keeping in mind while extending the system.

### Backend

- **`uvicorn.err.log` and `uvicorn.out.log` are tracked in git.** They grow
  unboundedly (the `.out.log` is already ~300 KB) and create churn every time
  the dev server runs. Move them to a path that `.gitignore` covers, or write
  them to `%TEMP%`. Right now they appear in every `git status`.
- **Kinds manifest drift** — `backend/data/kinds.json` is checked in but
  regenerated from the frontend by `scripts/export_kinds_manifest.ts`. There's
  no pre-commit guard; a CI check or pre-commit hook that runs the exporter
  and diffs the result would close this gap (`backend/scripts/audit_kind_drift.py`
  exists but isn't enforced).
- **`/api/scene` returns a fully denormalized snapshot.** Useful for cold
  start, but it's also the biggest single response. For large labs consider
  ETag + If-None-Match, or paginate by collection.
- **WebSocket events broadcast every individual write.** Commit
  `461b7a8` introduced batched object updates so 50 transforms cause 1
  re-render; the same pattern should be applied to bulk relation/link/
  device-state writes (currently still N events).
- **Several routers re-implement similar validation.** `optical_links.py`,
  `rf_chains.py`, `assembly_relations.py`, and `physics_elements.py` each
  parse `kindParams`, validate ports, check connector compatibility — much
  of this could move into a shared `services/scene_validation.py`.
- **`crud.py` is barely used.** Most routers hand-roll session ops. Either
  expand the helpers or delete the file.
- **`uuid7.py` is dead code.** Tables all use `uuid.uuid4()`. Remove unless
  the next migration plans to switch to time-ordered ids.

### Frontend

- **`sceneStore` is large and central.** Recent commits have already split out
  constants, persistence, and helpers (`69e7bd1`). Continue extracting
  per-domain slices (rfChains, timingPrograms, simulationRuns) so the file
  stops growing.
- **`DigitalTwinViewer.tsx` re-renders a full Three.js scene graph on most
  store changes.** Per-object dirty tracking + `THREE.Object3D` reuse would
  cut a lot of allocations; right now CPU time per frame is dominated by
  rebuilding sub-meshes for unchanged objects.
- **Two ray tracers** — the browser one in `three/rayTrace.ts` and the backend
  one in `solvers/optics_seq.py`. They produce different segment shapes
  (frontend has waist & power, backend has time-stamped BeamSegment rows).
  Make sure both agree at the segment level, otherwise the BeamScopePanel will
  disagree with persisted solver runs.
- **Many components import directly from siblings.** A few barrel files
  (`components/index.ts`, `kinds/index.ts`) would let `App.tsx` shrink and let
  test mocks be more surgical.
- **`utils/` has grown to ~25 files.** Group them under `utils/rf/`,
  `utils/fiber/`, `utils/beam/` to make ownership obvious.
- **The kinds plugin registry has no exhaustiveness check at runtime.**
  `__tests__/plugin_exhaustiveness.test.ts` covers it for compile-time; if a
  PassivePlugin is registered without a renderer the scene renders a missing
  mesh silently. A startup assertion would surface this earlier.
- **Optimistic updates lack a rollback path.** If a PUT fails after the store
  applied the patch optimistically, the local state stays stale until the
  next `/api/scene` reload. Wrap mutations in a small "previous-value
  snapshot" so failures can revert.
- **`WorkspaceProvider.STORAGE_KEY = "qmem.workspaceLayout.v7"`.** Anytime
  you change a default panel position, size, or visibility in `PANEL_DEFS`,
  bump the suffix (`v7` → `v8`). Existing users carry the old layout in
  localStorage and will silently keep the old defaults forever otherwise.
  The recent AI-binding flip from `visible: false` → `visible: true` is a
  case in point: returning users won't see the change until the key is
  bumped or they hit Reset Layout.
- **Two visibility gates for the AI panel can drift.** `App.tsx` mounts the
  component when `VITE_ENABLE_AI_PANEL=true`, and `WorkspaceProvider.tsx`
  separately decides whether the default layout is open. If the env var is
  off, the default `visible: true` is harmless because the component never
  mounts; but if you later disable the panel for another reason (legal,
  cost), make sure to change both files plus the `TopBar` Window-menu
  gate, or one entry point will leak through.

### Data / migration hygiene

- **Migrations 0017–0026 are mostly fiber/AOM defaults backfills.** Consider
  squashing pre-V2 (≤ 0026) into a baseline once the production install can
  be reset; alembic history is dense and slow to apply on fresh DBs. Doubly
  true now that 0052 was reversed by 0056 — the round-trip ends up as net
  zero schema change but a forward upgrade still walks both migrations.
- **Anchor `connectorType` (0050) is nullable.** Migrations and routers treat
  null as "unknown"; the frontend treats it as "compatible with everything".
  Tighten one or the other so cable-misconnect warnings work end-to-end.
- **Shared-asset anchor clobbering (fixed in 0054).** Three rf_cable
  components used to share `primitive_thorlabs_ca2906_cable`. Editing
  the BNC cable's `rf_in` anchor in PHY Editor silently overwrote the
  SMA cable's anchors. Migration 0054 + the updated
  `upsert_bnc_rf_cables.py` give each variant its own Asset3D row. If
  you add another procedural family in the future, **never share an
  Asset3D across components that have user-editable anchors** — clone
  the row in the seed script instead.
- **Agent draft lifecycle is invisible to existing REST routes.** 0057
  added `status='draft'` rows but the list endpoints
  (`/api/assets`, `/api/components`) do not yet filter them out — a
  draft created by a crashed session will appear in the catalog
  panel until the sweeper auto-abandons it 5 minutes later. Either
  add `WHERE status='active'` to the catalog list queries, or wire a
  hard "only my session can see drafts" check in the agent_tools
  layer.
- **Composite indexes added in 0057 are partial.** Both
  `ix_assets_3d_status_active` and `ix_components_status_active` use
  `postgresql_where=status='active'`, which keeps them tiny but
  means a future query that filters on `status='draft'` won't get
  indexed lookups. Acceptable today (draft scans only happen inside
  one session), worth knowing if you ever add a bulk draft viewer.
- **`Component.asset_3d_id` and `component_bindings` are dual sources of
  truth.** 0062 backfilled one root binding per Component, but the
  legacy pointer was not dropped and is still what every renderer
  reads. Two writers + one read path = inevitable drift if a fresh
  Component is created via the new bindings router only, or if the
  bindings tree is edited but the legacy pointer is left stale.
  Until Stage G ships, keep them in sync (root binding's `asset_3d_id`
  mirrors the column) or pin all writes to the legacy column. The
  `auto_create_physics_element_for_object` path is fine — it goes
  through `Component.asset_3d_id` only.
- **ComponentBinding cycle protection runs in Python, not SQL.** The
  router walks the candidate sub-component's transitive closure with
  a frontier list. Trees are shallow in practice (isolator → PBS is
  depth 1) so the iterative walk is cheap, but a malicious payload
  with a wide closure could in theory pull a lot of rows. The CHECK
  constraint `ck_component_bindings_no_self_subref` only guards depth
  0; depth ≥ 1 cycles must go through the application path. Don't
  bypass the router.
- **Asset-level aperture / fast-axis are global.** Post-0059 and 0060
  edits to `Asset3D.anchors[].apertureMm` and
  `Asset3D.anchors[].fastAxisDegBodyLocal` apply to every SceneObject
  that shares the asset. The TORNOS isolator (0061) was split out of
  `primitive_box` for this exact reason — if you find yourself wanting
  per-instance behaviour, the right answer is "clone the asset" not
  "patch the per-instance override", which is gone.

### Dev quality of life

- The repo root has dozens of debug PNGs from earlier alignment sessions
  (`ad9959-*`, `sma-*`, `aom-*`, `zhl-*`). They predate the `.gitignore` and
  inflate clones. Either move them under `docs/screenshots/` or delete and
  rely on the ones in `docs/` proper.
- `assets/agent_uploads/` accumulates per-session subdirectories with
  every CAD file the agent has ever been shown. Sessions that
  `commit` keep their uploads forever (they are the bound asset
  data); sessions that `cancel` or `abandon` leave orphaned
  directories. Add a janitor that walks
  `agent_sessions WHERE status != 'committed' AND created_at < now() - interval '7 days'`
  and `rmtree`s the matching upload dir.
- The AI binding panel's chat transcript is in-memory only
  (`useState<ChatBubble[]>`). A backend-side
  `messages_json` survives restarts, but the human-readable
  transcript does not. If the panel becomes user-facing, persist the
  rendered transcript alongside `messages_json` or rehydrate it from
  the SDK history on `getAgentSessionApi`.

---

### Frontend behaviour worth knowing

- **Per-panel Home view (new).** `sceneStore.homeView` persists a
  custom camera pose per viewport panel (left / right) to
  localStorage; the H button in the orientation gizmo
  restores the saved pose, or the factory default when none is set.
  `loadHomeView` / `saveHomeView` live in `store/_persistence.ts` and
  sanitize against degenerate up-vectors (would let `lookAt` produce
  NaN otherwise). Bookmark / un-bookmark icons in `DigitalTwinViewer`
  drive `setHomeView`.
- **Fiber body cascade was removed.** `expandFiberBodyPose` and the
  `expandFiberBodyPose` branch in `sceneStore.updateSceneObject` are
  gone (0056 collapsed the cluster — the body moves the ends because
  they are now sub-objects of its kindParams, not because of a
  store-side rigid-group expansion). Don't reintroduce the old call
  path; the resolver does the right thing already.

---

*Last regenerated: 2026-05-19 (Alembic revision 0063: drop per-object
aperture override (0059) → waveplate fast-axis moved to Asset (0060) →
TORNOS isolator gets dedicated Asset (0061) → ComponentBinding tree
(0062) → asset paths unified under `files/<ext>/` (0063); plus Stage C
ORM split into themed `models/` package and the `loadAsset/` tree split
with per-kind `renderer.ts` files + isolator PBS overlay).*
