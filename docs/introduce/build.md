[← 文件索引](README.md)

# BUILD — Geometry Builder（瀏覽器內 CAD → GLB 資產）

> 相關：[asset.md](asset.md)（產出的就是 Asset3D）、[anchors.md](anchors.md)（anchor 在 ASSET3D tab 事後標）、[kinds.md](kinds.md)（kind 決定 domain）、[rendering.md](rendering.md)（viewerHints）。
> 程式：`components/GeometryBuilder.tsx`、`three/occtImport.ts`、`three/loadAsset/viewerHints.ts`、`store/catalogStore.ts`。

## 它是什麼

BUILD tab 讓你**全程在瀏覽器**把 CAD 變成 catalog 裡的 Asset3D，**不需要 server 端 CAD 轉檔**。每個來源（上傳的 STEP 或挑選的既有資產）是一個 unit，組成一顆資產後存進 v3 catalog。

## 管線

1. **載入來源**
   - 上傳 **STEP**（`.step` / `.stp`）→ 用 `occt-import-js`（OpenCASCADE 編成的 WASM；`occtImport.ts` 的 `importStep` + `occtMeshToGeometry`）在前端解析成 three geometry，**保留每面顏色**。
   - 或從 catalog **挑既有資產**（GLB / GLTF / OBJ / STL 或 `procedural://`）當來源。
2. **減面（decimate）**：用 **meshoptimizer** 即時簡化可見 mesh；同時保留一份**未減面的隱藏 mesh**，讓 centroid key 在減面後仍穩定。
3. **顏色 / 幾何過濾**：以 **0.5 mm centroid 格點**為 key（`centroidKey`、`findCoplanarCluster`）做 include / delete，對應 Asset3D 的 `viewerHints`（`includeOnlyCentroids` / `deletedCentroids`，見 [rendering.md](rendering.md)）；篩選時連 per-triangle 顏色一起帶，保色。
4. **存檔**：匯出 **GLB**（`glbToFile`）→ 走既有上傳路由 `uploadAsset()`（`catalogStore`）。`catalog_id` 必須是 lower-snake-case（`[a-z0-9_]+`）。

## kind 與 domain

BUILD 上選的 **kind 決定資產的 domain**（`kind.domains` 為權威）。新匯入的資產**預設 kind = `unclassified`**（migration `0110`）：op_set/params/anchor 全空、`domains=['optical','rf','mechanical']` 全選，所以未分類前會同時出現在三個 domain rail。下拉可改選任一真實 kind。**「無 kind」不是合法狀態**：`assets_3d.kind_id` **NOT NULL**（migration `0111`），下拉已無 `— none —` 空選項，每個 asset 至少是 `unclassified`。前後端多層都保證非 None：前端 `GeometryBuilder` 下拉初值 + ASSET3D 編輯器 save fallback、後端 `v3_catalog.upload_asset3d_v3` 與 PUT 的 `... or "unclassified"`、model/DB 的 `server_default='unclassified'`。domain rail 分桶**完全 kind-authoritative**：asset 的 domain 只由 `kind.domains` 決定，**不再讀** `properties.domains`（per-asset 覆寫已於 2026-06-11 連同 code 與 DB 資料一併移除）。BUILD 也不再寫入 `properties.domains`。

> **Anchor 不在 BUILD 標**：BUILD 只負責幾何 + 顏色 + kind。anchor（方向 + aperture）在 **ASSET3D tab** 事後標（見 [anchors.md](anchors.md)）。

## Edit-in-place

可把既有資產載成唯一來源、鎖住其 `catalog_id` 編輯：Save 走 geometry-replace 端點，**保留 kind_id**、不新建資產（重編後記得回 ASSET3D tab 複查 anchors）。

## Viewport 注意事項

BUILD 視埠**必須用 flex 佈局**（不要套共用 SHELL grid）＋ canvas CSS 填滿 ＋ 每幀 resize，否則視埠會塌成空白；背景刻意深色 + 打亮燈光。

## 狀態

M1 §A + M2 §B 已完成（瀏覽器 STEP → 上色 GLB 的 BUILD tab，occt-import-js + meshoptimizer）；B-3 / B-4 / §C / §D 仍待做。
