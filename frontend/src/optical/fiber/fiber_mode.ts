/**
 * Fiber mode profiles. LP01 (= HE11, fundamental SM/PM mode) is the
 * dominant case for SM/PM coupling; we use the Marcuse Gaussian
 * approximation w_f = MFD/2 when the fiber's V-number > 1.5 (error
 * < 1% which is well below experimental coupling repeatability).
 *
 * For exact treatment (V<1.5 or wide-NA fibers), the LP01 field has
 * Bessel-J inside the core and modified-Bessel-K outside; we expose
 * `lp01ExactRadial` so the numerical-overlap path can use it.
 *
 * For MM, supported LP_lm modes have V_lm cutoffs determined by
 * J_l−1's roots. We enumerate them up to the fiber's V-number.
 */

import { besselJ0, besselJ, besselK, besselJ0Roots, besselJRoots } from "./bessel";

/** Gaussian-approximated LP01 field amplitude E(r). Real-valued (mode
 *  is bound, no oscillating phase across r). Normalized to peak=1. */
export function lp01GaussianRadial(rM: number, mfdM: number): number {
  const wF = mfdM / 2;
  return Math.exp(-(rM * rM) / (wF * wF));
}

/** Exact LP01 radial profile for step-index fiber.
 *  Inside core (r < a): J_0(u·r/a) / J_0(u)
 *  Outside (r > a):    K_0(w·r/a) / K_0(w)
 *  with u² + w² = V², transcendental matching at r=a.
 */
export function lp01ExactRadial(
  rM: number,
  coreRadiusM: number,
  vNumber: number,
): number {
  const uw = solveLP01UW(vNumber);
  if (rM <= coreRadiusM) {
    return besselJ0((uw.u * rM) / coreRadiusM) / besselJ0(uw.u);
  }
  return besselK(0, (uw.w * rM) / coreRadiusM) / besselK(0, uw.w);
}

/** Solve for u, w in LP01 dispersion: u·J_1(u)/J_0(u) = w·K_1(w)/K_0(w),
 *  u² + w² = V². Bisection on u ∈ (0, min(V, π)). */
function solveLP01UW(vNumber: number): { u: number; w: number } {
  if (vNumber < 1e-3) return { u: 0, w: 0 };
  // For LP01 dispersion: f(u) = u·J_1(u)·K_0(w) − w·K_1(w)·J_0(u), w = sqrt(V² − u²)
  const f = (u: number): number => {
    const w = Math.sqrt(Math.max(vNumber * vNumber - u * u, 1e-18));
    return u * besselJ(1, u) * besselK(0, w) - w * besselK(1, w) * besselJ0(u);
  };
  let lo = 1e-4;
  let hi = Math.min(vNumber - 1e-4, Math.PI - 1e-4);
  // Walk hi down until f(lo)*f(hi) < 0
  let fLo = f(lo);
  let fHi = f(hi);
  if (fLo * fHi > 0) {
    // Fallback: weakly-guided approximation, u ≈ V·exp(-1/V²)
    const u = vNumber * Math.exp(-1 / Math.max(vNumber * vNumber, 1e-3));
    const w = Math.sqrt(Math.max(vNumber * vNumber - u * u, 1e-12));
    return { u, w };
  }
  for (let i = 0; i < 80; i += 1) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm * fLo < 0) {
      hi = mid;
      fHi = fm;
    } else {
      lo = mid;
      fLo = fm;
    }
    if (hi - lo < 1e-10) break;
  }
  const u = 0.5 * (lo + hi);
  const w = Math.sqrt(Math.max(vNumber * vNumber - u * u, 0));
  return { u, w };
}

export type LpModeId = { l: number; m: number };

/** Enumerate LP_lm modes supported by a step-index fiber with given V.
 *  Cutoff for LP_lm: V_lm is the m-th positive root of J_{l-1}(x) = 0
 *  (with V_01 = 0 by convention — LP01 is always supported above V=0).
 *  Returns modes with V_lm < V_fiber. */
export function enumerateSupportedLpModes(vNumber: number): LpModeId[] {
  const out: LpModeId[] = [{ l: 0, m: 1 }]; // LP01 always
  // For each l, find m-th root of J_{l-1}(x) = 0
  for (let l = 0; l <= 20; l += 1) {
    const roots = l === 0 ? besselJ0Roots(20) : besselJRoots(l - 1, 20);
    // For LP_0m (l=0), the cutoffs are roots of J_{-1}(x)=−J_1(x) which
    // are roots of J_1, except m=1 where cutoff = 0.
    // For LP_lm with l ≥ 1, cutoffs are roots of J_{l-1}(x).
    for (let m = l === 0 ? 2 : 1; m <= roots.length; m += 1) {
      const vLm = l === 0 ? besselJRoots(1, m)[m - 1] : roots[m - 1];
      if (vLm < vNumber) {
        out.push({ l, m });
      } else {
        break;
      }
    }
  }
  return out;
}

/** Total number of polarization-degenerate modes supported (each LP_lm
 *  with l > 0 carries 2 orientations × 2 polarizations = 4 modes;
 *  l=0 carries 2 polarizations = 2 modes). For V > 2.4, ≈ V²/2. */
export function modeCountFromV(vNumber: number): number {
  const modes = enumerateSupportedLpModes(vNumber);
  let total = 0;
  for (const m of modes) total += m.l === 0 ? 2 : 4;
  return total;
}

/** Field amplitude of LP_lm at (r, φ). Two orthogonal orientations
 *  exist for l > 0 (cos(lφ) and sin(lφ)); we return cos for kind="cos". */
export function lpFieldRadialAzimuthal(
  rM: number,
  phiRad: number,
  l: number,
  m: number,
  coreRadiusM: number,
  vNumber: number,
  kind: "cos" | "sin" = "cos",
): number {
  // Solve dispersion for this LP_lm. For LP01 use solveLP01UW; for higher
  // modes, similar transcendental: u·J_{l-1}(u)/J_l(u) = w·K_{l-1}(w)/K_l(w)
  // with u² + w² = V². Approximated bisection (good enough for v1 since
  // the closed-form HG/LG paths are the primary use case; this function
  // is used by the numerical overlap fallback only).
  const uw = solveLPlmUW(l, m, vNumber);
  let radial: number;
  if (rM <= coreRadiusM) {
    radial = besselJ(l, (uw.u * rM) / coreRadiusM) / besselJ(l, uw.u);
  } else {
    radial = besselK(l, (uw.w * rM) / coreRadiusM) / besselK(l, uw.w);
  }
  const azimuthal = kind === "cos" ? Math.cos(l * phiRad) : Math.sin(l * phiRad);
  return radial * azimuthal;
}

function solveLPlmUW(l: number, m: number, vNumber: number): { u: number; w: number } {
  if (l === 0 && m === 1) return solveLP01UW(vNumber);
  const cutoff =
    l === 0
      ? besselJRoots(1, m)[m - 1]
      : besselJRoots(l - 1, m)[m - 1];
  if (vNumber <= cutoff + 1e-6) return { u: vNumber, w: 0 };
  const f = (u: number): number => {
    const w = Math.sqrt(Math.max(vNumber * vNumber - u * u, 1e-18));
    if (w < 1e-9) return 1e9;
    return (
      u * besselJ(l + 1, u) * besselK(l, w) -
      w * besselK(l + 1, w) * besselJ(l, u)
    );
  };
  // Bracket: u ∈ (cutoff_prev, cutoff]; we use (max(cutoff_prev, 0.01), V]
  let lo = cutoff + 1e-3;
  let hi = vNumber - 1e-4;
  if (lo >= hi) return { u: vNumber, w: 0 };
  let fLo = f(lo);
  let fHi = f(hi);
  if (fLo * fHi > 0) {
    return { u: 0.5 * (lo + hi), w: Math.sqrt(Math.max(vNumber * vNumber - 0.25 * (lo + hi) ** 2, 0)) };
  }
  for (let i = 0; i < 60; i += 1) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm * fLo < 0) {
      hi = mid;
      fHi = fm;
    } else {
      lo = mid;
      fLo = fm;
    }
    if (hi - lo < 1e-9) break;
  }
  const u = 0.5 * (lo + hi);
  const w = Math.sqrt(Math.max(vNumber * vNumber - u * u, 0));
  return { u, w };
}

/** Compute V-number for a step-index fiber. */
export function computeVNumber(
  coreRadiusM: number,
  nCore: number,
  nClad: number,
  lambdaM: number,
): number {
  const na = Math.sqrt(Math.max(nCore * nCore - nClad * nClad, 0));
  return ((2 * Math.PI * coreRadiusM) / lambdaM) * na;
}
