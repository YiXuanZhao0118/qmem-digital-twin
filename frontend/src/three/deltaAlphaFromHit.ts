/**
 * Compute (δ_x, δ_y, α_x, α_y) in BEAM-LOCAL frame for an optical element
 * encountered by a chief ray. Output is the misalignment quartet fed into
 * the 5×5 augmented ABCD operators in `optical/generalizedAbcd.ts`.
 *
 * Inputs come from the THREE.Raycaster hit + the element's lab pose:
 *   - hitPointWorld          (three frame, three units)
 *   - incomingDir            (three frame, unit)
 *   - elementCenterWorld     (three frame, three units)
 *   - elementNormalWorld     (three frame, unit)
 *
 * Beam-local basis convention (per typical optics-lab usage):
 *   e_z = incomingDir
 *   e_x = world_up × e_z        (horizontal cross-beam when beam is horizontal)
 *   e_y = e_z × e_x             (vertical / "up" component when beam is horizontal)
 *   world_up = three's (0, 1, 0) = lab +Z
 *   Falls back to world-X reference when the beam is nearly vertical.
 *
 * Sign conventions chosen to match the 5×5 spec:
 *   α_x = +θ  ⇔  element rotated by +θ about beam's e_x axis (right-hand)
 *   α_y = +θ  ⇔  element rotated by +θ about beam's e_y axis (right-hand)
 *   δ_x   = component of (hit - center) along e_x, in lab mm
 *   δ_y   = component of (hit - center) along e_y, in lab mm
 */

import * as THREE from "three";

import { MM_PER_THREE_UNIT } from "../optical/frames";

const WORLD_UP_THREE = new THREE.Vector3(0, 1, 0);
const WORLD_X_THREE = new THREE.Vector3(1, 0, 0);
const NEAR_PARALLEL = 0.99;

export type DeltaAlpha = {
  deltaXMm: number;
  deltaYMm: number;
  alphaXRad: number;
  alphaYRad: number;
  beamEx: THREE.Vector3;
  beamEy: THREE.Vector3;
};

/** Build a stable beam-local orthonormal basis perpendicular to incomingDir. */
export function buildBeamBasis(incomingDir: THREE.Vector3): {
  ex: THREE.Vector3;
  ey: THREE.Vector3;
  ez: THREE.Vector3;
} {
  const ez = incomingDir.clone().normalize();
  const ref = Math.abs(ez.dot(WORLD_UP_THREE)) > NEAR_PARALLEL ? WORLD_X_THREE : WORLD_UP_THREE;
  const ex = new THREE.Vector3().crossVectors(ref, ez).normalize();
  const ey = new THREE.Vector3().crossVectors(ez, ex).normalize();
  return { ex, ey, ez };
}

export function deltaAlphaFromHit(input: {
  hitPointWorld: THREE.Vector3;
  incomingDir: THREE.Vector3;
  elementCenterWorld: THREE.Vector3;
  elementNormalWorld: THREE.Vector3;
}): DeltaAlpha {
  const { ex, ey, ez } = buildBeamBasis(input.incomingDir);

  const displ = new THREE.Vector3().subVectors(input.hitPointWorld, input.elementCenterWorld);
  const deltaXMm = displ.dot(ex) * MM_PER_THREE_UNIT;
  const deltaYMm = displ.dot(ey) * MM_PER_THREE_UNIT;

  const n = input.elementNormalWorld.clone().normalize();
  if (n.dot(ez) > 0) n.negate();
  const nx = n.dot(ex);
  const ny = n.dot(ey);
  const nz = n.dot(ez);
  const denomZ = -nz;
  const alphaXRad = Math.atan2(ny, denomZ);
  const alphaYRad = Math.atan2(-nx, denomZ);

  return { deltaXMm, deltaYMm, alphaXRad, alphaYRad, beamEx: ex, beamEy: ey };
}
