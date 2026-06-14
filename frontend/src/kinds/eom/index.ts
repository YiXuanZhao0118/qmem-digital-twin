import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface EomParams extends Record<string, unknown> {
  vPiV: number;
  modulationKind: "phase" | "amplitude";
  wavelengthRangeNm: [number, number];
}

const EOM_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true, fastAxis: true },
  intercept_out: { min: 0, domain: "optical" },
};

export const eomPlugin = definePhysicsPlugin<EomParams>({
  id: "eom",
  displayName: "EOM",
  componentTypes: ["eom"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "eom",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "rf"],
    roles: EOM_ROLES,
    anchors: anchorContractFromRoles(EOM_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to beam. Translation only.",
    defaultParams: {
      vPiV: 5.0,
      modulationKind: "phase",
      wavelengthRangeNm: [400, 1700],
    },
  },
});
