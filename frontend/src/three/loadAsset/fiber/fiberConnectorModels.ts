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
import { mmToThree } from "../../transformUtils";

/** What the store-aware caller resolves a (fiberType, polish) pair to. */
export type FiberConnectorAssetSpec = {
  /** Stable cache key — the resolved asset's catalogId. */
  key: string;
  url: string;
  ext: string;
  unit?: string;
  scaleFactor?: number;
};

type Resolver = (fiberType: string, polish: string) => FiberConnectorAssetSpec | null;

let resolver: Resolver | null = null;
const geomCache = new Map<string, THREE.BufferGeometry>();
const loading = new Set<string>();

/** App wiring point (DigitalTwinViewer): map (fiberType, polish) → a catalog
 *  connector asset. Re-registering clears the cache so a new mapping reloads. */
export function setFiberConnectorAssetResolver(fn: Resolver | null): void {
  resolver = fn;
  geomCache.forEach((g) => g.dispose());
  geomCache.clear();
  loading.clear();
}

/** Bake a loaded connector model into the fibre connector frame: cable-side
 *  end at y=0, ferrule axis = +Y (the spline rotates +Y onto the outward
 *  tangent). The model's longest bbox axis becomes +Y, its near end drops to
 *  y=0, centred on X/Z. */
function bakeFiberConnectorFrame(geom: THREE.BufferGeometry): THREE.BufferGeometry {
  geom.scale(mmToThree(1), mmToThree(1), mmToThree(1)); // mm → scene units
  geom.computeBoundingBox();
  const size = new THREE.Vector3();
  geom.boundingBox!.getSize(size);
  if (size.x >= size.y && size.x >= size.z) geom.rotateZ(Math.PI / 2); // longest X → Y
  else if (size.z >= size.x && size.z >= size.y) geom.rotateX(-Math.PI / 2); // longest Z → Y
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  geom.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return geom;
}

async function loadFiberConnector(spec: FiberConnectorAssetSpec): Promise<void> {
  if (geomCache.has(spec.key) || loading.has(spec.key)) return;
  loading.add(spec.key);
  try {
    const subs = await loadAssetGeometry(spec.url, spec.ext, {
      unit: spec.unit,
      scaleFactor: spec.scaleFactor,
    });
    geomCache.set(
      spec.key,
      bakeFiberConnectorFrame(mergeColoredGeometries(subs.map((s) => s.geometry))),
    );
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
