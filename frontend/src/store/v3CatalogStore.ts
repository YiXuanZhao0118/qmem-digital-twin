/**
 * v3 Catalog Store — Zustand store for Asset-Physics-Model v3 catalogs.
 *
 * Pulls from `/api/v3/assets3d` and `/api/v3/components` (read-only in Phase 3a).
 * Cached after first fetch; explicit `refresh()` to invalidate.
 *
 * Consumer pattern:
 *   const lens = useV3Catalog(s => s.getAssetByCatalogId('thorlabs_la1540_b'))
 *   const isolator = useV3Catalog(s => s.getComponentByCatalogId('thorlabs_io_3_850_hp'))
 */

import { create } from "zustand";

import { client } from "../api/client";

// ---------------------------------------------------------------------------
// Types matching the v3 API response shape (CamelModel from backend)
// ---------------------------------------------------------------------------

export type V3Vec3 = { x: number; y: number; z: number };

/** Face transport domain — gates which tracer + which links the face
 *  participates in. See asset-physics-model.md §3 "Face `domain` 規約".
 *  Undefined / null is treated as "optical" for back-compat with rows
 *  written before the field existed. */
export type V3FaceDomain = "optical" | "rf" | "ttl";

export type V3Face = {
  id: string;
  positionMmBodyLocal: V3Vec3;
  normalBodyLocal?: V3Vec3 | null;
  apertureMm: number;
  apertureShape: "rectangle" | "ellipse" | "circle";
  apertureWidthMm?: number | null;
  apertureHeightMm?: number | null;
  domain?: V3FaceDomain | null;
};

export type V3Transition = {
  in: string;
  /** Internal face chain for multi-hop reflective elements (mix of
   *  A-prefixed external faces and B-prefixed internal faces).
   *  Empty/undefined = 2-port slab. See asset-physics-model.md §3.3. */
  via?: string[] | null;
  out: string | string[];
  op: string;
  params?: Record<string, unknown> | null;
  matrix5x5?: number[][] | null;
  abcd?: number[][] | null;
};

export type V3Asset = {
  id: string;
  catalogId: string;
  name: string;
  assetType: string;
  filePath: string;
  physicsKind: string | null;
  faces: V3Face[] | null;
  transitions: V3Transition[] | null;
  defaultParams: Record<string, unknown> | null;
  wavelengthRangeNm: [number, number] | null;
  bodyFrameRotation: { x: number; y: number; z: number; w: number } | null;
  properties: Record<string, unknown>;
};

export type V3AssetUpdate = Partial<{
  physicsKind: string | null;
  faces: V3Face[] | null;
  transitions: V3Transition[] | null;
  defaultParams: Record<string, unknown> | null;
  wavelengthRangeNm: [number, number] | null;
  bodyFrameRotation: { x: number; y: number; z: number; w: number } | null;
}>;

export type V3ComponentBinding = {
  bindingId: string;
  assetId: string;        // DB UUID — resolved against Asset.id
  localXMm: number;
  localYMm: number;
  localZMm: number;
  localRxDeg: number;
  localRyDeg: number;
  localRzDeg: number;
  sortOrder: number;
};

export type V3ExposedFace = {
  componentFaceId: string;
  assetBindingId: string;
  assetFaceId: string;
};

export type V3Component = {
  id: string;
  catalogId: string;
  name: string;
  componentType: string;
  brand: string | null;
  model: string | null;
  exposedFaces: V3ExposedFace[] | null;
  properties: Record<string, unknown>;
  bindings: V3ComponentBinding[];
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Status = "idle" | "loading" | "ready" | "error";

type V3CatalogState = {
  assets: V3Asset[];
  components: V3Component[];
  status: Status;
  error: string | null;
  loadedAt: number | null;

  fetchAll: () => Promise<void>;
  refresh: () => Promise<void>;
  updateAsset: (catalogId: string, patch: V3AssetUpdate) => Promise<V3Asset>;
  getAssetByCatalogId: (catalogId: string) => V3Asset | undefined;
  getAssetByDbId: (dbId: string) => V3Asset | undefined;
  getAssetsByKind: (kind: string) => V3Asset[];
  getComponentByCatalogId: (catalogId: string) => V3Component | undefined;
};

export const useV3Catalog = create<V3CatalogState>((set, get) => ({
  assets: [],
  components: [],
  status: "idle",
  error: null,
  loadedAt: null,

  fetchAll: async () => {
    if (get().status === "loading") return;
    set({ status: "loading", error: null });
    try {
      const [assetsRes, componentsRes] = await Promise.all([
        client.get<V3Asset[]>("/api/v3/assets3d"),
        client.get<V3Component[]>("/api/v3/components"),
      ]);
      set({
        assets: assetsRes.data,
        components: componentsRes.data,
        status: "ready",
        loadedAt: Date.now(),
        error: null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
    }
  },

  refresh: async () => {
    set({ status: "idle", loadedAt: null });
    await get().fetchAll();
  },

  updateAsset: async (catalogId, patch) => {
    const res = await client.put<V3Asset>(
      `/api/v3/assets3d/${encodeURIComponent(catalogId)}`,
      patch,
    );
    const updated = res.data;
    set((state) => ({
      assets: state.assets.map((asset) =>
        asset.catalogId === catalogId ? updated : asset,
      ),
    }));
    return updated;
  },

  getAssetByCatalogId: (catalogId) =>
    get().assets.find((a) => a.catalogId === catalogId),

  getAssetByDbId: (dbId) =>
    get().assets.find((a) => a.id === dbId),

  getAssetsByKind: (kind) =>
    get().assets.filter((a) => a.physicsKind === kind),

  getComponentByCatalogId: (catalogId) =>
    get().components.find((c) => c.catalogId === catalogId),
}));
