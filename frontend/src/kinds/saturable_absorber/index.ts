import { definePhysicsPlugin } from "../_plugin";

export interface SaturableAbsorberParams extends Record<string, unknown> {
  saturationIntensityWPerCm2: number;
  modulationDepth: number;
  nonSaturableLoss: number;
  recoveryTimePs: number;
  wavelengthRangeNm: [number, number];
}

export const saturableAbsorberPlugin = definePhysicsPlugin<SaturableAbsorberParams>({
  id: "saturable_absorber",
  displayName: "Saturable Absorber",
  componentTypes: ["saturable_absorber"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "saturable_absorber",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: [],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam axis.",
    defaultParams: {
      saturationIntensityWPerCm2: 1e6,
      modulationDepth: 0.5,
      nonSaturableLoss: 0.05,
      recoveryTimePs: 1.0,
      wavelengthRangeNm: [400, 1700],
    },
  },
});
