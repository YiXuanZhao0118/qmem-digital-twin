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
import { buildBncFemaleConnectorGroup } from "./bnc_female_connector";
import { buildBncMaleConnectorGroup } from "./bnc_male_connector";
import { buildSmaFemaleConnectorGroup } from "./sma_female_connector";
import { buildSmaMaleConnectorGroup } from "./sma_male_connector";

/** Family + gender. Matches the `rf_connector_{family}_{gender}` Asset3D
 *  slugs (alembic 0115). The legacy family-only "sma" / "bnc" values that
 *  still live in `properties.endAConnector` map to the male plug (the only
 *  gender the procedural renderer drew before) via `normalizeRfConnectorKind`. */
export type RfConnectorKind = "sma_male" | "sma_female" | "bnc_male" | "bnc_female";

const PROCEDURAL: Record<RfConnectorKind, () => THREE.Group> = {
  sma_male: buildSmaMaleConnectorGroup,
  sma_female: buildSmaFemaleConnectorGroup,
  bnc_male: buildBncMaleConnectorGroup,
  bnc_female: buildBncFemaleConnectorGroup,
};

/** Procedural fallback geometry for a connector kind. */
export function proceduralRfConnector(kind: RfConnectorKind): THREE.Group {
  return PROCEDURAL[kind]();
}

/** Map a legacy family-only token ("sma" / "bnc") to a gendered kind,
 *  defaulting to the male plug (back-compat: that's all the cable renderer
 *  drew before gender existed in the data model). Gendered tokens pass
 *  through. Returns null for anything unrecognised. */
export function normalizeRfConnectorKind(token: string): RfConnectorKind | null {
  if (token === "sma" || token === "sma_male") return "sma_male";
  if (token === "sma_female") return "sma_female";
  if (token === "bnc" || token === "bnc_male") return "bnc_male";
  if (token === "bnc_female") return "bnc_female";
  return null;
}

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
  fallback: () => THREE.Group = () => proceduralRfConnector(kind),
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
