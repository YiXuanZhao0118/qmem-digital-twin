/**
 * Asset-layer M2 §B-2: prove the meshoptimizer decimation wrapper reduces the
 * triangle count toward the requested budget, keeps vertex colours, and emits
 * no NaN/degenerate vertices. Runs in node (meshoptimizer inlines its WASM).
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  decimateGeometry,
  decimateWeldedGraded,
  triangleCount,
  weldForSimplify,
} from "../decimate";

describe("decimate", () => {
  it("reduces triangle count toward the target with colours intact, no NaN", async () => {
    // A subdivided icosahedron (closed, lots of shared edges). IcosahedronGeometry
    // is already non-indexed — like what occtMeshToGeometry hands the builder.
    const source = new THREE.IcosahedronGeometry(10, 4);
    const vertexCount = source.getAttribute("position").count;
    source.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(new Array(vertexCount * 3).fill(0.5), 3),
    );

    const sourceTris = triangleCount(source);
    const target = Math.floor(sourceTris * 0.25);

    const out = await decimateGeometry(source, target);
    const outTris = triangleCount(out);

    expect(outTris).toBeLessThan(sourceTris);
    expect(outTris).toBeLessThanOrEqual(target * 1.5);
    expect(out.getAttribute("color")).toBeTruthy();

    const positions = out.getAttribute("position").array;
    let allFinite = true;
    for (let i = 0; i < positions.length; i++) {
      if (!Number.isFinite(positions[i])) {
        allFinite = false;
        break;
      }
    }
    expect(allFinite).toBe(true);
  }, 30000);

  it("returns the full mesh when the target is not below the source", async () => {
    const source = new THREE.IcosahedronGeometry(5, 2);
    const sourceTris = triangleCount(source);
    const out = await decimateGeometry(source, sourceTris * 4);
    expect(triangleCount(out)).toBe(sourceTris);
  }, 30000);

  // objectives.md §R-5: the LOD switch divides by each tier's error, so a
  // tier that reports 0 would always be judged pixel-perfect and win at every
  // distance. This guards the wrapper actually forwarding meshoptimizer's
  // error instead of discarding it (which it did before 2026-08-17).
  it("reports a positive, monotonically growing error per graded tier", async () => {
    // Radius 10 => the absolute error is in the same units as the geometry,
    // so a plausible mm-scale magnitude is also asserted.
    const source = new THREE.IcosahedronGeometry(10, 4);
    const welded = weldForSimplify(source);
    const sourceTris = triangleCount(source);

    const [coarse, coarser] = await decimateWeldedGraded(welded, [
      Math.floor(sourceTris * 0.25),
      Math.floor(sourceTris * 0.05),
    ]);

    expect(coarse.errorMm).toBeGreaterThan(0);
    expect(coarser.errorMm).toBeGreaterThan(coarse.errorMm);
    // Deviation from a radius-10 sphere cannot exceed the sphere itself.
    expect(coarser.errorMm).toBeLessThan(10);
    expect(coarse.triangles).toBeGreaterThan(coarser.triangles);
  }, 30000);

  it("reports zero error for a tier that did not decimate", async () => {
    const source = new THREE.IcosahedronGeometry(5, 2);
    const welded = weldForSimplify(source);
    const [tier] = await decimateWeldedGraded(welded, [triangleCount(source) * 4]);
    expect(tier.errorMm).toBe(0);
    expect(tier.triangles).toBe(triangleCount(source));
  }, 30000);
});
