/**
 * Architectural pin for the single-root frame unification.
 *
 * The whole lab scene renders under one `labRoot` Group carrying the
 * Z-up→Y-up world swap S = Rx(-90°). Object wrappers sit in the canonical
 * Z-up lab frame: position = labMmToThreeLocal (pure scale, no swap),
 * quaternion = the plain pose M = sceneObjectToQuaternion. The render
 * therefore composes as world = S·M·b — the pose-correct order that
 * co-moves with the backend beam (labMmToThree = S·beam_lab) for EVERY
 * pose. The old per-leaf swap baked M·S·b, which only matches at ry=rz=0
 * and is why PBS252 / the isolator rendered 90° off their own beams.
 *
 * This test fails if a refactor reintroduces a leaf swap (→ M·S·b), drops
 * the root swap, or breaks the Y-up asset-import normalizer. It uses a
 * deliberately non-commuting pose (ry≠0 AND rz≠0) so S·M·b and the buggy
 * M·S·b are provably different.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  labDirToThreeLocal,
  labMmToThree,
  labRootSwapQuaternion,
  labRootSwapInverseQuaternion,
  sceneObjectToQuaternion,
} from "../../optical/frames";
import { applyObjectTransform, normalizeYupAssetToLabZup } from "../transformUtils";
import type { SceneObject } from "../../types/digitalTwin";


// A pose with ry≠0 AND rz≠0 so M and S do NOT commute — the regime where
// the old leaf swap was wrong.
const POSE = {
  id: "obj",
  xMm: 100,
  yMm: 200,
  zMm: 300,
  rxDeg: 20,
  ryDeg: 30,
  rzDeg: 90,
  visible: true,
  properties: {},
} as unknown as SceneObject;


function buildLabRoot(): THREE.Group {
  const labRoot = new THREE.Group();
  labRoot.name = "labRoot";
  labRoot.quaternion.copy(labRootSwapQuaternion());
  return labRoot;
}


describe("labRoot single-swap frame contract", () => {
  it("renders a Z-up object wrapper as S·M·b (pose-correct, beam-co-moving)", () => {
    const labRoot = buildLabRoot();
    const wrapper = new THREE.Group();
    labRoot.add(wrapper);
    applyObjectTransform(wrapper, POSE);

    // A marker at the wrapper's Z-up body origin (local identity = b frame).
    const marker = new THREE.Object3D();
    wrapper.add(marker);
    labRoot.updateMatrixWorld(true);

    const worldQuat = marker.getWorldQuaternion(new THREE.Quaternion());

    const S = labRootSwapQuaternion();
    const M = sceneObjectToQuaternion(POSE);
    const expected = S.clone().multiply(M); // S·M
    const buggy = M.clone().multiply(S); // M·S — the old leaf-swap order

    // Render must equal S·M and must be distinguishable from the old bug.
    expect(worldQuat.angleTo(expected)).toBeCloseTo(0, 6);
    expect(buggy.angleTo(expected)).toBeGreaterThan(0.1);

    // World position is preserved exactly vs the old labMmToThree leaf swap.
    const worldPos = marker.getWorldPosition(new THREE.Vector3());
    const expectedPos = labMmToThree({ xMm: POSE.xMm, yMm: POSE.yMm, zMm: POSE.zMm });
    expect(worldPos.x).toBeCloseTo(expectedPos.x, 6);
    expect(worldPos.y).toBeCloseTo(expectedPos.y, 6);
    expect(worldPos.z).toBeCloseTo(expectedPos.z, 6);
  });

  it("normalizes a Y-up-authored asset to the SAME world orientation as a Z-up one", () => {
    const labRoot = buildLabRoot();
    const wrapper = new THREE.Group();
    labRoot.add(wrapper);
    applyObjectTransform(wrapper, POSE);

    // Simulate a builder that authored its geometry in three's Y-up frame:
    // its output g = S·b. Represent g by a group pre-rotated by S; the inner
    // marker is therefore the body frame b.
    const yupOutput = new THREE.Group();
    yupOutput.quaternion.copy(labRootSwapQuaternion()); // g = S·b
    const innerMarker = new THREE.Object3D();
    yupOutput.add(innerMarker);

    wrapper.add(normalizeYupAssetToLabZup(yupOutput));
    labRoot.updateMatrixWorld(true);

    const worldQuat = innerMarker.getWorldQuaternion(new THREE.Quaternion());
    const expected = labRootSwapQuaternion().multiply(sceneObjectToQuaternion(POSE)); // S·M
    expect(worldQuat.angleTo(expected)).toBeCloseTo(0, 6);
  });

  it("premultiply-S⁻¹ (DigitalTwinViewer's loader airlock) yields S·M·b, not the S·M·S·b double-swap", () => {
    const labRoot = buildLabRoot();
    const wrapper = new THREE.Group();
    labRoot.add(wrapper);
    applyObjectTransform(wrapper, POSE);

    // Simulate a loader output authored in three's Y-up frame: its total
    // orientation contribution is g = S·b (generic STL, PBS rotateX, the
    // binding-gate swap, fiber/rf_cable spline coords). Represent g by a group
    // pre-rotated by S; the inner marker is therefore the body frame b.
    const yupAsset = new THREE.Group();
    yupAsset.quaternion.copy(labRootSwapQuaternion()); // g = S·b
    const marker = new THREE.Object3D();
    yupAsset.add(marker);

    // DigitalTwinViewer normalizes at the labRoot boundary by left-multiplying
    // the asset root quaternion by S⁻¹ (the single Y-up→Z-up airlock). After
    // this the inner marker reads as canonical Z-up body b under the wrapper.
    yupAsset.quaternion.premultiply(labRootSwapInverseQuaternion());
    wrapper.add(yupAsset);
    labRoot.updateMatrixWorld(true);

    const worldQuat = marker.getWorldQuaternion(new THREE.Quaternion());
    const S = labRootSwapQuaternion();
    const M = sceneObjectToQuaternion(POSE);
    const expected = S.clone().multiply(M); // S·M — pose-correct, beam-co-moving
    // The bug the airlock removes: if the loader output were left un-normalized
    // under labRoot the world orientation would be S·M·S (double swap), which a
    // non-commuting POSE makes provably distinct from S·M.
    const doubleSwap = S.clone().multiply(M).multiply(S);

    expect(worldQuat.angleTo(expected)).toBeCloseTo(0, 6);
    expect(doubleSwap.angleTo(expected)).toBeGreaterThan(0.1);
  });

  it("S and S⁻¹ are genuine inverses", () => {
    const composed = labRootSwapQuaternion().multiply(labRootSwapInverseQuaternion());
    expect(composed.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 6);
  });
});


/**
 * Architectural pin for the align write-back de-conjugation.
 *
 * The AOM / TA / Simple "align to beam" panels fit the rotation that takes a
 * body axis onto a lab beam direction, then decompose it to SceneObject Euler
 * and store it. Under the single-root S·M·b render, the stored quaternion M
 * must be the PLAIN Z-up fit R (R·axisBody = beamUnit) — fitted with
 * `labDirToThreeLocal` (raw, no swap) for BOTH the body axis and the lab beam.
 *
 * The old panels fitted in S-swapped three-space (labDirToThree on both
 * vectors), which bakes M = S·R·S⁻¹. That was correct only for the old M·S·b
 * leaf-swap render; under S·M·b it renders the body axis 90°-ish off its own
 * beam — the exact PBS/isolator symptom, now in the interactive-edit path.
 *
 * This test drives the real chain — raw fit → YXZ decompose → reconstruct via
 * sceneObjectToQuaternion → render S·M — and asserts the rendered body axis is
 * parallel to the rendered beam S·beam. It uses a generic (non-X-axis) fit so
 * S·R·S⁻¹ and R are provably different, and asserts the old conjugated
 * construction FAILS the same parallel check (the test has teeth).
 */
describe("align write-back de-conjugation contract (M = raw R, not S·R·S⁻¹)", () => {
  // Generic body axis + lab beam direction. Their cross product (the fit's
  // rotation axis) is far from X, so S=Rx(-90°) does NOT commute with the fit
  // and S·R·S⁻¹ ≠ R by a wide margin.
  const axisBody = new THREE.Vector3(0.3, -0.5, 0.8).normalize();
  const beamUnit = new THREE.Vector3(0.6, 0.7, -0.2).normalize();

  // The fit the panels now perform: raw Z-up setFromUnitVectors → R.
  const axisBodyLocal = labDirToThreeLocal(axisBody).normalize();
  const beamLocal = labDirToThreeLocal(beamUnit).normalize();
  const fittedR = new THREE.Quaternion().setFromUnitVectors(axisBodyLocal, beamLocal);

  // Panel write-back: decompose to SceneObject Euler exactly as the panels do.
  const e = new THREE.Euler().setFromQuaternion(fittedR, "YXZ");
  const pose = {
    id: "obj",
    xMm: 0,
    yMm: 0,
    zMm: 0,
    rxDeg: THREE.MathUtils.radToDeg(e.x),
    rzDeg: THREE.MathUtils.radToDeg(e.y),
    ryDeg: -THREE.MathUtils.radToDeg(e.z),
    visible: true,
    properties: {},
  } as unknown as SceneObject;

  it("raw fit decomposes+reconstructs back to R (the YXZ write-back is a clean round-trip)", () => {
    const M = sceneObjectToQuaternion(pose);
    expect(M.angleTo(fittedR)).toBeCloseTo(0, 6);
  });

  it("rendered body axis S·M·axisBody is parallel to the rendered beam S·beam", () => {
    const M = sceneObjectToQuaternion(pose);
    const S = labRootSwapQuaternion();

    const renderedAxis = axisBody.clone().applyQuaternion(M).applyQuaternion(S).normalize();
    const renderedBeam = beamUnit.clone().applyQuaternion(S).normalize();
    expect(renderedAxis.angleTo(renderedBeam)).toBeCloseTo(0, 5);
  });

  it("the OLD S·R·S⁻¹ construction is provably wrong under the S·M·b render", () => {
    const S = labRootSwapQuaternion();
    const Sinv = labRootSwapInverseQuaternion();
    const oldM = S.clone().multiply(fittedR).multiply(Sinv); // S·R·S⁻¹

    const renderedAxisOld = axisBody.clone().applyQuaternion(oldM).applyQuaternion(S).normalize();
    const renderedBeam = beamUnit.clone().applyQuaternion(S).normalize();
    // Same parallel check the correct M passes — the old conjugated M fails it.
    expect(renderedAxisOld.angleTo(renderedBeam)).toBeGreaterThan(0.1);
  });
});
