import { definePhysicsPlugin } from "../_plugin";

export interface BeamSplitterParams extends Record<string, unknown> {
  polarizing: boolean;
  transmissionAxisDegBeamLocal: number;
  coatingNormalBodyLocal: [number, number, number];
  wavelengthRangeNm: [number, number];
  // Optional Glan-Laser / calcite air-gap polarizer model. This kind's op
  // (anchor_ops/pbs.py, shared by `pbs` + `beam_splitter`) reads `lengthMm`
  // and `refractiveIndex_o`; the legacy glan_laser physics also reads
  // `refractiveIndex_e`. The remaining geometry/extinction fields describe a
  // real Glan-Laser prism (the IO-3/IO-5 isolator internals). A plain PBS
  // cube leaves these blank. Declared optional so prism assets correspond to
  // the kind without forcing the calcite model onto every beam splitter.
  lengthMm?: number;
  refractiveIndex_o?: number;
  refractiveIndex_e?: number;
  airGapAngleDeg?: number;
  airGapThicknessMm?: number;
  B_x_mm?: number;
  B_y_mm?: number;
  E_x_offset_coef?: number;
  extinctionRatioPpDb?: number;
  extinctionRatioSpDb?: number;
  transmissionAxisDegBodyLocal?: number;
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
    // Suggested Glan-Laser calcite values (IO-5-850-HP, L=7.5mm prism).
    optionalParams: {
      lengthMm: 7.5,
      refractiveIndex_o: 1.66,
      refractiveIndex_e: 1.48,
      airGapAngleDeg: 38.5,
      airGapThicknessMm: 0.15,
      B_x_mm: 5.53,
      B_y_mm: 5.07,
      E_x_offset_coef: 4.07,
      extinctionRatioPpDb: 100000,
      extinctionRatioSpDb: 30,
      transmissionAxisDegBodyLocal: 0,
    },
  },
});
