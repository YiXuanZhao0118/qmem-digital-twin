[← 文件索引](README.md)

# RF Cable — 同軸線（單物件 + per-instance spline）

> 相關：[timing.md](timing.md)（RF 鏈 AD9959→amp→switch→AOM）、[optics.md](optics.md)（RF tracer + AOM 耦合）、[anchors.md](anchors.md)（端點 anchor 由 spline 推導）、[kinds.md](kinds.md)（rf_cable）、[fiber.md](fiber.md)（光纖用**同一套** spline/端點架構）。
> 程式：`three/loadAsset/rf_cable/`、`utils/rfCable{AnchorResolver,Alignment}.ts`、`utils/rfPropagation.ts`、後端 `optical/rf_resolve.py`。

## 資料模型 + 端點連結

一條線 = **一個 SceneObject**，兩個 RF 埠 `rf_in`(A) / `rf_out`(B)。架構與 [fiber.md](fiber.md) 平行（共用 `FiberNode` + `buildFiberCurvePath`），但資料放在不同地方：

- **spline**：`SceneObject.properties.rfCableNodes`（`FiberNode[]`，含 `handleInMm`/`handleOutMm`）。沒有就由 `lengthMm`（預設 152mm）自動生 2-node 直線。
- **端點連結**：`SceneObject.properties.rfCableEndpoints = { A, B }`，每個是 `RfCableEndpointLink { targetObjectId, targetAnchorId("rf_in"/"rf_out"), targetAnchorName(如 "CH0") }` —— 把一端釘到另一個元件的 RF 埠。公母對插：cable outward 與目標 outward **反平行**。

## anchor 推導（`utils/rfCableAnchorResolver.ts`）

anchor 標 `derivedFromRfCableEndpoint = "A"|"B"`：
- 位置 = spline 端點 + 接頭 tip 偏移（`RF_CONNECTOR_TIP_MM = 15.5`(SMA) / `RF_BNC_CONNECTOR_TIP_MM = 27`(BNC)）。
- 方向 = spline outward 切線。
- 無 spline 時 fallback 到靜態 `positionMmBodyLocal` / `directionBodyLocal`（預設 +X）。
- `resolveLinkedRfCableEndpoint()` 把某端 node 對到目標埠 lab pose；可用 `nodeOffset{depthMm,sideXMm,sideYMm}` 手動微調。

## 渲染（`three/loadAsset/rf_cable/`）

`createSmaCableSpline()`（`cable_spline.ts`）：Bezier path → `TubeGeometry`（半徑 1.6mm，RG-316 同軸）；兩端依 `properties.endAConnector`/`endBConnector`（或 fallback `connectorType`）放 **SMA / BNC** 接頭，`+X` 對到 outward 切線。接頭幾何走 `connectorModels.ts` 的 `buildRfConnectorGroup()`：有 catalog 真模型用快取模型（`setRfConnectorAssetResolver()` 注入解析器、`bakeConnectorFrame()` 把最長 bbox 軸轉 +X），否則用程序化 `sma_male_connector.ts` / `bnc_male_connector.ts`。`refreshRfCableWrapperGeometry()` 在拖 node 或連結端點移動時就地更新。

## 對準（`utils/rfCableAlignment.ts`）

`findRfCableEndpointAlignmentCandidates()`：找 `toleranceMm`(25mm) 內所有 RF 埠 anchor（任何物件的 `rf_in`/`rf_out`），依距離排序；1 個自動 snap，多個（如 AD9959 CH0..CH3）出 picker。`align_variant: none`（不像光學件那樣自由拖對齊）。

## RF 物理：cable 是**圖的一條邊**（透明）

RF **不是光追**，是 port 鄰接圖上的 BFS（`utils/rfPropagation.ts` 前端、`optical/rf_resolve.py` 後端，兩邊同模型）。

- cable 在圖中是 **edge**：`rfCableEndpoints.A ↔ B`，把兩個目標埠接起來。**目前透明**（Phase RF.1：無 dB/m、無頻率相依損耗）——`RfSignalState` 原封不動穿過。
- 對比：`rf_amplifier` 套 `gainDb`（clamp 在 `outputPowerMaxDbm`、超了 `saturated=true`）；`rf_switch` 依 TTL（綁定 PPG 的 timing 或手動 `ttlState`）選通路 + 插入損耗。
- 鏈路：`rf_source`(AD9959 各 `rf_out`=CH 種訊號) → cable → amplifier → cable → switch → cable → **AOM `rf_in`（sink）**。`RfSignalState` 帶 `frequencyMhz`、`vpp`、`cumulativeGainDb`、`passthroughObjectIds`、`saturated`。AOM 端由後端 `resolve_aom_rf_drive()` 解析出 `{aomFreqMhz, rfDrivePowerW=vpp²/(8·50Ω)}` 灌進 Bragg 解。
- BFS 為 first-arrival-wins（無疊加）。`/api/rf-chains/nodes`（`routers/rf_chains.py`）存的是 per-terminal RF 鏈 metadata，不是傳播真值。

## kind

`rf_cable`（`primary_domain: rf`）：anchors `rf_in`/`rf_out`（需 direction、不需 aperture），`default_params.lengthMm = 152`，`align_variant: none`。

## 已知 / 注意

- **cable 目前零損耗 / 零增益**（透明）；阻抗、每長度損耗、頻率曲線是未來欄位。
- **無疊加**：兩源餵同一埠時 BFS 只記第一個到的。
- `RF_LOAD_Z = 50Ω` 寫死；接頭 tip 長度（SMA 15.5 / BNC 27mm）寫死。
- spline 存在 `properties`（無 catalog 預設）；舊場景可能沒有 `rfCableNodes`，新生的線自動補 2-node 直線。
- 前後端 BFS 必須 parity（schema 變動兩邊要一起改）。
