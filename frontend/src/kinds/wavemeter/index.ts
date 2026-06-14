import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface WavemeterParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

const WAVEMETER_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
};

export const wavemeterPlugin = definePhysicsPlugin<WavemeterParams>({
  id: "wavemeter",
  displayName: "Wavemeter",
  componentTypes: ["wavemeter"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "wavemeter",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: WAVEMETER_ROLES,
    anchors: anchorContractFromRoles(WAVEMETER_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Input port (intercept_in) translates to beam.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
