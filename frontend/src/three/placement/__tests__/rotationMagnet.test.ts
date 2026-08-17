import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { magnetizeRotationDelta } from "../gizmo";
import {
  sceneObjectEulerFromQuaternion,
  sceneObjectToQuaternion,
} from "../../../optical/frames";
import type { SceneObject } from "../../../types/digitalTwin";

const quatOf = (rxDeg: number, ryDeg: number, rzDeg: number): THREE.Quaternion =>
  sceneObjectToQuaternion({ rxDeg, ryDeg, rzDeg } as SceneObject);

/** Euler the gizmo would commit for a drag: raw delta, magnetized if the
 *  magnet fired. Mirrors `runEngineFromGizmoPose`'s rotate branch. */
function committedEuler(initial: THREE.Quaternion, rawDelta: THREE.Quaternion) {
  const delta = magnetizeRotationDelta(rawDelta, initial) ?? rawDelta;
  return sceneObjectEulerFromQuaternion(delta.clone().multiply(initial));
}

/** Delta that takes `initial` to the pose `target`. */
const deltaTo = (initial: THREE.Quaternion, target: THREE.Quaternion): THREE.Quaternion =>
  target.clone().multiply(initial.clone().invert());

describe("magnetizeRotationDelta", () => {
  it("snaps onto every multiple of 45° from inside the tolerance window", () => {
    const initial = quatOf(0, 0, 0);
    for (const multiple of [0, 45, 90, 135, 180, -45, -90, -135]) {
      for (const offset of [-4, -1, 1, 4]) {
        const committed = committedEuler(
          initial,
          deltaTo(initial, quatOf(0, 0, multiple + offset)),
        );
        // Compare mod 360 — at ±180 the Euler decomposition may pick either
        // sign for the same pose.
        const off = ((committed.rzDeg - multiple) % 360 + 540) % 360 - 180;
        expect(off).toBeCloseTo(0, 9);
      }
    }
  });

  it("leaves angles outside the tolerance window free", () => {
    const initial = quatOf(0, 0, 0);
    for (const angle of [10, 22.5, 30, 38, 52, 67.5]) {
      const committed = committedEuler(initial, deltaTo(initial, quatOf(0, 0, angle)));
      expect(committed.rzDeg).toBeCloseTo(angle, 6);
    }
  });

  it("returns null (no correction) when nothing is close enough", () => {
    const initial = quatOf(0, 0, 0);
    expect(magnetizeRotationDelta(deltaTo(initial, quatOf(0, 0, 30)), initial)).toBeNull();
  });

  it("does not disturb an axis the drag never touched", () => {
    // ry is hand-tuned to 43° — within 2° of a 45° multiple. Rotating only rz
    // must leave it exactly where it was.
    const initial = quatOf(0, 43, 0);
    const committed = committedEuler(initial, deltaTo(initial, quatOf(0, 43, 89)));
    expect(committed.rzDeg).toBeCloseTo(90, 9);
    expect(committed.ryDeg).toBeCloseTo(43, 9);
  });

  it("magnetizes rx and ry the same way as rz", () => {
    const initial = quatOf(0, 0, 0);
    expect(committedEuler(initial, deltaTo(initial, quatOf(43, 0, 0))).rxDeg).toBeCloseTo(45, 9);
    expect(committedEuler(initial, deltaTo(initial, quatOf(0, 47, 0))).ryDeg).toBeCloseTo(45, 9);
  });

  it("is a rigid delta — applying it to a follower keeps the relative pose", () => {
    const primaryInitial = quatOf(0, 0, 0);
    const followerInitial = quatOf(0, 0, 30);
    const rawDelta = deltaTo(primaryInitial, quatOf(0, 0, 44));
    const delta = magnetizeRotationDelta(rawDelta, primaryInitial);
    expect(delta).not.toBeNull();
    const follower = sceneObjectEulerFromQuaternion(
      delta!.clone().multiply(followerInitial),
    );
    // Primary landed on 45°, so the follower rides the same +45° delta.
    expect(follower.rzDeg).toBeCloseTo(75, 9);
  });
});
