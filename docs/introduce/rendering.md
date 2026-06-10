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
- 效能：on-demand rendering（閒置 0 renders/sec）、增量重建場景 + `objectWrappersRef` 以 (component, asset, deviceState) 參考相等做 wrapper 快取。
