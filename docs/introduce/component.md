[← 文件索引](README.md)

# Component / ComponentBinding — 目錄模板 + 綁定樹

> 屬 [核心資料模型](data-model.md) 第 2–3 層。實例化為 [SceneObject](object.md)；綁定樹的渲染路徑見 [rendering.md](rendering.md)。

## Component

**Component** — 目錄「模板」。有 `vendorPart`、一棵 **ComponentBinding 樹**、與對外的 `exposedFaces`。**本身沒有 kind、沒有物理參數**（migration 0094/0095 已把 physics keys 從 components 清空）。

## ComponentBinding

**ComponentBinding** — 綁定樹節點，把資產（或子元件）掛在父節點下，帶 local transform（localX/Y/Z mm、localR deg）、`tunable_axes`、`role_label`、`sort_order`。讓複合元件成立（如 isolator = faraday rod + 前後 Glan 稜鏡 + 外殼）。表 `component_bindings`：`parent_binding_id`、`target_kind`(asset/empty/subcomponent)、`asset_3d_id`…

## exposedFaces

Component 透過 `exposedFaces` 把 `componentFaceId`（如 `optical_in`）映到 `assetBindingId + assetFaceId`，使複合元件對外只露出語意化的光學埠。face 的物理語意見 [anchors.md](anchors.md)。
