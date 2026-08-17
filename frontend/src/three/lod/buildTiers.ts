/**
 * Turn one LOD0 geometry into the decimated tiers, ready to upload.
 *
 * Shared by the two producers so they cannot drift: BUILD's save path
 * (`GeometryBuilder.emitLodTiers`) and the catalog backfill
 * (`scripts/backfill-lods.ts`). Divergence here would mean an asset's tiers
 * depended on which route created them, which is a correctness bug, not a
 * style one — the runtime switch trusts `errorMm` absolutely.
 *
 * Budgets come from docs/objectives.md §R-5; changing them means changing
 * that spec.
 */

import type * as THREE from "three";

import { exportGlb } from "../glbExport";
import { decimateWeldedGraded, triangleCount, weldForSimplify } from "../decimate";

/** Triangle budget per decimated tier (§R-4/R-5). LOD0 is whatever the asset
 *  already is — its budget is enforced at authoring time, not here. */
export const LOD_TIER_TARGETS: readonly { level: 1 | 2; maxTriangles: number }[] = [
  { level: 1, maxTriangles: 100_000 },
  { level: 2, maxTriangles: 20_000 },
];

export interface BuiltTier {
  level: 1 | 2;
  triangles: number;
  /** Measured max deviation from LOD0, in the geometry's own units (mm for
   *  everything BUILD produces). The runtime switch divides by this. */
  errorMm: number;
  glb: ArrayBuffer;
}

/** Decimate `lod0` to each tier budget and export each as a GLB.
 *
 * Every tier is simplified from the ORIGINAL geometry, never from the tier
 * above it — chaining compounds quadric error and would make `errorMm` a
 * lower bound rather than the true deviation from LOD0. */
export async function buildLodTiers(lod0: THREE.BufferGeometry): Promise<BuiltTier[]> {
  const welded = weldForSimplify(lod0);
  try {
    const decimated = await decimateWeldedGraded(
      welded,
      LOD_TIER_TARGETS.map((t) => t.maxTriangles),
    );
    const out: BuiltTier[] = [];
    for (let i = 0; i < decimated.length; i++) {
      const tier = decimated[i];
      out.push({
        level: LOD_TIER_TARGETS[i].level,
        triangles: tier.triangles,
        errorMm: tier.errorMm,
        glb: await exportGlb(tier.geometry),
      });
      tier.geometry.dispose();
    }
    return out;
  } finally {
    if (welded !== lod0) welded.dispose();
  }
}

/** LOD0's own triangle count, for the level-0 manifest row. */
export function lod0TriangleCount(lod0: THREE.BufferGeometry): number {
  return triangleCount(lod0);
}
