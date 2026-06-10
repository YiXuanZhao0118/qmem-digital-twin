/**
 * Data-driven RF-cable end-connector models. Each connector kind ("sma" / "bnc")
 * maps to a catalog Asset3D whose mesh is loaded, baked into the cable connector
 * frame, cached once, and shared across every cable instance — mirroring the FC
 * fiber connector's STL-cache pattern, but resolving the source asset through an
 * injected resolver instead of a hardcoded path so this module stays free of any
 * store import (which would also reintroduce an import cycle through the catalog
 * store → loadAsset tree).
 *
 * While a model is loading (or if no asset is mapped) the cable falls back to the
 * procedural SMA/BNC connector so the end is never invisible; the imported model
 * appears on the next full cable re-render once the cache fills.
 */

import * as THREE from "three";

import { loadAssetGeometry } from "../../loadAssetGeometry";
import { mergeColoredGeometries, geometryToColoredMesh } from "../../glbExport";
import { mmToThree } from "../../transformUtils";

export type RfConnectorKind = "sma" | "bnc";

/** What the store-aware caller resolves a connector kind to. `url` is already
 *  run through `resolveAssetUrl`; `ext` is the lowercased file extension. */
export type RfConnectorAssetSpec = {
  url: string;
  ext: string;
  unit?: string;
  scaleFactor?: number;
};

type Resolver = (kind: RfConnectorKind) => RfConnectorAssetSpec | null;

let resolver: Resolver | null = null;
const geomCache = new Map<RfConnectorKind, THREE.BufferGeometry>();
const loading = new Set<RfConnectorKind>();

/** App wiring point: the store-aware layer (DigitalTwinViewer) registers how
 *  each connector kind maps to a catalog asset. Re-registering clears the cache
 *  so a new mapping (e.g. swapped placeholder) re-loads. */
export function setRfConnectorAssetResolver(fn: Resolver | null): void {
  resolver = fn;
  geomCache.forEach((g) => g.dispose());
  geomCache.clear();
  loading.clear();
}

/** Bake a loaded connector asset into the cable connector frame: cable-side end
 *  at x=0, mating axis = +X (the spline rotates +X onto the outward tangent).
 *  Provisional alignment for placeholder validation — the model's longest bbox
 *  axis becomes +X and its near end drops to x=0, centred on Y/Z. Real connector
 *  assets will be authored pre-aligned (or carry an anchor) so this heuristic
 *  can be replaced without touching the cable spline. */
function bakeConnectorFrame(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  geom.scale(mmToThree(1), mmToThree(1), mmToThree(1)); // mm → three-units (cable frame)
  geom.computeBoundingBox();
  const size = new THREE.Vector3();
  geom.boundingBox!.getSize(size);
  if (size.y >= size.x && size.y >= size.z) geom.rotateZ(Math.PI / 2); // longest = Y → X
  else if (size.z >= size.x && size.z >= size.y) geom.rotateY(Math.PI / 2); // longest = Z → X
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  geom.translate(-bb.min.x, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);
  return geom;
}

async function loadConnector(kind: RfConnectorKind): Promise<void> {
  if (geomCache.has(kind) || loading.has(kind) || !resolver) return;
  const spec = resolver(kind);
  if (!spec) return;
  loading.add(kind);
  try {
    const subs = await loadAssetGeometry(spec.url, spec.ext, {
      unit: spec.unit,
      scaleFactor: spec.scaleFactor,
    });
    geomCache.set(kind, bakeConnectorFrame(mergeColoredGeometries(subs.map((s) => s.geometry))));
  } catch (e) {
    console.warn(`[rf_cable] failed to load "${kind}" connector model — using procedural fallback`, e);
  } finally {
    loading.delete(kind);
  }
}

/** Sync connector builder for the cable spline. Returns the real catalog model
 *  if its geometry is cached; otherwise kicks the async load and returns the
 *  procedural fallback so the connector is never invisible. */
export function buildRfConnectorGroup(
  kind: RfConnectorKind,
  fallback: () => THREE.Group,
): THREE.Group {
  const cached = geomCache.get(kind);
  if (cached) {
    const group = new THREE.Group();
    group.add(geometryToColoredMesh(cached));
    return group;
  }
  void loadConnector(kind);
  return fallback();
}
