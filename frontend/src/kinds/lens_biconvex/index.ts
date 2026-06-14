import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface LensBiconvexParams extends Record<string, unknown> {
  focalLengthMm: number;
  wavelengthRangeNm: [number, number];
}

const LENS_BICONVEX_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", direction: true, aperture: true },
  intercept_out: { min: 0, domain: "optical" },
};

export const lensBiconvexPlugin = definePhysicsPlugin<LensBiconvexParams>({
  id: "lens_biconvex",
  displayName: "Biconvex Lens",
  componentTypes: ["lens_biconvex", "lens", "lens_spherical"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_biconvex",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: LENS_BICONVEX_ROLES,
    anchors: anchorContractFromRoles(LENS_BICONVEX_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in translates to beam axis. Direction = optical axis (light propagation direction through lens body).",
    defaultParams: { focalLengthMm: 100.0, wavelengthRangeNm: [400, 1100] },
  },
});
