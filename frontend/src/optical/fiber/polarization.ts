/**
 * Polarization handling for fibers. Jones-vector centric (2-component
 * complex), with Stokes-vector helpers for ray-tracer integration.
 *
 * Three fiber types behave differently:
 *
 *   PM:  preserves polarization. Slow / fast eigenmodes of the fiber
 *        accumulate different phases (birefringence Δβ·L). Power on
 *        each axis is preserved; relative phase shifts.
 *
 *   SM (non-PM): non-deterministic random rotation along the fiber.
 *        We model with a frozen-random Jones rotation seeded from the
 *        instance id so reloads are reproducible.
 *
 *   MM:  fully depolarized. Output Jones state is replaced by an
 *        unpolarized Stokes vector (S₁ = S₂ = S₃ = 0).
 */

import type { FiberType } from "../../types/digitalTwin";

export type Complex = { re: number; im: number };
export type JonesVector = { ex: Complex; ey: Complex };
export type StokesVector = { s0: number; s1: number; s2: number; s3: number };

/** Multiply two complex numbers. */
const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});

/** Modulus squared. */
const cAbs2 = (a: Complex): number => a.re * a.re + a.im * a.im;

/** Build a Jones vector from real linear polarization at angle φ to x-axis. */
export function jonesFromLinearAngle(phiRad: number): JonesVector {
  return {
    ex: { re: Math.cos(phiRad), im: 0 },
    ey: { re: Math.sin(phiRad), im: 0 },
  };
}

/** Total power |E|² of a Jones vector. */
export function jonesPower(j: JonesVector): number {
  return cAbs2(j.ex) + cAbs2(j.ey);
}

/** Stokes from Jones (assumes E·E* convention). */
export function stokesFromJones(j: JonesVector): StokesVector {
  const exAbs2 = cAbs2(j.ex);
  const eyAbs2 = cAbs2(j.ey);
  // Cross terms:  Ex Ey* = Ex.real·Ey.real + Ex.imag·Ey.imag + i·(Ex.imag·Ey.real - Ex.real·Ey.imag)
  // wait: Ex·conj(Ey) — corrected:
  const reCross = j.ex.re * j.ey.re + j.ex.im * j.ey.im;
  const imCross = j.ex.im * j.ey.re - j.ex.re * j.ey.im;
  return {
    s0: exAbs2 + eyAbs2,
    s1: exAbs2 - eyAbs2,
    s2: 2 * reCross,
    s3: -2 * imCross,
  };
}

/** Apply a 2x2 complex Jones matrix to a Jones vector.
 *  out = M · in;  matrix indexed [m00, m01, m10, m11]. */
export function applyJonesMatrix(
  m00: Complex,
  m01: Complex,
  m10: Complex,
  m11: Complex,
  jIn: JonesVector,
): JonesVector {
  return {
    ex: {
      re: m00.re * jIn.ex.re - m00.im * jIn.ex.im + m01.re * jIn.ey.re - m01.im * jIn.ey.im,
      im: m00.re * jIn.ex.im + m00.im * jIn.ex.re + m01.re * jIn.ey.im + m01.im * jIn.ey.re,
    },
    ey: {
      re: m10.re * jIn.ex.re - m10.im * jIn.ex.im + m11.re * jIn.ey.re - m11.im * jIn.ey.im,
      im: m10.re * jIn.ex.im + m10.im * jIn.ex.re + m11.re * jIn.ey.im + m11.im * jIn.ey.re,
    },
  };
}

/**
 * Jones matrix for a PM fiber:
 *
 *   J = R(−φ_s) · diag(exp(i·β_slow·L), exp(i·β_fast·L)) · R(φ_s)
 *
 * where φ_s is the slow-axis angle relative to the input polarization
 * basis. This rotates the input into the slow/fast eigenbasis,
 * applies independent phase delays, then rotates back.
 *
 * Δβ = (2π/λ) · Δn  is the birefringence per unit length;
 * total accumulated phase difference = Δβ · L.
 *
 * Jones output preserves total |E|² (no polarization loss); the
 * polarization state may rotate depending on Δβ·L.
 */
export function pmFiberJones(
  slowAxisAngleRad: number,
  deltaN: number,
  lambdaM: number,
  arcLengthM: number,
): { m00: Complex; m01: Complex; m10: Complex; m11: Complex } {
  const dPhi = (2 * Math.PI * deltaN * arcLengthM) / lambdaM;
  // We can pick the global phase reference. Set slow phase = 0, fast = dPhi.
  // Diagonal in the rotated frame:
  const phaseSlow: Complex = { re: 1, im: 0 };
  const phaseFast: Complex = { re: Math.cos(dPhi), im: Math.sin(dPhi) };
  const c = Math.cos(slowAxisAngleRad);
  const s = Math.sin(slowAxisAngleRad);
  // J = R(-φ) · D · R(φ)  where R(φ) = [[c, s], [-s, c]]
  // Multiplying out: J[00] = c²·d_slow + s²·d_fast,
  //                  J[01] = c·s·(d_slow − d_fast),
  //                  J[10] = c·s·(d_slow − d_fast),
  //                  J[11] = s²·d_slow + c²·d_fast.
  const cs = c * s;
  const dSminusF: Complex = {
    re: phaseSlow.re - phaseFast.re,
    im: phaseSlow.im - phaseFast.im,
  };
  return {
    m00: {
      re: c * c * phaseSlow.re + s * s * phaseFast.re,
      im: c * c * phaseSlow.im + s * s * phaseFast.im,
    },
    m01: { re: cs * dSminusF.re, im: cs * dSminusF.im },
    m10: { re: cs * dSminusF.re, im: cs * dSminusF.im },
    m11: {
      re: s * s * phaseSlow.re + c * c * phaseFast.re,
      im: s * s * phaseSlow.im + c * c * phaseFast.im,
    },
  };
  // Verify: |J·j|² = |j|² for any j (unitary).
}

/**
 * Single-mode (non-PM) fiber: random rotation seeded from a numeric
 * seed (typically the SceneObject id hashed to int). Reproducible.
 *
 * We use a deterministic pseudo-random generator (Mulberry32) so the
 * same seed always produces the same Jones rotation across runs.
 */
export function smFiberJones(
  seed: number,
): { m00: Complex; m01: Complex; m10: Complex; m11: Complex } {
  const prng = mulberry32(seed >>> 0);
  // Random unitary 2x2: parametrize by (θ, φ_a, φ_b, φ_c) uniformly.
  const theta = prng() * Math.PI;
  const phiA = prng() * 2 * Math.PI;
  const phiB = prng() * 2 * Math.PI;
  const phiC = prng() * 2 * Math.PI;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // U = exp(iφ_a) · [[c·exp(iφ_b), s·exp(iφ_c)], [−s·exp(−iφ_c), c·exp(−iφ_b)]]
  const eA: Complex = { re: Math.cos(phiA), im: Math.sin(phiA) };
  const eB: Complex = { re: Math.cos(phiB), im: Math.sin(phiB) };
  const eC: Complex = { re: Math.cos(phiC), im: Math.sin(phiC) };
  const eMinusB: Complex = { re: eB.re, im: -eB.im };
  const eMinusC: Complex = { re: eC.re, im: -eC.im };
  const sNeg = -s;
  return {
    m00: cMul(eA, { re: c * eB.re, im: c * eB.im }),
    m01: cMul(eA, { re: s * eC.re, im: s * eC.im }),
    m10: cMul(eA, { re: sNeg * eMinusC.re, im: sNeg * eMinusC.im }),
    m11: cMul(eA, { re: c * eMinusB.re, im: c * eMinusB.im }),
  };
}

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Apply the appropriate fiber Jones matrix to an input Jones vector
 * for the given fiber type. Returns the output Jones for SM/PM, and
 * a Stokes-vector representation for MM (since MM scrambles fully).
 */
export function applyFiberPolarizationTransform(args: {
  fiberType: FiberType;
  inputJones: JonesVector;
  /** PM only — slow axis world angle relative to Jones basis (rad). */
  slowAxisAngleRad?: number;
  /** PM only — birefringence (dimensionless). */
  deltaN?: number;
  /** SM/PM — wavelength (m). */
  lambdaM?: number;
  /** SM/PM — fiber arc length (m). */
  arcLengthM?: number;
  /** SM only — random seed for the frozen rotation. */
  smSeed?: number;
}): { jones?: JonesVector; stokes: StokesVector } {
  const { fiberType, inputJones } = args;
  if (fiberType === "polarization_maintaining") {
    const phi = args.slowAxisAngleRad ?? 0;
    const dn = args.deltaN ?? 0;
    const lam = args.lambdaM ?? 780e-9;
    const L = args.arcLengthM ?? 0;
    const m = pmFiberJones(phi, dn, lam, L);
    const out = applyJonesMatrix(m.m00, m.m01, m.m10, m.m11, inputJones);
    return { jones: out, stokes: stokesFromJones(out) };
  }
  if (fiberType === "single_mode") {
    const seed = args.smSeed ?? 1;
    const m = smFiberJones(seed);
    const out = applyJonesMatrix(m.m00, m.m01, m.m10, m.m11, inputJones);
    return { jones: out, stokes: stokesFromJones(out) };
  }
  // MM: fully depolarized — keep total power, zero S1/S2/S3
  const power = jonesPower(inputJones);
  return { stokes: { s0: power, s1: 0, s2: 0, s3: 0 } };
}
