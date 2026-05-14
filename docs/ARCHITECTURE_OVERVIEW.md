# QMsimulation / qmem-digital-twin — 完整架構統整

> **生成日期**：2026-05-13
> **檔案性質**：top-down 架構說明，從資料庫 → API → 後端 → 前端逐層拆解
> **更深細節**：請見 [`docs/vibe coding.md`](vibe%20coding.md)（1500+ 行 living reference，含 phase history、bug fix 記錄、layer 規則等）

---

## 目錄

1. [專案是什麼](#1-專案是什麼)
2. [技術 stack 與 port 配置](#2-技術-stack-與-port-配置)
3. [核心抽象：三層資料模型](#3-核心抽象三層資料模型)
4. [Multiphysics 模組架構](#4-multiphysics-模組架構)
5. [資料庫層（PostgreSQL）](#5-資料庫層postgresql)
6. [後端（FastAPI）](#6-後端fastapi)
7. [API 層（REST + WebSocket）](#7-api-層rest--websocket)
8. [前端（React + Zustand + Three.js）](#8-前端react--zustand--threejs)
9. [Frame / Unit 慣例](#9-frame--unit-慣例)
10. [ElementKind 物理元件 catalog](#10-elementkind-物理元件-catalog)
11. [Solver 系統](#11-solver-系統)
12. [完整資料流：使用者操作 → 結果](#12-完整資料流使用者操作--結果)
13. [啟動與開發](#13-啟動與開發)

---

## 1. 專案是什麼

**QMsimulation / qmem-digital-twin** 是一套量子記憶體實驗台的 **digital twin（數位孿生）** 平台。把整個光學桌面（laser → TA → HWP → PBS → AOM → 量子記憶體 cell）用 3D 視覺化、ray-tracing、Jones matrix polarization simulation 包成 web app。

**Lab 操作員**可以在瀏覽器：

- 拖物件、看 beam path、切 AOM 階數、調 waveplate 角度
- 即時跑光學模擬（前端 viz + 後端權威 solver）
- 定義 RF / digital trigger 的 timing program（10 ns 解析度，SpinCore-style）

**主要 use cases**：

| Use case | 流程 |
|---|---|
| 設計新光路 | 3D 場景擺元件 → 看 beam 怎麼走 → 看 power 在哪裡分掉 |
| Vendor 套件管理 | 把 Thorlabs / TOPTICA / AA Optoelectronic 的 STL/GLB import → 變可重用 Component |
| Align 模擬 | 元件 snap 到 beam 上 → 自動算 mirror reflection、AOM Bragg 條件 |
| 時序控制 | 定義 RF / digital trigger 的 timing block，10 ns snap |
| 多物理擴展（規劃中） | Ansys Workbench-style：Optics + Electronics (ngspice) + EM (palace FEM) + Magnetics + PulseBlaster |

---

## 2. 技術 stack 與 port 配置

### Stack

| Layer | 技術 |
|---|---|
| 資料庫 | PostgreSQL 16 |
| Migration | Alembic（目前 0001 → 0043）|
| 後端 | Python 3 + FastAPI + SQLAlchemy 2.x async + Pydantic v2 |
| 即時通訊 | WebSocket（FastAPI 內建）|
| 前端框架 | React 18 + TypeScript + Vite |
| 狀態管理 | Zustand |
| 3D 渲染 | Three.js + glTF/GLB asset + primitive geometry fallback |
| HTTP client | Axios |
| CAD 整合 | Onshape metadata sync（reserved for phase 2，client 已 stub）|
| Test | pytest（145 backend）+ vitest（76 frame + 25 AOM physics + …）+ Playwright e2e |

### Ports（docker-compose 與 local 兩套）

| Service | Docker port | Local-postgres port | Notes |
|---|---|---|---|
| PostgreSQL | 5432 (host) | **55432** (host) | local mode 為了不撞主機 postgres |
| Adminer | 8080 | — | DB GUI |
| Backend (uvicorn) | — | **8010** | `--reload` HMR |
| Frontend (Vite) | — | **5173** | HMR via Vite |

API 路徑全部 `http://localhost:8010/api/...`，**不走 Vite proxy**（前端直接打 backend）。

### 目錄佈局

```
qmem-digital-twin/
├── backend/
│   ├── app/
│   │   ├── main.py                FastAPI app + 28 routers 註冊
│   │   ├── db.py                  async engine + AsyncSessionLocal
│   │   ├── config.py              settings (DB URL, CORS, asset root)
│   │   ├── models.py              SQLAlchemy ORM（1021 行）
│   │   ├── schemas.py             Pydantic CamelModel（2594 行）
│   │   ├── crud.py                generic update helpers
│   │   ├── websocket.py           ConnectionManager + broadcast
│   │   ├── assembly_solver.py     約束求解器（face-touch / direction / position）
│   │   ├── timing_program.py      SpinCore 10 ns timing
│   │   ├── v2_bindings.py         legacy kindParams ↔ V2 anchorBindings 轉譯
│   │   ├── uuid7.py               UUIDv7 generator
│   │   ├── routers/               28 個 per-resource REST endpoint
│   │   ├── solvers/               9 個 solver（optics_seq / optics_cavity / spice / em_fem / magnetics_dc / …）
│   │   ├── services/              asset_converter / onshape_client / touchstone / instrument_polling
│   │   └── components/            anchor_contracts.py（per-kind anchor 合約）
│   ├── alembic/versions/          0001 → 0043
│   ├── scripts/seed.py            初始化 component catalog（含 29 條 Thorlabs isolators 等）
│   └── tests/                     145+ tests
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx                root layout + module switcher
│   │   ├── api/client.ts          axios + WS bootstrap（1146 行）
│   │   ├── store/sceneStore.ts    Zustand store（3294 行）
│   │   ├── types/
│   │   │   ├── digitalTwin.ts     全 domain types
│   │   │   ├── units.ts           brand types: Mm / Deg / Frame
│   │   │   └── visibility.ts      collection / view 可見性
│   │   ├── optical/
│   │   │   ├── frames.ts          ⭐ frame/unit conversion 唯一入口
│   │   │   ├── frames.test.ts     76 vitest
│   │   │   ├── kinds/
│   │   │   │   ├── _registry.ts   ⭐ KIND_REGISTRY（每個 kind 的 anchor 合約 + alignSpec）
│   │   │   │   └── aom/physics.ts ⭐ AOM Bragg / η / Bessel 唯一公式源（25 vitest）
│   │   │   └── fiber/             fiber spline + anchor 解析
│   │   ├── three/                 Three.js renderer 端
│   │   │   ├── beamPath.ts / opticalBeams.ts / rayTrace.ts
│   │   │   ├── loadAsset.ts       glTF/STL loader
│   │   │   ├── placement/         placement gizmo
│   │   │   └── photoRoom.ts       房間 / 桌子 / cursor
│   │   ├── utils/                 beam helpers / relation helpers / fiber alignment
│   │   ├── components/            React UI tree（30+ panel/editor 元件）
│   │   │   ├── DigitalTwinViewer.tsx    主 3D viewport
│   │   │   ├── PhyEditor.tsx            PHY layer 子頁面
│   │   │   ├── TimingEditorPanel.tsx    timing 編輯器
│   │   │   ├── optical/                 BeamScopePanel / CursorMenu / OpticalLinkViewerPanel
│   │   │   ├── physics/                 PhysicsElementPanel
│   │   │   └── workspace/               TopBar / ModuleSwitcher / SolverConsole / ScrubTimeBar
│   │   └── modules/               multiphysics 模組 workspace
│   │       ├── _registry.ts             ModuleDef 表
│   │       ├── electronics/             SPICE workspace
│   │       ├── em/                      EM workspace
│   │       ├── magnetics/               磁場 panel
│   │       ├── optics_cavity/           cavity 計算
│   │       └── pulse_blaster/           PB channel binding
│   ├── e2e/                       Playwright
│   └── vite.config.ts
│
├── docs/                          設計文件（這檔的位置）
├── docker-compose.yml             postgres + adminer
├── scripts/                       project-level CLI
└── assets/                        共用 GLB / STL / 圖片
```

---

## 3. 核心抽象：三層資料模型

**這是整個 codebase 最重要的概念，先看懂這個再讀任何 code。**

| Tier | 名稱 | DB table | API path | 一句話 |
|---|---|---|---|---|
| Layer 1 | **Asset3D** | `assets_3d` | `/api/assets` | CAD 檔案層（STL/GLB），含 reusable anchor 幾何 |
| Layer 2 | **Component** | `components` | `/api/components` | Vendor 型號 catalog（"Thorlabs PBS252"、"AOMO 3080"）|
| Layer 3 | **SceneObject** | `objects` | `/api/objects` | 場景上的實際擺位 instance（每個有自己 6-DoF pose）|
| Layer 3+| **PhysicsElement** | `physics_elements` | `/api/physics-elements` | 跟 SceneObject 1:1，存 per-instance transfer / interaction physics（`kind_params` JSONB）|

```
Asset3D (CAD 檔案)
 │  anchors[] — reusable physics interaction geometry
 │  (例：aom_mt80_optical_input、aom_mt80_rf_input)
 ▼
Component (vendor catalog)
 │  asset_3d_id → 連到 Asset3D
 │  component_type ("aom" / "mirror" / "waveplate" / ...)
 │  brand / model / documentation / notes
 ▼
SceneObject (instance)         ◄──1:1──►   PhysicsElement
 │  component_id → 連到 Component             │  element_kind ("aom" / "mirror" / ...)
 │  (x_mm, y_mm, z_mm, rx_deg, ry_deg, rz_deg)  │  kind_params JSONB（per-kind 物理）
 │  properties JSONB                          │  input_ports[] / output_ports[]
 │  (anchorBindings, opticalSources, locked,  │
 │   placedRelativeTo, controlledBy, …)       │
```

**規則**（極重要）：

- **物件移動 / 旋轉只動 SceneObject 的 6 個 Euler 欄位 + properties**
- Component / Asset 是 template，不該因為某個 instance 動了就改
- 同一個 Component 可以 spawn 很多 SceneObject

**歷史命名雷**：

- `objects` 表早期叫 `placements`（≤0008），`name` 欄位叫 `object_name`，alembic 0009 統一改名
- `PhysicsElement` 早期叫 `OpticalElement`（per-component），alembic 0014 改 per-object、0042 改名（為支援 RF / 非光學物理）
- DeviceState / TimingProgram 也是 0015 改 per-object

---

## 4. Multiphysics 模組架構

2026-05-12 拍板的 **Ansys Workbench-style 多物理平台**規劃。Frontend 透過 `TopBar/ModuleSwitcher` 切 module；backend 一個 `SolverRunner` 抽象分派到各 solver。

### Module catalog（`frontend/src/modules/_registry.ts`）

| Module ID | Display | Phase | Status | 描述 |
|---|---|---|---|---|
| `optics_seq` | **Lab** | A | available | 整合式 3D lab workspace —— 所有 device、beam、fiber、magnetics、PB channel 都在這裡。其他模組透過 Linked Schematics 把結果灌回這個 scene |
| `optics_cavity` | **Optics** | A | available | 純 cavity 計算：linear / ring Fabry-Perot、FSR + Finesse + linewidth、Airy spectrum、stability g-parameter |
| `spice` | **Electronics** | B | available | ngspice 電路模擬：netlist (Phase B) 或視覺化 schematic (Phase E)，transient / AC / DC sweep |
| `em_fem` | **EM** | C | available | palace FEM solver：antenna / waveguide / cavity，Gmsh 出 mesh，跑在 lab workstation（SSH）|
| `optics_fdtd` | reserved | D | coming_soon | MEEP / Lumerical-style FDTD |

### SolverRunner 抽象（`backend/app/solvers/runner.py`）

```
SolverRunner (Protocol)
 ├── InProcessRunner       — FastAPI coroutine（Phase A：optics_seq / optics_cavity）
 ├── ContainerRunner       — backend Docker subprocess（Phase B：spice）
 └── SshWorkstationRunner  — SSH to lab workstation（Phase C：em_fem / Phase D：MEEP）
```

**MODULE_DISPATCH** 把 `SimulationModule` enum 對到 solver coroutine：

```python
MODULE_DISPATCH = {
    "optics_seq":     optics_seq.run,
    "optics_cavity":  optics_cavity.run,
    "optics_crystal": optics_crystal.run,
    "spice":          spice.run,
    "em_fem":         em_fem.run,
    "magnetics_dc":   magnetics_dc.run,
}
```

每個 SimulationRun 紀錄：`module`（哪個 solver）+ `runner_kind`（在哪裡跑）+ `revision_id`（基於哪個 scene snapshot）。

---

## 5. 資料庫層（PostgreSQL）

### 5.1 主要 tables

| Table | 主要欄位 | 用途 |
|---|---|---|
| **`assets_3d`** | id, name, asset_type, file_path, unit (`mm`/`m`), scale_factor, **anchors JSONB** | CAD 檔案 + reusable 物理錨點 |
| **`components`** | id, name, component_type, brand, model, asset_3d_id, properties JSONB, physics_capabilities JSONB, notes, archived_at | Vendor catalog |
| **`objects`** | id, component_id, name (UNIQUE), x_mm/y_mm/z_mm, rx_deg/ry_deg/rz_deg, visible, locked, serial_number, **properties JSONB** | 場景 instance |
| **`physics_elements`** | id, object_id (UNIQUE FK), element_kind, **kind_params JSONB**, input_ports[], output_ports[], wavelength_range_nm | Per-instance 物理（1:1 with object）|
| **`connections`** | id, connection_type, from_object_id/from_port, to_object_id/to_port, label, properties | RF / USB / coax cabling |
| **`optical_links`** | id, from_object_id/from_port, to_object_id/to_port, free_space_mm, properties JSONB | Beam graph 邊（UNIQUE on endpoint quad）|
| **`assembly_relations`** | id, name, relation_type, object_a_id/b_id, selector_a/b JSONB, offset_mm, angle_deg, tolerance_mm, enabled, solved | 約束（face-touch / direction / position）|
| **`beam_paths`** | id, name, wavelength_nm, color, source_object_id, target_object_id, points JSONB, visible | Beam trace 結果 |
| **`beam_segments`** | id, simulation_run_id, optical_link_id, sequence_t_ms, beam_index, spectrum/spatial_x/y/transverse_mode/polarization_jones JSONB, power_mw, propagation_axis_local | Solver 輸出 per-segment 狀態 |
| **`device_states`** | object_id (PK), state JSONB | Runtime hot state（RF on/off, lock, temp）|
| **`timing_programs`** | object_id (PK), name, spin_core_start, duration_ns, properties | Per-object timing program |
| **`timing_blocks`** | id, program_object_id, t_start_ns, t_end_ns, waveform_kind, params, sort_order | 單一 timing block（10 ns snap）|
| **`revisions`** | id, label, snapshot JSONB, scene_hash | Scene input snapshot |
| **`simulation_runs`** | id, revision_id, solver_version, status, scene_hash, module, runner_kind, params, progress, result_summary, result_blob_path, started_at, finished_at | Solver execution 紀錄 |
| **`scene_views`** | id, name, filter_kind, filter_expr JSONB, overlay_overrides, is_default, is_pinned, sort_order | Outliner saved-view |
| **`collections`** | id, name, parent_id, color, visible, **rigid_transform**, sort_order, properties | Outliner 樹狀組織 |
| **`collection_members`** | collection_id + object_id (PK), sort_order, added_at | UNIQUE on object（每 object 只屬一個 collection 家）|
| **`scene_view_collection_overrides`** | scene_view_id + collection_id (PK), visible | Sparse per-view 可見性 override |
| **`app_settings`** | key (PK), value JSONB | Lab-global 設定（如 `room_dimensions`）|
| **`circuits`** | id, scene_object_id?, name, netlist, schematic JSONB | Phase B：SPICE netlist |
| **`coils`** | id, scene_object_id?, name, shape, params, current_a | Phase F+：磁場 coil |
| **`magnetics_problems`** | id, name, coil_ids[], eval_region | 磁場分析問題定義 |
| **`meshes`** | id, source_asset_3d_id?, name, mesh_format, file_path, element_count, max_size_mm, file_size_bytes | Phase C：Gmsh mesh |
| **`em_problems`** | id, scene_object_id?, mesh_id?, name, ports[], boundary_conditions, freq_range_ghz | Phase C：EM 分析 |
| **`pulse_blaster_channels`** | id, channel_index, label, target_component_id?, invert, enabled | PB TTL channel ↔ Component 綁定 |
| **`rf_chain_nodes`** | id, terminal_scene_object_id, position_in_chain, node_kind, label, gain_db, kind_params, linked_circuit_id?, linked_em_problem_id? | Phase RF.2：RF driver chain |

### 5.2 關鍵 invariant

- **UUIDv7 everywhere**：所有 PK 都用 UUIDv7（透過 `gen_random_uuid()` server default + `uuid7.py` 應用層）
- **CamelModel + alias_generator**：DB 用 snake_case，API 對外 camelCase（`populate_by_name=True` 接受兩種輸入）
- **JSONB 隨身欄**：所有可擴展的 per-instance / per-kind 資料都在 JSONB（`properties`、`kind_params`、`state`、`anchors`、`selector_a/b`），避免頻繁 migration
- **Cascade rules**：
  - `objects → physics_elements`：CASCADE
  - `objects → device_states / timing_programs`：CASCADE
  - `objects → beam_paths.source_object_id / target_object_id`：SET NULL（beam 比 endpoint 久）
  - `objects → optical_links`：CASCADE
  - `collections → collections.parent_id`：CASCADE（樹狀）

### 5.3 Alembic migration history（重點 milestone）

| ID | 標題 | 內容 |
|---|---|---|
| 0001 | initial | placements / components / assets table |
| 0002-0013 | 中間迭代 | optical_domain / archive / collection / timing / no_self_loop |
| **0009** | rename_objects | placements → objects、object_name → name |
| **0014** | per_obj_optical | OpticalElement 從 per-component 改 per-instance |
| **0015** | per_obj_state_serial | DeviceState / TimingProgram / BeamPath endpoint 全 per-instance |
| **0016** | unique_object_home | 每 object 只屬一個 collection |
| **0017** | fix_aom_glb_unit | AOM GLB 從 mm 改 m |
| **0018** | normalize_asset_anchors | Phase 4：`localPosition` → `positionMmBodyLocal` |
| **0019** | normalize_kindparams | Phase 5：加 frame suffix |
| **0020** | norm_comp_props | Phase 6：Component.properties 命名統一 |
| **0021** | aom_default_anchors | Phase 7：AOM 補 `intercept_in` / `intercept_out` |
| **0022-0026** | fiber 系列 | fiber radius、fiber anchors backfill |
| **0027** | v2_phase1_baseline | V2：SimulationRun + BeamSegment.simulation_run_id FK |
| **0028-0034** | V2 cutover 系列 | mirror / laser / waveplate / polarizer / lens / beam_splitter / aom / isolator 改 anchorBinding |
| **0035** | collection_rigid | 加 `rigid_transform`、清掉沒在用的 boolean flags |
| **0036** | simulation_runs_multiphysics | 加 `module` / `runner_kind` / `params` / `progress` / `result_*` |
| **0037** | circuits | Phase B：SPICE netlist table |
| **0038** | em_problems_meshes | Phase C：EM problem + Mesh |
| **0039** | coils_magnetics | Phase F：磁場 |
| **0040** | pulse_blaster_channels | PB 24-channel binding |
| **0041** | rf_chain_nodes | Phase RF.2：RF driver chain |
| **0042** | rename_optical_elements | OpticalElement → PhysicsElement |
| **0043** | app_settings | Lab-global settings（`room_dimensions`）|

> Alembic `version_num` 欄位是 VARCHAR(32)，新 migration revision id 不超過此長度。

---

## 6. 後端（FastAPI）

### 6.1 App 初始化（`backend/app/main.py`）

```python
app = FastAPI(title="Quantum Memory Digital Twin API")

# CORS
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, ...)

# Static asset 服務 (GLB / STL)
app.mount("/assets", StaticFiles(directory=str(settings.asset_root)), name="assets")

# 28 個 router 全部以 /api/<resource> 註冊
app.include_router(assets.router,             prefix="/api/assets")
app.include_router(components.router,         prefix="/api/components")
app.include_router(objects.router,            prefix="/api/objects")
app.include_router(connections.router,        prefix="/api/connections")
app.include_router(assembly_relations.router, prefix="/api/assembly-relations")
app.include_router(beam_paths.router,         prefix="/api/beam-paths")
app.include_router(device_states.router,      prefix="/api/device-states")
app.include_router(physics_elements.router,   prefix="/api/physics-elements")
app.include_router(optical_links.router,      prefix="/api/optical-links")
app.include_router(simulations.router,        prefix="/api/simulations")
app.include_router(simulation_runs.router,    prefix="/api/simulation-runs")
app.include_router(circuits.router,           prefix="/api/circuits")
app.include_router(touchstone.router,         prefix="/api/touchstone")
app.include_router(meshes.router,             prefix="/api/meshes")
app.include_router(em_problems.router,        prefix="/api/em-problems")
app.include_router(coils.router,              prefix="/api/coils")
app.include_router(magnetics_problems.router, prefix="/api/magnetics-problems")
app.include_router(pulse_blaster.router,      prefix="/api/pulse-blaster")
app.include_router(rf_chains.router,          prefix="/api/rf-chains")
app.include_router(optics_cavity.router,      prefix="/api/optics-cavity")
app.include_router(optics_crystal.router,     prefix="/api/optics-crystal")
app.include_router(revisions.router,          prefix="/api/revisions")
app.include_router(scene_views.router,        prefix="/api/scene-views")
app.include_router(collections.router,        prefix="/api/collections")
app.include_router(timing_programs.router,    prefix="/api/timing-programs")
app.include_router(app_settings.router,       prefix="/api/app-settings")
app.include_router(scene.router,              prefix="/api")           # /api/scene full snapshot
app.include_router(websocket_router,          prefix="/ws")            # /ws/scene

@app.on_event("startup")
async def _ensure_master_collection():
    # 啟動時保證 Master Collection 存在
    ...
```

### 6.2 Models（SQLAlchemy 2.x async）

`backend/app/models.py` (1021 行) 用 SQLAlchemy 2.x 的新式 `Mapped[...]` / `mapped_column(...)` 寫法：

```python
class SceneObject(Base):
    __tablename__ = "objects"
    __table_args__ = (UniqueConstraint("name", name="uq_objects_name"),)

    id:           Mapped[uuid.UUID] = mapped_column(PG_UUID, primary_key=True, ...)
    component_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("components.id", ondelete="CASCADE"))
    x_mm:         Mapped[float]     = mapped_column(Float, default=0)
    # ... + relationship() 連到 PhysicsElement / DeviceState / TimingProgram (1:1)
```

連線是 **async**：`db.py` 提供 `AsyncSessionLocal` + `get_session()` dependency。

### 6.3 Schemas（Pydantic v2，`backend/app/schemas.py`）

全用 `CamelModel` base class：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,    # snake_case ↔ camelCase
        from_attributes=True,        # 接 ORM row
        populate_by_name=True,       # accept both keys
    )
```

**Per-kind discriminated union**（OpticalElement.kindParams）：`MirrorParams`、`AOMParams`、`WaveplateParams`、`PolarizerParams`、`BeamSplitterParams`、`DichroicMirrorParams`、`FiberCouplerParams`、`IsolatorParams`、`LensSphericalParams`、`LensCylindricalParams`、`LaserSourceParams`、`EOMParams`、`NonlinearCrystalParams`、`SaturableAbsorberParams`、`TaperedAmplifierParams`、`DetectorParams`、`CameraParams`、`SpectrometerParams`、`WavemeterParams`、`BeamDumpParams`。

**Legacy compatibility helper**：

```python
def _accept_legacy_keys(data, renames: tuple[tuple[str, str], ...]):
    # 用在 model_validator(mode="before")，輸入接受 legacy + 新名
```

### 6.4 Routers（28 個）

| Router | 範圍 |
|---|---|
| `assets.py` | Asset3D CRUD + GLB/STL 上傳 |
| `components.py` | Component catalog CRUD + auto-register optical |
| `objects.py` | SceneObject CRUD + by-component upsert |
| `connections.py` | RF/cable connections |
| `assembly_relations.py` | 約束建立 / apply / 求解 |
| `beam_paths.py` | Beam path CRUD |
| `device_states.py` | Runtime state per-object |
| `physics_elements.py` | PhysicsElement CRUD |
| `optical_links.py` | Beam graph edges |
| `simulations.py` / `simulation_runs.py` | Solver dispatch + status |
| `circuits.py` | SPICE netlist CRUD |
| `touchstone.py` | S-parameter file upload / parse |
| `meshes.py` | Gmsh mesh upload + metadata |
| `em_problems.py` | EM analysis problem CRUD |
| `coils.py` / `magnetics_problems.py` | 磁場 |
| `pulse_blaster.py` | PB channel binding |
| `rf_chains.py` | RF driver chain |
| `optics_cavity.py` / `optics_crystal.py` | 純光學計算（不需 scene）|
| `revisions.py` | Scene snapshot |
| `scene_views.py` / `collections.py` | Outliner |
| `timing_programs.py` | Timing program + blocks |
| `app_settings.py` | Lab-global settings |
| `scene.py` | **`GET /api/scene`** 一次撈整 scene（含 v2 → legacy translator）|

### 6.5 Services

| Service | 用途 |
|---|---|
| `asset_converter.py` | GLB/STL/STEP 轉換、scale fix |
| `onshape_client.py` | Onshape 整合 stub（Phase 2 reserved）|
| `touchstone.py` | Touchstone (.sNp) 解析 |
| `instrument_polling.py` | Polling 實驗儀器狀態 |

### 6.6 Solvers

```
backend/app/solvers/
├── optical_solver.py   ⭐ 後端權威 Jones matrix solver（per-segment 狀態）
├── optics_seq.py       sequential ray-tracing pipeline
├── optics_cavity.py    Linear / ring Fabry-Perot：FSR/F/linewidth/Airy/g-param
├── optics_crystal.py   非線性晶體 / cavity
├── spice.py            ngspice wrapper（Phase B）
├── em_fem.py           palace FEM wrapper（Phase C，mock until SSH up）
├── magnetics_dc.py     magpylib Biot-Savart（Phase F+）
├── spinapi_compile.py  SpinCore timing → binary
├── palace_io.py        palace input/output 解析
└── runner.py           ⭐ SolverRunner Protocol + MODULE_DISPATCH
```

### 6.7 WebSocket（`websocket.py`）

非常輕：一個 `ConnectionManager`，accept 連線後接 `ping/pong`，server 主動 `broadcast(event_type, payload)` 給所有 active connections。

```python
class ConnectionManager:
    async def connect(self, ws):    ...
    def disconnect(self, ws):       ...
    async def broadcast(self, event_type, payload):
        event = {"type": event_type, "payload": payload}
        for ws in self.active_connections:
            await ws.send_json(event)
```

每個 router 在改 DB 後呼叫 `manager.broadcast(...)`，前端 sceneStore 的 `applyEvent` reducer 收到後 patch local state。

---

## 7. API 層（REST + WebSocket）

### 7.1 REST endpoints（精選，完整看 `/docs` Swagger UI）

#### Scene 完整快照

```
GET    /api/scene                       一次撈所有 assets/components/objects/relations/...
GET    /api/health
```

#### Asset / Component / Object 三層

```
GET    /api/assets                      list
POST   /api/assets                      create（含 GLB/STL 上傳）
GET    /api/assets/{id}
PUT    /api/assets/{id}                 改 anchors 等
DELETE /api/assets/{id}

GET    /api/components                  catalog list
POST   /api/components
PUT    /api/components/{id}
DELETE /api/components/{id}

GET    /api/objects                     instance list
POST   /api/objects                     新增 instance
PUT    /api/objects/{id}                改 pose / properties
PUT    /api/objects/by-component/{cid}  upsert instance for component
DELETE /api/objects/{id}
```

#### Optical pipeline

```
GET|POST|PUT|DELETE  /api/physics-elements
GET|POST|DELETE      /api/optical-links
GET|POST|PUT|DELETE  /api/beam-paths
GET|PUT              /api/device-states[/{object_id}]
POST                 /api/simulations/run             trigger solver
POST                 /api/simulation-runs             create + dispatch
GET                  /api/simulation-runs/{id}        poll status
```

#### Assembly / Constraints

```
GET|POST|PUT|DELETE  /api/assembly-relations
POST                 /api/assembly-relations/{id}/apply-once
```

#### Multiphysics 模組

```
GET|POST|PUT|DELETE  /api/circuits                    SPICE netlist
GET|POST|PUT|DELETE  /api/em-problems
GET|POST             /api/meshes                      upload Gmsh
GET|POST|PUT|DELETE  /api/coils
GET|POST|PUT|DELETE  /api/magnetics-problems
GET|POST|PUT|DELETE  /api/pulse-blaster/channels
GET|POST|PUT|DELETE  /api/rf-chains/nodes
POST                 /api/optics-cavity/compute       FSR/Finesse/Airy
POST                 /api/optics-crystal/compute
POST                 /api/touchstone/parse
```

#### Organization

```
GET|POST|PUT|DELETE  /api/collections
POST                 /api/collections/{id}/members
DELETE               /api/collections/{cid}/members/{oid}
GET|POST|PUT|DELETE  /api/scene-views
GET|POST|PUT|DELETE  /api/timing-programs[/{object_id}]
GET|POST             /api/revisions
GET|PUT              /api/app-settings/{key}          room_dimensions 等
```

#### Static

```
GET                  /assets/gltf/<file>              GLB/glTF 服務
GET                  /docs                            OpenAPI Swagger UI
```

### 7.2 WebSocket（`ws://localhost:8010/ws/scene`）

**Server → Client events**（前端 `applyEvent` reducer 處理）：

| Event type | Payload |
|---|---|
| `scene.connected` | `{}` |
| `scene.reload` | 強制重撈整 scene |
| `component.created` / `updated` / `deleted` | `{ component }` |
| `object.created` / `updated` / `deleted` | `{ object }` |
| `placement.updated` | (legacy alias) |
| `connection.updated` | `{ connection }` |
| `assembly_relation.updated` | `{ relation }` |
| `beam_path.updated` | `{ beamPath }` |
| `device_state.updated` | `{ state }` |
| `physics_element.updated` | `{ element }` |
| `optical_link.updated` | `{ link }` |
| `timing_program.updated` | `{ program }` |
| `simulation_run.status_changed` | `{ run }` |
| `pong` | response to `ping` |

**Client → Server**：只接 `{"type": "ping"}` keepalive。其他操作走 REST。

---

## 8. 前端（React + Zustand + Three.js）

### 8.1 入口 `App.tsx`

```
<WorkspaceProvider>
  <main class="workspace-shell">
    <TopBar>
      <SceneToolbar />            // Lab tab only：Initial Setup / overlays / dual viewport
    </TopBar>

    <div class="workspace-canvas">
      // 依 currentModule 切：
      // optics_seq    → DualViewerSplit + 一堆 floating panels
      // optics_cavity → OpticsHost
      // spice         → ElectronicsWorkspace
      // em_fem        → EmWorkspace
      // 其他          → ModulePlaceholder

      <SolverConsole />           // 跨 module 共用
    </div>
  </main>
</WorkspaceProvider>
```

PHY Editor 是 **整頁 take-over**（`editorMode === "phy-editor"`），跑完按 Back 才回 scene。

### 8.2 Zustand store（`store/sceneStore.ts`，3294 行）

唯一的 state container，把所有：

- Scene 資料（assets / components / objects / relations / links / paths / segments / views / collections）
- 選取狀態（selectedComponentId / selectedObjectId / selectedObjectIds[] / selectedRelationId）
- UI 模式（editorMode / currentModule / phyEditorView / phyEditorDirty）
- Overlay flags（components / connections / assembly_relations / optical_links / beam_segments / beam_paths）
- Session visibility（hidden / solo / forceVisible，含 collection cascade）
- Transform pivot（per-panel cursor mm，localStorage 持久）
- Preview transforms（拖物件時的 optimistic）
- WebSocket status
- Module-specific cache（circuits / emProblems / meshes / pulseBlasterChannels / rfChains / recentSimulationRuns）
- Scrub time（`scrubTimeNs`，timing 重播游標）

都丟進一個 store。重要 helper：

- `loadScene()` / `loadCircuits()` / `loadEmProblems()` / `loadMeshes()` / `loadPulseBlasterChannels()` / `loadRfChains()` —— 初始 / 重新拉
- `applyEvent(SceneEvent)` —— WS event reducer
- `selectComponent(id)` / `selectObject(id, opts)` —— 選取（decoupled with visibility）
- `setPreviewObjectTransform(id, patch)` —— 拖拽預覽（不寫 DB）
- `updateSceneObject(id, patch)` / `createObject()` / `deleteObject()` —— 走 API + WS sync
- `toggleOverlayFlag()` / `resetOverlayFlags()` / `toggleSoloObject()` / `toggleSessionHiddenObject()` —— UI 可見性
- `dispatchSimulationRun(payload)` —— Solver trigger

**LocalStorage 持久化的 key**：

- `qmem.transformCursorMm.v2` — 雙 panel cursor
- `qmem.transformCursorHidden.v1`
- `qmem.outliner.activeCollectionId`
- `qmem.overlayFlags.v1`
- `qmem.activeViewId`

### 8.3 三大子系統

#### A. React UI tree（`components/`）

| 元件 | 角色 |
|---|---|
| `DigitalTwinViewer.tsx` | 主 3D viewport（Three.js mount）—— on-demand rendering + wrapper cache，58 顆 STL 不 re-parse |
| `DualViewerSplit.tsx` | 左右兩個 viewport，獨立 camera + cursor |
| `ComponentPanel.tsx` | 選到 component / object 時的右側 inspector |
| `OpticalElementPanel.tsx` 等 | Per-kind 編輯 panel（AOM controls / Mirror UV / Waveplate fast-axis）|
| `ComponentsCatalogPanel` / `OutlinerFloatingPanel` | 左側 catalog + outliner 樹 |
| `TimingEditorPanel.tsx` | SpinCore timing block 編輯 |
| `OpticalLinkViewerPanel.tsx` / `BeamScopePanel.tsx` | Beam graph / 段 inspector |
| `TouchCoincidencePanel.tsx` | V·V / V·E / V·F / E·E / E·F / F·F 6 種 touch ops |
| `PhyEditor.tsx` | 整頁 PHY layer 編輯（asset anchors / optical kinds）|
| `OpticalKindsEditor.tsx` / `OpticalComponentEditor.tsx` | PHY Editor 子頁 |
| `SceneToolbar.tsx` | Initial Setup / Display overlays / Scene-view picker / dual-viewport toggle |
| `workspace/TopBar` + `ModuleSwitcher` | 切 module |
| `workspace/SolverConsole` | 跑 solver 的 console |
| `workspace/ScrubTimeBar` | Timing 重播游標 |
| `optical/CursorMenu` | 右鍵選單 |
| `modules/*/Workspace.tsx` | 各 module 主畫面 |

#### B. Three.js renderer（`three/`）

| 模組 | 角色 |
|---|---|
| `loadAsset.ts` | glTF/STL loader + primitive fallback |
| `beamPath.ts` / `opticalBeams.ts` | Beam line rendering |
| `rayTrace.ts` | 前端即時 ray tracer（拖物件就重 trace；跟 backend solver 邏輯**鏡像**但不完全相同）|
| `placement/` | 移動 / 旋轉 gizmo |
| `tableGrid.ts` / `photoRoom.ts` | 桌面 grid + 房間 |
| `transformUtils.ts` | three ↔ lab 矩陣轉換（一律走 `frames.ts`）|
| `rfBadge.ts` / `hornFarfield.ts` / `emissionVisuals.ts` | RF / 天線 / emitter 視覺化 |

#### C. Optical 物理 model（`optical/`）

| 檔 | 角色 |
|---|---|
| **`frames.ts`** | ⭐ Frame/unit conversion 唯一入口（見 §9）|
| `frames.test.ts` | 76 個 vitest regression test |
| **`kinds/_registry.ts`** | ⭐ `KIND_REGISTRY`：每個 ElementKind 的 anchor 合約、alignSpec、displayName |
| `kinds/aom/physics.ts` | ⭐ AOM Bragg / η / Bessel sideband 唯一公式源（25 vitest）|
| `fiber/` | Fiber spline + anchor 解析 |

### 8.4 API client（`api/client.ts`，1146 行）

Axios + 一堆 typed wrapper：

```ts
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8010";
export const WS_URL       = import.meta.env.VITE_WS_URL ?? `${API_BASE_URL.replace(/^http/, "ws")}/ws/scene`;

export const client = axios.create({ baseURL: API_BASE_URL, timeout: 12000 });

// ~100 個 typed function：
export async function fetchScene(): Promise<SceneData>
export async function createObjectApi(payload): Promise<SceneObject>
export async function updateObjectApi(objectId, patch): Promise<SceneObject>
export async function createOpticalLinkApi(payload): Promise<OpticalLink>
export async function dispatchSimulationRunApi(payload): Promise<SimulationRunV2>
// ... etc
```

每個 wrapper 處理 `AxiosError.response.data.detail`（Pydantic validation 的陣列 / 字串都 normalize 成可讀錯誤訊息）。

---

## 9. Frame / Unit 慣例

**這是 Phase 1-6 的核心 invariant，整個 codebase 嚴守。**

### 9.1 四種 frame

| 簡稱 | 軸向 | 單位 | 用途 |
|---|---|---|---|
| **Lab** | Z-up（X right, Y forward, Z up）| mm | SceneObject 位置、cursor、ray 端點 |
| **BodyLocal** | Z-up（跟 Lab 同軸向） | mm | Anchor 位置、向量在物體 local 表達 |
| **BeamLocal** | +z 沿 beam 方向 | dimensionless | Jones matrix 角度（fast axis）|
| **Three** | Y-up | three units（mm/100）| 只在 `frames.ts` + Three.js renderer 內部 |

**關鍵 invariant**：BodyLocal 跟 Lab **同軸向慣例** → BodyLocal → Lab 只要 SceneObject quaternion 旋轉，**不需 axis swap**。Three frame 只是 render 中介。

### 9.2 唯一 conversion 入口（`frames.ts`）

```ts
MM_PER_THREE_UNIT = 100;            // 唯一定義點

mmToThree(v): number
threeToMm(v): number

labMmToThree({xMm,yMm,zMm}): THREE.Vector3
threeToLabMm(v): {xMm,yMm,zMm}

labDirToThree(d): THREE.Vector3            // 純 axis swap，no scaling
threeDirToLab(v): {x,y,z}

bodyLocalDirToThree(d): THREE.Vector3
bodyLocalDirToWorldThree(d, sceneObject): THREE.Vector3   // axis swap + quaternion
bodyLocalDirToLabDir(d, sceneObject): {x,y,z}

sceneObjectToQuaternion(sceneObject): THREE.Quaternion    // ⭐ SINGLE SOURCE OF TRUTH
applySceneObjectRotationThree(vThree, sceneObject): THREE.Vector3
rotateLabDir(dLab, sceneObject): {x,y,z}
```

**禁止**：在 codebase 其他地方手寫 `(x, z, -y)` axis swap 或 `* 100 / 100`。Phase 3 修過一個 silent bug——兩個 caller 用不同 Euler order，多軸旋轉時 anchor 算出來的 lab 位置跟畫面顯示偏到 37%。現在保證 1e-9 精度。

### 9.3 命名 suffix 強制

帶 frame / unit 語意的欄位必須標示：

| Suffix | 用法 | 例 |
|---|---|---|
| `_Mm` | mm 純量 | `crystalLengthMm` |
| `_Deg` | degrees | `rxDeg`、`fastAxisDegBeamLocal` |
| `_Mrad` | milliradians | `braggAngularAcceptanceMrad` |
| `_Nm` | nanometers | `centerWavelengthNm` |
| `_MHz`/`_GHz`/`_W`/`_Mw`/`_Ns`/`_Ps` | 物理單位 | `centerFreqMhz` |
| `_Lab` | Lab Z-up frame | `braggTiltAxisDegLab` |
| `_BodyLocal` | Body Z-up frame | `surfaceNormalBodyLocal` |
| `_BeamLocal` | Beam frame | `fastAxisDegBeamLocal` |

**禁止**含糊的 `*Local`（沒指明哪個 frame）。

### 9.4 Brand types（compile-time 防呆，`src/types/units.ts`）

```ts
type Mm  = Brand<number, "Mm">;
type Deg = Brand<number, "Deg">;
type Frame = "Lab" | "BodyLocal" | "BeamLocal" | "Three";
type PositionMm<F extends Frame>  = { __frame: F; xMm: Mm; yMm: Mm; zMm: Mm };
type Direction<F extends Frame>   = { __frame: F; x: number; y: number; z: number };

asMm(v: number): Mm                  // boundary escape hatch
mm(v: Mm): number                    // unwrap
```

---

## 10. ElementKind 物理元件 catalog

每個 SceneObject 透過 1:1 的 `PhysicsElement.element_kind` 決定它是哪種光學 / RF 元件。`KIND_REGISTRY` 在 `frontend/src/kinds/_registry.ts` 定義每個 kind 的 anchor 合約 + alignSpec。

### Active emitters

| Kind | 主要 params | 備註 |
|---|---|---|
| `laser_source` | V2：source 在 `objects.properties.opticalSources[].beam`（carrier.wavelengthNm / powerMw / spectrum / polarization / spatialEnvelope / transverseMode）| 光源；不放 kindParams |
| `tapered_amplifier` | `centerWavelengthNm`、`driveCurrentMa`、`aseSamples[]`、`gainSamples[]` 2D 表 | BoosTA pro |

### Passive optics

| Kind | 主要 params | Align 規則 |
|---|---|---|
| `mirror` / `dichroic_mirror` | `reflectivity`、`surfaceNormalBodyLocal` | translate face-center → beam（25 mm tol）+ U/V slider 微調 |
| `lens_spherical` / `lens_cylindrical` | `focalMm`、`numericalAperture`、`transmission`、`gvdFs2` | translate intercept_in → beam |
| `waveplate` | `retardanceLambda` (0.5=HWP, 0.25=QWP)、`fastAxisDegBeamLocal` | translate + 繞 beam axis 轉 |
| `polarizer` | `transmissionAxisDegBeamLocal`、`extinctionRatioDb`、`transmission` | translate |
| `beam_splitter`（含 PBS）| `splitRatioTransmitted`、`polarizing`、`coatingNormalBodyLocal` | translate |
| `fiber_coupler` | `couplingEfficiency`、`modeFieldDiameterUm`、`fiberType` | translate |
| `fiber` | 整條 patch cable（雙向）：`fiberType`、`endA/endB` connectorSpec、`attenuationCurve[]`、`bendLoss`、PM/SM/MM 屬性 | 自定 spline align（投影光學 port 到 beam，反推 spline node）|
| `isolator` | `forwardLossDb`、`isolationDb`、`transmissionAxisDegBeamLocal` | translate；catalog 帶 per-template override |

### Active / nonlinear

| Kind | 主要 params | Align |
|---|---|---|
| `aom` | `centerFreqMhz`、`refractiveIndex`、`crystalLengthMm`、`acousticBeamWidthMm`、`rfDrivePowerW`、`acousticAxisBodyLocal`、`rfPropagationDirectionBodyLocal`、`diffractionOrder`、`maxDiffractionOrder`、`braggAngularAcceptanceMrad`、optional `braggInteractionPointMmBodyLocal` | ⭐ Phase 7.4 兩階段重寫：Stage 1 snap optical axis (D1) ∥ beam（upright/min-rot/keep-d2 三模）；Stage 2 繞 D3 轉 ω = −traversalSign·arcsin(expectedInputDotD2) 滿足 Bragg。entry 從 (intercept_in, intercept_out) 兩 anchor 算 perpendicular miss 取小（ambiguous 時 abort）|
| `eom` | `vPiV`、`modulationKind: "phase"\|"amplitude"`、`modulationBandwidthMhz`、`insertionLossDb` | translate |
| `nonlinear_crystal` | `process: "SHG"\|"SFG"\|"DFG"\|"OPO"`、`chi2PmPerV`、`lengthMm`、phase match | translate |
| `saturable_absorber` | `saturationIntensityWPerCm2`、`modulationDepth`、`recoveryTimePs` | translate |

### Sinks

| Kind | 主要 params |
|---|---|
| `detector` | `responsivityAPerW`、`quantumEfficiency`、`bandwidthMhz` |
| `camera` | `resolutionPx: [w,h]`、`pixelSizeUm`、`quantumEfficiency` |
| `spectrometer` | `resolutionPm`、`wavelengthRangeNm: [lo,hi]` |
| `wavemeter` | `precisionMhz` |
| `beam_dump` | `absorption` |

### KIND_REGISTRY 合約欄位

```ts
type KindContract = {
  requiredAnchors:          string[];   // 必要 anchor id（例 ["intercept_in", "intercept_out"]）
  anchorsNeedingDirection:  string[];   // 必要 directionBodyLocal 的 anchor
  anchorsNeedingAperture:   string[];   // 必要 apertureMm 的 anchor
  alignVariant:             "snap-translate" | "aom-stage2" | "fiber-spline" | "none";
  displayName:              string;
};
```

PHY Editor 用這個 contract 在 Save 時 validate。Align 也用同一個 contract 在 runtime validate。

---

## 11. Solver 系統

### 11.1 雙 solver 架構（光學）

```
                ┌──────────────────────────────────────┐
                │  Backend: optical_solver.py          │
                │  ────────────────────────────         │
                │  - Run Solver 按鈕 → 跑這個          │
                │  - Authoritative Jones matrix         │
                │  - 寫入 beam_segments table           │
                │  - 結果 broadcast via WS              │
                └──────────────────────────────────────┘

                ┌──────────────────────────────────────┐
                │  Frontend: rayTrace.ts               │
                │  ────────────────────────────         │
                │  - 拖物件時即時重 trace               │
                │  - 視覺化版本（不寫 DB）              │
                │  - 邏輯跟 backend solver 鏡像但不全同 │
                │  - 用同一組 Jones matrix              │
                └──────────────────────────────────────┘
```

**Phase 7 之後**：物理公式（Bragg θ、η、Bessel J_n、phase mod depth、sideband 強度）從 `rayTrace.ts` + `OpticalElementPanel.tsx` 抽進 `frontend/src/optical/kinds/<kind>/physics.ts` 純函數模組。**單一 source**。AOM 已抽完（25 vitest 守住）；其他 kind 待逐步搬。

長期目標：`rayTrace.ts` 跟 `optical_solver.py` 萎縮成 dispatcher，每個 kind 自己的 physics 模組是唯一公式源，frontend / backend 用 parity test 守住一致。

### 11.2 SolverRunner 抽象（multiphysics）

```python
# backend/app/solvers/runner.py

class SolverRunner(Protocol):
    async def submit(self, sim_run: SimulationRun, callable: SolverCallable) -> None: ...

# 三種實作：
# - InProcessRunner    : FastAPI 內 await（Phase A）
# - ContainerRunner    : backend Docker subprocess（Phase B）
# - SshWorkstationRunner: SSH 到 lab workstation（Phase C+）

MODULE_DISPATCH: dict[SimulationModule, SolverCallable] = {
    "optics_seq":     optics_seq.run,
    "optics_cavity":  optics_cavity.run,
    "optics_crystal": optics_crystal.run,
    "spice":          spice.run,
    "em_fem":         em_fem.run,
    "magnetics_dc":   magnetics_dc.run,
}

MODULE_DEFAULT_RUNNER: dict[SimulationModule, str] = {
    "optics_seq":     "inproc",
    "optics_cavity":  "inproc",
    "spice":          "inproc",
    "em_fem":         "inproc",
    "magnetics_dc":   "inproc",
}
```

每次 `POST /api/simulation-runs` 流程：

1. Snapshot 目前 scene 成新 `Revision`（含 `scene_hash`）
2. 若舊 SimulationRun 的 `scene_hash` 一樣，reuse `beam_segments`（不重跑）
3. 否則建 `SimulationRun` row（`status=queued`、`module`、`runner_kind`、`params`）
4. Runner pickup → 跑 solver coroutine → 寫 `beam_segments` + `result_summary` / `result_blob_path`
5. `status` → `running` → `completed`/`failed`/`cancelled`
6. 每次 status 改變 broadcast WS event `simulation_run.status_changed`

---

## 12. 完整資料流：使用者操作 → 結果

### 場景 A：使用者拖一顆 mirror

```
1. Three.js gizmo onDrag → store.setPreviewObjectTransform(id, {xMm, yMm, zMm})
   └─ 只寫 store.previewObjectTransforms（optimistic、不寫 DB、不送 WS）

2. rayTrace.ts useEffect 偵測到 preview transform 改 →
   重 trace beam（前端視覺化，60 fps 內完成）→
   觸發 DigitalTwinViewer requestRender

3. onDragEnd → store.updateSceneObject(id, patch) →
   PUT /api/objects/{id}                       ← REST 寫 DB

4. Backend objects.py router：
   - UPDATE objects SET x_mm=..., y_mm=..., z_mm=... WHERE id=...
   - await session.commit()
   - manager.broadcast("object.updated", {object})  ← WS 廣播

5. 所有連線中的 client（含發起的這個）收到 WS event：
   └─ store.applyEvent({type:"object.updated", payload}) →
      reducer 把 scene.objects[i] 換成新 row →
      清掉對應的 previewObjectTransforms[i]

6. React re-render → DigitalTwinViewer 從 store 拿新 sceneData →
   useEffect dep 變動 → 但 objectWrappersRef cache hit
   （component/asset/deviceState ref 都沒變）→
   只 strip-and-rebuild decoration + apply new transform →
   不重 parse STL
```

### 場景 B：使用者點 Run Solver

```
1. SolverConsole 「Run」按鈕 → store.dispatchSimulationRun({module: "optics_seq", ...})
2. POST /api/simulation-runs   ← REST
3. Backend：
   a. snapshot 目前 scene state → 算 scene_hash
   b. 若有舊 Run 同 hash → return 舊 Run（reuse beam_segments）
   c. 否則建 Revision + SimulationRun row（status=queued）
   d. 把 callable 丟給 InProcessRunner → background task
   e. immediate return new Run（status=queued）→ broadcast simulation_run.status_changed
4. Background task：
   a. status=running → broadcast
   b. 跑 optics_seq.run() → 寫 beam_segments
   c. status=completed + result_summary → broadcast
5. Frontend SolverConsole 收到 status_changed event → 更新 recentSimulationRuns
6. 若 status=completed → 自動 fetch beam_segments → DigitalTwinViewer 畫出最終 beam
```

### 場景 C：使用者按 PhyEditor 改 Asset anchor

```
1. App.tsx 偵測 editorMode === "phy-editor" → 整頁切到 <PhyEditor />
2. PhyEditor 子頁 → OpticalComponentEditor → 改 anchor 草稿
3. store.phyEditorDirty = true
4. Save → store.updateAssetAnchors(assetId, anchors) → PUT /api/assets/{id}
5. Backend：
   - UPDATE assets_3d SET anchors=... WHERE id=...
   - 不直接 broadcast（asset 變動偏靜態）
   - 前端依賴 store optimistic update
6. PhyEditor → setEditorMode("scene") → App.tsx 切回主畫面
```

---

## 13. 啟動與開發

### 13.1 本機啟動（最常用）

```powershell
# 1. PostgreSQL（local mode, port 55432，避開系統 postgres 5432）
.\scripts\start-local-postgres.ps1

# 2. Backend
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
alembic upgrade head
python .\scripts\seed.py
uvicorn app.main:app --reload --port 8010

# 3. Frontend
cd frontend
npm install
npm run dev   # http://localhost:5173
```

或直接呼叫專案 skill `/start-project`（會處理 stale `postmaster.pid` + alembic 增量 + 三個服務一次啟動）。

### 13.2 Docker mode

```powershell
docker compose up -d       # postgres 5432 + adminer 8080
cd backend
alembic upgrade head
python .\scripts\seed.py
uvicorn app.main:app --reload --port 8000   # 注意 docker mode 預設 8000
```

### 13.3 Useful URL

| URL | 用途 |
|---|---|
| http://localhost:5173 | Frontend |
| http://localhost:8010/api/health | Backend ping |
| http://localhost:8010/docs | OpenAPI Swagger UI |
| http://localhost:8010/api/scene | 一次撈整個 scene |
| ws://localhost:8010/ws/scene | WebSocket |
| http://localhost:8080 | Adminer（Docker mode 才有）|

### 13.4 Seed data（`backend/scripts/seed.py`）

第一次 `alembic upgrade head` 後跑 seed 會建：

- `optical_table_1`、`vacuum_chamber_1`
- `laser_852nm_1`、`laser_894nm_1`
- `mirror_001`、`mirror_002`、`lens_001`
- `aom_001`、`eom_9ghz_001`
- `rf_generator_001`、`rf_amp_001`
- 29 條 Thorlabs NIR 690-1080 nm isolators（IO-/IOT-/I*P3D 系列），透過 `_ISOLATOR_SPECS` 表 + `_build_isolator_meta()` 自動推 `forwardLossDb` from transmission %

### 13.5 Test

```powershell
# Backend
cd backend
pytest                          # 145+ tests

# Frontend
cd frontend
npm test                        # vitest（含 76 frame + 25 AOM physics）
npm run test:watch
npx playwright test             # e2e
```

### 13.6 環境變數

```powershell
# Frontend overrides
$env:VITE_API_BASE_URL = "http://localhost:8010"
$env:VITE_WS_URL       = "ws://localhost:8010/ws/scene"

# Backend
DATABASE_URL = "postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin"
```

---

## 附錄：當你想做 X 時該去哪改

| 想做什麼 | 該改哪 |
|---|---|
| 加新的 ElementKind | `frontend/src/optical/kinds/<kind>/physics.ts` 新檔 + 註冊到 `_registry.ts` + `backend/app/schemas.py` 加新 ParamSchema + `backend/app/solvers/optical_solver.py` dispatch + alembic |
| 加新 anchor 到 Asset | PHY Editor → optical_components → edit asset anchors |
| 改 per-instance physics 參數 | 主場景右側 inspector（Object panel）→ kindParams |
| 改 per-template（vendor）規格 | PHY Editor → optical_components → catalog 那欄 |
| 加新 REST endpoint | `backend/app/routers/<resource>.py` 新檔 + `main.py` 註冊 |
| 加新 WS event type | Backend router 改 DB 後加 `manager.broadcast("...", payload)` + frontend `sceneStore.applyEvent` 加 case |
| 加新 multiphysics module | `backend/app/solvers/<module>.py` 寫 solver coroutine → register 到 `MODULE_DISPATCH` + `MODULE_DEFAULT_RUNNER` → frontend `modules/_registry.ts` 加 ModuleDef → 寫 `<module>/Workspace.tsx` → `App.tsx` 加 render case |
| 改 frame 轉換 | **只**改 `frontend/src/optical/frames.ts`，整個 codebase 唯一入口 |
| 加 timing waveform kind | `backend/app/timing_program.py` + `frontend` TimingEditorPanel + schemas |
| 改 Bragg 角公式 | `frontend/src/optical/kinds/aom/physics.ts`（單一 source，前後端共用）|
| 加 alembic migration | `alembic revision --autogenerate -m "..."` → 改 versions/ + 編輯 upgrade/downgrade → `alembic upgrade head` |

---

## 進一步閱讀

| 文件 | 內容 |
|---|---|
| [`docs/vibe coding.md`](vibe%20coding.md) | 1500+ 行 living snapshot，含 phase history / bug fix 記錄 / layered design 規則 |
| [`docs/MULTIPHYSICS_PLAN.md`](MULTIPHYSICS_PLAN.md) | Multiphysics platform 完整規劃 |
| [`docs/MULTIPHYSICS_PROGRESS.md`](MULTIPHYSICS_PROGRESS.md) | Phase A/B/C/D 進度 |
| [`docs/PHASE_C_WORKSTATION_SETUP.md`](PHASE_C_WORKSTATION_SETUP.md) | Phase C lab workstation SSH 設定 |
| [`docs/PHYSICS_TIME_DESIGN.md`](PHYSICS_TIME_DESIGN.md) / `PHYSICS_TIME_CHECKPOINT.md` | Scrub-time evaluator 設計 |
| [`docs/AD9959_TIMING_INTEGRATION.md`](AD9959_TIMING_INTEGRATION.md) | AD9959 DDS chassis 整合 |
| [`docs/PLACEMENT_DESIGN.md`](PLACEMENT_DESIGN.md) / `PLACEMENT_PROGRESS.md` | Placement gizmo 設計 |
| [`docs/optical-schema-v2.md`](optical-schema-v2.md) | V2 anchorBindings + opticalSources schema |
| `README.md` | 啟動 cheatsheet + API summary |
