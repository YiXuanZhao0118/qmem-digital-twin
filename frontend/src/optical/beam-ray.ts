/**
 * BeamRay — the single value that flows through the v3 ray tracer.
 *
 * Combines:
 *   - **Chief ray** (origin + direction): macroscopic guidance through 3D space
 *   - **Gaussian beam q-parameter** (qx + qy independent): microscopic envelope
 *     (waist size, wavefront curvature, astigmatism via qx ≠ qy)
 *   - **Jones vector**: full polarization in beam-local s/p frame
 *   - **Spectrum + energy**: wavelength + power
 *   - **Tracking**: accumulated path length, phase (data only — no auto-recombination)
 *
 * Frame conventions:
 *   - `origin` is in **lab mm**
 *   - `direction` is a **unit vector** in lab frame
 *   - `qx`, `qy` are scalar Gaussian q-parameters along beam-local transverse axes
 *   - `jones = [E_s, E_p]` is in **beam-local s/p frame**, where +s = perp to
 *     the local plane of incidence (or global up reference when no plane).
 *     PhysicsOps receive Jones already expressed in the s/p basis of the
 *     incoming face.
 *
 * This struct is the input AND output of every PhysicsOp. Ops are pure
 * functions: (BeamRay, ctx) → BeamRay[].
 */

import { type Complex, qAtWaist } from "./fiber/gaussian";

export type Vec3 = { x: number; y: number; z: number };

export type BeamRay = {
  // ---- Chief ray (lab frame, mm) ----
  origin: Vec3;
  direction: Vec3;            // unit vector

  // ---- Gaussian beam envelope (per-axis q-parameter) ----
  qx: Complex;                // qx = (z − z_waist_x) + i·zR_x
  qy: Complex;                // qy = (z − z_waist_y) + i·zR_y

  // ---- Spectrum & energy ----
  wavelengthNm: number;
  powerMw: number;

  // ---- Polarization (beam-local s/p frame) ----
  jones: [Complex, Complex];  // [E_s, E_p]

  // ---- Tracking (data only — no auto-recombination at rendezvous) ----
  pathLengthMm: number;
  phaseAccumRad: number;

  // ---- Bookkeeping ----
  parentId?: string;          // for branching (BS, AOM, ghost rays)
  excludeFaceKey?: string;    // avoid immediate re-hit of the face we just exited
  isGhost?: boolean;          // AR Fresnel back-reflection, etc.
};

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const ZERO_C: Complex = { re: 0, im: 0 };
const ONE_C: Complex = { re: 1, im: 0 };

/** Build a BeamRay at a waist of radius `w0Mm`, propagating along `direction`.
 *  Defaults: circular Gaussian (qx = qy), linearly polarized in +s, 1 mW. */
export function makeBeamRay(opts: {
  origin: Vec3;
  direction: Vec3;
  wavelengthNm: number;
  waistRadiusMm?: number;     // defaults to 0.5 mm
  powerMw?: number;           // defaults to 1.0
  jones?: [Complex, Complex]; // defaults to [+s, 0]
}): BeamRay {
  const lambdaMm = opts.wavelengthNm * 1e-6;
  const w0Mm = opts.waistRadiusMm ?? 0.5;
  const q = qAtWaist(w0Mm, lambdaMm);
  return {
    origin: opts.origin,
    direction: normalize(opts.direction),
    qx: { ...q },
    qy: { ...q },
    wavelengthNm: opts.wavelengthNm,
    powerMw: opts.powerMw ?? 1.0,
    jones: opts.jones ?? [ONE_C, ZERO_C],
    pathLengthMm: 0,
    phaseAccumRad: 0,
  };
}

// ---------------------------------------------------------------------------
// Vec3 utilities (kept local to avoid pulling THREE into hot path)
// ---------------------------------------------------------------------------

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function vec3Scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function vec3Length(a: Vec3): number {
  return Math.sqrt(vec3Dot(a, a));
}
export function normalize(a: Vec3): Vec3 {
  const len = vec3Length(a);
  if (len < 1e-15) throw new Error("cannot normalize zero vector");
  return vec3Scale(a, 1 / len);
}

/** Distance between two points. */
export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3Length(vec3Sub(a, b));
}
