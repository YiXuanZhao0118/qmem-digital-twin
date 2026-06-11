[← 文件索引](README.md)

# 渲染管線（前端）

> 相關：[asset.md](asset.md)（viewerHints）、[component.md](component.md)（binding 樹）、[optics.md](optics.md)（光束渲染來源）。

- `components/DigitalTwinViewer.tsx` 是主場景建構器。對每個 SceneObject：解析 Component + Asset → 統一走 **Binding-tree 渲染路徑**（最完整、唯一正規路徑）：`buildSceneObjectFromBindings()` → `resolveBindingTree()` → `buildBindingTreeObject()` 走整棵 ComponentBinding 樹，組出（可複合的）元件；葉節點 asset 仍由 `loadAssetObject()` 實際載入幾何，per-instance binding override（如 isolator 前/後 glan 旋轉）在 `resolveBindingTree` 內套用。
  - `shouldRenderViaBindings()`（`bindingRendererGate.ts`）**現恆為 `true`（2026-06-10 統一）**——所有元件都走 binding-tree；舊的單一資產直連 `loadAssetObject()` 分支已成 dead code，待後續連同 `Component.asset_3d_id` 一起移除。
  - ⚠️ **尚未完成**：fiber / rf_cable / isolator 的 per-instance 狀態（`fiberNodes`/`rfCableNodes`/`radiusMm`/ferrule pose/`translucentHousing`）**還沒透過 binding 樹轉送**，所以這三類目前可能以 catalog 預設 spline/pose 渲染（待補狀態轉送，見 [fiber.md](fiber.md)、[cable.md](cable.md)）。
- `three/loadAsset/index.ts`（葉節點載入器）依資產型別分派（STL/GLB/OBJ/`procedural://`）並有特例 builder（PBS252、BB1E03、AD9959、isolator）。
- 材質：`materialFor()` → `colorForComponent()`（kindId 色表 + `colorHex` 覆寫 + 裝置狀態著色）。
- **viewerHints** 驅動幾何過濾：`includeOnlyCentroids`、`deletedCentroids`、`recenterOrigin`。
- 光束渲染：`three/rayTrace.ts` → `v3TraceAdapter.ts` 消費後端 `/api/v3/solver` 輸出，發佈到 `window.__rayTraceDebug`（供 OpticalLinkViewer、BeamScope、snap-to-beam 讀取）。
  - **像散（per-axis qx/qy）**：adapter 的 `beamMode.x/.y` + `waistAtStart/EndUm`（X，qx）與 `waistAtStart/EndUmY`（Y，qy）**各軸獨立**（2026-06-11 修；先前 y 軸誤抄 qx → 永遠圓）。`OpticalLinkViewerPanel` 因此把 3D 光束畫成**橢圓錐管**（自建 BufferGeometry，X 半寬←qx、Y 半寬←qy，每軸各套 `VISUAL_FLOOR_UM`），方向用 `makeBasis` 對到 beam-local **s/p**（local X→s、Z→p；約定 `spatialModeX∥s`，長軸反了就對調 s/p）。圓形光束退化回舊的圓錐。BeamScope 的 2D profile 熱圖同樣讀 `beamMode.x/.y` → 像散顯示為橢圓光斑。**近束腰**兩軸都被 `VISUAL_FLOOR_UM`(30µm) 夾平 → 仍圓；橢圓在下游才明顯。
- 效能：on-demand rendering（閒置 0 renders/sec）、增量重建場景 + `objectWrappersRef` 以 (component, asset, deviceState) 參考相等做 wrapper 快取。
