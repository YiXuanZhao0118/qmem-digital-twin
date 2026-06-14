import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface DetectorParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

const DETECTOR_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
};

export const detectorPlugin = definePhysicsPlugin<DetectorParams>({
  id: "detector",
  displayName: "Detector",
  componentTypes: ["detector"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "detector",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: DETECTOR_ROLES,
    anchors: anchorContractFromRoles(DETECTOR_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Active area centre (intercept_in) translates to beam. Beam absorbed.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
