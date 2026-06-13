import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";

export interface ProgrammablePulseGeneratorParams extends Record<string, unknown> {
  timingProgramId: string | null;
}

// One coax rf_out emitting the bound TimingProgram's gate. Domain "ttl" per
// plan §3.1 (⏱); note `rfLinkPorts.resolveRfLinkPortDomain` special-cases a
// PPG rf_out to the "rfout" gate domain (compatible with ttl + trigger), so
// this role domain only affects the generic heuristic, not link typing.
// Per-role spec (plan §2.1).
const PPG_ROLES: RolesMap = {
  rf_out: { min: 0, domain: "ttl", direction: true },
};

export const programmablePulseGeneratorPlugin =
  definePhysicsPlugin<ProgrammablePulseGeneratorParams>({
    id: "programmable_pulse_generator",
    displayName: "Programmable Pulse Generator",
    componentTypes: ["programmable_pulse_generator"],
    assetCategory: "electronics",
    catalogGroup: "RF",
    physics: {
      elementKind: "programmable_pulse_generator",
      primaryDomain: "rf",
      defaultPhysics: ["rf"],
      roles: PPG_ROLES,
      anchors: anchorContractFromRoles(PPG_ROLES),
      alignVariant: "none",
      alignToleranceMm: 0,
      alignSummary:
        "Programmable Pulse Generator (PPG) is the physical one-to-one output for a Pulse & Timing TimingProgram. One coax rf_out anchor emits TTL or Trigger according to the bound program kind. SMA and BNC variants differ only by connector.",
      defaultParams: {
        timingProgramId: null,
      },
      portDomains: portDomainsFromRoles(PPG_ROLES),
    },
  });
