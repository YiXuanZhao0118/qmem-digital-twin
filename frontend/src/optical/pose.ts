/**
 * V3Pose — lab↔body Vec3 transforms for the v3 ray tracer.
 *
 * Uses the **same Euler convention as `frames.ts`** — must stay in sync
 * (the convention is documented in `frames.sceneObjectToQuaternion`):
 *
 *   THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ")
 *
 * This module is plain Vec3-in / Vec3-out — no `THREE.Vector3` leaks to
 * callers. Internally uses THREE.Quaternion as a math primitive only;
 * downstream code (ray tracer, ops) treats poses opaquely.
 */

import * as THREE from "three";

import type { Vec3 } from "./beam-ray";

export type V3Pose = {
  xMm: number;
  yMm: number;
  zMm: number;
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};

// ---------------------------------------------------------------------------
// Quaternion build (mirrors frames.sceneObjectToQuaternion)
// ---------------------------------------------------------------------------

function quaternionOf(pose: V3Pose): THREE.Quaternion {
  const eulerThree = new THREE.Euler(
    (pose.rxDeg * Math.PI) / 180,
    (pose.rzDeg * Math.PI) / 180,
    (-pose.ryDeg * Math.PI) / 180,
    "YXZ",
  );
  return new THREE.Quaternion().setFromEuler(eulerThree);
}

// ---------------------------------------------------------------------------
// Point transforms (include translation)
// ---------------------------------------------------------------------------

/** Lab-frame point → body-local. p_body = q⁻¹ · (p_lab − origin_lab). */
export function pointLabToBody(pointLab: Vec3, pose: V3Pose): Vec3 {
  const qInv = quaternionOf(pose).clone().invert();
  const v = new THREE.Vector3(
    pointLab.x - pose.xMm,
    pointLab.y - pose.yMm,
    pointLab.z - pose.zMm,
  );
  v.applyQuaternion(qInv);
  return { x: v.x, y: v.y, z: v.z };
}

/** Body-local point → lab. p_lab = q · p_body + origin_lab. */
export function pointBodyToLab(pointBody: Vec3, pose: V3Pose): Vec3 {
  const q = quaternionOf(pose);
  const v = new THREE.Vector3(pointBody.x, pointBody.y, pointBody.z);
  v.applyQuaternion(q);
  return { x: v.x + pose.xMm, y: v.y + pose.yMm, z: v.z + pose.zMm };
}

// ---------------------------------------------------------------------------
// Direction transforms (rotation only, no translation)
// ---------------------------------------------------------------------------

/** Lab-frame direction → body-local. d_body = q⁻¹ · d_lab. */
export function dirLabToBody(dirLab: Vec3, pose: V3Pose): Vec3 {
  const qInv = quaternionOf(pose).clone().invert();
  const v = new THREE.Vector3(dirLab.x, dirLab.y, dirLab.z);
  v.applyQuaternion(qInv);
  return { x: v.x, y: v.y, z: v.z };
}

/** Body-local direction → lab. d_lab = q · d_body. */
export function dirBodyToLab(dirBody: Vec3, pose: V3Pose): Vec3 {
  const q = quaternionOf(pose);
  const v = new THREE.Vector3(dirBody.x, dirBody.y, dirBody.z);
  v.applyQuaternion(q);
  return { x: v.x, y: v.y, z: v.z };
}

// ---------------------------------------------------------------------------
// V3Transform — quaternion + translation. Closed under composition (unlike
// raw V3Pose Euler triples). Used by the scene tracer to precompute and
// reuse (sceneObject · binding) effective transforms.
// ---------------------------------------------------------------------------

export type V3Transform = {
  origin: Vec3;                   // lab-frame position
  quat: [number, number, number, number];   // [x, y, z, w]
};

const IDENTITY_TRANSFORM: V3Transform = {
  origin: { x: 0, y: 0, z: 0 },
  quat: [0, 0, 0, 1],
};

export function poseToTransform(pose: V3Pose): V3Transform {
  const q = quaternionOf(pose);
  return {
    origin: { x: pose.xMm, y: pose.yMm, z: pose.zMm },
    quat: [q.x, q.y, q.z, q.w],
  };
}

function transformToThree(t: V3Transform): THREE.Quaternion {
  return new THREE.Quaternion(t.quat[0], t.quat[1], t.quat[2], t.quat[3]);
}

export function identityTransform(): V3Transform {
  return { origin: { x: 0, y: 0, z: 0 }, quat: [0, 0, 0, 1] };
}

/** Compose two rigid transforms: `parent ∘ child`. The result T is the
 *  pose of the child frame expressed in the parent's parent (lab) frame.
 *
 *  For a point p_child in child-body coords:
 *      p_lab = parent.q · (child.q · p_child + child.origin) + parent.origin
 *            = (parent.q · child.q) · p_child
 *              + parent.q · child.origin + parent.origin
 *
 *  → composed.quat = parent.q · child.q   (parent applied AFTER child)
 *  → composed.origin = parent.q · child.origin + parent.origin
 */
export function composeTransforms(
  parent: V3Transform,
  child: V3Transform,
): V3Transform {
  const qParent = transformToThree(parent);
  const qChild = transformToThree(child);
  const qComposed = qParent.clone().multiply(qChild);

  // origin' = qParent · child.origin + parent.origin
  const childOriginRot = new THREE.Vector3(
    child.origin.x, child.origin.y, child.origin.z,
  ).applyQuaternion(qParent);

  return {
    origin: {
      x: childOriginRot.x + parent.origin.x,
      y: childOriginRot.y + parent.origin.y,
      z: childOriginRot.z + parent.origin.z,
    },
    quat: [qComposed.x, qComposed.y, qComposed.z, qComposed.w],
  };
}

// ---------------------------------------------------------------------------
// V3Transform-based point / direction transforms (used by scene tracer)
// ---------------------------------------------------------------------------

export function pointLabToBodyT(point: Vec3, t: V3Transform): Vec3 {
  const qInv = transformToThree(t).invert();
  const v = new THREE.Vector3(
    point.x - t.origin.x,
    point.y - t.origin.y,
    point.z - t.origin.z,
  );
  v.applyQuaternion(qInv);
  return { x: v.x, y: v.y, z: v.z };
}

export function pointBodyToLabT(point: Vec3, t: V3Transform): Vec3 {
  const q = transformToThree(t);
  const v = new THREE.Vector3(point.x, point.y, point.z);
  v.applyQuaternion(q);
  return { x: v.x + t.origin.x, y: v.y + t.origin.y, z: v.z + t.origin.z };
}

export function dirLabToBodyT(dir: Vec3, t: V3Transform): Vec3 {
  const qInv = transformToThree(t).invert();
  const v = new THREE.Vector3(dir.x, dir.y, dir.z);
  v.applyQuaternion(qInv);
  return { x: v.x, y: v.y, z: v.z };
}

export function dirBodyToLabT(dir: Vec3, t: V3Transform): Vec3 {
  const q = transformToThree(t);
  const v = new THREE.Vector3(dir.x, dir.y, dir.z);
  v.applyQuaternion(q);
  return { x: v.x, y: v.y, z: v.z };
}
