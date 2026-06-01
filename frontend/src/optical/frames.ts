/**
 * Single source of truth for frame and unit conversion across the QMEM
 * digital twin. Established as part of the Phase 1 unification effort
 * (see vibe-coding-log 2026-05-07).
 *
 * Frames in use:
 *   - Lab        : scene/world frame, Z-up, mm. SceneObject.{xMm,yMm,zMm}
 *                  are in this frame.
 *   - BodyLocal  : SceneObject's local frame, **Z-up**, mm. Body-local
 *                  matches lab's axis convention (purely a rotation +
 *                  translation, no axis re-mapping). Anchor positions and
 *                  kindParams direction vectors live here once Phase 5
 *                  migration is complete.
 *   - BeamLocal  : propagation frame with +z along beam direction. Used
 *                  by Jones matrices, fast/slow axis angles.
 *   - Three      : three.js render frame, Z-up, units = mm / 100. It uses
 *                  the same axis convention as Lab and BodyLocal.
 *
 * Lab <-> Three mapping:
 *   labToThree:  (xMm, yMm, zMm) -> (xMm/100, yMm/100, zMm/100)
 *   threeToLab:  (x, y, z)       -> (x*100, y*100, z*100)
 *
 * Rotation:
 *   The single allowed conversion from a SceneObject's (rxDeg, ryDeg,
 *   rzDeg) to a usable rotation is `sceneObjectToQuaternion`. All
 *   downstream code should derive from that quaternion — never compose
 *   Euler angles ad-hoc. Phase 3 will route every existing call site
 *   through this helper, so the runtime semantics today must match the
 *   pre-existing `applyObjectTransform`.
 *
 * Display-frame exception:
 *   The Object Panel's "Lab Sense rotation deg" row and the global-axis gizmo
 *   use a user-facing display frame. That display frame is a UI relabeling,
 *   not a physics convention. ComponentPanel.tsx maps display controls to
 *   stored Euler fields as:
 *     display RX =  stored rxDeg
 *     display RY = -stored ryDeg
 *     display RZ = -stored rzDeg
 *   Do not copy that mapping into solver, renderer, snapping, anchor access,
 *   or DB code; those paths must consume the stored SceneObject Euler fields
 *   through this module.
 *
 * NOTE: The legacy `transformUtils.ts` re-exports these helpers so old
 * imports keep working through Phase 2 migration. New code should import
 * from this module directly.
 */

import * as THREE from "three";

import type { SceneObject, Vec3 } from "../types/digitalTwin";

export type SceneObjectEulerDeg = {
  rxDeg: number;
  ryDeg: number;
  rzDeg: number;
};

// =============================================================================
// Scalar / unit conversions
// =============================================================================

/** One three.js unit equals this many millimetres. Pinned at 100 (i.e.
 *  1 three unit = 10 cm). Never reference the literal `100` elsewhere. */
export const MM_PER_THREE_UNIT = 100;

export function mmToThree(valueMm: number): number {
  return valueMm / MM_PER_THREE_UNIT;
}

export function threeToMm(valueThree: number): number {
  return valueThree * MM_PER_THREE_UNIT;
}

// =============================================================================
// Lab (Z-up, mm) <-> Three (Z-up, three units)
// =============================================================================

/** Convert a lab-frame mm position to a three.js Vector3. Three is Z-up, so
 *  this is pure unit scaling with no axis remap. */
export function labMmToThree(point: { xMm: number; yMm: number; zMm: number }): THREE.Vector3 {
  return new THREE.Vector3(
    mmToThree(point.xMm),
    mmToThree(point.yMm),
    mmToThree(point.zMm),
  );
}

/** Inverse of `labMmToThree`. Takes any object with x/y/z (THREE.Vector3
 *  or plain object) and returns lab mm. */
export function threeToLabMm(v: { x: number; y: number; z: number }): { xMm: number; yMm: number; zMm: number } {
  return {
    xMm: threeToMm(v.x),
    yMm: threeToMm(v.y),
    zMm: threeToMm(v.z),
  };
}

/** Tuple-form variant of `labMmToThree` — accepts the legacy `Vec3 =
 *  [xMm, yMm, zMm]` shape used by some store helpers. Prefer the object
 *  form for new code. */
export function labToThreeVector(point: Vec3): THREE.Vector3 {
  const [xMm, yMm, zMm] = point;
  return labMmToThree({ xMm, yMm, zMm });
}

/** Inverse of `labToThreeVector`. */
export function threeToLabVector(v: { x: number; y: number; z: number }): Vec3 {
  const r = threeToLabMm(v);
  return [r.xMm, r.yMm, r.zMm];
}

/** Convenience for the "LabPoint" shape (`{x, y, z}` plain mm-numbers,
 *  no `Mm` suffix) used by the placement gizmo, snap targets, cursor
 *  menu and other UI flows. Same numbers as `threeToLabMm` but with
 *  the unmarked field names — Phase 5 will rename consumers to use the
 *  `Mm`-suffixed shape and this can be deleted. */
export function threeToLabPointMm(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const r = threeToLabMm(v);
  return { x: r.xMm, y: r.yMm, z: r.zMm };
}

// =============================================================================
// Lab (Z-up, mm) -> labRoot-local three units
// =============================================================================
//
// `labRoot` is now just a grouping node. These helpers intentionally match
// `labMmToThree` so older call sites can keep their "under labRoot" naming.

/** Lab-frame mm -> labRoot-local three units. Pure scale, no axis swap. */
export function labMmToThreeLocal(point: { xMm: number; yMm: number; zMm: number }): THREE.Vector3 {
  return new THREE.Vector3(
    mmToThree(point.xMm),
    mmToThree(point.yMm),
    mmToThree(point.zMm),
  );
}

/** Tuple-form variant of `labMmToThreeLocal` (raw `[xMm, yMm, zMm]`). */
export function labToThreeVectorLocal(point: Vec3): THREE.Vector3 {
  const [xMm, yMm, zMm] = point;
  return labMmToThreeLocal({ xMm, yMm, zMm });
}

/** A lab-frame direction expressed in labRoot-local coordinates. Three is
 *  Z-up, so this returns a fresh Vector3 with the same components. */
export function labDirToThreeLocal(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(d.x, d.y, d.z);
}

// =============================================================================
// labRoot frame adapter
// =============================================================================
//
// Historical call sites still ask for a labRoot swap quaternion. With Three
// configured as Z-up, the adapter is identity.

/** Identity: Three is Z-up, so labRoot no longer carries a world swap. */
export function labRootSwapQuaternion(): THREE.Quaternion {
  return new THREE.Quaternion();
}

/** Identity inverse of `labRootSwapQuaternion`. */
export function labRootSwapInverseQuaternion(): THREE.Quaternion {
  return new THREE.Quaternion();
}

// =============================================================================
// Direction-vector frame swaps (no scaling — directions are dimensionless)
// =============================================================================

/** Convert a lab-frame direction vector to a three-frame direction.
 *  Three is Z-up, so components are unchanged.
 *
 *  Use this for normals, propagation directions, surface tangents — any
 *  unitless vector that describes an orientation.
 */
export function labDirToThree(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(d.x, d.y, d.z);
}

/** Inverse of `labDirToThree`. */
export function threeDirToLab(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: v.x, y: v.y, z: v.z };
}

// =============================================================================
// SceneObject orientation — quaternion is the single source of truth
// =============================================================================

/**
 * Convert a SceneObject's Euler triple (rxDeg, ryDeg, rzDeg) into a
 * quaternion. **This is the only allowed converter.** All math that
 * needs to apply a SceneObject's orientation must go through this
 * function — never call `setFromEuler` directly elsewhere.
 *
 * Convention: runtime code follows the documented XYZ 4x4 matrix,
 * transposed for column-vector math. There is no lab/three conjugation
 * because Three is Z-up.
 */
export function sceneObjectToQuaternion(sceneObject: SceneObject): THREE.Quaternion {
  const alpha = THREE.MathUtils.degToRad(sceneObject.rxDeg);
  const beta = THREE.MathUtils.degToRad(sceneObject.ryDeg);
  const gamma = THREE.MathUtils.degToRad(sceneObject.rzDeg);
  const ca = Math.cos(alpha);
  const sa = Math.sin(alpha);
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);
  const rLab = new THREE.Matrix4().set(
    cb * cg, sa * sb * cg + ca * sg, -ca * sb * cg + sa * sg, 0,
    -cb * sg, -sa * sb * sg + ca * cg, ca * sb * sg + sa * cg, 0,
    sb, -sa * cb, ca * cb, 0,
    0, 0, 0, 1,
  );
  const qLab = new THREE.Quaternion().setFromRotationMatrix(rLab);
  return qLab;
}

/** Decompose a quaternion back to the SceneObject rx/ry/rz convention.
 *
 * This is the inverse of `sceneObjectToQuaternion` for the documented matrix:
 *   R_col = transpose(Rx(rx) * Ry(ry) * Rz(rz))
 */
export function sceneObjectEulerFromQuaternion(q: THREE.Quaternion): SceneObjectEulerDeg {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q.clone().normalize());
  const te = m.elements;
  const r00 = te[0];
  const r10 = te[1];
  const r20 = te[2];
  const r01 = te[4];
  const r02 = te[8];
  const r21 = te[6];
  const r22 = te[10];

  const beta = Math.asin(THREE.MathUtils.clamp(r20, -1, 1));
  const cb = Math.cos(beta);
  let alpha: number;
  let gamma: number;

  if (Math.abs(cb) > 1e-8) {
    alpha = Math.atan2(-r21, r22);
    gamma = Math.atan2(-r10, r00);
  } else {
    gamma = 0;
    alpha = r20 > 0
      ? Math.atan2(r01, -r02)
      : Math.atan2(-r01, r02);
  }

  return {
    rxDeg: THREE.MathUtils.radToDeg(alpha),
    ryDeg: THREE.MathUtils.radToDeg(beta),
    rzDeg: THREE.MathUtils.radToDeg(gamma),
  };
}

/** Apply a SceneObject's rotation to a vector expressed in three's
 *  Z-up frame. Internally just `v.applyQuaternion(sceneObjectToQuaternion(o))`,
 *  but going through this helper makes the call site greppable for
 *  Phase 3 audit. */
export function applySceneObjectRotationThree(
  vThree: THREE.Vector3,
  sceneObject: SceneObject,
): THREE.Vector3 {
  return vThree.applyQuaternion(sceneObjectToQuaternion(sceneObject));
}

/** Apply a SceneObject's rotation to a lab-frame direction vector and
 *  return a lab-frame direction vector. This is the typed replacement
 *  for old ad-hoc axis swap + Euler apply + inverse axis swap paths.
 *
 *  Note: this produces a lab-frame OUTPUT — it does NOT translate by
 *  the SceneObject's position. For positions, use `bodyLocalMmToLabMm`
 *  (added in Phase 2/3 once we audit each call site's intent).
 */
export function rotateLabDir(
  dLab: { x: number; y: number; z: number },
  sceneObject: SceneObject,
): { x: number; y: number; z: number } {
  const vThree = labDirToThree(dLab);
  applySceneObjectRotationThree(vThree, sceneObject);
  return threeDirToLab(vThree);
}

// =============================================================================
// BodyLocal (Z-up, mm) — convenience compounds
// =============================================================================
//
// Body-local frame is Z-up (per Q2 of the unification decision), so the
// BodyLocal to Three conversion is identical to the lab one. The
// helpers below exist so call sites self-document their intent: when a
// vector is body-local (an asset's anchor offset, an optical element's
// surface normal in body coords, etc.), use the bodyLocal* helpers
// instead of the labDir* helpers, even though they currently do the
// same identity mapping. This way Phase 5+ (kindParams renaming) can audit by
// grepping for `bodyLocal*` callers without touching lab-direction
// callers.

/** Convert a body-local (Z-up) direction to a three.js-frame (Z-up)
 *  direction. This is a component copy: no scaling, no rotation. Use this when
 *  you have a body-local unit normal / axis (e.g.
 *  kindParams.acousticAxisLocal) and want it as a three.js vector still
 *  in the body's local frame. */
export function bodyLocalDirToThree(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return labDirToThree(d);
}

/** Most direct conversion for ray-tracing math: take a body-local Z-up
 *  direction, return a world-frame three.js direction (Z-up), going
 *  through the SceneObject's quaternion in one step. Replaces the
 *  recurring pattern:
 *    new Vector3(d.x, d.y, d.z).applyQuaternion(sceneObjectToQuaternion(o))
 *  Caller may `.normalize()` if a unit-length result is required. */
export function bodyLocalDirToWorldThree(
  d: { x: number; y: number; z: number },
  sceneObject: SceneObject,
): THREE.Vector3 {
  const vThree = bodyLocalDirToThree(d);
  return applySceneObjectRotationThree(vThree, sceneObject);
}

/** Round-trip: body-local Z-up direction → lab Z-up direction. Useful
 *  when downstream code expects a lab-frame vector (e.g. for storing
 *  or comparing against another lab direction). For three.js math,
 *  prefer `bodyLocalDirToWorldThree` to avoid the second axis swap. */
export function bodyLocalDirToLabDir(
  d: { x: number; y: number; z: number },
  sceneObject: SceneObject,
): { x: number; y: number; z: number } {
  return threeDirToLab(bodyLocalDirToWorldThree(d, sceneObject));
}
