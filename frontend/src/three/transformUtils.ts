/**
 * Object transform helpers — applies SceneObject pose to three.js Object3D.
 *
 * As of the Phase 2 unification (2026-05-07), the pure frame/unit
 * conversion helpers live in `src/optical/frames.ts` and are re-exported
 * from here for backwards compatibility. New code should import directly
 * from `../optical/frames`. This file retains only the stateful helpers
 * that mutate Object3D instances (applyObjectTransform,
 * applyObjectGeometryOffset) plus the property accessors that are not
 * pure frame conversions.
 */

import * as THREE from "three";

import type { SceneObject } from "../types/digitalTwin";
import {
  MM_PER_THREE_UNIT,
  labMmToThree,
  labToThreeVector,
  mmToThree,
  sceneObjectToQuaternion,
  threeToMm,
} from "../optical/frames";

export {
  MM_PER_THREE_UNIT,
  labMmToThree,
  labToThreeVector,
  mmToThree,
  sceneObjectToQuaternion,
  threeToMm,
};

function vecProperty(value: unknown): { x: number; y: number; z: number } {
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return {
      x: typeof source.x === "number" && Number.isFinite(source.x) ? source.x : 0,
      y: typeof source.y === "number" && Number.isFinite(source.y) ? source.y : 0,
      z: typeof source.z === "number" && Number.isFinite(source.z) ? source.z : 0,
    };
  }
  return { x: 0, y: 0, z: 0 };
}

export function getObjectOriginOffsetMm(sceneObject: SceneObject): { x: number; y: number; z: number } {
  return vecProperty(sceneObject.properties?.originOffsetMm);
}

export function getObjectScale(sceneObject: SceneObject): number {
  const value = sceneObject.properties?.objectScale;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

export function applyObjectGeometryOffset(target: THREE.Object3D, sceneObject: SceneObject): void {
  const offset = getObjectOriginOffsetMm(sceneObject);
  target.position.copy(labToThreeVector([offset.x, offset.y, offset.z]));
}

/**
 * Apply a SceneObject's pose (position + rotation + scale + visibility)
 * to a three.js Object3D. Position uses `labMmToThree`; rotation goes
 * through `sceneObjectToQuaternion` so the orientation derived here is
 * byte-for-byte identical to anywhere else that asks for the same
 * SceneObject's quaternion (single source of truth, per Phase 1).
 */
export function applyObjectTransform(target: THREE.Object3D, sceneObject: SceneObject): void {
  const positionThree = labMmToThree({
    xMm: sceneObject.xMm,
    yMm: sceneObject.yMm,
    zMm: sceneObject.zMm,
  });
  target.position.copy(positionThree);
  target.quaternion.copy(sceneObjectToQuaternion(sceneObject));
  target.scale.setScalar(getObjectScale(sceneObject));
  target.visible = sceneObject.visible;
}

export function getNumericProperty(
  properties: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function getDimensionsMm(
  properties: Record<string, unknown>,
  fallback: [number, number, number],
): [number, number, number] {
  const value = properties.dimensionsMm;
  if (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "number")
  ) {
    return value as [number, number, number];
  }
  return fallback;
}
