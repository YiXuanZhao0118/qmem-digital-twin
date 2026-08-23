/**
 * Detector — a terminal optical sink that reports an ELECTRICAL signal.
 *
 * Two builds share one kind, told apart by how the light arrives:
 *
 *   - free-space — the beam lands on a bare active area; `intercept_in`'s
 *     aperture is the photodiode itself.
 *   - fibre-coupled — the light arrives down a patch cable and stops at a
 *     bulkhead receptacle (the Thorlabs RXM series). That receptacle is
 *     **`fiber_in`**, its own anchor since 2026-08-23, NOT an `intercept_in`
 *     wearing a connector: it is a female socket you mate a male ferrule
 *     into, it can never be flown onto a free-space beam, and its aperture
 *     is the ferrule bore rather than any photosensitive area.
 *
 * A build has one or the other, never both, so both roles are `min: 0`.
 *
 * Either way the optical trace ENDS here (`_terminal_sink_op` in
 * `anchor_ops/misc_ops.py` returns no continuation). What leaves the part is
 * a voltage on `rf_out` — the coax jack a scope or spectrum analyser plugs
 * into. That anchor is optional (`min: 0`) because a bare photodiode has no
 * connector of its own, and like the AOM's `rf_in` it is used for cable
 * routing in 3D only: there is no optical→RF conversion in the solver yet,
 * so `responsivityAPerW` / `conversionGainVPerW` / `bandwidthHz` /
 * `nepWPerRtHz` are spec-sheet record, not something the tracer consumes.
 *
 * All params are intrinsic — a detector has no knob to dial at experiment
 * time, so there are no `stateParamKeys`.
 */
import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface DetectorParams extends Record<string, unknown> {
  wavelengthRangeNm: [number, number];
  /** Photodiode responsivity at the spec wavelength, A/W. */
  responsivityAPerW: number;
  /**
   * Optical power to output volts across the rated load, V/W. NEGATIVE for
   * an inverting output (the RXM15EF is −200 V/W into 50 Ω).
   */
  conversionGainVPerW: number;
  /** −3 dB electrical bandwidth of the transimpedance chain, Hz. */
  bandwidthHz: number;
  /** Noise-equivalent power, W/√Hz. */
  nepWPerRtHz: number;
}

const DETECTOR_ROLES: RolesMap = {
  // Bare active area, for the free-space build. `min: 0` since 2026-08-23 —
  // a fibre-coupled receiver has no free-space face at all.
  intercept_in: { min: 0, domain: "optical", aperture: true },
  // The fibre BULKHEAD, for the fibre-coupled build: a female receptacle on
  // the chassis carrying `connectorType: "fc_pc_female"` / `"fc_apc_female"`.
  // Its own role rather than a connector bolted onto `intercept_in` because
  // the two answer different questions — an intercept is a face you can align
  // a beam onto, a bulkhead is a CONNECTION a cable plugs into, exactly the
  // split coax already has between an optical face and `rf_in` / `rf_out`.
  //
  // In PRIMARY_ANCHOR_IDS (backend `anchor_tracer.py`), so the short segment
  // across the mating gap still terminates here and the part reads power.
  // Direction is the PROPAGATION direction (into the body), per anchors.md —
  // not the mechanical outward normal an rf_out uses. Aperture is the ferrule
  // bore: it only decides what counts as a hit, and a core-sized one would be
  // unhittable by anything but a perfectly placed fibre.
  fiber_in: { min: 0, domain: "optical", aperture: true, direction: true },
  // The coax jack the detected signal leaves on. Optional — a bare
  // photodiode has no connector. Direction is the OUTWARD face normal
  // (the way a mating cable plug slides on), same convention as rf_cable.
  rf_out: { min: 0, domain: "rf", direction: true },
};

export const detectorPlugin = definePhysicsPlugin<DetectorParams>({
  id: "detector",
  displayName: "Detector",
  componentTypes: ["detector"],
  assetCategory: "optical",
  catalogGroup: "Sinks",
  physics: {
    elementKind: "detector",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "rf"],
    roles: DETECTOR_ROLES,
    anchors: anchorContractFromRoles(DETECTOR_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Active area centre (intercept_in) translates to beam. Beam absorbed. " +
      "fiber_in is the fibre bulkhead of a fibre-coupled receiver — a female " +
      "receptacle a patch cable plugs into, never aligned to a free-space " +
      "beam. " +
      "rf_out marks the SMA / BNC jack the detected signal leaves on " +
      "(position = jack centre on the body, direction = outward face normal) " +
      "— cable-routing visualisation only, not consumed by the solver.",
    defaultParams: {
      wavelengthRangeNm: [400, 1100],
      responsivityAPerW: 0.5,
      conversionGainVPerW: 0.0,
      bandwidthHz: 0.0,
      nepWPerRtHz: 0.0,
    },
    intrinsicParamKeys: [
      "wavelengthRangeNm",
      "responsivityAPerW",
      "conversionGainVPerW",
      "bandwidthHz",
      "nepWPerRtHz",
    ],
    portDomains: {
      intercept_in: "optical",
      fiber_in: "optical",
      rf_out: "rf",
    },
  },
});
