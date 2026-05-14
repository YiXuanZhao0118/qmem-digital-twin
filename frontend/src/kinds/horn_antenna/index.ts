import { definePhysicsPlugin } from "../_plugin";

export interface HornAntennaParams extends Record<string, unknown> {
  frequencyGhz: number;
  gainDbi: number;
  beamwidth3dbDeg: number;
  polarAxisBodyLocal: [number, number, number];
  cosineExponent: number;
}

export const hornAntennaPlugin = definePhysicsPlugin<HornAntennaParams>({
  id: "horn_antenna",
  displayName: "Horn Antenna",
  componentTypes: ["horn_antenna"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "horn_antenna",
    primaryDomain: "rf",
    defaultPhysics: ["rf", "em"],
    anchors: {
      required: [],
      optional: ["aperture"],
      needsDirection: ["aperture"],
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "Microwave horn / antenna — radiates the chain output along its polar axis (+Z body-local by default). Phase RF.7 renders a parametric cos^n radiation lobe; palace farfield can populate a real pattern later.",
    defaultParams: {
      frequencyGhz: 9.2,
      gainDbi: 12.0,
      beamwidth3dbDeg: 30.0,
      polarAxisBodyLocal: [0, 0, 1],
      cosineExponent: 8.0,
    },
  },
});
