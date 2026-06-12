/**
 * Aperture energy clipping per beam cross-section profile.
 *
 * Returns the fraction (0..1) of a beam's power that survives a circular
 * aperture of radius `apertureMm`, given the beam-center-to-aperture-center
 * offset `rCMm`. Strategy-per-profile so the tracer doesn't hardcode a
 * Gaussian (see BeamProfile in beam-ray.ts):
 *   - ray:      binary (centre inside ⇒ 1, else 0)
 *   - top_hat:  circle∩circle overlap area / beam area
 *   - gaussian: integrated Gaussian through a circular aperture; exact
 *               on-axis (1 − exp(−2a²/w²)), and the decentred case is a
 *               knife-edge APPROXIMATION on the nearest aperture rim (the
 *               decentred Gaussian-through-circular integral has no closed
 *               form). Must stay in lock-step with the backend mirror
 *               gaussian_circular_aperture_fraction (aperture.py).
 *
 * The Gaussian width is derived from the existing astigmatic qx/qy (not a
 * separate single-q), using an area-equivalent effective radius
 * w_eff = sqrt(wx·wy).
 */

import type { BeamProfile } from "./beam-ray";
import type { Complex } from "./fiber/gaussian";

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Gaussian 1/e² field radius w from a q-parameter:
 *  1/q = 1/R − i·λ/(π·w²)  ⇒  w² = λ·|q|² / (π·Im(q)). Returns 0 for a
 *  degenerate / non-physical q (Im ≤ 0). */
export function gaussianWidthMm(q: Complex, lambdaMm: number): number {
  const absSq = q.re * q.re + q.im * q.im;
  if (absSq < 1e-30 || q.im <= 0) return 0;
  const wSq = (lambdaMm * absSq) / (Math.PI * q.im);
  return Math.sqrt(Math.max(wSq, 0));
}

/** Power transmission (0..1) of a beam through a circular aperture. */
export function calculateProfileClipping(
  rCMm: number,
  apertureMm: number,
  profile: BeamProfile | undefined,
  qx: Complex,
  qy: Complex,
  wavelengthNm: number,
): number {
  const a = apertureMm;
  const rC = Math.max(rCMm, 0);
  const kind = profile?.kind ?? "gaussian";

  // ---- ray: ideal geometric line — centre in/out is all-or-nothing ----
  if (kind === "ray") {
    return rC <= a ? 1 : 0;
  }

  // ---- top_hat: uniform disc of radius rB; overlap-area fraction ----
  if (kind === "top_hat") {
    const rB = profile && profile.kind === "top_hat" ? profile.radiusMm : 0;
    if (rB <= 1e-12) return rC <= a ? 1 : 0; // degenerate ⇒ ray-like
    if (rC + rB <= a) return 1; // disc fully inside aperture
    if (rC >= a + rB) return 0; // disc fully outside aperture
    if (rC <= 1e-12) {
      // Concentric and (since the fully-inside case is handled above)
      // the disc is larger than the aperture ⇒ area ratio.
      return clamp01((a * a) / (rB * rB));
    }
    // General two-circle lens area, normalised by the beam disc area.
    const d = rC;
    const ac1 = Math.acos(clamp((d * d + rB * rB - a * a) / (2 * d * rB), -1, 1));
    const ac2 = Math.acos(clamp((d * d + a * a - rB * rB) / (2 * d * a), -1, 1));
    const tri = 0.5 * Math.sqrt(
      Math.max(0, (-d + rB + a) * (d + rB - a) * (d - rB + a) * (d + rB + a)),
    );
    const overlap = rB * rB * ac1 + a * a * ac2 - tri;
    return clamp01(overlap / (Math.PI * rB * rB));
  }

  // ---- gaussian: effective width from qx/qy ----
  const wEff = Math.sqrt(
    Math.max(gaussianWidthMm(qx, wavelengthNm * 1e-6) * gaussianWidthMm(qy, wavelengthNm * 1e-6), 0),
  );
  if (wEff < 1e-12) return rC <= a ? 1 : 0; // no usable width ⇒ treat as ray
  if (rC <= 1e-12) {
    return clamp01(1 - Math.exp((-2 * a * a) / (wEff * wEff)));
  }
  // Decentred beam: clip by the NEAREST aperture edge, modelled as a
  // straight knife-edge at signed distance s = a − rC from the beam centre.
  // T = ½·(1 + erf(√2·s/w)). Correct in the w≪a regime of real lenses: a
  // beam fully inside but off-centre (a − rC ≫ w) passes ~100%, T = ½ at the
  // rim (rC = a), → 0 once the centre sits a few w outside. The previous
  // exp(−2·rC²/w²) factor modelled a pinhole at the offset and wrongly zeroed
  // a contained off-centre beam. (Near-edge clip only — for w ≳ a the far rim
  // also vignettes, not modelled.) Must match backend gaussian_circular_
  // aperture_fraction (aperture.py).
  if (rC > a + 3 * wEff) return 0; // beam centre well outside aperture
  const s = a - rC;
  return clamp01(0.5 * (1 + erf((Math.SQRT2 * s) / wEff)));
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Gauss error function — Abramowitz & Stegun 7.1.26 (max abs error ≈1.5e-7),
 *  enough for the knife-edge aperture approximation. JS has no Math.erf. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
