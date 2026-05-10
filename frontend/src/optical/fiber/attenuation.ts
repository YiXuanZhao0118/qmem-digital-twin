/**
 * Wavelength-dependent fiber attenuation. Stored as a sample list
 * { wavelength_nm, db_per_km } and linearly interpolated; values
 * outside the sampled range are clamped to the nearest endpoint.
 */

import type { FiberAttenuationPoint } from "../../types/digitalTwin";

/** Linear-interpolated dB/km at the given wavelength.
 *  Clamps to endpoints if lambda is outside the sampled range. */
export function attenuationDbPerKm(
  curve: FiberAttenuationPoint[],
  lambdaNm: number,
): number {
  if (curve.length === 0) return 0;
  if (curve.length === 1) return curve[0].dbPerKm;
  const sorted = [...curve].sort((a, b) => a.wavelengthNm - b.wavelengthNm);
  if (lambdaNm <= sorted[0].wavelengthNm) return sorted[0].dbPerKm;
  if (lambdaNm >= sorted[sorted.length - 1].wavelengthNm) {
    return sorted[sorted.length - 1].dbPerKm;
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (lambdaNm >= a.wavelengthNm && lambdaNm <= b.wavelengthNm) {
      const t = (lambdaNm - a.wavelengthNm) / (b.wavelengthNm - a.wavelengthNm);
      return a.dbPerKm + t * (b.dbPerKm - a.dbPerKm);
    }
  }
  return 0;
}

/** Power transmittance for a length L_arc (mm) of fiber at λ. */
export function attenuationTransmittance(
  curve: FiberAttenuationPoint[],
  lambdaNm: number,
  arcLengthMm: number,
): number {
  const dbPerKm = attenuationDbPerKm(curve, lambdaNm);
  const totalDb = (dbPerKm * arcLengthMm) / 1e6; // mm → km
  return Math.pow(10, -totalDb / 10);
}
