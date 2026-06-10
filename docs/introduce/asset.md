[← 文件索引](README.md)

# Asset3D — 幾何 + 物理真值層

> 屬 [核心資料模型](data-model.md) 第 1 層。相關：[anchors.md](anchors.md)（anchor 標註）、[kinds.md](kinds.md)（每 kind 物理參數）、[rendering.md](rendering.md)（如何渲染）。

**Asset3D** — 可重用 3D 模型 + 其物理預設。存：`geometryRef`（.glb/.stl）、`kind`、`anchors[]`（光學介面：每個 anchor 帶方向 + aperture）、`defaultParams`（該零件內在物理，如某顆 Thorlabs 透鏡的焦距）、`wavelengthRangeNm`、`viewerHints`。**物理預設只存在這裡。**

## 相關概念

- **anchors[]** — 取代舊的 `faces[]` / `transitions[]`：每個 anchor 本身就是一個光學介面，直接帶**方向**（tri-axis）與 **aperture**。結構與 tracer 用法見 [anchors.md](anchors.md)。
- **defaultParams** — 每 kind 的代表性物理預設值（laser 780.241nm/50mW、AOM v=4200 m/s 等）見 [kinds.md](kinds.md)。
- **viewerHints** — 驅動幾何過濾（`includeOnlyCentroids`、`deletedCentroids`、`recenterOrigin`），渲染端如何消費見 [rendering.md](rendering.md)。
