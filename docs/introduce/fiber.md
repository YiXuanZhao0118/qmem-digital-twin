[← 文件索引](README.md)

# Fiber — 光纖（單物件 + per-instance spline）

> 相關：[optics.md](optics.md)（耦合物理進到光追）、[anchors.md](anchors.md)（端點 anchor 由 spline 推導）、[kinds.md](kinds.md)（fiber / fiber_coupler）、[cable.md](cable.md)（RF cable 用同一套 spline/端點架構）。
> 程式：`optical/fiber/`、`three/loadAsset/fiber/`、`utils/fiber{Alignment,BodyEndpointResolver,AnchorResolver}.ts`、後端 `optical/anchor_ops/fiber.py`。

## 資料模型（單物件模型，post-0056）

一條光纖 = **一個 SceneObject**（Outliner 一條）。兩端 A/B 的 pose 內嵌在 `PE.kindParams.endA` / `endB`（body-local）：

- `posMm` — **接頭後端（wire 與 ferrule 的 junction）= spline 端點 = mesh 原點**。
- `tensionHandleMm` — outward 方向 + Bezier 切線的**單一真值**（ferrule 朝向也由它定）。
- `rotDeg` — **只是 ferrule 視覺 roll**，不轉 wire 切線。
- 加上每端物理欄：`numericalAperture`、`modeFieldDiameterUm`、`coreDiameterUm`、`connectorType`(FC/SC/…)、`polish`(PC/APC/UPC)…

> **光學 tip ≠ posMm**：`tip = posMm + outward · FIBER_FERRULE_TIP_MM`，`outward = -unit(tensionHandleMm)`，`FIBER_FERRULE_TIP_MM = 36.28 mm`（Thorlabs FC 30126A9 殼長）。所有 anchor 位置/方向都經 `fiberAnchorResolver.ts` 的 `resolveAnchorPosition()`/`resolveAnchorDirection()` 由 spline 推導（anchor 標 `derivedFromFiberEndpoint`）。

**Migration 演進**：`0052` 把一條 fiber 拆成三個 SceneObject（`fiber_end_a` / body / `fiber_end_b`）→ `0056` **收回單物件**，把端點 pose 烤進 kindParams、刪掉 fiber_end 物件。移動/旋轉 fiber 會同時帶兩端。

## 渲染（`three/loadAsset/fiber/`）

`createFiberSplineObject()`（`spline.ts`）建一個 Group：
- **管身**：`buildFiberCurvePath()`（`curve.ts`）由 `FiberNode[]`（含 `handleInMm`/`handleOutMm`）組 CubicBezier → `TubeGeometry`（半徑 `radiusMm`）。jacket 顏色依 fiberType（SM 黃、PM 藍、MM 橘）。
- **兩端 FC 接頭**：`thorlabs_30126a9_fc_connector.ts` 的快取 STL，`applyFiberFerruleOrientation()` 把接頭 +Y 對到 outward。
- **端點鎖定**：capability profile `fiber: { endpointSplineNodesLocked: true }` — spline 端點（node 0 / N−1）只能用 **Align End A / B** 按鈕動，中間 node 可自由拖。
- `refreshFiberWrapperGeometry()` 在 node/半徑變動時就地換 tube，不重建整個 wrapper。

## 對準（`utils/fiberAlignment.ts`）

`computeFiberEndAlignment()` / `findFiberEndAlignmentCandidates()`：把目前 ferrule **tip** 投影到各 beam 段，取 `toleranceMm`（25mm）內的候選，反推新 spline node（End A 入射 `outward=-beam_tangent`、End B 出射 `outward=+beam_tangent`，`node = tip - outward·36.28`），Bezier handle 對齊 beam 方向。對端與 body pose 不動。投影數學是純函式,Align A/B 與 per-end 端口編輯器共用。

**端點讀取的單一入口 = `sceneStore.resolveEffectiveFiberNodes(obj, component, physicsElements)`**：優先 `SceneObject.properties.fiberNodes`(≥2)→ `Component.properties.fiberNodes`(≥2)→ 否則由 fiber PE 的 `kindParams.endA/endB` 經 `syncFiberNodesFromKindParams()` 重建。**這一步是 connector-component fiber 能對齊的關鍵** —— 它剛實例化時只有 `kindParams.endA/endB`、沒有 cached `fiberNodes`(後端 `default_kind_params_for_component` 只 seed kindParams),舊版直接讀 `properties.fiberNodes` 在 `length<2` early-return → Align「完全沒反應」。`findFiberAlignmentCandidates` / `applyFiberAlignmentCandidate` / `setFiberPortLabPose` / `FiberPortPoseEditor` / FiberEditor 的 node 計數全走這個 resolver。

**寫回必須雙寫**:端點編輯(Align apply 與 port-pose 編輯)除了寫 `properties.fiberNodes`,還要把端點同步進 `kindParams.endA/endB`(`posMm`=junction、`tensionHandleMm`=handle),由共用 helper `sceneStore.syncFiberEndpointToKindParams()` 完成。只寫 `fiberNodes` 是死路 —— load 時 `syncFiberNodesFromKindParams()` 會用 kindParams 覆寫端點,改動會回彈。

## 光學物理（後端 `anchor_ops/fiber.py`）

雙 anchor：`intercept_in`(A) / `intercept_out`(B)。閉式 v1 耦合，無內部光追。耦合效率 `η = η_mode · η_Fresnel · η_α`：
- `η_mode` — Marcuse 高斯重疊：`exp(-r²/w₀²)·exp(-θ²/θ_NA²)`，`w₀ = MFD/2`、`θ_NA = asin(NA)`、r/θ 取自命中橫向偏移與傾角。
- `η_Fresnel` — 兩個 air-glass 面：`(1-R)²`，`R=((n-1)/(n+1))²`。
- `η_α` — Beer-Lambert：`10^(-α·L/10)`，`α=attenuationDbPerKm`、`L=lengthM`。

出射 ray：origin = 出射 anchor.position、direction = 出射 anchor.axisX（**光纖強制基模、抹掉入射傾角資訊**），q 重設為純虛（出射面為腰），power ×= η。

### connector-component fiber 的 intercept slot 由後端「合成」(2026-06-13)

`fiber_anchor_op` 只在 ray 命中 id 為 `intercept_in/intercept_out` 的 anchor 時觸發。但新的 connector-component fiber 綁的是兩個 `fiber_connector` 資產(anchor 是 `connect_in/connect_out`、op passthrough、且 `connect_*` 不在 `anchor_tracer.PRIMARY_ANCHOR_IDS`)—— 場景裡**沒有**任何 `fiber`-kind + `intercept_in/out` 的 slot,beam 會直接穿過、不耦合。

修法在後端 loader:`db_scene_loader.load_anchor_scene_from_db` 對每個 `comp.kind_id=="fiber"` 的物件,由其 fiber PhysicsElement 的 `kindParams.endA/endB` **合成一個 `fiber`-kind slot**(`_synth_fiber_slot`):
- `intercept_in`←endA、`intercept_out`←endB;`position = posMm + outward·tip_mm`、`outward = −unit(tensionHandleMm)`。`posMm`(junction)+ outward 來自 **Align 寫進 kindParams 的 per-instance 真值**(接頭實際擺放處,loader 不讀靜態 Asset3D anchor)。
- **光學面偏移 `tip_mm` 與命中 aperture 都取自該端 connector 綁定資產的 `connect_in` anchor**(`_connector_tip_and_aperture`):`tip_mm = |connect_in − connect_out|`、`aperture = connect_in.apertureMm`。**亦即合成的 `intercept_in/out` 精準落在你在 asset 定義的 `connect_in` 上(= fiber 收光面 = beam waist 處)** —— 調 asset 的 connect_in 位置/aperture 就同步改變光學面與接受窗;缺 connector 時退回 36.28 / endX.apertureDiameterMm。aperture 只決定「算不算命中」,η 仍由 Marcuse 重疊決定。
- `default_params` 由 kindParams 映射成 op 讀的 key:`coreMfdUm←modeFieldDiameterUm`、`numericalAperture`、`coreRefractiveIndex←glassIndexAtDesignLambda`、`attenuationDbPerKm←attenuationCurve[0].dbPerKm`、`lengthM←`spline 長度。
- 兩個 `fiber_connector` passthrough slot 照樣存在,無害(connect_* 不被命中)。
- 範圍:目前只 Lab(`run-from-db`);COMPONENT 預覽(`load_anchor_scene_from_component`)尚未合成。`fiber_coupler`(單 anchor)走原路徑。測試見 `backend/tests/optical/test_fiber_connector_coupling.py`。

## kinds：fiber vs fiber_coupler

| kind | 角色 | anchors | 對準 |
|---|---|---|---|
| `fiber` | 雙向 patch cable（兩個光學埠） | `intercept_in` + `intercept_out` | per-end Align 按鈕（`align_variant: none`，tol 25mm） |
| `fiber_coupler` | 自由空間 ↔ 光纖耦合/準直 | 只 `intercept_in` | translate-to-beam（單 anchor） |

兩者**共用** `fiber_anchor_op`（後端 `register_anchor_op("fiber"/"fiber_coupler", …)`）；差別在 anchor 數與對準方式。fiber 代表性 defaultParams：PM、NA 0.13、MFD 5.3µm、design 780nm、5 dB/km、min bend 25mm。

## 已知 / 注意

- **posMm = 接頭後端 junction，不是光學 tip**（2026-05-17 釐清；舊註解曾誤寫 posMm=emission point）。
- 端點鎖定 → 只能用 Align A/B 按鈕移端點，避免端點漂移。
- `fiber_end` kind 於 0056 後封存（僅留 manifest 讓舊資料可解析）。
- `utils/__tests__/fiberAlignment.test.ts`、`fiberBodyEndpointResolver.test.ts` 屬已知 pre-existing-red（見 [known-issues.md](known-issues.md)）。
