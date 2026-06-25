[← 文件索引](README.md)

# RF 子系統總覽（射頻：source → cable → amp/switch → AOM）

> 本檔是**整個 RF 子系統的索引與全景**。細節分散在 [cable.md](cable.md)（同軸線 + RF 圖傳播）、[kinds.md](kinds.md)（device registry / per-role 契約）、[timing.md](timing.md)（PPG / TimingProgram）、[optics.md](optics.md)（AOM Bragg drive）。先讀本檔抓全貌，再跳對應細節檔。
>
> **一句話心智模型**：RF **不是光追**，是 port 鄰接圖上的 BFS。source 的每個 `rf_out` 種一條訊號，沿 `rf_cable`（透明邊）走過 amplifier（加 gain）/ switch（依 TTL 選路），到達 `aom`/`eom` 的 `rf_in`（sink）轉成 Bragg/EO drive。前端 `rfPropagation.ts` 與後端 `rf_resolve.py` **同模型、須 parity**。

---

## 1. 行為 kind（RF 的「東西」）

每個 kind 用 per-role anchor spec（`roles`，見 [kinds.md](kinds.md)）。RF Link 面板只收 `domain ∈ {rf, ttl, trigger, rfout}` 的 port。

| kind | 角色 | RF role / domain | 檔案 |
|---|---|---|---|
| `rf_source` | DDS / synth，發射端 | `rf_out`（多埠 CH0..CH3）`rf` | `kinds/rf_source/index.ts` |
| `rf_amplifier` | `rf_in → rf_out`，套 `gainDb`（clamp 在 `outputPowerMaxDbm`） | `rf_in`/`rf_out` `rf` | `kinds/rf_amplifier/index.ts` |
| `rf_switch` | 共埠 `rf_in` → N 個 `rf_out`（RF1/RF2…），TTL 選路 | `rf_in`/`rf_out` `rf` + `ttl_in` `ttl` | `kinds/rf_switch/index.ts` |
| `programmable_pulse_generator`（PPG） | 一個 `rf_out` 閘（TTL/Trigger），綁 TimingProgram | `rf_out` → `rfout`（特例，見下） | `kinds/programmable_pulse_generator/index.ts` |
| `horn_antenna` | 發射 / 接收天線 | sink/emitter | `kinds/horn_antenna/index.ts` |
| `rf_cable` | 圖的**邊**（透明、零損耗） | `rf_in`/`rf_out`（derived from spline） | `kinds/rf_cable/index.ts` |
| `rf_cable_connector` | 接頭幾何（sma/bnc × male/female），passthrough | `connect_in`/`connect_out`（非 primary） | `kinds/rf_cable_connector/index.ts` |
| `aom` / `eom` | `rf_in` **sink** → Bragg / EO drive | `rf_in` `rf` | `kinds/aom`、見 [optics.md](optics.md) |

**訊號 domain 與相容規則**（`utils/rfLinkPorts.ts`）：`RfLinkSignalDomain = "rf"|"ttl"|"trigger"|"rfout"`。`domainsAreCompatible`（`rfLinkPorts.ts:28`）：同 domain 永遠可接；`rfout`（PPG 輸出）相容 `ttl`+`trigger`，但不跨進類比 `rf`。**PPG 的 `rf_out` 特例**：`resolveRfLinkPortDomain`（`rfLinkPorts.ts:48`）把它映成 `rfout`，故 role 宣告的 `ttl` 只影響泛型啟發、不影響連線型別。

## 2. Device（具體儀器，一檔一台）

`frontend/src/devices/*.ts` → `_registry.ts` 的 `DEVICES`。RF 相關：`ad9959`（4×CH 真實座標）、`dg4202`（2×CH BNC）、`zhl_1_2w`（amp）、`zyswa_2_50dr`（switch）、`rg316_sma`（cable）、`ppg_sma`、`horn_wr90`，以及 4 個 coax connector `sma_male`/`sma_female`/`bnc_male`/`bnc_female`。**`connectorType` 必須 gendered**（`sma_female` 不能是裸 `sma`，否則 `Anchor` schema literal 擋成 500）。詳見 [kinds.md](kinds.md)「Device registry」。

## 3. RF Link 面板（UI，`components/RfLinkPanel.tsx`）

3 欄自動分桶（source / transducer / sink），節點 = 每個 RF-bearing SceneObject，邊 = `rf_cable` 的 `rfCableEndpoints.{A,B}`。

- **節點來源**：`nodes` useMemo（`RfLinkPanel.tsx:825`）→ `kindParticipatesInRfLink`（`rfLinkPorts.ts:114`）閘掉非 RF kind → `rfLinkPortsOf`（`RfLinkPanel.tsx:208`）從 **asset anchor** 推 port。asset 用 `primaryAsset`（binding tree，非 `comp.asset3dId`）解析。**真的無 asset 時**退回 `rfLinkRoleAnchors(kind)`（`rfLinkPorts.ts:134`）以 role 合約合成 port（顯示 "NO CONN"、不可拉線）。細節見 [cable.md](cable.md)「RF Link 面板節點來源」。
- **per-port 編輯**：DDS `rf_out` 行可改 Freq/Vpp（寫 `RfSourceParams.channels`）；AOM `rf_in` 顯示 incoming + 「need ≥ Vpp」；amp 顯示 gain 與 Vpp_in→Vpp_out。
- **拉線連線**：port 圓點 pointer-drag → `createRfCableBetweenPorts`（`store/sceneStore.ts:2422`）生一條新 `rf_cable` 並接兩端。守則：異物件、反向 role、domain 相容、connector 有定義、未占用；跨家族 SMA↔BNC 允許（catalog 有 adapter 才完整）。
- **右鍵**：空 `ttl_in`/`trigger_in` → 「Create Pulse & Timing here」生 PPG；已連 port → 「Disconnect cable」。
- 節點可拖曳、位置存 localStorage。

## 4. RF 傳播 BFS（物理圖，前後端 parity）

**前端**：`utils/rfPropagation.ts` `buildRfPropagation`（`rfPropagation.ts:402`）；`rfPropagationSchedule.ts` 對每個 timing section 預算一張 snapshot（`buildRfPropagationSchedule:80`），scrub 時 `getRfSnapshotAt:110` 做 O(log N) 查表。
**後端（權威）**：`backend/app/optical/rf_resolve.py` `build_rf_propagation`（:325）；`load_rf_inputs`（:488）撈場景；`resolve_aom_rf_drive`（:574）→ `hydrate_aom_rf_drive`（:615）把到 AOM `rf_in` 的訊號解成 `{aomFreqMhz, rfDrivePowerW=vpp²/(8·50Ω)}` 灌進 Bragg 解（`/api/v3/solver`）。

- **節點 asset/anchor 解析（parity 不變量）**：每個節點的「device asset」（提供 `rf_out`/`rf_in` anchor 與 `fullScaleVpp` 等 spec）的取法 = **單一 root `targetKind="asset"` binding → 該 asset；否則退回 legacy `component.asset3dId`**。這正是 FE `componentBindings.primaryAsset`（`componentBindings.ts:104`）的語意。connector / 子 asset 是 binding 樹的 **children，永遠不是**節點的 primary asset。**FE/BE 兩側用同一條規則選 primary，否則 BFS desync** —— 已落實：FE `buildAnchorsByObject`/`buildAssetParamsByObject`（`rfPropagation.ts:160/179`）呼叫 `primaryAsset`，BE `load_rf_inputs` 呼叫對應的 `_primary_asset_id`（`rf_resolve.py`，逐行對齊 FE）。**注意 parity 細節**：`primaryAsset` 不吃 `ObjectBinding.asset_3d_id_override`（FE 簽名根本沒帶 objectBindings），故 BE 也刻意不吃——兩側一致用 root binding / legacy 欄。
- **種子 Vpp** = `amplitudeScale × fullScaleVpp`（`fullScaleVpp`、`channels[]` 都是 **asset 係數**，可由 `dynamic_sources` 逐實例覆寫）。
- cable 透明穿過；amp 套 `gainDb`（超 `outputPowerMaxDbm` → `saturated`）；switch 依 TTL（綁 PPG timing 或手動 `ttlState`）選通路 + 插入損耗。
- **first-arrival-wins，無疊加**。Powered-off source/amp/switch 排除在 BFS 外（與 Instrument Power 面板一致）。
- `/api/rf-chains`（`routers/rf_chains.py`，Phase RF.2）存的是 per-terminal RF 鏈 **metadata**，**不是**傳播真值——別跟 BFS 混淆。

## 5. RF Cable 幾何 / 渲染

單物件 + per-instance spline（`rfCableNodes`）。兩端各綁一個 `rf_cable_connector` asset（end_a/end_b binding）。接頭模型：device GLB（`sma_male` 等）或程序生成 fallback；`bakeConnectorByAnchors`（`three/loadAsset/connectorBake.ts`）把 `connect_out` 放 spline node、`connect_in` 放 +tip。**對準** `resolveLinkedRfCableEndpoint`（`utils/rfCableAnchorResolver.ts:248`）把 node 退後 = 接頭 tip，使 `connect_in` 落在目標 port。**tip 由 anchor 推導** `connectorTipMmFromAnchors`（`rfCableAnchorResolver.ts:71` = `|connect_in − connect_out|`），非寫死家族常數（`RF_CONNECTOR_TIP_MM=15.5`/`RF_BNC=27` 只對程序接頭成立）。完整細節見 [cable.md](cable.md)。

## 6. 其他關聯功能

- **Asset3D 編輯器**：per-anchor `connector_type` 下拉（4 個 gendered 值），unlocked row 可改（`locked` row 整張唯讀）。`components/Asset3DEditor.tsx`。
- **Pulse & Timing**：PPG ↔ TimingProgram 一對一；`rf_out` 發 TTL/Trigger gate；channel index 由場景 PPG 排序決定。見 [timing.md](timing.md)。
- **Instrument Power**：關掉 laser/source 串聯熄滅下游（source→無 RF→AOM 無 drive）。

## 7. 已知狀況 / 待辦（2026-06-25）

✅ 本批修好：RF Link 顯示 binding-backed RF 物件、拉線建 cable、anchor 方向讀 axisX（非 legacy `directionBodyLocal`）、接頭 tip 由 anchor 推導讓 `connect_in` 對齊 port、`connector_type` 可編輯。

✅ **本批修好（最大）：asset 解析的 binding 盲點。** 傳播 BFS 兩側原本都用 legacy 欄（`component.asset3dId` / `comp.asset_3d_id`）解節點 device asset，binding-backed 場景下恆 null → `anchors=() → rf_source 種不出 rf_out` → 訊號流動畫 / AOM Bragg drive 實際上沒在跑。已改成 binding-aware（§4 不變量），三處全部落地：
  - **FE** `buildAnchorsByObject` / `buildAssetParamsByObject`（`rfPropagation.ts:160/179`）改用 `primaryAsset`（同 `RfLinkPanel` 用的 helper，無另寫）；`buildRfPropagation` 新增 `componentBindings?` 參數並逐層串到兩個 live consumer（`RfLinkPanel.tsx`、`DigitalTwinViewer.tsx`）。`primaryAsset` 等三個 read-only helper 簽名加寬吃 `readonly` 陣列。
  - **BE** `load_rf_inputs` 加撈 `ComponentBinding`、新增 `_primary_asset_id`（逐行對齊 FE，**不**吃 `asset_3d_id_override` 以維持 parity）。範本：`db_scene_loader.py` 早就 binding-aware，RF 是最後一條搬家的舊路徑。
  - **測試**：BE `test_rf_resolve.py` 增 4 個 `_primary_asset_id` 案例（single-root / legacy fallback / composite→None / 非 root binding 不算）；FE `rfPropagation.test.ts` 維持綠（optional 參數預設退回 legacy）。
  - ⚠️ 仍是**舊/dead 路徑**故未動：`aomRfDrive.resolveAomRfDriveFromScene`（只剩 legacy `rayTrace.ts` 用）、`buildAomGateOverridesFromSnapshot`（無 caller）—— 兩者仍讀 `comp.asset3dId`，若日後重啟需一併套 `primaryAsset`。
- 相關背景見記憶 `[[anchor_dir_axisx_not_legacy]]`、`[[connector_refactor_0114]]`。

⚠️ 次要：viewer `applyLink` 仍有同 `asset3dId` 盲點（binding 場景 early-return → cable 不會隨 target 移動 live re-snap，靠 connect-time stored nodes）；cable 自身 derived rf port marker（`resolveRfCableAnchorPosition`）仍用寫死 tip；catalog 缺 SMA↔BNC adapter cable variant。
