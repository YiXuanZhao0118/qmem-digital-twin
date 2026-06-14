import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface NonlinearCrystalParams extends Record<string, unknown> {
  process: "SHG" | "SFG" | "DFG" | "OPO" | "OPA";
  chi2PmPerV: number;
  lengthMm: number;
  walkOffUrad: number;
  wavelengthRangeNm: [number, number];
}

const NONLINEAR_CRYSTAL_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
  intercept_out: { min: 0, domain: "optical" },
};

export const nonlinearCrystalPlugin = definePhysicsPlugin<NonlinearCrystalParams>({
  id: "nonlinear_crystal",
  displayName: "Nonlinear Crystal",
  componentTypes: ["nonlinear_crystal"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "nonlinear_crystal",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    roles: NONLINEAR_CRYSTAL_ROLES,
    anchors: anchorContractFromRoles(NONLINEAR_CRYSTAL_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "intercept_in translates to fundamental beam. Phase matching set in kindParams.",
    defaultParams: {
      process: "SHG",
      chi2PmPerV: 4.5,
      lengthMm: 10.0,
      walkOffUrad: 0.0,
      wavelengthRangeNm: [400, 1700],
    },
  },
});
