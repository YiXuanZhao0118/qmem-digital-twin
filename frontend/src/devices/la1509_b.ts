import { defineDevice } from "./_device";

/**
 * Thorlabs LA1509-B — Ø1" plano-convex lens, f = 100 mm, B-coating (650–1050 nm).
 *
 * Second OPTICAL device example: a transmissive element (`intercept_in`) vs the
 * BB1-E03's reflective face. Frame lifted from the live (locked) `la1509_b_step`
 * asset: entry face at the body origin, optical axis +Z, clear aperture
 * Ø12.7 mm. The thick-lens spec params (focal length, index, centre thickness)
 * ride in `defaultParams` so a seeded asset gets the accurate ABCD path.
 *
 * Same axisY limitation as [bb1_e03]; a lens is rotationally symmetric so axisY
 * is irrelevant here.
 */
export const la1509_b = defineDevice({
  id: "la1509_b",
  displayName: "Thorlabs LA1509-B lens (f=100mm, Ø1\")",
  behavioralKind: "lens_plano_convex",
  componentType: "lens_plano_convex",
  mesh: "la1509_b_step.glb",
  anchors: [
    {
      role: "intercept_in",
      positionMmBodyLocal: { x: 0, y: 0, z: 0 },
      directionBodyLocal: { x: 0, y: 0, z: 1 },
      apertureMm: 12.7,
    },
  ],
  defaultParams: {
    focalLengthMm: 100,
    transmittance: 0.995,
    refractiveIndex: 1.5098,
    centerThicknessMm: 3.6,
  },
});
