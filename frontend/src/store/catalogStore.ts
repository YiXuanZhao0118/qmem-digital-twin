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
 *  participates in. See asset-physics-model.md §3 "Face `domain` convention".
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

/** Phase 9.1 anchor schema (alembic 0087). The anchor tracer's primary
 *  input — replaces faces[] + transitions[] (Phase 9.8). PHY Editor
 *  edits these directly; axisY/axisZ are derived from axisX on save. */
export type V3Anchor = {
  id: string;
  positionMmBodyLocal: V3Vec3;
  axisXBodyLocal: V3Vec3;
  axisYBodyLocal: V3Vec3;
  axisZBodyLocal: V3Vec3;
  apertureMm?: number | null;
  apertureShape?: "rectangle" | "ellipse" | "circle" | null;
  apertureWidthMm?: number | null;
  apertureHeightMm?: number | null;
  /** Coax connector on RF / TTL ports (rf_in, rf_out, ttl_in, ...). The
   *  RF Link panel reads this to render the connector family and gate
   *  cable connections. Null / absent on optical anchors. */
  connectorType?: string | null;
  /** Display name for anchors that share an id (rf_switch RF1/RF2, AD9959
   *  CH0..CH3). The RF Link panel + solver key throws/channels by name.
   *  Null / absent on single-port anchors, which fall back to id. */
  name?: string | null;
};

export type V3Asset = {
  id: string;
  catalogId: string;
  name: string;
  assetType: string;
  filePath: string;
  unit: string;
  scaleFactor: number;
  /** Classification slug (alembic 0090). Pointer into the Kind registry. */
  kindId: string | null;
  /** Device-registry pointer (alembic 0118). When set, anchors are a
   *  materialised view of the device template and kindId is written through
   *  from the device's behavioralKind. Null = hand-authored asset. */
  deviceId: string | null;
  /** v3-era schema, being retired (Phase 9.8). Anchors[] is the new
   *  authority. Kept for back-compat reads while migration completes. */
  faces: V3Face[] | null;
  transitions: V3Transition[] | null;
  /** Phase 9.1+ tri-axis anchors. PHY Editor's primary write target.
   *  Mixed-schema legacy entries (snake_case, with name/type fields)
   *  may appear from older backfills — see Phase 2 cleanup migration. */
  anchors: Record<string, unknown>[] | null;
  defaultParams: Record<string, unknown> | null;
  /** Top-level defaultParams keys the asset author marked tunable per-instance
   *  (alembic 0113). Drives which params the SceneObject dynamic-sources editor
   *  exposes. */
  tunableParams: string[] | null;
  wavelengthRangeNm: [number, number] | null;
  properties: Record<string, unknown>;
  /** Human-confirmed "frozen" flag (alembic 0112). True = read-only in the
   *  PHY Editor; the API rejects edits until unlocked. */
  locked: boolean;
};

export type V3AssetUpdate = Partial<{
  name: string;
  kindId: string | null;
  /** Setting this seeds anchors from the device template + writes kindId
   *  through from the device's behavioralKind (alembic 0118). Send it ALONE
   *  (no anchors) to trigger the server-side re-seed. */
  deviceId: string | null;
  faces: V3Face[] | null;
  transitions: V3Transition[] | null;
  anchors: V3Anchor[] | null;
  defaultParams: Record<string, unknown> | null;
  tunableParams: string[] | null;
  wavelengthRangeNm: [number, number] | null;
  properties: Record<string, unknown>;
  locked: boolean;
}>;

export type V3AssetUpload = {
  file: File;
  catalogId: string;
  name: string;
  kindId?: string;
  domain?: "optical" | "rf" | "mechanical";
  unit?: "mm" | "m";
  scaleFactor?: number;
  precisionPreset?: "preview" | "standard" | "high";
  preserveColors?: boolean;
};

type UploadComponentFallbackResponse = {
  asset3dId?: string | null;
  asset3DId?: string | null;
};

const viewerAssetExtensions = new Set(["glb", "gltf", "obj", "stl"]);
const cadSourceExtensions = new Set(["step", "stp", "sldprt", "dxf"]);

function extensionFromFilename(filename: string): string {
  const ext = filename.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  return ext === filename.toLowerCase() ? "" : ext;
}

function uploadMetadata(payload: V3AssetUpload): Record<string, unknown> {
  const assetType = extensionFromFilename(payload.file.name);
  const viewerReady = viewerAssetExtensions.has(assetType);
  const cadSource = cadSourceExtensions.has(assetType);
  return {
    sourceFilename: payload.file.name,
    uploadedAssetType: assetType,
    viewerReady,
    conversionStatus: viewerReady ? "ready" : "cad_source_only",
    colorImportStatus: assetType === "glb" || assetType === "gltf"
      ? "from_file"
      : cadSource
        ? "pending_conversion"
        : "not_available",
    cadImport: {
      sourceFormat: assetType,
      targetFormat: "glb",
      precisionPreset: payload.precisionPreset ?? "standard",
      preserveColors: payload.preserveColors ?? true,
      recommendedSolidWorksExport: "STEP AP242 with Export appearance enabled",
    },
    // NOTE: domain is NOT stamped into properties — it derives from the
    // asset's kind (kind.domains). A stored properties.domains is a
    // redundant copy that drifts (BUILD imports used to stamp ["mechanical"]
    // before a kind was assigned, then never updated).
  };
}

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
  /** Classification slug (alembic 0090). Pointer into the Kind registry. */
  kindId: string | null;
  brand: string | null;
  model: string | null;
  exposedFaces: V3ExposedFace[] | null;
  properties: Record<string, unknown>;
  bindings: V3ComponentBinding[];
};

/** Reference counts for an Asset3D (GET /api/v3/assets3d/{key}/usage).
 *  `objectCount` > 0 means the asset is placed in a scene — the editor
 *  locks connector_type editing + Delete so a catalog-level change can't
 *  retroactively break those instances. */
export type V3AssetUsage = {
  componentCount: number;
  objectCount: number;
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
  /** `key` is catalog_id slug for seeded rows or row UUID for legacy
   *  mechanical Asset3Ds that have catalog_id = NULL. Backend resolves
   *  either form against the same row. */
  updateAsset: (key: string, patch: V3AssetUpdate) => Promise<V3Asset>;
  deleteAsset: (key: string) => Promise<void>;
  /** Fetch how many components / placed scene objects reference an asset.
   *  Used to gate in-use editing; not cached in store state. */
  fetchAssetUsage: (key: string) => Promise<V3AssetUsage>;
  uploadAsset: (payload: V3AssetUpload) => Promise<V3Asset>;
  updateAssetGeometry: (catalogId: string, payload: V3AssetUpload) => Promise<V3Asset>;
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
      // has_v3=false returns the FULL Asset3D / Component catalog, not just
      // rows that already have a stable catalog_id slug. Binding dev needs
      // the full set (mechanical-bucket Asset3Ds without catalog_id outnumber
      // the v3-seeded ones ~9-to-1); the editor's domain filter handles the
      // optical/rf/mechanical bucketing client-side from physicsKind and
      // properties.domainOverride.
      const [assetsRes, componentsRes] = await Promise.all([
        client.get<V3Asset[]>("/api/v3/assets3d", { params: { has_v3: false } }),
        client.get<V3Component[]>("/api/v3/components", { params: { has_v3: false } }),
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

  updateAsset: async (key, patch) => {
    // `key` accepts catalog_id slug OR row UUID (backend resolves both).
    // Local state diff is keyed on the returned row's id so it doesn't
    // matter which form the caller passed.
    const res = await client.put<V3Asset>(
      `/api/v3/assets3d/${encodeURIComponent(key)}`,
      patch,
    );
    const updated = res.data;
    set((state) => ({
      assets: state.assets.map((asset) =>
        asset.id === updated.id ? updated : asset,
      ),
    }));
    return updated;
  },

  deleteAsset: async (key) => {
    await client.delete(`/api/v3/assets3d/${encodeURIComponent(key)}`);
    set((state) => ({
      assets: state.assets.filter(
        (asset) => asset.catalogId !== key && asset.id !== key,
      ),
      // Bindings inside components also went away server-side; refresh
      // the component view next time it's read by clearing loadedAt.
      loadedAt: null,
    }));
  },

  fetchAssetUsage: async (key) => {
    const res = await client.get<V3AssetUsage>(
      `/api/v3/assets3d/${encodeURIComponent(key)}/usage`,
    );
    return res.data;
  },

  uploadAsset: async (payload) => {
    const form = new FormData();
    form.append("file", payload.file);
    form.append("catalog_id", payload.catalogId);
    form.append("name", payload.name);
    if (payload.kindId) form.append("kind_id", payload.kindId);
    if (payload.domain) form.append("domain", payload.domain);
    form.append("unit", payload.unit ?? "mm");
    form.append("scale_factor", String(payload.scaleFactor ?? 1));
    form.append("precision_preset", payload.precisionPreset ?? "standard");
    form.append("preserve_colors", String(payload.preserveColors ?? true));

    try {
      const res = await client.post<V3Asset>("/api/v3/assets3d/upload", form, {
        timeout: 600000,
      });
      const created = res.data;
      set((state) => ({ assets: [...state.assets, created] }));
      return created;
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status !== 405) throw error;

      // Older running backends may route /api/v3/assets3d/upload through
      // /api/v3/assets3d/{catalog_id}, returning 405 until the server is
      // restarted. Fall back to the existing component-upload path, then
      // stamp the created Asset3D with the v3 catalog fields the editor
      // needs.
      const fallbackForm = new FormData();
      fallbackForm.append("file", payload.file);
      fallbackForm.append("name", payload.name);
      fallbackForm.append("kind_id", "none");
      fallbackForm.append("unit", payload.unit ?? "mm");
      fallbackForm.append("scale_factor", String(payload.scaleFactor ?? 1));
      const fallback = await client.post<UploadComponentFallbackResponse>(
        "/api/assets/upload-component",
        fallbackForm,
        { timeout: 600000 },
      );
      const assetId = fallback.data.asset3dId ?? fallback.data.asset3DId;
      if (!assetId) {
        throw new Error("Fallback upload succeeded but did not return asset3dId.");
      }

      const updated = await client.put<V3Asset>(`/api/assets/${encodeURIComponent(assetId)}`, {
        name: payload.name,
        catalogId: payload.catalogId,
        kindId: payload.kindId ?? (payload.domain === "mechanical" ? "none" : null),
        properties: uploadMetadata(payload),
        defaultParams: {},
      });
      await get().refresh();
      return get().assets.find((asset) => asset.id === updated.data.id) ?? updated.data;
    }
  },

  updateAssetGeometry: async (catalogId, payload) => {
    const form = new FormData();
    form.append("file", payload.file);
    if (payload.name) form.append("name", payload.name);
    form.append("unit", payload.unit ?? "mm");
    form.append("scale_factor", String(payload.scaleFactor ?? 1));
    form.append("precision_preset", payload.precisionPreset ?? "standard");
    form.append("preserve_colors", String(payload.preserveColors ?? true));
    const res = await client.put<V3Asset>(
      `/api/v3/assets3d/${encodeURIComponent(catalogId)}/geometry`,
      form,
      { timeout: 600000 },
    );
    const updated = res.data;
    set((state) => ({
      assets: state.assets.map((a) => (a.catalogId === catalogId ? updated : a)),
    }));
    return updated;
  },

  getAssetByCatalogId: (catalogId) =>
    get().assets.find((a) => a.catalogId === catalogId),

  getAssetByDbId: (dbId) =>
    get().assets.find((a) => a.id === dbId),

  getAssetsByKind: (kind) =>
    get().assets.filter((a) => a.kindId === kind),

  getComponentByCatalogId: (catalogId) =>
    get().components.find((c) => c.catalogId === catalogId),
}));
