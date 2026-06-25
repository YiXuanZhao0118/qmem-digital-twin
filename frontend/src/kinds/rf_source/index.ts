import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";
import type { ParamSchema } from "../paramSchema";

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

// Typed UI schema (number → input, enum → dropdown). Drives the generic
// schema-driven editor. `channels` is a per-rf_out-anchor list (4 on AD9959,
// 2 on DG4202); each channel's rich sweep/profiles sub-modes stay in the
// bespoke panel for now (not declared here). fullScaleVpp + channels are the
// per-instance-tunable coefficients; maxOutputMHz/refClockMHz are spec.
const RF_SOURCE_PARAM_SCHEMA: ParamSchema = {
  fullScaleVpp: { type: "number", label: "Full-scale (Vpp)", min: 0, step: 0.01, tunable: true },
  maxOutputMHz: { type: "number", label: "Max output (MHz)", min: 0 },
  refClockMHz: { type: "number", label: "Ref clock (MHz)", min: 0 },
  channels: {
    type: "list",
    label: "Channels",
    tunable: true,
    cardinalityFromRole: "rf_out",
    itemLabel: (i) => `CH${i}`,
    item: {
      type: "record",
      fields: {
        channelEnabled: { type: "boolean", label: "enabled" },
        mode: {
          type: "enum",
          label: "mode",
          options: [
            { value: "single_tone" },
            { value: "sweep" },
            { value: "fm" },
            { value: "pm" },
            { value: "am" },
          ],
        },
        frequencyMhz: { type: "number", label: "frequency (MHz)", min: 0, step: 0.001 },
        phaseDeg: { type: "number", label: "phase (deg)", step: 0.1 },
        amplitudeScale: { type: "number", label: "amplitude (0..1)", min: 0, max: 1, step: 0.01 },
        modulationLevels: {
          type: "enum",
          label: "modulation levels",
          options: [
            { value: 2, label: "2" },
            { value: 4, label: "4" },
            { value: 8, label: "8" },
            { value: 16, label: "16" },
          ],
        },
      },
    },
  },
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
    paramSchema: RF_SOURCE_PARAM_SCHEMA,
    // Per-channel freq/amp seed the RF propagation walk; the legacy
    // single-tone fields + AD9959 PLL/clock straps were unused metadata.
    stateParamKeys: ["channels"],
    portDomains: portDomainsFromRoles(RF_SOURCE_ROLES),
  },
});
