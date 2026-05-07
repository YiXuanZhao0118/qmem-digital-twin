# QMsimulation / qmem-digital-twin — 專案 Snapshot

> 這份檔案是專案目前狀態的**完整參考文件**，從大到小都寫進來：架構 → 規範 → 細節。
> 不是時序紀錄。每次 Claude 對專案做改動後，更新對應段落而不是 append 新區段。
>
> **最後一次完整 normalize：2026-05-07 13:25**（Phase 1-6 schema/frame/unit 統一全部完成後）

---

## 1. 專案是什麼

QMsimulation 是一套量子記憶體實驗台的**digital twin**：把整個光學桌面 (laser → TA → HWP → PBS → AOM → ...) 用 3D 視覺化、ray-tracing、Jones matrix polarization simulation 包成一個可互動的 web app。Lab 操作員可以在瀏覽器拖物件、看 beam path、切 AOM 階數、調 waveplate 角度，所有改動即時跑光學模擬。

主要 use cases：
- **設計新光路**：在 3D 場景把元件擺好，看 beam 怎麼走、power 在哪裡分掉
- **vendor 套件管理**：把 Thorlabs / TOPTICA / AA Optoelectronic 的 STL/GLB import 進來變成可重用 component
- **align 模擬**：把元件 snap 到 beam 上、自動算 mirror reflection、AOM Bragg 條件
- **時序控制**：定義 RF / digital trigger 的 timing program（10 ns 解析度，SpinCore-style）

---

## 2. Layout 跟啟動

### Repo 結構

```
QMsimulation/
├── qmem-digital-twin/
│   ├── backend/                   FastAPI + SQLAlchemy + Pydantic
│   │   ├── app/
│   │   │   ├── main.py            FastAPI app + router 註冊
│   │   │   ├── db.py              async engine + AsyncSessionLocal
│   │   │   ├── config.py          settings (DB URL, etc)
│   │   │   ├── models.py          SQLAlchemy DB tables
│   │   │   ├── schemas.py         Pydantic schemas (CamelModel base)
│   │   │   ├── crud.py            generic update helpers
│   │   │   ├── assembly_solver.py 約束求解器（face-touch / direction / position relations）
│   │   │   ├── timing_program.py  SpinCore-style 10 ns timing
│   │   │   ├── websocket.py       即時 broadcast
│   │   │   ├── routers/           per-resource REST endpoints (見 §10)
│   │   │   ├── solvers/
│   │   │   │   └── optical_solver.py   Jones matrix 全光路解（後端權威版本）
│   │   │   └── services/
│   │   ├── alembic/versions/      DB migrations 0001 → 0020
│   │   ├── scripts/seed.py        初始化 component library 種子資料
│   │   └── tests/                 pytest 套件，139 tests
│   │
│   ├── frontend/                  React + Vite + TypeScript + Three.js + Zustand
│   │   ├── src/
│   │   │   ├── App.tsx            最外層 layout
│   │   │   ├── api/client.ts      axios + WS bootstrap
│   │   │   ├── store/sceneStore.ts Zustand store + scene action bus
│   │   │   ├── types/
│   │   │   │   ├── digitalTwin.ts 全部 domain types
│   │   │   │   ├── units.ts       brand types: Mm / Deg / Frame / PositionMm<F>...
│   │   │   │   └── visibility.ts  collection visibility helpers
│   │   │   ├── optical/
│   │   │   │   ├── frames.ts      ★ frame/unit conversion 唯一入口
│   │   │   │   └── frames.test.ts 76 個 vitest regression test
│   │   │   ├── three/             three.js side
│   │   │   ├── utils/             beam helpers + relation helpers
│   │   │   └── components/        React UI tree
│   │   └── package.json           npm scripts: dev / build / test / test:watch
│   │
│   └── docs/                      設計文件
│
├── scripts/                       project-level CLI utilities
├── docker-compose.yml             postgres on port 55432
├── README.md
├── vibe coding.md                 這個檔案
└── assets/                        共用 GLB / STL / 圖片
```

### 啟動

```bash
# DB（僅第一次或重啟）
docker-compose up -d postgres        # localhost:55432

# Backend
cd qmem-digital-twin/backend
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8010

# Frontend
cd qmem-digital-twin/frontend
npm install                          # 第一次
npm run dev                          # http://localhost:5173
```

或直接呼叫專案 skill：`/start-project`（會自動處理 stale postmaster.pid + alembic + 三個服務）。

### Ports 與檔案路徑慣例

| Service | Port | Notes |
|---|---|---|
| Postgres | 55432 (host) → 5432 (container) | 從 docker-compose |
| Backend uvicorn | 8010 | hot-reload via `--reload` |
| Frontend Vite | 5173 | hot-reload via HMR |

API 路徑前綴一律 `/api/`（routers 在 `app/main.py:42-` 註冊）。Frontend 直接走 `http://localhost:8010/api/...`，不走 Vite proxy。

---

## 3. 系統架構（高層）

### 三層資料模型（重要！）

這是整個 codebase 最重要的概念，先看懂這個再讀任何 code。

```
Layer 1 — Asset3D (CAD 檔案層)
─────────────────────────────────────────────────────────
* 對應 DB table: assets_3d
* 一份 STL/GLB 檔案 = 一個 Asset3D row
* 帶有「3D 模型上哪裡是光學重點」的 anchors[]
* 例：BoosTA pro 那顆 GLB 的 +x 面 (output aperture) 跟 -x 面 (input)

Layer 2 — Component (vendor 規格層)
─────────────────────────────────────────────────────────
* 對應 DB table: components
* 一個 vendor 型號 = 一個 Component row（template）
* 連到一個 Asset3D（asset_3d_id），帶 component_type ("aom", "mirror", ...)
* 帶 properties JSONB：每個型號特定的 dimensions、wavelength range、
  aperture coords 等規格資料
* 例：Thorlabs PBS252、AA Optoelectronic MT80-A1.5-IR

Layer 3 — SceneObject + OpticalElement (instance 層)
─────────────────────────────────────────────────────────
* SceneObject (objects table)：場景上的一顆實際擺位的物件
  - 每個 instance 有自己的 (xMm, yMm, zMm, rxDeg, ryDeg, rzDeg)
  - properties JSONB 帶 per-instance overrides (anchors, locked,
    objectScale, originOffsetMm, placedRelativeTo)
* OpticalElement (optical_elements table)：跟 SceneObject 1:1
  - element_kind: "mirror" | "aom" | ... (從 Component 推出)
  - kind_params JSONB: 跟 element kind 相關的物理參數
    (e.g. AOM 的 acousticAxisBodyLocal, waveplate 的 fastAxisDegBeamLocal)
```

**規則：物件移動 / 旋轉只動 SceneObject 的 6 個 Euler 欄位 + properties**。Component / Asset 是 template，不該因為某個 instance 動了就改。同一個 Component 可以 spawn 很多 SceneObject。

### 主要 subsystem

```
              ┌──────────────────────────────────────┐
              │   FastAPI backend (port 8010)        │
              │                                      │
              │   ┌──────────────────────────────┐   │
              │   │  routers/*.py                │   │
              │   │  REST + Pydantic validation  │   │
              │   └──────────────────────────────┘   │
              │              │                       │
              │   ┌──────────┴──────────┐            │
              │   │                     │            │
              │   ▼                     ▼            │
              │  assembly_solver   optical_solver    │
              │  (約束求解)        (Jones / power)   │
              │   │                     │            │
              │   └──────────┬──────────┘            │
              │              │                       │
              │   ┌──────────▼──────────┐            │
              │   │  PostgreSQL         │            │
              │   │  (port 55432)       │            │
              │   └─────────────────────┘            │
              └────────┬─────────────────────────────┘
                       │ HTTP + WS
                       ▼
              ┌──────────────────────────────────────┐
              │   React frontend (port 5173)         │
              │                                      │
              │   ┌─────────────────────┐            │
              │   │  Zustand store      │            │
              │   │  (sceneStore.ts)    │            │
              │   └──────────┬──────────┘            │
              │              │                       │
              │   ┌──────────┴──────────────┐        │
              │   │                         │        │
              │   ▼                         ▼        │
              │  React panels      Three.js scene    │
              │  (UI controls)     - DigitalTwinViewer
              │                    - rayTrace.ts (前端 ray tracer
              │                      —— 用來給使用者看 beam)
              │                    - placement gizmo
              └──────────────────────────────────────┘
```

**重點**：optical_solver.py 是 backend 權威版本（Run Solver 按鈕 → 跑這個）。frontend 的 rayTrace.ts 是即時視覺化版本（拖物件就重 trace），跟 backend solver 邏輯**鏡像**但不完全相同。兩邊都用 Jones matrix。

---

## 4. Frame / unit 統一規則 ⭐

**這是 Phase 1-6 的成果，整個 codebase 的核心 invariant**。改 code 之前先讀這段。

### 四種 frame

| 簡稱 | 全名 | 軸向 | 單位 | 用途 |
|---|---|---|---|---|
| **Lab** | scene / world frame | **Z-up**（X right, Y forward, Z up）| mm | SceneObject 位置、cursor、ray 端點 |
| **BodyLocal** | SceneObject's local frame | **Z-up**（跟 Lab 同軸向） | mm | anchor 位置、物理向量在物體 local 的表達 |
| **BeamLocal** | beam propagation frame | +z 沿 beam 方向 | dimensionless | Jones matrix 角度（fast axis / transmission axis） |
| **Three** | three.js render frame | **Y-up** | three units (mm / 100) | 只在 `frames.ts` 跟 three/* renderers 內部出現 |

**關鍵 invariant**：BodyLocal 跟 Lab 用**同一個軸向慣例** —— 從 BodyLocal 到 Lab 只要 SceneObject 的 quaternion 旋轉，**不需要 axis swap**。Three frame 是 only render 用的中介層。

### 唯一允許的 frame conversion 路徑

全 codebase **不可以**手寫 `(x, z, -y)` axis swap 或 `* 100 / 100` magic number。一律走 `src/optical/frames.ts`：

```ts
// frames.ts 提供：
MM_PER_THREE_UNIT = 100               // 唯一定義點

// 純單位 scalar
mmToThree(valueMm: number): number
threeToMm(valueThree: number): number

// Lab (Z-up mm) ↔ Three (Y-up units)
labMmToThree({xMm, yMm, zMm}): THREE.Vector3
threeToLabMm(v): {xMm, yMm, zMm}
labToThreeVector([xMm, yMm, zMm]): THREE.Vector3   // legacy tuple form
threeToLabVector(v): Vec3                          // legacy tuple form
threeToLabPointMm(v): {x, y, z}                    // unmarked LabPoint shape

// 純方向向量 axis swap (no scaling)
labDirToThree(d): THREE.Vector3
threeDirToLab(v): {x, y, z}

// Body-local Z-up direction 經 SceneObject 旋轉
bodyLocalDirToThree(d): THREE.Vector3                   // 純 axis swap
bodyLocalDirToWorldThree(d, sceneObject): THREE.Vector3 // swap + apply quaternion
bodyLocalDirToLabDir(d, sceneObject): {x, y, z}         // round-trip Lab

// SceneObject orientation（SINGLE SOURCE OF TRUTH）
sceneObjectToQuaternion(sceneObject): THREE.Quaternion
applySceneObjectRotationThree(vThree, sceneObject): THREE.Vector3
rotateLabDir(dLab, sceneObject): {x, y, z}
```

**SceneObject 的 (rxDeg, ryDeg, rzDeg) 只能透過 `sceneObjectToQuaternion()` 變成 rotation**。`applyObjectTransform()` 跟 `rotateLocalToLab()` 都走這條路徑。Phase 3 修了個 silent bug —— 之前這兩個用不同 Euler order，多軸旋轉時 anchor 算出來的 lab 位置跟畫面顯示偏到 37%。現在保證一致到 1e-9 精度（76 個 vitest 守住）。

### 命名規則：Frame / unit 強制 suffix

帶 frame 或 unit 語意的欄位**必須**在欄位名標出來：

```
< concept >_< unit >_< frame? >
```

| 標籤 | 用法 | 例 |
|---|---|---|
| `_Mm` | mm 純量 | `crystalLengthMm`、`focalMm` |
| `_Deg` | degrees | `rxDeg`、`fastAxisDegBeamLocal` |
| `_Mrad` | milliradians | `braggAngularAcceptanceMrad` |
| `_Nm` | nanometers | `centerWavelengthNm` |
| `_MHz`、`_GHz`、`_W`、`_Mw`、`_Ns`、`_Ps` | 物理單位 | `centerFreqMhz`、`riseTimeNs` |
| `_Lab` | lab Z-up frame | `braggTiltAxisDegLab`、`xMm` (frame implicit) |
| `_BodyLocal` | body Z-up frame | `surfaceNormalBodyLocal`、`positionMmBodyLocal`、`coatingNormalBodyLocal` |
| `_BeamLocal` | beam frame | `fastAxisDegBeamLocal`、`transmissionAxisDegBeamLocal` |

**禁止**：含糊的 `*Local` suffix（沒講哪個 frame 的 local）。Phase 4-5-6 已把 `localPosition`、`acousticAxisLocal`、`coatingNormalLocal`、`fastAxisDeg`、`transmissionAxisDeg`、`braggTiltAxisAngleDeg`、`apertureForwardLocalMm` 全部換成 frame-suffixed 名。

### Brand types（compile-time 防呆）

`src/types/units.ts` 提供 zero-runtime brand types：

```ts
export type Mm = Brand<number, "Mm">;
export type Deg = Brand<number, "Deg">;
// ... Mrad, Nm, Hz, MHz, W, Mw, Ns

export type Frame = "Lab" | "BodyLocal" | "BeamLocal" | "Three";
export type PositionMm<F extends Frame> = { __frame: F; xMm: Mm; yMm: Mm; zMm: Mm };
export type Direction<F extends Frame> = { __frame: F; x: number; y: number; z: number };
export type DirectionUnit<F extends Frame> = Direction<F> & { __unit: true };

// boundary escape hatches
asMm(v: number): Mm
asDeg(v: number): Deg
mm(v: Mm): number   // unwrap
deg(v: Deg): number
```

新 code 寫的時候盡量使用 brand types；既有 code 多數還是 `number`，逐步 migrate。

---

## 5. Backend schema reference

### DB tables（重點欄位）

| Table | 主要欄位 | 備註 |
|---|---|---|
| `assets_3d` | id, name, asset_type, file_path, unit ("mm"\|"m"), scale_factor, **anchors JSONB** | unit 影響 mesh 顯示 scale |
| `components` | id, name, component_type, asset_3d_id, capabilities[], **properties JSONB**, notes | template 層 |
| `objects` | id, component_id, x_mm, y_mm, z_mm, rx_deg, ry_deg, rz_deg, visible, locked, **properties JSONB** | per-instance pose |
| `optical_elements` | object_id (PK + FK to objects), element_kind, **kind_params JSONB**, input_ports, output_ports | 1:1 with object |
| `optical_links` | from_object_id, to_object_id, free_space_mm, ... | beam 連接 |
| `assembly_relations` | object_a_id, object_b_id, relation_type, selector_a / selector_b JSONB, offset_mm, angle_deg, tolerance_mm, enabled, solved | 約束 (face-touch / direction / position) |
| `beam_paths` | source_object_id, segments[] | trace 結果 |
| `beam_segments` | id, from_object_id, to_object_id, propagation_axis_local JSONB, power_mw, spectrum, polarization | per-segment beam state |
| `device_states` | object_id, state JSONB | runtime hot state (RF on/off, etc) |
| `timing_programs` | object_id (PK), duration_ns, blocks[], spin_core_start | SpinCore-style |
| `timing_blocks` | id, t_start_ns, t_end_ns, waveform_kind, params JSONB | 10 ns snap |
| `collections`、`collection_members` | outliner 用的 collection 樹狀結構 | 一個 object 只屬於一個 collection (alembic 0016) |

### Pydantic schema 階層

`backend/app/schemas.py` 全用 `CamelModel` 作 base：

```python
class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,        # snake_case ↔ camelCase
        from_attributes=True,
        populate_by_name=True,           # accepts both
    )
```

統一 transitional 工具：

```python
def _accept_legacy_keys(data, renames: tuple[tuple[str, str], ...]) -> Any:
    # 用在 model_validator(mode="before") 裡，input 接受 legacy 跟新名
```

主要 schema：

| Class | 用途 |
|---|---|
| `Asset3DBase / Asset3DCreate / Asset3DUpdate / Asset3DOut` | Asset CRUD |
| `AssetAnchor`、`Vec3Mm`、`AssetAnchorId` (Literal whitelist) | Phase 4：formal anchor schema |
| `ComponentBase / ComponentCreate / ComponentUpdate / ComponentOut` | Component CRUD |
| `SceneObjectBase / SceneObjectCreate / ... / SceneObjectOut` | Object pose CRUD |
| `OpticalElement{Base,Create,...}` + `kind_params` discriminated union | `MirrorParams`、`AOMParams`、`TaperedAmplifierParams`、`WaveplateParams`、`PolarizerParams`、`BeamSplitterParams`、`DichroicMirrorParams`、`FiberCouplerParams`、`IsolatorParams`、`LensSphericalParams`、`LensCylindricalParams`、`LaserSourceParams`、`EOMParams`、`NonlinearCrystalParams`、`SaturableAbsorberParams`、`DetectorParams`、`CameraParams`、`SpectrometerParams`、`WavemeterParams`、`BeamDumpParams` |
| `AssemblyRelation*` | 約束 |
| `OpticalLink*`、`BeamSegment*` | beam 連接 / segment |
| `TimingProgram*`、`TimingBlock*` | timing |

### Alembic migrations

| ID | 標題 | 內容 |
|---|---|---|
| 0001 | initial | placements / components / assets table |
| 0002 ~ 0013 | 中間迭代 | optical domain / archive / collection / timing / no_self_loop |
| **0014** | per_obj_optical | OpticalElement 從 per-component 改 per-instance |
| 0015 | per_obj_state_serial | DeviceState / TimingProgram / BeamPath endpoint 全 per-instance |
| 0016 | unique_object_home | 每個 object 只屬於一個 collection |
| 0017 | fix_aom_glb_unit | AOM GLB 從 mm 改 m（Blender authored unit 修正）|
| **0018** | normalize_asset_anchors | Phase 4：`localPosition` → `positionMmBodyLocal`、`localDirection` → `directionBodyLocal` |
| **0019** | normalize_kindparams | Phase 5：9 個 kindParams 加 frame suffix（acousticAxisLocal → acousticAxisBodyLocal 等）|
| **0020** | norm_comp_props | Phase 6：Component.properties 的 apertureForwardLocalMm / apertureBackwardLocalMm rename |

> **註**：alembic 的 `version_num` 欄位是 VARCHAR(32)，新 migration 的 revision id 不要超過這個長度（0020 改名一次踩過此雷）。

---

## 6. Frontend type reference

### `src/types/digitalTwin.ts` 主要 type

```ts
type Vec3 = [number, number, number]                   // legacy tuple
type AxisLock = { x: boolean; y: boolean; z: boolean }
type ObjectLock = { position: AxisLock; rotation: AxisLock }

type Anchor = {
  id: string                          // whitelist: ±x/y/z, center, optical_anchor,
                                      // in / intercept_in / intercept_out / intercept_face / seed / out
  name?: string                       // optional metadata
  type?: "center" | "face" | "edge" | "custom" | string
  positionMmBodyLocal: { x: number; y: number; z: number }   // ★ Phase 4
  directionBodyLocal?: { x: number; y: number; z: number }   // ★ Phase 4
  apertureMm?: number
}

type Asset3D = {
  id, name, assetType, filePath, source?, sourceUrl?,
  unit: "mm" | "m"
  scaleFactor: number
  anchors: Anchor[]
}

type ComponentItem = {
  id, name, componentType, ...
  asset3dId?: string
  properties?: {                      // heterogeneous JSONB by componentType
    geometry?: string
    dimensionsMm?: [number, number, number]
    wavelengthRangeNm?: [number, number]
    apertureForwardMmBodyLocal?: number[]    // ★ Phase 6 (TA / AOM)
    apertureBackwardMmBodyLocal?: number[]   // ★ Phase 6
    sourceUrl?: string, sourceStep?: string
    // ... 其他 vendor-specific 欄位
  }
}

type SceneObject = {
  id, componentId, name?
  xMm, yMm, zMm                       // Lab Z-up mm
  rxDeg, ryDeg, rzDeg                 // Lab Euler (透過 sceneObjectToQuaternion 用)
  visible, locked
  properties?: {
    anchors?: Anchor[]                // per-instance overrides
    originOffsetMm?: { x, y, z }      // Lab Z-up origin offset
    objectScale?: number
    placedRelativeTo?: { kind, fromObjectId, toObjectId, ... }
    locked?: { position, rotation }   // axis-mask lock
    controlledBy?: { position: [relationId, ...] }
    // ... solver soft state
  }
}

type ElementKind = "laser_source" | "tapered_amplifier" | "mirror" | "lens_spherical"
                 | "lens_cylindrical" | "waveplate" | "polarizer" | "beam_splitter"
                 | "dichroic_mirror" | "fiber_coupler" | "isolator" | "aom" | "eom"
                 | "nonlinear_crystal" | "saturable_absorber" | "detector"
                 | "camera" | "spectrometer" | "wavemeter" | "beam_dump"

type OpticalElement = {
  objectId, elementKind, kindParams: Record<string, unknown>,
  inputPorts: string[], outputPorts: string[]
}

// per-kind params types (subset shown — see schemas.py for full list):
type MirrorParams = { reflectivity, surfaceQualityNm?, surfaceNormalBodyLocal: number[] }
type WaveplateParams = { retardanceLambda, fastAxisDegBeamLocal, transmission }
type PolarizerParams = { transmissionAxisDegBeamLocal, extinctionRatioDb, transmission }
type BeamSplitterParams = { splitRatioTransmitted, polarizing, transmissionAxisDegBeamLocal,
                            extinctionRatioDb, transmission, coatingNormalBodyLocal? }
type IsolatorParams = { forwardLossDb, isolationDb, transmissionAxisDegBeamLocal }
type AOMParams = { ..., acousticAxisBodyLocal?, rfPropagationDirectionBodyLocal?,
                   braggTiltAxisDegLab?, ... }
```

### `src/types/units.ts`

見 §4 的 brand types。

---

## 7. ElementKind 各 kind 詳解

### Active emitters

| Kind | 主要 params | 說明 |
|---|---|---|
| `laser_source` | `centerWavelengthNm`、`spectrum`、`spatialModeX/Y` (Gaussian)、`polarization` (Jones)、`nominalPowerMw` | 光源 |
| `tapered_amplifier` | `centerWavelengthNm`、`driveCurrentMa` (default 2400)、`aseSamples[]`、`gainSamples[]` 2D 表、雙向 spatial mode | BoosTA pro 用 user-supplied GLB；scale 1（meters native）|

### Passive optics

| Kind | 主要 params | Align 規則 |
|---|---|---|
| `mirror` / `dichroic_mirror` | `reflectivity`、`surfaceNormalBodyLocal: number[]` | translate face-center → beam (25 mm tol) + 之後 user 用 U/V slider 沿 beam ⊥ basis 微調，rx/ry/rz 設角度 |
| `lens_spherical` / `lens_cylindrical` | `focalMm`、`numericalAperture?`、`transmission`、`gvdFs2`、material | translate intercept_in → beam |
| `waveplate` | `retardanceLambda` (0.5=HWP / 0.25=QWP)、`fastAxisDegBeamLocal` | translate intercept_in → beam + 繞 beam axis 旋轉 plate |
| `polarizer` | `transmissionAxisDegBeamLocal`、`extinctionRatioDb`、`transmission` | translate intercept_in → beam |
| `beam_splitter` (含 PBS) | `splitRatioTransmitted`、`polarizing`、`transmissionAxisDegBeamLocal`、`coatingNormalBodyLocal` | translate intercept_in → beam |
| `fiber_coupler` | `couplingEfficiency`、`modeFieldDiameterUm`、`fiberType` | translate intercept_in → beam |
| `isolator` | `forwardLossDb`、`isolationDb`、`transmissionAxisDegBeamLocal` | translate intercept_in → beam |

### Active / nonlinear

| Kind | 主要 params | Align |
|---|---|---|
| `aom` | `centerFreqMhz`、`refractiveIndex`、`figureOfMeritM2`、`crystalLengthMm`、`acousticBeamWidthMm`、`rfDrivePowerW`、**`acousticAxisBodyLocal`**、**`rfPropagationDirectionBodyLocal`**、`diffractionOrder ∈ {-1,0,+1}`、`maxDiffractionOrder` (≤10)、`sidebandVisibilityThreshold`、`braggAngularAcceptanceMrad`、**`braggTiltAxisDegLab`** (0=Z, 90=Y) | 6-face 候選 → 取最近 (25 mm)；繞 lab tilt-axis 1-D scan 滿足 `dir·acoustic = orderSign·sin(θ_B)`；translate face-center → beam |
| `eom` | `vPiV`、`modulationKind: "phase"\|"amplitude"`、`modulationBandwidthMhz`、`insertionLossDb` | translate intercept_in → beam |
| `nonlinear_crystal` | `process: "SHG"\|"SFG"\|"DFG"\|"OPO"`、`chi2PmPerV`、`lengthMm`、phase match params | translate intercept_in → beam |
| `saturable_absorber` | `saturationIntensityWPerCm2`、`modulationDepth`、`recoveryTimePs` | translate intercept_in → beam |

### Sinks

| Kind | 主要 params |
|---|---|
| `detector` | `responsivityAPerW`、`quantumEfficiency`、`bandwidthMhz` |
| `camera` | `resolutionPx: [w, h]`、`pixelSizeUm`、`quantumEfficiency` |
| `spectrometer` | `resolutionPm`、`wavelengthRangeNm: [lo, hi]` |
| `wavemeter` | `precisionMhz` |
| `beam_dump` | `absorption` |

---

## 8. Align 演算法 catalog

整套 align 邏輯散在這幾個地方：

### 共用 snap-to-beam (`src/utils/beamPlacement.ts`)

```
findSnapToBeam(objectId, scene) → SnapCandidate | null
  1. 取出物件的 intercept anchor (id ∈ {intercept_face, intercept_in, intercept_out, in, seed})
     沒 anchor → fallback body center, aperture 12.5 mm
  2. 取出 publish 的 ray segments (window.__rayTraceDebug)
  3. 對每個 (anchor × axis) 算 perpendicular miss distance
  4. miss ≤ SNAP_TOLERANCE_MM = 25 mm 的取最小
  5. 回傳 newBodyPos = 平移把 anchor 落到 axis 上（translation only）
```

`rotateLocalToLab(v, rxDeg, ryDeg, rzDeg)` — 內部呼叫 `sceneObjectToQuaternion`，所有 caller 都拿到跟 renderer 一致的 rotation（Phase 3 修的 silent bug）。

`perpendicularBasis(direction)` — 給 mirror U/V slider 用的兩個正交軸 (`u = direction × world_up`, `v = direction × u`)。

### 每個 kind 的 controls (`src/components/optical/OpticalElementPanel.tsx`)

| Kind | 控制 | Function |
|---|---|---|
| Generic (mirror / lens / PBS / waveplate / ...) | `AlignToBeamSection.onAlign` | 呼叫 findSnapToBeam，translation-only |
| Mirror / Dichroic | + `MirrorAdjustControls` | U/V mm slider、rx/ry/rz 角度 |
| Waveplate | + `WaveplateAdjustControls` | Fast axis 度數（commit 時繞 beam axis 轉 plate quaternion）|
| AOM | `AomAdjustControls` (取代 generic) | RF power slider、Max η、Output order ±1/0、Flip RF、Tilt axis r、Align AOM aperture + Bragg |
| TA | `TaperedAmplifierAdjustControls` | Drive current、ASE / Gain samples、`alignInputToLaser` (anti-parallel 25 mm) |

### AOM `alignToLaser` 演算法（最複雜）

1. 列出 6 面 (±X / ±Y / ±Z) 的 face center 跟對應 body axis
2. 對每個 face × beam pair 算 perpendicular miss
3. miss ≤ 25 mm + t > 0 + 排除 AOM 自己的 0/±1 emission，取最小
4. **1-D scan** 繞 user 選的 lab tilt axis（由 `braggTiltAxisDegLab` 連續決定）
   - 1° coarse 全圈 → 0.005° fine refine ±1°
   - 目標：`|arcsin(dir·acoustic_world) − orderSign·sin(θ_B)|` 最小
5. 算旋轉後 face center 位置，平移 body 把它拉到 beam axis 上
6. Feedback：face name + tilt axis + bestOmega + residual mismatch + face miss

物理：
- Bragg angle: `θ_B = arcsin(λ·f / (2·n·v))`
- 繞射效率: `η = sin²((π·L / 2λ·cosθ_B) · √(2·M₂·P_d / W))`
- Raman-Nath: `|n| ≥ 2` 用 Bessel `J_n²(v)` 算 sideband intensity
- Max η 一鍵: 反解 `arg = π/2` → `P_d = W·cos²θ_B·λ² / (2·M₂·L²)`

### 全域 cursor / multi-select operations (`src/store/sceneStore.ts`)

| Function | 行為 |
|---|---|
| `alignSelectedObjectsToCursor` | 移動 wrapper origin 到 3D cursor 位置 |
| `moveSelectedOriginsToCursor` | 改 `properties.originOffsetMm` |
| `rotateSelectedObjectsAroundCursor(axis, deg)` | 繞 cursor 旋轉 |
| `scaleSelectedObjectsAroundCursor` | 繞 cursor 縮放 |

---

## 9. 關鍵檔案 reference

### Frontend `src/`

| 檔案 | 角色 |
|---|---|
| `App.tsx` | 最外層 layout（top-bar / 左 panel / 中間 viewport / 右 panel）|
| `main.tsx` | React entry point + WS bootstrap |
| `api/client.ts` | axios + WS connection；`API_BASE_URL = http://localhost:8010`（無 Vite proxy）|
| `store/sceneStore.ts` | Zustand store + scene mutations（單一 source of truth）|
| **`optical/frames.ts`** | ★ frame/unit conversion 唯一入口 |
| **`optical/frames.test.ts`** | 76 個 vitest regression test |
| `types/digitalTwin.ts` | 全部 domain types |
| `types/units.ts` | brand types + Frame enum |
| `types/visibility.ts` | collection visibility helpers |
| `three/transformUtils.ts` | re-export from frames.ts + `applyObjectTransform`（用 `target.quaternion.copy(sceneObjectToQuaternion(...))`）|
| `three/rayTrace.ts` | 前端 ray tracer：emission、reflection、refraction、Jones polarization、AOM diffraction、TA gain、~1700 行 |
| `three/loadAsset.ts` | GLB / STL loader + procedural primitives (createAom 等)、anchor placement、apertureForwardMmBodyLocal 處理 |
| `three/opticalBeams.ts` | beam emission origin/direction 計算（用 anchor 的 positionMmBodyLocal / directionBodyLocal）|
| `three/beamPath.ts` | 把 beam segments 渲染成 LatheGeometry tube（waist taper visualization）|
| `three/photoRoom.ts` | 房間 / 牆 / 地板 |
| `three/tableGrid.ts` | optical table grid |
| `three/placement/gizmo.ts` | TransformControls wrapper + smart snapping |
| `three/placement/snapTargets.ts` | snap candidate enumerators |
| `three/placement/snapOverlay.tsx` | snap result UI overlay |
| `three/placement/engine.ts` | computePlacement core logic |
| `utils/beamPlacement.ts` | findSnapToBeam、perpendicularBasis、rotateLocalToLab、enumerateBeamAxes |
| `utils/beamAnchor.ts` | optical_anchor lookup（mirror reflective face center 等）|
| `utils/beamSnap.ts` | 純幾何 snap 工具 |
| `utils/relationAnchors.ts` | AssemblyRelation 用的 anchor metadata（含 selector face anchors）|
| `utils/opticalDefaults.ts` | DEFAULT_KIND_PARAMS、KIND_LABELS、KIND_GROUPS、componentTypeToOpticalKind |
| `utils/...` | 其他 helper |
| `components/DigitalTwinViewer.tsx` | ★ 主 3D viewport（含 marquee 選取、placement gizmo、wireframe outline、port labels、ABC markers、waveplate fast-axis 指示線）|
| `components/optical/OpticalElementPanel.tsx` | ★ 右側 per-kind 控制面板（最大檔案、含所有 AdjustControls + AdjustErrorBoundary）|
| `components/optical/CursorMenu.tsx` | Shift+S cursor pop-over |
| `components/optical/BeamScopePanel.tsx` | 選 beam 顯示 power / polarization / spectrum |
| `components/optical/...` | 其他 optical UI |
| `components/OutlinerPanel.tsx` | 場景 outliner（collection 樹狀）|
| `components/ComponentPanel.tsx` | 左側 component library |
| `components/AssetLibraryPanel.tsx` | 3D asset 管理 |
| `components/AlignPanel.tsx` | 全域 align actions |
| `components/SceneToolbar.tsx` | 上方 toolbar |
| `components/TimingEditorPanel.tsx` | timing program 編輯器 |
| `components/TouchCoincidencePanel.tsx` | face-touch panel |
| `components/DualViewerSplit.tsx` | 雙 viewport 模式 |
| `components/workspace/*` | floating panel framework |

### Backend `app/`

| 檔案 | 角色 |
|---|---|
| `main.py` | FastAPI app + lifespan + WS broadcaster + 所有 router 註冊 |
| `db.py` | async engine + AsyncSessionLocal |
| `config.py` | pydantic-settings (DB url, debug flags) |
| `models.py` | SQLAlchemy DB tables（含 11 個 main entities）|
| `schemas.py` | ★ 所有 Pydantic schemas + per-kind ParamModels + `_accept_legacy_keys` helper + AssetAnchor + selector_normal extractor |
| `crud.py` | generic apply_updates pattern |
| `assembly_solver.py` | direction relation + position relation 求解器；`_anchor_position_local` / `_anchor_direction_local` helper（accept new + legacy keys）|
| `solvers/optical_solver.py` | 後端權威 ray tracer + Jones matrix + Gaussian propagation；`_kp_first` helper |
| `timing_program.py` | timing block validation + 10 ns rounding |
| `websocket.py` | WS broadcast on entity change |
| `routers/assets.py` | Asset CRUD + upload (`/api/assets/upload-component`) |
| `routers/components.py` | Component CRUD + DEFAULT_KIND_PARAMS + auto_create_optical_element_for_object |
| `routers/objects.py` | SceneObject CRUD + scene-level move/rotate/scale endpoints |
| `routers/optical_elements.py` | OpticalElement (kind_params) upsert |
| `routers/optical_links.py` | beam connection links |
| `routers/connections.py` | electrical / RF connections |
| `routers/assembly_relations.py` | 約束關係 |
| `routers/beam_paths.py` | publish ray-trace output |
| `routers/scene.py` | 整個 scene snapshot fetch |
| `routers/scene_views.py` | 多 viewport view configs |
| `routers/collections.py` | outliner collections (move-not-link 模型) |
| `routers/device_states.py` | runtime hot state |
| `routers/timing_programs.py` | timing CRUD |
| `routers/simulations.py` | 觸發後端 solver run |
| `routers/onshape.py` | Onshape import |

---

## 10. Helper / pattern reference

### Backward-compat alias pattern (Pydantic)

每個有 rename 過的 kind class 都有：

```python
class AOMParams(CamelModel):
    acoustic_axis_body_local: list[float] | None = None
    # ... new fields ...

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_field_names(cls, data: Any) -> Any:
        return _accept_legacy_keys(data, (
            ("acousticAxisLocal", "acousticAxisBodyLocal"),
            ("acoustic_axis_local", "acoustic_axis_body_local"),
            # ... old → new pairs ...
        ))
```

API 接受 legacy key 但 emit new key。Frontend reader 也用同樣 pattern：

```ts
const value = params.acousticAxisBodyLocal ?? params.acousticAxisLocal;
```

**Phase 7+ 拔掉 fallback 之前**確認 prod DB 沒有 legacy data 殘留。

### `_accept_legacy_keys` (backend)

`schemas.py` module-level helper：

```python
def _accept_legacy_keys(data: Any, renames: tuple[tuple[str, str], ...]) -> Any:
    if not isinstance(data, dict):
        return data
    out = dict(data)
    for old, new in renames:
        if old in out:
            if new not in out:
                out[new] = out.pop(old)
            else:
                out.pop(old, None)
    return out
```

### Alembic JSONB rewrite pattern

統一 pattern 在 0018 / 0019 / 0020：

```python
def _apply(props: dict, renames: tuple[tuple[str, str], ...]) -> dict:
    out = dict(props)
    for old, new in renames:
        if old in out:
            if new not in out:
                out[new] = out.pop(old)
            else:
                out.pop(old, None)
    return out

def _rewrite(transform) -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, ... FROM ... ")).fetchall()
    for row in rows:
        new_props = transform(row.props, _RENAMES)
        if new_props == row.props: continue   # idempotent
        bind.execute(sa.text("UPDATE ... SET ... = CAST(:p AS JSONB) WHERE id = :id"),
                     {"p": json.dumps(new_props), "id": row.id})

def upgrade(): _rewrite(_apply)
def downgrade(): _rewrite(_reverse)        # invert old/new for rollback safety
```

### Frontend reader fallback (TypeScript)

```ts
const arr = params.surfaceNormalBodyLocal ?? params.normalLocal;
const value = typeof params.fastAxisDegBeamLocal === "number"
  ? params.fastAxisDegBeamLocal
  : typeof params.fastAxisDeg === "number" ? params.fastAxisDeg : 0;
```

### React error boundary（per-kind adjust panels）

`OpticalElementPanel.tsx` 的 `AdjustErrorBoundary` 包住所有 per-kind controls。HMR transient 錯誤被收進 `console.warn`，user-facing 顯示一行 fallback 而不是空白面板。`key={sceneObject.id}` 切換時自動 reset。

---

## 11. Tooling

### Backend

```bash
cd qmem-digital-twin/backend

# Migrations
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m alembic downgrade -1
.venv/Scripts/python.exe -m alembic current
.venv/Scripts/python.exe -m alembic revision -m "description" --autogenerate

# Tests (139 tests as of Phase 6)
.venv/Scripts/python.exe -m pytest -q
.venv/Scripts/python.exe -m pytest tests/test_optical_solver.py -v
```

### Frontend

```bash
cd qmem-digital-twin/frontend

# Dev
npm run dev

# Type check
./node_modules/.bin/tsc --noEmit

# Build (含 tsc + vite build)
npm run build

# Tests (76 vitest tests as of Phase 3)
npm test                       # run once
npm run test:watch             # watch mode
```

### Conventions for adding tests

- Backend pytest in `tests/test_*.py`，async tests 用 `@pytest.mark.asyncio`
- Frontend vitest in `src/**/*.test.ts`，現在主要在 `src/optical/frames.test.ts`

---

## 12. 已知 deferred / open work

### 還沒做的小東西（不急）

1. **拔掉 Phase 4-6 backward-compat fallback** —— 等 prod 部署 + 一段時間 + 確認 legacy data 清乾淨後，可以把 `?? oldKey` 跟 Pydantic `_accept_legacy_field_names` 都拔掉，讓系統 fail-fast
2. **Component.properties 結構性 column promotion** —— audit 顯示 heterogeneity 太高（90%+ 欄位 per-type 不重疊），column promotion cost / benefit 不划算。如果要做，建議 SQLAlchemy polymorphic mapping per `component_type`
3. **SceneObject.properties Pydantic 強型別** —— 13 個 keys 含 solver soft-state，加 typing 會跟 assembly_solver 內部狀態打架
4. **`BeamSegment.propagation_axis_local` SQL column rename** —— 真的 ALTER TABLE，比 JSONB key rewrite 風險高，等實際需求
5. **`relationAnchors.ts` Selector 的 `localDirection`** —— Selector schema 不在 Phase 4 範圍，Selector 也不是 Anchor。如果要清，整個 selector schema 一起改

### 規劃中的新功能

#### Component Editor 模式（規劃過、未實作）

獨立路由 `/component-editor/:componentId`，三欄 layout：
- 左：components-with-functions list
- 中：wireframe-only 3D viewport（單一 component 隔離，TransformControls 拖 anchor）
- 右：anchor inspector（id dropdown、xMm/yMm/zMm、apertureMm）+ kind alignSpec viewer (read-only)

層次設計：
- Layer 4 (instance params) = OpticalElement.kindParams ← Adjust panel 編
- Layer 3 (component template) = Component.properties ← 後端 import 流程
- Layer 2 (asset geometry) = Asset.anchors[] ← **Component Editor 主要編輯**
- Layer 1 (kind contract) = `src/optical/kinds/*.ts` ← 寫 code + PR

詳細設計與分階段計畫：見 git history 上的相關討論。

---

## 13. 部署清單

```bash
# 1. 把 code pull 到 prod box
git pull

# 2. Backend
cd qmem-digital-twin/backend
.venv/Scripts/python.exe -m pip install -r requirements.txt
.venv/Scripts/python.exe -m alembic upgrade head      # 必跑！0018/0019/0020 都要 apply
.venv/Scripts/python.exe -m pytest -q                 # 139 應該全綠
# 重啟 uvicorn

# 3. Frontend
cd qmem-digital-twin/frontend
npm install
npm test                                              # 76 應該全綠
npm run build                                         # 含 tsc + vite build

# 4. 清 dev DB cache（如果有）
# Frontend 的 Zustand store 在第一次連 ws 時會 refresh，所以不用手動清
```

---

## 14. 如何擴充

### 加新 ElementKind（例：Faraday rotator）

1. **Backend**
   - `app/schemas.py`：加 `FaradayRotatorParams(CamelModel)`，把 kind 加進 `kind_params` discriminated union
   - `app/routers/components.py`：`DEFAULT_KIND_PARAMS["faraday_rotator"] = {...}`
   - `app/solvers/optical_solver.py`：實作 `apply_faraday_rotator(beam, params)` 函數
   - 加 alembic migration 註冊新 kind（如果有 enum）
   - `app/utils/opticalDefaults.ts` 同步 (frontend 也有一份)

2. **Frontend**
   - `types/digitalTwin.ts`：加 `FaradayRotatorParams` type，把 kind 加進 ElementKind union
   - `utils/opticalDefaults.ts`：DEFAULT_KIND_PARAMS / KIND_LABELS / KIND_GROUPS / componentTypeToOpticalKind
   - `three/rayTrace.ts`：在 kind switch 加新 branch
   - `components/optical/OpticalElementPanel.tsx`：(可選) 加 `FaradayRotatorAdjustControls`，否則走 generic align

3. **驗證**：pytest + vitest + tsc + 開瀏覽器 spawn 一個試試

### 加新 frame-bearing field

1. 名字必須有 frame suffix：`*BodyLocal`、`*BeamLocal`、`*Lab` 三選一
2. 單位也要 suffix：`*Mm`、`*Deg`、`*Mrad`、...
3. 不要再用 `*Local` —— 會觸發 lint / review review
4. Backend Pydantic 用 `_accept_legacy_keys(...)` model_validator 接受 legacy + new
5. Alembic migration rewrite JSONB（idempotent + reversible）
6. Frontend reader 用 `params.newKey ?? params.oldKey` fallback
7. tsc + pytest + vitest + 瀏覽器手動驗證

### 加新 anchor id

1. `app/schemas.py` 的 `AssetAnchorId` Literal 加新 ID
2. `app/assembly_solver.py` 的 `normalize_anchor_id` aliases 表（如果是別名）
3. Frontend `findSnapToBeam` 的 candidates list（`utils/beamPlacement.ts:1344`）
4. 沒有 alembic migration（Asset.anchors[] 的 id 是 free string，只有 schema 上的 whitelist 強制）
5. 補測試

### 改 frame conversion 慣例（重大！）

只有一個地方改：`src/optical/frames.ts`。改完跑 `npm test` —— 76 個 regression test 會抓出任何不一致。Backend `applyObjectTransform` 等價計算如果也改了要同步 backend solvers。

---

## 15. 關於這份檔案

- **位置**：`qmem-digital-twin/docs/vibe coding.md`（注意檔名有空白）—— 2026-05-07 從專案根目錄搬進 repo 的 docs/，這樣它會跟 code 一起 git track 上 GitHub。更新時也要 commit 進 repo
- **更新原則**：每次 Claude 對 codebase 做改動後，找到對應段落更新內容，**不要 append 新區段**。這樣這份檔案會永遠是 codebase 當下狀態的 snapshot 而不是 changelog
- **如果改動是大架構的**（例如加新 frame、改命名規則、加新 ElementKind），更新到 §3-§7 對應段落
- **如果改動是小細節**（例如一個 helper rename、一個 bug fix），更新對應檔案的 §9 row
- **如果改動跟 Open Work / Future Phase 有關**：把 §12 對應 bullet 移除或標記完成

過去的時序紀錄已在 2026-05-07 13:25 全部 normalize 進這份 snapshot。如果要找歷史變更紀錄，請看 git log。
