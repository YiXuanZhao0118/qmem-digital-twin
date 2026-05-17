import { definePhysicsPlugin } from "../_plugin";

export interface EomParams extends Record<string, unknown> {
  vPiV: number;
  modulationKind: "phase" | "amplitude";
  modulationBandwidthMhz: number;
  insertionLossDb: number;
  wavelengthRangeNm: [number, number];
}

export const eomPlugin = definePhysicsPlugin<EomParams>({
  id: "eom",
  displayName: "EOM",
  componentTypes: ["eom"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "eom",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "rf"],
    anchors: {
      required: ["intercept_in"],
      optional: ["intercept_out"],
      needsDirection: [],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam. Translation only.",
    defaultParams: {
      vPiV: 5.0,
      modulationKind: "phase",
      modulationBandwidthMhz: 100.0,
      insertionLossDb: 3.0,
      wavelengthRangeNm: [400, 1700],
    },
  },
});
