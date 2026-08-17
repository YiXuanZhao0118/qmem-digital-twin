/**
 * docs/objectives.md §R-5 — the screen-space-error LOD rule.
 *
 * The point of these tests is the scale-freedom claim: the same rule, with no
 * size term and no special case, must handle a 12.7 mm optic and a 2 m optical
 * table. The calibration case in the spec (the 1353-part board's LOD2 at
 * ε ≈ 1.8 mm reading ~1 px at 2 m) is asserted directly.
 */

import { describe, expect, it } from "vitest";

import type { AssetLod } from "../../../types/digitalTwin";
import {
  LOD_PIXEL_ERROR_BUDGET,
  chooseLodLevel,
  pixelErrorFor,
} from "../lodPolicy";

const H = 1080;
const FOV = (50 * Math.PI) / 180;

function tier(level: number, errorMm: number): AssetLod {
  return {
    level,
    filePath: `x.lod${level}.glb`,
    triCount: 1000,
    byteSize: 1000,
    errorMm,
  };
}

/** A plausible three-tier asset: LOD0 exact, LOD1 fine, LOD2 coarse. */
const TIERS = [tier(0, 0), tier(1, 0.4), tier(2, 1.8)];

describe("pixelErrorFor", () => {
  it("reproduces the spec's calibration case", () => {
    // objectives.md §R-5: ε = 1.8 mm reads ~1.0 px at 2 m and ~4.2 px at 0.5 m.
    expect(pixelErrorFor(1.8, 2000, H, FOV)).toBeCloseTo(1.04, 1);
    expect(pixelErrorFor(1.8, 500, H, FOV)).toBeCloseTo(4.17, 1);
  });

  it("is zero for a tier with no error and infinite at zero distance", () => {
    expect(pixelErrorFor(0, 1000, H, FOV)).toBe(0);
    expect(pixelErrorFor(1.8, 0, H, FOV)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("chooseLodLevel", () => {
  const choose = (distanceMm: number, currentLevel = 0) =>
    chooseLodLevel({ tiers: TIERS, distanceMm, viewportHeightPx: H, fovRadY: FOV, currentLevel });

  it("coarsens with distance and refines on approach", () => {
    expect(choose(200)).toBe(0); // close: even LOD1 is over budget
    expect(choose(1000)).toBe(1); // mid: LOD1 fits, LOD2 does not
    expect(choose(5000, 1)).toBe(2); // far: LOD2 fits
    expect(choose(200, 2)).toBe(0); // back up close again
  });

  it("never coarsens past a tier that is over budget", () => {
    for (const d of [100, 300, 700, 1500, 4000, 10000]) {
      const level = choose(d);
      const chosen = TIERS.find((t) => t.level === level)!;
      expect(pixelErrorFor(chosen.errorMm, d, H, FOV)).toBeLessThanOrEqual(
        LOD_PIXEL_ERROR_BUDGET,
      );
    }
  });

  // The whole reason the metric is error-based rather than size-based.
  it("is scale-free: a big and a small asset switch on their own error", () => {
    // A 2 m table (coarse tiers) and a 12.7 mm optic (fine tiers), same spot.
    const table = [tier(0, 0), tier(2, 1.8)];
    const optic = [tier(0, 0), tier(2, 0.02)];
    const at = (tiers: AssetLod[], distanceMm: number) =>
      chooseLodLevel({ tiers, distanceMm, viewportHeightPx: H, fovRadY: FOV, currentLevel: 0 });

    // At 1 m the small optic's coarse tier is invisible; the table's is not.
    expect(at(optic, 1000)).toBe(2);
    expect(at(table, 1000)).toBe(0);
  });

  // The degenerate case a centre-distance metric cannot express.
  it("forces LOD0 when the camera is inside the object's bounds", () => {
    // distanceMm 0 = camera within the AABB (Box3.distanceToPoint returns 0).
    expect(choose(0, 2)).toBe(0);
  });

  it("holds its level inside the hysteresis band", () => {
    // Find the distance where LOD2 sits exactly on the budget, then probe
    // just inside it from both directions.
    const exact = (1.8 * H) / (2 * LOD_PIXEL_ERROR_BUDGET * Math.tan(FOV / 2));
    expect(choose(exact * 1.02, 1)).toBe(1); // barely fits, but not by the margin
    expect(choose(exact * 0.98, 2)).toBe(2); // barely over, but not by the margin
    expect(choose(exact * 1.3, 1)).toBe(2); // clear of the margin → coarsen
    expect(choose(exact * 0.7, 2)).toBe(1); // clear of the margin → refine
  });

  it("falls back to level 0 when the asset has no tiers", () => {
    expect(
      chooseLodLevel({
        tiers: [], distanceMm: 5000, viewportHeightPx: H, fovRadY: FOV, currentLevel: 0,
      }),
    ).toBe(0);
  });
});
