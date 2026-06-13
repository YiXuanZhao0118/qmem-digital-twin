import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";

export interface RfCableParams extends Record<string, unknown> {
  lengthMm: number;
}

// Bidirectional coax cable — two connector tips, both required and
// direction-bearing. Per-role spec (plan §2.1).
const RF_CABLE_ROLES: RolesMap = {
  rf_in: { min: 1, domain: "rf", direction: true },
  rf_out: { min: 1, domain: "rf", direction: true },
};

export const rfCablePlugin = definePhysicsPlugin<RfCableParams>({
  id: "rf_cable",
  displayName: "RF Cable",
  // Legacy `sma_cable` componentType promotes to the same kind so old
  // QMEM jumpers in the catalog migrate without DB rewrite.
  componentTypes: ["rf_cable", "sma_cable"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_cable",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    roles: RF_CABLE_ROLES,
    anchors: anchorContractFromRoles(RF_CABLE_ROLES),
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Bidirectional coaxial RF cable. rf_in (End A) and rf_out (End B) mark the two SMA / BNC / N connector tips; both directions are OUTWARD face normals (pointing away from the cable body, the way a mating plug would slide on). Cable physics (impedance, max frequency, connector type, jacket OD) lives in RfCableParams. Spline editing UX (analogous to fiber's Edit fiber path) is a follow-up — current visual is parametric straight cable.",
    defaultParams: {
      lengthMm: 152.0,
    },
    portDomains: portDomainsFromRoles(RF_CABLE_ROLES),
  },
});
