/**
 * Pose quantization contract — see poseQuantize.ts.
 *
 * The regression this guards: a quaternion round-trip used to persist
 * `ryDeg = -8.995967132789893e-15` for a pose that is exactly axis-aligned.
 */

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { sceneObjectEulerFromQuaternion } from "./frames";
import { quantizeDeg, quantizeMm, quantizePosePatch } from "./poseQuantize";

describe("quantizeDeg / quantizeMm", () => {
  it("snaps double dust to an exact, positive zero", () => {
    expect(quantizeDeg(-8.995967132789893e-15)).toBe(0);
    expect(quantizeMm(2.3e-13)).toBe(0);
    expect(Object.is(quantizeDeg(-1e-15), -0)).toBe(false);
  });

  it("snaps round-trip dust on a real value back to the authored number", () => {
    expect(quantizeDeg(45.000000000000007)).toBe(45);
    expect(quantizeMm(12.000000000000002)).toBe(12);
  });

  it("leaves values one decade below the O-1 / O-2 budget intact", () => {
    // O-2 = 0.1 µrad = 5.73e-6 deg, O-1 = 1 µm = 1e-3 mm.
    expect(quantizeDeg(5.7e-7)).toBe(5.7e-7);
    expect(quantizeMm(1e-4)).toBe(1e-4);
  });

  it("passes non-finite values through untouched", () => {
    expect(Number.isNaN(quantizeDeg(NaN))).toBe(true);
    expect(quantizeMm(Infinity)).toBe(Infinity);
  });
});

describe("quantizePosePatch", () => {
  it("snaps both the SceneObject and the ComponentBinding spellings", () => {
    const out = quantizePosePatch({
      ryDeg: -8.995967132789893e-15,
      xMm: 12.000000000000002,
      localRzDeg: 1e-14,
      localYMm: -3e-13,
    });
    expect(out).toEqual({ ryDeg: 0, xMm: 12, localRzDeg: 0, localYMm: 0 });
  });

  it("leaves non-pose keys alone and returns the same object when nothing moves", () => {
    const patch = { name: "laser", visible: true, xMm: 12 };
    expect(quantizePosePatch(patch)).toBe(patch);
  });
});

describe("sceneObjectEulerFromQuaternion", () => {
  it("returns an exact zero for an axis-aligned rotation (the e-15 regression)", () => {
    // 90° about lab +Z: rx and ry are mathematically zero, but the matrix
    // entries feeding atan2 are ~1e-16, which used to surface as e-15 deg.
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const euler = sceneObjectEulerFromQuaternion(q);
    expect(euler.rxDeg).toBe(0);
    expect(euler.ryDeg).toBe(0);
    expect(Math.abs(euler.rzDeg)).toBeCloseTo(90, 9);
  });
});
