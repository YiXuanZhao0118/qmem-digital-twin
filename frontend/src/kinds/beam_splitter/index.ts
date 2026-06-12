import { definePhysicsPlugin } from "../_plugin";

/**
 * beam_splitter params — EXACTLY the inputs the live optical-path op reads
 * (`backend/app/optical/anchor_ops/pbs.py`, shared by `pbs` + `beam_splitter`)
 * plus the geometry the op consumes through its anchor. Nothing the op ignores
 * is declared here: the old Glan-prism geometry fields
 * (`airGapAngleDeg` / `airGapThicknessMm` / `B_x_mm` / `B_y_mm` /
 * `E_x_offset_coef` / `transmissionAxisDegBodyLocal`) were removed — the live
 * tracer never read them (only the retired face-based TS solver did).
 */
export interface BeamSplitterParams extends Record<string, unknown> {
  /** Polarizing (PBS / Glan) vs 50:50 BS. Gates the transmission-axis
   *  (polarization-reference) binding; the op itself always splits by
   *  polarization. */
  polarizing: boolean;
  /** Transmission (p / e-ray) axis, degrees, beam-local at the cut interface —
   *  seeds the intercept_face anchor's fast axis (the s/p reference). */
  transmissionAxisDegBeamLocal: number;
  /** Cut / coating-plane normal, body-local = the intercept_face anchor axisX
   *  the op reflects the rejected (s/o-ray) branch about. */
  coatingNormalBodyLocal: [number, number, number];
  /** Slab length along the beam (mm). Op ABCD B = L/n per branch. */
  lengthMm: number;
  /** Reflected ORDINARY-ray slab index (op reflect branch). */
  refractiveIndex_o: number;
  /** Transmitted EXTRAORDINARY-ray slab index (op transmit branch). */
  refractiveIndex_e: number;
  /** Transmitted (P) port extinction ratio, dB. 100000:1 = 50 dB. */
  extinctionRatioPpDb: number;
  /** Reflected (S) port extinction ratio, dB. */
  extinctionRatioSpDb: number;
  /** Operating wavelength range (nm) — column-owned. */
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
    // Every key here is read by the live op (directly, or via the anchor it
    // seeds). Representative Glan-Laser values (Thorlabs IO-*-HP internals); a
    // plain isotropic PBS cube sets refractiveIndex_o = refractiveIndex_e.
    defaultParams: {
      polarizing: true,
      transmissionAxisDegBeamLocal: 0.0,
      // XZ-plane 38.5° cut normal ([sin, 0, -cos]); reflects a +Z beam toward
      // +X. (The old [0.7071,0.7071,0] was perpendicular to a +Z beam, so the
      // reflected branch was degenerate.)
      coatingNormalBodyLocal: [0.6225096458616945, 0, -0.7826121266688548],
      lengthMm: 7.5,
      refractiveIndex_o: 1.66,
      refractiveIndex_e: 1.48,
      extinctionRatioPpDb: 50,
      extinctionRatioSpDb: 30,
      wavelengthRangeNm: [400, 1100],
    },
  },
});
