// V2 anchor-binding accessors (frontend mirror of backend/app/v2_bindings.py).
//
// Per docs/optical-schema-v2.md §3, per-instance geometry-only data lives on
// objects.properties.anchorBindings[]. This file provides typed lookups so
// every consumer reads the same precedence chain instead of poking the JSON
// directly.

import type {
  AnchorBindingV2,
  Asset3D,
  SceneObject,
} from "../types/digitalTwin";
import { uuid7 } from "./uuid7";

export const OPTICAL_ANCHOR_ID = "optical_anchor";
export const OPTICAL_SURFACE_BINDING_KIND = "opticalSurface";

/** Pick the asset anchor an opticalSurface binding should reference.
 *  Mirrors the precedence used by alembic 0028 backfill so newly-created
 *  bindings target the same anchor that the migration would have picked. */
export function pickOpticalSurfaceAnchorId(
  assetAnchors: Asset3D["anchors"] | undefined,
): string | null {
  if (!assetAnchors || assetAnchors.length === 0) return null;
  const byId = new Map(assetAnchors.map((a) => [a.id, a]));
  if (byId.has(OPTICAL_ANCHOR_ID)) return OPTICAL_ANCHOR_ID;

  for (const hint of ["intercept_face", "intercept_in", "intercept_out", "optical"]) {
    for (const a of assetAnchors) {
      if (a.id === hint) return hint;
      const name = (a.name ?? "").toLowerCase();
      if (name.includes(hint)) return a.id;
    }
  }
  for (const a of assetAnchors) {
    if (a.id) return a.id;
  }
  return null;
}

/** Build a fresh V2 opticalSurface binding entry with a UUIDv7 id. */
export function makeOpticalSurfaceBinding(
  anchorId: string,
  normalBodyLocal: [number, number, number],
  name = "Reflective surface",
): AnchorBindingV2 {
  return {
    id: uuid7(),
    name,
    anchorId,
    kind: OPTICAL_SURFACE_BINDING_KIND,
    frame: "anchorLocalXY",
    payload: { normalBodyLocal: [...normalBodyLocal] },
  };
}

/** First binding on the SceneObject matching `kind`, or null. */
export function findBinding(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  kind: string,
): AnchorBindingV2 | null {
  if (!sceneObject) return null;
  const bindings = sceneObject.properties?.anchorBindings;
  if (!bindings) return null;
  return bindings.find((b) => b.kind === kind) ?? null;
}

/** V2 read of a mirror's reflective-surface normal in body-local frame.
 *  Returns null when no opticalSurface binding exists on the SceneObject —
 *  callers should fall back to the asset anchor's directionBodyLocal, then
 *  to the kind default. */
export function getMirrorNormalBodyLocal(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
): [number, number, number] | null {
  const binding = findBinding(sceneObject, OPTICAL_SURFACE_BINDING_KIND);
  if (!binding) return null;
  const raw = (binding.payload as { normalBodyLocal?: unknown }).normalBodyLocal;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const [x, y, z] = raw;
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
  return [x, y, z];
}

// =============================================================================
// V2 aperture: per-object override
// =============================================================================
//
// Aperture has been moved out of `Asset3D.anchors[].apertureMm` (Layer 2 /
// PHY Editor) and into per-instance bindings. Stored shape (V2):
//
//   objects.properties.anchorBindings[].payload.aperture =
//     { shape: "circle", rMm }              // radius
//   | { shape: "rectangle", xMm, yMm }      // half-widths
//   | { shape: "ellipse", xMm, yMm }        // semi-axes
//
// For kinds whose existing binding only carried geometry (mirror,
// beam_splitter), aperture rides along inside the SAME binding payload.
// For kinds whose anchors have no V2 binding yet (AOM intercept_in /
// intercept_out, lens intercept_in, fiber connector faces, etc.), the
// per-object override lives in a flat per-anchor map at
//   objects.properties.perAnchorApertures[anchorId] = <V2 aperture shape>
// Future cleanup will promote those into per-anchor bindings; the helper
// here abstracts both lookup paths so consumers can stay agnostic.

export type V2Aperture =
  | { shape: "circle"; rMm: number }
  | { shape: "rectangle"; xMm: number; yMm: number }
  | { shape: "ellipse"; xMm: number; yMm: number };

/** Convert a V2 aperture shape to a scalar "effective radius mm" — the
 *  largest in-plane half-extent. Used by consumers (beam intercept tests,
 *  apertureCheck) that today expect a single mm number. */
export function v2ApertureToScalarMm(a: V2Aperture | null | undefined): number | null {
  if (!a) return null;
  if (a.shape === "circle") return a.rMm;
  return Math.max(a.xMm, a.yMm);
}

function _readBindingPayloadAperture(payload: Record<string, unknown> | undefined): V2Aperture | null {
  const raw = payload?.aperture;
  if (!raw || typeof raw !== "object") return null;
  const shape = (raw as { shape?: unknown }).shape;
  if (shape === "circle") {
    const r = (raw as { rMm?: unknown }).rMm;
    if (typeof r === "number" && r > 0) return { shape: "circle", rMm: r };
  } else if (shape === "rectangle" || shape === "ellipse") {
    const x = (raw as { xMm?: unknown }).xMm;
    const y = (raw as { yMm?: unknown }).yMm;
    if (typeof x === "number" && typeof y === "number" && x > 0 && y > 0) {
      return { shape, xMm: x, yMm: y };
    }
  }
  return null;
}

/** Look up the per-instance aperture override for one (object, anchorId).
 *  Order:
 *    1. anchorBindings[anchorId].payload.aperture (V2 binding-resident)
 *    2. perAnchorApertures[anchorId]              (V2 transitional map)
 *  Returns null if no override is present.
 */
export function getPerObjectAperture(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  anchorId: string,
): V2Aperture | null {
  if (!sceneObject) return null;
  const props = sceneObject.properties as
    | { anchorBindings?: AnchorBindingV2[]; perAnchorApertures?: Record<string, unknown> }
    | undefined;
  const bindings = props?.anchorBindings ?? [];
  for (const b of bindings) {
    if (b.anchorId === anchorId) {
      const ap = _readBindingPayloadAperture(b.payload);
      if (ap) return ap;
    }
  }
  const map = props?.perAnchorApertures;
  if (map && typeof map === "object") {
    const raw = (map as Record<string, unknown>)[anchorId];
    if (raw && typeof raw === "object") {
      return _readBindingPayloadAperture({ aperture: raw });
    }
  }
  return null;
}

/** Effective scalar aperture (mm) for one (object, anchor) pair.
 *  Precedence:
 *    1. per-object V2 override (binding payload or perAnchorApertures map)
 *    2. asset anchor's legacy apertureMm (Layer 2 default seed)
 *    3. null  →  caller picks a kind default
 */
export function getEffectiveApertureMm(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  assetAnchor: { apertureMm?: number } | null | undefined,
  anchorId: string,
): number | null {
  const override = getPerObjectAperture(sceneObject, anchorId);
  const fromOverride = v2ApertureToScalarMm(override);
  if (fromOverride != null && fromOverride > 0) return fromOverride;
  const fromAsset = assetAnchor?.apertureMm;
  if (typeof fromAsset === "number" && fromAsset > 0) return fromAsset;
  return null;
}

/** Build a frontend writer that mutates a SceneObject's per-object
 *  aperture override. Stored under perAnchorApertures so any anchor id
 *  works (including AOM intercept_in/out, lens intercept_in, etc.) without
 *  needing a binding kind to exist for it. Returns the new properties
 *  dict; caller persists via PUT /api/objects/{id}.
 */
export function setPerObjectAperture(
  properties: SceneObject["properties"] | undefined,
  anchorId: string,
  aperture: V2Aperture | null,
): SceneObject["properties"] {
  const out = { ...(properties ?? {}) } as SceneObject["properties"] & {
    perAnchorApertures?: Record<string, V2Aperture>;
  };
  const map: Record<string, V2Aperture> = { ...(out.perAnchorApertures ?? {}) };
  if (aperture == null) {
    delete map[anchorId];
  } else {
    map[anchorId] = aperture;
  }
  if (Object.keys(map).length === 0) {
    delete out.perAnchorApertures;
  } else {
    out.perAnchorApertures = map;
  }
  return out;
}
