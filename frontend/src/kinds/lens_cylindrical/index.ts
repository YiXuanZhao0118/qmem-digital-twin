import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface LensCylindricalParams extends Record<string, unknown> {
  focalLengthMm: number;
  transmittance: number;
  wavelengthRangeNm: [number, number];
}

const LENS_CYLINDRICAL_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", direction: true, aperture: true },
  intercept_out: { min: 0, domain: "optical" },
};

export const lensCylindricalPlugin = definePhysicsPlugin<LensCylindricalParams>({
  id: "lens_cylindrical",
  displayName: "Cylindrical Lens",
  componentTypes: ["lens_cylindrical"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_cylindrical",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: LENS_CYLINDRICAL_ROLES,
    anchors: anchorContractFromRoles(LENS_CYLINDRICAL_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in translates to beam axis. Direction = optical axis (light propagation direction through lens body).",
    // Cylinder orientation is geometric, not a param: intercept_in's axisY is
    // the power (curved) axis, axisZ the cylinder line — both ⊥ axisX (optical
    // axis) by construction. Re-orient by rotating the anchor frame, not a
    // "cylindricalAxis" string (retired 2026-06-12; the live anchor tracer
    // always focuses axisY — see lens_cylindrical_op).
    //
    // transmittance: AR/Fresnel power factor read by the SHARED
    // _lens_power_factor (lens.py); declared here (mirroring lens_plano_convex)
    // so an asset's coating value survives the Asset3DEditor strict filter.
    defaultParams: { focalLengthMm: 100.0, transmittance: 0.99, wavelengthRangeNm: [400, 1100] },
  },
});
