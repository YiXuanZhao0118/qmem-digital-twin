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

`computeFiberEndAlignment()` / `findFiberEndAlignmentCandidates()`：把目前 ferrule **tip** 投影到各 beam 段，取 `toleranceMm`（25mm）內的候選，反推新 spline node（End A 入射 `outward=-beam_tangent`、End B 出射 `outward=+beam_tangent`，`node = tip - outward·36.28`），Bezier handle 對齊 beam 方向。對端與 body pose 不動。

## 光學物理（後端 `anchor_ops/fiber.py`）

雙 anchor：`intercept_in`(A) / `intercept_out`(B)。閉式 v1 耦合，無內部光追。耦合效率 `η = η_mode · η_Fresnel · η_α`：
- `η_mode` — Marcuse 高斯重疊：`exp(-r²/w₀²)·exp(-θ²/θ_NA²)`，`w₀ = MFD/2`、`θ_NA = asin(NA)`、r/θ 取自命中橫向偏移與傾角。
- `η_Fresnel` — 兩個 air-glass 面：`(1-R)²`，`R=((n-1)/(n+1))²`。
- `η_α` — Beer-Lambert：`10^(-α·L/10)`，`α=attenuationDbPerKm`、`L=lengthM`。

出射 ray：origin = 出射 anchor.position、direction = 出射 anchor.axisX（**光纖強制基模、抹掉入射傾角資訊**），q 重設為純虛（出射面為腰），power ×= η。

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
