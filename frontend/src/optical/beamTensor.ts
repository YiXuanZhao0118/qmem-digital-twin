/**
 * TypeScript mirror of the transverse-tensor helpers in
 * `backend/app/optical/beam_ray.py` (`sym2_rotate`, `sym2_eig`,
 * `q_width_tensor`, `beam_real_widths`).
 *
 * The backend carries the beam as a complex symmetric 2x2 matrix Q plus two
 * real symmetric readout tensors (the width multiplier and M²), all expressed
 * in `jones.beam_local_sp`'s (s, p) basis. The frontend models a beam as two
 * INDEPENDENT axes, which is exact only while those axes coincide with that
 * basis. These helpers find the beam's own principal axes so the per-axis
 * model can be applied in the frame where it is exact, with the leftover
 * rotation carried alongside as an azimuth.
 *
 * Why one azimuth per segment is enough: every element in the tracer applies a
 * ROTATED DIAGONAL operator, so Q always has the form `R·diag(qa, qb)·Rᵀ`, and
 * free-space propagation is `Q + L·I = R·diag(qa+L, qb+L)·Rᵀ` — the same R.
 * The principal axes therefore do not turn along a straight segment; only the
 * widths do. (A beam with genuinely general astigmatism, where Re and Im of
 * Q⁻¹ have different principal axes, WOULD twist as it propagates. The tracer
 * cannot currently produce one.)
 */

export type Complex = { re: number; im: number };
/** Symmetric 2x2, real. `xy` is the off-diagonal (== yx). */
export type Sym2 = { xx: number; yy: number; xy: number };
/** Symmetric 2x2, complex. */
export type CSym2 = { xx: Complex; yy: Complex; xy: Complex };

const cMul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cAdd = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const cSub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const cScale = (a: Complex, k: number): Complex => ({ re: a.re * k, im: a.im * k });
const cDiv = (a: Complex, b: Complex): Complex => {
  const d = b.re * b.re + b.im * b.im;
  if (d === 0) return { re: 0, im: 0 };
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};

/**
 * Re-express a real symmetric 2x2 in a basis rotated by `phi`: `T' = R·T·Rᵀ`
 * with the same R as the backend's `q_rotate` / `rotate_jones`.
 *
 * Returns the input untouched for a zero rotation OR an isotropic tensor —
 * the latter exactly, since an isotropic tensor is the same in every frame.
 */
export function rotateSym2(t: Sym2, phi: number): Sym2 {
  if (phi === 0 || (t.xy === 0 && t.xx === t.yy)) return t;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const cc = c * c;
  const ss = s * s;
  const cs = c * s;
  return {
    xx: cc * t.xx + 2 * cs * t.xy + ss * t.yy,
    yy: ss * t.xx - 2 * cs * t.xy + cc * t.yy,
    xy: cs * (t.yy - t.xx) + (cc - ss) * t.xy,
  };
}

/** Eigen-decomposition of a real symmetric 2x2. `azimuthRad` is the direction
 *  of `major`, and rotating the tensor BY it diagonalises the tensor. */
export function eigSym2(t: Sym2): { major: number; minor: number; azimuthRad: number } {
  const mid = 0.5 * (t.xx + t.yy);
  const rad = Math.hypot(0.5 * (t.xx - t.yy), t.xy);
  return { major: mid + rad, minor: mid - rad, azimuthRad: 0.5 * Math.atan2(2 * t.xy, t.xx - t.yy) };
}

/** Re-express a complex symmetric 2x2 in a rotated basis — the Q counterpart
 *  of {@link rotateSym2}. */
export function rotateCSym2(q: CSym2, phi: number): CSym2 {
  if (phi === 0) return q;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const cc = c * c;
  const ss = s * s;
  const cs = c * s;
  return {
    xx: cAdd(cAdd(cScale(q.xx, cc), cScale(q.xy, 2 * cs)), cScale(q.yy, ss)),
    yy: cSub(cAdd(cScale(q.xx, ss), cScale(q.yy, cc)), cScale(q.xy, 2 * cs)),
    xy: cAdd(cScale(cSub(q.yy, q.xx), cs), cScale(q.xy, cc - ss)),
  };
}

/**
 * Embedded width-SQUARED tensor of Q, so the 1/e² field radius along a unit
 * direction `n` is `sqrt(nᵀWn)`. `|E|² ~ exp(k·rᵀ Im(Q⁻¹) r)` gives
 * `W = -(λ/π)·Im(Q⁻¹)⁻¹`.
 *
 * Only ever used here for its ORIENTATION, which is scale-free, so the units
 * of `wavelengthNm` versus the q entries do not have to agree.
 */
export function qWidthTensor(q: CSym2, wavelengthNm: number): Sym2 {
  const det = cSub(cMul(q.xx, q.yy), cMul(q.xy, q.xy));
  if (det.re === 0 && det.im === 0) return { xx: 0, yy: 0, xy: 0 };
  // Q⁻¹ = (1/det)·[[yy, -xy], [-xy, xx]]
  const a = cDiv(q.yy, det).im;
  const c = cDiv(q.xx, det).im;
  const b = cDiv(cScale(q.xy, -1), det).im;
  const idet = a * c - b * b;
  if (idet === 0) return { xx: 0, yy: 0, xy: 0 };
  const k = -(wavelengthNm * 1e-6) / (Math.PI * idet);
  return { xx: k * c, yy: k * a, xy: -k * b };
}

/** `S·W·S` — the embedded width tensor scaled by the (symmetric) width
 *  multiplier. Reduces to the per-axis `w × mult` when both are diagonal. */
export function realWidthTensor(w: Sym2, s: Sym2): Sym2 {
  const axx = s.xx * w.xx + s.xy * w.xy;
  const axy = s.xx * w.xy + s.xy * w.yy;
  const ayx = s.xy * w.xx + s.yy * w.xy;
  const ayy = s.xy * w.xy + s.yy * w.yy;
  return {
    xx: axx * s.xx + axy * s.xy,
    yy: ayx * s.xy + ayy * s.yy,
    xy: axx * s.xy + axy * s.yy,
  };
}

/**
 * Azimuth of the beam's own principal axes, measured from the beam-local +s
 * axis. Rotating Q and both readout tensors BY this angle puts the beam in the
 * frame where the per-axis model is exact.
 *
 * Taken from the REAL width tensor rather than from Q directly because it is
 * real symmetric, so `atan2` resolves the quadrant unambiguously. Returns
 * exactly 0 when there is nothing to rotate, which keeps an unrotated beam
 * bit-identical to its pre-azimuth rendering.
 */
export function principalAzimuthRad(
  q: CSym2, mult: Sym2, wavelengthNm: number,
): number {
  const isotropicMult = mult.xy === 0 && mult.xx === mult.yy;
  if (q.xy.re === 0 && q.xy.im === 0 && isotropicMult) return 0;
  const w = realWidthTensor(qWidthTensor(q, wavelengthNm), mult);
  if (w.xy === 0 && w.xx === w.yy) return 0;
  return eigSym2(w).azimuthRad;
}


/** Lab-frame beam-local (s, p) basis — the mirror of the backend's
 *  `jones.beam_local_sp`. `up` is +z, or +x for a beam running along z. */
export function beamLocalSp(
  dir: { x: number; y: number; z: number },
): { s: [number, number, number]; p: [number, number, number] } {
  const n = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d: [number, number, number] = [dir.x / n, dir.y / n, dir.z / n];
  const up: [number, number, number] = Math.abs(d[2]) > 0.999 ? [1, 0, 0] : [0, 0, 1];
  const dot = up[0] * d[0] + up[1] * d[1] + up[2] * d[2];
  const sv: [number, number, number] = [
    up[0] - d[0] * dot, up[1] - d[1] * dot, up[2] - d[2] * dot,
  ];
  const sn = Math.hypot(sv[0], sv[1], sv[2]) || 1;
  const s: [number, number, number] = [sv[0] / sn, sv[1] / sn, sv[2] / sn];
  return {
    s,
    p: [
      d[1] * s[2] - d[2] * s[1],
      d[2] * s[0] - d[0] * s[2],
      d[0] * s[1] - d[1] * s[0],
    ],
  };
}

/** The two world axes transverse to `dir`, in x < y < z order — how the beam
 *  profile labels its horizontal and vertical axes. */
export function transverseAxisLabels(
  dir: { x: number; y: number; z: number },
): [string, string] {
  const abs = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
  const propIdx = abs.indexOf(Math.max(abs[0], abs[1], abs[2]));
  const rest = ["x", "y", "z"].filter((_, i) => i !== propIdx);
  return [rest[0], rest[1]];
}

/**
 * Linear map from the beam-profile DISPLAY axes (horizontal = the world axis
 * labelled `transverse[0]`, vertical = `transverse[1]`) to the beam's own
 * (s, p) components.
 *
 * The profile used to assume a fixed 90° rotation, which is right only while
 * the beam's +s happens to be the vertical label. That holds for propagation
 * in the horizontal plane — every beam on an optical table — but not for one
 * along +z, where `beamLocalSp` switches reference axis and +s becomes the
 * HORIZONTAL label. Deriving the map removes the guess.
 */
export function displayToBeamFrame(
  dir: { x: number; y: number; z: number },
): { sFromX: number; sFromY: number; pFromX: number; pFromY: number } {
  const { s, p } = beamLocalSp(dir);
  const [h, v] = transverseAxisLabels(dir);
  const unit = (name: string): [number, number, number] => [
    name === "x" ? 1 : 0, name === "y" ? 1 : 0, name === "z" ? 1 : 0,
  ];
  const e0 = unit(h);
  const e1 = unit(v);
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return {
    sFromX: dot(e0, s), sFromY: dot(e1, s),
    pFromX: dot(e0, p), pFromY: dot(e1, p),
  };
}
