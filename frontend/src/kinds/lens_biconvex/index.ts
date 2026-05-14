import { definePhysicsPlugin } from "../_plugin";

export interface LensBiconvexParams extends Record<string, unknown> {
  focalMm: number;
  transmission: number;
}

export const lensBiconvexPlugin = definePhysicsPlugin<LensBiconvexParams>({
  id: "lens_biconvex",
  displayName: "Biconvex Lens",
  componentTypes: ["lens_biconvex", "lens", "lens_spherical"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_biconvex",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: ["intercept_out"],
      needsDirection: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in translates to beam axis. Direction = optical axis (light propagation direction through lens body).",
    defaultParams: { focalMm: 100.0, transmission: 0.99 },
  },
});
