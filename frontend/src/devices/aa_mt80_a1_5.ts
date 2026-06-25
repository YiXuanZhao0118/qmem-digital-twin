import { defineDevice } from "./_device";

/**
 * aa_mt80_a1_5_ir — AA Opto-Electronic MT80-A1.5-IR AOM device template.
 *
 * behavioralKind `aom`. Anchors are the AOM's two optical faces + the RF
 * drive port (intercept_in / intercept_out / rf_in), per the `aom` kind
 * contract. Geometry is the catalog JSON's faces A/B/rf_in
 * (assets/catalog/assets3d/optical/aom/aa_mt80_a1_5_ir.json): A/B are the
 * ±z optical faces (1.5 mm clear aperture), rf_in is the +x SMA transducer
 * port. The earlier `rf_out` CH0..CH3 here were a copy-paste from ad9959
 * (the asset had been mis-seeded by ad9959) — an AOM has NO rf_out.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const aa_mt80_a1_5 = defineDevice({
  id: "aa_mt80_a1_5",
  displayName: "aa_mt80_a1_5_ir",
  behavioralKind: "aom",
  componentType: "aom",
  mesh: "aa_mt80_a1_5_ir.glb",
  anchors: [
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: -0.8 },
      directionBodyLocal: { x: 0, y: 0, z: -1 },
      apertureMm: 1.5,
      apertureShape: "circle",
    },
    {
      role: "intercept_out",
      positionMmBodyLocal: { x: 0, y: 0, z: 0.8 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 1.5,
      apertureShape: "circle",
    },
    {
      role: "rf_in",
      positionMmBodyLocal: { x: 15, y: 0, z: 0 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
  ],
  defaultParams: {
    rfPowerMaxW: 2,
    baseEfficiency: 0.85,
    crystalLengthMm: 25,
    refractiveIndex: 2.26,
    diffractionOrder: 1,
    braggAngularAcceptanceMrad: 2,
  },
});
