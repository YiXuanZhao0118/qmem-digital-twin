import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { axisVisibilityForView } from "../gizmo";

const IDENTITY = new THREE.Quaternion();

/** Eye direction `deg` away from the given axis, tilted towards +Y (or +X for
 *  the Y axis itself), normalised as the gizmo supplies it. */
function eyeOffAxis(axis: "x" | "y" | "z", deg: number): THREE.Vector3 {
  const rad = (deg * Math.PI) / 180;
  const along = Math.cos(rad);
  const off = Math.sin(rad);
  if (axis === "x") return new THREE.Vector3(along, off, 0);
  if (axis === "y") return new THREE.Vector3(off, along, 0);
  return new THREE.Vector3(0, off, along);
}

describe("axisVisibilityForView", () => {
  it("keeps every axis for a three-quarter view", () => {
    const eye = new THREE.Vector3(1, 1, 1).normalize();
    expect(axisVisibilityForView(eye, IDENTITY)).toEqual({
      showX: true,
      showY: true,
      showZ: true,
    });
  });

  it("drops Z when looking straight down -Z, and keeps X/Y", () => {
    const eye = new THREE.Vector3(0, 0, 1);
    expect(axisVisibilityForView(eye, IDENTITY)).toEqual({
      showX: true,
      showY: true,
      showZ: false,
    });
  });

  it("drops Z for the tilted near-axial views stock three still allowed", () => {
    // Stock AXIS_HIDE_THRESHOLD = 0.99 only hides inside ~8 deg; these are the
    // views where the Z picker used to sit on the gizmo centre and steal the
    // XY handle's clicks.
    for (const deg of [0, 5, 10]) {
      expect(axisVisibilityForView(eyeOffAxis("z", deg), IDENTITY).showZ).toBe(false);
    }
  });

  it("still offers Z once the view is clearly off-axis", () => {
    for (const deg of [20, 45, 90]) {
      expect(axisVisibilityForView(eyeOffAxis("z", deg), IDENTITY).showZ).toBe(true);
    }
  });

  it("is symmetric — viewing from +Z hides Z exactly as -Z does", () => {
    const front = axisVisibilityForView(new THREE.Vector3(0, 0, 1), IDENTITY);
    const back = axisVisibilityForView(new THREE.Vector3(0, 0, -1), IDENTITY);
    expect(front).toEqual(back);
  });

  it("applies to each axis in turn", () => {
    expect(axisVisibilityForView(eyeOffAxis("x", 0), IDENTITY).showX).toBe(false);
    expect(axisVisibilityForView(eyeOffAxis("y", 0), IDENTITY).showY).toBe(false);
  });

  it("follows the gizmo frame in local space", () => {
    // Gizmo rotated 90 deg about Y: its local X now points along world -Z, so
    // an eye down world Z must hide X, not Z.
    const frame = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    const eye = new THREE.Vector3(0, 0, 1);
    expect(axisVisibilityForView(eye, frame)).toEqual({
      showX: false,
      showY: true,
      showZ: true,
    });
  });
});
