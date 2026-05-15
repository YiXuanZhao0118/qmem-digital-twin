import { definePhysicsPlugin } from "../_plugin";

export interface RfSourceParams extends Record<string, unknown> {
  frequencyMhz: number;
  powerDbm: number;
  phaseDeg: number;
  modulation: string;
  channels: unknown;
  referenceClockMhz: number | null;
  sysClockMhz: number | null;
  pllMultiplier: number;
  pllBypass: boolean;
  serialInterface: string | null;
  syncRole: string;
  serialPortMode: string;
}

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
    anchors: {
      required: [],
      optional: ["rf_out"],
      needsDirection: [],
    },
    alignVariant: "none",
    alignToleranceMm: 0,
    alignSummary:
      "RF emitter — DDS / synth / arbitrary-waveform generator. Drives downstream RF chain (amp / filter / AOM-EOM driver). Not aligned optically.",
    defaultParams: {
      frequencyMhz: 80.0,
      powerDbm: 0.0,
      phaseDeg: 0.0,
      modulation: "none",
      channels: null,
      referenceClockMhz: null,
      sysClockMhz: null,
      pllMultiplier: 25,
      pllBypass: false,
      serialInterface: null,
      syncRole: "standalone",
      serialPortMode: "4wire",
    },
    // Phase 3c: AD9959 / generic-DDS spec sheet vs runtime knobs.
    //
    // Intrinsic (board / silicon):
    //   referenceClockMhz, sysClockMhz, pllMultiplier, pllBypass,
    //   serialInterface, syncRole (master/slave/standalone wiring on the
    //   PCB), serialPortMode (1/2/4-wire — strapped on the board).
    //
    // State (the user-facing knobs):
    //   frequencyMhz / powerDbm / phaseDeg are the legacy single-tone
    //   convenience fields; in production they're superseded by the
    //   `channels[]` array which carries per-channel freq / amp / phase /
    //   sweep / modulation.
    //
    // Note: AD9959 channel count (4) lives on the catalog Component's
    // properties / asset anchors, not in kindParams — see the asset's
    // CH0..CH3 anchors. Future addition: an explicit `channelCount`
    // intrinsic so we don't rely on asset introspection.
    intrinsicParamKeys: [
      "referenceClockMhz",
      "sysClockMhz",
      "pllMultiplier",
      "pllBypass",
      "serialInterface",
      "syncRole",
      "serialPortMode",
    ],
    stateParamKeys: [
      "frequencyMhz",
      "powerDbm",
      "phaseDeg",
      "modulation",
      "channels",
    ],
    portDomains: { rf_out: "rf" },
  },
});
