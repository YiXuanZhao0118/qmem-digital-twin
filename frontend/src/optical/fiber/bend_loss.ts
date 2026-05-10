/**
 * Macro-bend loss using a simplified Marcuse curvature-loss model.
 *
 * The full Marcuse 1976 formula has many fiber-dependent constants
 * (κ, β, V, W). For a digital-twin simulator we expose those as
 * BendLossConstants and integrate α_bend(R(s)) along the spline:
 *
 *     α_bend(R) ≈ A · exp(−B·R/R_crit) / sqrt(R)
 *
 * with A, B chosen so that α(R_crit) = 0.1 dB/m (the standard "critical
 * bend radius" definition) and α(2·R_crit) ≈ 0.01 dB/m. The asymptotic
 * exponential decay matches the W^3 R term in the full formula.
 *
 * For a more rigorous treatment when fiber-specific data is available,
 * users can override `evaluateAlphaPerMeter` directly.
 */

import type { BendLossConstants } from "../../types/digitalTwin";

/** Loss coefficient α (dB/m) at bend radius R (mm).
 *  Returns 0 for R = ∞ (straight). */
export function alphaDbPerMeter(
  bendRadiusMm: number,
  bendLoss: BendLossConstants,
): number {
  if (!Number.isFinite(bendRadiusMm) || bendRadiusMm > 1e6) return 0;
  if (bendRadiusMm <= 0) return Number.POSITIVE_INFINITY;
  const Rcrit = bendLoss.criticalRadiusMm;
  // Calibrate: α(Rcrit) = 0.1 dB/m, α(2·Rcrit) = 0.01 dB/m
  // Form: α(R) = A · exp(−B·R/Rcrit) / sqrt(R/Rcrit)
  // Solve B from ratio: 0.1/0.01 = exp(B)·sqrt(2) ⇒ B = ln(10/sqrt(2)) ≈ 1.957
  const B = Math.log(10 / Math.SQRT2);
  // A from boundary: 0.1 = A · exp(−B) / 1 ⇒ A = 0.1·exp(B)
  const A = 0.1 * Math.exp(B);
  const r = bendRadiusMm / Rcrit;
  return (A * Math.exp(-B * r)) / Math.sqrt(r);
}

/**
 * Integrate accumulated bend loss along a parametric curve. The curve
 * is sampled at `samples` equally-spaced t in [0, 1]; the curvature
 * radius at each sample is evaluated by the caller (curvature(t) →
 * radius in mm). Returns total loss in nepers (natural log).
 *
 * Output: P_out = P_in · exp(−lossNeper).
 */
export function integrateBendLossNeper(
  curvatureRadiusMm: (t: number) => number,
  arcLengthMm: number,
  bendLoss: BendLossConstants,
  samples = 64,
): number {
  // dB/m → nepers/m: 1 dB = (ln 10)/10 Np = 0.2303 Np
  const dbToNp = Math.log(10) / 10;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = (i + 0.5) / samples;
    const R = curvatureRadiusMm(t);
    sum += alphaDbPerMeter(R, bendLoss);
  }
  const meanAlphaDbPerM = sum / samples;
  // arc in meters
  const arcM = arcLengthMm / 1000;
  return meanAlphaDbPerM * arcM * dbToNp;
}

/** Bend-loss transmittance fraction. η_bend = exp(−neper). */
export function bendLossTransmittance(
  curvatureRadiusMm: (t: number) => number,
  arcLengthMm: number,
  bendLoss: BendLossConstants,
  samples = 64,
): number {
  const np = integrateBendLossNeper(curvatureRadiusMm, arcLengthMm, bendLoss, samples);
  return Math.exp(-np);
}
