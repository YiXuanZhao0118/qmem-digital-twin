import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface CameraParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

const CAMERA_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
};

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
    roles: CAMERA_ROLES,
    anchors: anchorContractFromRoles(CAMERA_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Sensor centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
