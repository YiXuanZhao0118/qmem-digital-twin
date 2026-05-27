import * as THREE from "three";

type AssetFrameLike = {
  bodyFrameRotation?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
};

export type FrameVec3 = { x: number; y: number; z: number };

function readVec3(value: unknown): THREE.Vector3 {
  if (!value || typeof value !== "object") return new THREE.Vector3();
  const source = value as Record<string, unknown>;
  return new THREE.Vector3(
    typeof source.x === "number" && Number.isFinite(source.x) ? source.x : 0,
    typeof source.y === "number" && Number.isFinite(source.y) ? source.y : 0,
    typeof source.z === "number" && Number.isFinite(source.z) ? source.z : 0,
  );
}

export function bodyFramePositionMm(asset: AssetFrameLike | undefined | null): THREE.Vector3 {
  return readVec3(asset?.properties?.bodyFramePositionMm);
}

export function bodyFrameQuaternion(asset: AssetFrameLike | undefined | null): THREE.Quaternion | null {
  const q = asset?.bodyFrameRotation;
  if (
    !q ||
    typeof q.x !== "number" ||
    typeof q.y !== "number" ||
    typeof q.z !== "number" ||
    typeof q.w !== "number"
  ) {
    return null;
  }
  return new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize();
}

export function bodyFramePointToObjectLocalMm(
  pointBodyMm: FrameVec3,
  asset: AssetFrameLike | undefined | null,
): THREE.Vector3 {
  const point = new THREE.Vector3(pointBodyMm.x, pointBodyMm.y, pointBodyMm.z);
  const q = bodyFrameQuaternion(asset);
  if (q) point.applyQuaternion(q);
  return point.add(bodyFramePositionMm(asset));
}

export function bodyFrameDirectionToObjectLocal(
  directionBody: FrameVec3,
  asset: AssetFrameLike | undefined | null,
): THREE.Vector3 {
  const direction = new THREE.Vector3(directionBody.x, directionBody.y, directionBody.z);
  const q = bodyFrameQuaternion(asset);
  if (q) direction.applyQuaternion(q);
  return direction;
}

export function bodyFrameMeshShiftMm(asset: AssetFrameLike | undefined | null): THREE.Vector3 {
  const shift = bodyFramePositionMm(asset);
  const q = bodyFrameQuaternion(asset);
  if (q) shift.applyQuaternion(q.clone().invert());
  return shift;
}
