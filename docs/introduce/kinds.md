[← 文件索引](README.md)

# Kind 分類與每 kind 契約

> 相關：[optics.md](optics.md)（求解器如何分派 PhysicsOp）、[asset.md](asset.md)（defaultParams 存放處）、[object-sense-kinds.md](../object-sense-kinds.md)。

## Kind 分類（live `kinds.json` `element_kinds`：31）

- **Emitter**：`laser_source`、`tapered_amplifier`。
- **Passive 光學**：`mirror`、`dichroic_mirror`、`lens_biconvex`/`lens_plano_convex`/`lens_cylindrical`、`waveplate`、`polarizer`、`glan_polarizer`、`beam_splitter`(含 PBS)、`fiber`/`fiber_coupler`、`isolator`(複合)、`faraday_rotator`、`aom`、`eom`、`nonlinear_crystal`、`saturable_absorber`、`fiber_connector`(纜線接頭)。
- **Sink**：`detector`、`camera`、`spectrometer`、`wavemeter`、`beam_dump`。
- **RF kinds**：`rf_source`(AD9959 DDS)、`rf_amplifier`、`rf_cable`、`rf_cable_connector`(纜線接頭)、`rf_switch`、`programmable_pulse_generator`(TTL)、`horn_antenna`(sink)。
- 另有 24 個純機械 `passive_plugins`（mount/post/chassis/optical_table…），無物理。

> 注意：`backend/data/kinds.json` 是 kind 物理參數的權威來源；v3 設計文件曾把三種 lens 簡化成單一 `lens`、把 Glan 併入 polarizer，但實際 live `element_kinds` 為 31。`test_kinds_manifest::TestElementKinds` 強制此數（現為 31）。

**纜線接頭 kind（`fiber_connector` / `rf_cable_connector`，2026-06-12, alembic `0114`）**：纜線端接頭（FC ferrule / SMA·BNC coax）的一級 catalog kind；9 個實體接頭在 `0115` 成為其下的 Asset3D 列。各持兩個幾何 anchor——`connect_out`（原點、−X、纜線/spline junction）與 `connect_in`（在 `tipMm`、+X、配對 / ferrule 端面）；纜線層級的 `intercept_in/out`(光) 與 `rf_in/out`(RF) 埠 anchor 由端接頭的 `connect_in` 推導（取代寫死的 36.28 / 15.5 / 27mm tip 常數，P2/P3 落地）。**物理是 passthrough**：接頭本身不獨立參與 trace——`connect_in/out` 不在 `PRIMARY_ANCHOR_IDS`，tracer 的 `nearest_anchor_hit` 根本不會命中它們；`optical/anchor_ops/connector.py` 仍**防禦性**註冊一個直通 op（`return [ray_in]`，鍵以 kind 名，因 tracer 以 kind 名分派、缺 op 的 primary-anchor 命中會被當 sink 吸光），確保未來接頭即便被賦予 primary anchor 也直通而非吸光。真正的耦合物理由纜線本體 op 從兩端接頭 params 讀。詳見接頭重構規劃（plan 2026-06-12）。

**9 個接頭 Asset3D（alembic `0115`）**：`fiber_connector` 下 5 列（`fiber_connector_{apc,pc}_{pm,sm}` + `fiber_connector_pc_mm`，共用 FC STL、依 0061「always clone, never share」每列獨立 row，`default_params` 帶 polish/polishAngleDeg/fiberType/mfd/na/core/cladding/slowAxisKeyed/returnLossDb，`wavelengthRangeNm` 走 column）；`rf_cable_connector` 下 4 列（`rf_connector_{sma,bnc}_{male,female}`，`file_path = primitive://{family}_{gender}_connector`，`default_params` 帶 family/gender/tipMm/impedanceOhm/maxFreqGhz/couplingType）。各列 `anchors` 為完整 tri-axis frame：`connect_out`(原點,axisX −X)、`connect_in`(在 tipMm, axisX +X；fiber 帶 apertureMm 0.125)。`tunable_params=[]`、`locked=false`。**標準渲染尚未接線**（接頭非獨立擺放，RF female 程序模型與 binding-tree 渲染為後續 phase）；遷移是唯一 seed 路徑（`seed_v3_assets.py` 是手動且已過時的 script，非 fresh-install 路徑）。

## Domain 與 Category（兩條獨立的軸）

兩者都「只是分類」，但分屬不同層、來源不同 kind，**互不覆蓋**：

| 軸 | 屬於 | 來源 | 用途 |
|---|---|---|---|
| **Domain**（物理行為） | **Asset3D** 層 | `Asset3D.kind_id` → `kind.domains` | 跑什麼物理、PHY Editor domain rail、kind 篩選 |
| **Category**（目錄分類） | **Component** 層 | `Component.properties.category`（直接欄位，未設＝Uncategorized） | 在零件庫的哪個區段 |

- **Domain**：正規值只有 `optical` / `rf` / `mechanical`（DB `kinds.domains`，CHECK `<@ {optical,rf,mechanical}` + cardinality≥1，`models/hardware.py`）。**完全 kind-authoritative**：asset 的 domain ＝ 其 `kind.domains`（多 domain 直接由陣列表達，如 `aom=['optical','rf']`），**沒有** per-asset 覆寫——`properties.domains` 已不再被讀取（2026-06-11 移除 `domainAssets`/`assetDomains` 的 override + `faces[].domain` 分支，DB 既有的 `properties.domains` 也清空）。要改 domain 就改 kind。另有 `primary_domain`（單一主 domain）、`default_physics`（會跑哪些求解，可含 thermal 等）、`port_domains`（per-port，給 AOM 這類 hybrid）。
- **Category**：6 個 CategoryKey（Optical / Electronics & RF / Mounts & Mechanics / Workspace / Annotations / Uncategorized）。零件庫面板 `categoryForComponent`（`AssetLibraryPanel.tsx`）**直接讀 `component.properties.category`，不再由 kind 衍生**（2026-06-11；先前是 plugin `assetCategory` 自動衍生）：未設＝Uncategorized。由 PHY Editor COMPONENT tab 的 `category` 下拉寫入（空＝Uncategorized）。零件庫第二層分組仍用 `Component.kind_id`（`catalogGroup` 細組僅供 kinds 清單用）。**與 domain 解耦**——`physicsCapabilities` 不再參與 category。

→ 一句話：**Category 由 component 自身的 `category` 欄位決定（零件庫再依 `Component.kind_id` 分二層）、Domain 由 asset 的 kind 決定**，兩者本就不同步（見 [component.md](component.md)、[asset.md](asset.md)），也互不覆蓋。

## 每 kind 契約

每 kind 契約：前端註冊渲染器（`kinds/<kind>/`）+ 後端物理（**live：`optical/anchor_ops/<kind>.py` 的 anchor op**；face-based `optical/kinds/<kind>/physics.py` 已退役）+ `kinds.json` 參數。代表性 defaultParams：laser 852.347nm/50mW（像散：`spatialModeX` waist 2.2µm·M²1.15、`spatialModeY` waist 0.52µm·M²1.08，**plugin = 真值**；註：097d003(2026-06-11) 曾把 DB 端 dbr_tosa/LASER_SOURCE0 的 X↔Y 對調成 X0.52/Y2.2 但**未改 plugin**，造成 plugin↔DB 不同步，現已把 DB 還原對齊 plugin）；AOM v=4200 m/s、n=2.26、baseEfficiency 0.85；glan_polarizer wedge 38.5°、ER 55dB；TA gain 30dB、sat 500mW。lens 預設薄透鏡（`focalLengthMm`）；asset 另帶 `radiusFrontMm`+`refractiveIndex`+`centerThicknessMm` 時自動切**厚透鏡 ABCD**（短焦/非球面，如 A230TM-B，見 [optics.md](optics.md)）。

**Asset ↔ kind 參數對應不變式**：每個 asset 的 `default_params` 必須涵蓋其 kind 的所有 required 參數（`physics.defaultParams`，扣除 column-owned `wavelengthRangeNm`），且只能用 kind 宣告的 key（required + `physics.optionalParams`）。為此，kind 的 schema 必須「補齊」其 op/asset 實際使用的物理參數——用 `optionalParams`（frontend-only，opt-in、不進 manifest、不強制 seed）宣告 model-specific / spec-sheet 欄位：**lens** thick-lens 幾何（`radiusFrontMm`/`refractiveIndex`/`centerThicknessMm`/`radiusBackMm`）。**faraday_rotator 沒有 optionalParams**：其 `defaultParams` 就是 live op (`anchor_ops/misc_ops.py`) 實際會用到的全集——`rotationDeg`/`lengthMm`/`refractiveIndex`（＋ column-owned `wavelengthRangeNm`）；先前的 spec 欄位 `VerdetConstantRadPerTeslaMm`/`arResidualR`/`material`/`reciprocal` 從不被 live op 讀，已移除。Glan-Laser 稜鏡 asset 的 `polarizing=true`、`coatingNormalBodyLocal`＝其 `intercept_face` anchor 的 axisX。**beam_splitter 沒有 optionalParams**：其 `defaultParams` 就是 live op (`anchor_ops/pbs.py`) 實際會用到的全集——`lengthMm`、`refractiveIndex_o`(反射 o-ray)、`refractiveIndex_e`(透射 e-ray)、`extinctionRatioPpDb`(透射 P 埠)/`extinctionRatioSpDb`(反射 S 埠,合法 dB，100000:1→50dB)、`coatingNormalBodyLocal`(→anchor axisX 反射軸)、`transmissionAxisDegBeamLocal`(→fast axis)、`polarizing`、column-owned `wavelengthRangeNm`。slab 折射率分 branch(PBS cube 只設 isotropic `refractiveIndex` 則 op fallback 兩者同值)。**已移除**從不被 live op 讀的舊欄位 `airGapAngleDeg`/`airGapThicknessMm`/`B_x_mm`/`B_y_mm`/`E_x_offset_coef`/`transmissionAxisDegBodyLocal`(僅退役的 face-based TS solver 用過)。

**`wavelengthRangeNm` 強制不變式**：**除了兩個 emitter（`laser_source`、`tapered_amplifier`）以外，所有 optical kind 的 `defaultParams` 都必須帶 `wavelengthRangeNm`**——即使其 live op 不直接讀（如 `faraday_rotator`、`mirror`），它仍是 column-owned 的工作波段（存 `wavelength_range_nm` 欄，供 UI / 波段驗證用），所以恆在 `defaultParams`、且不算進「op 實際讀的參數」（在 strict editor 裡由 lambda min/max 欄編輯，不出現在一般 scalar 欄位）。兩個 emitter 改帶 `centerWavelengthNm`（中心波長）而非範圍。此規則由 `backend/tests/test_kinds_manifest.py::TestOpticalCoverage` 強制：`test_every_non_emitter_optical_has_wavelength_range`（非-emitter 必須有 `wavelengthRangeNm`）+ `test_emitters_have_center_wavelength`（emitter 必須有 `centerWavelengthNm`）；來源 spec `docs/optical-kinds-spec.md` R1/R2。

**`locked` 凍結旗標（alembic 0112）**：`kinds.locked` / `assets_3d.locked`(BOOLEAN NOT NULL DEFAULT false)＝人類已確認「完整、不可調整」。PHY Editor 的 KIND / ASSET3D 左側清單每列右邊有鎖頭按鈕(`KindsEditor.tsx` / `Asset3DEditor.tsx`)：鎖定後該列 Edit/Delete 停用、右側表單唯讀(asset 用 `pointerEvents:none` 整塊唯讀),只剩解鎖可按。後端硬性擋寫:`PATCH /api/kinds/{id}`、`PUT /api/v3/assets3d/{key}`、`PUT /api/assets/{id}` 及對應 delete,只要 row.locked 且請求改了 `locked` 以外任何欄位就回 **422**(guard：`backend/app/lock_guard.py`);唯一例外是「只切 `locked`」(解鎖)。`KindOut`/`Asset3DV3Out` 都帶 `locked`。**AI 規則(見 [CLAUDE.md](../../CLAUDE.md))：絕不修改/刪除 locked 的 kind/asset,需要動就請使用者先解鎖。**

- **`op_set_name`（kind → code op 的間接層）**：kind metadata 在 DB，但物理 op 實作永遠在 code（`optical/registry.py`）。每筆 kind 用 `op_set_name` 指向一組已註冊的 code op set。內建 kind `op_set_name == name`；UI 自建變體可指向現有 op set 來**複用**物理（如 `my_custom_lens` → `op_set_name='lens_biconvex'`），不必改 code。dispatch：`get_op(kind, op)` 先查 registry，查不到才用 `op_set_name` fallback（`optical/db_kinds.py`）。
- **被動 / placeholder kind**：`op_set_name='none'` ＝ 無物理 op、tracer 不對它跑任何 op（如 `isolator` 外殼）。`unclassified`（migration `0110`）即此類：`domains=['optical','rf','mechanical']` 全選、params/anchor 全空，作為 **BUILD 新匯入的預設 kind**（見 [build.md](build.md)），未分類前同時現身三個 domain rail。**invariant：`assets_3d.kind_id` NOT NULL（migration `0111`）**——asset 不存在「無 kind」狀態，至少是 `unclassified`；`components.kind_id` 則仍可 NULL（composite component）。
