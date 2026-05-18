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
// Aperture: asset-level fixed (per-instance override removed 2026-05-18)
// =============================================================================

/** Effective scalar aperture (mm) for one (object, anchor) pair.
 *  Aperture is now defined exclusively at the asset level (PHY Editor →
 *  Optical → Components); all SceneObjects sharing an asset share its
 *  anchor `apertureMm`. The `sceneObject` parameter is retained for
 *  callsite ergonomics but unused. Returns null when the asset anchor
 *  has no apertureMm — caller picks a kind default. */
export function getEffectiveApertureMm(
  _sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  assetAnchor: { apertureMm?: number } | null | undefined,
  _anchorId: string,
): number | null {
  const fromAsset = assetAnchor?.apertureMm;
  if (typeof fromAsset === "number" && fromAsset > 0) return fromAsset;
  return null;
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
