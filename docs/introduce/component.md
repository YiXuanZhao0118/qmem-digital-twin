[← 文件索引](README.md)

# Component / ComponentBinding — 目錄模板 + 綁定樹

> 屬 [核心資料模型](data-model.md) 第 2–3 層。實例化為 [SceneObject](object.md)；綁定樹的渲染路徑見 [rendering.md](rendering.md)。

## Component

**Component** — 目錄「模板」。有 `vendorPart`、一棵 **ComponentBinding 樹**、與對外的 `exposedFaces`。**本身沒有物理 kind、沒有物理參數**（migration 0094/0095 已把 physics keys 從 components 清空；物理由綁定的 asset 之 kind 決定）。`Component.kind_id` 仍存在但只是**目錄分類 slug**（非物理）：決定零件庫內層 group 標籤（`typeKey = kindId || "uncategorized"`），composite 預設為 sentinel `"none"`。可在 **PHY Editor COMPONENT tab** 的 `kind_id` 自由文字欄直接編輯（空＝null）。零件庫外層 category 則由 `properties.category` 直接決定（未設＝Uncategorized，不再由 kind 衍生；見 [kinds.md](kinds.md)）。

## ComponentBinding

**ComponentBinding** — 綁定樹節點，把資產（或子元件）掛在父節點下，帶 local transform（`local_x_mm`/`local_y_mm`/`local_z_mm` + `local_rx_deg`/`local_ry_deg`/`local_rz_deg`，三軸旋轉）、`tunable_axes`、`role`、`sort_order`。讓複合元件成立（如 isolator = faraday rod + 前後 Glan 稜鏡 + 外殼）。表 `component_bindings`：`parent_binding_id`、`target_kind`(asset/empty/subcomponent)、`asset_3d_id`…

## exposedFaces

Component 透過 `exposedFaces` 把對外語意埠（如 `optical_in`）映到 `assetBindingId + anchorId`，使複合元件對外只露出語意化的光學埠（faces 已退役 → anchors，見 [anchors.md](anchors.md)）。
