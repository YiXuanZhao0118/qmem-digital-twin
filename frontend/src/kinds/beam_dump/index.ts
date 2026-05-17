import { definePhysicsPlugin } from "../_plugin";

export interface BeamDumpParams extends Record<string, unknown> {
  absorption: number;
  wavelengthRangeNm: [number, number];
}

export const beamDumpPlugin = definePhysicsPlugin<BeamDumpParams>({
  id: "beam_dump",
  displayName: "Beam Dump",
  componentTypes: ["beam_dump"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "beam_dump",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: [],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Absorbing face (intercept_in) translates to beam. Beam terminates.",
    defaultParams: { absorption: 0.999, wavelengthRangeNm: [400, 1100] },
  },
});
