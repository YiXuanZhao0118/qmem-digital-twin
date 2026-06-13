/**
 * Data-driven FIBRE end-connector models — the fibre analogue of
 * rf_cable/connectorModels.ts. A fibre cable end is identified by
 * (fiberType, polish); the injected resolver maps that to a catalog
 * Asset3D (e.g. the user's GLB `pm_apc_780`). Its mesh is loaded once,
 * baked into the fibre connector frame, cached, and shared.
 *
 * Frame contract (DIFFERS from RF — fibre uses +Y, RF uses +X): the FC
 * placement (`applyFiberFerruleOrientation`) rotates the connector's local
 * **+Y** to the outward endpoint tangent, with the cable-side end at y=0.
 * So `bakeFiberConnectorFrame` aligns the model's longest bbox axis to +Y
 * and drops its near end to y=0 (mirror of RF's bakeConnectorFrame).
 *
 * While a model loads (or if no asset resolves) the caller's procedural FC
 * housing is drawn, so the connector is never invisible; the real model
 * appears on the next fibre re-render once the cache fills. The bbox
 * heuristic is provisional — a model authored pre-aligned (or carrying a
 * connect_in/out anchor pair) can replace it without touching the spline.
 */
import * as THREE from "three";

import { loadAssetGeometry } from "../../loadAssetGeometry";
import { mergeColoredGeometries, geometryToColoredMesh } from "../../glbExport";
import { bakeConnectorByAnchors, type Vec3Mm } from "../connectorBake";

/** What the store-aware caller resolves a (fiberType, polish) pair to.
 *  connectOutMm / connectInMm are the asset's connect_out / connect_in anchor
 *  positions (mm, body frame) — when present they drive the bake. */
export type FiberConnectorAssetSpec = {
  /** Stable cache key — the resolved asset's catalogId. */
  key: string;
  url: string;
  ext: string;
  unit?: string;
  scaleFactor?: number;
  connectOutMm?: Vec3Mm | null;
  connectInMm?: Vec3Mm | null;
};

type Resolver = (fiberType: string, polish: string) => FiberConnectorAssetSpec | null;

let resolver: Resolver | null = null;
const geomCache = new Map<string, THREE.BufferGeometry>();
const loading = new Set<string>();
const loadListeners = new Set<() => void>();

/** Subscribe to "a fibre connector model finished loading into the cache".
 *  A static consumer (the PHY-editor COMPONENT preview) needs this to rebuild
 *  and swap the procedural FC fallback for the real baked mesh once the async
 *  load lands; the Lab re-renders often enough not to. Returns an unsubscribe
 *  fn. Mirrors rf_cable/connectorModels' subscribeRfConnectorLoaded. */
export function subscribeFiberConnectorLoaded(cb: () => void): () => void {
  loadListeners.add(cb);
  return () => loadListeners.delete(cb);
}

/** App wiring point (DigitalTwinViewer): map (fiberType, polish) → a catalog
 *  connector asset. Re-registering clears the cache so a new mapping reloads. */
export function setFiberConnectorAssetResolver(fn: Resolver | null): void {
  resolver = fn;
  geomCache.forEach((g) => g.dispose());
  geomCache.clear();
  loading.clear();
}

async function loadFiberConnector(spec: FiberConnectorAssetSpec): Promise<void> {
  if (geomCache.has(spec.key) || loading.has(spec.key)) return;
  loading.add(spec.key);
  try {
    const subs = await loadAssetGeometry(spec.url, spec.ext, {
      unit: spec.unit,
      scaleFactor: spec.scaleFactor,
    });
    // Fibre placement rotates the connector's local +Y onto the outward tangent.
    const merged = mergeColoredGeometries(subs.map((s) => s.geometry));
    geomCache.set(
      spec.key,
      bakeConnectorByAnchors(merged, spec.connectOutMm, spec.connectInMm, new THREE.Vector3(0, 1, 0)),
    );
    loadListeners.forEach((cb) => cb());
  } catch (e) {
    console.warn(`[fiber] failed to load connector model "${spec.key}" — using procedural FC fallback`, e);
  } finally {
    loading.delete(spec.key);
  }
}

/** Sync builder for the fibre spline. Returns the real catalog model if its
 *  geometry is cached; otherwise kicks the async load and returns the
 *  procedural FC housing so the connector is never invisible. */
export function buildFiberConnectorGroup(
  fiberType: string,
  polish: string,
  fallback: () => THREE.Group,
): THREE.Group {
  if (!resolver) return fallback();
  const spec = resolver(fiberType, polish);
  if (!spec) return fallback();
  const cached = geomCache.get(spec.key);
  if (cached) {
    const group = new THREE.Group();
    group.add(geometryToColoredMesh(cached));
    return group;
  }
  void loadFiberConnector(spec);
  return fallback();
}
