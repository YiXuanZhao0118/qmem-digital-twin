/**
 * Fresnel transmission/reflection coefficients at a dielectric interface.
 * Real refractive indices, no absorption. Handles arbitrary angle of
 * incidence and arbitrary linear polarization (decomposed into s and p
 * components in the plane of incidence). Total internal reflection
 * (above the critical angle) returns R=1.
 *
 * Convention:
 *   θ_i = angle of incidence in medium 1 (n_1), measured from interface normal.
 *   θ_t = angle of transmission in medium 2 (n_2), via Snell n_1 sinθ_i = n_2 sinθ_t.
 *   χ   = polarization angle in beam frame; χ=0 means E perpendicular to plane
 *         of incidence (s-polarized), χ=π/2 means E in the plane (p-polarized).
 */

export type FresnelInputs = {
  /** Angle of incidence (rad), 0 = normal incidence. */
  thetaIRad: number;
  /** Refractive index of incident medium. */
  n1: number;
  /** Refractive index of transmitting medium. */
  n2: number;
  /** Polarization angle (rad) in beam frame; 0 = s, π/2 = p. */
  chiRad: number;
  /** Multiplier on R(θ): 1 = no AR coating, ~0.15 = typical AR, 0 = perfect AR.
   *  Applied AFTER the Fresnel formula so the angular and polarization
   *  dependence stays correct. */
  arResidual?: number;
};

export type FresnelResult = {
  /** Total reflectance (energy-fraction reflected). */
  reflectance: number;
  /** Total transmittance = 1 − reflectance (energy-fraction transmitted,
   *  not amplitude). */
  transmittance: number;
  /** Reflectance for s-polarization alone. */
  rS: number;
  /** Reflectance for p-polarization alone. */
  rP: number;
  /** True if total internal reflection (Snell beyond critical angle). */
  totalInternalReflection: boolean;
};

export function fresnelReflectance({
  thetaIRad,
  n1,
  n2,
  chiRad,
  arResidual = 1.0,
}: FresnelInputs): FresnelResult {
  const sinI = Math.sin(thetaIRad);
  const cosI = Math.cos(thetaIRad);
  // Snell: n1 sinθ_i = n2 sinθ_t
  const sinT = (n1 / n2) * sinI;
  if (sinT >= 1.0) {
    // Total internal reflection
    return {
      reflectance: 1.0,
      transmittance: 0.0,
      rS: 1.0,
      rP: 1.0,
      totalInternalReflection: true,
    };
  }
  const cosT = Math.sqrt(1 - sinT * sinT);
  // Fresnel amplitude reflection coefficients
  const rsAmp = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rpAmp = (n2 * cosI - n1 * cosT) / (n2 * cosI + n1 * cosT);
  const rS = rsAmp * rsAmp;
  const rP = rpAmp * rpAmp;
  // Power-fraction in each polarization component, summed
  const cosChi2 = Math.cos(chiRad) ** 2;
  const sinChi2 = 1 - cosChi2;
  const rTotal = rS * cosChi2 + rP * sinChi2;
  const reflectance = Math.max(0, Math.min(1, rTotal * arResidual));
  return {
    reflectance,
    transmittance: 1 - reflectance,
    rS,
    rP,
    totalInternalReflection: false,
  };
}

/** Brewster angle (θ_p = 0 angle) for n1 → n2 interface.
 *  tan(θ_B) = n2/n1. */
export function brewsterAngleRad(n1: number, n2: number): number {
  return Math.atan2(n2, n1);
}

/** Critical angle for total internal reflection (only meaningful when
 *  n1 > n2). sin(θ_c) = n2/n1. */
export function criticalAngleRad(n1: number, n2: number): number {
  if (n1 <= n2) return Math.PI / 2;
  return Math.asin(n2 / n1);
}
