/**
 * Resolve a placed optical element's OPTICAL center + axis in world (three)
 * frame, for use as the geometric reference when computing (δ, α) for the
 * 5×5 augmented ABCD operators.
 *
 * Why this is NOT just `hit.object.getWorldPosition()` + `hit.face.normal`:
 *   - hit.object is the GLB wrapper, whose origin sits wherever the CAD
 *     pipeline parked it (often a face corner, not the lens center).
 *   - hit.face.normal is a SURFACE normal at the hit point; on a curved
 *     lens face it varies across the surface and is NOT the lens's
 *     overall optical-axis tilt.
 *
 * Convention used here (Phase D.3c MVP):
 *   - Optical center = SceneObject's lab position (xMm, yMm, zMm).
 *     Assumption: lens asset bodies have their optical centre at the
 *     body-local origin. Standard Thorlabs / Edmund / Newport catalog
 *     CADs follow this.
 *   - Optical axis = body-local (1, 0, 0) rotated by SceneObject Euler.
 *     Assumption: lens body-local +X is the optical axis. Aligned with
 *     the laser-source / TA "out" anchor convention used elsewhere.
 *
 * Both assumptions can be relaxed in a follow-up by reading the asset's
 * dedicated optical anchors (e.g. "intercept_in" with directionBodyLocal)
 * once each lens kind in the catalog has them populated.
 */

import * as THREE from "three";

import type { SceneObject } from "../types/digitalTwin";
import { bodyLocalDirToWorldThree, labMmToThree } from "../optical/frames";

const BODY_LOCAL_OPTICAL_AXIS = { x: 1, y: 0, z: 0 };

export type LensOpticalGeometry = {
  centerWorldThree: THREE.Vector3;
  opticalAxisWorldThree: THREE.Vector3;
};

export function lensOpticalGeometry(obj: SceneObject): LensOpticalGeometry {
  const centerWorldThree = labMmToThree({
    xMm: obj.xMm,
    yMm: obj.yMm,
    zMm: obj.zMm,
  });
  const opticalAxisWorldThree = bodyLocalDirToWorldThree(
    BODY_LOCAL_OPTICAL_AXIS,
    obj,
  ).normalize();
  return { centerWorldThree, opticalAxisWorldThree };
}
