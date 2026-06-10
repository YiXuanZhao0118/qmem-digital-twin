import { definePhysicsPlugin } from "../_plugin";

export interface CameraParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

export const cameraPlugin = definePhysicsPlugin<CameraParams>({
  id: "camera",
  displayName: "Camera",
  componentTypes: ["camera"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "camera",
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
    alignSummary: "Sensor centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
