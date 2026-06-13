import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";

export interface HornAntennaParams extends Record<string, unknown> {
  polarAxisBodyLocal: [number, number, number];
  cosineExponent: number;
}

// Single radiating aperture — RF sink that emits a cos^n lobe along the polar
// axis. Per-role spec (plan §2.1).
const HORN_ANTENNA_ROLES: RolesMap = {
  aperture: { min: 0, domain: "rf", direction: true },
};

export const hornAntennaPlugin = definePhysicsPlugin<HornAntennaParams>({
  id: "horn_antenna",
  displayName: "Horn Antenna",
  componentTypes: ["horn_antenna"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "horn_antenna",
    primaryDomain: "rf",
    defaultPhysics: ["rf", "em"],
    roles: HORN_ANTENNA_ROLES,
    anchors: anchorContractFromRoles(HORN_ANTENNA_ROLES),
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "Microwave horn / antenna — radiates the chain output along its polar axis (+Z body-local by default). Phase RF.7 renders a parametric cos^n radiation lobe; palace farfield can populate a real pattern later.",
    defaultParams: {
      polarAxisBodyLocal: [0, 0, 1],
      cosineExponent: 8.0,
    },
    portDomains: portDomainsFromRoles(HORN_ANTENNA_ROLES),
  },
});
