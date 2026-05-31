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
  labMmToThreeLocal,
  labRootSwapInverseQuaternion,
  labToThreeVector,
  labToThreeVectorLocal,
  mmToThree,
  sceneObjectToQuaternion,
  threeToMm,
} from "../optical/frames";

export {
  MM_PER_THREE_UNIT,
  labMmToThree,
  labMmToThreeLocal,
  labToThreeVector,
  labToThreeVectorLocal,
  mmToThree,
  sceneObjectToQuaternion,
  threeToMm,
};

/**
 * Normalize a builder output that was authored in three's Y-up frame so it
 * can live under an object wrapper in the canonical Z-up lab world (labRoot).
 *
 * The single world swap lives on `labRoot` (S = Rx(-90°)); object wrappers
 * carry the plain pose quaternion M and sit in Z-up. Most asset builders,
 * however, emit geometry already in three's Y-up frame (g = S·b) — that is
 * why they render upright today. Wrapping such output in one S⁻¹ group makes
 * everything below it the canonical Z-up body frame (S⁻¹·g = b), without
 * having to understand or rewrite the builder's internal construction. A
 * builder that already authors Z-up (de-swapped PBS, the binding tree) must
 * NOT be passed through here.
 */
export function normalizeYupAssetToLabZup(content: THREE.Object3D): THREE.Object3D {
  const adapter = new THREE.Group();
  adapter.name = "yupImportAdapter";
  adapter.quaternion.copy(labRootSwapInverseQuaternion());
  adapter.add(content);
  return adapter;
}

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
  target.position.copy(labToThreeVectorLocal([offset.x, offset.y, offset.z]));
}

/**
 * Apply a SceneObject's pose (position + rotation + scale + visibility)
 * to a three.js Object3D that lives UNDER `labRoot`.
 *
 * Position uses `labMmToThreeLocal` (pure scale, NO axis swap) because
 * labRoot carries the single Z-up→three-Y-up swap S; labRoot.S applied to
 * `labMmToThreeLocal(pos)` reproduces the old `labMmToThree(pos)` world
 * position exactly. Rotation is the plain pose quaternion M from
 * `sceneObjectToQuaternion` (single source of truth) — with the swap moved
 * out to labRoot the world orientation composes as S·M·b, the pose-correct
 * order that co-moves with the backend beam for every pose (the old
 * leaf-swap baked M·S·b, wrong whenever ry≠0 or rz≠0).
 */
export function applyObjectTransform(target: THREE.Object3D, sceneObject: SceneObject): void {
  const positionThree = labMmToThreeLocal({
    xMm: sceneObject.xMm,
    yMm: sceneObject.yMm,
    zMm: sceneObject.zMm,
  });
  target.position.copy(positionThree);
  target.quaternion.copy(sceneObjectToQuaternion(sceneObject));
  target.scale.setScalar(getObjectScale(sceneObject));
  target.visible = sceneObject.visible;
}

/**
 * Place a wrapper in three's Y-up WORLD frame — for render surfaces added
 * straight to a Y-up scene with NO labRoot to supply the swap S.
 *
 * Position uses `labMmToThree` (the S axis-swap baked into the world
 * position) and the plain pose quaternion M, i.e. the exact behaviour
 * `applyObjectTransform` had before the labRoot unification moved S out to
 * the root. The only current caller is `OpticalLinkViewerPanel`, whose beam
 * tubes are placed at `labMmToThree(segment)` so their wireframe overlays
 * must live in the same world frame. Anything parented UNDER labRoot must use
 * `applyObjectTransform` (raw Z-up local) instead.
 */
export function applyObjectTransformWorld(target: THREE.Object3D, sceneObject: SceneObject): void {
  target.position.copy(labMmToThree({
    xMm: sceneObject.xMm,
    yMm: sceneObject.yMm,
    zMm: sceneObject.zMm,
  }));
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
