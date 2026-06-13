import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";

export interface RfSourceParams extends Record<string, unknown> {
  channels: unknown;
}

// Per-role anchor spec (plan §2.1) — single source of truth. `rf_out` is an
// optional, unbounded multiport (CH0..CH3 on a DDS, 1 port on a synth);
// concrete per-instrument layouts live in the device registry
// (`devices/ad9959.ts`), not here.
const RF_SOURCE_ROLES: RolesMap = {
  rf_out: { min: 0, max: null, domain: "rf" },
};

export const rfSourcePlugin = definePhysicsPlugin<RfSourceParams>({
  id: "rf_source",
  displayName: "RF Source",
  // dds_ad9959_pcb and rf_generator are physical-form aliases that map
  // to the same kind (DDS evaluation board vs generic signal generator).
  componentTypes: ["rf_source", "dds_ad9959_pcb", "rf_generator"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_source",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    roles: RF_SOURCE_ROLES,
    anchors: anchorContractFromRoles(RF_SOURCE_ROLES),
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "RF emitter — DDS / synth / arbitrary-waveform generator. Drives downstream RF chain (amp / filter / AOM-EOM driver). Not aligned optically.",
    defaultParams: {
      channels: null,
    },
    // Per-channel freq/amp seed the RF propagation walk; the legacy
    // single-tone fields + AD9959 PLL/clock straps were unused metadata.
    stateParamKeys: ["channels"],
    portDomains: portDomainsFromRoles(RF_SOURCE_ROLES),
  },
});
