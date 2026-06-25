import { defineDevice } from "./_device";

/**
 * A230TM-B-Step — device template (auto-derived from the live `a230tm_b_step` asset).
 *
 * behavioralKind `lens_plano_convex`. Frame + scalar params lifted 1:1 from the asset's
 * confirmed anchors, so a NEW import of this part seeds identically. The
 * existing (locked) catalog row keeps its own anchors on attach — the
 * deviceId PUT resends them, so this template never overwrites it.
 * (Nested/array params — spectra, polarization, spatial modes — are not
 * representable in the flat device defaultParams and come from the kind.)
 */
export const a230tm_b = defineDevice({
  id: "a230tm_b",
  displayName: "A230TM-B-Step",
  behavioralKind: "lens_plano_convex",
  componentType: "lens_plano_convex",
  mesh: "a230tm_b_step.glb",
  anchors: [
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      axisYBodyLocal: { x: 0, y: 1, z: 0 },
      apertureMm: 2.475,
      apertureShape: "circle",
    },
  ],
  defaultParams: {
    radiusBackMm: 10.308,
    focalLengthMm: 4.51,
    radiusFrontMm: 2.3244,
    transmittance: 0.995,
    refractiveIndex: 1.59,
    centerThicknessMm: 2.75,
  },
});
