// @vitest-environment happy-dom
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { beforeEach, describe, expect, it } from "vitest";

import { spreadTranslateHandles } from "../gizmo";

type HandleSets = { gizmo: THREE.Object3D; picker: THREE.Object3D };

function handleSets(controls: TransformControls): HandleSets {
  const internals = (controls as unknown as {
    _gizmo: { gizmo: Record<string, THREE.Object3D>; picker: Record<string, THREE.Object3D> };
  })._gizmo;
  return { gizmo: internals.gizmo.translate, picker: internals.picker.translate };
}

/** Bounding box of every baked handle geometry sharing `name`. */
function boxOf(parent: THREE.Object3D, name: string): THREE.Box3 {
  const box = new THREE.Box3();
  const named = parent.children.filter((c) => c.name === name);
  expect(named.length).toBeGreaterThan(0);
  for (const child of named) {
    const geometry = (child as THREE.Mesh).geometry;
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox as THREE.Box3);
  }
  return box;
}

let controls: TransformControls;
let sets: HandleSets;

beforeEach(() => {
  controls = new TransformControls(new THREE.PerspectiveCamera(), document.createElement("div"));
  sets = handleSets(controls);
});

describe("spreadTranslateHandles", () => {
  it("finds the three-internal handle sets it patches", () => {
    // Guards the silent no-op path: a three upgrade that renames `_gizmo`
    // would leave stock spacing with no other symptom than the bug coming back.
    expect(sets.gizmo.children.length).toBeGreaterThan(0);
    expect(sets.picker.children.length).toBeGreaterThan(0);
  });

  it("starts with the plane picker overlapping the axis pick cone", () => {
    // Stock: XY picker spans 0.05..0.25, and the X cone's radius at y = 0.25
    // is 0.25/3 = 0.083 > 0.05 — the quad's inner corner is inside the cone.
    const xy = boxOf(sets.picker, "XY");
    expect(xy.min.x).toBeCloseTo(0.05, 5);
    expect(xy.max.x).toBeCloseTo(0.25, 5);
  });

  it("moves the plane handles clear of the axis handles", () => {
    spreadTranslateHandles(controls);
    const picker = boxOf(sets.picker, "XY");
    expect(picker.min.x).toBeCloseTo(0.2, 5);
    expect(picker.max.x).toBeCloseTo(0.4, 5);
    // The X cone radius at the quad's new inner edge is 0.2/3 * 0.5 = 0.033,
    // well short of 0.2 — no overlap left.
    const drawn = boxOf(sets.gizmo, "XY");
    expect(drawn.min.x).toBeCloseTo(0.225, 5);
    expect(drawn.max.x).toBeCloseTo(0.375, 5);
  });

  it("moves drawn and picker quads together so the pick region matches the art", () => {
    spreadTranslateHandles(controls);
    for (const name of ["XY", "YZ", "XZ"]) {
      const drawn = boxOf(sets.gizmo, name).getCenter(new THREE.Vector3());
      const picker = boxOf(sets.picker, name).getCenter(new THREE.Vector3());
      expect(drawn.distanceTo(picker)).toBeCloseTo(0, 5);
    }
  });

  it("thins the axis pickers without shortening them", () => {
    const before = boxOf(sets.picker, "X");
    spreadTranslateHandles(controls);
    const after = boxOf(sets.picker, "X");
    // Radius (y/z extent) halves...
    expect(after.max.y).toBeCloseTo(before.max.y * 0.5, 5);
    expect(after.max.z).toBeCloseTo(before.max.z * 0.5, 5);
    // ...reach along the axis is untouched.
    expect(after.max.x).toBeCloseTo(before.max.x, 5);
    expect(after.min.x).toBeCloseTo(before.min.x, 5);
  });

  it("leaves the drawn arrows alone", () => {
    const before = boxOf(sets.gizmo, "X").clone();
    spreadTranslateHandles(controls);
    expect(boxOf(sets.gizmo, "X").equals(before)).toBe(true);
  });

  it("leaves the centre XYZ handle alone", () => {
    const before = boxOf(sets.picker, "XYZ").clone();
    spreadTranslateHandles(controls);
    expect(boxOf(sets.picker, "XYZ").equals(before)).toBe(true);
  });
});
