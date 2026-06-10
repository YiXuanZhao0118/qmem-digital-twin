/**
 * Faraday Rotator — non-reciprocal polarization rotator (e.g. the TGG rod
 * inside a high-power optical isolator).
 *
 * Single-anchor kind: `optical_center` marks the rod's optical axis pivot.
 * The beam passes straight through (slab q-propagation, B = L/n) and its
 * polarization rotates by `rotationDeg` in a FIXED absolute direction set
 * by the magnet — regardless of travel direction. A round trip therefore
 * accumulates 2×rotationDeg (not 0°, unlike a waveplate), which is what
 * makes a 45° rotator + crossed polarizer block back-reflections.
 *
 * The anchor contract mirrors the DB Kind row (optical_center, needs
 * aperture + direction). Without this plugin the PHY Editor's ASSET3D
 * panel can't resolve `pluginForKind("faraday_rotator")`, so it disables
 * the per-anchor aperture / axis fields for every faraday rod asset.
 *
 * Physics op lives in `optical/kinds/faraday-rotator/physics.ts` (frontend)
 * and `backend/app/optical/kinds/faraday_rotator/physics.py` (backend).
 */
import { definePhysicsPlugin } from "../_plugin";

export interface FaradayRotatorParams extends Record<string, unknown> {
  rotationDeg: number;
  lengthMm: number;
  refractiveIndex: number;
  wavelengthRangeNm: [number, number];
}

export const faradayRotatorPlugin = definePhysicsPlugin<FaradayRotatorParams>({
  id: "faraday_rotator",
  displayName: "Faraday Rotator",
  componentTypes: ["faraday_rotator"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "faraday_rotator",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["optical_center"],
      optional: [],
      needsDirection: ["optical_center"],
      needsAperture: ["optical_center"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "optical_center translates to beam axis. Translation only.",
    defaultParams: {
      rotationDeg: 45,
      lengthMm: 18,
      refractiveIndex: 1.95,
      wavelengthRangeNm: [400, 1100],
    },
    portDomains: { optical_center: "optical" },
  },
});
