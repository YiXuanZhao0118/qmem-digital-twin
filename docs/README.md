# QMsimulation / qmem-digital-twin — 專案完整解說

> 本檔由 `docs/` 下原本 19 份分散的設計 / 進度 / 規格 .md 整合而成，是描述整個專案的單一權威說明。
> 最後整理：2026-06-01。整合來源清單見文末附錄。
> （根目錄另有 169KB 的 `README.md` 主文件；本檔聚焦架構與概念解說，與之互補。逐檔清理建議見根目錄 `CLEANUP_AUDIT.md`。）

---

## 1. 這是什麼

**QMsimulation**（別名 qmem-digital-twin）是一套**量子記憶體 / 冷原子光學實驗室的數位分身（digital twin / 數位孿生）**。它把一張真實的量子光學桌（laser → tapered amplifier → 波片 → PBS → AOM → 量子記憶體 cell，加上 RF 電子與時序控制）建模成一個可互動、物理精確的 3D 數位分身，支援光束追跡、偏振模擬與多物理場模擬。

使用者可以在瀏覽器裡擺放/對準光學元件、連接光路與 RF 鏈、沿時間排程脈衝，並即時看到光束如何傳播與被各元件作用。長期目標是做成類 Ansys Workbench 的「多物理整合平台」（光學 + 電子 + 電磁 + 磁學 + 時序），但全用開源求解器、供實驗室內部使用。

---

## 2. 系統架構（三層服務）

| 層 | 技術 | 連接埠 | 角色 |
|---|---|---|---|
| 前端 Frontend | React 18 + TypeScript + Vite 6 + three.js 0.170 + zustand + axios | **5173** | 3D 視埠、編輯 UI、各模組工作區 |
| 後端 Backend | FastAPI + SQLAlchemy 2.x async + Pydantic v2 + numpy/scipy | **8010** | REST API + WebSocket、光學/多物理求解器、持久化 |
| 資料庫 Database | PostgreSQL 16（本機隔離實例，位於 `.local-postgres/`） | **55432** | 場景 / 資產 / 元件 / 模擬結果持久化 |

**連接方式：**
- 前端寫死連後端 `http://localhost:8010`（`frontend/src/api/client.ts`，可用 `VITE_API_BASE_URL` 覆寫），**直接打、不透過 Vite proxy**。
- WebSocket：`ws://localhost:8010/ws/scene`（伺服器→客戶端推 `component.*`/`object.*`/`simulation_run.*` 等事件，客戶端只送 `ping`）。
- 後端 CORS 白名單 `localhost:5173`、`localhost:3000`（`backend/app/config.py`）。
- DB 連線字串：`postgresql+asyncpg://qmem:qmem_password@localhost:55432/qmem_twin`。
- 資產檔：前端 `resolveAssetUrl()` 組出 `http://localhost:8010/assets/files/...`，後端靜態服務 `assets/`。

> ⚠️ **常見過時資訊更正：**
> - 後端 port 是 **8010**（部分舊文件/根 README 寫 8000，那是 docker 模式預設，本機開發用 8010）。
> - `docker-compose.yml` 內 Postgres 寫 **5432**；本專案實際用本機 **55432** + `scripts/start-local-postgres.ps1`，且環境未安裝 Docker。5432 vs 55432 是最常見的混淆點。

---

## 3. 目錄結構

```
qmem-digital-twin/
├── frontend/src/
│   ├── components/   # React UI：DigitalTwinViewer（主場景，~6000 行）、各 panel、editor
│   │   └── physics/  # 各 kind 的 *AdjustControls（Laser/Aom/TaperedAmplifier/Simple）
│   ├── three/        # three.js 場景、loadAsset、rayTrace、v3TraceAdapter、beam、placement/
│   ├── kinds/        # 每 kind 的 plugin 渲染器 + 註冊表（_plugins.ts、_renderer_bindings.ts）
│   ├── optical/      # TS 光學：jones、frames、pose、fiber/、WIP v3 光追島（見 §7.4）
│   ├── store/        # zustand：sceneStore、kindsStore、(v3)catalogStore
│   ├── utils/        # (v2)bindings、anchorAccess、componentBindings、rfPropagation
│   └── modules/      # Lab / Optics / Electronics / EM / Magnetics 工作區（_registry.ts）
├── backend/
│   ├── app/
│   │   ├── main.py       # FastAPI 進入點，~40 routers 註冊於 /api/<resource>
│   │   ├── routers/      # 每資源 REST router
│   │   ├── models/       # SQLAlchemy ORM（scene、hardware、timing…）
│   │   ├── optical/      # ★權威光學引擎：ray_tracer_v3、solver_v3、kinds/<kind>/physics、anchor_ops/、db_scene_loader、jones、abcd
│   │   ├── solvers/      # 多物理：em_fem、magnetics_dc、optics_cavity/crystal/seq、spice、runner、palace_io
│   │   ├── services/     # touchstone…（onshape_client / instrument_polling 為死碼）
│   │   └── schemas*.py   # Pydantic（CamelModel：DB snake_case ↔ API camelCase）
│   ├── alembic/versions/ # migration 0001..0097（線性鏈）
│   └── data/             # kinds.json（★kind 物理參數權威來源）、thorlabs_cad_manifest.json
├── assets/
│   ├── catalog/          # 元件/資產/kinds JSON 定義（seed 來源；DB 才是 runtime 真值）
│   └── files/            # stl、glb、cad_sources（CAD 二進位不進 DB）
└── docs/                 # 本檔 + aom_align_*.{png,py}（AOM 對準圖表腳本）
```

---

## 4. 核心資料模型（最重要的抽象）

四層模型，**參數歸屬（param ownership）是整個系統的脊椎規則**——這條規則已在資料層由 migration 0094/0095/0096 強制落實：

```
Asset3D    （幾何 + faces + transitions + defaultParams = 物理真值）
   ▲  透過 ComponentBinding 樹綁定（local transform、tunable axes、role_label）
Component  （vendorPart + 綁定樹 + exposedFaces；★不存 kind、不存物理）
   ▲  實例化為
SceneObject（Lab pose + paramOverrides[bindingId] + dynamicSources）
```

1. **Asset3D** — 可重用 3D 模型 + 其物理預設。存：`geometryRef`（.glb/.stl）、`kind`、`faces[]`、`transitions[]`、`defaultParams`（該零件內在物理，如某顆 Thorlabs 透鏡的焦距）、`wavelengthRangeNm`、`viewerHints`、`anchors`。**物理預設只存在這裡。**

2. **Component** — 目錄「模板」。有 `vendorPart`、一棵 **ComponentBinding 樹**、與對外的 `exposedFaces`。**本身沒有 kind、沒有物理參數**（migration 0094/0095 已把 physics keys 從 components 清空）。

3. **ComponentBinding** — 綁定樹節點，把資產（或子元件）掛在父節點下，帶 local transform（localX/Y/Z mm、localR deg）、`tunable_axes`、`role_label`、`sort_order`。讓複合元件成立（如 isolator = faraday rod + 前後 Glan 稜鏡 + 外殼）。表 `component_bindings`：`parent_binding_id`、`target_kind`(asset/empty/subcomponent)、`asset_3d_id`…

4. **SceneObject（Object）** — 場景中放置的實例。有 Lab pose（x/y/z/rx/ry/rz）、`visible`、`locked`、`param_overrides`（per-binding 靜態校正）、`dynamic_sources`（per-instance 執行期值）。名稱自動產生為 `KIND+index`（AOM0、MIRROR1；kind 為 none → NONE0）。

**參數合併順序**（`ray_tracer_v3.py`）：
`effective = asset.defaultParams ⊕ paramOverrides[bindingId] ⊕ transition.params`；`dynamic = sceneObject.dynamicSources`。

- **paramOverrides** = per-binding 靜態校正（任何 defaultParams key，如某片波片實測 retardance 88°）。
- **dynamicSources** = 整個 instance 的執行期值，把光學耦合到電子/RF/雷射狀態：
  - laser_source：powerMw、centerWavelengthNm、spectrum、polarization、spatialMode
  - aom：aomFreqMhz、rfDrivePowerW/aomRfVpp（通常由上游 RF 鏈灌入，dynamicSources 是手動覆寫 fallback）
  - rf_source：channels[] CH0–3

物理參數分兩類：`intrinsic_param_keys`（硬體固定，如折射率、晶體長度）vs `state_param_keys`（執行期可調，如 RF 頻率、繞射階數 → 對應 dynamicSources）。

---

## 5. 座標系與 Anchor / Face 架構（現行：alembic 0093）

**三個執行期座標系**（注意：這取代了舊文件的「4-frame」模型）：
1. **Lab frame** — 場景/世界。SceneObject 的 `x/y/z mm` + `rx/ry/rz deg` 把一個元件實例放進實驗室。
2. **Component frame** — 組裝/模板。Component 的 ComponentBinding 把資產/子元件擺在 component root 之下；tunable axes + object-level binding override 可在此 frame 內移動/旋轉。
3. **Asset/CAD frame** — 單一 Asset3D 的幾何局部系。Anchor / face 直接在此標註。**沒有獨立的執行期 body frame。**

**變換鏈與公式：**
```
anchor_asset_local → ComponentBinding pose → SceneObject Lab pose → Lab frame

P_lab = T_sceneObject_lab · T_componentBinding · P_anchor_asset
D_lab = R_sceneObject_lab · R_componentBinding · D_anchor_asset
```
- Lab 與 three.js **都是 Z-up**，執行期數學**不可**再做 lab↔three 軸交換。
- 旋轉用 row-vector 慣例：`M_row = Rx(rx)·Ry(ry)·Rz(rz)`，`R_lab = transpose(M_row)`。例：`ryDeg=45` 把 CAD `[0,0,1]` 映到 Lab `[-0.707, 0, 0.707]`。
- 舊的 body-frame 層（`body_frame_rotation`/`bodyFramePositionMm`）已被 **0093** 移除並烤進 anchors；執行期不得再套用 `R_body`/`bfp`。CAD 軸不順要在 catalog import 時修，不在 trace/render 時修。
- 相容性：欄名仍含 `BodyLocal`（`positionMmBodyLocal`、`directionBodyLocal`…）但語意已是 Asset/CAD-local。

**Faces（光學介面面）：** `faces[]` 是物理光學面。雙埠資產用物理面 `A`/`B`；方向/互易性/繞射階/RF-side 放在**有向的** `transitions[]`（A→B、B→A），**不用** A1/B1/A2/B2 重複命名。Component 透過 `exposedFaces` 把 `componentFaceId`（如 `optical_in`）映到 `assetBindingId + assetFaceId`。

- Face 法向是 Snell/Fresnel/反射的真值（s/p 分解：`s=(k×n)/|·|`、`p=k×s`）；**tracer 決定出射方向，op 不決定**。
- 5×5 增廣矩陣（V=[x,θx,y,θy,1]）處理橫向位移（稜鏡楔角、Glan-Laser 38.5° decenter）；一般用 2×2 ABCD；柱面鏡/Glan 用 abcdXY（x/y 分開）。

frame 數學：前端 `optical/frames.ts`、`optical/pose.ts`、`utils/anchorAccess.ts`；後端 `optical/db_scene_loader.py`。

---

## 6. 渲染管線（前端）

- `components/DigitalTwinViewer.tsx` 是主場景建構器。對每個 SceneObject：解析 Component + Asset → 由 `shouldRenderViaBindings()` 決定路徑：
  - **Binding-tree 路徑**：`buildSceneObjectFromBindings()` 走 ComponentBinding 樹（複合元件）。
  - **Legacy 路徑**：`loadAssetObject()`（單一資產）。
- `three/loadAsset/index.ts` 依資產型別分派（STL/GLB/OBJ/`procedural://`）並有特例 builder（PBS252、BB1E03、AD9959、isolator）。
- 材質：`materialFor()` → `colorForComponent()`（kindId 色表 + `colorHex` 覆寫 + 裝置狀態著色）。
- **viewerHints** 驅動幾何過濾：`includeOnlyCentroids`、`deletedCentroids`、`recenterOrigin`。
- 光束渲染：`three/rayTrace.ts` → `v3TraceAdapter.ts` 消費後端 `/api/v3/solver` 輸出，發佈到 `window.__rayTraceDebug`（供 OpticalLinkViewer、BeamScope、snap-to-beam 讀取）。
- 效能：on-demand rendering（閒置 0 renders/sec）、增量重建場景 + `objectWrappersRef` 以 (component, asset, deviceState) 參考相等做 wrapper 快取。

---

## 7. 光學物理模型

### 7.1 Kind 分類（live `kinds.json`：28 kinds）
- **Emitter**：`laser_source`、`tapered_amplifier`。
- **Passive 光學**：`mirror`、`dichroic_mirror`、`lens_biconvex`/`lens_plano_convex`/`lens_cylindrical`、`waveplate`、`polarizer`、`glan_polarizer`、`beam_splitter`(含 PBS)、`fiber`/`fiber_coupler`、`isolator`(複合)、`faraday_rotator`、`aom`、`eom`、`nonlinear_crystal`、`saturable_absorber`。
- **Sink**：`detector`、`camera`、`spectrometer`、`wavemeter`、`beam_dump`。
- **RF kinds**：`rf_source`(AD9959 DDS)、`rf_amplifier`、`rf_cable`、`rf_switch`、`programmable_pulse_generator`(TTL)、`horn_antenna`(sink)。
- 另有 24 個純機械 `passive_plugins`（mount/post/chassis/optical_table…），無物理。

> 注意：`backend/data/kinds.json` 是 kind 物理參數的權威來源；v3 設計文件曾把三種 lens 簡化成單一 `lens`、把 Glan 併入 polarizer，但實際 live 是上述 28 種。`test_kinds_manifest` 期待 30、實際 28，是已知差異。

每 kind 契約：前端註冊渲染器（`kinds/<kind>/`）+ 後端物理（`optical/kinds/<kind>/physics.py` 的 PhysicsOp）+ `kinds.json` 參數。代表性 defaultParams：laser 780.241nm/50mW；AOM v=4200 m/s、n=2.26、baseEfficiency 0.85；glan_polarizer wedge 38.5°、ER 55dB；TA gain 30dB、sat 500mW。

### 7.2 偏振
以 **Jones calculus** 追蹤（`optical/jones.ts`）。各 kind 套自己的 Jones：waveplate retardance、polarizer 投影、PBS 分光（face 慣例 `face_1..6` = ±X/±Y/±Z，`H_transmit_V_reflect`）。

### 7.3 求解器：Kind Registry + PhysicsOp（現行）
- **Kind Registry**（alembic 0086）：DB `kinds` 表存 metadata（name、domain、`op_set_name`、default_params、needs_aperture、wavelength_range_nm）；**code 端 REGISTRY 存 PhysicsOp callable**，由 `op_set_name` 連結。新 kind 可在 UI 用既有 op 建立。
- **Ray tracer**（`ray_tracer_v3.py`）：單一迴圈，**沒有 `switch(kind)`**——靠 PhysicsOp 查表分派。`PhysicsOp = (rayIn, faceIn, faceOut, params, dynamic?) => BeamRay[]`，回傳陣列以支援分支（AOM 階數、PBS 穿透+反射、ghost）。`BeamRay` 帶 chief ray + 獨立 qx/qy（像散）+ Jones s/p + excludeFaceKey。
- **AOM Bragg**：`theta_B = asin(λ·f_rf / (2·v_acoustic))`、`theta_deflect(order) = order·2·theta_B`（外角慣例）。

### 7.4 求解器現況（重要）
- **後端 v3 anchor 求解器**（`ray_tracer_v3.py`、`solver_v3.py`，端點 `/api/v3/solver`）是**唯一權威光學引擎**。實驗室看到的光束 = 後端 v3 trace。
- 舊的 legacy chain solver（`optical_solver.py` + `rf_propagation.py` + `optics_seq` 的 solve_chain）已於 Phase 1（migration ~0094 期）**刪除**；Lab「Run」按鈕現在也走 v3。
- 前端 `optical/` 的 TypeScript 光追引擎（`ray-tracer-v3.ts` 等 19 檔）是**平行、尚未上線**的實作，目前只被 vitest 引用、main.tsx 到不了，但有完整 parity 測試 + golden fixtures，疑似進行中的重構——**勿當廢案刪**。

### 7.5 RF tracer
RF **不是** ray tracer——沒有波前/Jones/q。它在 port 鄰接圖上做 **graph BFS**，攜帶 `RfSignalState{frequencyMhz, vpp, cumulativeGainDb, saturated, …}`。常數 `AD9959_VPP_FULL_SCALE=1.0V`、`RF_LOAD_Z=50Ω`、`P=Vpp²/(8Z)`。AOM 是**hybrid**——同時是 ray tracer 的光學元件與 RF tracer 的 RF sink；RF 經 BFS 灌到 `signalAtPort[(aom,"rf_in")]`，AOM RF 設定值優先序：**dynamicSources（手動）> RF tracer > defaultParams.centerFreqMhz**。

### 7.6 Tapered Amplifier（設計鎖定 2026-05-31，四因素模型 2026-06-01）
半導體增益晶片，種子放大。鎖定：forward A→B only；ASE 僅在無種子時發射（option 6b）。Op 在 `anchor_ops/misc_ops.py`（`tapered_amplifier_anchor_op`），代表資產 `toptica_boosta_pro`（face A 種子 −z / B 輸出 +z）。

**Gain 軸 = anchor `axisY`**（取代舊的 `gainAxisDegBodyLocal` 角度參數）：兩個面 `intercept_in` / `intercept_out` 都標 `needsFastAxis`，axisY 在 PHY Editor 可編輯。放大量由四個物理因素決定，耦合功率 `P_coupled = P_in · frac_TE · η_mode`：

1. **偏振（TE 選擇定則）**：`_jones_in_axis_basis()` 把入射 Jones 轉到 anchor (axisY, axisZ) 基底，`frac_TE = |E_axisY|²/|E|²`。只有 TE（∥axisY）被放大，TM 幾乎零增益；輸出沿 axisY 線偏振 + 有限消光（`polarizationExtinctionDb`）。
2. **Seed 光強度（增益飽和）**：`P_out = P_sat·ln(1 + (P_coupled/P_sat)·(G0−1))`，`G0=10^(smallSignalGainDb/10)`，clamp 到 `outputPowerMaxMw`。弱種子→線性、提取差、ASE 高;強種子→飽和、最大輸出。
3. **Mode matching（重疊積分）**：`_mode_match_eta()` 從 seed q 參數算端面光腰 `w²=λ|q|²/(π·Im q)`，與波導模 `inputSpatialModeX/Y.waistUm` + hit 橫向偏移做可分離二維高斯重疊。輸出橫模重塑為 `outputSpatialModeX/Y`。
4. **Current Driver Quality**：`driverQualityFactor∈[0,1]` 穩態提取效率懲罰（預設 1.0）。**動態效應不在範圍內**：α-parameter AM→PM 雜訊、自聚焦/filamentation、M² 崩潰屬時域/M²-aware 現象（BeamRay 無 M² 欄位、trace 為穩態）→ 歸 §9 時域模組。

新參數：`polarizationExtinctionDb`、`driverQualityFactor`（FE interface + kind defaultParams；op 對舊資產 graceful default）。已知 bug：op 讀 `smallSignalGainDb` 但舊資產存 `gainLinear`，待統一。

---

## 8. 多物理場模組系統

UI 可切換的**模組**（前端 `modules/<name>/`，`modules/_registry.ts` 註冊、`ModuleSwitcher.tsx` 切換、`SolverConsole.tsx` 跑求解）：

| 模組 | 內容 | 後端求解器 | 函式庫 |
|---|---|---|---|
| **Lab** | 主 3D 光學實驗室（預設） | `optics_seq` → v3 anchor tracer | — |
| **Optics** | 光腔 / 非線性晶體分析 | `optics_cavity`、`optics_crystal` | — |
| **Electronics** | 電路 netlist / SPICE / 網路分析 | `spice` | ngspice、scikit-rf（Smith chart/S-param） |
| **EM** | 電磁場 / 天線 / 場視覺化 | `em_fem` | palace(FEM) + Gmsh，vtk.js 體渲染 |
| **Magnetics** | DC 線圈 / 磁場（在 Optics 工作區內） | `magnetics_dc` | magpylib v5 Biot-Savart（Helmholtz 已驗證） |

**設計原則**：不重做殼，擴充既有 SceneObject 樹 + per-module sidecar 表。
**SolverRunner 抽象**（`solvers/runner.py` Protocol：submit/cancel/status）：`InProcessRunner`（光學，ms 級）、`ContainerRunner`（ngspice/MEEP 子程序）、`SshWorkstationRunner`（palace 跑在實驗室工作站，經 SSH）。`simulation_runs.runner_kind` 記錄分派方式。
**sidecar 表（additive）**：`simulation_runs`(0036)、`circuits`(0037)、`em_problems`+`meshes`(0038)、`coils`+`magnetics_problems`(0039)。
**EM 工作站（Phase C）**：13700K+128GB+RTX4070Ti、Windows+WSL2+Docker Desktop；palace 用 `awslabs/palace` image；流程 SSH→SCP mesh+config.json→`docker run palace`（60 分上限 `em_solver_timeout_sec`）→SCP 回 `port-S.csv`→`palace_io.parse_palace_sparams`。env：`WORKSTATION_HOST`/`WORKSTATION_KEY_PATH`/`WORKSTATION_PALACE_IMAGE`。預設 Run 仍用 inproc mock（合成 Lorentzian）；真 palace 需 `runnerKind:'ssh_workstation'`。已知限制：mesh port/PEC 標註需手動、場 `.pvtu` 尚未回傳。

---

## 9. 時間域模擬

**設計核心**：時間是一等座標。一次「實驗 run」是時間演化的 trace，而非穩態快照。
- **Sequence Timeline**：一個 Sequence = 一串 Event `(t, channel, action, params)`（channel 為點分路徑如 `AOM_001.rf_amplitude`；action：set/ramp/pulse_gate/trigger/wait/barrier）。模組在 event 之間各自向前演化，於 event 邊界交換跨物理狀態。**穩態 = 空 Sequence 的特例**（無 Sequence → 既有 CW evaluator 跑，不破相容）。
- **per-module 時間網格**：optical envelope（ps–100ns 取樣）、RF phasor、量子 ρ(t) 密度矩陣、thermal T(t,x)、vacuum P(t)——因單一全域 dt 不可行。採 RWA/SVEA 近似。
- **Schema**：`PulseEnvelope`/`RFSignal`/`QuantumTrace`/`ScalarTrace` + `Sequence`/`SequenceEvent` 表；各 kind 加選用色散參數（gvdFs2、groupDelayPs、riseTimeNs…）。
- **PhysicsModule Protocol**：`steady_state(scene)` + `evolve(scene, t0, t1, controls, state_in)`。光學 primitive：`propagate_envelope`（split-step Fourier 處理 GVD/TOD，已實作於 optical_solver、textbook 驗證 <0.5%）、`angular_spectrum_propagate`、`fiber_overlap`。
- **已落實**：trace schemas + 選用色散參數 + `propagate_envelope`；CW 路徑為 no-op，無回歸。後續 Phase（量子 Lindblad、thermal ODE、timeline UI）未完。

### Scrub time / Timing programs / AD9959
- **Scrub time**（`ScrubTimeBar.tsx`）：場景狀態是時間 t 的函數。
- **TimingProgram**：per-SceneObject 1:1，扁平 `TimingBlock` list（`[t_start_ns, t_end_ns)` + `waveform_kind`(const/linear_ramp/arbitrary/gate_on/gate_off) + params JSONB）。端點 `/api/timing-programs`、model `models/timing.py`。`evaluate_intervals_at(t)` 求當下有效狀態。
- **Programmable Pulse Generator（PPG）**：承載 timing program、輸出 TTL，驅動下游裝置。
- **AD9959**（4 通道 DDS RF 源）：時序整合採 **Option A**——在 TimingBlock 的 `params.channelIndex`(0–3) 加通道標籤，零 migration；AD9959 專屬波形 `dds_single_tone`/`dds_sweep`/`dds_profile`。player 把每通道有效 block 解析成 `DdsChannel`，靜態 `kindParams.channels[i]` 為 fallback。（此為設計提案，是否完全落地需對照程式碼確認。）
- **RF 鏈**：AD9959 通道 → rf_amplifier → rf_switch → AOM（`utils/rfPropagation.ts`、端點 `/api/rf-chains/nodes`），透過 AOM 的 dynamicSource 耦合到光學。

---

## 10. 擺放與吸附（Placement & Snapping）

**心智模型**：光學位置是相對的（相對光束、元件、對稱軸），不是絕對的。Lab pose 是**持久化輸出**而非主要輸入；主要輸入是「帶吸附意圖的拖曳」。不用會跟使用者作對的 assembly_relations，改記**意圖 metadata**（`placedRelativeTo`，記得但不強制執行）。

- **引擎是純函式** `computePlacement(input) → PlacementResult`（`three/placement/engine.ts`）。管線：① collectSnapTargets ② rankByOpticalRelevance ③ applyConstraints。所有輸入源（gizmo 拖曳、數字面板輸入、Shift+S 游標選單、多選對齊、Place-along-beam）都組成 intent 走同一引擎，無旁路。
- **SnapTarget** 種類：beam_centerline/along/intersection/endpoint、mesh_vertex/edge_midpoint/face_centroid/bbox_center、anchor、cursor、world_origin、object_plane、grid。**排序優先序：beam > mesh > cursor > grid**，平手取距離近 + kind 更具體（anchor > face_centroid > bbox_center > vertex）。
- **7 層（L0–L7）**：L0 純引擎、L1 gizmo（Global/Local/Beam 朝向，TransformControls）、L2 吸附視覺回饋 + Tab 循環、L3 3D cursor（Shift+S 選單）、L4 光學工具（Place/Insert along beam）、L5 多選 Align、L6 placedRelativeTo + Re-snap、L7 表達式數字欄（`+50`/`*2`/`@200`/`mid(A,B)`，`exprInput.ts`/`NumberField.tsx`）。
- 後端基本不動（placedRelativeTo 只是 SceneObject.properties 上的 JSON）。已知限制：Re-snap 目前只支援 `beam_along`；大 STL（>5k 頂點，如 14k 的 BB1-E03）mesh 吸附需 subsample。cursor 狀態 `transformCursorMm`、最後點擊光束點 `scopeProbe`。

---

## 11. 主要 API 端點

- `GET /api/health` → `{"ok": true}`；`GET /api/scene` — 場景快照
- `POST /api/v3/solver/run-from-db` — 對持久化場景跑光學 trace（產生光束段：dir、pol、命中面）
- `GET /api/v3/catalog/...`、`/api/v3/assets3d`、`/api/v3/components`
- `/api/timing-programs`、`/api/rf-chains/nodes`、`/api/coils`、`/api/magnetics-problems`、`/api/simulation-runs`、`/api/touchstone/parse`、`/api/app-settings/{key}`
- 靜態：`/assets/files/...`；Swagger：`/docs`；WebSocket：`/ws/scene`
- 慣例：所有持久 id 為 UUIDv7；CamelModel（DB snake_case ↔ API camelCase）。

---

## 12. 啟動與開發 Runbook

**一鍵重啟（建議）：**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  "C:\repos\qmem-digital-twin\.claude\skills\start-project\scripts\restart-stack.ps1"
```
釋放 5173/8010、啟動 Postgres、跑 `alembic upgrade head`、起 uvicorn + vite，印出驗證表。

**手動：**
```powershell
scripts/start-local-postgres.ps1                    # Postgres → 55432（qmem/qmem_password, db qmem_twin）
# 在 backend/ 下，用 DATABASE_URL env 覆寫到 55432：
alembic upgrade head
python -m uvicorn app.main:app --host 0.0.0.0 --port 8010 --reload   # ★8010
frontend/node_modules/.bin/vite.cmd                 # Vite → 5173（勿用 npx）
```

**驗證**：前端 `http://localhost:5173`（200）、後端 `/api/health`（`{"ok":true}`）、`alembic current` 報 head。
**Seed**：live DB 由 `backend/scripts/seed_v3_assets.py` + v3 catalog 種；舊 `seed.py` 已 deprecated（有 banner，不在 live DB）。
**工具**：pytest（backend）、vitest（frontend）、`tsc --noEmit`、`vite build`。

> Windows/工具陷阱：PowerShell `Set-Content` 預設 cp950 會讓含中文的 JSON mojibake → 用 `-Encoding UTF8`；uvicorn `--reload` 在 Windows 檔案監看不穩，必要時手動重啟；PS 5.1 無 `??`；Asset3D JSON 不可有 `+` 前綴數字；scipy `from_euler` "YXZ"(intrinsic) 才對應 three.js。

---

## 13. Alembic Migration 鏈

- **Head：** `0097_repair_dynamic_sources`；**Root：** `0001_initial_schema`。
- 97 個 migration 單一線性鏈，無 gap、無分支、無重複 revision id。`env.py` 以 `from app.models import Base` 取 metadata 當 autogenerate target。
- revision id 刻意縮寫以守 **VARCHAR(32)** 限制（曾有 0091 超限把 DB 卡在 0090 的事故，現已健康）。
- 關鍵 migration：0036–0039 多物理 sidecar 表；0082–0084 v3 asset 物理欄;0086 kinds registry;0093 flatten frame anchors（移除 body frame）;0094/0095 strip component physics;0096 drop pe intrinsic/state;0097 repair dynamic sources。
- ⚠️ **絕對不要刪**任何已套用的 migration（包括名字像實驗的 `v2`/`v3`/`baseline`/`cutover`，如 0027~0034、0082~0084）：刪除會斷鏈、讓 `alembic upgrade head` 壞掉、DB 卡在前一版。名字像實驗，實際是正史。

---

## 14. 已知過時 / 待處理事項

- 後端 port 是 8010（非 8000）；`docker-compose.yml` 的 5432 + adminer 實質未用（走本機 55432 腳本，Docker 未裝）。
- 前端 `optical/` TS 光追引擎被部分舊文件當成 production，實際線上是後端 v3 求解器。
- 斷掉的 geometryRef：`thorlabs_io_3_850_faraday_rod.json` 指向不存在的 `files/stl/thorlabs_io_3_850_hp/` 切片子目錄（`split_io_3_hp_stl.py` 可能沒跑或檔案遺失）。
- isolator 的 front/back piece 與 body housing 顏色都寫死 `#1a1a1c`（不走 colorForComponent）；要換色須同改 subset-piece 分支與 `buildThorlabsIsolatorObject`。
- TA 資產 `gainLinear` vs op `smallSignalGainDb` 單位不一致，待統一。
- pulse-envelope/色散時域數學在 legacy 退役時被刪（可從 git 復原）。
- `test_kinds_manifest` 期待 30 kinds 但實際 28。
- `objects.parent_component_id` model/schema 與 DB 欄位可能不一致；非 emitter 的 chain root（無入射 link 的 mirror）會報「chain root cannot emit」。
- 死碼/孤兒檔/正名建議：見根目錄 `CLEANUP_AUDIT.md`。

---

## 附錄：本檔整合來源

整合自以下原 `docs/` 檔（已於整合後移除）：
**架構** — `ARCHITECTURE_OVERVIEW.md`、`vibe coding.md`、`frame-anchor-architecture.md`；
**光學/物理** — `optical-schema-v2.md`、`optical-kinds-spec.md`、`asset-physics-model.md`、`asset-physics-implementation.md`、`asset-params-inventory.md`、`legacy-physics-retirement.md`、`tapered-amplifier-model.md`、`phase-3b-review.md`；
**多物理/時間/擺放** — `MULTIPHYSICS_PLAN.md`、`MULTIPHYSICS_PROGRESS.md`、`PHYSICS_TIME_DESIGN.md`、`PHYSICS_TIME_CHECKPOINT.md`、`PLACEMENT_DESIGN.md`、`PLACEMENT_PROGRESS.md`、`AD9959_TIMING_INTEGRATION.md`、`PHASE_C_WORKSTATION_SETUP.md`。

`docs/aom_align_*.png` 與 `aom_align_*.py`（AOM 對準圖表的產生腳本與圖）予以保留。

> 文件版本衝突解析原則：當舊文件矛盾時以最新者為準——`frame-anchor-architecture.md`(0093) > `ARCHITECTURE_OVERVIEW.md`(0043) > `vibe coding.md`(~0020)；v3 取代 v2；`PhysicsElement` 取代舊 `OpticalElement`；`ComponentBinding` 是規劃中 `anchorBindings` 的實作版。
