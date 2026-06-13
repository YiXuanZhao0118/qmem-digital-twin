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
import { bakeConnectorByAnchors, type Vec3Mm } from "../connectorBake";
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
 *  run through `resolveAssetUrl`; `ext` is the lowercased file extension.
 *  connectOutMm / connectInMm are the asset's connect_out / connect_in anchor
 *  positions (mm, body frame) — when present the bake is driven by them
 *  instead of the bbox heuristic. */
export type RfConnectorAssetSpec = {
  url: string;
  ext: string;
  unit?: string;
  scaleFactor?: number;
  connectOutMm?: Vec3Mm | null;
  connectInMm?: Vec3Mm | null;
};

type Resolver = (kind: RfConnectorKind) => RfConnectorAssetSpec | null;

let resolver: Resolver | null = null;
const geomCache = new Map<RfConnectorKind, THREE.BufferGeometry>();
const loading = new Set<RfConnectorKind>();
const loadListeners = new Set<() => void>();

/** Subscribe to "a connector model finished loading into the cache". A static
 *  consumer (the PHY-editor COMPONENT preview) needs this to rebuild and swap
 *  the procedural fallback for the real baked mesh once the async load lands;
 *  the Lab re-renders often enough not to. Returns an unsubscribe fn. */
export function subscribeRfConnectorLoaded(cb: () => void): () => void {
  loadListeners.add(cb);
  return () => loadListeners.delete(cb);
}

/** App wiring point: the store-aware layer (DigitalTwinViewer) registers how
 *  each connector kind maps to a catalog asset. Re-registering clears the cache
 *  so a new mapping (e.g. swapped placeholder) re-loads. */
export function setRfConnectorAssetResolver(fn: Resolver | null): void {
  resolver = fn;
  geomCache.forEach((g) => g.dispose());
  geomCache.clear();
  loading.clear();
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
    // RF placement rotates the connector's local +X onto the outward tangent.
    const merged = mergeColoredGeometries(subs.map((s) => s.geometry));
    geomCache.set(
      kind,
      bakeConnectorByAnchors(merged, spec.connectOutMm, spec.connectInMm, new THREE.Vector3(1, 0, 0)),
    );
    loadListeners.forEach((cb) => cb());
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
