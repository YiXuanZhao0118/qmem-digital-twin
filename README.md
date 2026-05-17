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
10. [Phase 2 / roadmap](#phase-2--roadmap)
11. [Troubleshooting & optimization notes](#troubleshooting--optimization-notes)

---

## Glossary & domain model

The data model has **three catalog tiers** plus a **scene graph** layered on top:

| Term | Meaning | DB table | API path |
|------|---------|----------|----------|
| **Asset** | A 3D file (`.stl` / `.glb` / `.step` / primitive) in the asset library. Owns `anchors[]`. | `assets_3d` | `/api/assets` |
| **Component** | A part type in the catalog ("AOMO 3080", "DBR-852-TOSA"). Backed by an Asset. | `components` | `/api/components` |
| **Object** | An **instance** of a Component placed in the scene. Has pose, visibility, locks, per-instance overrides. | `objects` | `/api/objects` |

`Asset → Component → Object` is the canonical hierarchy. The same Component can
have many Objects. The left panel shows Components and Objects; underlying
Assets are managed indirectly through component upload/import.

On top of those three tiers the scene graph adds:

- **Collections** (`collections` / `collection_members`) — Blender-style nested
  groups; a `rigidTransform: true` collection moves all members together.
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
- **Backend:** Python 3.13, FastAPI, SQLAlchemy async, Pydantic, WebSocket
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
                 │  /api/* (26 routers)  +  /ws (broadcast hub)   │
                 │  ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
                 │  │ routers/ │ │ services/  │ │ solvers/     │  │
                 │  └──────────┘ └────────────┘ └──────────────┘  │
                 │  SQLAlchemy async  +  Pydantic schemas         │
                 └────────────────────────┬───────────────────────┘
                                          │
                 ┌────────────────────────▼───────────────────────┐
                 │  PostgreSQL    :55432   (Alembic at 0054)      │
                 │  assets_3d, components, objects, connections,  │
                 │  collections, optical_links, rf_chain_nodes,   │
                 │  physics_elements, beam_paths, simulation_runs │
                 │  timing_programs, collection_templates, …      │
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
- 26 API routers under `/api/...` (full table below).

Config lives in `backend/app/config.py` (Pydantic Settings, reads `.env`):
`DATABASE_URL`, `CORS_ORIGINS`, `ASSET_ROOT`, plus Onshape and Palace fields
for later phases.

### Database tables (selected)

All tables use UUID primary keys. JSONB columns are used liberally for
per-kind parameter blobs so the schema doesn't have to migrate every time a
plugin grows a field.

| Table | Purpose | Notable columns |
|---|---|---|
| `assets_3d` | 3D files & their anchors | `file_path`, `unit`, `scale_factor`, `anchors` (JSONB, with `connectorType` after migration 0050) |
| `components` | Catalog | `component_type`, `brand`, `model`, `asset_3d_id`, `properties`, `physics_capabilities`, `archived_at` |
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

### Routers (`backend/app/routers/`, mounted in `main.py`)

| Mount | File | Purpose |
|---|---|---|
| `/api/assets` | `assets.py` | Asset upload & CRUD; serves anchors editor |
| `/api/components` | `components.py` | Catalog CRUD; archive/restore; upload-from-file. Owns `auto_create_physics_element_for_object`, which on a fresh `fiber` spawn also creates paired `fiber_end_a` + `fiber_end_b` SceneObjects (3-object cluster, mirroring migration 0052 for new placements) and joins them to the body's collection |
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
- `services/asset_converter.py`, `services/touchstone.py`,
  `services/instrument_polling.py`, `services/onshape_client.py`.

### Alembic migrations

Currently at **revision 0054**. Recent milestones:

| Rev | Title | Purpose |
|---|---|---|
| 0049 | split_kind_params | `kind_params` → `intrinsic_params` + `state_params` (Phase 4) |
| 0050 | anchor_connector_type | Adds typed connector field (sma/bnc, male/female) to every anchor |
| 0051 | timing_program_slim | Drops `kind`/`channel_index`/`invert`; PPGs emit one "RFout" gate; positional ordering |
| 0052 | fiber_split_to_paired_ends | A fiber becomes 3 SceneObjects: `fiber_end_a` + body + `fiber_end_b` |
| 0053 | collection_templates | Adds `collection_templates` table backing Collection Drift |
| 0054 | split_rf_cable_assets | Splits the shared `primitive_thorlabs_ca2906_cable` Asset3D into per-component rows (`primitive_rf_cable_sma_to_bnc`, `primitive_rf_cable_bnc_to_bnc`) so PHY Editor `rf_in`/`rf_out` anchor edits no longer clobber sibling cables |

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

- `loadAsset.ts` — GLTF/OBJ/STL loaders, per-componentType base colors,
  device-state overrides (overheating amp → red), per-component
  `properties.colorHex` overrides, mm scale.
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

### Fiber 3-object cluster (post-0052)

A "fiber" in the UI is **three SceneObjects** glued together:

```
fiber_body  ──── fiber_end_a   (End A ferrule, drives spline node 0)
            └─── fiber_end_b   (End B ferrule, drives spline node N-1)
```

The body's `PhysicsElement.kindParams` carries `endAObjectId` /
`endBObjectId` back-references. The spline endpoint positions are
**derived** from the ends' lab poses by `fiberBodyEndpointResolver.ts` —
moving an end repositions only the matching spline endpoint, while
moving the body cascades the same rigid delta to both ends so the whole
assembly translates / rotates together (`expandFiberBodyPose`,
`sceneStore.updateSceneObject`). Interior spline nodes stay editable in
fiber node-edit mode; endpoint nodes are locked (`endpointSplineNodesLocked`).

`kinds/_capabilityProfile.ts` reflects this: the fiber body is Outliner-
visible, gizmo-attachable, and pose-editable (so the whole assembly can
be picked up), but per-body Align and per-body Remove are hidden — those
operations belong to the individual ends or to the surrounding
collection.

### API client (`frontend/src/api/client.ts`)

A thin axios layer over `VITE_API_BASE_URL`. Method groups:

- **Scene**: `fetchScene`, `fetchRoomDimensionsApi`, `updateRoomDimensionsApi`
- **Objects**: `createObjectApi`, `updateObjectApi`, `deleteObjectApi`,
  `upsertObjectForComponentApi`
- **Components**: `createComponentApi`, `updateComponentApi`,
  `deleteComponentApi`, `uploadComponentAssetApi`, `importLocalComponentAssetApi`
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

WebSocket: app shell opens a single connection to `WS_URL` on mount, pipes
events into `sceneStore.applyEvent`, tracks status, and auto-reconnects on
close.

### Top-level types (`frontend/src/types/digitalTwin.ts`)

`SceneObject`, `ComponentItem`, `Asset3D`, `Anchor` (with `connectorType`,
`derivedFromFiberEndpoint`, `derivedFromRfCableEndpoint`), `OpticalLink`,
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

Drop GLB/glTF/STL files under `assets/` and reference them in `assets_3d.file_path`,
e.g. `gltf/my_mount.glb`. FastAPI serves the directory at
`http://localhost:8010/assets/gltf/my_mount.glb`. If no file is present, the
frontend falls back to primitive geometry derived from `component_type` and
`properties`.

For Onshape STEP → STL conversion see `scripts/convert_step_to_stl.py`.
The `backend/scripts/upsert_*.py` files generate catalog rows for specific
parts (BNC adapters, ZHL-1-2W amp, AD9959 chassis, programmable pulse
generator, …).

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

## Phase 2 / roadmap

- **Onshape sync** — placeholder client at
  `backend/app/services/onshape_client.py`. Plan: add metadata-link table +
  `/api/onshape/*` routes once the scene/placement/assets/WS loop is stable.
- **Optics cavity & nonlinear crystal solvers** — module stubs exist
  (`routers/optics_cavity.py`, `routers/optics_crystal.py`, matching solver
  files); fill in Phase D.
- **Palace via SSH** — config exists in `settings`; current EM solver is the
  Phase C.5 mock. See `docs/PHASE_C_WORKSTATION_SETUP.md`.
- **Fiber editor full UX** — splines are first-class (post-0052) but UX for
  multi-segment editing is still rough.

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

### Data / migration hygiene

- **Migrations 0017–0026 are mostly fiber/AOM defaults backfills.** Consider
  squashing pre-V2 (≤ 0026) into a baseline once the production install can
  be reset; alembic history is dense and slow to apply on fresh DBs.
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

### Dev quality of life

- The repo root has dozens of debug PNGs from earlier alignment sessions
  (`ad9959-*`, `sma-*`, `aom-*`, `zhl-*`). They predate the `.gitignore` and
  inflate clones. Either move them under `docs/screenshots/` or delete and
  rely on the ones in `docs/` proper.

---

*Last regenerated: 2026-05-17 (Alembic revision 0054, with fiber
3-object cluster spawn + body cascade in working tree).*
