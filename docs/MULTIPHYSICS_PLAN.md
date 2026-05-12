# Multi-physics Platform Plan — Optics / Electronics / EM

> 規劃文件,2026-05-12 拍板。把現有 qmem-digital-twin 從 quantum-optics digital twin 擴成 Ansys Workbench-style 多物理模擬平台,給 lab 內部設計實際裝置用。
>
> **這份是 planning,不是 implementation 進度。** 開始實作後請建 `MULTIPHYSICS_PROGRESS.md` 追蹤,本檔保留為設計參考。

---

## 0. 目標與限制

| 項目 | 設定 |
|---|---|
| **使用者** | 只給 lab 內部 |
| **Solver 認真度** | 真正能拿來設計實際裝置(出 paper / 出 PCB / 出 cavity) |
| **時間軸** | 不急,Phase 一個個做,沒有 hard deadline |
| **第一版 module** | Optics(現有)、Electronics、EM 三個 |
| **License 策略** | 全 open source(MEEP / ngspice / palace / Gmsh / scikit-rf);不支援 Ansys batch |

---

## 1. 架構方向

**核心原則:不重做殼,擴充現有 qmem-digital-twin。**

- 現有三層資料模型(Asset3D / Component / SceneObject + OpticalElement)全部複用
- Three.js scene、FastAPI、Postgres、Zustand store、WebSocket 都不動
- 多物理 = 同一個 SceneObject tree 上掛不同 module 的 view + sidecar table
- 每顆 chassis / chamber 在不同 module 下扮演不同角色(光學 enclosure / EM cavity / 電子 PCB 載體),用 sidecar 1:N 關聯標出

### UI:Workbench-style module switcher

```
┌────────────────────────────────────────────────────────────────┐
│ [QMsim] [Optics ▼] [Electronics] [EM] [Solver runs ▼]  [User]  │ ← top bar
├──────────┬─────────────────────────────────────┬───────────────┤
│ Outliner │                                     │ Properties    │
│ (scene   │   Active Module Workspace           │ panel         │
│  tree,   │   ─ Optics: 3D scene + ray trace    │  - 一般 obj   │
│  shared  │   ─ Electronics: schematic + waves  │  - kindParams │
│  cross   │   ─ EM: 3D scene + port/BC + field  │  - module-    │
│  modules)│                                     │    specific   │
│          ├─────────────────────────────────────┤    params     │
│          │ Solver console / progress / errors  │               │
└──────────┴─────────────────────────────────────┴───────────────┘
```

- **Outliner** = 跨 module 共用(只有一份 SceneObject tree)
- **中央 workspace** = 模組切換時換內容
- **Properties panel** = 顯示當前選中 object 在 active module 下的 module-specific 參數

---

## 2. 各 Module Solver 選型

### 2.1 Optics(擴充現有)

| Sub-tool | 對應 Ansys | Implementation |
|---|---|---|
| **Sequential Ray Trace** | Zemax OpticStudio (Sequential) | 現有 `rayTrace.ts` + `optical_solver.py`(已存在);Phase A 包進 module switcher 即可 |
| **Lens Design Helpers** | Zemax merit functions | 加 Seidel aberrations / spot diagram / MTF;可選整合 `rayoptics` Python lib |
| **Wave Optics FDTD** | Lumerical FDTD | wrap **MEEP** (MIT 開源 FDTD,業界 reference);Phase D 才做 |
| **Non-sequential / Illumination** | Speos | Phase 後期,先不做 |

### 2.2 Electronics(Phase B)

| Sub-tool | Implementation |
|---|---|
| **SPICE Simulation** | wrap **ngspice**(headless mode,Python 餵 netlist 拿 waveform) |
| **Schematic Editor** | Phase B 先 textarea + monaco editor 寫 netlist;Phase E 才做拖拉式 schematic |
| **Network Analysis** | **scikit-rf**(已知 S-parameter 的網路分析,小工程量) |
| **Waveform Viewer** | uPlot 或 Plotly,從 ngspice raw output 解析 |

### 2.3 EM(Phase C)

| Sub-tool | Implementation |
|---|---|
| **Frequency Domain FEM** | wrap **palace**(https://github.com/awslabs/palace,DOE/AWS FEM solver,接近 HFSS) |
| **Mesh Generation** | **Gmsh**(從 STEP/STL → `.msh`);Phase C 先 line CLI,後期再做 mesh quality UI |
| **Visualization** | vtk.js 或自寫 Three.js shader 顯示 field magnitude / E-field 向量 |
| **S-parameter Chart** | 同 Electronics waveform viewer 共用 |

**不選 openEMS 的原因**:FDTD-based,對複雜幾何(coax connector、bonding wire)收斂差;palace 是 FEM,跟 HFSS 一個量級。

---

## 3. 資料模型擴充

不動現有 schema。新增 sidecar table:

```sql
-- 跨 module 共用
simulation_runs (
  id UUID PK,
  module ENUM('optics_seq','optics_fdtd','spice','em_fem'),
  scene_snapshot_id UUID,        -- 跑 solver 時的 scene 快照(immutable)
  status ENUM('queued','running','done','error','cancelled'),
  runner_kind ENUM('inproc','container','ssh_workstation'),
  started_at, finished_at, error_message,
  params JSONB,                   -- per-module 輸入參數
  result_blob_path TEXT,          -- 大結果存 filesystem;小結果直接 JSONB
  result_summary JSONB,           -- key metrics 給 UI 列表用
  created_by, created_at
)

-- Electronics
circuits (
  id UUID PK,
  scene_object_id UUID FK,        -- 可選:綁到 scene 上的 PCB / chassis
  netlist TEXT,                   -- SPICE netlist
  schematic JSONB                 -- 自寫 schematic editor 的 graph(Phase E)
)

-- EM
em_problems (
  id UUID PK,
  scene_object_id UUID FK,        -- 哪個 chassis / antenna / waveguide
  ports JSONB,                    -- port spec(impedance, mode, anchorBinding id)
  boundary_conditions JSONB,
  freq_range_ghz JSONB,
  mesh_id UUID FK
)

meshes (
  id UUID PK,
  source_asset_3d_id UUID FK,
  mesh_format ENUM('gmsh','vtk'),
  file_path TEXT,
  element_count INT,
  max_size_mm REAL,
  created_at
)
```

### 跟現有資料的整合點

| 共用基礎 | 怎麼用 |
|---|---|
| `assets_3d.anchors[]` | EM port location 重用 anchor;circuit connection 也是 anchor |
| `objects.properties.anchorBindings[]` | EM port surface = `kind: "emPort"`(沿用同一個 binding 機制);沿用 frame / aperture / 半長慣例 |
| Three.js scene | EM field overlay 成 colormap(vtk.js);circuit voltage overlay 到 PCB trace |
| `device_states` | RF on/off 同時影響 optics(AOM)+ electronics(driver)— 真實 lab 邏輯 |
| WebSocket | Solver run progress 即時推前端 |
| `optical_solver.py` | 改名 / 移到 `solvers/optics_seq.py`,跟 `solvers/optics_fdtd.py`、`solvers/spice.py`、`solvers/em_fem.py` 平行 |

---

## 4. Solver Runner 抽象

不要把 solver invocation 寫死在 router。引入 **Solver Runner** interface,implementation 可換:

```python
# backend/app/solvers/runner.py
class SolverRunner(Protocol):
    async def submit(self, run: SimulationRun) -> None: ...
    async def cancel(self, run_id: UUID) -> None: ...
    async def status(self, run_id: UUID) -> RunStatus: ...

class InProcessRunner: ...      # Phase A:現有 optics ray trace,async function
class ContainerRunner: ...      # Phase B:subprocess in backend container(ngspice / MEEP)
class SshWorkstationRunner: ... # Phase C:SSH 到 lab workstation 跑 palace
```

Routers 只看到 `SolverRunner`,不關心怎麼跑。`simulation_runs.runner_kind` 記錄實際 dispatch 到哪個 runner。

### Per-phase 預設 runner

| Phase | Module | 預設 runner | 為什麼 |
|---|---|---|---|
| A | Optics(現有) | inproc | ray trace 是 ms 級,async function 即可 |
| B | Electronics | container | ngspice 是 subprocess,但很快;backend container 跑得動 |
| C | EM | ssh_workstation | palace FEM 跑大 mesh 要小時級 + GPU;lab workstation(`~/.ssh/config` 已有 `QM` / `Master` 等 host)更實際 |
| D | Optics FDTD | ssh_workstation | MEEP 同理 |

---

## 5. Phase 規劃

### Phase A — Module Switcher Shell + Optics 收編
**Scope**:把現有光學包進新框架。
**估計**:2–3 週(全職)
**Deliverables**:
- 新 top bar 加 module selector(Optics / Electronics / EM,後兩個 disabled)
- 新 `simulation_runs` table + `SolverRunner` interface + `InProcessRunner`
- 現有 ray trace 包成 `solvers/optics_seq.py`,從 `/api/simulation_runs` 觸發
- Properties panel 顯示 module-specific tab(Optics 先把現有 OpticalElementPanel 塞進去)
- Solver console 區塊(progress / log / error)
- 加 `optics_fdtd` / `spice` / `em_fem` enum 但不 implement

**Done criteria**:user 在 UI 切「Optics」進入現有光學模式,所有現存功能不變;module selector tab 可見但其他兩個只是 "Coming in Phase B/C" placeholder。

---

### Phase B — Electronics MVP
**Scope**:能跑 SPICE 看波形。
**估計**:3–4 週
**Deliverables**:
- `circuits` schema + CRUD endpoints
- ngspice 裝進 backend container,`solvers/spice.py` + `ContainerRunner`
- Electronics workspace:左半邊 monaco netlist editor,右半邊 uPlot waveform viewer
- 支援 transient / AC / DC sweep
- scikit-rf 整合 Smith chart + S-parameter view(用既有的 .s2p / .s4p touchstone file)
- Object types 新增 `circuit_board` `signal_generator` `oscilloscope`(scene-level只是 visualization,實際電路在 circuits table)

**Done criteria**:user 寫個 RLC 共振 netlist,點 Run → 30 秒內看到 V/I 波形圖。

---

### Phase C — EM MVP(palace)
**Scope**:能跑 FEM 算 S-parameter + field。
**估計**:6–10 週
**Deliverables**:
- `em_problems` + `meshes` schema + CRUD
- Gmsh 整合(input: STL/STEP from `assets_3d`,output: `.msh`)
- palace 裝在 lab workstation,`SshWorkstationRunner`
- EM workspace:3D scene(沿用 Three.js viewer)+ port assignment UI(從 anchorBinding 選)+ frequency sweep params
- Field overlay viewer(vtk.js 載 paraview 輸出 `.pvtu`)
- S-parameter chart 共用 Phase B waveform viewer

**Done criteria**:user 選一個 waveguide STL,assign 兩個 port,跑 1–10 GHz sweep,30 分鐘後看到 S11/S21 + |E| field heatmap。

---

### Phase D — Optics FDTD(MEEP)
**Scope**:wave optics 模擬。
**估計**:6–10 週
**Deliverables**:
- `solvers/optics_fdtd.py` + MEEP 裝在 workstation
- Optics workspace 加 sub-tab「Wave Optics」
- 場域定義 UI(simulation region / source / monitor,從 anchorBinding 推)
- Field viewer(同 EM 共用)

**Done criteria**:user 設定一個 grating coupler 結構,跑 FDTD → 看到 transmission spectrum + E-field movie。

---

### Phase E — Electronics Schematic Editor
**Scope**:取代 textarea netlist。
**估計**:4–6 週
**Deliverables**:
- React canvas-based schematic editor(zustand state + drag/drop)
- 元件 library(R / L / C / opamp / transistor / source / probe)
- Auto-generate netlist → 餵 ngspice
- 同步 highlight(波形上某條 trace ↔ schematic 上某個 net)

---

### Phase F — Polishing + Cross-module Dependency
**Scope**:跨模組數據流。
**估計**:open-ended
**Deliverables**:
- Cross-module dependency tracking(e.g. SPICE 算出的 RF driver 輸出 → propagate 到 AOM `kindParams.rfPowerW` → 影響 diffraction efficiency)
- Param sweep + convergence study + report export(PDF / Markdown)
- Mesh quality UI(Gmsh size field 可視化)
- Solver caching(scene hash + params hash 命中時直接拿舊結果)

---

## 6. Repo / Code 組織

新增 backend modules:

```
backend/app/
├── solvers/
│   ├── __init__.py
│   ├── runner.py             ← Protocol + 三個 runner implementation
│   ├── optics_seq.py         ← Phase A:把現有 optical_solver.py 搬過來
│   ├── optics_fdtd.py        ← Phase D:wrap MEEP
│   ├── spice.py              ← Phase B:wrap ngspice
│   └── em_fem.py             ← Phase C:wrap palace + Gmsh
├── routers/
│   ├── ...(現有)
│   ├── simulation_runs.py    ← Phase A
│   ├── circuits.py           ← Phase B
│   └── em_problems.py        ← Phase C
└── models.py                 ← 加 SimulationRun / Circuit / EmProblem / Mesh
```

新增 frontend modules:

```
frontend/src/
├── modules/                   ← 新:per-module workspace
│   ├── _registry.ts          ← module metadata(icon / displayName / enabled)
│   ├── optics/
│   │   ├── OpticsWorkspace.tsx
│   │   └── ...(現有 panels 移過來)
│   ├── electronics/
│   │   ├── ElectronicsWorkspace.tsx
│   │   ├── NetlistEditor.tsx
│   │   └── WaveformViewer.tsx
│   └── em/
│       ├── EmWorkspace.tsx
│       ├── PortAssignmentPanel.tsx
│       └── FieldViewer.tsx
├── components/workspace/
│   ├── ModuleSwitcher.tsx    ← 新:top bar 切 module
│   ├── SolverConsole.tsx     ← 新:progress + log
│   └── ...(現有)
└── api/
    ├── simulationRuns.ts     ← 新
    ├── circuits.ts           ← 新
    └── emProblems.ts         ← 新
```

---

## 7. Risk / 待解

| Risk | 緩解策略 |
|---|---|
| Lab workstation SSH 連線斷掉 → solver 半路死 | `SshWorkstationRunner` 用 `tmux` / `nohup` + heartbeat 檔案;斷線後 reconnect 仍能查 status |
| OneDrive 同步 .git → repo corrupt | 開始 Phase A 前把 repo 移出 OneDrive 到 `C:\repos\qmem-digital-twin\` |
| Mesh edit UI 太貴 | 第一版只接受 upload `.msh`;後期再做 region painting |
| palace dependency 太重(MFEM / PETSc) | 用 Docker image 而不是手 build;workstation 也包成 container |
| MEEP MPI 配置 | 初版單 process,後期再加多核 |
| 跨 module 同步狀態 conflict | Phase F 才碰;先確保 `simulation_runs.scene_snapshot_id` 是 immutable snapshot 不被後續編輯污染 |

---

## 8. 不在 Plan 內(明確排除)

- Ansys license / batch mode 支援
- Multi-tenant / commercial polish
- Cloud deployment(AWS / Azure)
- Mobile UI
- Non-sequential optics(Speos-like illumination)— Phase 之外
- PCB layout / signal integrity(Sigrity-like)— Phase 之外
- Structural FEM / CFD — 明確不做(只做光學 / 電子 / EM 三個)

---

## 9. 開工前 checklist

- [ ] 把 repo 從 OneDrive 移出(避免 .git 同步 corrupt)
- [ ] Lab workstation 確認:哪一台?GPU?palace 跑得動的記憶體?
- [ ] SSH key 設好(現在 `~/.ssh/` 沒 private key,push 用 HTTPS;workstation runner 之前要補)
- [ ] 拍板 Phase A 開工日期
- [ ] 建 `MULTIPHYSICS_PROGRESS.md` 開始追蹤
