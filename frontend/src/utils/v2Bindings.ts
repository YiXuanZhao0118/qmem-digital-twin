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
// V2 aperture: per-object scalar override
// =============================================================================
//
// 2026-05-10 simplification (per user request): aperture is stored as a
// flat scalar field on `objects.properties` keyed by `<anchorId>_apertureMm`,
// e.g. `intercept_in_apertureMm`, `intercept_out_apertureMm`. Just a number
// in millimetres (interpreted as a circular aperture radius). The previous
// `perAnchorApertures` map of {shape, rMm/xMm/yMm} variants is read on a
// best-effort fallback so un-migrated rows keep working until the alembic
// migration drains them.
//
// Backward-compat sources, in precedence:
//   1. objects.properties[`${anchorId}_apertureMm`]                  (new flat)
//   2. objects.properties.anchorBindings[anchorId].payload.aperture  (legacy V2 binding)
//   3. objects.properties.perAnchorApertures[anchorId]               (legacy transitional map)
//   4. asset.anchors[anchorId].apertureMm                            (Layer 2 default seed)
//   5. null  →  caller picks a kind default

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

/** Build the flat per-anchor key — `<anchorId>_apertureMm`. Use this so
 *  callers don't hand-roll the join (which is easy to typo). */
export function flatApertureKey(anchorId: string): string {
  return `${anchorId}_apertureMm`;
}

/** Look up the per-instance aperture override for one (object, anchorId).
 *  Returns a V2Aperture for backward compatibility — flat scalar values
 *  are wrapped as { shape: "circle", rMm }. Reads through the precedence
 *  chain documented above; null when no override is present.
 */
export function getPerObjectAperture(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  anchorId: string,
): V2Aperture | null {
  if (!sceneObject) return null;
  const props = sceneObject.properties as
    | (Record<string, unknown> & {
        anchorBindings?: AnchorBindingV2[];
        perAnchorApertures?: Record<string, unknown>;
      })
    | undefined;
  if (!props) return null;
  // [1] new flat scalar
  const flatKey = flatApertureKey(anchorId);
  const flat = props[flatKey];
  if (typeof flat === "number" && flat > 0) {
    return { shape: "circle", rMm: flat };
  }
  // [2] legacy binding payload
  const bindings = props.anchorBindings ?? [];
  for (const b of bindings) {
    if (b.anchorId === anchorId) {
      const ap = _readBindingPayloadAperture(b.payload);
      if (ap) return ap;
    }
  }
  // [3] legacy transitional map
  const map = props.perAnchorApertures;
  if (map && typeof map === "object") {
    const raw = (map as Record<string, unknown>)[anchorId];
    if (raw && typeof raw === "object") {
      return _readBindingPayloadAperture({ aperture: raw });
    }
  }
  return null;
}

/** Effective scalar aperture (mm) for one (object, anchor) pair.
 *  Precedence: per-object override → asset anchor's apertureMm → null.
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

/** Mutate `properties` to set the flat scalar aperture field for a given
 *  anchor. Pass `null` to clear. Returns the updated properties dict;
 *  caller persists via PUT /api/objects/{id}. Aperture shape variants
 *  (rectangle/ellipse) are no longer supported through this writer —
 *  if the legacy V2Aperture shape is passed, it's collapsed to its
 *  largest half-extent and stored as a scalar.
 */
export function setPerObjectAperture(
  properties: SceneObject["properties"] | undefined,
  anchorId: string,
  aperture: V2Aperture | number | null,
): SceneObject["properties"] {
  const out = { ...(properties ?? {}) } as Record<string, unknown> & {
    perAnchorApertures?: Record<string, V2Aperture>;
  };
  const flatKey = flatApertureKey(anchorId);
  if (aperture == null) {
    delete out[flatKey];
  } else {
    const scalar = typeof aperture === "number"
      ? aperture
      : (v2ApertureToScalarMm(aperture) ?? 0);
    if (scalar > 0) out[flatKey] = scalar;
    else delete out[flatKey];
  }
  // Drain the legacy map for the same anchor on every write so re-saves
  // converge to the new shape (cheap garbage collection).
  const map = out.perAnchorApertures;
  if (map && typeof map === "object" && anchorId in map) {
    const next = { ...map };
    delete (next as Record<string, V2Aperture>)[anchorId];
    if (Object.keys(next).length === 0) delete out.perAnchorApertures;
    else out.perAnchorApertures = next;
  }
  return out as SceneObject["properties"];
}

// =============================================================================
// AOM rf_direction — Asset3D anchor (replaces kindParams.rfPropagationDirectionBodyLocal)
// =============================================================================

export const RF_DIRECTION_ANCHOR_ID = "rf_direction";

/** Read the AOM's RF / acoustic propagation direction in body-local frame.
 *  Source of truth (per 2026-05-10 refactor) is an Asset3D anchor with
 *  `id = "rf_direction"`. Falls back to legacy kindParams field names so
 *  un-migrated rows keep working until the alembic migration drains them.
 *
 *  Returns null only when neither asset nor kindParams provide a direction
 *  — the caller (alignToLaser, ray-tracer) then warns the user. */
export function getRfDirectionBodyLocal(
  asset: Asset3D | null | undefined,
  kindParams: Record<string, unknown> | null | undefined,
): { x: number; y: number; z: number } | null {
  // [1] new: asset anchor
  const anchor = asset?.anchors?.find((a) => a.id === RF_DIRECTION_ANCHOR_ID);
  const dir = anchor?.directionBodyLocal;
  if (dir && typeof dir.x === "number" && typeof dir.y === "number" && typeof dir.z === "number") {
    const m = Math.hypot(dir.x, dir.y, dir.z);
    if (m > 1e-9) return { x: dir.x / m, y: dir.y / m, z: dir.z / m };
  }
  // [2] legacy kindParams (Phase 5 + earlier names)
  const fallbackKeys = [
    "rfPropagationDirectionBodyLocal",
    "rfPropagationDirectionLocal",
    "acousticAxisBodyLocal",
    "acousticAxisLocal",
  ];
  for (const k of fallbackKeys) {
    const raw = kindParams?.[k];
    if (Array.isArray(raw) && raw.length >= 3) {
      const [x, y, z] = raw as number[];
      if (typeof x === "number" && typeof y === "number" && typeof z === "number") {
        const m = Math.hypot(x, y, z);
        if (m > 1e-9) return { x: x / m, y: y / m, z: z / m };
      }
    }
  }
  return null;
}
