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
 *   - Three      : three.js render frame, Y-up, units = mm / 100. Should
 *                  ONLY appear inside this module and the three/*
 *                  renderers. Outside code never touches Three frame
 *                  directly.
 *
 * Lab ↔ Three mapping:
 *   labToThree:  (xMm, yMm, zMm) → (xMm/100, zMm/100, -yMm/100)
 *   threeToLab:  (x, y, z)        → (x*100, -z*100, y*100)
 *
 * Rotation:
 *   The single allowed conversion from a SceneObject's (rxDeg, ryDeg,
 *   rzDeg) to a usable rotation is `sceneObjectToQuaternion`. All
 *   downstream code should derive from that quaternion — never compose
 *   Euler angles ad-hoc. Phase 3 will route every existing call site
 *   through this helper, so the runtime semantics today must match the
 *   pre-existing `applyObjectTransform`.
 *
 * NOTE: The legacy `transformUtils.ts` re-exports these helpers so old
 * imports keep working through Phase 2 migration. New code should import
 * from this module directly.
 */

import * as THREE from "three";

import type { SceneObject, Vec3 } from "../types/digitalTwin";

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
// Lab (Z-up, mm) ↔ Three (Y-up, three units)
// =============================================================================

/** Convert a lab-frame mm position to a three.js Vector3. The axis swap
 *  comes from the convention that lab is Z-up but three is Y-up:
 *  three.x = lab.x, three.y = lab.z, three.z = -lab.y. */
export function labMmToThree(point: { xMm: number; yMm: number; zMm: number }): THREE.Vector3 {
  return new THREE.Vector3(
    mmToThree(point.xMm),
    mmToThree(point.zMm),
    mmToThree(-point.yMm),
  );
}

/** Inverse of `labMmToThree`. Takes any object with x/y/z (THREE.Vector3
 *  or plain object) and returns lab mm. */
export function threeToLabMm(v: { x: number; y: number; z: number }): { xMm: number; yMm: number; zMm: number } {
  return {
    xMm: threeToMm(v.x),
    yMm: -threeToMm(v.z),
    zMm: threeToMm(v.y),
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
// Direction-vector frame swaps (no scaling — directions are dimensionless)
// =============================================================================

/** Convert a lab-frame direction vector (Z-up) to a three-frame direction
 *  (Y-up). Axis swap only — magnitude preserved.
 *
 *  Use this for normals, propagation directions, surface tangents — any
 *  unitless vector that describes an orientation.
 */
export function labDirToThree(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(d.x, d.z, -d.y);
}

/** Inverse of `labDirToThree`. */
export function threeDirToLab(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
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
 * Convention (Phase 1): preserves the existing `applyObjectTransform`
 * behaviour to avoid changing rendered output. The Euler order is
 * `THREE.Euler(rxDeg, rzDeg, -ryDeg, "YXZ")`, which is how the renderer
 * applies SceneObject rotations today. Phase 3 will reconcile this
 * with `rotateLocalToLab`'s `R = Rz·Ry·Rx` convention; until then this
 * function matches the rendered pose so nothing visually shifts.
 */
export function sceneObjectToQuaternion(sceneObject: SceneObject): THREE.Quaternion {
  const eulerThree = new THREE.Euler(
    THREE.MathUtils.degToRad(sceneObject.rxDeg),
    THREE.MathUtils.degToRad(sceneObject.rzDeg),
    THREE.MathUtils.degToRad(-sceneObject.ryDeg),
    "YXZ",
  );
  return new THREE.Quaternion().setFromEuler(eulerThree);
}

/** Apply a SceneObject's rotation to a vector expressed in three's
 *  Y-up frame. Internally just `v.applyQuaternion(sceneObjectToQuaternion(o))`,
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
 *  for ad-hoc `(x, z, -y)` swap + Euler apply + `(x, -z, y)` swap that
 *  appears in many places today.
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
// axis swap from BodyLocal to Three is identical to the lab one. The
// helpers below exist so call sites self-document their intent: when a
// vector is body-local (an asset's anchor offset, an optical element's
// surface normal in body coords, etc.), use the bodyLocal* helpers
// instead of the labDir* helpers, even though they currently do the
// same swap. This way Phase 5+ (kindParams renaming) can audit by
// grepping for `bodyLocal*` callers without touching lab-direction
// callers.

/** Convert a body-local (Z-up) direction to a three.js-frame (Y-up)
 *  direction — pure axis swap, no scaling, no rotation. Use this when
 *  you have a body-local unit normal / axis (e.g.
 *  kindParams.acousticAxisLocal) and want it as a three.js vector still
 *  in the body's local frame. */
export function bodyLocalDirToThree(d: { x: number; y: number; z: number }): THREE.Vector3 {
  return labDirToThree(d);
}

/** Most direct conversion for ray-tracing math: take a body-local Z-up
 *  direction, return a world-frame three.js direction (Y-up), going
 *  through the SceneObject's quaternion in one step. Replaces the
 *  recurring pattern:
 *    new Vector3(d.x, d.z, -d.y).applyEuler(euler).normalize()
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
