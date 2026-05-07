/**
 * Regression tests for the frame/unit conversion helpers. The single most
 * important property pinned here: `rotateLocalToLab` (used by every align
 * and snap-to-beam path) must produce the same world-frame vector as the
 * renderer's `applyObjectTransform` does (via `sceneObjectToQuaternion`).
 *
 * Phase 3 of the schema unification fixed a silent bug where the two
 * paths used different Euler-composition orders (XYZ extrinsic vs YXZ
 * intrinsic-when-mapped-to-three), giving up to ~37 % positional error
 * for any SceneObject with two or more non-zero Euler components. This
 * test prevents future regressions of that fix.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import type { SceneObject } from "../types/digitalTwin";
import { rotateLocalToLab } from "../utils/beamPlacement";
import {
  bodyLocalDirToLabDir,
  bodyLocalDirToWorldThree,
  labDirToThree,
  labMmToThree,
  MM_PER_THREE_UNIT,
  sceneObjectToQuaternion,
  threeDirToLab,
  threeToLabMm,
  threeToLabPointMm,
  threeToMm,
  mmToThree,
} from "./frames";

const fakeSceneObject = (rxDeg: number, ryDeg: number, rzDeg: number): SceneObject =>
  ({ rxDeg, ryDeg, rzDeg } as SceneObject);

/** Apply the SceneObject's pose to a body-local point by going through
 *  the actual three.js scene graph — i.e. exactly what the renderer does
 *  in `applyObjectTransform` + child anchor. This is the source of truth
 *  any other rotation function must agree with. */
function rotateBodyLocalViaRenderer(
  vBodyLocal: { x: number; y: number; z: number },
  sceneObject: SceneObject,
): { x: number; y: number; z: number } {
  const wrapper = new THREE.Object3D();
  wrapper.quaternion.copy(sceneObjectToQuaternion(sceneObject));
  const child = new THREE.Object3D();
  // Body-local Z-up → three Y-up axis swap for the child position.
  child.position.set(vBodyLocal.x, vBodyLocal.z, -vBodyLocal.y);
  wrapper.add(child);
  wrapper.updateMatrixWorld(true);
  const cw = new THREE.Vector3();
  child.getWorldPosition(cw);
  // Three Y-up world → lab Z-up.
  return { x: cw.x, y: -cw.z, z: cw.y };
}

describe("scalar mm ↔ three conversion", () => {
  it("uses the documented MM_PER_THREE_UNIT scale", () => {
    expect(MM_PER_THREE_UNIT).toBe(100);
    expect(mmToThree(100)).toBe(1);
    expect(mmToThree(0)).toBe(0);
    expect(threeToMm(1)).toBe(100);
    expect(threeToMm(-2.5)).toBe(-250);
  });

  it("round-trips through mmToThree → threeToMm", () => {
    for (const v of [0, 1, -1, 12.345, -987.6, 0.001]) {
      expect(threeToMm(mmToThree(v))).toBeCloseTo(v, 9);
    }
  });
});

describe("lab ↔ three position conversion", () => {
  it("swaps axes consistent with the documented (x, z, -y) mapping", () => {
    const v = labMmToThree({ xMm: 100, yMm: 200, zMm: 300 });
    expect(v.x).toBeCloseTo(1, 9);  // xMm/100
    expect(v.y).toBeCloseTo(3, 9);  // zMm/100
    expect(v.z).toBeCloseTo(-2, 9); // -yMm/100
  });

  it("round-trips through labMmToThree → threeToLabMm", () => {
    const labs = [
      { xMm: 0, yMm: 0, zMm: 0 },
      { xMm: 1, yMm: 2, zMm: 3 },
      { xMm: -100, yMm: 200, zMm: -300 },
      { xMm: 12.345, yMm: -67.89, zMm: 0.001 },
    ];
    for (const lab of labs) {
      const back = threeToLabMm(labMmToThree(lab));
      expect(back.xMm).toBeCloseTo(lab.xMm, 6);
      expect(back.yMm).toBeCloseTo(lab.yMm, 6);
      expect(back.zMm).toBeCloseTo(lab.zMm, 6);
    }
  });

  it("threeToLabPointMm produces the same numbers as threeToLabMm with unmarked keys", () => {
    const v = new THREE.Vector3(1, 2, 3);
    const marked = threeToLabMm(v);
    const unmarked = threeToLabPointMm(v);
    expect(unmarked.x).toBeCloseTo(marked.xMm, 9);
    expect(unmarked.y).toBeCloseTo(marked.yMm, 9);
    expect(unmarked.z).toBeCloseTo(marked.zMm, 9);
  });
});

describe("direction vector axis swap (no scaling)", () => {
  it("preserves vector magnitude through labDirToThree", () => {
    const d = { x: 0.5, y: -0.7, z: 0.3 };
    const t = labDirToThree(d);
    const inMag = Math.hypot(d.x, d.y, d.z);
    const outMag = Math.hypot(t.x, t.y, t.z);
    expect(outMag).toBeCloseTo(inMag, 9);
  });

  it("round-trips through labDirToThree → threeDirToLab", () => {
    const dirs = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0.6, y: -0.5, z: 0.3 },
    ];
    for (const d of dirs) {
      const back = threeDirToLab(labDirToThree(d));
      expect(back.x).toBeCloseTo(d.x, 9);
      expect(back.y).toBeCloseTo(d.y, 9);
      expect(back.z).toBeCloseTo(d.z, 9);
    }
  });
});

describe("rotateLocalToLab matches the renderer (Phase 3 fix)", () => {
  // The full multi-Euler matrix: every rotation combo that was previously
  // mis-aligned by the old XYZ-extrinsic implementation must now agree
  // exactly with what the renderer puts on screen.
  const eulerCases: Array<{ rxDeg: number; ryDeg: number; rzDeg: number }> = [
    // Single non-zero (always agreed even before the fix — sanity).
    { rxDeg: 0, ryDeg: 0, rzDeg: 0 },
    { rxDeg: 30, ryDeg: 0, rzDeg: 0 },
    { rxDeg: 0, ryDeg: 45, rzDeg: 0 },
    { rxDeg: 0, ryDeg: 0, rzDeg: 90 },
    // Two non-zero (HWP-style — used to silently disagree on some combos).
    { rxDeg: 22.5, ryDeg: 0, rzDeg: 90 },     // exactly the HWP in the live scene
    { rxDeg: 30, ryDeg: 60, rzDeg: 0 },
    { rxDeg: 0, ryDeg: 45, rzDeg: 60 },
    // Three non-zero (most divergent under the old impl).
    { rxDeg: 30, ryDeg: 45, rzDeg: 60 },      // ~37 % positional error pre-fix
    { rxDeg: 15, ryDeg: -30, rzDeg: 80 },
    { rxDeg: -45, ryDeg: 90, rzDeg: 30 },
    { rxDeg: 60, ryDeg: 60, rzDeg: 60 },
  ];

  // A spread of body-local input vectors that are NOT axial — axial cases
  // can fool the test because they're invariant under specific rotations.
  const inputVectors = [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 2, z: 3 },
    { x: -10, y: 5, z: -7 },
  ];

  for (const eulers of eulerCases) {
    for (const v of inputVectors) {
      it(
        `agrees with renderer for v=${JSON.stringify(v)}, eulers=${JSON.stringify(eulers)}`,
        () => {
          const fromRotateLocalToLab = rotateLocalToLab(
            v,
            eulers.rxDeg,
            eulers.ryDeg,
            eulers.rzDeg,
          );
          const fromRenderer = rotateBodyLocalViaRenderer(
            v,
            fakeSceneObject(eulers.rxDeg, eulers.ryDeg, eulers.rzDeg),
          );
          // 1e-9 tolerance — the only error here is fp noise.
          expect(fromRotateLocalToLab.x).toBeCloseTo(fromRenderer.x, 9);
          expect(fromRotateLocalToLab.y).toBeCloseTo(fromRenderer.y, 9);
          expect(fromRotateLocalToLab.z).toBeCloseTo(fromRenderer.z, 9);
        },
      );
    }
  }
});

describe("bodyLocalDirToLabDir = renderer-derived rotation", () => {
  it("agrees with the renderer for the HWP's actual Eulers", () => {
    const eulers = { rxDeg: 22.5, ryDeg: 0, rzDeg: 90 };
    const v = { x: 1, y: 0, z: 0 };
    const a = bodyLocalDirToLabDir(v, fakeSceneObject(eulers.rxDeg, eulers.ryDeg, eulers.rzDeg));
    const b = rotateBodyLocalViaRenderer(v, fakeSceneObject(eulers.rxDeg, eulers.ryDeg, eulers.rzDeg));
    expect(a.x).toBeCloseTo(b.x, 9);
    expect(a.y).toBeCloseTo(b.y, 9);
    expect(a.z).toBeCloseTo(b.z, 9);
  });

  it("preserves direction magnitude", () => {
    const v = { x: 3, y: -4, z: 12 };  // |v| = 13
    const out = bodyLocalDirToLabDir(v, fakeSceneObject(30, 45, 60));
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(13, 9);
  });
});

describe("bodyLocalDirToWorldThree returns correct three-frame vector", () => {
  it("axis-swaps then rotates (composition order matters)", () => {
    // body-local +Z (Z-up) under identity rotation should map to
    // three's +Y (Y-up). The dir helper (no rotation) gives us this:
    const labZ = { x: 0, y: 0, z: 1 };
    const direct = labDirToThree(labZ);
    expect(direct.x).toBeCloseTo(0, 9);
    expect(direct.y).toBeCloseTo(1, 9);
    expect(direct.z).toBeCloseTo(0, 9);

    // With identity rotation, bodyLocalDirToWorldThree should match.
    const t = bodyLocalDirToWorldThree(labZ, fakeSceneObject(0, 0, 0));
    expect(t.x).toBeCloseTo(0, 9);
    expect(t.y).toBeCloseTo(1, 9);
    expect(t.z).toBeCloseTo(0, 9);
  });
});
