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
      // Measured off aa_mt80_a1_5_ir.glb (2026-08-14): the SMA-female
      // receptacle is the only coax feature in the mesh — barrel r≈3.18 mm
      // centred on (y 0.000, z −1.2265), running x≈40 → 45.52 (= mesh bbox
      // max = the mating face), hex flange r≈5.37 at x≈37, mounted on the
      // +X end of the housing (body ends x≈33). The old (15, 0, 0) was the
      // migration-0048 placeholder (`transducerOffsetFromCenterMmX`
      // "typical 15 mm") and sat ~30 mm INSIDE the housing, so a mated
      // cable's connector was drawn buried in the AOM body.
      role: "rf_in",
      positionMmBodyLocal: { x: 45.5, y: 0, z: -1.2265 },
      directionBodyLocal: { x: 1, y: 0, z: 0 },
      connectorType: "sma_female",
    },
  ],
  defaultParams: {
    rfPowerMaxW: 2,
    baseEfficiency: 0.85,
    // Datasheet Size 59.5 x 22.4 x 17.3 mm — 22.4 mm is the dimension the
    // beam crosses, and equals this device's intercept_in → intercept_out
    // separation. Sets the slab propagation L/n AND the Bragg angular
    // acceptance n·v/(f·L) = ±5.3 mrad (alembic 0120).
    crystalLengthMm: 22.4,
    refractiveIndex: 2.26,
    diffractionOrder: 1,
    braggAngularAcceptanceMrad: 2,
  },
});
