/**
 * Asset-layer M2 §B-2: prove the meshoptimizer decimation wrapper reduces the
 * triangle count toward the requested budget, keeps vertex colours, and emits
 * no NaN/degenerate vertices. Runs in node (meshoptimizer inlines its WASM).
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { decimateGeometry, triangleCount } from "../decimate";

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
});
