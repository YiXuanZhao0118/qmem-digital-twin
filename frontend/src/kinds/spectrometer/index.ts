import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface SpectrometerParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

const SPECTROMETER_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
};

export const spectrometerPlugin = definePhysicsPlugin<SpectrometerParams>({
  id: "spectrometer",
  displayName: "Spectrometer",
  componentTypes: ["spectrometer"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "spectrometer",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: SPECTROMETER_ROLES,
    anchors: anchorContractFromRoles(SPECTROMETER_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Slit/fiber input (intercept_in) translates to beam.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
