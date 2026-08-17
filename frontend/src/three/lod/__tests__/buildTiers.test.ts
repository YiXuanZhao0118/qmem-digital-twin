// @vitest-environment happy-dom
/**
 * The shared tier builder — BUILD's save path and the catalog backfill both
 * go through it, so a regression here would silently make an asset's tiers
 * depend on which route produced them.
 *
 * happy-dom is required: GLTFExporter finishes a binary GLB through
 * `FileReader`, which the plain node runner does not have.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { LOD_TIER_TARGETS, buildLodTiers, lod0TriangleCount } from "../buildTiers";

describe("buildLodTiers", () => {
  it("emits one GLB per tier, progressively coarser, with a measured error", async () => {
    // Must exceed the FINEST budget (100k) or LOD1 comes back untouched.
    // PolyhedronGeometry's `detail` is edge subdivisions, so the count is
    // 20·(detail+1)² — detail 120 is ~293k triangles, not 4^detail.
    //
    // Deliberately well above 100k rather than just over it: a GENTLE
    // decimation of a regular sphere (131k→100k) reports `errorMm` of
    // exactly 0, because by the quadric metric the collapsed vertices still
    // lie on the same surface. That is a real property of the metric, not a
    // defect — but it makes a marginal mesh a bad subject for asserting that
    // the error is forwarded at all, which is what this test is for.
    const source = new THREE.IcosahedronGeometry(10, 120);
    expect(lod0TriangleCount(source)).toBeGreaterThan(
      Math.max(...LOD_TIER_TARGETS.map((t) => t.maxTriangles)),
    );

    const tiers = await buildLodTiers(source);

    expect(tiers.map((t) => t.level)).toEqual([1, 2]);
    for (const tier of tiers) {
      const budget = LOD_TIER_TARGETS.find((t) => t.level === tier.level)!.maxTriangles;
      expect(tier.triangles).toBeLessThanOrEqual(budget);
      expect(tier.errorMm).toBeGreaterThan(0);
      expect(tier.glb.byteLength).toBeGreaterThan(0);
    }
    // Coarser tier = fewer triangles and a larger deviation.
    expect(tiers[1].triangles).toBeLessThan(tiers[0].triangles);
    expect(tiers[1].errorMm).toBeGreaterThan(tiers[0].errorMm);
  }, 60000);

  it("reports zero error for a mesh already inside the budgets", async () => {
    // The backfill uses exactly this signal to skip an asset rather than
    // store three identical copies of it.
    const source = new THREE.IcosahedronGeometry(5, 2);
    const tiers = await buildLodTiers(source);
    for (const tier of tiers) {
      expect(tier.errorMm).toBe(0);
      expect(tier.triangles).toBe(lod0TriangleCount(source));
    }
  }, 60000);
});
