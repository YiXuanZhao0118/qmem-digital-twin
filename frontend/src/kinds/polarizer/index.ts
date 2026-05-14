import { definePhysicsPlugin } from "../_plugin";

export interface PolarizerParams extends Record<string, unknown> {
  transmissionAxisDegBeamLocal: number;
  extinctionRatioDb: number;
  transmission: number;
}

export const polarizerPlugin = definePhysicsPlugin<PolarizerParams>({
  id: "polarizer",
  displayName: "Polarizer",
  componentTypes: ["polarizer"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "polarizer",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: [],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam axis. Translation only.",
    defaultParams: {
      transmissionAxisDegBeamLocal: 0.0,
      extinctionRatioDb: 30.0,
      transmission: 0.95,
    },
  },
});
