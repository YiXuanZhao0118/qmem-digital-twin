[← Doc index](README.md)

# BUILD — Geometry Builder (in-browser CAD → GLB asset)

> Related: [asset.md](asset.md) (what it produces is an Asset3D), [anchors.md](anchors.md) (anchors are annotated afterwards on the ASSET3D tab), [kinds.md](kinds.md) (kind decides domain), [rendering.md](rendering.md) (viewerHints).
> Code: `components/GeometryBuilder.tsx`, `three/occtImport.ts`, `three/loadAsset/viewerHints.ts`, `store/catalogStore.ts`.

## What it is

The BUILD tab turns CAD into a catalog Asset3D **entirely in the browser** — **no server-side CAD conversion required**. Each source (an uploaded STEP, or an existing asset you pick) is one unit; together they form an asset that gets saved into the v3 catalog.

## Pipeline

1. **Load a source**
   - Upload a **STEP** (`.step` / `.stp`) → parsed into three geometry on the frontend by `occt-import-js` (OpenCASCADE compiled to WASM; `importStep` + `occtMeshToGeometry` in `occtImport.ts`), **preserving per-face colour**.
   - Or upload a **mesh file** (`.stl` / `.obj` / `.glb` / `.gltf`) → goes through the shared `loadAssetGeometry` (loaded from a temporary blob URL; `GeometryBuilder.handleFiles` → `loadSourceFile`). Uploads carry no units and, like STEP, are **treated as mm**; STL has no embedded colour → the default grey is applied.
   - Or **pick an existing catalog asset** (GLB / GLTF / OBJ / STL or `procedural://`) as the source.
2. **Decimate**: **meshoptimizer** simplifies the visible mesh live, while an **un-decimated hidden mesh** is kept so centroid keys stay stable after decimation.
3. **Colour / geometry filtering**: include / delete is keyed on a **0.5 mm centroid grid** (`centroidKey`, `findCoplanarCluster`), which maps onto the Asset3D's `viewerHints` (`includeOnlyCentroids` / `deletedCentroids`, see [rendering.md](rendering.md)); filtering carries per-triangle colour along, so colours survive.
4. **Save**: export a **GLB** (`glbToFile`) → through the existing upload route `uploadAsset()` (`catalogStore`). `catalog_id` must be lower-snake-case (`[a-z0-9_]+`).

## Kind and domain

The **kind you pick in BUILD decides the asset's domain** (`kind.domains` is authoritative). A newly imported asset **defaults to kind `unclassified`** (migration `0110`): empty op_set/params/anchors and `domains=['optical','rf','mechanical']` all selected, so before classification it appears in all three domain rails. The dropdown can change it to any real kind. **"No kind" is not a legal state**: `assets_3d.kind_id` is **NOT NULL** (migration `0111`), the dropdown no longer offers a `— none —` entry, and every asset is at least `unclassified`. Several layers on both sides guarantee non-None: the frontend `GeometryBuilder` dropdown's initial value and the ASSET3D editor's save fallback, the backend `v3_catalog.upload_asset3d_v3` and the PUT's `... or "unclassified"`, and `server_default='unclassified'` in the model/DB. Domain-rail bucketing is **fully kind-authoritative**: an asset's domain comes only from `kind.domains` and **no longer reads** `properties.domains` (the per-asset override was removed on 2026-06-11, code and DB data together). BUILD no longer writes `properties.domains` either.

> **Anchors are not annotated in BUILD**: BUILD only handles geometry + colour + kind. Anchors (direction + aperture) are annotated afterwards on the **ASSET3D tab** (see [anchors.md](anchors.md)).

## Edit-in-place

You can load an existing asset as the only source and edit it with its `catalog_id` locked: Save goes through the geometry-replace endpoint, **preserves kind_id** and does not create a new asset (after re-editing, remember to re-check anchors on the ASSET3D tab).

## Viewport caveats

The BUILD viewport **must use a flex layout** (do not apply the shared SHELL grid), with the canvas filling via CSS and a per-frame resize — otherwise the viewport collapses to blank. The dark background plus bright lighting is deliberate.

## Status

M1 §A + M2 §B are done (the in-browser STEP → coloured GLB BUILD tab, occt-import-js + meshoptimizer); B-3 / B-4 / §C / §D remain.
