import { definePhysicsPlugin } from "../_plugin";

export interface BeamSplitterParams extends Record<string, unknown> {
  splitRatioTransmitted: number;
  polarizing: boolean;
  transmissionAxisDegBeamLocal: number;
  extinctionRatioDb: number;
  transmission: number;
  coatingNormalBodyLocal: [number, number, number];
}

export const beamSplitterPlugin = definePhysicsPlugin<BeamSplitterParams>({
  id: "beam_splitter",
  displayName: "Beam Splitter",
  componentTypes: ["beam_splitter"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "beam_splitter",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: ["intercept_out"],
      needsDirection: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Cube of two right-angle prisms cemented along the diagonal. intercept_in marks that diagonal interface: position = cube centre, direction = coating normal (along ±(X±Y) / ±(X±Z) / ±(Y±Z) for face-aligned cubes), aperture = half the active interface size. PBS vs BS distinguished by Component.properties.beamSplitterType (Phase 2 schema).",
    defaultParams: {
      splitRatioTransmitted: 0.5,
      polarizing: false,
      transmissionAxisDegBeamLocal: 0.0,
      extinctionRatioDb: 30.0,
      transmission: 0.99,
      coatingNormalBodyLocal: [0.7071067811865475, 0.7071067811865475, 0],
    },
  },
});
