/**
 * RF Switch — coaxial SP2T family (default Mini-Circuits ZYSWA-2-50DR).
 *
 * Four physical SMA-F connectors:
 *   rf_in   ×1 → RFIN (common port)
 *   rf_out  ×N → RF1, RF2, ... (throws; multiple anchors share id="rf_out",
 *                distinguished by anchor.name)
 *   ttl_in  ×1 → TTL control line
 *
 * Reciprocal at small signal; active throw decided at solve time from
 * TTL state on ttl_in (or kind-level TTL_GATE_KINDS picker if no cable).
 * Needs ±5 V supply (POWER_KINDS).
 */
import { definePhysicsPlugin } from "../_plugin";

export interface RfSwitchParams extends Record<string, unknown> {
  switchType: "SP2T" | "SP4T" | "SP6T";
  throwCount: number;
  frequencyMinGhz: number;
  frequencyMaxGhz: number;
  insertionLossDb: number;
  isolationDb: number;
  switchingTimeNs: number;
  absorptionType: "absorptive" | "reflective";
  controlLogic: "TTL" | "CMOS";
  controlVoltageHighV: number;
  supplyPositiveV: number;
  supplyNegativeV: number;
  supplyCurrentMa: number;
  maxInputPowerDbm: number;
  connectorType: string;
  /** Per-model TTL polarity. When TTL is HIGH, switch routes RFIN →
   *  RF{ttlActiveHighThrow}; LOW routes to the other SPDT throw. */
  ttlActiveHighThrow: 1 | 2 | 3 | 4 | 5 | 6;
  /** Manual TTL state used when no PPG is connected on ttl_in. When a
   *  PPG cable is present the active state is derived from the bound
   *  TimingProgram at t = 0 (HIGH if t = 0 falls inside any HIGH
   *  interval). */
  ttlState: "HIGH" | "LOW";
  manufacturer: string;
  model: string;
  datasheetUrl: string;
}

export const rfSwitchPlugin = definePhysicsPlugin<RfSwitchParams>({
  id: "rf_switch",
  displayName: "RF Switch",
  componentTypes: ["rf_switch"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_switch",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    anchors: {
      required: ["rf_in", "rf_out", "ttl_in"],
      optional: [],
      needsDirection: ["rf_in", "rf_out", "ttl_in"],
    },
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Coaxial RF switch (SP2T by default). Four physical SMA-F connectors on the case: rf_in marks the common port (RFIN); the N throw ports are anchors all keyed `rf_out` and distinguished by `name` (RF1, RF2, …); ttl_in marks the TTL control port (a 4th SMA on the ZYSWA-2-50DR). All four directions are OUTWARD face normals — same convention as rf_cable — so a mating cable's End A / End B anchors line up. The switch is reciprocal at small signal (1-in/2-out SPDT == 2-in/1-out multiplexer); the active throw is decided at solve time from the TTL state on ttl_in, or from the kind-level TTL_GATE_KINDS picker when no cable is hooked up — both write to DeviceState.state.activeThrow. ±5 V supply lives at the kind level (POWER_KINDS) so the Instrument Power toggle attaches automatically. Per-model insertion loss / isolation / max input power live in RfSwitchParams.",
    defaultParams: {
      switchType: "SP2T",
      throwCount: 2,
      frequencyMinGhz: 0.0,
      frequencyMaxGhz: 5.0,
      insertionLossDb: 1.0,
      isolationDb: 35.0,
      switchingTimeNs: 250.0,
      absorptionType: "absorptive",
      controlLogic: "TTL",
      controlVoltageHighV: 5.0,
      supplyPositiveV: 5.0,
      supplyNegativeV: -5.0,
      supplyCurrentMa: 25.0,
      maxInputPowerDbm: 27.0,
      connectorType: "sma",
      ttlActiveHighThrow: 2,
      ttlState: "LOW",
      manufacturer: "Mini-Circuits",
      model: "ZYSWA-2-50DR",
      datasheetUrl: "https://www.minicircuits.com/pdfs/ZYSWA-2-50DR+.pdf",
    },
  },
});
