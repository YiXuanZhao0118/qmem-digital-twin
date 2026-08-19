/**
 * Frontend mirror of the backend's parameter merge order.
 *
 * `effective = asset.defaultParams ⊕ (dynamicSources ∩ tunableParams)`
 * — data-model.md, implemented server-side by `db_scene_loader` +
 * `anchor_tracer`. Anything the renderer or a per-instance editor shows must
 * come from here rather than from `Component.properties`: the Component is the
 * catalog template and is SHARED by every instance, so writing per-instance
 * values there mutates every other copy (the same layer confusion the fiber
 * `fiberNodes` fix called out).
 *
 * The tunable contract is enforced exactly as the backend enforces it: a
 * dynamicSources key that IS a defaultParams key but is NOT marked tunable is
 * dropped (so a non-tunable param always tracks the asset), while keys that
 * are not asset params at all pass through untouched (runtime couplings like
 * aomFreqMhz).
 */
import type { Asset3D, SceneObject } from "../types/digitalTwin";

/** Component kinds whose whole appearance is asset params + per-instance
 *  overrides, with no geometry file behind them. Kept here so the renderer
 *  gate and the Object panel agree on one list. */
export const ANNOTATION_KIND_IDS: ReadonlySet<string> = new Set([
  "rect_annotation",
  "text_annotation",
]);

export function effectiveInstanceParams(
  asset: Asset3D | null | undefined,
  sceneObject: SceneObject | null | undefined,
): Record<string, unknown> {
  const defaults = (asset?.defaultParams ?? {}) as Record<string, unknown>;
  const dynamic = (sceneObject?.dynamicSources ?? {}) as Record<string, unknown>;
  const tunable = new Set(asset?.tunableParams ?? []);
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(dynamic)) {
    if (key in defaults && !tunable.has(key)) continue;
    merged[key] = value;
  }
  return merged;
}

/** Stable digest of the per-instance overrides, for render caches that key on
 *  "did anything about this instance's appearance change?". Sorted so key
 *  insertion order can't cause a spurious rebuild. */
export function instanceParamsKey(sceneObject: SceneObject | null | undefined): string {
  const dynamic = sceneObject?.dynamicSources;
  if (!dynamic || typeof dynamic !== "object") return "";
  return Object.entries(dynamic as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(",");
}
