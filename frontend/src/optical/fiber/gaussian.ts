/**
 * Gaussian beam math — circular and astigmatic. q-parameter propagation,
 * spot size at arbitrary z, divergence half-angle, ABCD propagation
 * (lens, mirror, free-space).
 *
 * Convention:
 *   q(z) = z + i·z_R    where z_R = π·w_0² / λ  (Rayleigh range)
 *   1/q(z) = 1/R(z) − i·λ/(π·w(z)²)
 *   w(z) = w_0·sqrt(1 + (z/z_R)²)
 *
 * For astigmatic beams (laser diode, wedge prisms, etc.) we keep two
 * INDEPENDENT q-parameters along orthogonal beam axes (axisX, axisY)
 * perpendicular to the propagation direction. The axes need not be
 * aligned with the lab x/y; for a rotated diode we store the actual
 * orthogonal axis vectors so the field at any point is fully
 * specified.
 */

export type Complex = { re: number; im: number };

export const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const cDiv = (a: Complex, b: Complex): Complex => {
  const denom = b.re * b.re + b.im * b.im;
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom,
  };
};
export const cInv = (a: Complex): Complex => {
  const denom = a.re * a.re + a.im * a.im;
  return { re: a.re / denom, im: -a.im / denom };
};

/** Build q at the waist (z=0). q_waist = i·z_R. */
export function qAtWaist(waistRadiusM: number, lambdaM: number): Complex {
  const zR = (Math.PI * waistRadiusM * waistRadiusM) / lambdaM;
  return { re: 0, im: zR };
}

/** Build q at a position z away from the waist (along propagation axis). */
export function qAtZFromWaist(waistRadiusM: number, lambdaM: number, zM: number): Complex {
  const q0 = qAtWaist(waistRadiusM, lambdaM);
  return { re: q0.re + zM, im: q0.im };
}

/** Spot radius w(z) from q(z). */
export function spotRadiusFromQ(q: Complex, lambdaM: number): number {
  const invQ = cInv(q);
  // 1/q = 1/R - i·λ/(π·w²)  →  w = sqrt(λ / (π · |Im(1/q)|))
  return Math.sqrt(lambdaM / (Math.PI * Math.abs(invQ.im)));
}

/** Wavefront radius of curvature R(z) from q(z). +∞ at the waist. */
export function radiusOfCurvatureFromQ(q: Complex): number {
  const invQ = cInv(q);
  if (Math.abs(invQ.re) < 1e-30) return Number.POSITIVE_INFINITY;
  return 1.0 / invQ.re;
}

/** Far-field divergence half-angle from waist radius and wavelength.
 *  θ_div = λ / (π · w_0). Independent of z (constant for free-space). */
export function divergenceHalfAngleFromWaist(waistRadiusM: number, lambdaM: number): number {
  return lambdaM / (Math.PI * waistRadiusM);
}

/** Recover (w_0, z_offset) from a q-parameter at arbitrary z. */
export function waistFromQ(q: Complex, lambdaM: number): {
  waistRadiusM: number;
  zFromWaistM: number;
} {
  // q = z + i·z_R where z is the offset from waist along +propagation
  const zR = q.im;
  const waistRadiusM = Math.sqrt((lambdaM * zR) / Math.PI);
  return { waistRadiusM, zFromWaistM: q.re };
}

/** Apply a thin-lens ABCD matrix to q. M = [[1, 0], [-1/f, 1]].
 *  q' = (A·q + B) / (C·q + D) */
export function applyThinLens(q: Complex, focalLengthM: number): Complex {
  const negInvF: Complex = { re: -1 / focalLengthM, im: 0 };
  const numerator = q;
  const denominator = cAdd(cMul(negInvF, q), { re: 1, im: 0 });
  return cDiv(numerator, denominator);
}

/** Free-space propagation by distance d: q' = q + d. */
export function propagateFreeSpace(q: Complex, distanceM: number): Complex {
  return { re: q.re + distanceM, im: q.im };
}

/**
 * Astigmatic Gaussian beam descriptor in lab frame. The beam has two
 * principal transverse axes (axisXLab, axisYLab) which are orthogonal
 * unit vectors perpendicular to propagationDirLab. q_x and q_y track
 * the complex beam parameter along each transverse axis independently.
 */
export type AstigmaticBeam = {
  qx: Complex;
  qy: Complex;
  axisXLab: [number, number, number];
  axisYLab: [number, number, number];
  propagationDirLab: [number, number, number];
  /** Origin point along the propagation direction at which qx/qy are
   *  evaluated. Use propagateFreeSpace(distance) to advance. */
  originLabM: [number, number, number];
  lambdaM: number;
};

/** Convenience: build a circular Gaussian (qx = qy) at its waist
 *  centered at origin, propagating in +x_lab. */
export function makeCircularGaussianAtWaist(
  waistRadiusM: number,
  lambdaM: number,
  originLabM: [number, number, number] = [0, 0, 0],
  propagationDirLab: [number, number, number] = [1, 0, 0],
  axisXLab: [number, number, number] = [0, 1, 0],
  axisYLab: [number, number, number] = [0, 0, 1],
): AstigmaticBeam {
  const q = qAtWaist(waistRadiusM, lambdaM);
  return {
    qx: { ...q },
    qy: { ...q },
    axisXLab,
    axisYLab,
    propagationDirLab,
    originLabM,
    lambdaM,
  };
}

/** Spot radii at the current origin in the beam's two principal axes. */
export function spotAtOrigin(beam: AstigmaticBeam): { wxM: number; wyM: number } {
  return {
    wxM: spotRadiusFromQ(beam.qx, beam.lambdaM),
    wyM: spotRadiusFromQ(beam.qy, beam.lambdaM),
  };
}
