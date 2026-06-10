import { definePhysicsPlugin } from "../_plugin";

export interface DetectorParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

export const detectorPlugin = definePhysicsPlugin<DetectorParams>({
  id: "detector",
  displayName: "Detector",
  componentTypes: ["detector"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "detector",
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
    alignSummary: "Active area centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
