import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface LensPlanoConvexParams extends Record<string, unknown> {
  focalLengthMm: number;
  transmittance: number;
  wavelengthRangeNm: [number, number];
  // Optional thick-lens geometry (opt-in per part). Leave blank for the
  // thin-lens approximation (focus at nominal f); fill radiusFrontMm +
  // refractiveIndex + centerThicknessMm to switch the op to the accurate
  // air→air thick-lens ABCD (focus at back-vertex + BFL). See
  // backend/app/optical/anchor_ops/lens.py `_is_thick`.
  radiusFrontMm?: number;
  refractiveIndex?: number;
  centerThicknessMm?: number;
  // Back-surface radius. Blank ⇒ flat back (true plano-convex; op treats a
  // missing/≈∞ radius as zero power). Set it for an aspheric modeled as a
  // thick-lens EQUIVALENT FIT with a curved back, e.g. A230TM-B
  // (radiusBackMm=10.308). See docs/introduce/optics.md.
  radiusBackMm?: number;
}

const LENS_PLANO_CONVEX_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", direction: true, aperture: true },
  intercept_out: { min: 0, domain: "optical" },
};

export const lensPlanoConvexPlugin = definePhysicsPlugin<LensPlanoConvexParams>({
  id: "lens_plano_convex",
  displayName: "Plano-Convex Lens",
  componentTypes: ["lens_plano_convex"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "lens_plano_convex",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: LENS_PLANO_CONVEX_ROLES,
    anchors: anchorContractFromRoles(LENS_PLANO_CONVEX_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "intercept_in is the plane-side surface center; direction points from plane toward convex side.",
    // The lens anchor-op reads `focalLengthMm` (thin-lens) + `transmittance`
    // (AR-coating power factor) from default_params; see
    // backend/app/optical/anchor_ops/lens.py:167,109.
    //
    // wavelengthRangeNm stays in this KIND TEMPLATE (the optical-kinds spec
    // requires every non-emitter optical kind to declare it, and the legacy
    // PhysicsElement seed reads it — components.py:667). But at the ASSET
    // level it is column-owned, not a default_param: the Asset3D editor seeds
    // it into the lambda min/max fields and strict-filters it OUT of
    // default_params (kindScalarParamKeys / kindAllParamKeys exclude it). So
    // an asset's wavelength lives in wavelength_range_nm, never in its
    // default_params. See docs/introduce/asset.md.
    defaultParams: { focalLengthMm: 100.0, transmittance: 0.99, wavelengthRangeNm: [400, 1100] },
    // Suggested thick-lens geometry shown as placeholders when the user
    // opts in. Defaults reproduce the validated LA1509-B golden (f=100,
    // N-BK7): R=51.5, n=1.5168, d=3.6 → BFL 97.3 mm. Per-part values differ
    // by focal length, so these are suggestions, not seeded defaults.
    optionalParams: { radiusFrontMm: 51.5, refractiveIndex: 1.5168, centerThicknessMm: 3.6, radiusBackMm: 0 },
  },
});
