import { defineDevice } from "./_device";

/**
 * LJ1960L1-B-Step — device template (auto-derived from the live `lj1960l1_b_step` asset).
 *
 * behavioralKind `lens_cylindrical`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const lj1960l1_b = defineDevice({
  id: "lj1960l1_b",
  displayName: "LJ1960L1-B-Step",
  behavioralKind: "lens_cylindrical",
  componentType: "lens_cylindrical",
  mesh: "lj1960l1_b_step.glb",
  anchors: [
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 1,
      apertureShape: "rectangle",
      apertureWidthMm: 12,
      apertureHeightMm: 10,
    },
  ],
  defaultParams: {
    focalLengthMm: 20.01,
    transmittance: 0.995,
  },
});
