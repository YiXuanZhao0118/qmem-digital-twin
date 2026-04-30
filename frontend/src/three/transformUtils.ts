import * as THREE from "three";

import type { Placement, Vec3 } from "../types/digitalTwin";

export const MM_PER_THREE_UNIT = 100;

export function mmToThree(valueMm: number): number {
  return valueMm / MM_PER_THREE_UNIT;
}

export function labToThreeVector(point: Vec3): THREE.Vector3 {
  const [xMm, yMm, zMm] = point;
  return new THREE.Vector3(mmToThree(xMm), mmToThree(zMm), mmToThree(-yMm));
}

export function applyPlacement(object: THREE.Object3D, placement: Placement): void {
  object.position.set(
    mmToThree(placement.xMm),
    mmToThree(placement.zMm),
    mmToThree(-placement.yMm),
  );

  object.rotation.set(
    THREE.MathUtils.degToRad(placement.rxDeg),
    THREE.MathUtils.degToRad(placement.rzDeg),
    THREE.MathUtils.degToRad(-placement.ryDeg),
    "YXZ",
  );
  object.visible = placement.visible;
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

