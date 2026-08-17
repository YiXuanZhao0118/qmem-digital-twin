/**
 * Architectural pin for the single-root frame contract.
 *
 * Three is configured Z-up in this app, so the lab frame and the three frame
 * coincide up to scale: `labRootSwapQuaternion()` is the identity, and an
 * object wrapper renders as plain M·b where M = `sceneObjectToQuaternion`.
 * There is no swap at the root and none at the leaves.
 *
 * This file previously pinned the older contract, where three was Y-up and
 * labRoot carried S = Rx(-90°); it proved correctness by showing the render
 * equalled S·M·b and was *distinguishable* from the buggy leaf-swap M·S·b.
 * Once S became the identity those distinguishability assertions could not
 * hold — S·M and M·S are the same quaternion — and the file went red.
 *
 * The rewrite keeps every bit of that discriminating power by naming the old
 * swap explicitly as LEGACY_S instead of reaching for `labRootSwapQuaternion`.
 * So these tests still fail loudly if a refactor reintroduces a swap at
 * either end, and they now also fail if the root swap stops being identity.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  labMmToThree,
  labRootSwapQuaternion,
  labRootSwapInverseQuaternion,
  labDirToThreeLocal,
  sceneObjectEulerFromQuaternion,
  sceneObjectToQuaternion,
} from "../../optical/frames";
import { applyObjectTransform, normalizeYupAssetToLabZup } from "../transformUtils";
import type { SceneObject } from "../../types/digitalTwin";


/** The retired Y-up world swap. Kept as a local constant purely so the tests
 *  below can assert the render is NOT this — it is no longer what
 *  `labRootSwapQuaternion()` returns. */
const LEGACY_S = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2,
);

// A pose with ry≠0 AND rz≠0 so M and LEGACY_S do NOT commute — the regime
// where a reintroduced swap is provably visible.
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


describe("labRoot frame contract (Z-up, no swap)", () => {
  it("labRoot carries no swap — the adapter is identity in both directions", () => {
    // The fact everything else here depends on. If a refactor puts a real
    // rotation back on labRoot, this fails first and names the cause.
    expect(labRootSwapQuaternion().angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
    expect(labRootSwapInverseQuaternion().angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
  });

  it("renders a Z-up object wrapper as M·b, with position a pure scale", () => {
    const labRoot = buildLabRoot();
    const wrapper = new THREE.Group();
    labRoot.add(wrapper);
    applyObjectTransform(wrapper, POSE);

    // A marker at the wrapper's Z-up body origin (local identity = b frame).
    const marker = new THREE.Object3D();
    wrapper.add(marker);
    labRoot.updateMatrixWorld(true);

    const worldQuat = marker.getWorldQuaternion(new THREE.Quaternion());
    const M = sceneObjectToQuaternion(POSE);

    expect(worldQuat.angleTo(M)).toBeCloseTo(0, 6);

    // Teeth: either flavour of reintroduced swap is a different orientation
    // for this non-commuting pose.
    expect(M.clone().multiply(LEGACY_S).angleTo(M)).toBeGreaterThan(0.1);
    expect(LEGACY_S.clone().multiply(M).angleTo(M)).toBeGreaterThan(0.1);

    const worldPos = marker.getWorldPosition(new THREE.Vector3());
    const expectedPos = labMmToThree({ xMm: POSE.xMm, yMm: POSE.yMm, zMm: POSE.zMm });
    expect(worldPos.x).toBeCloseTo(expectedPos.x, 6);
    expect(worldPos.y).toBeCloseTo(expectedPos.y, 6);
    expect(worldPos.z).toBeCloseTo(expectedPos.z, 6);
  });

  it("normalizeYupAssetToLabZup is an identity adapter under a Z-up three", () => {
    // Assets are authored Z-up now, so the importer adapter must not rotate
    // anything. Builders that genuinely emit Y-up geometry rotate at their own
    // call site instead (see the optical_table branches in Asset3DEditor /
    // ComponentsEditor, which apply rotation.x = +π/2 themselves).
    const labRoot = buildLabRoot();
    const wrapper = new THREE.Group();
    labRoot.add(wrapper);
    applyObjectTransform(wrapper, POSE);

    const content = new THREE.Group();
    const innerMarker = new THREE.Object3D();
    content.add(innerMarker);

    wrapper.add(normalizeYupAssetToLabZup(content));
    labRoot.updateMatrixWorld(true);

    const worldQuat = innerMarker.getWorldQuaternion(new THREE.Quaternion());
    expect(worldQuat.angleTo(sceneObjectToQuaternion(POSE))).toBeCloseTo(0, 6);
  });
});


/**
 * Architectural pin for the align write-back.
 *
 * The AOM / TA / Simple "align to beam" panels fit the rotation that takes a
 * body axis onto a lab beam direction, then store it as SceneObject Euler.
 * Under the Z-up render the stored quaternion M must be the plain fit R
 * (R·axisBody = beamUnit), fitted with `labDirToThreeLocal` (raw) for BOTH
 * vectors, and decomposed with `sceneObjectEulerFromQuaternion` — the
 * canonical inverse of `sceneObjectToQuaternion`.
 *
 * The old panels fitted in S-swapped three-space, baking M = S·R·S⁻¹; the
 * third test keeps that construction around (via LEGACY_S) and shows it still
 * fails the same parallel check, so this file has teeth rather than just
 * restating the implementation.
 *
 * This block also used to hand-roll the decomposition as
 * `Euler(…, "YXZ")` → (rx = e.x, rz = e.y, ry = -e.z). That mapping is the
 * Object Panel's user-facing DISPLAY frame, which `optical/frames.ts`
 * explicitly warns not to copy into non-UI code, and it does not round-trip:
 * it was off by ~2.6 rad, which is what failed here.
 */
describe("align write-back (M is the raw fit R)", () => {
  // Generic body axis + lab beam. Their cross product is far from X, so
  // LEGACY_S does not commute with the fit and S·R·S⁻¹ ≠ R by a wide margin.
  const axisBody = new THREE.Vector3(0.3, -0.5, 0.8).normalize();
  const beamUnit = new THREE.Vector3(0.6, 0.7, -0.2).normalize();

  const fittedR = new THREE.Quaternion().setFromUnitVectors(
    labDirToThreeLocal(axisBody).normalize(),
    labDirToThreeLocal(beamUnit).normalize(),
  );

  const pose = {
    id: "obj",
    xMm: 0,
    yMm: 0,
    zMm: 0,
    ...sceneObjectEulerFromQuaternion(fittedR),
    visible: true,
    properties: {},
  } as unknown as SceneObject;

  it("the Euler write-back is a clean round-trip back to R", () => {
    expect(sceneObjectToQuaternion(pose).angleTo(fittedR)).toBeCloseTo(0, 6);
  });

  it("the rendered body axis lands on the beam", () => {
    const rendered = axisBody
      .clone()
      .applyQuaternion(sceneObjectToQuaternion(pose))
      .normalize();
    expect(rendered.angleTo(beamUnit)).toBeCloseTo(0, 5);
  });

  it("the old S·R·S⁻¹ construction still fails the same check", () => {
    const conjugated = LEGACY_S.clone()
      .multiply(fittedR)
      .multiply(LEGACY_S.clone().invert());
    const rendered = axisBody.clone().applyQuaternion(conjugated).normalize();
    expect(rendered.angleTo(beamUnit)).toBeGreaterThan(0.1);
  });
});
