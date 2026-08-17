/**
 * LOD tier selection — the screen-space-error rule from docs/objectives.md §R-5.
 *
 * The question is never "how big is this object on screen" but "how many
 * pixels does this tier's geometric error project to". Size-based metrics are
 * not scale-free: a 2 m optical table and a 12.7 mm mirror covering the same
 * pixels need completely different triangle densities, and for any object big
 * enough to contain the camera a centre-distance term collapses to zero and
 * pins it at LOD0 forever. Error-based selection has no size term at all, so
 * large and small assets go through the same rule with no special case.
 *
 * Deliberately free of scene/THREE state so the rule is unit-testable on its
 * own; the caller supplies distance, viewport and fov.
 */

import type { AssetLod } from "../../types/digitalTwin";

/** Pixel budget for a tier's projected error (τ). At 1 px the coarsening is
 *  by definition not resolvable on the reference 1080p display. */
export const LOD_PIXEL_ERROR_BUDGET = 1.0;

/** Fractional margin a level change must clear before it is taken. Without
 *  it an object parked exactly on a threshold flips tier every frame. */
export const LOD_HYSTERESIS = 0.15;

/** World units are mm/100 throughout the viewer (see rendering.md), so a
 *  three.js distance times this is millimetres — the unit `errorMm` is in. */
export const MM_PER_WORLD_UNIT = 100;

/**
 * How many pixels `errorMm` of geometric deviation covers at `distanceMm`.
 *
 *   px = ε × H / (2 · d · tan(fov/2))
 *
 * Returns 0 for a tier with no error (level 0, or a tier that did not
 * actually decimate) and Infinity at zero distance — both flow naturally into
 * `chooseLodLevel`, which then keeps or forces LOD0 respectively.
 */
export function pixelErrorFor(
  errorMm: number,
  distanceMm: number,
  viewportHeightPx: number,
  fovRadY: number,
): number {
  if (!(errorMm > 0)) return 0;
  if (!(distanceMm > 0)) return Number.POSITIVE_INFINITY;
  return (errorMm * viewportHeightPx) / (2 * distanceMm * Math.tan(fovRadY / 2));
}

export interface LodChoiceInput {
  /** The asset's tiers, any order. Levels without an entry are unavailable. */
  tiers: readonly AssetLod[];
  /** Camera distance to the object's world AABB **surface**, in mm. Never
   *  centre distance — see the module header. */
  distanceMm: number;
  viewportHeightPx: number;
  fovRadY: number;
  /** The level currently attached, so hysteresis can resist a flip. */
  currentLevel: number;
  /** Pixel budget override, for tests and future per-asset policy. */
  budgetPx?: number;
}

/**
 * The coarsest tier whose projected error fits the budget, with hysteresis.
 *
 * A change is only taken when it clears the budget by the hysteresis margin:
 * coarsening needs the candidate comfortably under budget, refining needs the
 * current level comfortably over it. Level 0 always qualifies (zero error), so
 * there is always an answer, including when `tiers` is empty.
 */
export function chooseLodLevel({
  tiers,
  distanceMm,
  viewportHeightPx,
  fovRadY,
  currentLevel,
  budgetPx = LOD_PIXEL_ERROR_BUDGET,
}: LodChoiceInput): number {
  const byLevel = new Map<number, AssetLod>();
  for (const tier of tiers) byLevel.set(tier.level, tier);

  const pxAt = (level: number): number => {
    const tier = byLevel.get(level);
    if (!tier) return Number.POSITIVE_INFINITY; // unavailable → never chosen
    return pixelErrorFor(tier.errorMm, distanceMm, viewportHeightPx, fovRadY);
  };

  // Coarsest first: the highest level that fits wins.
  const levels = [...byLevel.keys()].sort((a, b) => b - a);
  let candidate = 0;
  for (const level of levels) {
    if (pxAt(level) <= budgetPx) {
      candidate = level;
      break;
    }
  }

  if (candidate === currentLevel) return currentLevel;
  if (candidate > currentLevel) {
    // Coarsening: require the candidate to be well inside the budget.
    return pxAt(candidate) <= budgetPx * (1 - LOD_HYSTERESIS) ? candidate : currentLevel;
  }
  // Refining: require what we are showing to be well outside it. When the
  // current level is not in the manifest at all its error is unknowable, so
  // refine immediately rather than sit on a tier we cannot judge.
  const currentPx = pxAt(currentLevel);
  return currentPx > budgetPx * (1 + LOD_HYSTERESIS) ? candidate : currentLevel;
}
