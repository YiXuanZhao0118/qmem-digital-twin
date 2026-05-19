/**
 * Generalized 5×5 ABCD propagation for misaligned optical systems.
 *
 * TypeScript port of `backend/app/solvers/generalized_abcd.py`. Same API,
 * same physics, same operator definitions (lens, cylindrical, mirror,
 * curved-mirror, PBS, glass plate, rotation). See the Python module's
 * docstring for the full convention table.
 *
 * Conventions: lengths in mm, angles in rad, wavelength in nm.
 * 5×5 state vector: (x, θ_x, y, θ_y, 1)ᵀ.
 *
 * Matrices are represented as flat `Mat5 = number[]` of length 25 in
 * row-major order (M[row * 5 + col]). The flat form keeps allocation
 * cheap during a viewer trace where we may build a few hundred operators
 * per scrub frame.
 */

import {
  type Complex,
  cAdd,
  cDiv,
  cInv,
  cMul,
} from "./fiber/gaussian";

// ---------------------------------------------------------------------------
// Mat5 helpers — flat row-major 5×5
// ---------------------------------------------------------------------------

export type Mat5 = number[];

export function mat5Identity(): Mat5 {
  return [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
    0, 0, 0, 0, 1,
  ];
}

function at(M: Mat5, row: number, col: number): number {
  return M[row * 5 + col];
}

function setAt(M: Mat5, row: number, col: number, value: number): void {
  M[row * 5 + col] = value;
}

/** B @ A in math convention (B applied AFTER A). */
export function mat5Mul(B: Mat5, A: Mat5): Mat5 {
  const out: Mat5 = new Array(25).fill(0);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      let sum = 0;
      for (let k = 0; k < 5; k++) sum += B[r * 5 + k] * A[k * 5 + c];
      out[r * 5 + c] = sum;
    }
  }
  return out;
}

/** Apply 5×5 to a 5-vector v = [x, θ_x, y, θ_y, 1]. */
export function mat5Apply(M: Mat5, v: [number, number, number, number, number]): [number, number, number, number, number] {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2] + M[3] * v[3] + M[4] * v[4],
    M[5] * v[0] + M[6] * v[1] + M[7] * v[2] + M[8] * v[3] + M[9] * v[4],
    M[10] * v[0] + M[11] * v[1] + M[12] * v[2] + M[13] * v[3] + M[14] * v[4],
    M[15] * v[0] + M[16] * v[1] + M[17] * v[2] + M[18] * v[3] + M[19] * v[4],
    M[20] * v[0] + M[21] * v[1] + M[22] * v[2] + M[23] * v[3] + M[24] * v[4],
  ];
}

/** Cascade operators in beam order (first encountered first). */
export function compose(...matrices: Mat5[]): Mat5 {
  let result = mat5Identity();
  for (const M of matrices) result = mat5Mul(M, result);
  return result;
}

// ---------------------------------------------------------------------------
// 5×5 operator constructors
// ---------------------------------------------------------------------------

export function mFreeSpace(distanceMm: number): Mat5 {
  const M = mat5Identity();
  setAt(M, 0, 1, distanceMm);
  setAt(M, 2, 3, distanceMm);
  return M;
}

export type LensMisalign = {
  deltaXMm?: number;
  deltaYMm?: number;
  alphaXRad?: number;
  alphaYRad?: number;
};

export function mThinLens(focalMm: number, misalign: LensMisalign = {}): Mat5 {
  if (Math.abs(focalMm) < 1e-12) {
    throw new Error("focal length must be non-zero");
  }
  const { deltaXMm = 0, deltaYMm = 0, alphaXRad = 0, alphaYRad = 0 } = misalign;
  const invF = 1.0 / focalMm;
  const oneMinusInvF = 1.0 - invF;

  const M = mat5Identity();
  setAt(M, 1, 0, -invF);
  setAt(M, 3, 2, -invF);
  setAt(M, 1, 4, deltaXMm * invF + alphaYRad * oneMinusInvF);
  setAt(M, 3, 4, deltaYMm * invF + alphaXRad * oneMinusInvF);
  return M;
}

export type CylindricalParams = LensMisalign & {
  axis?: "x" | "y";
  thicknessMm?: number;
  refractiveIndex?: number;
};

export function mCylindricalStandard(focalMm: number, params: CylindricalParams = {}): Mat5 {
  if (Math.abs(focalMm) < 1e-12) throw new Error("focal length must be non-zero");
  const {
    axis = "x",
    thicknessMm = 0,
    refractiveIndex = 1.0,
    deltaXMm = 0,
    deltaYMm = 0,
    alphaXRad = 0,
    alphaYRad = 0,
  } = params;
  if (refractiveIndex <= 0) throw new Error("refractive index must be positive");
  const invF = 1.0 / focalMm;
  const oneMinusInvF = 1.0 - invF;
  const dOverN = thicknessMm / refractiveIndex;
  const plateShift = thicknessMm * (1.0 - 1.0 / refractiveIndex);

  const M = mat5Identity();
  if (axis === "x") {
    setAt(M, 1, 0, -invF);
    setAt(M, 1, 4, deltaXMm * invF + alphaYRad * oneMinusInvF);
    setAt(M, 2, 3, dOverN);
    setAt(M, 2, 4, alphaXRad * plateShift);
  } else if (axis === "y") {
    setAt(M, 0, 1, dOverN);
    setAt(M, 0, 4, alphaYRad * plateShift);
    setAt(M, 3, 2, -invF);
    setAt(M, 3, 4, deltaYMm * invF + alphaXRad * oneMinusInvF);
  } else {
    throw new Error(`axis must be 'x' or 'y', got ${axis}`);
  }
  return M;
}

export function mRotation(thetaRad: number): Mat5 {
  const c = Math.cos(thetaRad);
  const s = Math.sin(thetaRad);
  const M = mat5Identity();
  setAt(M, 0, 0, c);
  setAt(M, 0, 2, s);
  setAt(M, 1, 1, c);
  setAt(M, 1, 3, s);
  setAt(M, 2, 0, -s);
  setAt(M, 2, 2, c);
  setAt(M, 3, 1, -s);
  setAt(M, 3, 3, c);
  return M;
}

export function mCylindricalRotated(
  focalMm: number,
  thetaRotRad: number,
  params: CylindricalParams = {},
): Mat5 {
  const Mcyl = mCylindricalStandard(focalMm, params);
  return mat5Mul(mat5Mul(mRotation(-thetaRotRad), Mcyl), mRotation(thetaRotRad));
}

export type MirrorTilt = { alphaXRad?: number; alphaYRad?: number };

export function mFlatMirror(tilt: MirrorTilt = {}): Mat5 {
  const { alphaXRad = 0, alphaYRad = 0 } = tilt;
  const M = mat5Identity();
  setAt(M, 1, 1, -1.0);
  setAt(M, 3, 3, -1.0);
  setAt(M, 1, 4, 2.0 * alphaYRad);
  setAt(M, 3, 4, 2.0 * alphaXRad);
  return M;
}

export function mCurvedMirror(radiusMm: number, misalign: LensMisalign = {}): Mat5 {
  if (Math.abs(radiusMm) < 1e-12) throw new Error("radius must be non-zero");
  const { deltaXMm = 0, deltaYMm = 0, alphaXRad = 0, alphaYRad = 0 } = misalign;
  const invF = 2.0 / radiusMm;

  const M = mat5Identity();
  setAt(M, 1, 0, -invF);
  setAt(M, 1, 1, -1.0);
  setAt(M, 3, 2, -invF);
  setAt(M, 3, 3, -1.0);
  setAt(M, 1, 4, deltaXMm * invF + 2.0 * alphaYRad);
  setAt(M, 3, 4, deltaYMm * invF + 2.0 * alphaXRad);
  return M;
}

export function mGlassPlate(thicknessMm: number, refractiveIndex: number, tilt: MirrorTilt = {}): Mat5 {
  if (refractiveIndex <= 0) throw new Error("refractive index must be positive");
  const { alphaXRad = 0, alphaYRad = 0 } = tilt;
  const dOverN = thicknessMm / refractiveIndex;
  const plateShift = thicknessMm * (1.0 - 1.0 / refractiveIndex);

  const M = mat5Identity();
  setAt(M, 0, 1, dOverN);
  setAt(M, 2, 3, dOverN);
  setAt(M, 0, 4, alphaYRad * plateShift);
  setAt(M, 2, 4, alphaXRad * plateShift);
  return M;
}

export function mPbsReflected(tilt: MirrorTilt = {}): Mat5 {
  return mFlatMirror(tilt);
}

export function mPbsTransmitted(cubeSizeMm: number, refractiveIndex: number, tilt: MirrorTilt = {}): Mat5 {
  return mGlassPlate(cubeSizeMm, refractiveIndex, tilt);
}

// ---------------------------------------------------------------------------
// Beam state
// ---------------------------------------------------------------------------

export type BeamMisaligned = {
  qX: Complex;
  qY: Complex;
  xCMm: number;
  yCMm: number;
  thetaXCRad: number;
  thetaYCRad: number;
  wavelengthNm: number;
};

export function beamMisaligned(init: {
  qX: Complex;
  qY: Complex;
  xCMm?: number;
  yCMm?: number;
  thetaXCRad?: number;
  thetaYCRad?: number;
  wavelengthNm: number;
}): BeamMisaligned {
  return {
    qX: init.qX,
    qY: init.qY,
    xCMm: init.xCMm ?? 0,
    yCMm: init.yCMm ?? 0,
    thetaXCRad: init.thetaXCRad ?? 0,
    thetaYCRad: init.thetaYCRad ?? 0,
    wavelengthNm: init.wavelengthNm,
  };
}

// ---------------------------------------------------------------------------
// q-parameter constructors and derived quantities
// ---------------------------------------------------------------------------

export function qFromWaist(
  waistUm: number,
  waistZOffsetMm: number,
  wavelengthNm: number,
  mSquared = 1.0,
): Complex {
  const w0Mm = waistUm * 1e-3;
  const lamMm = wavelengthNm * 1e-6;
  const zRMm = (Math.PI * w0Mm * w0Mm) / (Math.max(mSquared, 1e-9) * lamMm);
  return { re: -waistZOffsetMm, im: zRMm };
}

export function waistUmFromQ(q: Complex, wavelengthNm: number, mSquared = 1.0): number {
  const zRMm = Math.max(q.im, 1e-12);
  const lamMm = wavelengthNm * 1e-6;
  const w0Mm = Math.sqrt((zRMm * lamMm * Math.max(mSquared, 1e-9)) / Math.PI);
  return w0Mm * 1000.0;
}

export function spotRadiusUm(q: Complex, wavelengthNm: number, mSquared = 1.0): number {
  const mag2 = q.re * q.re + q.im * q.im;
  if (mag2 < 1e-30) return 0;
  const invQIm = -q.im / mag2;
  const lamMm = wavelengthNm * 1e-6;
  if (Math.abs(invQIm) < 1e-30) return Number.POSITIVE_INFINITY;
  const wMm = Math.sqrt((-lamMm / (Math.PI * invQIm)) * Math.max(mSquared, 1e-9));
  return wMm * 1000.0;
}

export function radiusOfCurvatureMm(q: Complex): number {
  const mag2 = q.re * q.re + q.im * q.im;
  if (mag2 < 1e-30) return Number.POSITIVE_INFINITY;
  const invQRe = q.re / mag2;
  if (Math.abs(invQRe) < 1e-30) return Number.POSITIVE_INFINITY;
  return 1.0 / invQRe;
}

// ---------------------------------------------------------------------------
// Generalized ABCD propagation
// ---------------------------------------------------------------------------

/** Apply a 5×5 augmented operator. q via per-axis ABCD law; chief-ray via
 *  full 5×5 vector multiply (handles cross-axis coupling from rotated
 *  cylindrical optics). */
export function applyOperator(beam: BeamMisaligned, M: Mat5): BeamMisaligned {
  if (M.length !== 25) throw new Error(`operator must be 5×5 flat (length 25), got ${M.length}`);

  const Ax = at(M, 0, 0), Bx = at(M, 0, 1);
  const Cx = at(M, 1, 0), Dx = at(M, 1, 1);
  const Ay = at(M, 2, 2), By = at(M, 2, 3);
  const Cy = at(M, 3, 2), Dy = at(M, 3, 3);

  const denomX = cAdd(cMul({ re: Cx, im: 0 }, beam.qX), { re: Dx, im: 0 });
  const denomY = cAdd(cMul({ re: Cy, im: 0 }, beam.qY), { re: Dy, im: 0 });
  if (denomX.re * denomX.re + denomX.im * denomX.im < 1e-60
      || denomY.re * denomY.re + denomY.im * denomY.im < 1e-60) {
    throw new Error("ABCD denominator vanished — degenerate operator/beam");
  }
  const qXOut = cDiv(cAdd(cMul({ re: Ax, im: 0 }, beam.qX), { re: Bx, im: 0 }), denomX);
  const qYOut = cDiv(cAdd(cMul({ re: Ay, im: 0 }, beam.qY), { re: By, im: 0 }), denomY);

  const [xCOut, thetaXCOut, yCOut, thetaYCOut] = mat5Apply(M, [
    beam.xCMm, beam.thetaXCRad, beam.yCMm, beam.thetaYCRad, 1,
  ]);

  return {
    qX: qXOut,
    qY: qYOut,
    xCMm: xCOut,
    yCMm: yCOut,
    thetaXCRad: thetaXCOut,
    thetaYCRad: thetaYCOut,
    wavelengthNm: beam.wavelengthNm,
  };
}

// Re-export Complex helpers so consumers can build q values without a
// second import.
export { cInv, type Complex };
