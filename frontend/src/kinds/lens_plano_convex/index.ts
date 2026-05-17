import { definePhysicsPlugin } from "../_plugin";

export interface LensPlanoConvexParams extends Record<string, unknown> {
  focalMm: number;
  transmission: number;
  wavelengthRangeNm: [number, number];
}

export const lensPlanoConvexPlugin = definePhysicsPlugin<LensPlanoConvexParams>({
  id: "lens_plano_convex",
  displayName: "Plano-Convex Lens",
  componentTypes: ["lens_plano_convex"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_plano_convex",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: ["intercept_out"],
      needsDirection: ["intercept_in"],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in is the plane-side surface center; direction points from plane toward convex side.",
    defaultParams: { focalMm: 100.0, transmission: 0.99, wavelengthRangeNm: [400, 1100] },
  },
});
