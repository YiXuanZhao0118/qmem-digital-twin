import { definePhysicsPlugin } from "../_plugin";

export interface CameraParams extends Record<string, unknown> {
  resolutionPx: [number, number];
  pixelSizeUm: number;
  quantumEfficiency: number;
  wellDepthE: number;
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
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Sensor centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: {
      resolutionPx: [1024, 1024],
      pixelSizeUm: 5.5,
      quantumEfficiency: 0.5,
      wellDepthE: 20000,
    },
  },
});
