[← 文件索引](README.md)

# RF Cable — 同軸線（單物件 + per-instance spline）

> **全景索引見 [rf.md](rf.md)**（整個 RF 子系統）。相關：[timing.md](timing.md)（RF 鏈 AD9959→amp→switch→AOM）、[optics.md](optics.md)（RF tracer + AOM 耦合）、[anchors.md](anchors.md)（端點 anchor 由 spline 推導）、[kinds.md](kinds.md)（rf_cable）、[fiber.md](fiber.md)（光纖用**同一套** spline/端點架構）。
> 程式：`three/loadAsset/rf_cable/`、`utils/rfCable{AnchorResolver,Alignment}.ts`、`utils/rfPropagation.ts`、後端 `optical/rf_resolve.py`。

## 資料模型 + 端點連結

一條線 = **一個 SceneObject**，兩個 RF 埠 `rf_in`(A) / `rf_out`(B)。架構與 [fiber.md](fiber.md) 平行（共用 `FiberNode` + `buildFiberCurvePath`），但資料放在不同地方：

- **spline**：`SceneObject.properties.rfCableNodes`（`FiberNode[]`，含 `handleInMm`/`handleOutMm`）。沒有就自動生 2-node 直線（`createSmaShortCable` 讀 `component.properties.lengthMm`，**fallback 150**；kind 的 `default_params.lengthMm` 是 152 —— 兩個預設不一致，但只在「完全沒有 spline」時看得出來）。
- **一旦有 spline，`lengthMm` 就不再描述這條線**：使用者拖 node 後真實長度是 Bezier 弧長（`cableSplineLengthMm(nodes)`，`three/loadAsset/fiber/curve.ts`，量的是 `TubeGeometry` 用的同一條 `CurvePath`，不含接頭 tip）。RF Link 面板標籤走這個值（見「已知 / 注意」）。
- **端點連結**：`SceneObject.properties.rfCableEndpoints = { A, B }`，每個是 `RfCableEndpointLink { targetObjectId, targetAnchorId("rf_in"/"rf_out"), targetAnchorName(如 "CH0") }` —— 把一端釘到另一個元件的 RF 埠。公母對插：cable outward 與目標 outward **反平行**。

## anchor 推導（`utils/rfCableAnchorResolver.ts`）

anchor 標 `derivedFromRfCableEndpoint = "A"|"B"`：
- 位置 = spline 端點 + 接頭 tip 偏移（`RF_CONNECTOR_TIP_MM = 15.5`(SMA) / `RF_BNC_CONNECTOR_TIP_MM = 27`(BNC)）。
- 方向 = spline outward 切線。
- 無 spline 時 fallback 到靜態 `positionMmBodyLocal` / `directionBodyLocal`（預設 +X）。
- `resolveLinkedRfCableEndpoint()` 把某端 node 對到目標埠 lab pose；可用 `nodeOffset{depthMm,sideXMm,sideYMm}` 手動微調。

## 渲染（`three/loadAsset/rf_cable/`）

`createSmaCableSpline()`（`cable_spline.ts`）：Bezier path → `TubeGeometry`（半徑 1.6mm，RG-316 同軸）；兩端依 `properties.endAConnector`/`endBConnector`（或 fallback `connectorType`）放 **SMA / BNC** 接頭，`+X` 對到 outward 切線。接頭幾何走 `connectorModels.ts` 的 `buildRfConnectorGroup()`：有 catalog 真模型用快取模型，否則用程序化 `sma_male_connector.ts` / `bnc_male_connector.ts`。`refreshRfCableWrapperGeometry()` 在拖 node 或連結端點移動時就地更新。

**接頭真模型解析器（`setRfConnectorAssetResolver()`）**：把 connector kind（如 `bnc_male`）對到 catalog Asset3D（先試 slug `bnc_male`＝使用者上傳的 GLB，再試 `rf_connector_<kind>`；`primitive://` 列無可載 mesh → 回 null 走程序化）。載入後由 `connectorBake.ts` 的 `bakeConnectorByAnchors()` 烘焙：把資產的 `connect_out`→`connect_in` 軸轉到目標軸 +X、`connect_out` 移到原點（無此兩 anchor 才退回「最長 bbox 軸轉 +X」啟發式）。**解析器是 module-global 單例，必須由每個會畫 cable 的 viewer 各自註冊**：Lab 在 `DigitalTwinViewer.tsx`、PHY Editor 的 COMPONENT 預覽在 `ComponentsEditor.tsx`（`ComponentPreview3D`）—— 因 PHY Editor 是整頁接管、Lab 已 unmount 把解析器清成 null，少了這個註冊，預覽就只會畫程序化接頭，和 ASSET3D / Lab 看到的真 GLB **形狀不一致**。非同步載入完成由 `subscribeRfConnectorLoaded()` 通知預覽 rebuild（`connectorEpoch` 進 scene effect deps）換上真模型。真模型 mesh 由 `geometryToColoredMesh(geom, THREE.DoubleSide)` 包成 —— **DoubleSide** 對齊 ASSET3D 編輯器（它也強制 `material.side=DoubleSide`），避免 CAD 匯出件反向面被 FrontSide 剔除而看起來破/糊。

**換 mesh 後 Object Sense 仍顯示舊 mesh?** 多半是 **iOS bfcache**:手機把分頁從記憶體還原、沒重跑 JS,catalog store 凍在舊 `file_path`。`App.tsx` 的 `pageshow`(`event.persisted`)監聽會在 bfcache 還原時強制 `location.reload()` 重抓;無痕分頁不受 bfcache 影響,可用來驗證資料其實是新的。fiber 接頭走同一套(`fiberConnectorModels.ts` + `subscribeFiberConnectorLoaded()`),見 [fiber.md](fiber.md)。

**接頭直接進去是低細節(程序化 fallback)、切到 ASSET3D 再回來才變完整?**(2026-06-13 用 headless preview network trace 實證的真根因)`useV3Catalog.fetchAll()` **過去只在 Asset3DEditor 裡呼叫** —— Lab(DigitalTwinViewer)和 COMPONENT 預覽從不載 catalog。所以剛開 app 進 Lab 時 catalog store 是空的,接頭解析器 `getAssetsByKind("fiber_connector")` 回 `[]` → 無 match → 畫程序化 fallback,而且**不會重試**(沒 kick GLB load → 沒 connector-loaded bump)。切到 ASSET3D 才跑 fetchAll 填滿 catalog,回來才配對成功載真 GLB。實證:Lab 的 network 只抓 `/api/scene`、`/api/coils`…**從不抓 `/api/v3/assets3d`**、也沒 `sm_pc_780.glb`。修法:(1) `App.tsx` 開機就 `useV3Catalog.getState().fetchAll()`;(2) DigitalTwinViewer 與 `ComponentPreview3D` 訂閱 `useV3Catalog(s=>s.assets.length)`,在 >0 時 bump `connectorEpoch` → 在 catalog 到齊前就畫好的 cable 重新解析接頭。`THREE.Cache.enabled = true`(main.tsx)只是順手的效能項(避免每次切畫面重抓),不是這個 bug 的解。

**改了接頭資產(重傳 GLB / 改 anchor)後 Object Sense + COMPONENT 仍顯示舊 mesh,切到 ASSET3D 再回來才更新?** geomCache 的 key 是 connector kind / catalogId,**重傳或改 anchor 都不會變**,所以 `loadConnector`/`loadFiberConnector` 命中舊快取就 early-return,永遠送舊烘焙 —— 只有 viewer unmount(切到 ASSET3D tab)觸發 `setResolver(null)` 才清掉。`App.tsx` 訂閱 `useV3Catalog`,在 `assets` 陣列變動時呼叫 `invalidateRfConnectorCache()`/`invalidateFiberConnectorCache()`:清空 geomCache 並 fire load listeners,讓當前掛載的 viewer bump `connectorEpoch` → rebuild → 空快取重抓 → 直接補上新 mesh,不必再手動切 tab。

## 對準（`utils/rfCableAlignment.ts`）

`findRfCableEndpointAlignmentCandidates()`：找 `toleranceMm`(25mm) 內所有 RF 埠 anchor（任何物件的 `rf_in`/`rf_out`），依距離排序；1 個自動 snap，多個（如 AD9959 CH0..CH3）出 picker。`align_variant: none`（不像光學件那樣自由拖對齊）。

## RF 物理：cable 是**圖的一條邊**（透明）

RF **不是光追**，是 port 鄰接圖上的 BFS（`utils/rfPropagation.ts` 前端、`optical/rf_resolve.py` 後端，兩邊同模型）。

- cable 在圖中是 **edge**：`rfCableEndpoints.A ↔ B`，把兩個目標埠接起來。**目前透明**（Phase RF.1：無 dB/m、無頻率相依損耗）——`RfSignalState` 原封不動穿過。
- 對比：`rf_amplifier` 套 `gainDb`（clamp 在 `outputPowerMaxDbm`、超了 `saturated=true`）；`rf_switch` 依 TTL（綁定 PPG 的 timing 或手動 `ttlState`）選通路 + 插入損耗。
- 鏈路：`rf_source`(AD9959 各 `rf_out`=CH 種訊號) → cable → amplifier → cable → switch → cable → **AOM `rf_in`（sink）**。`RfSignalState` 帶 `frequencyMhz`、`vpp`、`cumulativeGainDb`、`passthroughObjectIds`、`saturated`。AOM 端由後端 `resolve_aom_rf_drive()` 解析出 `{aomFreqMhz, rfDrivePowerW=vpp²/(8·50Ω)}` 灌進 Bragg 解。
- **種子 Vpp = `amplitudeScale × fullScaleVpp`**。`fullScaleVpp` 與 **`channels[]` 都是 asset 係數**（`Asset3D.default_params`，權威真值；fullScaleVpp 缺省退回 `AD9959_VPP_FULL_SCALE=1.0`），可由 `SceneObject.dynamic_sources` 逐實例覆寫（須在 asset `tunable_params`，預設 `["channels","fullScaleVpp"]`）——**跟光學 asset 同一套模型**。channels 解析鏈：`dynamic_sources.channels` → `asset.default_params.channels` → 舊 `PhysicsElement.kindParams.channels`(legacy fallback)。AD9959 面板（`Ad9959ObjectControls`）的 per-channel 編輯寫 `dynamicSources.channels`（不再寫 kindParams）；chip 層 PLL/refClock/sync/serial 仍在 kindParams。兩邊 seed loop 同模型（`rf_resolve.py` `RfNode.asset_params`/`dynamic_sources` ⇄ `rfPropagation.ts` `buildAssetParamsByObject`）。
- BFS 為 first-arrival-wins（無疊加）。`/api/rf-chains/nodes`（`routers/rf_chains.py`）存的是 per-terminal RF 鏈 metadata，不是傳播真值。

## kind

`rf_cable`（`primary_domain: rf`）：anchors `rf_in`/`rf_out`（需 direction、不需 aperture），`default_params.lengthMm = 152`，`align_variant: none`。

## 已知 / 注意

- **RF Link 面板節點來源（asset 解析走 binding tree）**：`RfLinkPanel.tsx` 的 node 由該 object 的 `Asset3D.anchors` 經 `rfLinkPortsOf` 推 port，而 asset 用 **`primaryAsset(component, scene)`（`utils/componentBindings.ts`）解析**——先看 root `targetKind="asset"` 的 ComponentBinding，再退回 legacy `component.asset3dId`。**binding-backed 場景裡 `component.asset3dId` 恆為 null、asset 掛在 binding 上**，故面板早期直接讀 `asset3dId` 會對「已掛 asset」的 RF object 找不到 anchors → 節點空白/"NO CONN"（已修）。
- **真的無 asset 時的退路**：`primaryAsset` 仍解不到（無 binding 又無 legacy 欄）才退回 `rfLinkRoleAnchors(kind)` 以 kind 的 `roles` 合約合成 port，使裸 RF object 仍顯示為節點而非被靜默丟棄。代價：合成 port 的 `connectorFamily=null`（顯示 "NO CONN"、`onPointerDown` early-return 不可拉線），且多埠 role 退化為單一泛用埠（CH 名/數量在 asset 上）——須掛上帶 `connectorType` 的 asset 後才完整可連 cable。
- **port 方向讀 axisX 不讀 legacy `directionBodyLocal`**：cable 對準的 port 外法線方向必須用 `anchorObjectLocalPrimaryDir`（axisX → 退回 legacy `directionBodyLocal`，`utils/anchorAccess.ts`）。device-materialized anchor **只帶 `axisXBodyLocal`、`directionBodyLocal` 為 null**，故 `resolvePort`/`findRfCableAlignmentCandidates` 早期直接讀 `anchor.directionBodyLocal` 會退回預設 `+X` → 只要 port 面法線不是 +X（如 ad9959 CH0 面朝 `+Z`）connector 就轉 90°「對不上」。renderer/Debug-anchors overlay 本來就用 axisX 所以畫得對，連線碼之前沒對齊到同一來源。**注意 Debug-anchors overlay 故意跳過 `rf_cable`/`sma_cable`**（`DigitalTwinViewer.tsx` ~L4410：cable 的 connector 位置由 spline node 決定、非 asset 靜態 anchor，畫了會誤導），所以看得到 ad9959 的方向、看不到 cable 的。
- **連線動作也走 binding-aware**：拉線建 cable 的 `sceneStore.createRfCableBetweenPorts`（內部 `resolvePort`）與 cable 端點吸附的 `findRfCableAlignmentCandidates` 同樣改用 `primaryAsset` 解 asset——之前直接讀 `comp.asset3dId`（binding 場景恆 null）會讓 `resolvePort` 回 null → 拉線靜默 no-op（面板有 port、卻建不出 cable）。**注意尚未統一**：RF 傳播顯示讀取（`rfPropagation.ts` / `rfPropagationSchedule.ts` / `ppgMounting.ts` / `aomRfDrive.ts`）仍直接讀 `comp.asset3dId`，binding 場景下 panel 的訊號流動畫/AOM 上游讀數可能為空；要修需把 `componentBindings` 串進這些 builder 並與後端 `rf_resolve.py` BFS 維持 parity。
- **RF Link 面板的長度標籤 = 實際 spline 弧長（2026-08-14 修）**：`RfLinkPanel.tsx` 的 `RfEdge.lengthMm` 以前直接讀 `PhysicsElement.kindParams.lengthMm`（catalog 常數 152），所以任何拉過線的 cable 都被標成 152 mm —— live 場景的 RF_CABLE2 實際 780 mm 卻顯示 152。現在改成 `cableSplineLengthMm(properties.rfCableNodes)`（沒有 spline 才退回 nominal，那正好是 renderer 畫直線的情形）；nominal 值移到 `<title>` tooltip，方便對照「這條線該是幾 mm 的料號」。**接頭 tip 不計入**（tip 在端 node 之外，長度依 connector asset 而定）。單元測試 `three/loadAsset/fiber/__tests__/curveLength.test.ts`。
- **cable 目前零損耗 / 零增益**（透明）；阻抗、每長度損耗、頻率曲線是未來欄位。長度現在是幾何真值，之後要做 dB/m 或傳播延遲時應該用它，不是 `lengthMm`。
- **無疊加**：兩源餵同一埠時 BFS 只記第一個到的。
- `RF_LOAD_Z = 50Ω` 寫死。**接頭 tip 偏移現由 connector asset 的 anchor 推導**（`connectorTipMmFromAnchors` = `|connect_in − connect_out|`，`utils/rfCableAnchorResolver.ts`）：`bakeConnectorByAnchors` 把 connect_out 放在 spline node、connect_in 放在 +tip 處，故對準時 node 退後 = 此距離才能讓 **connect_in 落在目標 port 上**。寫死的 `connectorTipMmForFamily`（SMA 15.5 / BNC 27）只對「程序生成」接頭成立，匯入的 device GLB 不同（sma_male 實測 25.45、bnc_male 43.5）→ 舊版 connect_in 會 overshoot ~10mm（SMA）/ ~16.5mm（BNC）。connect 建線（`createRfCableBetweenPorts`）與 viewer live re-align 都改讀綁定 connector asset 的 anchor。**注意**：cable 自身 derived rf port anchor（`resolveRfCableAnchorPosition`）仍用寫死 `RF_CONNECTOR_TIP_MM`，故那顆 port marker 比 connect_in 短 tip 差；另 viewer `applyLink` 仍有 `targetComp.asset3dId` binding 盲點（binding 場景下 early-return、靠 connect-time stored nodes）。
- spline 存在 `properties`（無 catalog 預設）；舊場景可能沒有 `rfCableNodes`，新生的線自動補 2-node 直線。
- 前後端 BFS 必須 parity（schema 變動兩邊要一起改）。
