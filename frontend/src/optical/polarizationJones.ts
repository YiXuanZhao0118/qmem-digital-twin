// Polarization ↔ Jones helpers for the physics control panels.
//
// The emitter / TA polarization is stored as a 2-component complex Jones
// vector (ex, ey) expressed in the anchor's transverse (axisY, axisZ) basis
// — ex = E along axisY, ey = E along axisZ (see backend
// anchor_ops/emit_laser_source.py + jones.jones_axis_to_lab). That is the
// minimal *complete* representation (exactly the 2 transverse DOF a
// transverse wave has), and it keeps circular / elliptical states that a
// plain real [x,y,z] direction cannot express.
//
// These helpers let the UI present that complex Jones through intuitive,
// physical knobs — orientation angle θ (from axisY) and ellipticity χ —
// while the underlying storage stays the full complex Jones.

export type Jones = { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Polarization-ellipse → normalized Jones in the (axisY, axisZ) basis.
 *  @param thetaDeg orientation (azimuth) of the major axis, measured from
 *                  axisY toward axisZ.
 *  @param chiDeg   ellipticity angle ∈ [−45, 45]. 0 = linear; ±45 = circular
 *                  (sign = handedness); in-between = elliptical. */
export function jonesFromEllipse(thetaDeg: number, chiDeg: number): Jones {
  const t = thetaDeg * D2R;
  const c = chiDeg * D2R;
  const cc = Math.cos(c);
  const sc = Math.sin(c);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  return {
    exRe: cc * ct,
    exIm: -sc * st,
    eyRe: cc * st,
    eyIm: sc * ct,
  };
}

/** Jones → (orientation θ ∈ [0, 180), ellipticity χ ∈ [−45, 45]) via the
 *  Stokes parameters. Inverse of {@link jonesFromEllipse} up to the global
 *  phase / amplitude the solver normalizes away. */
export function ellipseFromJones(j: Jones): { thetaDeg: number; chiDeg: number } {
  const exRe = j.exRe ?? 0;
  const exIm = j.exIm ?? 0;
  const eyRe = j.eyRe ?? 0;
  const eyIm = j.eyIm ?? 0;
  const ex2 = exRe * exRe + exIm * exIm;
  const ey2 = eyRe * eyRe + eyIm * eyIm;
  const s0 = ex2 + ey2;
  if (s0 < 1e-12) return { thetaDeg: 0, chiDeg: 0 };
  const s1 = ex2 - ey2;
  const s2 = 2 * (exRe * eyRe + exIm * eyIm); // Re(ex* · ey)
  const s3 = 2 * (exRe * eyIm - exIm * eyRe); // Im(ex* · ey)
  let theta = 0.5 * Math.atan2(s2, s1) * R2D;
  if (theta < 0) theta += 180;
  const chi = 0.5 * Math.asin(Math.max(-1, Math.min(1, s3 / s0))) * R2D;
  return { thetaDeg: theta, chiDeg: chi };
}

const INV2 = 1 / Math.SQRT2;

/** Common named polarization states (in the axisY/axisZ basis):
 *  H = linear ∥ axisY, V = linear ∥ axisZ, ±45 = diagonal, R/LCP = circular. */
export const POLARIZATION_PRESETS: Record<string, Jones> = {
  H: { exRe: 1, exIm: 0, eyRe: 0, eyIm: 0 },
  V: { exRe: 0, exIm: 0, eyRe: 1, eyIm: 0 },
  "+45": { exRe: INV2, exIm: 0, eyRe: INV2, eyIm: 0 },
  "-45": { exRe: INV2, exIm: 0, eyRe: -INV2, eyIm: 0 },
  RCP: { exRe: INV2, exIm: 0, eyRe: 0, eyIm: INV2 },
  LCP: { exRe: INV2, exIm: 0, eyRe: 0, eyIm: -INV2 },
};

/** Name of the matching preset, or "custom" when the Jones is something else. */
export function detectPreset(j: Jones, tol = 1e-3): string {
  const close = (a?: number, b?: number) => Math.abs((a ?? 0) - (b ?? 0)) < tol;
  for (const [name, p] of Object.entries(POLARIZATION_PRESETS)) {
    if (
      close(j.exRe, p.exRe) && close(j.exIm, p.exIm)
      && close(j.eyRe, p.eyRe) && close(j.eyIm, p.eyIm)
    ) {
      return name;
    }
  }
  return "custom";
}
