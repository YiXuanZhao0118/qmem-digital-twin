# QMEM Digital Twin

A live, browser-based digital twin of a quantum-memory optical table. The user
arranges real lab parts in 3D, wires their RF/TTL chains, defines their pulse
schedules, then dispatches multiphysics solvers (sequential ray-trace, RF
graph propagation, SPICE, EM FEM, DC magnetostatics) on demand. The scene is
the single source of truth — every panel reads from it, every event mutates it,
and every solver returns into it.

> **Schema epoch.** Currently at **alembic 0091** — the legacy
> `components.component_type` and `assets_3d.physics_kind` columns
> were collapsed into a single `kind_id` slug pointing at the new
> `kinds` registry table (alembic 0086) and the legacy columns were
> dropped (0090). 0091 walks every Asset3D and rotates
> `bodyFramePositionMm` by `R_body⁻¹` — see the migrations table for
> the read-side caveat. Asset-Physics-Model v3 has graduated from a
> behind-flag experiment to the **sole** physics path: the v3
> anchor-centric ray tracer
> ([`backend/app/optical/anchor_tracer.py`](backend/app/optical/anchor_tracer.py)
> + [`anchor_ops/`](backend/app/optical/anchor_ops/)) is what
> [`three/v3TraceAdapter.ts`](frontend/src/three/v3TraceAdapter.ts)
> feeds to every downstream consumer that used to read the legacy
> `TraceSegment` shape. v2's `componentType` dispatch is gone; UI
> types still expose a `kindId` field for compat reads but the
> backend writes the new shape exclusively.

> **Two reading orders:**
> - This README is a top-down architectural map (backend ↔ frontend ↔ data).
> - [`docs/vibe coding.md`](docs/vibe%20coding.md) is the running notebook
>   (frame/unit conventions, per-kind ParamSchemas, align algorithms, extension
>   recipes). Updated in place as the codebase evolves — not a changelog
>   (`git log` is).
> - [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md) is the
>   long-form companion to this README.
> - [`docs/asset-physics-model.md`](docs/asset-physics-model.md) +
>   [`docs/asset-physics-implementation.md`](docs/asset-physics-implementation.md)
>   describe the **Asset-Physics-Model v3** — the face-based ray-tracer that
>   collapses optical physics onto Asset3D and replaces the kind-string
>   dispatch in v2. Phase 3a/3b code lives alongside v2 today (gated by
>   `?useV3RayTracer=1` / localStorage flag); see
>   [Asset-Physics-Model v3](#asset-physics-model-v3-phase-23) below for
>   the architectural map.
> - [`docs/phase-3b-review.md`](docs/phase-3b-review.md) is the post-Phase-3b
>   audit (file map, design decisions, gaps, test inventory).
> - [`docs/frame-anchor-architecture.md`](docs/frame-anchor-architecture.md)
>   is the **single source of truth** for the 5-layer frame stack
>   (Lab → Object-local/CAD → Body → Binding-local → Anchor), the
>   `bodyFramePositionMm` + `body_frame_rotation` semantics
>   (Phase 9.10 vs 9.11 — see §3 for the live convention), every
>   anchor-id convention, OpticalLink / RfLink / Fiber / RfCable
>   plumbing, and the known optimisation backlog (§15–§17). **Read it
>   before touching any frame/anchor/link/cable code** — most of the
>   bugs in that area come from forgetting the body-frame lift.

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
11. [Asset-Physics-Model v3 (Phase 2/3)](#asset-physics-model-v3-phase-23)
12. [Phase 2 / roadmap](#phase-2--roadmap)
13. [Troubleshooting & optimization notes](#troubleshooting--optimization-notes)

---

## Glossary & domain model

The data model has **three catalog tiers** plus a **scene graph** layered on top:

| Term | Meaning | DB table | API path |
|------|---------|----------|----------|
| **Asset** | A 3D file (`.stl` / `.glb` / `.step` / primitive) in the asset library. Owns `anchors[]`. | `assets_3d` | `/api/assets` |
| **Component** | A part type in the catalog ("AOMO 3080", "DBR-852-TOSA"). Composed of one or more bindings (asset or sub-component) in a tree. | `components` | `/api/components` |
| **ComponentBinding** | A node in a Component's composition tree. Each binding targets either an `Asset3D` (raw geometry), another `Component` (sub-component), or **nothing** (`target_kind='empty'`, since alembic 0066 — a transform-only intermediate node). `tunable_axes` declares per-instance Euler DoFs; `properties.linkGroup` lets sibling bindings share a single user slider. | `component_bindings` | `/api/components/{id}/bindings` · `/api/component-bindings/{id}` |
| **Object** | An **instance** of a Component placed in the scene. Has pose, visibility, locks. Catalog-shared baseline (per-axis local pose, asset target) lives on `ComponentBinding`; per-instance tweaks live in a separate `object_bindings` row. | `objects` | `/api/objects` |
| **ObjectBinding** | Per-SceneObject override of a `ComponentBinding` (alembic 0076). Carries nullable per-axis pose **deltas** (`local_x_mm_delta`, …, `local_rz_deg_delta`) added on top of the binding baseline, plus an optional `asset_3d_id_override` to swap which Asset3D is rendered. Unique on `(object_id, component_binding_id)`. Promoted from the legacy `SceneObject.properties.bindingOverrides` JSON prototype. | `object_bindings` | `/api/objects/{object_id}/object-bindings` · `/api/object-bindings/{id}` |

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
                 │  PostgreSQL    :55432   (Alembic at 0076)      │
                 │  assets_3d, components, component_bindings,    │
                 │  objects, object_bindings, connections,        │
                 │  collections, optical_links, rf_chain_nodes,   │
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
- **Startup hooks**: `_ensure_master_collection()` bootstraps the master
  Collection so the outliner always has a root node;
  `_hydrate_kind_cache()` populates the in-process `_KIND_TO_OP_SET` map
  from the `kinds` table; `_audit_legacy_anchor_ids()` (new, Phase 9.8)
  walks every Asset3D and logs a warning if any anchor still uses a
  pre-9.8 id (`optical_anchor` / `out` / `+x` / `in` / `seed`) — clean
  installs hit zero; non-zero means the fallback chains in
  `beamAnchor.ts::OPTICAL_ANCHOR_ID`, `opticalBeams.ts::findEmitterAnchor`,
  and `beamPlacement.computeBeamStart` are still load-bearing for that
  install; `_audit_body_frame_consistency()` (new, alembic 0091
  follow-up) warns on `assets_3d` rows where both `body_frame_rotation`
  is non-identity AND `bodyFramePositionMm` is non-zero, because the
  alembic-0091 rotation may have left the stored value at the wrong
  semantics — see [`docs/frame-anchor-architecture.md §3`](docs/frame-anchor-architecture.md).
- **`GET /api/health`** liveness probe.
- **`/ws`** WebSocket (see [WebSocket protocol](#websocket-protocol)).
- 29 API routers under `/api/...` (full table below). Both `component_bindings` and `object_bindings` mount twice (one router each — nested at `/api/{owner}/{owner_id}/...` for tree/list creation + top-level `/api/{kind}/{id}` for per-row operations); each counted as one router.

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
| `assets_3d` | 3D files & their anchors | `file_path` (post-0063 lives under `files/<ext>/…` or `agent_uploads/<session_id>/…` — anything else is rejected by `resolve_asset_path`), `unit`, `scale_factor`, `anchors` (JSONB, with `connectorType` after migration 0050; for waveplates `fastAxisDegBodyLocal` is asset-level since 0060). Post-0057 also carries `status` (`active`/`draft`), `created_by_session_id`, `ai_approved_at`. Post-0064 owns a JSONB `properties` column whose first consumer is `viewerHints` — see [viewerHints](#assets-pipeline). |
| `components` | Catalog | `component_type`, `brand`, `model`, `asset_3d_id` (legacy single-asset pointer, kept around until all read paths move to `component_bindings`), `properties`, `physics_capabilities`, `archived_at`. Same three lifecycle columns (`status`, `created_by_session_id`, `ai_approved_at`) appended in 0057 |
| `component_bindings` | Composition tree (post-0062) | `component_id` (FK → `components.id`), `parent_binding_id` (self-FK, NULL = root), `target_kind` (`asset`\|`subcomponent`\|`empty` — `empty` added in 0066 for transform-only intermediate nodes such as the isolator's "PBS Mount"), `asset_3d_id` XOR `sub_component_id` XOR both NULL, `role` (e.g. `body`, `end_cap_a`, `pbs_front`), `local_{x,y,z}_mm` + `local_{rx,ry,rz}_deg` (parent-binding-local pose), `tunable_axes` (JSONB declaring per-instance Euler DoFs with `frame`/`min`/`max`/`default`), `sort_order`, `properties` (since 0067 also carries `role_label` for migration-keyed updates and `linkGroup` so sibling bindings share a slider). Single combined CHECK constraint `ck_component_bindings_target_shape` (post-0066) admits all three target shapes + no self-subref; cycle detection in the router walks the candidate sub-component's transitive closure |
| `objects` | Scene instances | `x/y/z_mm`, `rx/ry/rz_deg`, `visible`, `locked`, `serial_number`, `properties` (fiber/rf-cable spline, anchor bindings, emission visuals — the legacy `bindingOverrides` dict was migrated out to `object_bindings` by alembic 0076) |
| `object_bindings` | Per-instance ComponentBinding overrides (post-0076) | `object_id` (FK → `objects.id`, CASCADE), `component_binding_id` (FK → `component_bindings.id`, CASCADE), nullable `local_{x,y,z}_mm_delta` + `local_{rx,ry,rz}_deg_delta` (NULL distinguishes "no override on this axis" from "explicit 0"), optional `asset_3d_id_override` (FK → `assets_3d.id`, RESTRICT — lets one instance render against a damaged-housing variant of the binding's declared asset). Unique on `(object_id, component_binding_id)` — overrides compose, they don't stack. Two indexes on `object_id` and `component_binding_id` for "all overrides for binding X" queries |
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
| `kinds` | **New (0086)** — Kind metadata registry | `name` (slug), `display_name`, `domain` (`optical`/`rf`/`mechanical`), `op_set_name` (string FK into the code-only PhysicsOp registry — multiple Kind rows can share one op set, e.g. `my_custom_lens` → `lens_biconvex`), `default_params` JSONB, `face_template` JSONB, `needs_aperture`, `wavelength_range_nm` REAL[], `description`. Backfilled from `backend/data/kinds.json` at upgrade time. Read at FastAPI startup into the in-process `_KIND_TO_OP_SET` cache in `app.optical.db_kinds` so the tracer's `get_op` can dispatch on user-created kind slugs without a DB roundtrip on every ray |
| `agent_sessions` | One AI binding conversation (post-0057) | `instruction`, `status`, `last_heartbeat_at`, `heartbeat_timeout_sec`, `committed_at`/`cancelled_at`/`cancellation_reason`, `messages_json` (Anthropic SDK history persisted across turns, added in 0058) |
| `session_mutations` | Append-only log of agent writes (post-0057) | `op`, `entity_type` (`asset_3d`/`component`), `entity_id`, `before`/`after` JSONB, `undone_at` |
| `approval_events` | Audit log of approve/unlock/modify_blocked/rolled_back (post-0057) | `event_type`, `entity_type`/`entity_id`, `session_id`, `metadata` (column kept as `metadata`; ORM attr is `event_metadata` because `DeclarativeBase.metadata` is reserved) |

### Routers (`backend/app/routers/`, mounted in `main.py`)

| Mount | File | Purpose |
|---|---|---|
| `/api/assets` | `assets.py` | Asset upload & CRUD; serves anchors editor. Uploads land under `assets/files/<ext>/<uuid>_<name>.<ext>` (viewer-ready: glb/gltf/obj/stl) or `assets/files/cad_sources/…` (step/stp/sldprt/dxf) after alembic 0063 unified the legacy `uploads/` bucket |
| `/api/kinds` | `kinds.py` | **New (0086)**: CRUD for the Kind registry table. `GET /` lists rows (filter `?domain=optical|rf|mechanical`); `POST /` creates a new kind metadata row (must reference an `op_set_name` that exists in the code-only PhysicsOp registry — to add genuinely new physics behavior you still need to write and register a PhysicsOp in `app/optical/kinds/<kind>/physics.py`); `PATCH /{kind_id}` edits display name / default params / face template / wavelength range / needs_aperture / description (renaming `name` and `op_set_name` is blocked — the tracer-side cache invalidation would be racy); `DELETE /{kind_id}` is 409-blocked if any `assets_3d.kind_id` row still references the slug. Every mutation refreshes `_KIND_TO_OP_SET` via `set_kind_cache_entry` / `remove_kind_cache_entry` so the in-process tracer dispatch sees the change on the next ray |
| `/api/components` | `components.py` | Catalog CRUD; archive/restore; upload-from-file. Owns `auto_create_physics_element_for_object`, which on a fresh `fiber` spawn also creates paired `fiber_end_a` + `fiber_end_b` SceneObjects (3-object cluster, mirroring migration 0052 for new placements) and joins them to the body's collection |
| `/api/components/{id}/bindings` · `/api/component-bindings/{id}` | `component_bindings.py` | **New (0062)**: ComponentBinding tree CRUD. Nested `GET` returns full binding list in `sort_order` ascending; structure is implied by `parent_binding_id` (multiple roots legal). Top-level routes operate on a single binding by id; the update path **cannot** change the binding's target — to retarget, delete + recreate (keeps cycle protection simple). Cycle protection: creating a `subcomponent`-kind binding walks the candidate sub-component's transitive sub-component closure and rejects with 400 if the container appears in it |
| `/api/objects` | `objects.py` | Instance CRUD; **bulk batch update** so multi-select doesn't trigger N broadcasts. On fresh `fiber` creation also broadcasts the auto-spawned `fiber_end_a`/`fiber_end_b` SceneObjects + PhysicsElements so the 3-object cluster lands without a page reload |
| `/api/objects/{object_id}/object-bindings` · `/api/object-bindings/{id}` | `object_bindings.py` | **New (0076)**: per-SceneObject ComponentBinding overrides. Nested `GET` lists every override row for the object in `created_at` order; nested `POST` is **UPSERT-by-(object_id, component_binding_id)** — slider drags re-POST on every change and the unique constraint keeps the row id stable. Top-level routes `GET`/`PUT`/`DELETE` a single row by id; `PUT` cannot change `component_binding_id` (immutability rule matches `ComponentBindingUpdate`). Every mutation broadcasts `object_binding.created` / `.updated` / `.deleted` on the WS so other clients sync live |
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
| `/api/v3/assets3d` · `/api/v3/components` | `v3_catalog.py` | **Catalog (0082, 0087-0090)**: full CRUD over the Asset-Physics-Model v3 columns. As of 0089/0090 the classification field is `kind_id` (replaces `physics_kind`); as of 0087 anchors are stored on a JSONB `anchors[]` column and read by the new anchor-based tracer (legacy `faces[]` / `transitions[]` remain populated for solver-DB seeding but the anchor list is canonical for the tracer). `GET /v3/assets3d?has_v3=true&kind_id=lens` lists v3-seeded rows; `POST /v3/assets3d` creates a new catalog row (slug-shape enforced by `ck_assets_catalog_id_slug_shape`, alembic 0088); `POST /v3/assets3d/upload-stl` uploads a viewer-ready STL and creates the catalog row + slug in one shot; `GET/PUT/DELETE /v3/assets3d/{catalog_id}` operate on a single row by stable slug. `/v3/components` mirrors the same shape: list / get / put on `catalog_id`. Slug constraint: lower-snake-case (`^[a-z0-9_]+$`), unique-non-null per table. The JSON catalog under `assets/catalog/` is the source of truth for fresh installs; `backend/scripts/seed_v3_assets.py` is idempotent |
| `/api/v3/solver/run` · `/api/v3/solver/run-from-db` | `v3_solver.py` | **Phase 3+**: two entry points. `POST /run` is **deprecated** (Phase 9.8 marker) and kept only for `backend/tests/optical/test_solver_v3*.py` + face-vs-anchor parity checks — it runs the **legacy face-based** tracer (`ray_tracer_v3.py`) over a caller-supplied scene. **Frontend never calls it**; `api/client.ts` only references `/run-from-db`. `POST /run-from-db` (Phase 9.7) takes only `{options?}` and rebuilds the V3Scene from live `assets_3d` + `components` + `component_bindings` + `objects` rows via `app.optical.db_scene_loader.load_anchor_scene_from_db` — the Lab viewer + UI panels call this so they don't have to serialize the scene first. Both return `SolverResult` `{segments[], finalRays[], errors[], warnings[]}`. Anchor-tracer path: as of Phase 9.2 (alembic 0087) the tracer dispatches on Asset3D's `anchors[]` column instead of `faces[]` + `transitions[]`; see `app.optical.anchor_tracer.trace_anchor_scene`. Eager-imports `app.optical.kinds` and `app.optical.anchor_ops` on first call so every op is registered before dispatch. `db_scene_loader._apply_body_frame_to_anchor` lifts every anchor's position + tri-axis from body→CAD frame using `bodyFramePositionMm` + `body_frame_rotation` so the tracer can compose against the SceneObject's lab pose without each op repeating the lift; `_derive_aom_interaction_center` synthesises the AOM Bragg interaction anchor at the midpoint of `intercept_in` + `intercept_out` so the tracer's primary-anchor hit test has a target without storing a redundant row |
| `/api/agent-sessions` | `agent_sessions.py` | **New (0057+0058)**: AI binding session lifecycle — `POST /` start · `GET /{id}` review (session + mutations) · `POST /{id}/heartbeat` · `POST /{id}/uploads` (multipart, asset 50 MB / image 10 MB cap, stored under `assets/agent_uploads/<session>/`) · `POST /{id}/messages` (SSE-streamed agent turn — yields `assistant_chunk` / `tool_call` / `tool_result` / `done` / `error`) · `POST /{id}/undo-last` · `POST /{id}/commit` (drafts → active, `ai_approved_at` set) · `POST /{id}/cancel` (reverse-replay mutation log) · `POST /{id}/unlock` (**new, Phase 2**: reverses a previous commit's lock by clearing `ai_approved_at` on every entity this session created — idempotent, only valid on `status='committed'` sessions; writes one `unlock` ApprovalEvent per entity. The session row itself stays `committed`; to re-edit the rows the user opens a new agent session and the now-unlocked rows become touchable again). 409 on any write to a terminal session |
| `/api/timing-programs` | `timing_programs.py` | TimingProgram CRUD + `/compile` to SpinCore opcodes |
| `/api/app-settings` | `app_settings.py` | Singleton settings (room dimensions, …) |
| `/api` | `scene.py` | `GET /api/scene` — single denormalized snapshot for frontend hydration |

### Solvers (`backend/app/solvers/`)

| File | What it computes |
|---|---|
| `generalized_abcd.py` | **New (Phase 2, 2026-05).** 5×5 augmented-matrix ABCD propagation for misaligned optical systems. State vector `(x, θ_x, y, θ_y, 1)` in `(mm, rad)`; q-parameter (Gaussian beam) propagates via per-axis 2×2 sub-blocks while chief-ray (centre + tilt) goes through the FULL 5×5 multiply so rotated cylindrical optics couple x↔y correctly. Operator constructors: `m_free_space`, `m_thin_lens` (with decenter Δ and tilt α — `M[1,4] = Δ/f + α·(1-1/f)`), `m_cylindrical_standard` / `m_cylindrical_rotated` (focusing in one axis + glass-plate Snell shift in the other), `m_rotation`, `m_flat_mirror` (tilt α doubles into chief ray, no decenter term), `m_curved_mirror` (`f = R/2`), `m_glass_plate` (`B = d/n` + plate-shift `(1-1/n)·d·α`), `m_glan_slab` (ASTIGMATIC — `B_x ≠ B_y` from the wedged air-gap cut + augmented `E_x` lateral offset; `wedge_angle_deg` documented for downstream Jones builders, not in the matrix), `m_faraday_slab` (SYMMETRIC `B_x = B_y = L/n` + θ_F-rotated tilt coupling block + `E_x`/`E_y` augmented offsets — the geometric counterpart of the non-reciprocal Jones rotation), `m_pbs_reflected` / `m_pbs_transmitted`. `BeamMisaligned` dataclass carries `q_x`, `q_y`, chief-ray (x_c, y_c, θ_xc, θ_yc), wavelength. `apply_operator` does both updates in parallel. `q_from_waist`, `waist_um_from_q`, `spot_radius_um`, `radius_of_curvature_mm` helpers. Cross-axis coupling on the q-parameter (off-diagonal A_x, B_x, …) is NOT modelled — per-axis scalar-q split is exact for x/y-decoupled operators and approximate for rotated cyl unless the input beam is rotationally symmetric |
| `optical_solver.py` | Core CW Gaussian-beam propagator (q-parameter, Jones polarization, spectrum lineshapes). Astigmatic X/Y. Post Phase 2 hosts new dispatchers for the isolator's 3-stage architecture: `jones_glan_laser_matrix` (extinction degrades quadratically with chief-ray tilt: `ε(θ) = ε₀ + α·θ²`), `jones_faraday_matrix` (non-reciprocal — same rotation forward and backward in lab frame), `apply_glan_laser` (TWO output ports: `out` = transmitted E-ray, `out_r` = TIR-rejected O-ray exiting the side at ~67-68° — same dispatch shape as a polarising PBS; both carry the opposite polarisation's extinction leak), `apply_faraday_rotator` (Jones rotation + 5×5 `m_faraday_slab` geometric propagation; not a port dispatcher — returns a single Beam), `apply_isolator` (the user-facing chain: `front Glan → Faraday → back Glan` with **three** output ports — `out` = main forward transmission, `out_r_front` = front Glan's rejected O-ray, `out_r_back` = back Glan's rejected O-ray; back-compat falls through to the legacy `forwardLossDb` single-knob multiplier when `frontGlan`/`backGlan`/`faraday` nested dicts are absent). `_dispatch_element` routes the `glan_polarizer` kind to `apply_glan_laser` |
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

Currently at **revision 0090**. Recent milestones:

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
| 0064 | asset_properties | Adds `Asset3D.properties` JSONB column (`NOT NULL DEFAULT '{}'`). First consumer is `viewerHints` — `deletedCentroids` (STL triangle prune key list), `includeOnlyCentroids` (inverse — keep only the listed tris, used by sub-piece partition assets), `recenterOrigin` (post-filter translation so a sub-piece's effective origin lands at its mount), `axisRadiusFilterMm` (bulk hide ≤ N mm of bbox-longest axis), `material.{type,opacity}` (translucent_housing render hint), `bundledOverlay` (suppress legacy bespoke overlay paths). The generic asset loader honours these hints regardless of the consuming Component's `componentType`, so isolators stop needing a bespoke `pbsOverlay` path for triangle pruning and translucent housing |
| 0065 | tornos_binding_tree | First real ComponentBinding migration — seeds TORNOS-850-4 with two PBS sub-Component bindings (`front_pbs` at z = −13, `back_pbs` at z = +13, `tunable_axes.ry_deg` opening the per-instance rotation knob). Visually identical to today's bespoke `pbsOverlay` path; sits behind the per-Component opt-in gate Stage A''.8 added in commit `ba283f7` |
| 0066 | binding_empty_target | Drops `ck_component_bindings_one_target` + `ck_component_bindings_target_kind_matches`, replaces with a single combined `ck_component_bindings_target_shape` that admits `target_kind='empty'` (both FKs NULL, transform-only). Renderer walker treats empty nodes as intermediates and recurses into children — backbone of the 5-part isolator decomposition (front PBS / front Mount / Faraday body / back Mount / back PBS) where the Mount layer carries a rotation DoF without any geometry of its own |
| 0067 | tornos_body_asset | Three-step TORNOS-850-4 restructure: clone the body into a procedural builder Asset3D (`procedural://isolator_body`, shared across models that need it), repoint the Component + root binding at the new asset, then insert two `target_kind='empty'` Mount bindings between root and the existing front_pbs / back_pbs bindings. `tunable_axes.ry_deg` migrates from PBS → Mount, matching the design "Mount rotates relative to body, PBS is rigid to Mount". Resulting tree: root body → front_mount (empty) → front_pbs (PBS subcomp); same on the back |
| 0068 | io_vlp_binding_tree | Migrates IO-3D-850-VLP + IO-5-850-VLP to the same 5-part shape as TORNOS — body STL stays real (not procedural), front + back Mounts are empty, PBS sub-Components hang off the Mounts. Stamps `Asset3D.properties.viewerHints.bundledOverlay = false` on each housing STL so the legacy `buildThorlabsIsolatorObject` path skips its bundled PBS overlay (the binding tree's PBS sub-Components render PBS instead — avoids a double-render). PBS poses are copied verbatim from `pbsOverlay.ts::ISOLATOR_PBS_DEFAULTS_BY_MODEL` |
| 0069 | fix_viewer_hints_bundled | Fixes a 0068 silent no-op: `jsonb_set(properties, '{viewerHints,bundledOverlay}', …)` with `create_missing=true` doesn't auto-create the intermediate `viewerHints` key, so the update returned the original `{}`. Replaces with a nested `jsonb_set` that materialises `viewerHints` first. Applies to every Asset3D referenced by an isolator Component with a 5-part binding tree (empty Mount bindings present) — so it picks up future A''.10/A''.11 assets too without re-keying |
| 0070 | migrate_isolator_deletions | Stage A''.10 — moves STL triangle deletion data from `Component.properties.isolatorDeletedCentroids` → `Asset3D.properties.viewerHints.deletedCentroids` so the generic loader's `applyViewerHintsToGeometry` (A''.2) handles it instead of the bespoke `applyIsolatorDeletionFilter` inside `pbsOverlay`. Conceptually the deletion list is a property of the STL geometry, not of any particular consuming Component — moving asset-level lets every Component that points at the same STL inherit the deletion. Idempotent (skips rows whose target already has the key) |
| 0071 | hp_glan_laser_bindings | Stage A''.11 — high-power isolator migration. IO-3-850-HP + IO-5-850-HP both get the 5-part binding tree, but their polariser sub-Component is **Glan-Laser calcite prism** (`glan_polarizer` kind, prep'd in commit `7fd153a`) instead of the cube PBS252 used by VLP / TORNOS. Creates the catalog entries if missing — `Asset3D` `glan_polarizer_calcite_prism` pointing at `procedural://glan_polarizer_prism`, plus `Component` `GlanLaserCalcitePrism` referencing it — and inserts the per-model binding trees |
| 0072 | io_3_hp_glan_pose | Locks the IO-3-850-HP Glan-Laser Mount pose the user authored via the IsolatorDevPage 3-axis Euler editor (front: `pos=(0, 11, 0) rotDeg=(0, 270, 0)`, back: `pos=(0, 84, 0) rotDeg=(0, 225, 0)`). Keyed on `properties->>'role_label'` so future binding-tree shape changes don't invalidate the migration |
| 0073 | io_5_hp_glan_pose | Same pose values mirrored onto IO-5-850-HP (same chassis family as IO-3-850-HP — user explicitly asked for parity) |
| 0074 | io_3_hp_bake_partitions | Bakes the IO-3-850-HP front (~1937 tris) and back (~2174 tris) STL partitions the user marked via IsolatorDevPage's Ctrl/Alt + drag box-select into two new sub-`Asset3D` rows. Each sub-Asset references the SAME housing STL file but with `viewerHints.includeOnlyCentroids` to extract just its partition + `viewerHints.recenterOrigin` to shift the kept geometry by −(Mount's body-local pose) so its effective origin lands at the Mount (otherwise the sub-asset's STL coords would double-offset under the Mount binding's own local translation). Each gets bound under the matching Mount so it moves rigidly with the Glan-Laser |
| 0075 | io_3_hp_flatten_mounts | User-driven flatten of IO-3-850-HP's tree: drops the two empty Mount intermediates and reparents all four (PBS + piece × front + back) children directly under the root body, copying the Mount's local pose + `tunable_axes` onto each. Each of the 5 (root + 4 children) is now independently positionable via the Bindings panel. The Mount layer was useful when PBS + piece needed to rotate together via a shared `tunable_axes`; the user prefers per-child control here |
| 0076 | object_bindings | Promotes the ad-hoc `SceneObject.properties.bindingOverrides` JSON dict to a first-class `object_bindings` table — FK cascade on `component_binding_id`, indexes for "all overrides for binding X" queries, WS event channel for live cross-client sync, and per-axis schema validation that catches typos. Per-axis deltas are `nullable=True` (not `DEFAULT 0`) so the renderer can distinguish "no override declared for this axis" from "explicit 0 override". Sparse storage avoids row-bloat for the common case where only one axis (e.g. `ry_deg`) is being tweaked. `asset_3d_id_override` lets the same row swap which Asset3D the binding renders. Backfill walks every legacy `bindingOverrides` entry → row + strips the legacy key (idempotent via NOT EXISTS); downgrade re-packs rows back into the JSON dict, so a roundtrip preserves state |
| 0077 | io_5_hp_link | Brings IO-5-850-HP up to parity with IO-3-850-HP (0075). Three data-shape changes in one go: (1) flatten empty `role=mount` intermediate bindings — copy their pose + `tunable_axes` down to each child, reparent children to the Mount's parent, delete the Mount row; (2) stamp `properties.linkGroup = 'front'` / `'back'` on every side-tagged binding (`role_label` starts with `front_` / `back_`) so `BindingTreeAdjustControls` renders one slider per side driving prism + piece together; (3) widen `tunable_axes.ry_deg` to `min=0 max=360` matching the IO-3 range. Idempotent. Does NOT create `front_piece` / `back_piece` rows — those land in 0078 after IO-5 borrows IO-3's baked partition data |
| 0078 | io_5_hp_clone_io_3 | User confirmed IO-5-850-HP and IO-3-850-HP are physically the same housing (same internal optics, differ only in max power rating). Migration repoints the IO-5 body Asset3D's `file_path` to `thorlabs_io_3_850_hp.stl`, copies the IO-3 body's `viewerHints` (`deletedCentroids`, `bundledOverlay`), clones the IO-3 piece Asset3D rows + piece bindings (with `includeOnlyCentroids` + `recenterOrigin` copied byte-for-byte plus `linkGroup` + `role_label`), and copies `Component.properties.isolator*` partition data over so the ComponentComposer dev page sees the same baseline. Idempotent + reversible — downgrade restores the IO-5 STL pointer and drops the cloned piece rows |
| 0079 | glan_prism_physical | Pins the catalogue GlanLaserCalcitePrism Component to the compact prism geometry: `sizeMm=8.5`, `lengthMm=7.5`, `wedgeAngleDeg=38.5` (`airGapMm` intentionally left at the plugin default 0.05 mm). The procedural renderer (`glan_polarizer_prism.ts`) reads these off `component.properties` so a fresh PhysicsElement seeded from the catalog inherits the right physical size. The 5×5 ABCD operator (`m_glan_slab`) consumes `lengthMm`, `refractiveIndex`, `wedgeAngleDeg`, `airGapAstigmatismMm` — none of which depend on the transverse cross-section (W/H) |
| 0080 | isolator_nested_chain | Fixes a silent legacy fallback: `apply_isolator` (the new 3-stage Glan→Faraday→Glan formulation, Phase 2) gates the full nested chain on presence of `frontGlan` + `backGlan` + `faraday` dicts in `kind_params`. Rows seeded before that gate landed have only flat keys (`forwardLossDb`, `isolationDb`, …) and silently fall through to the single-knob power multiplier, missing polarisation-axis transmission/rejection physics, Faraday non-reciprocity, and out_r_front / out_r_back rejected-beam visualisation. Migration scans every `physics_elements` row with `element_kind='isolator'` and splices in canonical nested defaults when any of the three keys is missing. Flat keys are preserved — they coexist; the gate only checks the nested dict presence |
| 0081 | glan_prism_w_h_6_5 | Phase 21 refinement: refines `Component.properties.sizeMm` on GlanLaserCalcitePrism from 8.5 → 6.5 mm so the procedural prism renders as a compact 6.5 × 6.5 × 7.5 mm crystal. Length / wedge / `n_e` from 0079 unchanged. ABCD unaffected — `m_glan_slab` ignores transverse W/H |
| 0082 | v3_asset_physics_columns | **Asset-Physics-Model v3 schema landing.** Adds (a) on `assets_3d`: `catalog_id` TEXT (stable slug used by `assets/catalog/**/*.json`), `physics_kind` TEXT, `faces` JSONB (port geometry — id, body-local position, optional normal, aperture size + shape, optional domain `optical`/`rf`/`ttl`), `transitions` JSONB (face_in → face_out + op + params + optional 2×2 ABCD / 5×5 matrix + optional `via[]` chain for multi-hop reflective elements), `default_params` JSONB, `wavelength_range_nm` REAL[], `body_frame_rotation` JSONB quaternion (CAD axis correction so body +Z = optical axis). (b) on `components`: `catalog_id` TEXT, `exposed_faces` JSONB. (c) on `objects`: `param_overrides` + `dynamic_sources` JSONB. All columns nullable — v2 anchor/kindParams data coexists indefinitely. (Note: `physics_kind` was dropped in 0090 once `kind_id` superseded it.) Downgrade drops every new column |
| 0083 | aom_v3_rf_in_face | Phase RF.2 increment. Backfills a third `rf_in` face onto every AOM Asset3D (`physics_kind='aom'` or legacy `component_type='aom'` orphans). Position derived from `defaultParams.transducerOffsetFromCenterMmX` (fallback 15 mm) along `defaultParams.rfPropagationDirectionBodyLocal` (fallback (1, 0, 0)); domain=`rf`. The legacy side-channel `rfPropagationDirectionBodyLocal` stays for back-compat but `rf_in.normalBodyLocal` is the source of truth. NOT added to `transitions[]` — the AOM PhysicsOp reads it as an RF sink, not a ray-tracer entry/exit face. Idempotent (skips if `rf_in` already present); downgrade strips the face (destructive of user-edited rf_in placements) |
| 0084 | rf_v3_backfill | Phase RF.2 cleanup. Backfills `physics_kind` / `faces` / `transitions` / `default_params` on the 8 RF Asset3D rows not previously seeded for v3 (rf_source / programmable_pulse_generator / rf_amplifier / rf_cable × 3 / rf_switch). Pinned by asset name; shared `primitive_box` is intentionally not touched. Idempotent (skips rows with non-null `physics_kind`). Downgrade clears the v3 fields on those 8 rows — dev-only |
| 0085 | io_3_hp_flatten_to_5_assets | IO-3-850-HP: retire the 7-binding workaround tree (0071+0074) and the `thorlabs_io_3_850_faraday_rod` full-assembly Asset3D in favour of a flat 5-binding shape: `hp_root` (faraday_rotator kind) + `glan_front` + `glan_back` (pbs kind) + `front_piece` + `back_piece` (mechanical). All siblings under the Component, no Mount intermediates. Migration only **cleans** legacy state; new bindings + new Asset3Ds are populated by re-running `backend/scripts/seed_v3_assets.py` against the updated JSON catalog. The 3 new STL slice files are produced by `backend/scripts/split_io_3_hp_stl.py`. Downgrade is a no-op |
| 0086 | kinds_table | **New `kinds` table** — per-kind metadata (display name, default params, face template, needs_aperture, wavelength range, domain) moves out of the code-only registry into a DB row. PhysicsOps stay in code; each Kind row references one via `op_set_name` (lookup target in the `_REGISTRY` dict — e.g. a user-created `my_custom_lens` slug can reuse the built-in `lens_biconvex` op set). Backfill walks `backend/data/kinds.json` (generated from the frontend plugin registry) and inserts one row per physics_plugin. The tracer consults `app.optical.db_kinds._KIND_TO_OP_SET` (hydrated at FastAPI startup, refreshed by the Kind CRUD endpoints) as a fallback in `get_op` |
| 0087 | assets_anchors_column | Phase 9.1. Makes `assets_3d.anchors` JSONB the canonical anchor-centric store (it was already present from v1/v2). Each anchor = `{id, positionMmBodyLocal, axisXBodyLocal, axisYBodyLocal, axisZBodyLocal, apertureMm, apertureShape}`. Data transformation happens in `backend/scripts/backfill_asset_anchors.py` (idempotent, separate from this migration). `faces` + `transitions` columns remain in parallel for the legacy face-based tracer; Phase 9.8 drops them after the anchor tracer is the only reader |
| 0088 | catalog_id_constraints | Phase 9.11. Adds CHECK (`^[a-z0-9_]+$` lower-snake-case slug when non-null) + UNIQUE (NULLS DISTINCT — multiple instance leaves with NULL slug are still allowed) constraints to `assets_3d.catalog_id` + `components.catalog_id`. Pre-audited free of bad shapes / duplicates so the constraints land without data churn. Catches accidental garbage (spaces, capitals, slashes) before it lands in the catalog |
| 0089 | kind_id_column | Phase 9.13. Adds a unified `kind_id` TEXT column to BOTH `components` and `assets_3d`, indexed for filter queries. Backfills `kind_id = component_type` on Components and `kind_id = physics_kind` on Asset3D (verbatim copy — no alias canonicalization). Legacy columns kept; the actual drop is 0090 |
| 0090 | drop_legacy_kind_columns | Phase 9.14. Drops `components.component_type` and `assets_3d.physics_kind` now that `kind_id` is the canonical classification field everywhere (ORM models, FastAPI schemas, every router, every frontend type). Downgrade re-adds the columns nullable and re-backfills from `kind_id` so a rollback can round-trip |
| 0091 | body_frame_position_to_body_frame | Phase 9.11 (data-only). Walks every `assets_3d` row with a non-null `body_frame_rotation` + non-zero `bodyFramePositionMm` and rotates the stored offset by `R_body⁻¹`. **⚠ Read the docstring before changing this** — the rest of the codebase (`utils/assetFrame.ts`, `three/opticalBeams.ts`, `backend/app/optical/db_scene_loader.py::_apply_body_frame_to_anchor`, `frontend/src/utils/anchorAccess.ts`) treats `bodyFramePositionMm` as a CAD-axis vector applied AFTER the body→CAD rotation (Phase 9.10 semantics), so on rows with non-identity `R_body` this migration leaves the stored value rotated by `R_body⁻¹` relative to how readers interpret it. Migration is kept in place for alembic linearity; the canonical write-up is [`docs/frame-anchor-architecture.md §3`](docs/frame-anchor-architecture.md) and the audit/cleanup plan is §15.2 of the same doc. `main.py` runs a startup audit (`_audit_body_frame_consistency`) that warns on suspect rows |

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
The PHY Editor header carries a "🔧 Binding dev" toggle (top-right) that
mounts the `ComponentComposer` live binding-tree tweak page in the right
pane, mutually exclusive with the Kinds / Components rail items. The
default landing is empty — the user picks a rail item or opens Binding
dev explicitly (the old IsolatorDevPage auto-landing was retired in
Phase 2).

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
| `ai-binding` | AI Binding | −340, 80 | 380 × 520 | no (open it from the Window menu after enabling `VITE_ENABLE_AI_PANEL=true`) | 3 |

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
| PHY editor (full screen) | `PhyEditor.tsx`, `BindingDevPanel.tsx`, `KindsEditor.tsx`, `Asset3DV3Editor.tsx`, `ComponentsV2Editor.tsx`, `ComponentComposer.tsx` | Catalog metadata + anchor editor. The legacy `ComponentEditor.tsx` + `component_editor/AnchorFaceSections.tsx` + `componentAnchorContracts.ts` were retired with the v2 dispatch flip; the read-only legacy landing is gone. `BindingDevPanel.tsx` (mounted by the 🔧 Binding dev toggle in PHY Editor) is the unified CRUD shell — left rail groups items by PHY domain (Optical / RF / Electrical placeholder / Mechanical), right pane mounts exactly one editor at a time (`KindsEditor` / `Asset3DV3Editor` / `ComponentsV2Editor`) so the 3D context (THREE.WebGLRenderer) only lives for the active rail item — avoids two renderers fighting for the same canvas. `KindsEditor` does CRUD against `/api/kinds`. `Asset3DV3Editor` edits faces / transitions / anchors / wavelength range / body_frame_rotation against `/api/v3/assets3d`. `ComponentsV2Editor` composes Asset3Ds into a Component via flat asset bindings (`parentBindingId=null`, `targetKind="asset"`); subcomponent and empty-target bindings are out of MVP scope — see source-level note. `ComponentComposer.tsx` is the live binding-tree tweak page that replaced `kinds/isolator/IsolatorDevPage.tsx` in Phase 2 (per-row pose/rot Apply buttons, live 3D preview from in-progress edits before commit) |
| Timing | `PulseTimingPanel.tsx` | Edit TimingProgram intervals |
| RF | `RfLinkPanel.tsx`, `ScrubTimeRfReadout.tsx` | Per-port Vpp / dBm / freq readout; chain inspector |
| Optical | `optical/OpticalLinkViewerPanel.tsx`, `optical/BeamScopePanel.tsx`, `optical/CursorMenu.tsx`, `optical/TargetLinksSection.tsx`, `optical/CapabilityPills.tsx` | Beam inspection, ray-scope viewer, cursor menu. **Phase 2 fix**: the panel's wireframe cache now tags every cached `THREE.Group` with a `digest` derived from the per-object `objectBindings` deltas (`componentBindingId|XYZRxRyRz delta|asset3dIdOverride`). When a user drags an isolator's per-side rotation slider, the digest changes, the cache lookup misses, and the wireframe rebuilds with the new pose — without the digest, the panel froze the wireframe at first render and ignored subsequent slider updates. The same digest is also folded into the panel-level `contentKey` so the parent rebuild gate fires too |
| Assembly | `TouchCoincidencePanel.tsx`, `AlignPanel.tsx`, `VisibilityControls.tsx` | Constraint solver UI + visibility kit |
| Per-kind physics | `physics/PhysicsElementPanel.tsx`, `LaserSourceControls.tsx`, `AomAdjustControls.tsx`, `TaperedAmplifierAdjustControls.tsx`, `SimpleAdjustControls.tsx`, `_shared.tsx` | Kind-specific inspectors, extracted from a previously 4000-line monolith |
| Binding-tree per-instance editor | `BindingTreeAdjustControls.tsx` (new, post-0076) | Generic slider panel for ANY composite component's binding tree. Reads `component.componentBindings`, groups them by `binding.properties.linkGroup`, then renders a numeric + range input per `commonTunableAxes(group)`. Writes go through `sceneStore.upsertObjectBinding` (one row per binding in the link group, so a single slider drag drives `front_glan_laser` + `front_piece` together). Dragging back to 0 with no other axis set deletes the row so the renderer reverts to the catalog baseline. New components opt in just by declaring `tunable_axes` on their bindings — no component-specific code. Mounted from `PhysicsElementPanel` for optical-domain elements. **Phase 2 addition**: a per-instance "See through" checkbox writes `sceneObject.properties.translucentHousing = true` so the renderer drops the isolator housing to 0.35 opacity for the selected instance (default is opaque metal); the legacy `opaqueHousing` key is cleaned up when the toggle is touched. Gated on `componentType === "isolator"` for now — generic enough to fan out by adding new keys to the same block |
| Power & state | `InstrumentPowerPanel.tsx` | Enabled / temperature / pressure readouts |
| DDS specifics | `DdsChassisObjectControls.tsx`, `Ad9959ObjectControls.tsx` | AD9959 chassis & per-chip UIs |
| Toolbar | `SceneToolbar.tsx`, `ToolbarHint.tsx`, `NumberField.tsx`, `CollapsibleSection.tsx` | Initial Setup button, shortcut help, shared inputs |
| AI binding (alpha) | `AIBindingPanel.tsx` | Drives the agent_orchestrator from the browser. Gated behind `VITE_ENABLE_AI_PANEL=true`. Three local states (`idle` / `running` / `terminal`) map to `agent_sessions.status`. 30 s heartbeat keeps the backend sweeper from auto-abandoning the session. Chat transcript is purely display state; the persisted source of truth for "what got created" is the `mutations` list from `GET /{id}`. **Phase 2 addition**: terminal panel now exposes an Unlock button (committed sessions only) wired to `unlockAgentSessionApi` → `POST /api/agent-sessions/{id}/unlock`; success renders a summary row with the count of unlocked assets / components; busy + idempotency-locked while in flight. Default layout flipped back to `visible: false` (the env flag is off by default; even if someone flips only the env var on, the panel stays closed until they open it from the Window menu — kept symmetric with the `App.tsx` and `TopBar.tsx` gates) |

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
  glan_polarizer/index.ts     (new, A''.3 — Glan-Laser calcite prism;
                               sub-Component for HP-series isolators)
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
  are escape hatches. `buildThorlabsIsolatorObject` accepts an
  `opaqueHousing: boolean` flag (default false) so IsolatorDevPage can
  inspect the housing exterior without inner geometry bleeding through.
- `components/ComponentComposer.tsx` (**new, Phase 2** — replaces the
  retired `kinds/isolator/IsolatorDevPage.tsx`) — full-screen live
  binding-tree tweak page reached via the PHY Editor top-right "🔧
  Binding dev" button (no longer the default landing). Layout: header
  row (Model dropdown + inner-r partition toggles + save / reset),
  link-rotation row (visible only when ≥1 linked triangle marked),
  Binding tree poses table (one row per binding — `root(body)` /
  `front_mount` / `front_pbs` / `front_piece` / `back_mount` /
  `back_pbs` / `back_piece`, each with pos[x,y,z] + rot[rx,ry,rz] +
  Apply button that PATCHes `/api/component-bindings/{id}` directly),
  and a full-width 3D preview canvas driven LIVE from the in-progress
  `bindingEdits` buffer (so an edit shows before Apply commits).
  Source of truth is the ComponentBinding rows in the DB; the page's
  `bindingEdits` is the local-edit buffer; the preview's poseOverride
  is derived from it. Today wired to the isolator preset (model
  dropdown is isolator-only, 3D path goes through
  `buildThorlabsIsolatorObject`); planned generalisations: root picker,
  new mode, atomic save. Marked partitions still export to an alembic
  migration (0074 / 0078 baked on top of this workflow) with
  `viewerHints.includeOnlyCentroids` + `recenterOrigin`. The mutually-
  exclusive "🔧 Binding dev" toggle in `PhyEditor.tsx` opens this and
  hides the Kinds/Components rail sub-editors
- `v3TraceAdapter.ts` (**new, Phase 7.2**) — converts a
  `V3SolverResult.labSegments[]` snapshot into the legacy
  `TraceSegment` shape that downstream consumers still read off
  `window.__rayTraceDebug` (OpticalLinkViewerPanel reads
  `seg.emitterObjectId` to filter chains, BeamScope reads
  `polarizationAtStart` + `beamMode`, snap-to-beam uses
  `startThree`/`endThree`). Waist is recomputed from the segment's
  q-parameter (`q(z) = (z − z_waist) + i·zR` → `w₀ = √(zR · λ / π)`
  → `w(z) = w₀ · √(1 + (Δz/zR)²)` under M² = 1). Fields the v3
  tracer doesn't yet track (`taSeedCoupling`, `aomSideband`,
  `fiberCoupling`) stay undefined; `branch` defaults to "main";
  `depth = 0`. Once the v3 solver emits an explicit BeamMode the
  heuristic recompute disappears.
- `rayTrace.ts` — legacy forward ray tracer running in the browser using loaded meshes.
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
| `assetFrame.ts` (new, frame-anchor) | Low-level body-frame math: `bodyFramePositionMm(asset)`, `bodyFrameQuaternion(asset)`, `bodyFramePointToObjectLocalMm(p, asset)`, `bodyFrameDirectionToObjectLocal(d, asset)`, `bodyFrameMeshShiftMm(asset)`. Lifts body-frame vectors into object-local/CAD frame using the asset's `properties.bodyFramePositionMm` + `bodyFrameRotation`. Used by everything that needs to compose an anchor with a SceneObject pose |
| `anchorAccess.ts` (new, frame-anchor) | **Canonical anchor reader.** Public helpers `anchorObjectLocalPos`, `anchorObjectLocalAxisX/Y/Z`, `anchorObjectLocalLegacyDir` return values already in the object-local CAD frame (ready to compose with SceneObject pose). Downstream code MUST NOT touch raw `*BodyLocal` fields directly — `frontend/scripts/check-anchor-access.mjs` is a pre-build grep guard wired into `npm run build` via `npm run check:anchors` that fails the build if any non-allowlisted file accesses `positionMmBodyLocal` / `axisXBodyLocal` / `axisYBodyLocal` / `axisZBodyLocal` / `directionBodyLocal`. Per-line opt-out: append `/* raw-anchor-ok: <reason> */`. Allowlisted readers: the helper module itself, `assetFrame.ts`, `types/digitalTwin.ts`, fiber/rfCable resolvers (which intentionally return body-local), `v2Bindings.ts`, sceneStore, the Asset3DV3 / ComponentsV2 / ComponentComposer editors (write side), parity test fixtures, `ray-tracer-v3.ts`, per-kind `optical/kinds/**/physics.ts`, and tests |
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
- **Object bindings (new, post-0076)**: `listObjectBindingsApi`,
  `upsertObjectBindingApi` (POST to the nested route — backend treats
  it as UPSERT thanks to the unique constraint on
  `(object_id, component_binding_id)`, so slider drags can re-POST on
  every change without 409s), `updateObjectBindingApi`,
  `deleteObjectBindingApi`. Payload types `ObjectBindingUpsertPayload`
  / `ObjectBindingUpdatePayload` carry `componentBindingId` + the six
  optional per-axis `local*Delta` fields + `asset3dIdOverride` +
  `properties`. `null` on a delta field means "clear this axis's
  override"; numeric means "set the delta to this value"
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
  `undoLastMutationApi`, `uploadAgentFileApi`,
  `unlockAgentSessionApi` (**new, Phase 2** — POST
  `/api/agent-sessions/{id}/unlock`; returns `UnlockResult`
  `{sessionId, unlockedAssets[], unlockedComponents[]}`). The
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

`SceneObject` (carries `properties.rotationAroundBeamAxisDeg` for
waveplate per-instance rotation post-0060; the legacy `properties.bindingOverrides`
JSON dict was promoted to first-class `ObjectBinding` rows by 0076),
`ObjectBinding` (post-0076 — `componentBindingId`, six nullable
`local*Delta` fields, `asset3dIdOverride`, `properties`),
`ComponentItem`, `ComponentBinding`
(post-0062 — `targetKind` (`asset`/`subcomponent`/`empty`),
`assetThreeDId`/`subComponentId`, `localXMm`…`localRzDeg`,
`tunableAxes: { [axis]: { frame, min, max, default } }`, `role`, `sortOrder`,
`properties.linkGroup` (string — sibling-binding slider link),
`properties.role_label` (string — stable key for migrations)),
`Asset3D`, `Anchor` (with `connectorType`, `derivedFromFiberEndpoint`,
`derivedFromRfCableEndpoint`; waveplate fast-axis lives on
`Anchor.fastAxisDegBodyLocal` post-0060), `OpticalLink`,
`PhysicsElement`, `BeamPath`, `OpticalPort`, `Spectrum` /
`SpectrumComponent` / `GaussianMode` / `JonesVector`, per-kind param structs
(`LaserSourceParams`, `TaperedAmplifierParams`, `MirrorParams`,
`LensSphericalParams`, `WaveplateParams`, `FiberParams`, `GlanPolarizerParams`
(Phase 2 — gained physical-spec keys `lengthMm` / `refractiveIndex` /
`airGapAstigmatismMm` / `augmentedOffsetXMm` / `coatingNormalBodyLocal`
so the procedural prism + 5×5 ABCD operator are catalog-tunable),
`IsolatorParams` + nested `IsolatorGlanParams` / `IsolatorFaradayParams`
(Phase 2 — when `frontGlan` + `faraday` + `backGlan` are all present the
simulator runs the 3-stage Glan→Faraday→Glan composition; missing any
falls back to the legacy single-knob `forwardLossDb`), …),
`UnlockResult` (Phase 2 — `sessionId` + `unlockedAssets[]` +
`unlockedComponents[]`), `AssemblyRelation` /
`RelationType` / `GeometrySelector`, `Collection` / `CollectionMember` /
`CollectionTemplate`, `TimingProgram`, `RfSourceParams` / `RfAmplifierParams` /
`RfCableEndpointLink` / `RfChainNode`, `DeviceState`, `SimulationModule` /
`SimulationRunV2`, `Circuit`, `EmProblem`, `Mesh`, `ElementKind` (union of all
~31 kind strings), `PhysicsCapability`.

Anchor reference: `AssetAnchorId` literal union (in `backend/app/schemas.py`)
gained `faraday_centre` (Phase 2 — marks the TGG slab's central plane
normal to the optical axis; position = isolator body centre, direction =
+Z, apertureMm = TGG clear aperture, typ. ⌀4.7 mm for IO-3-850-HP). The
legacy `front_pbs` / `back_pbs` anchors remain in the union for back-
compat with alembic-seeded scenes but are no longer the canonical
isolator alignment surface — the 3-stage architecture puts each Glan
slab's cut interface anchor on its own GlanLaserCalcitePrism
sub-Component.

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

### Asset3D.properties.viewerHints (post-0064)

Asset3D gained a JSONB `properties` column in alembic 0064 to give
asset-level metadata a canonical home. First (and currently only)
consumer is `viewerHints`, honoured by the generic asset loader
regardless of which Component renders the asset:

| Field | Effect |
|---|---|
| `deletedCentroids: string[]` | STL triangle prune — keep all triangles whose `(x,y,z)` centroid key is NOT in the list. Originally lived on `Component.properties.isolatorDeletedCentroids`; migrated asset-level by 0070. |
| `includeOnlyCentroids: string[]` | Inverse of `deletedCentroids` — keep ONLY the listed triangles. Used by the IO-3-850-HP partition sub-assets baked by 0074 to extract the front / back STL slices. |
| `recenterOrigin: [x,y,z]` | Translate the post-filter geometry by `-x,-y,-z` (mm, body-local). Lets a sub-piece asset's effective origin sit at its Mount so the binding's `local*` translation doesn't double-offset. |
| `axisRadiusFilterMm: number` | Bulk hide every triangle whose distance from the bbox-longest axis is ≤ N mm — used to strip mount internals. |
| `material.type, material.opacity` | Render-hint override (`translucent_housing` etc.). |
| `bundledOverlay: boolean` | Suppress the legacy bespoke overlay path (`buildThorlabsIsolatorObject` etc.) when the binding tree's sub-Components handle the overlay instead. Avoids double-rendering PBS cubes when both code paths fire. Set on every isolator housing STL once a 5-part binding tree migration has landed (0068, 0071). |

Generic loader entry point: `frontend/src/three/loadAsset/viewerHints.ts`
(`applyViewerHintsToGeometry`, `applyIncludeOnlyFilter`, `materialForHints`).
Isolator-only paths (the bespoke `pbsOverlay` route) check `bundledOverlay`
before emitting their own PBS / calcite-prism overlay, so the binding
tree's PBS sub-Components are the single source for those after migration.

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
{ "type": "object.updated",          "payload": { ...SceneObject }   }
{ "type": "object.created",          "payload": { ...SceneObject }   }
{ "type": "object.deleted",          "payload": { "id": "..." }      }
{ "type": "component.updated",       "payload": { ...ComponentItem } }
{ "type": "component_binding.created"/.updated/.deleted, "payload": { ...ComponentBinding } }
{ "type": "object_binding.created"/.updated, "payload": { ...ObjectBinding } }  // alembic 0076
{ "type": "object_binding.deleted",  "payload": { "id": "...", "objectId": "..." } }
{ "type": "beam_path.updated",       "payload": { ...BeamPath }      }
{ "type": "device_state.updated",    "payload": { ...DeviceState }   }
{ "type": "connection.updated",      "payload": { ...Connection }    }
{ "type": "timing_program.updated",  "payload": { ...TimingProgram } }
{ "type": "collection.updated",      "payload": { ...Collection }    }
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
- `POST /unlock` (**new, Phase 2**) — reverses a previous commit's
  *lock* (not the lifecycle). For every entity this session created
  (via the `op='create'`, `undone_at IS NULL` mutation log), clears
  `ai_approved_at` if it is still set; writes one `unlock`
  ApprovalEvent per entity. Only valid on `status='committed'`
  sessions — cancelled / abandoned sessions never had a lock to
  reverse, running sessions haven't approved anything yet. Idempotent:
  re-running returns empty `unlockedAssets` / `unlockedComponents`
  lists. The session row stays `committed`; to re-edit the rows the
  user starts a new agent session and the now-unlocked rows become
  touchable again. Useful when an approved Component needs another
  pass of agent edits.

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

## Asset-Physics-Model v3 (Phase 2/3)

A second optical architecture lives **alongside** v2 in this repo. v2
remains the default everything renders against; v3 is the in-progress
replacement that pushes optical physics down onto `Asset3D` (kind +
faces + transitions) so the ray tracer becomes geometry-driven instead
of `componentType`-dispatched. Read
[`docs/asset-physics-model.md`](docs/asset-physics-model.md) for the
design rationale, [`docs/asset-physics-implementation.md`](docs/asset-physics-implementation.md)
for the phase plan + file map, and [`docs/phase-3b-review.md`](docs/phase-3b-review.md)
for the post-Phase-3b audit.

### Three-tier layout in v3

| Layer | v2 (current default) | v3 (Phase 3) |
|---|---|---|
| Physics | Lives on Component via `componentType` + the kind plugin registry | Lives on `Asset3D` as `physics_kind` + `faces[]` + `transitions[]`; Component is now purely a composition tree |
| Geometry | CAD only on Asset3D | CAD + optical port geometry (face position / normal / aperture / domain) on Asset3D |
| Per-instance state | `SceneObject.properties.kindParams` + `objectBindings` | `objects.param_overrides` + `objects.dynamic_sources` (alembic 0082 columns) |
| Dispatch | Ray tracer switches on `componentType` string | Ray tracer hits a face, looks up the transition for that face id, calls the named op from a code-only Kind Registry |

### Backend (`backend/app/optical/`)

| File | Role |
|---|---|
| `beam_ray.py` | `BeamRay` dataclass (chief ray `origin` + `direction`, per-axis Gaussian `qx`/`qy` complex parameters supporting astigmatism, `jones=[E_s, E_p]` in beam-local s/p frame, `power_mw`, `wavelength_nm`, `path_length_mm`, `phase_accum_rad`, `is_ghost`, `exclude_face_key`). `make_beam_ray` constructor; `vec3_distance` helper |
| `jones.py` | s/p basis math + frame transforms (`jones_body_to_lab`, `jones_lab_to_body`) — needed because Jones vectors are expressed in beam-local frame, not body- or lab-frame |
| `pose.py` | `V3Pose` (mm + ZXZ Euler degrees), `V3Transform`, `compose_transforms`, `pose_to_transform`, plus lab↔body point and direction transforms (uses THREE-equivalent quaternion math but returns plain `Vec3` so the rest of the package stays renderer-agnostic — paves the way for the Phase 5 Rust/WASM port) |
| `registry.py` | `Face` dataclass, `PhysicsOpContext`, `register_kind` / `register_ops` / `get_op` / `has_op`. **Code-only registry — no DB tables**. Each kind module under `kinds/` calls `register_kind` at import time; the v3 solver eager-imports `app.optical.kinds` so dispatch never sees an unregistered op |
| `ray_tracer_v3.py` | Legacy face-based tracer (Phase 3). `intersect_face` (ray-plane + aperture test, `exclude_face_id` to prevent re-hitting the face the ray just left), `nearest_face_hit`, `trace_ray_through_asset` (single-asset trace, Phase 3a), `trace_ray_scene` (full scene trace with per-object lab↔body transforms, Phase 3b). Multi-hop `via[]` support for PBS / Glan-Laser / dichroic internal reflection chains. Kept in parallel until Phase 9.8 drops `faces`/`transitions` |
| `anchor_tracer.py` | **Phase 9.2 anchor-centric tracer.** Dispatches on `Asset3D.anchors[]` instead of `faces[]` + `transitions[]`. Each anchor carries its own local tri-axis (`axisX` = propagation/normal, `axisY` / `axisZ` = transverse). Beam state at a hit is the 5×5 augmented vector `[y, θ_y, z, θ_z, 1]` in the anchor's local frame (transverse offsets + tilts). `V3Anchor` / `V3AnchorScene` / `V3AnchorBindingSlot` dataclasses; `intersect_anchor` (ray-plane + circular-aperture test), `nearest_anchor_hit` filters to `PRIMARY_ANCHOR_IDS` — after the **Phase 9.8 anchor-naming cleanup** that set collapsed to five canonical ids: `intercept_in` (transmissive entry — lens, waveplate, EOM, polarizer, nonlinear, beam_dump, camera, detector, wavemeter, fiber-in, glan_polarizer, TA-in), `intercept_out` (transmissive exit — laser_source, fiber-out, TA-out), `intercept_face` (reflective/coating — mirror, dichroic_mirror, PBS, beam_splitter, **and Glan-Laser as of Phase 9.8** so the same op handles cube PBS + air-gap calcite prism), `interaction_center` (AOM — synthesized at load time by `db_scene_loader._derive_aom_interaction_center` from the midpoint of `intercept_in` and `intercept_out`), and `optical_center` (faraday_rotator only). Pre-Phase-9.8 ids (`optical_anchor`, `out`, `+x`, `in`, `seed`, `coating_plane`, `reflection_surface`, `tip_a/b`, `emit_point`, `slab_center`, etc.) are no longer trace entry points; `main.py::_audit_legacy_anchor_ids` logs a warning at startup if any Asset3D still carries one. `beam_state_from_anchor_hit` uses `abs(d.dot(axisX))` so `θ_y` / `θ_z` keep their geometric sign whether the ray hits head-on or anti-parallel; propagation-direction sign is recovered in `out_ray_from_state`. Per-kind ops live in `anchor_ops/<kind>.py` and take `(ray_in_body, asset, anchor_hit, ctx) → list[BeamRay]`; multi-output ops (PBS p/s branch, AOM ±1 orders) return ≥ 2 rays |
| `anchor_ops/{aom,emit_laser_source,fiber,lens,mirror,misc_ops,pbs,polarizer,waveplate}.py` | Anchor-tracer per-kind PhysicsOps. `misc_ops.py` bundles the smaller kinds (dichroic_mirror / eom / waveplate / etc.) that don't need their own file. Each module's `register()` is called from `anchor_ops/__init__.py`'s eager import at startup; the v3 solver always sees them registered |
| `solver_v3.py` | Orchestrator: runs `trace_ray_scene` (face-based) **or** `trace_ray_anchor_scene` (anchor-based) over the scene + initial rays, serialises BeamRays to JSON-safe dicts. Stateless (no DB writes — distinct from the v2 `solve_chain` which persists `BeamSegment` rows) |
| `db_kinds.py` | DB-backed `{kind_name: op_set_name}` cache (`_KIND_TO_OP_SET`). Hydrated at FastAPI startup from the `kinds` table (alembic 0086); refreshed by the Kind CRUD endpoints via `set_kind_cache_entry` / `remove_kind_cache_entry`. Used by `registry.get_op` as a fallback when the kind name isn't a literal `_REGISTRY` key. Kept separate from `registry.py` because that file is parity-mirrored to TypeScript on the frontend — DB / SQLAlchemy imports must NOT leak into the parity contract |
| `db_scene_loader.py` | Builds a complete `V3Scene` + `V3AnchorScene` snapshot directly from `assets_3d` + `components` + `component_bindings` + `objects` rows so the `/v3/solver/run-from-db` endpoint doesn't require callers to ship a serialized scene. Objects whose Asset3Ds lack v3 fields (kind_id / faces / transitions) are skipped silently — v2-only objects coexist while migration proceeds. Dynamic sources (laser power, channel freq) come from `SceneObject.properties` for now (v2 location); when Phase 7 adds a dedicated `dynamic_sources` column the lookup moves there |
| `geometry.py` | Pure geometric helpers shared across ops (Snell, reflection, intersection primitives) |
| `kinds/<kind>/physics.py` | Legacy face-based PhysicsOp implementations: `aom_v3/`, `dichroic_mirror/`, `eom/`, `faraday_rotator/`, `fiber/`, `glan_laser/`, `laser_source/`, `lens/`, `mirror/`, `pbs/`, `polarizer/`, `tapered_amplifier/`, `waveplate/`. Each kind exports `register()` that calls `register_kind` once; `kinds/__init__.py` eager-imports all of them. Will retire when the anchor tracer is the only reader |
| `schemas_v3.py` (in `backend/app/`) | Additive Pydantic schemas: `FaceV3`, `TransitionV3`, `TransferMatrixV3`, `Asset3DV3In/Out/Update`, `ComponentV3Out`, `QuaternionV3` etc. Coexists with `schemas.py` |

### Frontend (`frontend/src/optical/`)

The TypeScript mirror of the backend package — same `BeamRay` shape,
same op names, same numerical results to within 1 × 10⁻⁶ tolerance
(parity-tested):

| Module | Role |
|---|---|
| `beam-ray.ts` | `BeamRay` struct + `Vec3` helpers + `makeBeamRay` |
| `jones.ts` | s/p basis + reflection-basis flip math |
| `pose.ts` | Lab↔body transform; internal use of THREE but `Vec3`-only public API |
| `registry.ts` | `OpticalKind` literal union (~22 kinds), `PhysicsOp` type, `registerKind` / `registerOps` (e.g. `kinds/glan-laser/` adds `glan_transmit_p` + `glan_reject_s` under the existing `polarizer` kind), `getOp` / `hasOp` / `listRegisteredKinds`. Throws on missing op so unit tests catch typos at registration time, not at trace time |
| `geometry.ts` | Pure geometric helpers (Snell, reflection, intersection) shared by ops |
| `ray-tracer-v3.ts` | `intersectFace` / `nearestFaceHit` / `traceRayThroughAsset` / `traceRayScene` / `findTransitionContexts`. Honors `excludeFaceKey` per-segment to avoid re-hits |
| `kinds/<kind>/physics.ts` | Per-kind ops — `lens` (`abcd_thin_lens` via `mThinLens`), `mirror` (`reflect_specular`), `polarizer` (`jones_polarizer` + Malus's law + Jones re-normalisation), `pbs` (transmit + reflect dual-port), `waveplate` (Jones rotation by retardance), `aom-v3` (multi-order diffraction with order-dependent power split), `dichroic-mirror` (wavelength-cutoff transmit vs reflect), `eom` (intensity / phase modulator), `faraday-rotator` (non-reciprocal Jones rotation), `glan-laser` (TIR + birefringent extinction), `laser-source` (emitter origin + Jones init), `tapered-amplifier` (gain + saturation), `fiber` (Bessel-mode coupling + bend loss + Fresnel + polarisation) |
| `fiber/` | Self-contained fiber sub-package — `arc_length.ts`, `attenuation.ts`, `bend_loss.ts`, `bessel.ts`, `coupling.ts`, `fiber_mode.ts`, `fresnel.ts`, `gaussian.ts`, `polarization.ts`, `total_efficiency.ts`. Used by `kinds/fiber/physics.ts` to compute Gaussian-to-mode coupling efficiency for a fiber end snap |
| `__tests__/` | 14-test single-asset suite + 13-test scene-level suite + per-kind physics tests + cross-language parity runner (loads golden JSON beam-trace traces and compares frontend output to within tolerance — golden files live in `__tests__/parity/golden/`, identical files are referenced by the backend parity suite via `backend/tests/optical/parity/`) |

### Store + UI

- [`frontend/src/store/v3CatalogStore.ts`](frontend/src/store/v3CatalogStore.ts) —
  Zustand store hydrated from `/api/v3/assets3d` + `/api/v3/components`.
  Selectors: `getAssetByCatalogId(slug)`, `getAssetByDbId(uuid)`,
  `getAssetsByKind(kind)`, `getComponentByCatalogId(slug)`,
  `updateAsset(catalogId, patch)`. Cached after first fetch; explicit
  `refresh()` to invalidate.
- [`frontend/src/store/kindsStore.ts`](frontend/src/store/kindsStore.ts) —
  Zustand store backing the Kind registry (alembic 0086). Cached list
  from `/api/kinds`; `byDomain('optical'|'rf'|'mechanical')` selector
  feeds the `kind_id` `<select>` in `ComponentsV2Editor` and
  `Asset3DV3Editor`. Status atom (`idle`/`loading`/`ready`/`error`);
  explicit `refresh()` after the user CRUDs a kind. Loaded once on
  first read.
- [`frontend/src/store/v3FeatureFlags.ts`](frontend/src/store/v3FeatureFlags.ts) —
  the `useV3RayTracer` opt-in flag. Sources (priority): URL query
  param `?useV3RayTracer=1`/`=0` → localStorage
  `qmem.flag.useV3RayTracer` → default `false`. Plain Zustand atom +
  non-React `isV3RayTracerEnabled()` getter so the dispatcher can
  consult it inside pure ray-trace functions.
- [`frontend/src/components/Asset3DV3Editor.tsx`](frontend/src/components/Asset3DV3Editor.tsx) —
  full-screen editor for v3 face / transition metadata. Side-panel
  edits faces (id, body-local position, optional normal, aperture
  size + shape, `optical`/`rf`/`ttl` domain) and transitions
  (face_in / face_out / op / params / optional 5×5 matrix); a live
  THREE preview shows face icons placed on the loaded STL/GLB so the
  user can sanity-check the body-local coordinates before saving.
  Writes go through `useV3Catalog.updateAsset` → `PUT /api/v3/assets3d/{catalog_id}`.
- [`frontend/src/components/dev/V3RayTracerToggle.tsx`](frontend/src/components/dev/V3RayTracerToggle.tsx) —
  fixed-corner dev chip that reads/writes the flag without forcing
  the user into URL or localStorage edits. Mount somewhere persistent
  during the v3 rollout.

### Asset catalog (`assets/catalog/`)

Stable string slugs (`catalog_id`) live in JSON files:

```
assets/catalog/
  kinds/                        # Kind metadata (defaults, doc, schema hints)
  assets3d/
    optical/<kind>/<vendor_part>.json
    mechanical/<role>/<vendor_part>.json
  components/<kind>/<vendor_part>.json
```

`backend/scripts/seed_v3_assets.py` reads this tree and upserts into
the v3 columns of `assets_3d` / `components` / `component_bindings` by
`catalog_id`. Mechanical-only assets (Asset3D with `kind == null` in
JSON) seed with `physics_kind = NULL` + empty faces/transitions — only
geometry + properties are populated. Re-running the seed is
idempotent and safe; the unique partial index on `catalog_id` ensures
collisions surface as DB errors rather than silent duplication.

### Tests + parity

- Backend: `backend/tests/optical/test_<kind>.py` (lens, mirror,
  polarizer, waveplate, pbs, dichroic_mirror, faraday_rotator,
  aom_v3, glan_laser), `test_ray_tracer_v3.py` (single + scene),
  `test_solver_v3.py`, `test_solver_v3_isolator.py`,
  `parity/test_parity.py` (loads golden JSON traces and reproduces
  them with the Python solver).
- Frontend: `frontend/src/optical/kinds/<kind>/physics.test.ts`,
  `frontend/src/optical/__tests__/ray-tracer-v3*.test.ts` (single
  asset / scene / component / isolator), `frontend/src/optical/fiber/__tests__/*`,
  `frontend/src/optical/__tests__/parity/parity.test.ts` (consumes
  the same golden JSON as the backend so the two language
  implementations stay numerically in lockstep).

### Status — what shipped, what's still legacy

- **v3 dispatcher swap landed.** `DigitalTwinViewer` consumes v3
  anchor tracer output through
  [`three/v3TraceAdapter.ts`](frontend/src/three/v3TraceAdapter.ts);
  the `useV3RayTracer` flag is no longer consulted (the file remains
  as a no-op stub for one release in case URL bookmarks still set
  it).
- **v3 solver DB-loader landed.** `POST /v3/solver/run-from-db` loads
  the V3Scene directly from `assets_3d` + `components` +
  `component_bindings` + `objects` via
  `db_scene_loader.load_anchor_scene_from_db`. The stateless
  `POST /v3/solver/run` is still available for external callers and
  parity tests.
- **Anchor tracer is the default.** `app.optical.anchor_tracer`
  reads `Asset3D.anchors` (alembic 0087) and is the production path.
  Legacy `ray_tracer_v3` still exists and reads
  `Asset3D.faces` / `Asset3D.transitions`; Phase 9.8 drops those two
  columns once no call sites remain.
- **`kind_id` everywhere.** Alembic 0090 dropped
  `components.component_type` and `assets_3d.physics_kind`; the new
  `kinds` table (0086) is the metadata registry; the in-process
  `_KIND_TO_OP_SET` cache resolves a row's slug to its `op_set_name`
  so the tracer can dispatch on user-created kinds without a DB
  roundtrip.
- **`ComponentBinding` per-binding v3 fields are still pending.**
  The `ObjectBinding` per-axis delta path (0076) is the current
  escape hatch; Phase 3c will graft `tunable_axes` semantics onto
  the v3 tree directly.

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
  Phase 2 already landed the `POST /unlock` escape hatch for "I
  committed too early — let me re-edit"; the next step is to expose
  it from the AI panel of the *new* (current) session as well, not
  just the panel that did the original commit.
- **ComponentBinding read-path migration (Stages D → G).** 0062 added the
  table; 0064–0076 worked through the read-path flip — every isolator
  family (TORNOS / IO-VLP / IO-HP / IO-3-HP-flat) now renders through
  the binding tree with `viewerHints.bundledOverlay=false` suppressing
  the legacy `pbsOverlay` path. Stage E landed via 0076 (per-instance
  overrides → first-class `object_bindings` table + `BindingTreeAdjustControls`
  panel). Remaining: Stage F (legacy `IsolatorLinkedRotationGroup` /
  `pbsOverlay`'s per-model PBS pose table fully retired — currently
  the dev-page only consults it as a seed); Stage G — drop
  `Component.asset_3d_id` once no renderer reads it. Until Stage G
  lands the two pointers must stay in sync (root binding's
  `asset_3d_id` mirrors the column).
- **Per-instance ObjectBinding panel polish.** `BindingTreeAdjustControls`
  ships in the optical-domain `PhysicsElementPanel`, but a generic
  panel mount (so non-optical composite components like `mirror_mount`
  can use the same UX once they grow binding trees) is still a follow-up.
- **IsolatorDevPage promotion.** The standalone dev page in
  `kinds/isolator/IsolatorDevPage.tsx` is now the authoring tool for
  isolator binding-tree migrations (mark partitions, save Glan-Laser
  pose, bake sub-Asset3D) but the workflow still ends in "hand-edit an
  alembic migration." A "save to DB" button that emits the migration
  for human review would close the loop.

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
  with a wide closure could in theory pull a lot of rows. After 0066
  the constraints collapsed into a single
  `ck_component_bindings_target_shape` that admits asset / subcomponent
  / empty target shapes; depth 0 self-subref still rejected at the
  DB. Depth ≥ 1 cycles must go through the application path. Don't
  bypass the router.
- **Asset-level aperture / fast-axis are global.** Post-0059 and 0060
  edits to `Asset3D.anchors[].apertureMm` and
  `Asset3D.anchors[].fastAxisDegBodyLocal` apply to every SceneObject
  that shares the asset. The TORNOS isolator (0061) was split out of
  `primitive_box` for this exact reason — if you find yourself wanting
  per-instance behaviour, the right answer is "clone the asset" not
  "patch the per-instance override", which is gone.
- **ObjectBinding additive semantics — clearing vs zero (post-0076).**
  `localXMmDelta`, `…YMmDelta`, etc are nullable on purpose: `NULL`
  means "no override on this axis" (renderer adds zero — i.e. the
  ComponentBinding baseline shows through), a number including 0
  means "override to this delta". The slider UI tries to delete the
  row when every axis returns to 0 (so the renderer reverts cleanly
  to baseline), but if your code path writes a row with all six
  deltas explicitly = 0 it persists — clean it up by DELETEing
  rather than zeroing.
- **ObjectBinding cascade-on-binding-deletion is forward only.**
  Dropping a ComponentBinding CASCADEs its `object_bindings` rows
  (FK is `ondelete='CASCADE'`), but the inverse — dropping an Asset3D
  that is the target of an `asset_3d_id_override` — RESTRICTs. The
  app gets a 23503 / `IntegrityError` rather than orphaned overrides.
  This is intentional but easy to confuse with a generic DB error;
  check the constraint name in the response if you see a delete fail.
- **`viewerHints.bundledOverlay` must be set BEFORE the binding tree
  is inserted (or you double-render).** Migrations 0068 / 0071 set
  the flag first, then insert the bindings. If you author a new
  isolator migration that flips this order — bindings first, flag
  later — the next page load will render PBS twice (once by the
  legacy `pbsOverlay` path, once by the binding sub-Components) and
  the alpha-compositing of two translucent housings looks opaque.
  Always set `viewerHints.bundledOverlay=false` first.
- **5-part vs flat tree is a per-model choice.** 0067 (TORNOS) and
  0068 (VLP) use the 5-part tree with empty Mount intermediates;
  0075 flattened IO-3-850-HP back to 5 sibling children directly
  under the root. Both are valid; the Mount layer is only useful
  when the Mount's rotation DoF needs to drive multiple children
  rigidly. If you only need per-child rotation, flat is simpler.
  Picking the wrong shape isn't a bug — but if the user expects "PBS
  and piece rotate together" you want the Mount; if they expect
  "each independently positionable", flatten. Phase 2 paired this
  with the `linkGroup` mechanism (0077): when prism + piece must
  rotate together in the flat tree, give them the same
  `properties.linkGroup` string and `BindingTreeAdjustControls`
  renders ONE slider that updates both rows.
- **Generalized 5×5 ABCD scalar-q split is approximate for rotated
  cylindrical optics.** `apply_operator` in
  `solvers/generalized_abcd.py` updates `q_x` and `q_y` independently
  from the diagonal 2×2 sub-blocks of M, so it's exact for x/y-
  decoupled operators (free space, spherical lens, glass plate, flat
  / curved mirror, axis-aligned cyl, PBS arms, Glan slab, Faraday
  slab) but ignores off-diagonal coupling that arises from
  `m_cylindrical_rotated` unless the input beam is rotationally
  symmetric (`q_x = q_y`). The chief-ray 5×5 vector multiply IS exact
  — only the scalar-q split is approximate. If you ever need
  off-axis-rotated cyl with astigmatic input, the way forward is a
  full 2×2 complex-q matrix (not the scalar split today).
- **Isolator nested-chain gate is silent on missing keys.**
  `apply_isolator` runs the full 3-stage Glan→Faraday→Glan
  composition only when `kindParams.frontGlan` + `backGlan` +
  `faraday` are ALL present as dicts. Missing any falls back to the
  legacy `forwardLossDb` single-knob power multiplier — no error,
  the chain just renders lossy. 0080 backfilled the nested defaults
  onto every pre-existing `physics_elements` row; new isolator rows
  inherit them from the plugin's `defaultParams`. If a fresh scene
  starts looking like the isolator is invisible (forward power
  passes through, no `out_r_front` / `out_r_back` rejected-beam
  segments, polarisation untouched) check the row's `kind_params`
  first — the gate is the most likely culprit.
- **v3 dispatch eager-imports `app.optical.kinds` on EVERY solver
  call.** `routers/v3_solver.py::run_v3_solver` does `from app.optical
  import kinds` inside the request handler so a fresh test run with
  no prior import gets the registry populated. The cost is one
  module-cache hit per request after the first; not a hot path today
  but worth lifting to a startup hook if `/v3/solver/run` becomes
  high-QPS. The frontend has the same shape — `kinds/<kind>/physics.ts`
  side-effect-registers on import; barrel files keep the dependency
  chain explicit so unused kinds don't bloat the bundle.
- **`v3CatalogStore` is a read-through cache with no invalidation hook.**
  An edit through `Asset3DV3Editor` calls `updateAsset` which patches
  the store optimistically, but another client editing the same
  Asset3D over the v3 API never broadcasts on the WS — the v3 routes
  do not yet emit `asset.updated` events (the v2 mutation broadcast
  pipeline only fires through the v2 routers). For now Asset3DV3Editor
  is single-user; multi-user editing will need a v3 broadcast lane
  (likely `v3_asset.updated` to keep v2 listeners decoupled). The
  store's manual `refresh()` is the escape hatch.
- **`useV3RayTracer` flag has three sources.** URL param wins;
  localStorage second; default `false`. If a user types
  `?useV3RayTracer=1` once, the param sets the value AND the persist
  helper writes `qmem.flag.useV3RayTracer = "true"` to localStorage,
  so subsequent reloads without the param still get v3. To force a
  reset to default, clear `qmem.flag.useV3RayTracer` from devtools
  Application → Storage.
- **Parity tests share golden JSON between languages.** The
  `frontend/src/optical/__tests__/parity/golden/*.json` files are the
  source of truth; `backend/tests/optical/parity/` references the
  same files via a symlink (per `docs/asset-physics-implementation.md`
  §1). If a parity test fails after editing one side's op, regenerate
  the golden file via the runner — DO NOT update the JSON by hand,
  or the two implementations will drift apart silently.
- **0082 columns are nullable — v2 reads see NULLs cleanly.** Existing
  v2 list endpoints (`/api/assets`, `/api/components`) do NOT filter
  on `catalog_id`, so a non-seeded row appears in v2 with no v3
  fields populated — fine. The flip side: a v3 catalog edit that
  changes `faces[]` or `transitions[]` does NOT trigger any v2
  re-render path, because the v2 renderer reads `Asset3D.anchors`
  (the old shape) instead. Until the v3 dispatcher swap lands the
  two surfaces evolve independently.
- **Anchor tracer vs face tracer overlap (Phase 9 transition).** The
  anchor tracer (`anchor_tracer.py`) is the production path, but the
  face tracer (`ray_tracer_v3.py`) is still in the package and still
  reads `Asset3D.faces` + `Asset3D.transitions`. If you author a new
  Asset3D and only populate `anchors[]` (skipping faces/transitions),
  the anchor tracer is happy but any legacy code path that still
  imports `nearest_face_hit` will hit an empty face list and trace
  nothing through that asset silently. Until Phase 9.8 drops the two
  columns, seed BOTH shapes for new catalog rows (`seed_v3_assets.py`
  does this automatically — only hand-written catalog edits are at
  risk).
- **Kind cache is hydrated at FastAPI startup ONLY.** `db_kinds.py`'s
  `_KIND_TO_OP_SET` is rebuilt by `kinds.py` router on every
  POST/PATCH/DELETE, but a direct SQL UPDATE against the `kinds`
  table bypasses the cache and the tracer keeps returning the stale
  `op_set_name`. If you need to fix up a kind via psql / Adminer,
  restart the uvicorn process or POST a no-op patch through the
  router so the cache invalidator runs.
- **`v3TraceAdapter.ts` waist is a heuristic, not a tracked value.**
  Until the v3 solver emits explicit `BeamMode` per segment, waist
  in TraceSegment-shaped output (BeamScope, OpticalLinkViewer,
  snap-to-beam) is recomputed from the q-parameter under M² = 1.
  Anything that depends on accurate w(z) for non-fundamental modes
  (multi-mode fiber output, depolarised TA seed) will be wrong by
  the M² factor. Tracked as a Phase 7.3 follow-up.
- **`/v3/solver/run-from-db` silently skips Objects whose Asset3Ds
  lack v3 fields.** This is intentional — v2-only objects coexist
  with v3 during the migration — but means a typo'd `kind_id` (or a
  legacy row whose `kind_id` was never backfilled) just doesn't show
  up in the trace, no error. If a scene's trace is mysteriously
  short, check `assets_3d.kind_id IS NULL` for the row first.
- **Slug-shape constraint (alembic 0088) is per-table, not
  cross-table.** `assets_3d.catalog_id` and `components.catalog_id`
  each have their own UNIQUE; the same slug can live on both an
  Asset3D and a Component (and usually does — `coherent_tornos_850_4`
  the Asset3D + `coherent_tornos_850_4` the Component). The
  `seed_v3_assets.py` upsert relies on this — don't add a global
  UNIQUE across both tables or the seed breaks.
- **GlanLaserCalcitePrism geometry lives in TWO places.** The 3D
  procedural renderer (`glan_polarizer_prism.ts`) reads
  `component.properties.{sizeMm, lengthMm, wedgeAngleDeg}` for the
  visual prism dimensions; the 5×5 ABCD operator (`m_glan_slab`)
  reads `kindParams.{lengthMm, refractiveIndex, wedgeAngleDeg,
  airGapAstigmatismMm, augmentedOffsetXMm}` for the optical math.
  Migrations 0079 + 0081 set the Component-level geometry; the
  plugin's `defaultParams` seed the per-PhysicsElement keys.
  Editing only one of them (e.g. tweaking `lengthMm` on the
  Component but not on existing PhysicsElement rows) leaves the
  renderer and the solver disagreeing. Re-running 0080 is the
  safest way to re-align after a Component-level change.

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
- **Body-frame lift is mandatory for anchor reads.** `Asset3D.anchors[].positionMmBodyLocal` and `axis{X,Y,Z}BodyLocal` live in body frame. To get a value you can compose with a SceneObject's lab pose you MUST lift it via `bodyFramePositionMm` + `body_frame_rotation` — `R_body × anchor + bfp` (CAD-axis offset, Phase 9.10 semantics; see [`docs/frame-anchor-architecture.md §3`](docs/frame-anchor-architecture.md)). Reading the raw fields and composing directly with SceneObject pose is the recurring bug fixed on 2026-05-27. The TypeScript codebase enforces this through `utils/anchorAccess.ts` (`anchorObjectLocalPos`, `anchorObjectLocalAxisX/Y/Z`, `anchorObjectLocalLegacyDir`) + the `npm run check:anchors` pre-build grep guard. The Python side does the lift centrally in `db_scene_loader._apply_body_frame_to_anchor` before handing anchors to the tracer, so each `anchor_ops/<kind>.py` op operates on already-lifted geometry. Per-line escape hatch: `/* raw-anchor-ok: <reason> */` on the offending line in TS.
- **Anchor tri-axis (`axisX/Y/Z`) ships through `/api/scene`.** Phase 9.1 added `axisXBodyLocal`, `axisYBodyLocal`, `axisZBodyLocal` to the `Anchor` Pydantic schema (alembic 0087 made `anchors` JSONB canonical; the schema field was added in this epoch). Legacy `directionBodyLocal` is still emitted for v2 back-compat. New consumers (PBS p/s split, waveplate retardance, fiber polarization) should read the tri-axis directly; the FE probe beam (PHY Editor preview) needs them to render polarization axes correctly.
- **Glan-Laser polarizer shares the PBS op.** Phase 9.8 collapsed the `coating_plane` anchor into `intercept_face` and widened `anchor_ops/pbs.py` so the same dispatch covers both 45° cube PBS (`cubeSizeMm` + `refractiveIndex`) and Glan-Laser air-gap calcite prism (`lengthMm` + `refractiveIndex_o`). `_pick_length_mm` / `_pick_refractive_index` pick whichever parameter set is populated, falling back to a 1-inch BK7 cube. The IO-3-850-HP / IO-5-850-HP 5-asset binding trees (alembic 0078 / 0085) reuse the new code path.
- **`window.__rayTraceDebug` is now a typed bridge.** Originally an ad-hoc dev hook, the `window.__rayTraceDebug` / `__beamGroup` / `__v3LabSegments` globals back real cross-component data flow (OpticalLinkViewerPanel, BeamScopePanel, snap-to-beam gizmo, AomAdjustControls / TaperedAmplifierAdjustControls, sceneStore). `three/debugBridge.ts` consolidates the type + publisher: `DigitalTwinViewer.renderRayTraces` calls `publishQmemDebug({rayTraceDebug, beamGroup, v3LabSegments})` as the single writer; consumers read via `readQmemDebug()` for the typed view (legacy direct `window.__*` reads still work). When the contract changes, search for `publishQmemDebug` to find every reader.
- **Fiber body cascade was removed.** `expandFiberBodyPose` and the
  `expandFiberBodyPose` branch in `sceneStore.updateSceneObject` are
  gone (0056 collapsed the cluster — the body moves the ends because
  they are now sub-objects of its kindParams, not because of a
  store-side rigid-group expansion). Don't reintroduce the old call
  path; the resolver does the right thing already.

---

*Last regenerated: 2026-05-28 (Alembic revision **0091** — Phase 9.11
data migration rotates `bodyFramePositionMm` by `R_body⁻¹`; the
codebase still reads it as a CAD-axis offset, so `main.py` startup
audits warn on suspect rows. See
[`docs/frame-anchor-architecture.md §3`](docs/frame-anchor-architecture.md).
Also landed this epoch: Phase 9.8 anchor-naming cleanup —
`PRIMARY_ANCHOR_IDS` collapsed to `intercept_in` / `intercept_out` /
`intercept_face` / `interaction_center` / `optical_center`; PBS op
now covers Glan-Laser; AOM `interaction_center` synthesised at load
time. New frame-anchor read pattern: `frontend/src/utils/anchorAccess.ts`
+ `assetFrame.ts` + `npm run check:anchors` pre-build grep guard
forbids raw `*BodyLocal` reads outside an allowlist; the Python side
lifts anchors centrally in `db_scene_loader._apply_body_frame_to_anchor`.
`/v3/solver/run` marked deprecated (tests / parity only);
`/v3/solver/run-from-db` is production. `Anchor` schema now ships
`axisXBodyLocal` / `axisYBodyLocal` / `axisZBodyLocal` to the FE.
`three/debugBridge.ts` consolidates `window.__rayTraceDebug` /
`__beamGroup` / `__v3LabSegments` into one typed publisher+reader.
Prior epoch: Alembic 0090 dropped legacy
`component_type` / `physics_kind` columns). The
classification field across the whole stack is now `kind_id`, an
FK-style slug into the new `kinds` table (alembic 0086). The
`/api/kinds` router gives the UI live CRUD over Kind metadata
(display name, default params, face template, needs_aperture,
wavelength range) without requiring a TypeScript change; PhysicsOps
stay in code and each row points at one via `op_set_name`. The v3
ray tracer is the **sole** physics path: anchor-centric tracer
([`anchor_tracer.py`](backend/app/optical/anchor_tracer.py) +
[`anchor_ops/`](backend/app/optical/anchor_ops/)) reads
`Asset3D.anchors` (canonical store after alembic 0087); the legacy
face/transition tracer (`ray_tracer_v3.py`) still exists for one
more release while parity tests drain. Downstream consumers that
used to read the legacy `TraceSegment` shape are now fed by
[`three/v3TraceAdapter.ts`](frontend/src/three/v3TraceAdapter.ts).
New REST: `POST /v3/solver/run-from-db` (loads scene from live
rows — no body needed). PHY Editor's "🔧 Binding dev" toggle now
mounts `BindingDevPanel.tsx` (unified Kinds / Asset3D /
Components CRUD with a single-active-rail-item canvas). New
migrations since the previous epoch: 0083 backfills the AOM
`rf_in` face; 0084 backfills v3 metadata onto 8 RF Asset3Ds; 0085
retires the IO-3-850-HP 7-binding workaround for a flat 5-asset
shape (per-slice STLs produced by
`backend/scripts/split_io_3_hp_stl.py`); 0086 lands the `kinds`
registry table; 0087 marks `assets_3d.anchors` as canonical; 0088
adds catalog-id slug-shape + uniqueness constraints; 0089 adds
unified `kind_id` columns; 0090 drops the legacy ones.

Previous epoch (Alembic 0082 — Asset-Physics-Model v3 schema landing):
the v3 columns
(`assets_3d.{catalog_id, physics_kind, faces, transitions,
default_params, wavelength_range_nm, body_frame_rotation}`,
`components.{catalog_id, exposed_faces}`,
`objects.{param_overrides, dynamic_sources}`) shipped alongside the
existing v2 anchor / kindParams data — all nullable, no breaking
change for v2 readers. Backend package `backend/app/optical/` and
frontend package `frontend/src/optical/` mirror each other
line-for-line — same BeamRay struct, same op names, golden-JSON
parity tests in `__tests__/parity/`. Per-kind ops landed: `lens`,
`mirror`, `polarizer`, `waveplate`, `pbs`, `dichroic_mirror`,
`faraday_rotator`, `aom_v3`, `glan_laser`, `eom`, `fiber` (with full
`optical/fiber/` sub-package for Bessel mode coupling, bend loss,
Fresnel, polarisation), `laser_source`, `tapered_amplifier`.
Catalog seed: `backend/scripts/seed_v3_assets.py` upserts from
`assets/catalog/{kinds,assets3d,components}/**/*.json` by
`catalog_id`.

Previous epoch (Alembic 0081 — Phase 2 isolator re-architecture):
legacy monolithic PBS+Faraday+PBS retired in favour of the 3-stage
Glan-Laser → Faraday → Glan-Laser chain. New backend solver
`solvers/generalized_abcd.py` introduced the 5×5 augmented-matrix
ABCD propagator (`m_glan_slab`, `m_faraday_slab`, `m_thin_lens` with
decenter/tilt, `m_cylindrical_*`, `m_curved_mirror`, …);
`optical_solver` gained `apply_glan_laser` (two ports — transmitted
E-ray + TIR-rejected O-ray) and `apply_faraday_rotator`, then
`apply_isolator` composed the three with `out_r_front` /
`out_r_back` rejected-beam ports. Schema: `faraday_centre` anchor
added (TGG central plane), legacy `front_pbs`/`back_pbs` retained
for back-compat; alembic 0077 ported IO-5-HP to the same flat tree
+ linkGroup as IO-3-HP, 0078 borrowed the IO-3 housing + piece
partitions, 0079 + 0081 nailed down the GlanLaserCalcitePrism
physical size (7.5 × 6.5 × 6.5 mm, wedge 38.5°, n_e 1.48), 0080
backfilled the nested 3-stage chain into every existing isolator
PhysicsElement so legacy scenes got the new physics without a
manual edit. Agent sessions gained `POST /unlock` to reverse a
commit's `ai_approved_at` lock. Frontend: `IsolatorDevPage`
retired and replaced by `ComponentComposer` (opened via the "🔧
Binding dev" toggle in PHY Editor); `BindingTreeAdjustControls`
added a per-instance "See through" toggle for translucent isolator
housings; `AIBindingPanel` gained an Unlock button;
`OpticalLinkViewerPanel` wireframe cache keyed on per-instance
objectBindings digest so slider drags re-render. Epoch before that
(0076): `object_bindings` first-class table +
`BindingTreeAdjustControls` + generic `viewerHints` asset loader +
IsolatorDevPage authoring flow.*
