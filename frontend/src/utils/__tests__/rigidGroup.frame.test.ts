/**
 * Frame pin for `expandPoseToRigidGroup` under the single-root S·M·b render.
 *
 * A rigid group's defining property: when the leading object is moved, every
 * member's pose RELATIVE TO the leading — as actually rendered in the world —
 * is preserved. Under labRoot each object renders with world position
 * S·pos (labMmToThree) and world orientation S·M (M = sceneObjectToQuaternion),
 * so the relative world transform lead⁻¹·member must be identical before and
 * after the expansion.
 *
 * The pre-labRoot expander rotated member position offsets in `labMmToThree`
 * (S-swapped) scratch space, which bakes S⁻¹·ΔR·S onto the lab offset — rigid
 * only for the OLD M·S·b world (world orient = M·S). Under S·M·b that scatters
 * members along the wrong arc. This test fails for that conjugated math and
 * passes once the offset rotates by the plain lab-frame ΔR. It uses a pose
 * delta with ry≠0 AND rz≠0 so ΔR and S do NOT commute (the regime where the
 * two differ).
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { expandPoseToRigidGroup } from "../rigidGroup";
import {
  labMmToThree,
  labRootSwapQuaternion,
  sceneObjectToQuaternion,
} from "../../optical/frames";
import type { SceneData, SceneObject } from "../../types/digitalTwin";

type Pose = {
  id: string;
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};

function pose(
  id: string,
  xMm: number,
  yMm: number,
  zMm: number,
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
): Pose {
  return { id, xMm, yMm, zMm, rxDeg, ryDeg, rzDeg };
}

/** Minimal scene with one rigidTransform collection holding every object. */
function makeRigidScene(objects: Pose[]): SceneData {
  return {
    objects: objects as unknown as SceneObject[],
    collections: [{ id: "C", parentId: null, rigidTransform: true, name: "C" }],
    collectionMembers: objects.map((o) => ({ objectId: o.id, collectionId: "C" })),
    physicsElements: [],
  } as unknown as SceneData;
}

/** World matrix as rendered under labRoot: world pos = S·pos (labMmToThree),
 *  world orient = S·M. This is the frame the rigid group must be rigid in. */
function worldMatrix(o: Pose): THREE.Matrix4 {
  const pos = labMmToThree({ xMm: o.xMm, yMm: o.yMm, zMm: o.zMm });
  const quat = labRootSwapQuaternion().multiply(
    sceneObjectToQuaternion(o as unknown as SceneObject),
  );
  return new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
}

/** Member pose relative to the leading object, in the rendered world. */
function relWorld(lead: Pose, member: Pose): THREE.Matrix4 {
  return new THREE.Matrix4()
    .copy(worldMatrix(lead))
    .invert()
    .multiply(worldMatrix(member));
}

describe("expandPoseToRigidGroup — rigidity under the labRoot S·M·b render", () => {
  it("preserves each member's relative WORLD pose across a rotate+translate of the leading", () => {
    const lead = pose("L", 0, 0, 0, 0, 0, 0);
    const member = pose("P", 100, 40, -25, 12, 8, -33);
    const scene = makeRigidScene([lead, member]);

    // Non-commuting delta: ry≠0 AND rz≠0, plus a translation of the leading.
    const patch = { rxDeg: 15, ryDeg: 35, rzDeg: 80, xMm: 30, yMm: -20, zMm: 5 };
    const result = expandPoseToRigidGroup(scene, lead as unknown as SceneObject, patch);
    expect(result.kind).toBe("group");
    if (result.kind === "rejectedLockedMember") throw new Error("unexpected rejection");

    const memberEntry = result.entries.find((e) => e.id === "P");
    expect(memberEntry).toBeDefined();
    const memberNew = { ...member, ...memberEntry!.patch } as Pose;
    const leadNew = { ...lead, ...patch } as Pose;

    const relOld = relWorld(lead, member);
    const relNew = relWorld(leadNew, memberNew);
    for (let i = 0; i < 16; i++) {
      expect(relNew.elements[i]).toBeCloseTo(relOld.elements[i], 5);
    }
  });

  it("pure translation rides every member by the same lab delta and leaves rotation untouched", () => {
    const lead = pose("L", 0, 0, 0, 10, 20, 30);
    const member = pose("P", 100, 50, -25, 5, -5, 15);
    const scene = makeRigidScene([lead, member]);

    const patch = { xMm: 7, yMm: -3, zMm: 11 };
    const result = expandPoseToRigidGroup(scene, lead as unknown as SceneObject, patch);
    if (result.kind === "rejectedLockedMember") throw new Error("unexpected rejection");
    const memberEntry = result.entries.find((e) => e.id === "P")!;

    expect(memberEntry.patch.xMm).toBeCloseTo(107, 6);
    expect(memberEntry.patch.yMm).toBeCloseTo(47, 6);
    expect(memberEntry.patch.zMm).toBeCloseTo(-14, 6);
    expect(memberEntry.patch.rxDeg).toBeCloseTo(5, 6);
    expect(memberEntry.patch.ryDeg).toBeCloseTo(-5, 6);
    expect(memberEntry.patch.rzDeg).toBeCloseTo(15, 6);
  });
});
