import { definePhysicsPlugin } from "../_plugin";

export interface IsolatorParams extends Record<string, unknown> {
  forwardLossDb: number;
  isolationDb: number;
  faradayRotationDeg: number;
  transmissionAxisDegBeamLocal: number;
}

export const isolatorPlugin = definePhysicsPlugin<IsolatorParams>({
  id: "isolator",
  displayName: "Isolator",
  componentTypes: ["isolator"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "isolator",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: ["intercept_out", "front_pbs", "back_pbs"],
      needsDirection: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Optical isolator = PBS + Faraday Rotator + PBS in series. intercept_in / intercept_out are the device's outer ports; front_pbs / back_pbs (optional) mark each PBS cube's diagonal cement interface (position = cube centre, direction = coating normal). The two PBS directions implicitly fix the device's transmission axis; faradayRotationDeg (typ. 45°) is in kindParams.",
    defaultParams: {
      forwardLossDb: 0.5,
      isolationDb: 40.0,
      faradayRotationDeg: 45.0,
      transmissionAxisDegBeamLocal: 0.0,
    },
  },
});
