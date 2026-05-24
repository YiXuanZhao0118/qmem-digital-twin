/**
 * Jones vector helpers — frame convention + transformations between
 * beam-local s/p frames when the beam direction changes (reflection,
 * refraction, polarization-altering elements).
 *
 * Frame convention:
 *   Jones = [E_s, E_p] in **beam-local s/p frame**, where
 *     +z_beam = beam.direction (unit)
 *     +s_beam = projection of a global "up" reference onto the plane
 *               perpendicular to z_beam (then normalized)
 *     +p_beam = z_beam × s_beam       (right-handed)
 *
 * When direction changes (e.g. mirror reflection), the s/p basis flips
 * parity and must be rotated to express the same physical polarization
 * in the new frame. `rotateJonesIntoNewFrame` handles that.
 *
 * Most PhysicsOps receive Jones already expressed in the s/p basis of
 * the incoming face — the ray tracer wraps `rotateJonesIntoNewFrame` at
 * the face-hit boundary so op authors don't have to worry.
 */

import { type Complex, cMul, cAdd } from "./fiber/gaussian";
import {
  type Vec3,
  vec3Dot,
  vec3Scale,
  vec3Sub,
  normalize,
} from "./beam-ray";

/** Global "up" reference used to define s_beam when beam direction is
 *  not parallel to it. Chosen as lab +z (vertical). */
const GLOBAL_UP: Vec3 = { x: 0, y: 0, z: 1 };
/** Fallback "up" when beam direction is (anti-)parallel to GLOBAL_UP. */
const FALLBACK_UP: Vec3 = { x: 1, y: 0, z: 0 };

/** Compute s_beam and p_beam unit vectors for a given beam direction.
 *  Returns the (s, p) pair such that {direction, s, p} is right-handed
 *  with direction = s × p. */
export function beamLocalSP(direction: Vec3): { s: Vec3; p: Vec3 } {
  const d = normalize(direction);
  // Choose up reference: prefer GLOBAL_UP unless beam is parallel to it.
  const dotUp = vec3Dot(d, GLOBAL_UP);
  const up = Math.abs(dotUp) > 0.999 ? FALLBACK_UP : GLOBAL_UP;
  // s = up - (up·d)·d, then normalize → perpendicular to d in the (d, up) plane
  const upMinusProj = vec3Sub(up, vec3Scale(d, vec3Dot(up, d)));
  const s = normalize(upMinusProj);
  // p = d × s (right-handed)
  const p: Vec3 = {
    x: d.y * s.z - d.z * s.y,
    y: d.z * s.x - d.x * s.z,
    z: d.x * s.y - d.y * s.x,
  };
  return { s, p };
}

/** Rotate Jones vector from one beam-local s/p basis into another, by
 *  the angle `phi` between the old +s and the new +s (measured in the
 *  plane perpendicular to the beam direction, right-handed about
 *  +direction). */
export function rotateJones(
  jones: [Complex, Complex],
  phiRad: number,
): [Complex, Complex] {
  const c = Math.cos(phiRad);
  const s = Math.sin(phiRad);
  const cC: Complex = { re: c, im: 0 };
  const sC: Complex = { re: s, im: 0 };
  // [E_s']   [ c  s] [E_s]
  // [E_p'] = [-s  c] [E_p]
  const Es_new = cAdd(cMul(cC, jones[0]), cMul(sC, jones[1]));
  const Ep_new = cAdd(
    cMul({ re: -s, im: 0 }, jones[0]),
    cMul(cC, jones[1]),
  );
  return [Es_new, Ep_new];
}

/** Compute the rotation angle phi needed to re-express Jones from
 *  s_old basis to s_new basis (both perpendicular to the same beam
 *  direction). phi = signed angle from s_old to s_new about +direction.
 *  Used when the beam direction changes (reflection, refraction). */
export function jonesRotationAngle(
  sOld: Vec3,
  sNew: Vec3,
  direction: Vec3,
): number {
  const cosPhi = vec3Dot(sOld, sNew);
  // Sign from cross product · direction
  const cross: Vec3 = {
    x: sOld.y * sNew.z - sOld.z * sNew.y,
    y: sOld.z * sNew.x - sOld.x * sNew.z,
    z: sOld.x * sNew.y - sOld.y * sNew.x,
  };
  const sinPhi = vec3Dot(cross, direction);
  return Math.atan2(sinPhi, cosPhi);
}

/** Convenience: given a ray that just changed direction (e.g. after
 *  reflection from a mirror), compute the new Jones vector by rotating
 *  the s/p basis from old direction to new direction. */
export function rotateJonesIntoNewFrame(
  jones: [Complex, Complex],
  oldDirection: Vec3,
  newDirection: Vec3,
): [Complex, Complex] {
  const { s: sOld } = beamLocalSP(oldDirection);
  const { s: sNew } = beamLocalSP(newDirection);
  const phi = jonesRotationAngle(sOld, sNew, newDirection);
  return rotateJones(jones, phi);
}

/** Power = |E_s|² + |E_p|² (without explicit power factor — used for
 *  validating Jones vector magnitude). */
export function jonesIntensity(jones: [Complex, Complex]): number {
  const [Es, Ep] = jones;
  return Es.re * Es.re + Es.im * Es.im + Ep.re * Ep.re + Ep.im * Ep.im;
}

// ---------------------------------------------------------------------------
// Lab ↔ body Jones basis transformation (Phase 4c).
//
// When the same physical polarization is expressed in two different
// beam-local s/p frames — one derived from the lab direction, one from
// the body direction — the basis is rotated. These helpers compute the
// rotation angle from the geometry and apply it via rotateJones.
//
// Algorithm:
//   - s_lab is the +s vector in lab frame, derived from dirLab.
//   - s_body is the +s vector in body frame, derived from dirBody.
//   - Express s_lab in body coords (applying the inverse of the body→lab
//     transform) so both vectors live in the same frame.
//   - Angle from s_lab_in_body to s_body about dirBody is the basis
//     rotation that takes lab Jones to body Jones.
// ---------------------------------------------------------------------------

/** Convert a Jones vector from lab beam-local s/p frame to body
 *  beam-local s/p frame.
 *
 *  @param dirToBody Function that maps a lab-frame direction vector to
 *                   the body-frame equivalent (typically the slot's
 *                   `dirLabToBodyT` curried with its transform).
 */
export function jonesLabToBody(
  jones: [Complex, Complex],
  dirLab: Vec3,
  dirBody: Vec3,
  dirToBody: (v: Vec3) => Vec3,
): [Complex, Complex] {
  const { s: sLab } = beamLocalSP(dirLab);
  const { s: sBody } = beamLocalSP(dirBody);
  const sLabInBody = dirToBody(sLab);
  const phi = jonesRotationAngle(sLabInBody, sBody, dirBody);
  return rotateJones(jones, phi);
}

/** Inverse: body beam-local s/p → lab beam-local s/p. */
export function jonesBodyToLab(
  jones: [Complex, Complex],
  dirBody: Vec3,
  dirLab: Vec3,
  dirToLab: (v: Vec3) => Vec3,
): [Complex, Complex] {
  const { s: sLab } = beamLocalSP(dirLab);
  const { s: sBody } = beamLocalSP(dirBody);
  const sBodyInLab = dirToLab(sBody);
  const phi = jonesRotationAngle(sBodyInLab, sLab, dirLab);
  return rotateJones(jones, phi);
}
