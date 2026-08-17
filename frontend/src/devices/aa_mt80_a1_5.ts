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
    // Optical faces: the beam runs along body ±Y, separated by 22.4 mm
    // (±11.2), which is `crystalLengthMm` below — the datasheet Size
    // dimension the beam crosses. Synced 2026-08-17 from the locked
    // aa_mt80_a1_5_ir Asset3D row. These used to read ±0.8 on Z, i.e. a
    // 1.6 mm separation on the wrong axis: 1.6 mm is the retired crystal
    // length that alembic 0120 replaced (at 1.6 the ±1 Bragg orders are
    // not distinguishable), so this block contradicted the defaultParams
    // in its own file. See docs/float64-audit.md §3-5.
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 0, y: -11.2, z: 0 },
      directionBodyLocal: { x: 0, y: -1, z: 0 },
      apertureMm: 1.5,
      apertureShape: "circle",
    },
    {
      role: "intercept_out",
      positionMmBodyLocal: { x: 0, y: 11.2, z: 0 },
      directionBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 1.5,
      apertureShape: "circle",
    },
    {
      // The SMA-female receptacle is the only coax feature in the mesh:
      // barrel r≈3.18 mm centred on (y 0.000, z −1.2265), running x≈40 →
      // 45.52 (mesh bbox max), hex flange r≈5.37 at x≈37, mounted on the
      // +X end of the housing (body ends x≈33).
      //
      // The anchor sits at the flange, x = 37.174 — synced 2026-08-17 from
      // the locked aa_mt80_a1_5_ir Asset3D row, which is the value the
      // renderer and tracer have actually been using. This file briefly
      // carried 45.5 (the bbox-max mating face) instead; both are measured
      // off the same connector, just off different features, and the asset
      // is the human-confirmed one. Either way it clears the housing — the
      // bug both replaced was the migration-0048 placeholder (15, 0, 0)
      // (`transducerOffsetFromCenterMmX` "typical 15 mm"), which sat ~30 mm
      // INSIDE the housing and drew a mated cable buried in the AOM body.
      role: "rf_in",
      positionMmBodyLocal: { x: 37.174, y: 0, z: -1.226 },
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
