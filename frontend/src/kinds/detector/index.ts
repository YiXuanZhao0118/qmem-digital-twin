import { definePhysicsPlugin } from "../_plugin";

export interface DetectorParams extends Record<string, unknown> {
  responsivityAPerW: number;
  quantumEfficiency: number;
  bandwidthMhz: number;
  saturationPowerMw: number;
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
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Active area centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: {
      responsivityAPerW: 0.5,
      quantumEfficiency: 0.8,
      bandwidthMhz: 1000.0,
      saturationPowerMw: 10.0,
    },
  },
});
