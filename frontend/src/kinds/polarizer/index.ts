import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface PolarizerParams extends Record<string, unknown> {
  transmissionAxisDegBeamLocal: number;
  extinctionRatioDb: number;
  wavelengthRangeNm: [number, number];
}

const POLARIZER_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true, fastAxis: true },
};

export const polarizerPlugin = definePhysicsPlugin<PolarizerParams>({
  id: "polarizer",
  displayName: "Polarizer",
  componentTypes: ["polarizer"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "polarizer",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: POLARIZER_ROLES,
    anchors: anchorContractFromRoles(POLARIZER_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam axis. Translation only.",
    defaultParams: {
      transmissionAxisDegBeamLocal: 0.0,
      extinctionRatioDb: 30.0,
      wavelengthRangeNm: [400, 1100],
    },
  },
});
