import { definePhysicsPlugin } from "../_plugin";

export interface SpectrometerParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

export const spectrometerPlugin = definePhysicsPlugin<SpectrometerParams>({
  id: "spectrometer",
  displayName: "Spectrometer",
  componentTypes: ["spectrometer"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "spectrometer",
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
    alignSummary: "Slit/fiber input (intercept_in) translates to beam.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
