# QMsimulation / qmem-digital-twin — 專案 Snapshot

> 這份檔案是專案目前狀態的**完整參考文件**，從大到小都寫進來：架構 → 規範 → 細節。
> 不是時序紀錄。每次 Claude 對專案做改動後，更新對應段落而不是 append 新區段。
>
> **最後一次完整 normalize：2026-05-08 07:45**（記錄核心架構原則：**PhyEditor 只該寫 Layer 2，不該寫 Layer 3 / Layer 4**。Per-physical-unit physics（TA mode profile + polarization、mirror reflectivity、AOM RF power 等）即使是同型號 vendor template 都會因為 manufacturing tolerance 不同 → 屬於 Layer 4 kindParams、主場景 Object panel 編、不在 PhyEditor。撤回之前的 taChipSpec migration 提議。§12 加 layered design + 「想編這個東西該去哪」對照表）
>
> **最近 update：2026-05-09 — AOM Stage 1 upright mode bug fix**：user 把 MT80 重置到 Euler (0,0,0) 然後 align 0 order,跑出來 `(-3.97e-12, -89.99..., 90)`,預期 `(0, 0, 90)`。Root cause:Stage 1 upright mode 限制錯軸 — 把 D3 朝 lab+Z + D2 = D3×D1,等於把 AOM 側躺(body+X 朝上,acoustic 軸朝水平)。實際物理「upright」意思是 acoustic 軸(= D2 = body+Z for typical AOM)朝上。**Fix**:把 upright mode 的 projectOntoPerp(lab+Z, D1Target) 結果指派給 D2_target,D3_target = D1_target × D2_target。改完 state-B align 跑出 `(0, 0, 90)` ✓,state-A 跑出 `(0, 0, -90)` ✓,跟 `aomBodyFrameBodyLocal` 的 D3 = D1×D2 慣例一致(Phase 7.4 sign convention 不變)。詳 §8 Stage 1 段。
>
> **最近 update：2026-05-09 — DigitalTwinViewer 雙重 perf 優化**：解 user 回報「物件多時轉畫面 / 編 object 卡」。
>
> **(1) On-demand rendering**:`animate` 是連續 `requestAnimationFrame` 60 fps loop,即使 scene 完全靜止也每 frame 把所有 high-poly Thorlabs STL geometry + shadow + antialias 全部重渲一次。改法:加 `let pendingRender = true` + `requestRender = () => { pendingRender = true }` closure,塞進 `requestRenderRef` 給其他 useEffect 用。`animate` 改成 `const cameraMoved = controls.update(); if (cameraMoved \|\| pendingRender) { ...renderer.render(...); pendingRender = false }` — `controls.update()` 在 OrbitControls damping 還沒停時 return true,放開滑鼠後尾段 damping 也會繼續 render 直到 settle。`requestRender` plumb 到:`controls` 'change' event、gizmo `onDraggingChange` + `onDragUpdate`、`handlePointerMove`、`handlePointerLeave`、`resize`。元件最後加 no-deps safety-net `useEffect(() => { requestRenderRef.current?.() })` 每次 React commit fire 一次,捕捉兄弟 useEffect 對 scene 的副作用 mutation。Idle scene = 0 renders/sec(原本 60)。
>
> **(2) Incremental scene rebuild + wrapper cache**:原本 [L2766 那個大 useEffect](qmem-digital-twin/frontend/src/components/DigitalTwinViewer.tsx) 任何 dep 變動 → `clearGroup(componentGroup)` + 重新 `await loadAssetObject(...)` 全部物件(58~284 顆 STL/GLB 重 parse + clone),導致 select/drag/preview 都卡。**改法**:加 `objectWrappersRef = useRef<Map<objectId, { wrapper, componentRef, assetRef, stateRef }>>` 持久 cache。每次 useEffect 跑時用 **reference equality** 三件比對 `(component, asset, deviceState)` 當 cache key — Zustand store 改 selection / preview / activeTool 都不會新建這些 ref,所以全部 cache hit、只要 strip-and-rebuild decorations + apply transform。Cache miss 才 dispose 舊的 + 重新 async load。Sceneobject 從 scene 移除 → cache 裡 orphan 也跟著清。Beam group + relation group 還是 full rebuild(便宜的 line geometry,不值得 cache)。新 `stripDynamicDecorations` helper 透過 `userData.isOutline / isPortLabel / isAomTiltAxisMarker` + 四個 `relation-*` named child 找出可拆 decoration,asset 主體 mesh 保留。Asset 第一個 child 加 `userData.isLoadedAsset = true` 給 cache-hit path 找到原 asset 物件呼叫 `applyObjectGeometryOffset`。Effect cleanup 不再 `clearGroup(componentGroup)`(那會把 cache 弄壞),只 set `cancelled = true`;init useEffect unmount 才整個 dispose + cache.clear()。實測:setSelectedObjects 來回切兩次後 58 顆 wrapper 全部 UUID 不變(58 cache hit / 0 miss);previewObjectTransform 期間 wrapper UUID 不變、position 正確 update + revert。
>
> 詳 §9 DigitalTwinViewer 段。
>
> **2026-05-08 — Viewport mouse-mapping 改回 SOLIDWORKS / Blender 預設**：(1) 左鍵 drag = 相機 ROTATE; (2) 右鍵 drag = PAN; (3) 滾輪鍵 (middle) drag = marquee 框選 (取代左鍵 drag); (4) 右鍵點到 optical_table 不彈 context menu (right-click 主要用來拖 PAN,光桌占大部分視窗空間,popup Hide/Solo menu 太吵)。改動點:`controls.mouseButtons = { LEFT: ROTATE, MIDDLE: null, RIGHT: PAN }`,移掉舊的 `handleMouseButtonRemap` shift-keydown swap 邏輯。`handlePointerDown` 現在接受 button 0 或 1,並把 button 存進 pendingPick 區分。marquee overlay / select 只在 button=1 (middle) drag 觸發;click-pick / beam-scope double-click 只在 button=0 (left) 無 drag 時觸發。`handleContextMenu` 在 picked componentType === 'optical_table' 時 setCtxMenu(null) early-return。其他物件右鍵還是有 Hide/Solo menu。詳 §9 DigitalTwinViewer 段。
>
> **最近 update：2026-05-08 — Phase 7.4.1 state-B Bragg fix**:user 回報 state A (beam→IN→OUT) align 對、state B (beam→OUT→IN) 錯。Root cause:rayTrace.ts 還在 call `effectiveAomOrderForTraversal(orderSign, traversal.sign)` 把 user m 翻號(state B 用 -m),但 Phase 7.4 兩階段 align 已經 per-state 重新 tilt body,body-frame 的 Bragg-correct order 就是 user m 沒翻。結果 state B m=+1 的 plan.order 變成 -1,deflection -2θ_B 從 input·D2 = +sin θ_B 出發 → output·D2 = sin(3θ_B)(off-Bragg);align 那邊看 residual = 0 但物理上 +1 落在三倍角度的位置。**Fix**:rayTrace 把 `effectiveOrderSign = effectiveAomOrderForTraversal(...)` 改成 `effectiveOrderSign = orderSign` 直接用,不再翻 — body-frame 物理慣例(plan.order = user m always),跟 `expectedInputDotD2` 在 align 那邊用的 traversalSign-aware 公式結構性吻合。新增 regression test「rayTrace contract: planOrder=userM gives Bragg-mirror in BOTH states」。131 tests 全綠。Browser-runtime 6 個 (state, m) cases 全部 Bragg-correct。`effectiveAomOrderForTraversal` 仍保留供舊呼叫者 / 未來「無重對齊」場景用,但 align + rayTrace 兩條主路徑都不再叫它。
>
> **2026-05-08 — Phase 7.4 AOM Bragg sign-convention unification**:修掉 align ↔ rayTrace 的 sign drift bug(user 選 ±1 永遠落在 ±3θ_B off-Bragg 位置 → angularFactor → 0 → +1/−1 永遠是 0.1% suppression floor)。Root cause:舊 align 用 `expectedSinTheta = +effectiveOrder·sin(θ_B)` 但 rayTrace 旋轉 `+m·2·θ_B about D3` — 兩者反號,m=+1 要 Bragg-mirror 必須 input·D2 = **−**sin(θ_B)。physics.ts 加三個 single-source-of-truth helper:`expectedInputDotD2`(定義唯一 Bragg sign 慣例)、`diffractedDirection`(Rodrigues 旋轉,rayTrace 直接呼叫)、`aomBodyFrameBodyLocal`(從 anchors + RF 推 D1/D2/D3)。alignToLaser 重寫成兩階段流程:**Stage 1** snap optical axis (D1) ∥ beam,mode 由 `kindParams.stage1RotationMode` 切("min-rot"/"upright"(預設)/"keep-d2")→ 釘住「繞 beam 自轉」這個 free DoF;**Stage 2** 繞 D3 轉 ω = −traversalSignRaw·arcsin(expectedInputDotD2(...)) 達成 Bragg 條件,sign 從 physics.ts 結構性派生 → align/rayTrace 永遠不再 drift。新 `kindParams.stage2SignConvention` 切 "physical-traversal"(預設)vs "lab-fixed"。詳 §5/§8/§9。
>
> **Phase 7 — 7.3 歷史背景**（已被 7.4 取代但欄位保留 read-compat）：contract `intercept_in` + `intercept_out` 必須 apertureMm、entry 由 beam-first t 決定、pivot = anchor 中點、`kindParams.braggInteractionPointMmBodyLocal` 可選 override、alembic 0021 backfill anchors、`KindContract.anchorsNeedingAperture` 通用機制、PHY Editor `AomFaceSection` 顯示 midpoint pivot + 「📌 Pick INTERCEPT_IN/OUT face」 + aperture validation。Phase 7.1 移除 Flip RF + 手動 lab-frame r 旋鈕，改 b̂×â 自動 derive。Phase 7.2 加 `computeBraggTiltAxisBodyLocal` + `braggTiltAngleDegBodyLocal` α slider。Phase 7.3 改 â-independent（ê₀ = body+X projected ⊥ b̂）修「α=270° degenerate 33°」bug。`computeBraggTiltAxis*` helper 在 7.4 不再被 alignToLaser 使用（改成 D3 = D1×D2 直接拿），但留著給 PHY Editor viewport 視覺化用。
>
> **Target architecture planning — 2026-05-10 Asset3D anchors / anchorBindings boundary**：下一版資料模型規劃中，`assets_3d.anchors[]` 只存 reusable physics interaction geometry：`id`、`name`、`type`、`positionMmBodyLocal`、`directionBodyLocal`。`type` 必須是 `PhysicsCapability`（`optical` / `rf` / `em` / `thermal` / `fluid` / `quantum` / `stress`），不是 `component_type`。Anchor 不再放 `aperture`，也不放純機械裝配點、螺絲孔、body center 或 CAD alignment point；object instance 的 geometry-only start/contact points、surface、detector、port payload 改放 `objects.properties.anchorBindings[]`。`anchorBindings[]` 只定義 beam 從哪裡開始、進出、打到哪個面、或被哪個 detector area 接收；不放 wavelength、power、spectrum、polarization、q-parameter、linewidth、reflectivity、gain、RF power、diffraction order 等 propagation / transfer physics。`aperture` 不是獨立 binding kind，而是跟 `opticalSurface`、`opticalPortSurface`、`detectorArea` 一對一；尺寸語意全部用半長：circle `rMm` 是半徑，ellipse `xMm/yMm` 是 semi-axis，rectangle `xMm/yMm` 是 half-width / half-height。`frame` 用來定義 geometry payload 座標如何解讀，surface/port/detector 預設 `anchorLocalXY`，solver 用它做 beam clipping / coupling / lab transform。OpticalPort 建議獨立存在為 beam graph endpoint，但不複製幾何或 beam 參數；port 用 `bindingId` 指到 anchorBinding，再解析到 asset anchor + object pose。`optical_links` 連接 object ports（`fromObjectId/fromPortId` → `toObjectId/toPortId`），binding 由 port 解析，不把 `from_binding_id/to_binding_id` 當 source-of-truth。`freeSpaceMm` 主要應由 pose + binding geometry 推導，必要時才當 cache / override / snapshot。Laser source / emitted beam 參數也屬於 object instance data：放 `objects.properties.opticalSources[]`，每筆 source 有自己的 object-scoped opaque `id`，並用 `bindingId` 指向 output/start binding；beam propagation 參數全部在 source 的 `beam` object。不要用 asset anchor id 當 beam source 主鍵。`components` 在目標架構中只作 catalog / documentation；target 欄位是 `id/name/component_type/brand/model/asset_3d_id/documentation/notes/timestamps`。移除 target `properties` 與 `physics_capabilities`；`componentType` 只是 catalog classification，不代表物理能力。per-instance transfer / interaction physics 留在 `optical_elements.kind_params` / `device_states.state`。`beam_segments` 是 solver output：每段必須從 `objects.properties.opticalSources[].id` 追溯，經 `optical_links` endpoint propagation 與 `optical_elements` interaction 產生 `stateAtStart/stateAtEnd`；不要手動把它當 source beam definition。

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
│   │   └── tests/                 pytest 套件，145 tests
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
│   │   │   │   ├── frames.test.ts 76 個 vitest regression test
│   │   │   │   └── kinds/
│   │   │   │       ├── _registry.ts          ★ KIND_REGISTRY (expected anchors / alignSpec / displayName per kind)
│   │   │   │       └── aom/
│   │   │   │           ├── physics.ts        ★ AOM Bragg / η / Bessel sideband 唯一 source
│   │   │   │           └── physics.test.ts   25 vitest test
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
* anchors[] 只描述 reusable physics interaction geometry
* anchor 欄位：id, name, type, positionMmBodyLocal, directionBodyLocal
* type 是 PhysicsCapability；例如 optical anchor / rf anchor
* 不放 aperture，也不放純機械定位點
* 例：aom_mt80_optical_input、aom_mt80_rf_input

Layer 2 — Component (vendor 規格層)
─────────────────────────────────────────────────────────
* 對應 DB table: components
* 一個 vendor 型號 = 一個 Component row（catalog / documentation）
* 連到一個 Asset3D（asset_3d_id），帶 component_type ("aom", "mirror", ...)
* target 欄位：id, name, component_type, brand, model, asset_3d_id,
  documentation, notes, created_at, updated_at, archived_at
* 移除 target properties；舊 Component.properties 只視為 legacy compatibility
* 移除 target physics_capabilities；PhysicsCapability 從 asset anchors /
  object data / optical elements / connections 推導
* component_type 只是 catalog classification，不代表物理能力
* 例：Thorlabs PBS252、AA Optoelectronic MT80-A1.5-IR

Layer 3 — SceneObject + OpticalElement (instance 層)
─────────────────────────────────────────────────────────
* SceneObject (objects table)：場景上的一顆實際擺位的物件
  - 每個 instance 有自己的 (xMm, yMm, zMm, rxDeg, ryDeg, rzDeg)
  - properties JSONB 帶 per-instance payload，例如 anchorBindings[],
    opticalSources[], locked, objectScale, originOffsetMm, placedRelativeTo
  - anchorBindings[] 連接 asset anchors 與 object-instance geometry-only
    start/contact payload；surface / port surface / detector area 的 aperture 在
    binding payload 裡，尺寸皆用半長
  - anchorBindings[] 不放 beam propagation / transfer physics
  - opticalSources[] 的每筆 source 有自己的 object-scoped id，並用 bindingId
    reference start binding；laser wavelength / power / spectrum / polarization
    / spatialEnvelope / transverseMode 等 propagation 參數放在這裡，不放 Component、Asset 或 binding
* OpticalElement (optical_elements table)：跟 SceneObject 1:1
  - element_kind: "mirror" | "aom" | ... (從 Component 推出)
  - kind_params JSONB: 跟 element kind 相關的 transfer / interaction 物理參數
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

**Phase 7 起手**：物理公式（Bragg θ、η、Bessel J_n、phase mod depth、sideband 強度）從 rayTrace.ts 跟 OpticalElementPanel.tsx 抽進 `frontend/src/optical/kinds/<kind>/physics.ts` 純函數模組，**單一 source**。AOM 已抽完（25 vitest 守住）；其他 kind 待逐步搬。長期目標：rayTrace.ts 跟 optical_solver.py 萎縮成 dispatcher，每個 kind 自己的 physics 模組是唯一公式源頭，frontend / backend 用 parity test 守住一致。

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
| `assets_3d` | id, name, asset_type, file_path, unit ("mm"\|"m"), scale_factor, **anchors JSONB** | target anchors = id/name/type/positionMmBodyLocal/directionBodyLocal；type 是 PhysicsCapability |
| `components` | id, name, component_type, brand, model, asset_3d_id, documentation JSONB, notes, created_at, updated_at, archived_at | target = catalog / documentation 層；移除 properties 與 physics_capabilities |
| `objects` | id, component_id, x_mm, y_mm, z_mm, rx_deg, ry_deg, rz_deg, visible, locked, **properties JSONB** | per-instance pose；target anchorBindings[] 與 opticalSources[] 放這裡 |
| `optical_elements` | object_id (PK + FK to objects), element_kind, **kind_params JSONB**, input_ports, output_ports | 1:1 with object；target kind_params = transfer / interaction physics，不存 laser emitted beam source state |
| `optical_links` | id, from_object_id, from_port_id, to_object_id, to_port_id, status, properties JSONB | beam 連接；endpoint geometry 從 port -> binding -> anchor -> object pose 解析；from/to binding 不作 source-of-truth 欄位 |
| `assembly_relations` | object_a_id, object_b_id, relation_type, selector_a / selector_b JSONB, offset_mm, angle_deg, tolerance_mm, enabled, solved | 約束 (face-touch / direction / position) |
| `beam_paths` | source_object_id, segments[] | trace 結果 |
| `beam_segments` | id, simulation_run_id, source_id, previous_segment_id, optical_link_id, interaction_object_id, interaction_kind, branch, beam_index, state_at_start JSONB, state_at_end JSONB | target = solver propagation output；beam state 從 object optical source 推導，不手動定義 |
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

### Target anchorBindings / OpticalPort / OpticalLink

這段是目前規劃版，尚未代表程式碼已完成 migration。

`objects.properties.anchorBindings[]` 是 object instance 層的 geometry-only anchor-bound payload。Asset anchor 只給 reusable geometry；實際的 start/contact point、surface、port surface、detector area、interaction volume、mode field、calibration point 放在 binding。Binding `id` 用 opaque stable id，不從 object name / anchor name / role 組字串；人類檢索用 `name`、`kind`、`anchorId`、tags。Binding 不放 beam propagation 參數，也不放 transfer physics；那些分別屬於 `objects.properties.opticalSources[].beam` 與 `optical_elements.kind_params`。

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9b01",
  "name": "Mirror reflective surface",
  "anchorId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9b02",
  "kind": "opticalSurface",
  "frame": "anchorLocalXY",
  "payload": {
    "surfaceType": "reflective",
    "aperture": {
      "shape": "circle",
      "rMm": 12.7
    }
  }
}
```

Aperture 不獨立存在，而是跟 `opticalSurface`、`opticalPortSurface`、`detectorArea` 一對一。尺寸語意一律用半長：`circle.rMm` 是 radius；`ellipse.xMm/yMm` 是 semi-axis；`rectangle.xMm/yMm` 是 half-width / half-height。裁切規則直接在 binding frame 的 local X/Y 上算：circle `x^2+y^2<=r^2`，ellipse `(x/xMm)^2+(y/yMm)^2<=1`，rectangle `abs(x)<=xMm && abs(y)<=yMm`。

`frame` 的用途是定義 geometry payload 裡的數字要在哪個座標系讀。`anchorLocalXY` 用於 surface / port / detector：origin 是 anchor position，local normal 是 anchor direction，X/Y 是 aperture 平面。`bodyLocal` 用於 3D volume 或 axis reference。`lab` 保留給量測 / 校準 / solver output，不作為 reusable setup geometry 的預設。Renderer 用 frame 畫 aperture overlay；solver 用 frame 做 clipping、coupling overlap、surface normal 與 lab-frame transform。

OpticalPort 建議獨立存在，因為 beam graph 應該連 port，不是直接連 object；但 port 不複製幾何，也不放 beam propagation 參數。Port 用 `bindingId` 指向 `opticalPortSurface` binding，幾何再由 binding -> anchor -> object pose 解析。

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a11",
  "role": "output",
  "branchKind": "main",
  "name": "Main output",
  "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9b01"
}
```

`optical_links` 連接 object ports。target schema 不把 `from_binding_id` / `to_binding_id` 當 source-of-truth 欄位；binding 由 port 的 `bindingId` 解析。`free_space_mm` 主要應由 object pose + endpoint binding 算出；只有 cache、手動 override、或 simulation snapshot 才需要存。

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a21",
  "fromObjectId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a31",
  "fromPortId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a32",
  "toObjectId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a41",
  "toPortId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a42",
  "status": "valid",
  "properties": {
    "medium": "air",
    "manualDistanceOverrideMm": null
  }
}
```

Recommended target rules now:

- IDs use UUIDv7 strings everywhere: DB rows, asset anchors, anchorBindings, opticalSources, inline OpticalPort records, optical_links, revisions, and simulation_runs.
- `id` is opaque and immutable. `name` is human-facing, mutable, searchable, and may be duplicated.
- Do not encode object name, vendor name, role, branch, or physical meaning into ids.
- `OpticalPort` and `optical_links` are not the same thing. A port is an endpoint on one object; a link is the edge between two object ports.
- Ports stay inline on `optical_elements` for now. Do not make an `optical_ports` table unless ports later need independent CRUD / permissions / lifecycle.
- `optical_links` should not store `from_binding_id` / `to_binding_id` as source-of-truth; resolve those through `fromPortId` / `toPortId`.
- `beam_paths` should be treated as render/cache data derived from `beam_segments`, not authoritative physics state.

Recommended inline `OpticalPort` shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a11",
  "role": "output",
  "branchKind": "main",
  "name": "Main output",
  "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0c9a12"
}
```

`anchorLocalXY` basis is kind/component-defined, not globally guessed. The anchor direction gives local Z / normal. Local X/Y comes from the optical kind contract; if the kind has an anisotropic aperture and cannot derive a stable tangent basis from CAD/body convention, the geometry-only binding payload must include `xAxisBodyLocal`.

| Kind | Local Z / normal | Local X/Y rule |
|---|---|---|
| `laser_source` | output anchor direction | output face convention; circular aperture can ignore roll |
| `mirror` | reflective surface normal | mirror face tangent axes from kind/component contract |
| `lens` | optical axis | lens clear aperture plane; cylindrical lens must define cylinder axis |
| `pbs` / `beam_splitter` | interface normal or port direction | cube/interface convention; branch ports use their own bindings |
| `aom` | optical port direction | X = aperture/acoustic interaction width; Y = crystal height or kind-defined vertical |
| `detector` / `camera` | detector normal | sensor pixel axes |

Per-kind target schema always splits data into three places:

| Layer | Stores | Does not store |
|---|---|---|
| `anchorBindings[]` | geometry-only start/contact/surface/detector/volume payloads | wavelength, power, polarization, RF power, reflectivity, gain |
| `objects.properties.opticalSources[].beam` | emitted beam source parameters | mirror/lens/AOM transfer physics |
| `optical_elements.kind_params` | transfer / interaction physics | reusable CAD geometry or source beam identity |

Strict per-kind optical planning:

Here "object propagation" means object-instance data, primarily `optical_elements.kind_params`; for emitted light it also includes `objects.properties.opticalSources[].beam`. Propagation / transfer fields do not belong in `assets_3d.anchors[]` or `components`.

| Kind | `anchorBindings[]` geometry definition | Object-defined propagation / transfer |
|---|---|---|
| `laser_source` | output position and output direction | source beam is defined by `objects.properties.opticalSources[].beam` |
| `mirror` | reflective surface center and reflective surface normal | reflected / transmitted branches, reflectivity, transmission, coating phase |
| `lens_biconvex` | body center, circular clear aperture / circular faces, two side normals | local focus / focal length behavior, transmission, aberration model later |
| `lens_plano_convex` | plane surface center; normal points from plane center toward convex side | local focus / focal length behavior, orientation-dependent focusing, transmission |
| `waveplate` | body center and in-plane axis vector; this vector is the waveplate short axis | HWP / QWP / arbitrary retardance, retardance phase, wavelength behavior |
| `polarizer` | body center and polarization axis vector | transmission axis, extinction ratio, loss |
| `beam_splitter` | internal reflective / splitting surface and surface normal | reflected / transmitted branches, split ratio, phase convention |
| `pbs` | internal reflective / splitting surface and surface normal | reflected / transmitted branches plus polarization-dependent splitting / extinction |
| `detector` / `camera` / `spectrometer` / `wavemeter` | receiving position and receiving surface normal pointing toward incoming beam | sink behavior: has `from` input and no optical `to` output; responsivity/readout/spectral measurement |
| `fiber` / `fiber_coupler` | connector endpoints A/B, receiving/emitting surface positions, outward surface normals, per-end polarization reference directions | bidirectional propagation from A to B and from B to A, coupling, loss, PM/SM/MM behavior |
| `aom` | optical side endpoints A/B, optical face positions, outward face normals, RF direction | AOM theory computes diffraction order angles and powers from object params |
| `eom` | optical side endpoints A/B, outward face normals, optical polarization reference direction, optional RF direction | EOM theory computes modulation sideband/order powers from object params |
| `nonlinear_crystal` | optical side endpoints A/B, outward face normals, optical polarization / crystal-axis reference direction | nonlinear interaction / phase matching / generated branches from object params |
| `isolator` | optical side endpoints A/B, outward face normals, optical polarization reference direction | forward transmission and reverse isolation from object params |

Per-kind anchor convention details:

- Lens kind is split into `lens_biconvex` and `lens_plano_convex`; surface geometry should not depend on one generic `lens` contract.
- For biconvex lenses, body center is the symmetric reference; the two side normals define optical axis directions for the two circular faces.
- For plano-convex lenses, the plane center is the reference; the plane normal points toward the convex side.
- Waveplate and polarizer both require an in-plane optical axis vector. For waveplate it is the short-axis reference; for polarizer it is the transmission / polarization axis reference.
- Detector-like devices are terminal optical sinks: links enter them, but they do not emit an optical output unless a special reflective/readout model is explicitly added.
- AOM uses outward optical face normals for A/B and a separate RF direction. Diffraction branch geometry is computed from object propagation params, not pre-baked into anchors.
- EOM / nonlinear crystal / isolator use the same A/B outward-face convention as AOM for optical endpoints. RF direction exists only for kinds that physically need it.

BeamSource / BeamState target schema:

- `objects.properties.opticalSources[].beam` is editable source input; `beam_segments.state_at_start/end` are solver output snapshots.
- Carrier source-of-truth is `carrier.wavelengthNm` in vacuum. Do not store editable `centerThz` and `centerWavelengthNm` together; frequency is derived.
- `powerMw` is total optical power. Spectrum line power is represented by `powerFraction`; do not use ambiguous source `amplitude`.
- Enabled `spectrum.components[].powerFraction` values must sum to 1.0.
- `lineshape.kind: "delta"` means ideal zero linewidth and has no width parameter. Real lasers use `lorentzian` / `gaussian` with `fwhmHz`, `voigt` with Gaussian + Lorentzian FWHM, or `measured`.
- Jones polarization is normalized (`|Ex|^2 + |Ey|^2 = 1`) and power stays separate in `powerMw`.
- `spatialEnvelope` describes the continuous Gaussian/q-parameter envelope; `transverseMode` describes modal family/order and does not replace the envelope.

Recommended laser source shape:

```json
{
  "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb01",
  "bindingId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb02",
  "enabled": true,
  "beam": {
    "carrier": {
      "wavelengthNm": 780.241,
      "wavelengthReference": "vacuum"
    },
    "powerMw": 20,
    "spectrum": {
      "normalization": "power_fraction_sum_1",
      "components": [
        {
          "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0cb11",
          "name": "carrier",
          "role": "carrier",
          "offsetMhz": 0,
          "lineshape": {
            "kind": "lorentzian",
            "fwhmHz": 100000
          },
          "powerFraction": 1.0
        }
      ]
    },
    "polarization": {
      "basis": "beamLocalXY",
      "normalization": "unit_jones",
      "jones": { "exRe": 1, "exIm": 0, "eyRe": 0, "eyIm": 0 }
    },
    "spatialEnvelope": {
      "model": "astigmatic_gaussian",
      "x": { "waistRadiusUm": 500, "waistZOffsetMm": 0, "mSquared": 1 },
      "y": { "waistRadiusUm": 500, "waistZOffsetMm": 0, "mSquared": 1 }
    },
    "transverseMode": {
      "family": "HG",
      "m": 0,
      "n": 0,
      "label": "TEM00"
    }
  }
}
```

Laser source per-kind target:

| Layer | Laser source data |
|---|---|
| `anchorBindings[]` | one output/start `opticalPortSurface` binding with aperture and frame; geometry-only |
| inline OpticalPort | one `role: "output"`, `branchKind: "main"` port referencing the output binding |
| `objects.properties.opticalSources[]` | one or more emitted beams, each referencing a start `bindingId` and carrying the editable `beam` definition |
| `optical_elements.kind_params` | no beam propagation fields; only device-level non-beam metadata if needed later |

Laser source initialization:

```text
source.bindingId
  -> anchorBindings[].payload gives output aperture / frame
  -> anchorBindings[].anchorId gives asset anchor position + direction
  -> object pose transforms anchor geometry to lab frame
  -> source.beam initializes carrier, power, spectrum, polarization, spatialEnvelope, transverseMode
  -> solver creates BeamState_0 with sourceId and start geometry
```

Revision / snapshot split:

- `Revision` stores scene input state: objects, optical_elements.kind_params, objects.properties.anchorBindings, objects.properties.opticalSources, optical_links, assembly_relations, and asset/component references.
- `SimulationRun` stores solver output: beam_segments, beam path render cache, warnings, solver version, and the source revision id.
- Do not mix `beam_segments` into the canonical scene revision. They are artifacts of a solver run linked to a revision.

Recommended `Revision` / `SimulationRun` shapes:

```json
{
  "revision": {
    "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca01",
    "name": "Before AOM alignment",
    "sceneInput": {
      "objects": [],
      "opticalElements": [],
      "opticalLinks": [],
      "assemblyRelations": []
    },
    "assetRefs": [],
    "componentRefs": []
  },
  "simulationRun": {
    "id": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca11",
    "revisionId": "018f2c8e-8d4b-7c20-a5d3-1e4b7b0ca01",
    "solverVersion": "optical-solver-v1",
    "status": "completed",
    "warnings": [],
    "outputs": {
      "beamSegments": [],
      "beamPathCache": []
    }
  }
}
```

### Target beam propagation trace

`beam_segments` 是 solver output，不是使用者手動建立的 beam source。Beam source 只從 `objects.properties.opticalSources[]` 來：

```text
objects.properties.opticalSources[].beam
  -> initialize BeamState_0
  -> opticalSources[].bindingId selects the object-local start binding
  -> anchorBindings[].anchorId resolves the asset anchor position / direction
  -> optical_links connects optical ports and resolves endpoint bindings
  -> endpoint bindings + object poses give free-space distance / direction
  -> optical_elements.kind_params applies interaction physics
  -> beam_segments stores stateAtStart / stateAtEnd snapshots
```

Target `beam_segments` rules:

- `source_id` points to `objects.properties.opticalSources[].id`.
- `previous_segment_id` links the propagation chain.
- `optical_link_id` identifies the graph edge being propagated.
- `interaction_object_id`, `interaction_kind`, and `branch` record what produced the current branch, e.g. `mirror/reflected`, `pbs/transmitted`, `aom/+1`.
- `state_at_start` and `state_at_end` are computed snapshots. They are not source of truth.
- Spectrum, spatial q/envelope, polarization, and power in a segment must be derived from the source beam plus propagation / interaction. They should not be edited directly.

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
| **0021** | aom_default_anchors | Phase 7：對所有 `component_type='aom'` 的 Asset3D 補上 default `intercept_in` / `intercept_out` anchors（座標從 dimensionsMm + opticalAxisFromEndMm + activeApertureMm 算）。Idempotent — 已有 port anchors 的 row 不動。配合新 AOM align contract（必須兩個 port 都有 apertureMm）。SQL 用 `c.asset_3d_id`（注意 underscored numeric form，不是 `asset3d_id`）|
| **0022** | fiber_radius_1mm | 2026-05-09：fiber jacket 預設半徑 1.5 → 0.5 mm。**已被 0023 接續調整**（user 第一次說「直徑 1mm」，0022 配合；第二次釐清要的是「半徑 1mm」，0023 再從 0.5 → 1.0）。Strict eq backfill；自訂值不動 |
| **0023** | fiber_radius_r1 | 2026-05-09：接 0022，fiber jacket 預設半徑 0.5 → 1.0 mm（半徑 1 mm = 直徑 2 mm，最終 user-spec'd 值）。frontend 三個 default fallback + `seed.py` 同步從 0.5 改 1.0 |
| **0024** | fiber_anchors | 2026-05-09：fiber 接入 standard anchor model — 給每個 fiber `Component.properties` 加 `fiberAnchors[]`（`intercept_in` / `intercept_out`，connector body-local mm，預設 ferrule tip `(0, 36.28, 0)`，aperture = 2.5 mm = ferrule metal sleeve OD）。優先 backfill 自 legacy `OpticalElement.kindParams.endA/B.facePositionMmBodyLocal`，沒值就用 ferrule-tip default。Idempotent — 既有 `fiberAnchors` row 不動。SQL JOIN 用 table 名 `objects`（不是 `scene_objects`，命名雷） |
| **0025** | fiber_anchors_rs | 2026-05-09 follow-up：0024 的 legacy backfill 讀到的 `kindParams.endA/B.facePositionMmBodyLocal` 不是預期的 connector body-local mm（裡頭是 lab-frame spline endpoint coords + 計算出的 unit-vector direction）。0025 用 heuristic（任一 axis 偏離 ferrule tip > 30 mm 就視為 polluted）reset 到 default。User 之前實際手動設過的 anchor（在 ferrule tip ±30 mm 範圍內）保留 |

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
  apertureMm?: number                 // scalar half-width (circular)
  apertureWidthMm?: number            // ★ rectangular: PBS / BS cube diagonal
  apertureHeightMm?: number           //   cement plane is rectangular not square
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
  brand?: string
  model?: string
  documentation?: {                   // human-facing only; not solver input
    datasheetUrl?: string
    productUrl?: string
    sourceUrl?: string
    description?: string
  }
  notes?: string
  // target removes properties + physicsCapabilities.
  // Existing code may still read legacy properties during migration only.
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
                   braggTiltAxisDegLab?,
                   braggInteractionPointMmBodyLocal?,    // ★ Phase 7: optional pivot
                                                         // override; default = midpoint
                                                         // of intercept_in / out
                   ... }
```

### `src/types/units.ts`

見 §4 的 brand types。

---

## 7. ElementKind 各 kind 詳解

### Active emitters

| Kind | 主要 params | 說明 |
|---|---|---|
| `laser_source` | target source params live in `objects.properties.opticalSources[].beam`: `carrier.wavelengthNm`、`powerMw`、`spectrum`、`polarization`、`spatialEnvelope`、`transverseMode` | 光源；beam 不放 `kind_params` |
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
| `fiber` | 整條光纖 patch cable（雙向）：`fiberType`、`endA/endB: FiberEndSpec`（aperture / NA / MFD / connector / polish / Fresnel residual / glass index / **PM slow axis**）、`cutoffWavelengthNm`、`operatingWavelengthRangeNm`、`designWavelengthNm`、`maxInputPowerMw`、`attenuationCurve[]`、`bendLoss: BendLossConstants`、`minBendRadiusMm`、`birefringenceDeltaN` (PM)、`pmdCoefficientPsPerSqrtKm`、`polarizationExtinctionRatioDb` (PM)、`bandwidthMhzKm` (MM) | 自定 align：`alignFiberEndToBeam(componentId, "A"\|"B", toleranceMm=25)` 把 endpoint anchor 投影到最近 beam segment，並把該端 handleIn/handleOut 對齊到 beam 切線方向；只動該端，內部節點不動。詳見 §16 「Fiber 系統（Phase A–J）」 |
| `isolator` | `forwardLossDb`、`isolationDb`、`transmissionAxisDegBeamLocal` | translate intercept_in → beam |

### Active / nonlinear

| Kind | 主要 params | Align |
|---|---|---|
| `aom` | `centerFreqMhz`、`refractiveIndex`、`figureOfMeritM2`、`crystalLengthMm`、`acousticBeamWidthMm`、`rfDrivePowerW`、**`acousticAxisBodyLocal`**（asset metadata，Phase 7.1 起 UI 不再可改）、`rfPropagationDirectionBodyLocal`（同）、`diffractionOrder ∈ {-1,0,+1}`、`maxDiffractionOrder` (≤10)、`sidebandVisibilityThreshold`、`braggAngularAcceptanceMrad`、~~`braggTiltAxisDegLab`~~（Phase 7.1 起不被 align 讀取，schema 保留供舊資料相容；align 改自動推 tilt 軸 = b̂×â）、**`braggInteractionPointMmBodyLocal?`**（Phase 7 optional pivot override）| **Phase 7 (2026-05-08)**：anchor 合約改成 required `intercept_in` + `intercept_out`，**兩者都要 apertureMm**（PHY Editor Save validate + runtime align validate）。Align：(1) 把兩個 anchor 用當前 pose 投到 lab，對每條 upstream beam 算 perpendicular miss + forward t；取 (anchor, beam) miss 最小 + t≥0 + 沒有 ambiguous（兩 anchor 都打中且 t 差距 < 一個 aperture diameter 就 abort）的當 entry。(2) 1-D ω 掃描繞 lab tilt-axis 滿足 `dir·acoustic = orderSign·sin(θ_B)`，pivot = `(intercept_in.pos + intercept_out.pos)/2`（= acousto-optic interaction 點；override 走 `kindParams.braggInteractionPointMmBodyLocal`）。(3) 旋轉後 translate scene object 把 entry anchor 落在 beam line 上。Aperture clipping warning：上游 component beamWaistMm > entry apertureMm → feedback 加 `⚠`。錯誤訊息分五類（缺 anchor / 缺 aperture / 沒 forward beam / ambiguous entry / Bragg 殘差）|
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
| AOM | `AomAdjustControls` (取代 generic) | RF power slider、Max η、Output order ±1/0、Align AOM port + Bragg。**Tilt axis 由 PHY Editor 上的 α (`component.properties.braggTiltAngleDegBodyLocal`) 控制**（Phase 7.3，**â-independent**）— α 是 1-DoF body-local 角度，τ̂(α) = cos(α)·ê₀ + sin(α)·(ê₀×b̂)；ê₀ = body+X projected onto ⊥-b̂。對 b̂=body+Y 來說：α=0°→body+X、α=90°→body+Z、α=180°→-body+X、α=270°→-body+Z（preset 跟 body axis 對應一致，跟 â 無關）。**(Phase 7.1 移除 Flip RF + 手動 lab-frame r)** — `acousticAxisBodyLocal` 已決定 â、`diffractionOrder` 選 ±1/0 哪一邊；舊 lab-frame `braggTiltAxisDegLab` schema 欄位保留供舊資料讀取、但 align 不再讀取 |
| TA | `TaperedAmplifierAdjustControls` | Drive current、ASE / Gain samples、`alignInputToLaser` (anti-parallel 25 mm) |

### AOM `alignToLaser` 演算法（Phase 7.4 兩階段重寫）

physics.ts 是 Bragg 幾何唯一 source；align 跟 rayTrace 用同一組 helper 計算 sign，不再各自 hard-code（Phase 7.4 的核心 invariant）。Body 命名約定：D1 = unit(intercept_out − intercept_in)（optical axis）、D2 = `rfPropagationDirectionBodyLocal`（acoustic / RF axis）、D3 = D1 × D2（Bragg rotation axis）。對 canonical MT80 來說：D1 = body+Y、D2 = body−X、D3 = body+Z。

**Bragg 條件**只約束 beam 的 D2 分量：`beam·D2 = expectedInputDotD2(m, traversalSign, θ_B)` = `−m·traversalSign·sin(θ_B)`。leading 負號 = sign-bug 修法的核心：rayTrace 旋轉 `+m·2·θ_B about D3`，要 m=+1 落到 Bragg-mirror 必須 input 在 D1 的 **反**側。

流程：

0. **Validate contract**：Asset 有 `intercept_in` + `intercept_out`，兩 anchor 都有 `apertureMm > 0`。`aomBodyFrameBodyLocal(in, out, rf)` 推 D1/D2/D3，degenerate（in≡out 或 rf‖D1）直接 abort。

1. **算 anchor lab 位置**（用當前 SceneObject pose）：body-local Z-up mm 經 `rotateLabDir` → lab Z-up mm。

2. **挑 entry**：對每條 upstream beam segment（排除自己），把 in/out 兩 anchor 投影到 beam line。t≥0 且 miss ≤ 25 mm 的優先；兩個都符合取較小 t（beam 先到）。跨 beam 比 miss、全域取最小。

3. **Ambiguity guard**：同一條 beam 兩 anchor 都在 tolerance 內且 `|t_in − t_out| < 2 × apertureMm` → AOM ≈ 垂直 beam，無法判斷誰 entry → abort 要求先手動轉。

4. **State 判定**：`traversalSignRaw = aomTraversalSignFromEntryPort(best.portId)`（+1 = entry=in = state A，−1 = entry=out = state B）。`stage2SignConvention` 為 `"lab-fixed"` 時把 expectedInputDotD2 用的 traversalSign 強制 = +1（user 看到的 +1 永遠在 lab 同一邊）；`"physical-traversal"`（預設）則用原值（state-B 反向使用時 ±1 lab side 翻轉）。

5. **Stage 1 — snap optical axis ∥ beam**。`D1_target = +beam`（state A）或 `−beam`（state B）。剩下「繞 beam 自轉」的 1-DoF 由 `kindParams.stage1RotationMode` 釘住：
   - `"upright"`（**預設**）：**D2_target** = lab+Z 經 ⊥D1_target 投影正規化（fallback +Y → +X），D3_target = D1_target × D2_target。AOM body 的 acoustic 軸（= D2 = body+Z for typical AOM）永遠朝上，等於底座貼在水平光桌。**2026-05-09 bug fix**：之前這條限制錯軸 — 寫成 D3 朝 lab+Z + D2 = D3×D1，等於把 AOM 側躺（body+X up）。重置 AOM 到 (0,0,0) 然後對 +X beam state-B align 會跑出 (0, **-90**, 90) 而不是預期的 (0, 0, 90)。改成限制 D2 後 (0, 0, 90) 對。
   - `"min-rot"`：用最小角度旋轉（axis = current_D1 × D1_target）把現在的 pose 拉到目標，對 D2、D3 套同一個 dq。對既存姿態擾動最小。
   - `"keep-d2"`：D2_target = current_D2 經 ⊥D1_target 投影正規化，D3_target = D1_target × D2_target。RFin port 朝向不變。
   完整目標 frame = {D1_t, D2_t, D3_t}，注意 D3 = D1 × D2 跟 `aomBodyFrameBodyLocal` 的 body 端慣例對齊（Phase 7.4 sign convention）。

6. **Build Stage 1 quaternion**：absolute rotation `R = M_target · M_body⁻¹`，其中 M_body / M_target 用 `THREE.Matrix4.makeBasis(D1, D2, D3)` 各自建好，body-local 到 world target frame 的 mapping。`stage1Quat = setFromRotationMatrix(R)`。

7. **Stage 2 — Bragg rotation**。`expectedDotD2 = expectedInputDotD2(currentOrder, traversalSignForExpect, θ_B)`，`ω = −traversalSignRaw · arcsin(expectedDotD2)`。為什麼這個 sign：post-Stage-1 beam = s·D1_target（s = ±1），繞 D3_target 轉 ω → `beam·D2_new = −s·sin(ω)`，要 = expectedDotD2 → `ω = −s·arcsin(expectedDotD2)`，s = traversalSignRaw。`finalQuat = stage2DeltaQuat · stage1Quat`。

8. **Translate entry on beam**：用 finalQuat 旋轉 body-local entryBody offset 到 lab，再把整個 SceneObject 平移到 `best.closest − rotatedEntryDelta`，讓 entry anchor 落在 beam line 上 `best.closest` 點（已經是 entryLab 對 beam line 的垂足，所以一次到位）。

9. **Verify Bragg**：算實際 `beam·D2_new` 跟 `expectedDotD2` 的差距 → `residualMrad` 報給 user（≈0 時 align 成功）。

10. **Aperture clipping warning**：上游 `component.properties.beamWaistMm > entry.apertureMm` → feedback 加 `⚠ upstream beam waist X mm > entry aperture Y mm — beam will clip`（不擋 align）。

11. **Persist + feedback**：`updateSceneObject` 寫 xMm/yMm/zMm 跟 rxDeg/ryDeg/rzDeg；feedback 文字含 stage1Mode、ω、state、m、residual。

物理（公式都在 `optical/kinds/aom/physics.ts` 單一 source）：
- Bragg angle: `θ_B = arcsin(λ·f / (2·n·v))` → `braggAngleRad(params, λnm)`
- **Bragg input target（Phase 7.4 新增）**: `beam·D2 = −m·traversalSign·sin(θ_B)` → `expectedInputDotD2(m, traversalSign, θ_B)`
- **Diffracted output（Phase 7.4 新增）**: 繞 D3 轉 `+m·2·θ_B`(Rodrigues)→ `diffractedDirection(input, D3, m, θ_B)`，rayTrace 直接呼叫
- 繞射效率: `η = sin²((π·L / 2λ·cosθ_B) · √(2·M₂·P_d / W))` → `diffractionEfficiency(...)`
- Raman-Nath: `|n| ≥ 2` 用 Bessel `J_n²(v)` 算 sideband intensity → `sidebandIntensitiesOnBragg(...)`
- Max η 一鍵: 反解 `arg = π/2` → `rfPowerForPeakEfficiencyW(...)`

**Sign-bug 防護**：54 physics tests 含 (state ∈ {A, B}) × (m ∈ {−1, +1}) round-trip matrix — 模擬 align target 後跑 `diffractedDirection`，assert 輸出 `output·D2 = −expectedDotD2`（Bragg-mirror）。任何人改 expectedInputDotD2 / diffractedDirection 兩者之一沒同步另一個 → 這些 test fail 直接 surface 不一致，不會像 7.4 之前那樣 silent drift。

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
| **`optical/kinds/_registry.ts`** | ★ `KIND_REGISTRY: Record<ElementKind, KindContract>`：每個 kind 的 expected anchors (required + optional)、**`anchorsNeedingDirection`**（mirror / dichroic_mirror 的 `intercept_face` 必須帶法向方向，否則 ray-tracer 不知道哪一側反射）、align variant、tolerance、人類可讀的 align summary。OpticalKindsEditor + OpticalComponentEditor 都從這裡讀。MVP 是 hardcoded TS const；未來 (P8/P9) 可搬部分到 DB |
| **`optical/kinds/aom/physics.ts`** | ★ AOM 物理 + Bragg 幾何唯一 source。Bragg θ_B、closed-form sin² η、Bessel J_n、phase mod depth、sideband intensities、RF power inverse。**Phase 7.4 新增**：`expectedInputDotD2(m, traversalSign, θ_B)` = `−m·traversalSign·sin(θ_B)` 是 align 的 Bragg target、`diffractedDirection(input, D3, m, θ_B)` 是 rayTrace 的 deflection rotation、`aomBodyFrameBodyLocal(in, out, rf)` 從 anchors + RF 推 D1/D2/D3。`Stage1RotationMode` / `Stage2SignConvention` enum + DEFAULT_*。被 AomAdjustControls (alignToLaser) + rayTrace.ts 共用,sign 結構性派生不再 drift |
| **`optical/kinds/aom/physics.test.ts`** | 54 個 vitest 守住公式 + Bragg sign convention（J_n 序列收斂、Bragg 角度數值、η ∈ [0,1]、sideband 總和歸一、Max η inverse 自洽、`expectedInputDotD2` sign matrix、`diffractedDirection` Rodrigues、(state, m) round-trip Bragg-mirror — 防 Phase 7.4 sign-bug 復發）|
| **`components/PhyEditor.tsx`** | ★ PHY Editor 全頁面 wrapper（活化條件 `editorMode === "phy-editor"`）。Top bar (Back to scene + 標題 + 全域 dirty 指示) + 兩欄：左 rail PHY domain 樹 + 右 pane host 子 editor。Tab 切換 / Back 都檢 `phyEditorDirty` 彈 confirm |
| **`components/OpticalKindsEditor.tsx`** | optical_kinds 子 editor (read-only)：渲染 KIND_REGISTRY 的 20 個 kind 為卡片，顯示 displayName / variant / tolerance / required + optional anchor pills / alignSummary。頂部黃色 banner 提示「contract live in code, edit via PR」 |
| **`components/OpticalComponentEditor.tsx`** | optical_component 子 editor。三欄 layout（左 component list / 中 isolated wireframe viewport + TransformControls + marker direction ArrowHelper（單向 or 雙向，由 `setBidirectional` 控制）+ **黃色面外框 LineSegments**（picked face / hover preview）+ **黃色半透明 face preview fill**（`setFacePreview`；直接用 `computeCoplanarFace` 回傳的 `faceTrianglesWrapperThree`，所以 hover / click 顯示的是實際 wireframe mesh face，不是合成方形 helper）+ **`.editor-viewport-tools` overlay**（top-center, viewer-tools-pie 風格 on-canvas 工具）/ 右 inspector）。**Marker 大小**：`meshSpan` lazy 計算自 mesh-only bbox。**Hover preview**：pick mode 時 `pointermove` rAF-throttled raycast → `computeCoplanarFace` → `setFaceHighlight()` + `setFacePreview()`。**Stable callback ref**：`handlePickFace` 透過 `handlePickFaceRef` + `stablePickFaceCallback` 餵給 useViewport，避免 stale closure。**Custom-UX kinds**（`hasCustomEditorUX = isSingleFaceKind \|\| isTaperedAmplifierKind \|\| isAomKind \|\| isFiberKind`）：隱藏通用 list/+Add/dropdown/delete、自動建 anchor drafts、inspector 顯示對應 kind 的 section component。共六系列：

- **Mirror / dichroic_mirror（single-anchor `intercept_face`）**: 「📌 Pick reflective face」+ +/− side。
- **Lens（single-anchor `intercept_in`）**: 模式 toggle [Plano-Convex] / [Bi-Convex]；Plano `handlePickFace` 對 lens 把法線**翻轉**（光是 INTO body），UI「+ into body / − out of body」；Bi-Convex「📍 Snap to body centre」+ X/Y/Z 光軸，arrow 雙向。
- **Waveplate（single-anchor `intercept_in`）**: 「📌 Pick flat face」設位置 + X/Y/Z fast-axis 按鈕設 directionBodyLocal。
- **Beam-splitter / PBS（single-anchor `intercept_in`，rectangle aperture）**: 對角介面在 cube 內部不能 face-pick — 改用「📍 Snap to cube centre」+ 6 顆 face-aligned 對角方向按鈕（+X+Y / +X−Y / +X+Z / +X−Z / +Y+Z / +Y−Z）+「⇄ Flip」反向 coating normal；用 `setInterfacePlane()` 渲染半透明黃色 PlaneGeometry rectangle 視覺化對角介面（widthMm × heightMm 由 anchor.apertureWidthMm/HeightMm 決定）。PBS vs BS 暫時從 instance kindParams.polarizing 推斷。
- **Tapered Amplifier（dual-anchor: `intercept_in` + `intercept_out`，scalar aperture）**: 第一個 multi-anchor kind。Viewport 兩顆 Pick 按鈕（INPUT / OUTPUT）共用 pickFaceMode 但用新 `pickFaceTarget` state 區分要寫入哪個 anchor。兩個 direction 都是 **OUTWARD face normals**（光從 −intercept_in.dir 進、從 +intercept_out.dir 出）；INPUT 跟 OUTPUT 不一定對立面（side-output / shaped TA chip 任意夾角都合法），所以**沒有** anti-parallel 健康檢查 — 只顯示 `INPUT–OUTPUT angle: N°` 資訊。`<TaperedAmplifierFaceSection>` inspector 兩個 port 各一個 EditableAnchorFields（scalar aperture）+ 角度顯示。Per-instance 物理 (mode profile / polarization / ASE / gain / drive current) 仍在主場景 TaperedAmplifierAdjustControls 編 — 未來可考慮搬到 Component.properties.taChipSpec 變成 Layer 3 vendor-spec。
- **Fiber Patch Cable（procedural dual-anchor: `intercept_in` + `intercept_out`，scalar aperture）**: fiber 沒 Asset3D row，但 `loadAssetObject(component, undefined)` 會在 PHY Editor viewport 直接渲染 Bezier cable + FC connector mesh，所以 End A / End B 現在跟 TA 一樣有兩顆 Pick face 按鈕，`pickFaceTarget` 分別寫入 `Component.properties.fiberAnchors[]`。Pick mode 優先 raycast 真正 connector mesh：APC 端的 emission 出口在 model 裡就是 8° slanted face，點得到模型斜面時 `computeCoplanarFace()` 直接取這個 mesh face 的 centroid + normal；只有沒有 mesh hit（例如點在空洞中心）才 fallback 到黃色 aperture ring / transparent larger hit disk，把 anchor 設到圈中心。PC/UPC ring 平面垂直 ferrule axis；APC ring 會依 `polishAngleDeg`（保留 stored sign，seed default +8°）傾斜，ring helper 寫入 APC slanted-face normal，而不是直直往外的 ferrule axis。Fallback toolbar buttons: `End A ring` / `End B ring` 也走同一個 `fiberDefaultPortAnchor()` / `fiberPolishedNormalBodyLocal()` helper。Fiber viewport 隱藏 anchor center sphere（material opacity 0，仍保留透明 pick/gizmo target），label / normal arrow 用較小 marker scale（0.45，arrow span 0.13）避免遮住 mm-scale connector face；`setFiberSlowAxes()` 會在 End A / End B port 旁畫 cyan slow-axis rod + `A slow` / `B slow` label，跟 Waveplate-style `X/Y/Z` unsigned-axis buttons 即時同步。Anchor 座標是 procedural fiber body-local mm（從實際 connector face pick 或 aperture ring / hole-center helper 出來），defaults 由 endpoint spline node + connector outward * 36.28 mm 算，不再把 `(0,36.28,0)` 當全域固定點。PM slow axis 不混用 face normal；UI 用 Waveplate-style `X/Y/Z` unsigned-axis buttons 寫 `Component.properties.fiberKindParamsOverride.endA/B.slowAxisAxisBodyLocal`，並保留 legacy `slowAxisDegInBodyFrame`（X=0°, Z=90°；Y 無 legacy 角度等價，fallback 0°）供舊資料相容。Save 同時保存 `fiberAnchors[]` 與 fiber kind override。

**全部** kind section 都用 `<EditableAnchorFields>` 共用 helper（X/Y/Z position、nX/nY/nZ direction、scalar 或 rectangle aperture 鍵盤輸入）。**Anchor schema** 新增 `apertureWidthMm` / `apertureHeightMm` 欄位（前後端 Pydantic CamelModel optional、向後相容），給 BS 對角介面跟 TA chip waveguide 這種長方形 active 區域用。**其他 kind 走通用 UX**：Anchor list + Selected coordinate-grid + Pick face 按鈕。`computeCoplanarFace(hit, wrapper)`：`mergeVertices(rawGeometry, 1e-6)` dedup non-indexed STL → BFS adjacency（5°）→ centroid + 平均法線 + 邊界 edges → wrapper-local Y-up。Save → `updateAssetApi`。Dirty mirrored to `phyEditorDirty` |
| `types/digitalTwin.ts` | 全部 domain types |
| `types/units.ts` | brand types + Frame enum |
| `types/visibility.ts` | collection visibility helpers |
| `three/transformUtils.ts` | re-export from frames.ts + `applyObjectTransform`（用 `target.quaternion.copy(sceneObjectToQuaternion(...))`）|
| `three/rayTrace.ts` | 前端 ray tracer：emission、reflection、refraction、Jones polarization、AOM diffraction（Phase 7.4 改用 `diffractedDirection` + `expectedInputDotD2` from physics.ts、sign 跟 alignToLaser 結構性一致）、TA gain、~1700 行 |
| `three/loadAsset.ts` | GLB / STL loader + procedural primitives (createAom 等)、anchor placement、apertureForwardMmBodyLocal 處理。**`createTextAnnotation(component)`** 把 `componentType: "text_annotation"` 渲成 canvas-textured rounded-rectangle billboard sprite（讀 `properties.text/textColor/bgColor/accentColor/fontSizePx/scaleMm`），sprite 標 `userData.isTextAnnotation = true` |
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
| **`components/PhyEditor.tsx`** | ★ PHY Editor 全頁面 wrapper（活化條件 `editorMode === "phy-editor"`）。Top bar (Back to scene + 標題 + 全域 dirty 指示) + 兩欄 layout：左 rail (PHY domain 樹：Optical 展開含 optical_kinds / optical_component；Electrical / Mechanical 灰標 placeholder) + 右 pane host 子 editor。Tab 切換 / Back 都檢 `phyEditorDirty` 彈 confirm |
| **`components/OpticalKindsEditor.tsx`** | optical_kinds 子 editor（read-only）：渲染 `KIND_REGISTRY` 的 20 個 kind 為卡片陣列，顯示 displayName / variant / tolerance / required + optional anchor pills / alignSummary。頂部黃色 banner 提示「contract live in code, edit via PR」 |
| **`components/OpticalComponentEditor.tsx`** | optical_component 子 editor（編輯 Asset.anchors[]）。三欄 layout：左 component list / 中 isolated wireframe viewport (own scene + camera + OrbitControls + TransformControls + getHelper compat) / 右 anchor inspector + kind contract viewer。Save → updateAssetApi。Dirty mirrored to `phyEditorDirty` for wrapper Back/tab-switch confirm |
| `components/DigitalTwinViewer.tsx` | ★ 主 3D viewport（含 marquee 選取、placement gizmo、wireframe outline、port labels、AOM tilt-axis 箭頭（Phase 7.1：取代舊的 ABC sphere markers，渲染 b̂×â 自動推導的 Bragg 旋轉軸 = 跟 alignToLaser 用的同一條）、waveplate fast-axis 指示線）。**On-demand render（2026-05-09）**：`animate` loop 用 `cameraMoved \|\| pendingRender` gate `renderer.render(...)` + `orientationRenderer.render(...)`，`cameraMoved = controls.update()`（OrbitControls damping 還沒停就持續 true）。`requestRenderRef`（指向 `() => { pendingRender = true }` closure）由 `controls` 'change' 事件、gizmo `onDraggingChange` / `onDragUpdate`、`handlePointerMove`（hover highlight 之後）、`handlePointerLeave`、`resize` 直接呼叫；元件尾端 no-deps `useEffect(() => requestRenderRef.current?.())` 是 safety net，每次 React commit fire 一次，捕捉兄弟 useEffect 對 scene 的副作用 mutation。Wall-fade per-frame loop + orientation-gizmo quaternion update 搬進 gated 分支。Idle = 0 fps，camera move / drag / hover / state change 自動補 render。**Incremental rebuild（2026-05-09）**：rebuild useEffect 不再 `clearGroup(componentGroup) + 全 reload`，改用 `objectWrappersRef = useRef<Map<objectId, {wrapper, componentRef, assetRef, stateRef}>>` 做 reference-equality cache：`(component, asset, deviceState)` 三件 ref 都跟上次一樣 → cache hit、只 `stripDynamicDecorations(wrapper)` + 重貼 transform/displayMode/decoration；任何一件 ref 變了 → cache miss、dispose 舊 wrapper + 重新 `await loadAssetObject(...)`。Beam + relation group 還是 full rebuild。Asset object 加 `userData.isLoadedAsset = true` 給 cache-hit path 找回原物件呼叫 `applyObjectGeometryOffset`。`stripDynamicDecorations` 透過 `userData.isOutline / isPortLabel / isAomTiltAxisMarker` + 四個 `relation-*` named child 找可拆 decoration，asset 主體保留。Effect cleanup 只 set `cancelled = true`，不再 clearGroup（會弄壞 cache）；init unmount 才整個 dispose + `objectWrappersRef.current.clear()`。Cleanup 移除 'change' listener + reset ref to noop |
| `components/optical/OpticalElementPanel.tsx` | ★ 右側 per-kind 控制面板（最大檔案、含所有 AdjustControls + AdjustErrorBoundary）。AomAdjustControls.alignToLaser 是 Phase 7.4 兩階段流程：Stage 1 snap D1∥beam（mode 由 `params.stage1RotationMode` 切 upright/min-rot/keep-d2）→ Stage 2 繞 D3 轉 ω = −traversalSignRaw·arcsin(expectedInputDotD2(...))。所有 sign 從 physics.ts 派生 |
| `components/optical/CursorMenu.tsx` | Shift+S cursor pop-over |
| `components/optical/BeamScopePanel.tsx` | 選 beam 顯示 power / polarization / spectrum |
| `components/optical/...` | 其他 optical UI |
| `components/OutlinerPanel.tsx` | 場景 outliner（collection 樹狀）|
| `components/ComponentPanel.tsx` | 左側 component library。當所選物件 `componentType === "text_annotation"` 時，Object panel 多渲一段 `<TextAnnotationEditor>`（textarea 內容 / Width mm / Font px / 三顆 color picker），所有欄位寫到 component properties，sprite 透過 `loadAsset.createTextAnnotation` rebuild |
| `components/AssetLibraryPanel.tsx` | 3D asset 管理 |
| `components/AlignPanel.tsx` | 全域 align actions |
| `components/SceneToolbar.tsx` | 上方 toolbar。Scene group 含 `Type` icon button → `addTextAnnotation()` 在 cursor 位置 spawn 一個 `text_annotation` 物件 |
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

# Tests (145 tests as of Phase 7)
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

# Tests (101 vitest tests as of Phase 7.1: 76 frames + 25 AOM physics)
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

#### PHY Editor（已上線 ✅）

**入口**：SceneToolbar 上的「PHY Editor」按鈕（PenTool icon，Initial Setup 旁邊）。  
**流程**：點按鈕 → 子頁面 → 左欄 PHY domain 樹（Optical 展開後出現 `optical_kinds` / `optical_component`；Electrical / Mechanical 灰標占位）→ 點任一 sub-editor → 右 pane render 對應內容 → 編完 Save → Back to scene。

完成範圍：
- ✅ **P7.1** — AOM 物理公式抽進 `optical/kinds/aom/physics.ts`，AomAdjustControls + rayTrace.ts 共用同一 source。25 vitest 守住
- ✅ **PHY Editor MVP** — 全域 sub-page wrapper + 兩個 sub-editor
  - `sceneStore.ts` state：`editorMode: "scene" \| "phy-editor"`、`phyEditorView: { domain, section } \| null`、`editingAssetId`、`phyEditorDirty`
  - `sceneStore.ts` actions：`openPhyEditor`、`closePhyEditor`、`setPhyEditorView`、`setPhyEditorDirty`、`updateAssetAnchors`
  - `App.tsx` 在 `editorMode === "phy-editor"` 整頁切到 `<PhyEditor>`（取代一般 scene + panels）
  - `components/PhyEditor.tsx`：top bar (Back to scene + 標題 + dirty marker) + 兩欄 layout（左 rail PHY 樹 + 右 pane host 子 editor）。Tab 切換 / Back 都檢 phyEditorDirty 彈 confirm
  - `components/OpticalKindsEditor.tsx`：read-only 卡片陣列顯示 KIND_REGISTRY 的 20 個 kind
  - `components/OpticalComponentEditor.tsx`：anchor 編輯器（左 component list + 中 isolated wireframe + TransformControls + 右 inspector）。Save → updateAssetApi。Dirty 透過 store 同步給 wrapper
  - `optical/kinds/_registry.ts`：`KIND_REGISTRY` map（每 kind 的 expected anchors + align variant + tolerance + alignSummary）
  - 編輯入口集中在 `SceneToolbar`，不再從 `ComponentPanel` 進入（per-component "Edit anchors" 按鈕已拔掉）

待做：
- ⏳ P7.2-P7.5：Mirror、Waveplate、TA 物理公式比照 P7.1 抽出
- ⏳ P7.6：Generic kinds（lens / PBS / polarizer / ...）共享 default propagation
- ⏳ P8：抽出 alignAlgorithm pure function、把 magic number 搬進 alignSpec
- ⏳ P9：Backend 對稱 `app/optical/kinds/<kind>/physics.py` + parity tests
- ⏳ P12：Live align preview（Editor 內按按鈕跑 alignAlgorithm 顯示結果）— blocked on P8
- ⏳ optical_kinds editor 升級成可編輯：blocked on `optical_kinds` DB table。目前是 read-only viewer + 黃色 banner 標明這事
- ⏳ Electrical / Mechanical PHY domains：左欄 placeholder 已經佔位

層次設計（**核心架構原則**）：
- Layer 4 (instance params) = OpticalElement.kindParams ← **per-physical-unit physics**：mirror reflectivity、lens transmission、TA mode profile / polarization、AOM RF power、waveplate fastAxisDeg。**主場景 Object panel 編**（每個出廠 unit 即使同型號都有 manufacturing tolerance）
- Layer 4b (object source / anchor-bound geometry) = SceneObject.properties.opticalSources[] + anchorBindings[] ← **per-object emitted beam / start-contact geometry**：laser wavelength、power、spectrum、polarization、spatialEnvelope、transverseMode 放 opticalSources[].beam；surface / port / detector aperture、interaction volume / mode field 等 geometry-only payload 放 anchorBindings[]。每筆 source / binding 有自己的 opaque object-scoped `id`；source 用 `bindingId` reference start binding，binding 用 `anchorId` reference Asset.anchors[]；不要用 asset anchor id 當 source 或 binding 主鍵
- Layer 3 (component catalog) = Component ← **vendor documentation / catalog**：model number、vendor、datasheet、linked asset、component_type。目標架構中不把 Component.properties 當物理參數容器
- Layer 2 (asset geometry) = Asset.anchors[] ← **reusable physics interaction geometry**：id、name、type、positionMmBodyLocal、directionBodyLocal。type 必須是 PhysicsCapability；不放 aperture，也不放純機械定位點
- Layer 1 (kind contract) = `optical/kinds/_registry.ts`（code）+ 未來 `optical_kinds` table ← physics class 定義，OpticalKindsEditor 唯讀顯示；編輯走 PR

**PhyEditor 只該寫 Layer 2，不應該寫 Layer 3 或 Layer 4。**這條界線很重要：

| 想編的東西 | 在哪裡編 | 為什麼 |
|---|---|---|
| anchor 位置 / 朝向 / type（physics interaction point 在哪、由哪個 PhysicsCapability 接管）| **PhyEditor (Layer 2)** | 是 asset geometry 的事實，同型號所有 instance 一樣 |
| anchorBindings[].payload.aperture | **主場景 Object panel / objects.properties (Layer 3/4 boundary)** | aperture 跟 opticalSurface / opticalPortSurface / detectorArea 一對一；尺寸用半長，不放 Asset anchor |
| laser source emitted beam（wavelength / power / spectrum / polarization / spatialEnvelope / transverseMode）| **主場景 Object panel / objects.properties.opticalSources[]** | 同一份 asset 可以 spawn 多顆 laser object；每顆 object 的 beam 參數不同。source id 是 object-scoped，bindingId 只是起始 geometry reference |
| TA mode profile (waist X/Y, M²)、polarization、ASE / gain table | **主場景 Object panel (Layer 4)** | 每片 TA 出廠不同（半導體 tolerance），per-unit 的事實 |
| Mirror surfaceNormalBodyLocal（多餘 legacy）| **主場景 Object panel (Layer 4)** | TODO: 之後讓 ray-tracer 改讀 anchor 的 directionBodyLocal，廢掉這個 legacy |
| Lens shape (plano-convex / bi-convex)、PBS vs BS type | Component catalog / kind contract 規劃中；目前可能仍在 Layer 4 暫存 | 這是分類或合約事實，不該每 instance 重複設定 |
| 像「把 BoosTA Pro 的 TA chip spec」搬到 Component.properties.taChipSpec | **不要做** | components 目標上只是文檔；真實 mode profile / gain / tolerance 仍放 per-instance physics |

物理公式分三類（**全部會 live in `optical/kinds/<kind>/`**，rayTrace.ts / optical_solver.py 將萎縮成 dispatcher）：
- A. Geometry rules（body axis 慣例、6-face enumeration、anchor expectation）
- B. Beam-physics propagation（reflection/refraction/diffraction）
- C. Derived UI readouts（Bragg θ、η、sideband table）— **AOM 已抽完 ✅**

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

## 16. Fiber 系統（Phase A–J，2026-05-08）

**Scope**：把光纖從「拖個直管 + 兩個假連接頭」升級成完整的物理建模 + UI 編輯系統，從 catalog 到 OpticalElement 到 ray-tracer 一路打通。

### 資料模型（Phase A）

| 層 | 欄位 | 來源 |
|---|---|---|
| **`ElementKind`** | 加 `"fiber"` | `backend/app/schemas.py:668`、`frontend/src/types/digitalTwin.ts:223` |
| **`PortRole`** | 加 `"bidirectional"` | 同上 |
| **`FiberParams`** | `fiberType` (`"multi_mode"` / `"single_mode"` / `"polarization_maintaining"`)、`endA: FiberEndSpec`、`endB: FiberEndSpec`、`cutoffWavelengthNm`、`operatingWavelengthRangeNm`、`designWavelengthNm`、`maxInputPowerMw`、`attenuationCurve[]`、`bendLoss: BendLossConstants`、`minBendRadiusMm`、`birefringenceDeltaN`、`pmdCoefficientPsPerSqrtKm`、`polarizationExtinctionRatioDb`、`bandwidthMhzKm`、`randomJonesSeed` | `backend/app/schemas.py:920–1059`、`frontend/src/types/digitalTwin.ts:355–414` |
| **`FiberEndSpec`** | `apertureDiameterMm`、`numericalAperture`、`modeFieldDiameterUm` (SM/PM only)、`coreDiameterUm`、`claddingDiameterUm`、`connectorType` (`FC`/`SC`/`LC`/`ST`/`BARE`)、`polish` (`PC`/`UPC`/`APC`/`AR`)、`polishAngleDeg`、`fresnelResidual`、`glassIndexAtDesignLambda`、`slowAxisDegInBodyFrame` (legacy PM angle)、`slowAxisAxisBodyLocal` (preferred unsigned `x/y/z`) | 同上 |
| **DEFAULT_PORTS** | `fiber: { input: [a, b] (both bidirectional), output: [] }` | 後端 schemas.py:1149–1156 |
| **DEFAULT_KIND_PARAMS["fiber"]** | 完整 780 nm PM 預設值（mirrors 後端 Pydantic defaults）| `backend/app/routers/components.py:153–212`、`frontend/src/utils/opticalDefaults.ts:147–199` |
| **Per-template override** | Component.properties.`fiberKindParamsOverride` deep-merged into the default by `default_kind_params_for_component` | `backend/app/routers/components.py:305–319` |

### 渲染（Phase D／既有）

`frontend/src/three/loadAsset.ts` 的 `createFiberSplineObject` 把 fiber componentType 當作 procedural Bezier tube：
- `properties.fiberNodes: { posMm, handleInMm?, handleOutMm? }[]` — PPT-style anchor + tangent handles
- `properties.radiusMm` — jacket 半徑（預設 1.0 mm = 直徑 2 mm；2026-05-09 從 1.5 → 0.5 → 1.0 兩段微調，最終 user 釐清要的是「半徑 1mm」。alembic 0022 把 1.5 → 0.5、0023 接著把 0.5 → 1.0；兩支 migration 都 strict-eq 比對，user 自訂值不動）
- **`properties.fiberAnchors[]`（2026-05-09）** — 標準 anchor system 的 fiber 適配（fiber 沒 Asset3D，所以 anchor 存 Component.properties 而不是 `Asset.anchors`）。`{ id: "intercept_in" | "intercept_out", positionMmBodyLocal: { x, y, z }, directionBodyLocal: { x, y, z }, apertureMm }`。座標系是 **procedural fiber body-local mm**，也就是 PHY Editor viewport 裡 Bezier cable + FC connector mesh 的本體座標；Pick End A/B face 會把實際 connector face 的 centroid + outward normal 寫到這裡。預設值由 spline endpoint + connector outward * 36.28 mm 算，aperture 2.5 mm（ferrule metal sleeve OD，幾何 clipping aperture，**不是 mode field diameter** — 後者在 `kindParams.endA/B.modeFieldDiameterUm` 給 Phase 3 Gaussian beam tracking 用）。PM slow-axis 不存在 anchor direction 裡，而是透過 `properties.fiberKindParamsOverride.endA/B.slowAxisAxisBodyLocal` 存 unsigned `x/y/z` 軸（legacy `slowAxisDegInBodyFrame` 仍同步寫入）。Editor 入口：PHY Editor → Fiber 選中 → 中央 viewport 上方 Pick End A/B face + slow-axis X/Y/Z buttons，右 aside `<FiberPatchCableFaceSection>` 顯示 EditableAnchorFields。Alembic 0024/0025 只處理歷史 backfill/reset；新 UI 以 live face pick 為準。
- 兩端 FC/PC 連接頭 — `buildFcConnectorMesh`：boot (28 mm 錐形)、shoulder、6-面 hex 螺紋本體、knurled 後段、metal sleeve、chrome ferrule shoulder、Ø2.5 mm 陶瓷 ferrule、對位 key pin
- 連接頭方向用 `applyFiberConnectorTransform(conn, nodes, "A"|"B")` 計算 outward = -handle direction（A 用 handleOut，B 用 handleIn），ferrule 永遠對外

### Edit Mode（Phase E + 既有）

`DigitalTwinViewer.tsx` 的 fiber-edit `useEffect` 在 `fiberEditingComponentId` 設定時：
- 其他元件淡到 18% opacity
- 每節點放橘 (interior) / 黃 (endpoint) anchor sphere
- 每個 handle 放 cyan tip sphere + 連線 line
- **Phase E new**：PM fiber 的連接頭 body 上加細 cyan 線指示 `slowAxisDegInBodyFrame`、ferrule 端面加金色 ring 顯示 aperture
- 互動：左鍵拖 anchor 移節點、左鍵拖 handle tip 改張力、tube 上 double-click 插節點、右鍵 anchor 刪節點
- 拖曳時即時重建 tube（`buildFiberCurvePath` + TubeGeometry）+ 接頭跟著轉

### PHY Editor 整合（2026-05-09 refactor）

Fiber 之前用一個 fiber-only `FiberInspector` 覆蓋 PHY Editor 中間 viewport 區，包含 3 個 fieldset：Laser direction radio、Port face position xyz、Slow axis（PM）。2026-05-09 後 Fiber 走標準 viewport anchor UX：中央 viewport 直接載入 procedural cable/connector mesh，End A / End B 用 TA-style dual pick buttons 選面；hover 會出現黃色 face preview fill，直接填滿目前滑鼠 raycast 到的 connector wireframe mesh face；若要選的是空的 ferrule hole center（沒有 mesh face 可點），點 viewport 裡的黃色 aperture ring 來代表洞中心，也可用 `End A ring` / `End B ring` helper 直接把 anchor 設到幾何中心；PM slow axis 用 Waveplate-style unsigned `X/Y/Z` axis buttons 設定並用 cyan slow-axis rod 標示在 viewport，因為 +X/-X 是同一條 optical axis，不是有方向箭頭的 vector。Laser direction 仍是 SceneObject 層，不放在 PHY Editor。

| 原 fieldset | 屬於 | 新位置 |
|---|---|---|
| Port face position | Layer 2（chip-intrinsic geometry）| ✅ 留 PHY Editor — 但改用 `fiberAnchors[]`（intercept_in / intercept_out）走標準 anchor flow，跟 AOM / TA 一致 |
| Slow axis | Component template default / kind override | ✅ 留 PHY Editor — 用 Waveplate-style unsigned `X/Y/Z` buttons 寫 `fiberKindParamsOverride.endA/B.slowAxisAxisBodyLocal`（同步 legacy `slowAxisDegInBodyFrame`）；主場景可再用 per-instance override（未來） |
| Laser direction | SceneObject 層 | ❌ 移到主場景 — 點 connector 直接 toggle `SceneObject.properties.beamEntryEnd`（見下一段） |

`OpticalComponentEditor.tsx` 改動點：
- 加 `canEditAnchors = !!editedAsset || (isFiberKind && !!selectedComponent)` helper
- drafts loader useEffect 加 fiber 分支：`isFiberKind && selectedComponent` 時從 `Component.properties.fiberAnchors` 讀 drafts，預設 intercept_in / intercept_out at ferrule tip
- `handleSave` 加 fiber 分支：寫到 `Component.properties.fiberAnchors` via `updateComponent`，不走 `updateAssetAnchors`
- Save 按鈕跟 `+ Add` 按鈕的 `disabled` 從 `!editedAsset` 改用 `!canEditAnchors`
- 中間 viewport 的 `FiberInspector` 整段刪掉（180 行）；fiber 現在跟一般 component 一樣由 `useViewport` 載入 mesh，只保留不擋 pointer 的小狀態 badge
- 新增 `<FiberPatchCableFaceSection>`：右 aside 顯示 End A/B anchors、scalar aperture、face normal，以及 PM slow-axis unsigned `X/Y/Z` axis buttons；viewport overlay 提供 `Pick End A face` / `Pick End B face`
- `handleSave` fiber 分支同步寫 `fiberAnchors[]` 與 `fiberKindParamsOverride.endA/B.facePositionMmBodyLocal + slowAxisAxisBodyLocal + legacy slowAxisDegInBodyFrame`
- 「This component has no Asset3D」訊息加 `&& !isFiberKind` 條件，fiber 不再彈這訊息

`ComponentPanel.tsx` 改動點：
- 新增 `FiberSlowAxisEditor` sub-component：找到該 fiber 的 OpticalElement，渲 End A / End B 兩個 number input，only enabled when `fiberType === "polarization_maintaining"`，writes `kindParams.endA/B.slowAxisDegInBodyFrame` via `upsertOpticalElement`
- 在 `FiberEditor` 的 Jacket radius slider 跟 Align 按鈕之後 render

### Beam-entry / exit 端口指定（2026-05-09）

點 fiber 的 connector(housing 或 ferrule 任一段都算 — 透過 `userData.fiberConnectorEndpoint` "A"/"B" 在 parent chain 找)→ `sceneStore.toggleFiberBeamEntry(objectId, end)` 設定光從哪端進。Toggle 邏輯:點同端二次清掉,點另一端切換。資料寫 **`SceneObject.properties.beamEntryEnd: "A" | "B"`**(不是 Component.properties — 避免踩 wrapper-cache 失效,因為改 SceneObject 不動 (component, asset, deviceState) cache key)。

視覺指示在 rebuild useEffect 的 `decorate()` 階段呼叫 `addFiberBeamFlowIndicator(wrapper, beamEntryEnd)` 加上:
- 入光端 connector 套**綠色 torus**(`0x22c55e`,半徑 3.5 mm,在 ferrule 末端外 5 mm)
- 出光端 connector 套**紅色 torus**(`0xef4444`,同尺寸)
- assetObject 上加**橘色 ArrowHelper**(`0xf97316`)在兩 connector 中點,指向 entry → exit

實作細節:torus 直接 `entryConn.add(torus)` 掛在 connector 上(connector-local +Y = outward,torus 旋轉 X 軸 90° 讓 disc plane ⊥ 出光方向);arrow 掛 `assetObject` 上(因為兩個 connector position 在 assetObject-local frame,中點計算才不會穿越 frame)。所有 child mesh tag `userData.isBeamFlowIndicator = true`,`stripDynamicDecorations` 重貼前會先清除。

Click handler 在 `handlePointerUp` no-drag 路徑、`pickObject` 命中後執行:walk parent chain 找 `userData.fiberConnectorEndpoint`,若有就 `useSceneStore.getState().toggleFiberBeamEntry(...)` + 同步呼叫 `selectObject(...)` 讓 panel 一起出現。

Ray-tracer 整合**還沒做**(Phase TBD) — 目前 `beamEntryEnd` 只記錄 + 顯示視覺,`traceBeamsFromLasers` 還不會根據它決定光在 fiber 的傳播方向。

### Align action（Phase F）

`sceneStore.alignFiberEndToBeam(componentId, "A"|"B", toleranceMm=25)`：
1. 在所有 visible BeamPath 的 segment 上找最接近該 endpoint 的點（投影到線段）
2. 若距離 > toleranceMm，return null
3. 把 endpoint posMm 設成投影點
4. 改該端 handle 的 direction（保留 magnitude）使連接頭 outward = -beam_tangent
5. 透過 `updateFiberNodes` commit
- 中間節點完全不動
- panel 兩個按鈕「對齊 A 端到 beam」「對齊 B 端到 beam」綁這個 action

### Panel（Phase G + I）

`ComponentPanel.tsx` 的 `FiberEditor`（`componentType === "fiber"` 時渲染）：
- 編輯模式 toggle 按鈕、節點數顯示、半徑滑桿
- A / B 對齊到 beam 按鈕 + feedback
- `<FiberEfficiencyDisplay>`：read-only 顯示 fiberType / 節點數 / Marcuse 完美匹配下的 η_coupling + 單面 PC Fresnel η（Phase H 整合後會被實際 ray-trace 數值取代）
- `<FiberWarnings>`：採樣 spline 上 9 個 t 點計算 cubic Bezier 曲率半徑，若 minR < `minBendRadiusMm` 顯示橘色 warning；SM/PM 缺 cutoff 也提示

### Ray tracer（Phase H — light）

`backend/app/solvers/optical_solver.py` 加 `apply_fiber(beam, params)`：
- 每端 Fresnel 用 `n` + `arResidual`：`R = ((n−1)/(n+1))² · ar`、`η_fresnel = 1 − R`
- Attenuation：取 `attenuationCurve[0].dbPerKm` × 1 m placeholder（spline arcLength 待 SceneObject geometry 注入）
- η_bend 暫設 1.0（待 spline 注入後做 Marcuse 積分）
- η_coupling：SM/PM 為 1.0（perfect mode-match probe 假設），MM 為 0.9（geometric average）
- 兩個 bidirectional port 都輸出 beam · η_total — solver dispatcher 走 input port 進、其他 port 出
- 註明 Phase H+ 要做：把 SceneObject.fiberNodes 注入、跑完整 frontend Phase B library 的 Marcuse + 數值 bend 積分 + 偏振 Jones

### Catalog（Phase J）

`backend/scripts/seed.py` 的 `_THORLABS_BULK` 加三條 fiber，全部 library-only（`x=None y=None`）：

| Catalog 項 | fiberType | λ | NA | MFD / Core | 備註 |
|---|---|---|---|---|---|
| `P1-780PM-FC-1` | PM | 780 nm | 0.13 | MFD 5.3 µm | 預設 (從 Phase A 來) |
| `P1-980A-FC-1` | SM | 980 nm | 0.13 | MFD 5.6 µm | Phase J 加 |
| `M14L02` | MM | 1300 nm | 0.22 | core 50 µm OM4 | Phase J 加，cladding 仍 Ø125 µm |

每個 catalog 條目透過 `properties.fiberKindParamsOverride` 帶自己的 spec；`default_kind_params_for_component` 的 deep-merge 會把它疊到 DEFAULT_KIND_PARAMS["fiber"] 上後再寫入 OpticalElement.kindParams。

### 物理引擎（Phase B）

`frontend/src/optical/fiber/`（pure-math 函式庫，**45/45 textbook unit tests passing**）：

| 模組 | 內容 |
|---|---|
| `gaussian.ts` | q-parameter（complex）、astigmatic beam descriptor、ABCD propagation、spot/divergence helpers |
| `bessel.ts` | J_0、J_1、J_n（Miller's downward recurrence）、I_0、I_1、K_0、K_1、K_n、root finder for J_l(x) — 純 series/asymptotic，no external dependency |
| `fiber_mode.ts` | LP01 Gaussian-approx + exact Bessel form (V<1.5)、enumerate `LP_lm` modes < V_fiber、`computeVNumber` |
| `fresnel.ts` | 完整 R_s / R_p、χ-decomposed 偏振、AR residual factor、Brewster + critical angles |
| `bend_loss.ts` | Calibrated 簡化 Marcuse formula：α(R_crit)=0.1 dB/m、α(2R_crit)=0.01 dB/m、`integrateBendLossNeper` along curve |
| `attenuation.ts` | Wavelength-curve linear interp + clamping |
| `arc_length.ts` | 64-point Gauss-Legendre quadrature、cubic Bezier first/second derivative、curvature radius |
| `polarization.ts` | Jones / Stokes 雙向轉換、PM Jones matrix（rotation × diagonal phase × inverse rotation）、SM frozen-random Jones (mulberry32 seeded)、MM full depolarize |
| `coupling.ts` | **Top-level dispatch**: Marcuse circular / astigmatic、HG_mn closed form (parity check)、LG_pl closed form (OAM ⇒ 0)、super-Gaussian numerical radial、flat-top closed form、MM aperture × NA cone |
| `total_efficiency.ts` | 把 coupling × Fresnel_A × atten × bend × Fresnel_B 串起來 |

### 驗收 checklist（Phase B 全綠）

| 物理測試 | 預期 | 實測 |
|---|---|---|
| Marcuse: w_b = w_f, perfect align | η = 1.000 | ✓ |
| w_b = 2 w_f | η = 0.640 | ✓ |
| w_b = 0.5 w_f | η = 0.640 (對稱) | ✓ |
| Δr = w_f | η = e⁻¹ ≈ 0.368 | ✓ |
| α = λ/(πw_f) | η = e⁻¹ | ✓ |
| Astigmatic w_x=2w_f w_y=w_f | η = 0.640 | ✓ |
| TEM_01 → SMF | η = 0 (parity) | ✓ |
| TEM_10 → SMF | η = 0 (parity) | ✓ |
| TEM_20 w_b=w_f → SMF | η = 0 | ✓ |
| LG_01 (vortex l=1) → SMF | η = 0 (OAM) | ✓ |
| LG_10 (radial p=1) → SMF | η = 0 | ✓ |
| Flat-top R = w_f → SMF | η = 2(1−e⁻¹)² ≈ 0.799 | ✓ |
| Flat-top R → 0 → SMF | η ~ 2R²/w_f² | ✓ |
| Fresnel normal n=1→1.45 | R = 0.0338 | ✓ |
| Fresnel Brewster (1→1.5) p-pol | R_p = 0 | ✓ |
| TIR onset (1.5→1.0) | sin θ_c = 1/1.5 | ✓ |
| Bend at R = R_crit | α = 0.1 dB/m | ✓ |
| Bend at R = 2 R_crit | α = 0.01 dB/m | ✓ |
| Arc length straight | = L | ✓ |
| Arc length semicircle | = πR | ✓ |
| PM Jones unitarity | \|J·j\|² = \|j\|² | ✓ |
| SM Jones reproducibility | same seed ⇒ same matrix | ✓ |
| MM Stokes after fiber | (S₀, 0, 0, 0) | ✓ |

### 下一步（未做、規劃進 Phase H+）

- 把 spline geometry（arc length、curvature profile）注入後端 `apply_fiber`，跑完整 Marcuse + bend integral + per-segment polarization Jones
- Beam scope panel 顯示 fiber 前後 power、η breakdown（每個 η_coupling/Fresnel/atten/bend 分項）
- Auto-follow via `assembly_relations`（fiber endpoint linked to beam → laser 移動 fiber 端跟著走）
- PM 慢軸的 per-instance roll override（SceneObject.properties.endA.bodyRollDeg）
- Flat-top + 偏移、Custom field（量測 mode）的 2D 數值 overlap engine

---

## 15. 關於這份檔案

- **位置**：`qmem-digital-twin/docs/vibe coding.md`（注意檔名有空白）—— 2026-05-07 從專案根目錄搬進 repo 的 docs/，這樣它會跟 code 一起 git track 上 GitHub。更新時也要 commit 進 repo
- **更新原則**：每次 Claude 對 codebase 做改動後，找到對應段落更新內容，**不要 append 新區段**。這樣這份檔案會永遠是 codebase 當下狀態的 snapshot 而不是 changelog
- **如果改動是大架構的**（例如加新 frame、改命名規則、加新 ElementKind），更新到 §3-§7 對應段落
- **如果改動是小細節**（例如一個 helper rename、一個 bug fix），更新對應檔案的 §9 row
- **如果改動跟 Open Work / Future Phase 有關**：把 §12 對應 bullet 移除或標記完成

過去的時序紀錄已在 2026-05-07 13:25 全部 normalize 進這份 snapshot。如果要找歷史變更紀錄，請看 git log。
## 2026-05-08 09:49 - Align MT80 AOM body-local acoustic / Bragg frame

- **User request / context**: User confirmed the AOM drawing frame: body +Y is laser -> 0th, body -X is Transducer -> Absorber acoustic propagation, and body +/-Z is perpendicular to the drawing. User asked to align implementation while testing.
- **Changes**: Updated AOM defaults and MT80 seed metadata so `acousticAxisBodyLocal` and `rfPropagationDirectionBodyLocal` use `[-1, 0, 0]`; updated frontend fallback/defaults and comments to match the MT80 frame; added regression tests pinning `b=+Y, alpha=270 deg -> tau=-Z` and `tau perpendicular acoustic -X`.
- **Live scene sync**: Updated the running localhost scene AOM component and optical element via API: component metadata and kindParams now both report `[-1, 0, 0]`, legacy `[0,0,1]` keys removed, and `braggTiltAngleDegBodyLocal` remains `270`.
- **Validation**: `npm test -- physics.test.ts` passed with 27 tests. Backend `python -m pytest tests/test_optical_schemas.py tests/test_aom_anchor_migration.py -q` passed with 30 tests; pytest cache write still warns under Windows permissions.
- **Notes / next**: The Bragg tilt axis is now aligned to the user's drawing definition: alpha 270 deg gives body -Z, while acoustic propagation is body -X, so the tilt axis is non-degenerate and the +1/-1 physical side is no longer flipped by the old +X or +Z defaults.

## 2026-05-08 10:17 - Bidirectional AOM sideband order mapping

- **User request / context**: User clarified the same AOM theory should support two physical uses: beam entering `INTERCEPT_IN -> INTERCEPT_OUT` keeps the drawing's +theta -> +order convention, while beam entering `INTERCEPT_OUT -> INTERCEPT_IN` flips +order/-order for the same mechanical Bragg tilt.
- **Changes**: Added AOM traversal helpers in `frontend/src/optical/kinds/aom/physics.ts`; updated `Align AOM port + Bragg` to derive the effective Bragg order from the beam-first port; updated `frontend/src/three/rayTrace.ts` to detect traversal from the live ray direction against the asset's `intercept_out - intercept_in` body axis and emit the flipped matched sideband for reverse input.
- **Validation**: `npm test -- physics.test.ts` passed with 29 tests after adding forward/reverse traversal tests. `npm run build` passed; Vite still reports the existing large-chunk warning.
- **Notes / next**: Forward traversal keeps selected +1/-1 unchanged. Reverse traversal maps selected +1 to physical -1 and selected -1 to physical +1, matching the user's drawing when the AOM is used backwards.

## 2026-05-08 10:44 - PHY Editor AOM RF direction definition

- **User request / context**: User wanted the PHY Editor AOM control to use the intuitive RF signal input direction, with MT80 default body `-X`, instead of exposing an abstract Bragg tilt-axis angle.
- **Changes**: Added `computeBraggTiltAxisFromRfDirectionBodyLocal(...)` so the code derives the real rocking axis as `RF direction x optical axis`; updated AOM align, the 3D AOM orange marker, and PHY Editor's AOM section to use RF direction presets (`RF -X` default) rather than the old alpha tilt-axis slider. Saving the PHY Editor writes both `acousticAxisBodyLocal` and `rfPropagationDirectionBodyLocal`.
- **Validation**: `npm run build` passed. `npm test -- physics.test.ts` passed with 31 tests, including the MT80 `b=+Y`, `RF=-X`, `tau=-Z` regression.
- **Live scene check**: Localhost scene AOM currently reports component and kindParams RF/acoustic directions as `[-1, 0, 0]`, so the running MT80 data already matches the new definition.

## 2026-05-08 10:46 - PHY Editor visible mojibake cleanup

- **User request / context**: User pointed out the PHY Editor button text `?? Pick reflective face`.
- **Changes**: Removed visible `??` mojibake from face-pick buttons and nearby status labels in `frontend/src/components/OpticalComponentEditor.tsx`, replacing them with plain ASCII labels such as `Pick reflective face`, `Click a face (ESC)`, `Face picked`, and `Unsaved`.
- **Validation**: `npm run build` passed. A targeted search confirms `?? Pick reflective face` and related visible pick-button strings are gone; only non-visible comment mojibake remains in that file.

## 2026-05-08 10:53 - PHY Editor Optical Components mojibake sweep

- **User request / context**: User pointed out more visible Optical / Components mojibake, including `?? Snap to cube centre` and diagonal direction labels like `+X?`.
- **Changes**: Swept visible UI strings in `frontend/src/components/OpticalComponentEditor.tsx` across AOM, TA, lens, waveplate, beam splitter/PBS, and generic anchor panels. Replaced corrupted labels/tooltips with plain ASCII text such as `Snap to cube centre`, `+X-Z`, `INPUT-OUTPUT angle`, `Flip`, and `Optical / Components`.
- **Validation**: `npm --prefix qmem-digital-twin\frontend run build` passed after rerunning outside the sandbox for the Windows `spawn EPERM` esbuild child-process issue. Only the existing Vite large-chunk warning remains.

## 2026-05-08 - Free-form text annotations in scene

- **User request / context**: 「新增可以放至文字的功能 像是 object:TA 兩端的文字」— user wanted a way to drop arbitrary text labels into the 3D scene, modelled after the INPUT/OUTPUT billboard sprites already shown at both ends of the BoosTA pro TA.
- **Changes**:
  - `frontend/src/three/loadAsset.ts`: added `createTextAnnotation(component)` helper that builds a canvas-textured rounded-rectangle Sprite from `properties.text / textColor / bgColor / accentColor / fontSizePx / scaleMm`, with a new `case "text_annotation"` in `createPrimitive`'s switch. The sprite is marked `userData.isTextAnnotation = true` and renders at `renderOrder = 100` so it stays on top of meshes without depth-fighting.
  - `frontend/src/store/sceneStore.ts`: added `addTextAnnotation(text?)` store action — creates a fresh component (`componentType: "text_annotation"`) plus a SceneObject at the transform cursor and selects the new object so the Object panel opens directly to its editor.
  - `frontend/src/components/SceneToolbar.tsx`: added a `Type` icon button in the Scene toolbar group that calls `addTextAnnotation()`.
  - `frontend/src/components/ComponentPanel.tsx`: added `<TextAnnotationEditor>` rendered when the selected object's `componentType === "text_annotation"`. Has a multi-line textarea (commits on blur or Enter without Shift), Width mm / Font px NumberFields, and three `<input type="color">` pickers (text, border, panel). All edits flow through the existing `updateComponent` path, so the canvas sprite rebuilds automatically when any property changes.
- **Why this fits the existing model**: text annotations reuse the SceneObject CRUD / transform gizmo / locking / visibility / collection-cascade plumbing — moving, hiding, locking, or grouping a text label uses the same UX as any other object. Backend already accepts arbitrary `component_type` strings (no enum validation), so no migration was needed; the new `text_annotation` type lives entirely in the frontend rendering branch.
- **Validation**: Vite HMR picked up all three frontend files without errors. End-to-end smoke test via the running preview server (port 5173) — clicking the new toolbar button created a `text_annotation` component + SceneObject (verified via `GET /api/scene`), the Object panel rendered the new "Text annotation" section with all six controls, editing the textarea propagated to `component.properties.text` and `component.name`. No console errors / warnings.

## 2026-05-08 - Fiber 系統 Phase A–J（rigorous patch-cable physics）

- **User request / context**: User asked for a complete fiber subsystem covering MM / SM / PM types, bidirectional propagation, mode constraints (TM00 ⇒ LP01), polarization (PM slow axis), per-end aperture / NA / connector spec, in-scene align action within 25 mm of a beam, and rigorous coupling efficiency that handles non-Gaussian inputs (HG / LG / super-Gauss / flat-top) and astigmatic two-axis divergence. Theory must be precise — no simplifications.
- **Phase A (schema)**: extended `ElementKind` with `"fiber"`, `PortRole` with `"bidirectional"`, added `FiberType` / `FiberConnectorType` / `FiberConnectorPolish` enums, `FiberAttenuationPoint` / `BendLossConstants` / `FiberEndSpec` / `FiberParams` Pydantic models in `backend/app/schemas.py`. Mirrored to `frontend/src/types/digitalTwin.ts`. Registered in `KIND_PARAMS_MODELS` + `DEFAULT_PORTS` (two bidirectional ports a/b). Added `DEFAULT_KIND_PARAMS["fiber"]` matching a Thorlabs P1-780PM-FC-1 in `backend/app/routers/components.py` and `frontend/src/utils/opticalDefaults.ts`. Added kind contract row in `frontend/src/optical/kinds/_registry.ts`. API round-trip verified for hybrid endA(PC) / endB(APC) fiber with multi-point attenuation curve.
- **Phase B (physics core library)**: built `frontend/src/optical/fiber/` with 9 modules (`gaussian`, `bessel`, `fiber_mode`, `fresnel`, `bend_loss`, `attenuation`, `arc_length`, `polarization`, `coupling`, `total_efficiency`). Coupling dispatches by input mode: Marcuse closed form for Gaussian (circular + astigmatic), HG_mn parity-aware closed form, LG_pl with OAM orthogonality, super-Gauss numerical radial, flat-top closed form, MM aperture × NA cone. Fresnel handles arbitrary angle of incidence + s/p polarization decomposition + TIR + AR residual. Bend loss uses calibrated Marcuse formula integrated by 64-point Gauss-Legendre. Polarization is full Jones matrix for PM (rotation × diagonal × inverse), frozen-random unitary for SM (mulberry32-seeded), full depolarize for MM. **45 textbook unit tests across 5 files all pass** — Marcuse limits, HG/LG parity, MM, Fresnel Brewster + TIR, bend at R_crit, Stokes round-trip, etc.
- **Phase E (slow-axis + aperture overlay)**: extended the fiber edit overlay in `DigitalTwinViewer.tsx` to add a cyan slow-axis line on each PM connector body (angle = `slowAxisDegInBodyFrame`) and a gold aperture ring at each ferrule tip. Reads spec from the live `OpticalElement.kindParams.endA/endB`.
- **Phase F (align action)**: added `sceneStore.alignFiberEndToBeam(componentId, "A"|"B", toleranceMm=25)` that snaps a fiber endpoint to the closest BeamPath segment within tolerance; only the chosen endpoint anchor + its handle direction are modified, preserving the rest of the spline. UI surfaced as two buttons in `FiberEditor` with feedback line.
- **Phase G (efficiency display)**: added `FiberEfficiencyDisplay` in `ComponentPanel.tsx` that reads the placed fiber's `OpticalElement.kindParams` and shows the perfectly-mode-matched η_coupling + per-face PC Fresnel, with a note that real per-segment η will surface from Phase H ray-trace integration.
- **Phase H (ray-tracer integration, light)**: added `apply_fiber(beam, params)` to `backend/app/solvers/optical_solver.py` and registered it in the dispatch. Computes Fresnel at both faces using the FiberEndSpec indices + AR residual, attenuation with first-curve-point dB/km × 1 m placeholder, bend = 1.0 placeholder, Marcuse coupling = 1.0 (perfect mode-match assumption) for SM/PM and 0.9 for MM. Outputs on both bidirectional ports — solver dispatcher routes input/output. Marked TODO Phase H+: inject SceneObject.fiberNodes for true arcLength + curvature integration + per-segment polarization Jones.
- **Phase I (warnings)**: added `FiberWarnings` in `ComponentPanel.tsx`. Samples cubic Bezier curvature at 9 t-points along each segment, computes minimum bend radius, warns if below the kindParams `minBendRadiusMm`. Also surfaces a hint when SM/PM is missing `cutoffWavelengthNm` (can't validate single-mode operation).
- **Phase J (catalog expansion + per-template override)**: added `_deep_merge_dict` helper in `backend/app/routers/components.py`; the fiber branch of `default_kind_params_for_component` deep-merges Component.properties.`fiberKindParamsOverride` into `DEFAULT_KIND_PARAMS["fiber"]` so each catalog Thorlabs model lights up with its own spec. Seeded two new catalog entries in `seed.py`: `P1-980A-FC-1` (SM 980 nm, MFD 5.6 µm) and `M14L02` (MM step-index 50/125 OM4, NA 0.22). All three fibers are library-only (catalogue without scene placement).
- **Files changed**: `backend/app/schemas.py` (+enums, +Pydantic models, +Enum import, ElementKind/PortRole/KIND_PARAMS_MODELS/DEFAULT_PORTS extensions); `backend/app/routers/components.py` (+`_deep_merge_dict`, +fiber branch, +DEFAULT_KIND_PARAMS["fiber"]); `backend/app/solvers/optical_solver.py` (+`apply_fiber`, +dispatch); `backend/scripts/seed.py` (+3 fiber catalog entries with overrides, fiberKindParamsOverride for non-default ones); `frontend/src/types/digitalTwin.ts` (mirror); `frontend/src/utils/opticalDefaults.ts` (mirror); `frontend/src/optical/kinds/_registry.ts` (+fiber contract); `frontend/src/optical/fiber/*` (9 new modules + 5 test files, 45 unit tests); `frontend/src/store/sceneStore.ts` (+`alignFiberEndToBeam`); `frontend/src/components/DigitalTwinViewer.tsx` (+slow-axis + aperture overlay in fiber edit useEffect); `frontend/src/components/ComponentPanel.tsx` (+`FiberEfficiencyDisplay`, +`FiberWarnings`, +align buttons in `FiberEditor`).
- **Validation**: `npx tsc --noEmit` clean. `npx vitest run src/optical/fiber` → 45/45 tests pass. `seed.py` runs clean. `GET /api/scene` returns 3 fiber components (`P1-780PM-FC-1`, `P1-980A-FC-1`, `M14L02`); each gets the right merged kindParams when bootstrapped. Browser preview reload — no console errors. See §16 for detailed per-Phase architecture.
