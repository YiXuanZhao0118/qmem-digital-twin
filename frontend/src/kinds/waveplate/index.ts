import { definePhysicsPlugin } from "../_plugin";

export interface WaveplateParams extends Record<string, unknown> {
  retardanceLambda: number;
  retardanceDeg?: number;
  transmission: number;
  designWavelengthNm?: number;
  wavelengthRangeNm: [number, number];
  lengthMm?: number;
  thicknessMm?: number;
  refractiveIndex?: number;
  clearApertureMm?: number;
  plateAlphaXRad?: number;
  plateAlphaYRad?: number;
  material?: string;
  plateType?: string;
}

export const waveplatePlugin = definePhysicsPlugin<WaveplateParams>({
  id: "waveplate",
  displayName: "Waveplate",
  componentTypes: ["waveplate"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "waveplate",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: ["intercept_in"],
      needsAperture: ["intercept_in"],
      needsFastAxis: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Pick the flat face on the wireframe (sets intercept_in position). Asset-level fast-axis angle is set in PHY Editor → Optical → Components on the intercept_in anchor (fastAxisDegBodyLocal). Per-instance rotation around the beam axis is set in the Object panel.",
    defaultParams: {
      retardanceLambda: 0.5,
      transmission: 0.99,
      wavelengthRangeNm: [400, 1100],
    },
    intrinsicParamKeys: [
      "retardanceLambda",
      "retardanceDeg",
      "transmission",
      "designWavelengthNm",
      "wavelengthRangeNm",
      "lengthMm",
      "thicknessMm",
      "refractiveIndex",
      "clearApertureMm",
      "plateAlphaXRad",
      "plateAlphaYRad",
      "material",
      "plateType",
    ],
    stateParamKeys: [],
    portDomains: { intercept_in: "optical" },
  },
});
