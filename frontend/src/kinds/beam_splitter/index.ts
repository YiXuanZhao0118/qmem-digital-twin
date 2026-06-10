import { definePhysicsPlugin } from "../_plugin";

export interface BeamSplitterParams extends Record<string, unknown> {
  polarizing: boolean;
  transmissionAxisDegBeamLocal: number;
  coatingNormalBodyLocal: [number, number, number];
  wavelengthRangeNm: [number, number];
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
      needsAperture: ["intercept_in"],
      // s/p polarization basis at the coating — transverse reference
      // edited as axisY. Relevant for PBS (beamSplitterType="pbs").
      needsFastAxis: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Cube of two right-angle prisms cemented along the diagonal. intercept_in marks that diagonal interface: position = cube centre, direction = coating normal (along ±(X±Y) / ±(X±Z) / ±(Y±Z) for face-aligned cubes), aperture = half the active interface size. PBS vs BS distinguished by Component.properties.beamSplitterType (Phase 2 schema).",
    defaultParams: {
      polarizing: false,
      transmissionAxisDegBeamLocal: 0.0,
      coatingNormalBodyLocal: [0.7071067811865475, 0.7071067811865475, 0],
      wavelengthRangeNm: [400, 1100],
    },
  },
});
