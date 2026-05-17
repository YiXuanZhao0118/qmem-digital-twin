import { definePhysicsPlugin } from "../_plugin";

export interface FiberCouplerParams extends Record<string, unknown> {
  couplingEfficiency: number;
  modeFieldDiameterUm: number;
  fiberType: "single_mode" | "multi_mode" | "polarization_maintaining";
  wavelengthRangeNm: [number, number];
}

export const fiberCouplerPlugin = definePhysicsPlugin<FiberCouplerParams>({
  id: "fiber_coupler",
  displayName: "Fiber Coupler",
  componentTypes: ["fiber_coupler"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "fiber_coupler",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: [],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in (free-space side) translates to beam.",
    defaultParams: {
      couplingEfficiency: 0.7,
      modeFieldDiameterUm: 5.0,
      fiberType: "single_mode",
      wavelengthRangeNm: [400, 1100],
    },
  },
});
