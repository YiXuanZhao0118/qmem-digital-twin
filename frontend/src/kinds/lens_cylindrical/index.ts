import { definePhysicsPlugin } from "../_plugin";

export interface LensCylindricalParams extends Record<string, unknown> {
  focalMm: number;
  cylindricalAxis: "x" | "y" | "z";
  transmission: number;
}

export const lensCylindricalPlugin = definePhysicsPlugin<LensCylindricalParams>({
  id: "lens_cylindrical",
  displayName: "Cylindrical Lens",
  componentTypes: ["lens_cylindrical"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_cylindrical",
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
    defaultParams: { focalMm: 100.0, cylindricalAxis: "x", transmission: 0.99 },
  },
});
