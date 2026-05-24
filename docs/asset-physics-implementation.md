# Asset-Physics-Model — 實作計畫

> Status: **規劃中。** 起草於 2026-05-21。
> 對應設計文件:[`asset-physics-model.md`](asset-physics-model.md)。
> 本文件聚焦「**檔案在哪、Phase 做什麼、IO-3-850-HP 怎麼從你已拆好的 5 個 STL 跑通**」。

---

## 0. 跟設計文件的分工

| 文件 | 內容 |
|------|------|
| [`asset-physics-model.md`](asset-physics-model.md) | **設計** — 三層職責、schema、Face/Transition 抽象、範例 |
| **本文件** | **實作** — 檔案結構、DB schema、phase 任務、IO-3 完整走查 |

讀本文件前請先讀設計文件 §1–§5(動機、三層分工、schema)。

---

## 1. 檔案結構總覽

```
qmem-digital-twin/
├── op-core/                                # ★ Phase 5+ 新增 — Rust crate(WASM 共用)
│   ├── Cargo.toml
│   ├── pyproject.toml                      # maturin 設定
│   └── src/
│       ├── lib.rs                          # wasm-bindgen + PyO3 入口
│       ├── beam_ray.rs
│       ├── frames.rs
│       └── kinds/{lens,mirror,polarizer,...}.rs
│
├── assets/                                 # ★ Phase 0~2 重組
│   ├── files/                              # 二進位 CAD(不入 DB)
│   │   ├── stl/
│   │   │   ├── thorlabs_io_3_850_hp/       # ★ 同貨號拆分的 STL 集中
│   │   │   │   ├── input_housing.stl
│   │   │   │   ├── faraday_housing.stl
│   │   │   │   ├── output_housing.stl
│   │   │   │   └── _original.stl           # 留檔(底線排序到最上)
│   │   │   ├── thorlabs_glan_laser_gl10.stl  # 共用 asset 放根目錄
│   │   │   └── ... (其他現有 100+ STL)
│   │   ├── glb/                            # 現有
│   │   └── step/                           # ★ 從 scripts/.step_cache/ 搬過來進版控
│   ├── catalog/                            # ★ 全新 — JSON 定義(seed 來源)
│   │   ├── kinds/                          # 從 backend/data/kinds.json 拆檔
│   │   │   ├── lens.json
│   │   │   ├── mirror.json
│   │   │   ├── polarizer.json
│   │   │   ├── faraday_rotator.json
│   │   │   ├── aom.json
│   │   │   ├── pbs.json
│   │   │   └── ...
│   │   ├── assets3d/
│   │   │   ├── optical/{kind}/{vendor_part}.json
│   │   │   └── mechanical/{role}/{vendor_part}.json
│   │   └── components/{kind}/{vendor_part}.json
│   └── agent_uploads/                      # 不動
│
├── backend/
│   ├── app/
│   │   ├── optical/                        # ★ Phase 1 新 package
│   │   │   ├── __init__.py
│   │   │   ├── registry.py                 # Kind Registry
│   │   │   ├── beam_ray.py                 # BeamRay dataclass
│   │   │   ├── jones.py                    # 偏振 frame 轉換
│   │   │   ├── abcd.py                     # q-parameter 數學
│   │   │   ├── anchor_adapter.py           # 給 Smart Placement / Assembly Solver
│   │   │   ├── ray_tracer_v3.py            # 新 tracer
│   │   │   └── kinds/{kind}/physics.py
│   │   ├── models/                         # ★ Phase 2 拆掉 models.py(1021 行)
│   │   │   ├── __init__.py                 # re-export 維持既有 imports 不破
│   │   │   ├── asset3d.py
│   │   │   ├── component.py
│   │   │   └── scene_object.py
│   │   ├── schemas/                        # ★ Phase 2 拆掉 schemas.py(2594 行!)
│   │   │   ├── asset3d.py
│   │   │   ├── component.py
│   │   │   ├── scene_object.py
│   │   │   └── beam.py
│   │   ├── routers/
│   │   │   ├── assets3d.py                 # ★ Phase 2 新增 CRUD
│   │   │   ├── components.py               # ★ Phase 2 新增
│   │   │   └── asset_upload.py             # ★ Phase 4 STL/GLB import
│   │   └── solvers/
│   │       └── optical_solver.py           # wrap optical/ray_tracer_v3
│   ├── alembic/versions/                   # 0044+ (見 §3)
│   ├── data/                               # ★ Phase 2 後 kinds.json 廢除,manifest 保留
│   │   └── thorlabs_cad_manifest.json
│   ├── scripts/
│   │   ├── seed_v3_assets.py               # ★ 從 assets/catalog/ seed DB
│   │   ├── import_thorlabs_cad.py
│   │   ├── audit_legacy_anchors.py
│   │   └── migrate_kindparams_to_v3.py
│   └── tests/optical/
│       ├── kinds/{kind}/test_physics.py
│       └── parity/
│           ├── test_parity.py
│           └── golden/                     # symlink → frontend/.../golden/
│
├── frontend/src/
│   ├── optical/                            # ★ Phase 1 新增 + 重組
│   │   ├── frames.ts                       # ★ 保留現有(frame 轉換 single source)
│   │   ├── registry.ts                     # Kind Registry
│   │   ├── beam-ray.ts
│   │   ├── jones.ts
│   │   ├── abcd.ts
│   │   ├── anchor-adapter.ts
│   │   ├── ray-tracer-v3.ts
│   │   ├── ray-tracer-v2.ts                # 從 utils/rayTrace.ts 改名,@deprecated
│   │   └── kinds/{kind}/
│   │       ├── physics.ts
│   │       ├── face-template.ts
│   │       └── __tests__/physics.test.ts
│   ├── types/                              # ★ Phase 2 拆掉 digitalTwin.ts
│   │   ├── digital-twin.ts                 # 只留共用 primitive
│   │   ├── asset3d.ts
│   │   ├── component.ts
│   │   ├── scene-object.ts
│   │   └── beam.ts
│   ├── components/
│   │   ├── AssetEditor/                    # ★ Phase 4 取代 PhyEditor + ComponentEditor
│   │   │   ├── AssetEditor.tsx
│   │   │   ├── FacePainter.tsx             # 點 CAD 表面 → 黃色面 UI
│   │   │   ├── TransitionList.tsx
│   │   │   ├── ParamForm.tsx
│   │   │   └── KindTemplatePicker.tsx
│   │   ├── ComponentBuilder/               # ★ Phase 4
│   │   └── SolverResultPanel/              # ★ Phase 3 — UI side state
│   └── state/
│       ├── asset-catalog.store.ts          # ★ Phase 2
│       ├── component-catalog.store.ts      # ★ Phase 2
│       ├── scene.store.ts                  # 現有 enhance
│       └── solver-results.store.ts         # ★ Phase 3 — UI only
│
└── docs/
    ├── asset-physics-model.md              # 設計(現有)
    ├── asset-physics-implementation.md     # 本文件
    ├── optical-kinds-spec-v3.md            # ★ Phase 1 升級
    ├── ARCHITECTURE_OVERVIEW.md            # ★ Phase 2 更新 §3、§10
    └── PLACEMENT_DESIGN.md                 # ★ Phase 4 後更新 snap 認 Face
```

---

## 2. 編排原則速查

1. **CAD 二進位檔不動** — 留在 `assets/files/stl/`、`glb/`(現有 100+ 檔)
2. **同貨號拆分的 STL 用子目錄包** — `files/stl/thorlabs_io_3_850_hp/{input,faraday,output}_housing.stl`
3. **共用 STL 平鋪根目錄** — `files/stl/thorlabs_glan_laser_gl10.stl`
4. **Asset3D JSON 按物理 kind 分,不按 vendor 分** — `catalog/assets3d/optical/polarizer/thorlabs_glan_laser_gl10.json`
5. **Component JSON 跟 Asset3D 完全解耦** — Component 只認 `assetId` 字串
6. **JSON 是 seed source, DB 是 runtime truth** — 啟動時 seed,使用者編輯只動 DB
7. **`geometryRef` 永遠相對 `assets/`** — 例:`files/stl/thorlabs_glan_laser_gl10.stl`

---

## 3. DB / Alembic 計畫

從 0044 開始(現行最新 0043)。每個 migration **reversible**,且**不丟舊資料 — 用 nullable + backfill**,直到該欄位確認沒人用才砍。

| Migration | 內容 | Phase |
|-----------|------|-------|
| 0044 | Asset3D 加 `kind ENUM`、`faces JSONB`、`transitions JSONB`、`default_params JSONB`、`wavelength_range_nm INT[2]`、`body_frame_rotation JSONB`,全 nullable | 2 |
| 0045 | Backfill `kind`:從對應 Component.kind 抄過來 | 2 |
| 0046 | Backfill `faces`:從現有 `anchors` 抽出 `optical_in`/`optical_out`/`optical_anchor` 對應項 | 2 |
| 0047 | Backfill `transitions`:每 kind 用 registry 範本生成 | 2 |
| 0048 | Backfill `default_params`:從 Component.kindParams 抄 | 2 |
| 0049 | SceneObject 加 `param_overrides JSONB`、`dynamic_sources JSONB`,nullable | 8 |
| 0050 | Backfill SceneObject 過載:`properties.kindParamOverride` → `paramOverrides`、`properties.{laserPowerMw,...}` → `dynamicSources` | 8 |
| 0051 | Asset3D 加 `version INT NOT NULL DEFAULT 1`(版本管理) | 2 |
| 0052 | Asset3D 加 `mechanical_anchors JSONB`(從現有 anchors 抽機械項) | 2 |
| 0053 | Seed `catalog/assets3d/**/*.json` 進 DB(idempotent) | 2 |
| 0054 | Seed `catalog/components/**/*.json` 進 DB | 2 |
| ...(Phase 7+ 之後砍欄位)| | |
| 0070 | Drop `Component.kind`、`Component.kindParams`(已遷移完) | 7 |
| 0071 | Drop SceneObject.properties 內已遷出的舊欄位 | 8 |
| 0072 | Drop Asset3D anchor 中的光學項(保留機械項) | 10 |

---

## 4. API endpoint

```
Asset3D
  GET    /api/assets3d                      # list, ?kind=&vendor=&version=
  POST   /api/assets3d                      # create
  GET    /api/assets3d/{id}
  PUT    /api/assets3d/{id}                 # replace (+ version bump)
  DELETE /api/assets3d/{id}                 # soft delete, 拒絕若被 Component 引用
  POST   /api/assets3d/import               # STL/GLB upload → stub Asset3D

Component
  GET    /api/components
  POST   /api/components
  GET    /api/components/{id}
  PUT    /api/components/{id}
  DELETE /api/components/{id}

SceneObject  (現有,擴 paramOverrides / dynamicSources)
  PATCH  /api/scene-objects/{id}            # 部分更新

Solver
  POST   /api/solver/run                    # body: scene snapshot → SolverResult (見 §5)
```

---

## 5. Solver 輸出結構(UI side state)

`SolverResult` 不存 DB,僅由 WebSocket / REST 推回前端 Zustand store:

```typescript
type SolverResult = {
  runId: string
  timestamp: string
  beams: BeamSegment[]                      // 所有 ray 路徑(viewport 渲染用)
  detectors: { [sceneObjectId]: {
    incidentPowerMw: number
    spectrum?: number[]                     // wavelength → intensity
    jonesState?: [Complex, Complex]
  }}
  cameras: { [sceneObjectId]: {
    image: Float32Array                     // 2D intensity map
    widthPx: number; heightPx: number
  }}
  spectrometers: { [sceneObjectId]: {
    wavelengthsNm: number[]
    intensities: number[]
  }}
  warnings: Warning[]                       // beam exceeds aperture, ghost rays, etc.
}
```

前端 `state/solver-results.store.ts` 接收後 fan-out 給各個 `*Panel.tsx`。

---

## 6. 第一個範例 — IO-3-850-HP 完整遷移

這是 Phase 1~3 結束時的「proof of concept」目標。**你已經拆好 5 個 STL 了 — 本節是給你照著做的 step-by-step**。

### 6.1 檔案準備(Phase 0,純整理)

```
# 你現在的 STL 檔案搬到:
assets/files/stl/thorlabs_io_3_850_hp/
├── input_housing.stl                       # 拆出的第 1 段
├── faraday_housing.stl                     # 第 2 段(含 Faraday rod + 磁鐵殼)
├── output_housing.stl                      # 第 3 段
└── _original.stl                           # 原始未拆檔留檔

# Glan-Laser polarizer STL 從 Thorlabs 抓並放:
assets/files/stl/thorlabs_glan_laser_gl10.stl
```

**在 CAD 軟體量出**(用 bbox 中心):
- input_housing 中心相對 IO-3 整體中心 z 偏移:**-18 mm**(假設值,你實測)
- faraday_housing 中心 z 偏移:**0 mm**
- output_housing 中心 z 偏移:**+18 mm**

拆 STL 時建議:**每段 STL 重置為自己的中心**(跟 Glan-Laser 風格一致)。Component binding 再算位置。

### 6.2 寫 Asset3D JSON(Phase 0~2)

#### `assets/catalog/assets3d/optical/polarizer/thorlabs_glan_laser_gl10.json`
```json
{
  "id": "thorlabs_glan_laser_gl10",
  "vendorPart": "GL10",
  "geometryRef": "files/stl/thorlabs_glan_laser_gl10.stl",
  "kind": "polarizer",
  "wavelengthRangeNm": [350, 2300],
  "faces": [
    { "id": "A1", "positionMmBodyLocal": {"x":0,"y":0,"z":-7.5}, "apertureMm": 5, "apertureShape": "circle" },
    { "id": "B1", "positionMmBodyLocal": {"x":0,"y":0,"z":+7.5}, "apertureMm": 5, "apertureShape": "circle" },
    { "id": "A2", "positionMmBodyLocal": {"x":0,"y":0,"z":+7.5}, "apertureMm": 5, "apertureShape": "circle" },
    { "id": "B2", "positionMmBodyLocal": {"x":0,"y":0,"z":-7.5}, "apertureMm": 5, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "A1", "out": "B1", "op": "jones_polarize_p" },
    { "in": "A2", "out": "B2", "op": "jones_polarize_p" }
  ],
  "defaultParams": {
    "extinctionDb": 100000,
    "transmissionAxisDegBodyLocal": 0
  }
}
```

#### `assets/catalog/assets3d/optical/faraday_rotator/thorlabs_io_3_850_faraday.json`
```json
{
  "id": "thorlabs_io_3_850_faraday",
  "vendorPart": "IO-3-850-HP (Faraday core)",
  "geometryRef": "files/stl/thorlabs_io_3_850_hp/faraday_housing.stl",
  "kind": "faraday_rotator",
  "wavelengthRangeNm": [840, 860],
  "faces": [
    { "id": "A1", "positionMmBodyLocal": {"x":0,"y":0,"z":-15}, "apertureMm": 4, "apertureShape": "circle" },
    { "id": "B1", "positionMmBodyLocal": {"x":0,"y":0,"z":+15}, "apertureMm": 4, "apertureShape": "circle" },
    { "id": "A2", "positionMmBodyLocal": {"x":0,"y":0,"z":+15}, "apertureMm": 4, "apertureShape": "circle" },
    { "id": "B2", "positionMmBodyLocal": {"x":0,"y":0,"z":-15}, "apertureMm": 4, "apertureShape": "circle" }
  ],
  "transitions": [
    { "in": "A1", "out": "B1", "op": "faraday_rotate", "abcd": [[1, "L/n"], [0, 1]] },
    { "in": "A2", "out": "B2", "op": "faraday_rotate", "abcd": [[1, "L/n"], [0, 1]] }
  ],
  "defaultParams": {
    "rotationDeg": 45,
    "reciprocal": false,
    "lengthMm": 30,
    "refractiveIndex": 1.93,
    "arResidualR": 0.005
  }
}
```

#### `assets/catalog/assets3d/mechanical/housing/thorlabs_io_3_850_input_housing.json`
```json
{
  "id": "thorlabs_io_3_850_input_housing",
  "vendorPart": "IO-3-850-HP (input housing)",
  "geometryRef": "files/stl/thorlabs_io_3_850_hp/input_housing.stl",
  "kind": null,
  "mechanicalAnchors": [
    { "id": "mount_face_front", "positionMmBodyLocal": {"x":0,"y":0,"z":-9} },
    { "id": "thread_8_32", "positionMmBodyLocal": {"x":0,"y":-15,"z":0} }
  ]
}
```

(同理 `faraday_housing` 與 `output_housing` 各自一個 JSON)

### 6.3 寫 Component JSON(Phase 2)

#### `assets/catalog/components/isolator/thorlabs_io_3_850_hp.json`
```json
{
  "id": "thorlabs_io_3_850_hp",
  "vendorPart": "IO-3-850-HP",
  "wavelengthCenterNm": 850,
  "bindings": [
    { "bindingId": "input_pol",       "assetId": "thorlabs_glan_laser_gl10",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": -18,
      "local_rx_deg": 0, "local_ry_deg": 0, "local_rz_deg": 0 },

    { "bindingId": "input_housing",   "assetId": "thorlabs_io_3_850_input_housing",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": -18 },

    { "bindingId": "faraday",         "assetId": "thorlabs_io_3_850_faraday",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": 0 },

    { "bindingId": "faraday_housing", "assetId": "thorlabs_io_3_850_faraday_housing",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": 0 },

    { "bindingId": "output_pol",      "assetId": "thorlabs_glan_laser_gl10",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": +18,
      "local_rx_deg": 0, "local_ry_deg": 0, "local_rz_deg": 45 },

    { "bindingId": "output_housing",  "assetId": "thorlabs_io_3_850_output_housing",
      "local_x_mm": 0, "local_y_mm": 0, "local_z_mm": +18 }
  ],
  "exposedFaces": [
    { "componentFaceId": "optical_in",  "assetBindingId": "input_pol",  "assetFaceId": "A1" },
    { "componentFaceId": "optical_out", "assetBindingId": "output_pol", "assetFaceId": "B1" }
  ]
}
```

### 6.4 驗證流程(Phase 3 完成後)

1. **Seed**:跑 `python backend/scripts/seed_v3_assets.py` 把 5 個 Asset3D + 1 個 Component 寫進 DB
2. **建 SceneObject**:scene editor 拖入 Isolator,放在 `xMm:0, yMm:0, zMm:0, ryDeg:90`(讓 component +z 對齊 lab +x)
3. **建 Laser SceneObject**:沿 lab +x 朝 Isolator 發射,750 mW @ 850 nm,線偏振 0°(+y_lab)
4. **跑 solver**:預期 viewport 看到 beam 從 laser → 入射 input_pol → 過 → faraday → 過 → output_pol → 出
5. **加 mirror 反射**:在 Isolator output 另一側放 mirror 反射回來,預期 ray 在 input_pol 被擋(因為通過兩個 +45° rotation 累計 90° vs input_pol 的 0°)
6. **檢查 Detector**:擺在 Isolator 反射側的 detector 應該看到 ≈ 0 mW(隔離度 30~40 dB)

---

## 7. Phase-by-phase 工作計畫

### Phase 0:設計凍結 + 檔案搬遷(1~2 週)

| 任務 | 檔案 |
|------|------|
| Review 本文件 + `asset-physics-model.md` | 設計凍結 |
| `mkdir assets/catalog/{kinds,assets3d,components}` | 空骨架 |
| 把現有 `scripts/.step_cache/*.step` 搬到 `assets/files/step/` | 進版控 |
| 拆 IO-3 STL 進 `assets/files/stl/thorlabs_io_3_850_hp/` | 你已部分完成 |
| 下載 Glan-Laser STL 到 `assets/files/stl/thorlabs_glan_laser_gl10.stl` | 從 Thorlabs |

### Phase 1:Kind Registry + lens spike(2~3 週)

| 任務 | 檔案 |
|------|------|
| 建 `frontend/src/optical/{beam-ray,jones,abcd,registry}.ts` skeleton | 純 TS 結構 |
| 寫 `kinds/lens/physics.ts` 實作 `abcd_thin_lens` op | + `__tests__/physics.test.ts` |
| 對應 backend `app/optical/{beam_ray,jones,abcd,registry}.py` | 鏡像 |
| 寫 `kinds/lens/physics.py` + `tests/optical/kinds/test_lens.py` | 鏡像 |
| 建 golden fixture `parity/golden/lens_basic.json` | 餵兩邊比結果 |
| Parity test runner — TS vitest + Python pytest 都讀同一份 fixture | 1e-6 容差 |
| **驗收**:同一個 BeamRay 進 lens,兩邊算出同樣 q-parameter | |

### Phase 2:Asset3D schema 並存(3~4 週)

| 任務 | 檔案 |
|------|------|
| Alembic 0044~0048(加欄位 + backfill) | `backend/alembic/versions/` |
| 拆 `models.py` → `models/{asset3d,component,scene_object}.py` | `backend/app/models/` |
| 拆 `schemas.py` → `schemas/{asset3d,component,scene_object,beam}.py` | `backend/app/schemas/` |
| 拆 `types/digitalTwin.ts` → `types/{asset3d,component,scene-object,beam}.ts` | `frontend/src/types/` |
| 寫 `seed_v3_assets.py` 掃 catalog/ 寫 DB | `backend/scripts/` |
| 新增 routers `assets3d.py`、`components.py` | `backend/app/routers/` |
| 前端 `state/{asset-catalog,component-catalog}.store.ts` | Zustand |
| 把 6.2~6.3 的 IO-3 JSON 全部寫好 seed 進 DB | **第一筆真實資料** |

### Phase 3:Ray Tracer v3 平行存在(3~4 週)

| 任務 | 檔案 |
|------|------|
| `ray-tracer-v3.ts` + `ray_tracer_v3.py`(只支援 lens kind,其他 kind 退回 v2) | 兩端 |
| Feature flag `useV3RayTracer` (URL param + UI toggle) | |
| Parity test:同一場景兩個 tracer 跑 → beam path 容差比對 | |
| 後端 `optical_solver.py` 加 v3 path,routing by flag | |
| SolverResult struct + UI side state(SolverResultPanel) | 前端 |
| **驗收**:IO-3 + laser + detector 場景,v3 tracer 跑通 | |

### Phase 4:逐 kind 切換到 v3(6~8 週)

順序:**lens(Phase 3 已含)→ mirror → polarizer → faraday_rotator → waveplate → AOM → PBS → beamsplitter → dichroic_mirror → fiber_coupler → laser_source / TA → detector**。

每 kind:
1. Frontend `kinds/{kind}/physics.ts` + test
2. Backend `kinds/{kind}/physics.py` + test
3. Golden fixture
4. Parity test 過綠
5. v3 tracer 加進 kind dispatch
6. 場景測試(現有 scenes 切到 v3 → 結果一致)
7. v2 tracer 內該 kind 的程式碼標 `@deprecated`

**Asset Editor v1**(Phase 4 中段):replaces PhyEditor + ComponentEditor。
- `AssetEditor.tsx` 主面板
- `FacePainter.tsx` — 點 CAD 表面 → 半透明黃色面標記 → 調法向 / 形狀 / aperture
- `TransitionList.tsx` — 編輯 transitions
- 從 `kind` 選 → registry 給 face/transition 範本 → 使用者微調

### Phase 5:Rust spike(2~3 週)

| 任務 | 檔案 |
|------|------|
| 開 `op-core/` Rust crate(repo 根) | `Cargo.toml` |
| 用 `wasm-pack` 編 WASM target | |
| 用 `maturin` 編 Python wheel | |
| 把 `abcd_thin_lens` 翻成 Rust(`op-core/src/kinds/lens.rs`) | |
| 前端 `optical/op-core.ts` import WASM,call lens op | |
| 後端 `optical/op_core.py` import Python wheel | |
| Parity test 升級:`TS v3 ≡ Python v3 ≡ Rust WASM` 三方對齊 | |
| **評估**:dev iteration 速度、debug 體驗、build 時間 → 決定 Phase 6 範圍 | |

### Phase 6:Rust ops 全面遷移(若 Phase 5 過)(4~6 週)

逐 kind 翻 Rust,翻完該 kind 砍 TS+Python 實作。

### Phase 7:Component 收緊(1~2 週)

- Alembic 0070 drop `Component.kind`、`Component.kindParams`
- Frontend 刪 v1/v2 kindParams 讀取碼
- 文件 `optical-schema-v2.md` 標 deprecated

### Phase 8:SceneObject 收緊(1~2 週)

- Alembic 0049~0050(加 paramOverrides / dynamicSources + backfill)
- Alembic 0071 drop 舊欄位
- 前後端讀寫程式碼遷移

### Phase 9:Frame 約定強制(1 週)

- 啟動時 runtime assert
- Asset Editor warning UI

### Phase 10:清理(2~3 週)

- Alembic 0072 drop 舊 anchor 光學項
- 刪 v2Bindings.ts、舊 ray tracer
- 刪 `kindParams.{rfPropagationDirectionBodyLocal,...}`
- 文件全面更新

**總時間估**:約 6~9 個月,單人 part-time。若全職可壓 3~4 個月。

---

## 8. 跨語言同步策略(Phase 1~5)

### Golden fixture 路徑
```
frontend/src/optical/__tests__/parity/golden/        # ★ master
├── lens_basic.json
├── lens_off_axis.json
├── mirror_normal_incidence.json
├── polarizer_45deg.json
├── faraday_+45.json
├── aom_3orders.json
├── pbs_back_input.json
└── isolator_io3_forward.json + isolator_io3_reverse.json

backend/tests/optical/parity/golden/                  # → 軟連結到上面
```

### Fixture 格式
```json
{
  "name": "lens_basic",
  "kind": "lens",
  "asset": { "faces":..., "transitions":..., "defaultParams":{"focalLengthMm":50,...} },
  "rayIn": { "origin":[0,0,-100], "direction":[0,0,1], "wavelengthNm":780, "qx":..., "qy":..., "jones":[1,0], "powerMw":1.0 },
  "expectedRaysOut": [
    { "origin":[0,0,2], "direction":[0,0,1], "qx":..., "qy":..., "jones":[1,0], "powerMw":0.995 }
  ],
  "tolerance": { "positionMm": 1e-6, "angleRad": 1e-8, "powerMw": 1e-9 }
}
```

### CI gate
- `frontend: vitest run --reporter verbose` — vitest 過綠
- `backend: pytest backend/tests/optical/parity/` — pytest 過綠
- (Phase 5+)`cd op-core && cargo test` — Rust unit
- PR merge 阻擋直到三者全過

---

## 9. 開放問題追蹤

從設計文件 §11 + 後續討論,以下尚未拍板:

| # | 問題 | 暫定方向 | 何時定 |
|---|------|---------|-------|
| Q1 | Aperture shape circle 留還是砍? | 留 type、UI 不顯示 | Phase 2 |
| Q2 | `Component.kind = "isolator"` 還要不要? | 砍,所有 isolator 走 Component | Phase 7 之前 |
| Q3 | Fiber 是 Asset 還是 Component? | Component(2 fiber_end + 1 dynamic spline) | Phase 4 |
| Q4 | PhysicsOp 前後端 vs WASM? | Phase 1~4 TS+Python,Phase 5 Rust spike,Phase 6 評估 | Phase 5 |
| Q5 | Recursive transition(etalon 多反射)? | PhysicsOp 內部 loop,schema 不動 | Phase 4 |
| Q6 | Smart Placement 過渡期? | AnchorAdapter 包一層,Phase 4 後重寫 | Phase 4 |
| Q7 | Asset Editor UI 互動細節? | 點面 → 黃色面 → 調法向 / 形狀(設計文件 §11 已有 spec) | Phase 4 |
| Q8 | Asset3D 版本與 in-flight 編輯? | optimistic lock `If-Match: version`,changelog 表 | Phase 2 |

---

## 10. 風險與緩解

| 風險 | 緩解 |
|------|------|
| 既有 100+ STL 沒對齊 +z = 光學軸 | Phase 0 跑 `audit_legacy_anchors.py`,不符合者用 `bodyFrameRotation` 補正,不改 CAD |
| Asset Editor 跑不出來 | Phase 4 之前用 JSON 手寫 + seed 腳本,Asset Editor 是 nice-to-have 不擋路 |
| Parity test ε 累積 | Golden fixture 容差固定在 1e-6,出現 drift 立刻調查不放過 |
| Rust toolchain 設置卡關 | Phase 5 spike 評估後再決定 Phase 6 範圍,卡關退回 TS+Python |
| 既有 scene 遷移失敗 | Backfill migration 全 reversible,失敗可 downgrade 退回 0043 |
| 工作量超估 | 每個 Phase 各自可 ship,中間任何點停下都是 working 系統 |

---

## 11. 下一步

1. **本文件 + 設計文件雙審** — 確認 schema、phase 順序、IO-3 範例
2. **Phase 0 動工**:檔案搬遷(IO-3 STL + Glan-Laser STL 進 `assets/files/stl/`)
3. **量測 IO-3 三段 z 偏移**,把上面 §6.2~§6.3 的 JSON 把假設值換成實測值
4. **進 Phase 1**:Kind Registry skeleton + lens spike

過程中若任何 §9 開放問題卡住,即時提出 — 不要硬撐做出 ad-hoc 決定。
