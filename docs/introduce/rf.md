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
- **per-port 編輯**：DDS `rf_out` 行可改 Freq/Vpp；AOM `rf_in` 顯示 incoming + 「need ≥ Vpp」；amp 顯示 gain 與 Vpp_in→Vpp_out。**channels 的讀寫都走所有權鏈**（2026-08-14 修）：顯示用 `channelsByObjectId`（`RfLinkPanel.tsx:918`）解 `dynamicSources` > Asset `defaultParams` > `kindParams`，寫入用 `updateSceneObject` 打進 **`dynamicSources.channels`**（與 `Ad9959ObjectControls.updateChannel` 同一條路）。**不可寫 `kindParams`** —— ad9959 asset 自己作者了 `channels`（且標 tunable），asset 層永遠贏過 kindParams，於是「面板數字變了、傳播沒變」，下游 AOM 死守 asset 的 80 MHz / 1.0 Vpp。
- **拉線連線**：port 圓點 pointer-drag → `createRfCableBetweenPorts`（`store/sceneStore.ts:2422`）生一條新 `rf_cable` 並接兩端。守則：異物件、反向 role、domain 相容、connector 有定義、未占用。**cable-variant 自動選型**：依兩端 port 各自的 `connectorType`（`sma_*`/`bnc_*`，`connectorFamilyFromAnchor`）配對 catalog 三款 cable（SMA-SMA / BNC-SMA / BNC-BNC），direct 或 reverse（swap A/B）都試；跨家族 SMA↔BNC 走非對稱 `RF cable BNC SMA`。**cable 的每端家族由其綁定的 connector asset 推導**（`end_a`/`end_b` binding → `rf_cable_connector` asset 的 `defaultParams.family`，經 `deriveCablePropsFromConnectorBindings`），**不是**讀 component `properties.endAConnector`（catalog row 該欄空）。
- **右鍵**：空 `ttl_in`/`trigger_in` → 「Create Pulse & Timing here」生 PPG；已連 port → 「Disconnect cable」。
- 節點可拖曳、位置存 localStorage。

## 4. RF 傳播 BFS（物理圖，前後端 parity）

**前端**：`utils/rfPropagation.ts` `buildRfPropagation`（`rfPropagation.ts:440`）；`rfPropagationSchedule.ts` 對每個 timing section 預算一張 snapshot（`buildRfPropagationSchedule:84`），scrub 時 `getRfSnapshotAt:114` 做 O(log N) 查表。
**後端（權威）**：`backend/app/optical/rf_resolve.py` `build_rf_propagation`（:372）；`load_rf_inputs`（:593）撈場景；`resolve_aom_rf_drive`（:690）→ `hydrate_aom_rf_drive`（:732）把到 AOM `rf_in` 的訊號解成 `{aomFreqMhz, rfDrivePowerW=vpp²/(8·50Ω)}` 灌進 Bragg 解（`/api/v3/solver`）。

- **節點 asset/anchor 解析（parity 不變量）**：每個節點的「device asset」（提供 `rf_out`/`rf_in` anchor 與 `fullScaleVpp` 等 spec）的取法 = **單一 root `targetKind="asset"` binding → 該 asset；否則退回 legacy `component.asset3dId`**。這正是 FE `componentBindings.primaryAsset`（`componentBindings.ts:104`）的語意。connector / 子 asset 是 binding 樹的 **children，永遠不是**節點的 primary asset。**FE/BE 兩側用同一條規則選 primary，否則 BFS desync** —— 已落實：FE `buildAnchorsByObject`/`buildAssetParamsByObject`（`rfPropagation.ts:200/219`）呼叫 `primaryAsset`，BE `load_rf_inputs` 呼叫對應的 `_primary_asset_id`（`rf_resolve.py`，逐行對齊 FE）。**注意 parity 細節**：`primaryAsset` 不吃 `ObjectBinding.asset_3d_id_override`（FE 簽名根本沒帶 objectBindings），故 BE 也刻意不吃——兩側一致用 root binding / legacy 欄。
- **種子 Vpp** = `amplitudeScale × fullScaleVpp`（`fullScaleVpp`、`channels[]` 都是 **asset 係數**，可由 `dynamic_sources` 逐實例覆寫）。
- **passthrough 參數所有權（2026-08-13 修）**：amp / switch 的 transfer 看到的參數 = `dynamicSources` > Asset `defaultParams` > PhysicsElement `kindParams`，與 [object.md](object.md) 記的所有權鏈一致。FE `resolveElementParams`（`rfPropagation.ts:499`）、BE `_resolved_params`（`rf_resolve.py:393`），TTL pre-pass 的 manual `ttlState`、PPG 的 `restState`/`timingProgramId`、以及 BFS 呼叫 transfer 三處都走它。**先前只讀 `kindParams`**，於是 asset 作者寫的或使用者逐實例調的 switch/amp 旋鈕全部無效 —— 最明顯的是 `rf_switch` plugin 宣告 `ttlState` 為 tunable（寫進 `dynamicSources`）卻永遠讀不到，手動 TTL 切換完全沒作用。
- cable 透明穿過；amp 套 `gainDb`（超 `outputPowerMaxDbm` → `saturated`）；switch 依 TTL（綁 PPG timing 或手動 `ttlState`）選通路 + 插入損耗。
- **PPG 閘位 = `inInterval XOR (restState === "HIGH")`（2026-08-14 修）**：gate pre-pass 先算全場每顆 PPG 的位準（FE `rfPropagation.ts:528`、BE `rf_resolve.py:421`），TTL pre-pass 只是查表。不變量：`restState` 是**畫出來的區塊「之外」的位準**，所以 rest=HIGH 會把使用者畫的 block 變成 LOW 脈衝（負邏輯）；`idleRestMode`（scrub 停）不看 intervals，即 XOR 的退化。插著的 PPG **一律擁有那條線**，沒綁 program 也用 rest 位準（先前會 fall through 到 switch 的手動 `ttlState`）。契約寫在 `types/digitalTwin.ts` `ProgrammablePulseGeneratorParams.restState` 與 `schemas.py` `rest_state`。
- **AOM 有沒有被 RF 驅動＝拓樸，不是有沒有載波**：`rf_in` 上「插了東西」（`connectedPorts` / `connected_ports`＝鄰接表的所有 port key）才交給 RF link 決定；沒插線的 AOM 才保留 asset 的額定工作點。判定條件寫成「某個 timing section 有載波到」會讓**接了線但永遠沒訊號**的 AOM（switch 常駐另一 throw、source 關電）看起來像沒接線，退回額定 drive、在完全沒 RF 的情況下畫出整組 sideband。
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

✅ **cable-variant 選型 bug**：sma port ↔ bnc port 卻永遠生 sma-sma cable。根因＝`cableEndFamily`（`sceneStore.ts`）讀 component `properties.endAConnector`（catalog 三款 cable 該欄全空）→ 家族恆 null → fallback 到 `rfCables[0]`(sma-sma)。改成用 `deriveCablePropsFromConnectorBindings` 從綁定的 connector asset `defaultParams.family` 推導（gendered token 前綴比對）。現 SMA-SMA / SMA-BNC / BNC-BNC 三組合都正確選型（跨家族走 reverse-swap 的 `RF cable BNC SMA`）。**已 live 驗證**（2026-07-04 Playwright）：RF_SOURCE0·CH0(SMA)→RF_SWITCH0·rf_in(BNC) 選中 `RF cable BNC SMA`；PPG rf_out(BNC)→ttl_in(BNC) 選中 `RF Cable BNC`。

✅ **右鍵建 PPG 無聲失敗**：右鍵 `ttl_in`「Create Pulse & Timing here」沒反應。根因＝`createProgrammablePulseGenerator`（`sceneStore.ts:1794`）只用 `properties.connectorType` 精確比對挑 PPG 元件，挑到**空殼**（`PPG (SMA)`/`PPG (BNC)` 零 binding、無 asset、無 `rf_out` anchor）→ PPG 物件建了但 auto-connect 找不到 `rf_out` → `createPpgAtPort` 整組 rollback → 使用者看起來「什麼都沒發生」。修法＝挑選時加 `ppgHasUsableAsset` 閘（primaryAsset 存在且帶 `rf_out` anchor），空殼永不再被選；資料側把使用者的 asset-backed PPG 元件補上 `properties.connectorType`。已 live 驗證：右鍵 TTLIN·BNC 一次成功（PPG+TimingProgram+BNC cable 全建、面板 Vpp 傳播即時顯示）。

✅ **PPG 建立失敗留幽靈 channel**：只有一個 PPG，Pulse & Timing 卻列 CH0+CH1。根因＝建立流程「先建 TimingProgram / 先塞 store，後續步驟失敗」的清理不完整：① program 建好後 object/PE 建立丟例外 → DB 留孤兒 program；② `createPpgAtPort` cable 失敗 rollback 只呼 `deleteObject`，若 delete 本身也失敗（如後端當機——正是 cable 會失敗的同一種時刻），store 裡的 program/object 沒人清 → 幽靈 CHn 掛到 reload 為止。修法＝① object/PE 建立包 try/catch，失敗即 `deleteTimingProgramApi` 再 rethrow；② rollback 後**本地**同步 filter 掉 objects/physicsElements/timingPrograms（與 websocket 事件冪等）。既有幽靈重新整理頁面即消失（DB 本來就乾淨）。

✅ **本批修好（最大）：asset 解析的 binding 盲點。** 傳播 BFS 兩側原本都用 legacy 欄（`component.asset3dId` / `comp.asset_3d_id`）解節點 device asset，binding-backed 場景下恆 null → `anchors=() → rf_source 種不出 rf_out` → 訊號流動畫 / AOM Bragg drive 實際上沒在跑。已改成 binding-aware（§4 不變量），三處全部落地：
  - **FE** `buildAnchorsByObject` / `buildAssetParamsByObject`（`rfPropagation.ts:200/219`）改用 `primaryAsset`（同 `RfLinkPanel` 用的 helper，無另寫）；`buildRfPropagation` 新增 `componentBindings?` 參數並逐層串到兩個 live consumer（`RfLinkPanel.tsx`、`DigitalTwinViewer.tsx`）。`primaryAsset` 等三個 read-only helper 簽名加寬吃 `readonly` 陣列。
  - **BE** `load_rf_inputs` 加撈 `ComponentBinding`、新增 `_primary_asset_id`（逐行對齊 FE，**不**吃 `asset_3d_id_override` 以維持 parity）。範本：`db_scene_loader.py` 早就 binding-aware，RF 是最後一條搬家的舊路徑。
  - **測試**：BE `test_rf_resolve.py` 增 4 個 `_primary_asset_id` 案例（single-root / legacy fallback / composite→None / 非 root binding 不算）；FE `rfPropagation.test.ts` 維持綠（optional 參數預設退回 legacy）。
  - ⚠️ 仍是**舊/dead 路徑**故未動：`aomRfDrive.resolveAomRfDriveFromScene`（只剩 legacy `rayTrace.ts` 用）、`buildAomGateOverridesFromSnapshot`（無 caller）—— 兩者仍讀 `comp.asset3dId`，若日後重啟需一併套 `primaryAsset`。
- 相關背景見記憶 `[[anchor_dir_axisx_not_legacy]]`、`[[connector_refactor_0114]]`。

✅ **viewer `applyLink` 盲點（cable 不隨儀器移動）**：`resolveEffectiveRfCableState.applyLink`（`DigitalTwinViewer.tsx`）讀 `targetComp.asset3dId` → binding 場景 early-return → 移動 RF_SOURCE0/SWITCH/AMP 時 cable 端點凍在 connect-time nodes。改用 `primaryAsset`（與 BFS/建線同一 helper）。驗證＝以 live scene 資料跑解析閘門：6/6 cable 端點從 early-return(dead) → 正確解析 asset+anchor；下游 re-snap 機制（`resolveLinkedRfCableEndpoint` + `linkWatchKey` 含 target pose）本就會在 pose 變動時重算。至此 **FE 已無 RF 路徑讀 legacy `comp.asset3dId`**（僅剩 dead/legacy：`aomRfDrive`、`buildAomGateOverridesFromSnapshot`、viewer AOM gating 迴圈 `DigitalTwinViewer.tsx:1584`）。

✅ **write-through re-snap（stored nodes 跟著儀器走）**：上述 render-time re-snap 修好後仍有殘影——`rfCableNodes` 存的是 connect-time 值，儀器移動後 DB 是舊資料，F5 第一幀畫舊位置、等 live pass 跑完才跳對。依「資料就該存對」原則補上寫穿：`sceneStore.resnapRfCablesLinkedTo(movedIds)`——找出 `rfCableEndpoints` 指向被移動物件的每條 cable 端，重算（同 `createRfCableBetweenPorts.buildCandidate` 數學）並經 `applyRfCableAlignmentCandidate` **持久化**。掛在三個 pose 提交點：`updateSceneObject`（單物件 + rigid-group）與 `updateSceneObjects`（多選批次），fire-and-forget 不擋移動 UX。驗證（Playwright + DB）：移 RF_SOURCE0 Δx=−49.971 → stored node[B] 同步 −49.971；復原後 node **bit-for-bit** 回原值。註：undo 走 `updateObjectApi` 直呼不觸發 re-snap → stored 可能暫時滯後，但 renderer 照 link 重derive 所以畫面正確；stored nodes 本就是 fallback。

✅ **switch / amp 參數所有權（2026-08-13）**：passthrough transfer 只讀 `kindParams`，導致 asset 作者寫的與逐實例 `dynamicSources` 調的旋鈕全被忽略（`ttlState` 明明宣告 tunable 卻是死鍵）。FE/BE 各加一個 resolver 走 `dynamicSources > asset defaultParams > kindParams`，兩側各補 4 個 parity 測試（FE 10 綠 / BE 21 綠）。**注意這不會自己讓訊號通過 switch**：`minicircuits_zyswa_2_50dr` 的 `default_params` 目前是空的 `{}`，所以 `ttlActiveHighThrow` 仍退回 hardcode 2 → LOW 選 RF1。要讓 RF2 通，得在 PHY Editor 幫該 asset 寫上 `ttlState` / `ttlActiveHighThrow`，或接上 PPG。

✅ **PPG 3D 相對位置錯（2026-08-13）**：PPG 該直接插在目標埠上（`computePpgMountedThreePose`，`utils/ppgMounting.ts:156`），實際卻浮在 spawn 點。根因是**同一個 legacy-asset 盲點又出現兩次**：① `ppgMounting.findAnchor` 用 `comp.asset3dId` 解目標儀器的 asset → binding 場景恆 null → 整個函式 return null；② viewer 傳進來的 PPG 自身 `asset`（`DigitalTwinViewer.tsx:3877`）也是 legacy 解析 → PPG 元件本身也是 binding-backed → 找不到 `rf_out`。兩處都改走 `primaryAsset`（②以 `asset ?? primaryAsset(...)` 就地補，不動 3877 那行的其他使用者）。新增 `utils/__tests__/ppgMounting.test.ts` 4 個測試，其中「目標 asset 只能經 binding 樹解到」那個正是這次的回歸守門。
  - 至此 rf.md §7 記的那條「FE 已無 RF 路徑讀 legacy `comp.asset3dId`」有補充：`ppgMounting` 當時漏掉了，現已補上。

✅ **PPG 生命週期 / 資料同步（2026-08-13 盤點）**：使用者要求「只能從 RF Link 增刪、主件刪除要連帶刪 PPG、三個面板資料同步」。盤查後**增刪與串聯刪除本來就正確**（`capabilityProfile` 關掉 outliner/remove 按鈕/gizmo；`deleteObjects` 的 cable→PPG→TimingProgram 串聯；全 app 只有 4 個 `deleteObject` 呼叫點且都受閘門保護），**唯一真的沒同步的是改名**：從 RF Link 節點改名只寫 `SceneObject.name`，Pulse & Timing 面板才會順手鏡像到 `TimingProgram.name`。改成在 store 統一鏡像，見 [timing.md](timing.md)「PPG」。

✅ **點擊 cable / PPG 會把它刪掉（2026-08-14，資料遺失級）**：Rendered 模式下在 3D 點選一條 rf_cable，該 cable 立刻被刪，連帶把接在上面的 PPG 也帶走。**這不是 viewer 的刪除路徑** —— viewport 的 `handlePointerUp` 只做 `selectObject`。真兇是 `ComponentPanel` 的 dangling-link 自動清理 `useEffect`（`ComponentPanel.tsx:1543`）：cable 一被選中 effect 就掛載 → `resolveLinkLive` 判定兩端都斷 → `clearRfCableEndpointLink` → 依 cable 契約整條刪掉 → PPG 因 orphan 規則連坐（`deleteObjects` 的 cable→PPG 串聯）。
  - **根因又是 legacy-asset 盲點（第 5 處）**：`resolveLinkLive`（`ComponentPanel.tsx:1516`）用 `tc.asset3dId` 找目標儀器的 asset，binding-backed 儀器（switch / amp / DDS）該欄恆 null → 健康的連線被判成 dangling。改用 `primaryAsset`。
  - **加固（比修 bug 更重要）**：`resolveLinkLive` 現在回傳三態 —— `{targetName}` 解析成功、`"gone"` 目標物件確實不存在、`null` 物件在但 asset/anchor 解不出來。**只有 `"gone"` 會觸發刪除**；`null` 只在面板顯示黃字 "? unresolved"。原則：會毀資料的自動清理，只能依據它能積極證實的事實動作，不能依據一次失敗的查詢。
  - **404 幽靈迴圈**：`deleteObjects` 用 `Promise.all`，任一 DELETE 失敗就 throw → 後面的 store reducer 從沒執行 → 物件永遠留在 store → 上面那個 effect 每次 render 都對同一個死 id 重試，console 刷滿 404。改成把 404 視為成功（列已經不在了 = 想要的結果），其餘錯誤照樣拋。
  - **驗證**（live，deletes 只監看不攔截）：選取 RF_CABLE0 → `deleteObjects` 呼叫 0 次、物件數 13→13、面板兩端顯示 `⛓ RF_SWITCH0 · rf_in` / `⛓ RF_SOURCE0 · CH0`（原本兩端都是 ⚠ dangling）。

✅ **隱形物件仍可被點選（2026-08-14）**：`pickObject` / `pickFeature`（`DigitalTwinViewer.tsx:2426`）只過濾 `userData.objectId`，**沒看可見性** —— three 的 raycaster 不會跳過 `visible === false` 的節點（可見性是 render-time 旗標，不是 pick-time）。於是 PPG 強制隱藏的那條 cable、Cables overlay 關掉的 cable、session/collection 隱藏的物件，全都還能被射到選中。這正是使用者「明明看不到 RF_CABLE2 卻點得到、然後被上面那個 effect 刪掉」的入口。加 `pickVisible()`（往上走 parent chain 檢查 `visible`）套在兩條 pick 路徑上；marquee 路徑本來就有 `isObjectVisible` 閘，現在點選與之一致。
  - **連帶要補的逃生門**：加了 pick 閘門之後，「Hide (permanent)」（右鍵選單 → 寫 DB `SceneObject.visible=false`）對 **`outlinerVisible:false` 的 kind（rf_cable / PPG）** 就變成單程票 —— 它們沒有 Outliner 列可以按眼睛復原，3D 又點不到了。兩層一起補：
    1. **Outliner「Managed」區**（`OutlinerPanel.tsx`，樹下方獨立一段）：列出所有 `outlinerVisible:false` 的物件，**每列只有一顆眼睛** —— 不能拖曳、不能鎖、不能刪，因為生命週期仍歸 RF Link 面板管。這是使用者要的形狀，也是最直接的復原路徑。驗證：把 DB-hidden 的 RF_CABLE0 用該眼睛點回來 → `dbVisible false→true`、`wrapperVisible=true`。
    2. **`showAllHidden` 擴充**：原本只重置 session，現在清完 session 後也把「DB `visible=false` 且該 kind 沒有一般 Outliner 列」的物件還原（樂觀更新 + `updateObjectApi` 寫穿，fire-and-forget）。有一般 Outliner 列的 kind 刻意不動 —— 它們的眼睛按鈕才是正解。

✅ **PPG 座落太深 = PPG 自己的公頭長度，不是埠 anchor 的問題（2026-08-14）**：`computePpgMountedThreePose` 把 PPG 的 `rf_out` anchor 貼到目標埠 anchor 上。但那個 anchor 標的是「**公頭離開 PPG 本體的位置**」，不是「與埠對接的面」—— `PPG BNC Male` 的 anchor 在 `z=4.8`，卡榫套筒一路到 `z=13.8`，**9.0 mm 的公頭在 anchor 外面**，於是整根埋進儀器裡、PPG 本體深 9mm。
  - **鐵則：這種偏移必須修在 PPG 這一側，不能去動儀器的埠 anchor。** `ttl_in` 是**共用契約**，cable 的端點解算器也在讀它；為了遷就 PPG 去挪它，會無聲移動插在同一個埠上的每一條 cable —— 這正是本次改 ZYSWA/ZHL anchor 後 amp 那條 cable 偏 8.3mm 的成因。
  - **實作**：`matingProtrusionMm(ppgAsset)` 讀 asset 的 `defaultParams.matingProtrusionMm`，mount 沿對接軸把本體後退該距離，讓**公頭尖端**而非 anchor 落在埠面上。未標註的 asset 回傳 0 → 維持原本 anchor-on-anchor 行為，不做任何猜測。量法：沿 `rf_out` 軸取 mesh 最外緣減去 anchor 座標（此 asset = 13.8 − 4.8 = 9.0）。測試 `ppgMounting.test.ts` M6 同時驗證「有標註會後退」與「未標註不變」。

✅ **改 anchor 座標後 cable 不對位（2026-08-14）**：把 ZYSWA / ZHL 的 port anchor 從 seeder 模板值移到實測接頭面之後，插在上面的 cable 端沒有跟著走。根因＝`resnapRfCablesLinkedTo` **只掛在 pose 提交點**（`updateSceneObject` / `updateSceneObjects`），而改 anchor 是「port 移動了但沒有任何 SceneObject 的 pose 變動」→ 沒有任何東西觸發重算，stored `rfCableNodes` 就停在舊 port 位置。實測偏差：RF_CABLE1.B → amp `rf_in` 差 **8.3 mm**（＝ amp anchor 47.2→55.5 的位移）；switch 那幾端剛好是 0，只因為使用者事後移動過 switch，pose 提交順便觸發了 re-snap。修法＝Asset3D 編輯器存檔成功後（`loadScene()` 之後，確保新座標已發佈），找出所有 `primaryAsset` 指向該 asset 的物件並 `resnapRfCablesLinkedTo`。⚠️ 直接打 API 改 anchor（腳本）仍繞過前端，之後要靠手動移動一次或再存一次 asset 觸發。

✅ **AOM 的 `rf_in` 是模板佔位值，不是實測（2026-08-14）**：`RF_CABLE2.B ⛓ AOM0·rf_in` 接頭整根埋進 AOM 機殼裡。**不是 cable 端算錯** —— 現場數據對到浮點級：node B 相對 AOM0 body = `(40.45, 0, 0)` = `rf_in(15,0,0)` + `25.45`（＝綁定 `sma male` asset 的 `|connect_in − connect_out|`），即 `applyLink`（`DigitalTwinViewer.tsx:3685`，已 binding-aware + `connectorTipMmFromAnchors`）確實把公頭對接面精準放在 anchor 上。錯的是 anchor 本身：`(15, 0, 0)` 來自 `0048_aom_default_rf_in` 的 `transducerOffsetFromCenterMmX`「typical 15 mm」佔位值，原封不動抄進 device registry。實測 `aa_mt80_a1_5_ir.glb`（54000 verts）：機殼 x ∈ [−18.98, 33]，**唯一的同軸特徵**是螺紋外徑 r≈3.18 的圓柱，軸心 `(y 0.000, z −1.2265)`，x≈40 → **45.52（＝bbox max ＝母座對接面）**，x≈37 有 r≈5.37 六角法蘭 —— 也就是裝在 +X 端面的 SMA female。x=15 在機殼**內部**，差 30.5 mm。修成 `(45.5, 0, −1.2265)`，axisX 仍 +X（同 asset 的 `intercept_in` z=−1.226 早就用了這個接頭軸心，佐證 rf_in 從沒對過真模型）。**同步改三處**：DB asset row、[`devices/aa_mt80_a1_5.ts`](../../frontend/src/devices/aa_mt80_a1_5.ts)（否則 re-materialize 打回 15）、`backend/data/kinds.json`（`npm run export:kinds`）。因為走 API 改 anchor 會繞過前端 re-snap（見上一條），另手動依 `resnapRfCablesLinkedTo` 同一套算式把 `RF_CABLE2.B` 的 stored node 補寫（位移量 30.53 mm ＝ anchor 位移，✓）。
  - **通則**：`0048` / `0083` 這批 migration 種下的 RF port anchor **全是參數化佔位值**，只要沒人實測過就會是「差幾十 mm」的原始碼。判斷法：座標很圓（15/0/0）、且與同 asset 其他實測 anchor 的軸心對不上，就是沒對過。量法＝解 GLB 找同軸接頭圓柱（r≈3.2 SMA / r≈5 BNC）的軸心與外端面。
  - **同場另一顆雷（一併修掉）**：viewer 的 AOM drive 迴圈（`DigitalTwinViewer.tsx:1594`）仍讀 legacy `comp.asset3dId` 取 asset → binding 場景恆 null → `rf_in` 找不到 → 每顆 AOM 都 `continue` → `aomOverrides` 恆 `{}`。注意**它不是物理**：AOM drive 是後端 `hydrate_aom_rf_drive` 解的，這張 map 從不送給 server，只當 refetch 的 **dedup 簽章**（`driveSig`）。所以症狀是**時間軸拖過 timing section 邊界時不重抓 trace** —— PPG-TTL 把 switch 切掉了，畫出來的光路還停在上一段，要等某個無關的場景編輯才更新。以前場景無 AOM 沒踩到，AOM0 進場就踩得到。改用 `primaryAsset`（同 §「節點 asset/anchor 解析」的規則，port key 用 `name ?? id` 與 `rfPropagation` 對齊）；連帶移除只餘該處使用的 `assetById`。`npx tsc --noEmit` 綠。⚠️ 同檔還有幾處 legacy `asset3dId` 讀取未動（`:3604` aomAsset、`:3894`、`:4345`/`:4366` relation anchors）。

✅ **PPG 改成無 cable 直接附著（2026-08-14）**：`createPpgAtPort` 過去會建一條真的 rf_cable 當圖的邊，再由 viewer 強制隱藏。三個問題：① 它是一級 SceneObject，看不見卻可被選、可被刪（刪了 PPG 連坐）、可被 permanent-hide 成無法救回；② **性別不成立** —— PPG `rf_out` 是 `bnc_male`，catalog 三款 cable 兩端也全是 male，公對公，這條 cable 物理上不存在；③ 與「PPG 直接插在儀器上」的設計自相矛盾。
  - **新模型**：連接關係存在 PPG 自己身上 —— `SceneObject.properties.ppgAttachment = {targetObjectId, targetAnchorId, targetAnchorName}`。契約與 helper 都在 [`utils/ppgAttachment.ts`](../../frontend/src/utils/ppgAttachment.ts)（含完整 rationale）。**它沒有自己的 SceneObject，所以上述三種失效模式全部不存在。**
  - **四個讀者**：FE BFS `readPpgAttachmentEdges`（`rfPropagation.ts`，與 `readCables` 併成同一組邊）、BE `_read_ppg_attachments`（`rf_resolve.py`，`RfNode.ppg_attachment` 由 loader 從 `properties` 撈）、RF Link 面板的 `edges`/`occupiedPortKeys`/`cableByPortKey` 三個 memo、以及 `ppgMounting.findMatingPort`。全部把它當成 `PPG.rf_out ↔ 目標埠` 的零長度邊，BFS 與 TTL pre-pass 無需特例。
  - **刪除連鎖**：`deleteObjects` 改用 `ppgsAttachedTo`（主儀器進 doomed set → 插在上面的 PPG 跟著刪）。⚠️ 舊的 cable-orphan 判定（「rf_out 上的 cable 全 doomed → 刪 PPG」）**必須加 `cables.length === 0 → continue` 護欄**，否則無 cable 的 PPG 會被讀成「所有 cable 都沒了」，任何一次無關的刪除都會把它一起刪掉。
  - **右鍵 Disconnect**：`cableByPortKey` 對 PPG 兩端都映到 **PPG 自己的 id**，所以既有的「移除」處理器直接刪 PPG —— 這也正好是唯一被允許的 PPG 移除路徑。
  - **legacy 相容**：舊場景仍用 rf_cable 串 PPG 的，`findMatingPort` 會退回走 cable 查找，不需要資料遷移。
  - **驗證**（live）：刪掉舊 PPG（cable + TimingProgram 一併連鎖）→ 用 `createPpgAtPort` 重建 → 物件數 14→**15（只多 PPG，沒有 cable）**、`ppgAttachment` 正確寫入、PPG 存的 pose 還是 spawn `(0,1000,0)` 但**畫出來在 `(-432,553,1920)`**（switch 在 `(-417,558,1920)`）。測試：新增 `ppgAttachment.test.ts`（7）+ `ppgMounting` 第 5 個案例，BE 新增 2 個 parity 案例；FE 22 綠 / BE optical 231 綠。
  - **順手修**：`createProgrammablePulseGenerator` 用 raw append 塞 TimingProgram，與 websocket 廣播重複 → Pulse & Timing 出現兩列同 id 的 "CH0"。改用 `upsertById`。（現場重現並確認修好。）

⚠️ 次要：cable 自身 derived rf port marker（`resolveRfCableAnchorPosition`）仍用寫死 tip；catalog 缺 SMA↔BNC adapter cable variant；viewer 同檔其餘 legacy `asset3dId` 讀取（`:3604`/`:3894`/`:4345`/`:4366`）尚未搬到 `primaryAsset`（AOM drive 迴圈那處已修，見上）。

✅ **PPG rest=HIGH 在 scrub 開著時失效 + AOM 沒 RF 還有 sideband（2026-08-14）**：現場症狀兩條 —— ① `CH0`(PPG, rest=HIGH) 插在 `RF_SWITCH0.ttl_in`，但 RF Link 面板那條線是灰的、switch 之後整條鏈（amp/AOM）全部 "no upstream"；② AOM0 在「面板說沒有 RF」的狀態下 3D 仍畫出整組 sideband。三個獨立根因：
  - **語意**：active scrub 走的是**純正邏輯**（intervals 斷言 HIGH），`restState` 只在 idle snapshot 生效。於是一條「rest=HIGH 且沒畫任何 block」的 channel，一按下 Scrub time 就讀成 LOW → switch 切到沒接線的 RF1 → 下游全滅。改成 XOR（見 §4），FE/BE 同步。
  - **面板**：邊的 active 判定只看 `signalAtPort` 兩端同源（`RfLinkPanel.tsx:1436`），而 PPG 送的是**閘不是載波**，永遠不會進 `signalAtPort` → TTL 線恆灰，看不出 HIGH/LOW。改成再吃 `ppgGateHighObjectIds`（只有 PPG id 會進去，故兩端都測也順便涵蓋 legacy 用 cable 串的 PPG）。
  - **AOM**：`resolve_aom_rf_drive` / viewer 的 `linkDriven`（`DigitalTwinViewer.tsx:1609`）用「有沒有載波」判斷有沒有接線 → switch 常駐另一 throw 時 AOM 被當成沒接線 → 退回額定 drive → 沒 RF 也繞射。改成拓樸判定（見 §4）。連帶：接在**已關電** source 上的 AOM 現在也正確為 0 W（`test_powered_off_source_emits_nothing` 斷言隨之更新）。
  - **診斷陷阱**：查這題時 8010 上有**兩個 uvicorn**（08:43 那組加上一組更早的殭屍 worker，`--reload` 對它無效），API 回的是舊碼、跟同一份原始碼在 process 內跑出來的結果不一致，一度指向錯誤方向。判斷法：改一行 route 加個 marker 欄位再打一次，沒出現就是殭屍（見 memory `uvicorn_reload_windows`）。
  - **驗證**：FE `rfPropagation.test.ts` +5、BE `test_rf_resolve.py` +5（含 rest=HIGH 反轉、program-less PPG、wired-but-silent）；BE optical 236 綠、FE `npx tsc --noEmit` 綠（16 個 frame/fiber 失敗為既有紅）。Live：restart 後 scrub ON/OFF 四條邊皆 active、無 "no upstream"；以現場場景把 restState 改 LOW 跑 pure resolver → AOM 0 W（先前是額定 1.0 W 的 fan）。

✅ **AOM 的 RF 不跟著 RF Link 走（2026-08-14）**：在 RF Link 面板改 CH0 的 Freq/Vpp，數字有變、AOM 的 drive 完全不動。根因＝`commitChannelEdit` 把編輯寫進 `PhysicsElement.kindParams.channels`，而 BFS 的 seed 迴圈解析順序是 `dynamicSources` > Asset `defaultParams` > `kindParams`，**ad9959 asset 自己就帶 `channels`**（`tunable_params = ["channels","fullScaleVpp"]`），asset 層永遠蓋掉 kindParams → 寫進去的值誰也讀不到。面板本身又只從 `kindParams` 讀來顯示，所以 UI 顯示編輯後的值、物理用 asset 的值，兩邊各說各話。修法：讀寫都改走所有權鏈（見 §3 per-port 編輯）。**同型 bug 的判斷法**：任何面板要改「asset 有作者、且標 tunable」的參數，就必須寫 `dynamicSources`；寫 `kindParams` 只會在 asset 沒有該 key 時碰巧生效。Live 驗證：CH0 → 100 MHz 後 `resolve_aom_rf_drive` 回 `aomFreqMhz=100`；再把 Vpp 調到 0.5 → AOM `rf_in` 12.56 Vpp / 0.394 W（0.5 Vpp × amp +29 dB）；驗完把 `dynamic_sources` 清回 `null`，場景還原。
