import { definePhysicsPlugin } from "../_plugin";

export interface WavemeterParams extends Record<string, unknown> {
  precisionMhz: number;
}

export const wavemeterPlugin = definePhysicsPlugin<WavemeterParams>({
  id: "wavemeter",
  displayName: "Wavemeter",
  componentTypes: ["wavemeter"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "wavemeter",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: [],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Input port (intercept_in) translates to beam.",
    defaultParams: { precisionMhz: 1.0 },
  },
});
