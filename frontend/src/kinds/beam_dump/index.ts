import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface BeamDumpParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
}

const BEAM_DUMP_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true },
};

export const beamDumpPlugin = definePhysicsPlugin<BeamDumpParams>({
  id: "beam_dump",
  displayName: "Beam Dump",
  componentTypes: ["beam_dump"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "beam_dump",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "thermal"],
    roles: BEAM_DUMP_ROLES,
    anchors: anchorContractFromRoles(BEAM_DUMP_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary: "Absorbing face (intercept_in) translates to beam. Beam terminates.",
    defaultParams: { wavelengthRangeNm: [400, 1100] },
  },
});
