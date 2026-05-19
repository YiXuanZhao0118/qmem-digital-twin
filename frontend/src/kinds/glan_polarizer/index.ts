/**
 * Glan-Laser polariser — calcite-prism alternative to a PBS cube.
 *
 * Two right-angle calcite prisms separated by a thin air gap along
 * their hypotenuse. The E-ray passes through near-Brewster (the
 * "transmission axis"); the O-ray hits TIR at the air gap and exits
 * the side at ~68° from the optical axis. Glan-Laser variants have a
 * higher damage threshold than cement-bonded PBS cubes so they're
 * used in high-power isolators (Thorlabs IO-*-HP suffix, Newport HP).
 *
 * Used as a sub-Component of isolator Components on the high-power
 * variants — the isolator's binding tree picks
 * ``glan_polarizer_calcite`` for the front/back polariser slot
 * instead of ``polarizer_pbs_cube`` (Stage A''.3/.4).
 */
import { definePhysicsPlugin } from "../_plugin";


export interface GlanPolarizerParams extends Record<string, unknown> {
  /** Transmission-axis angle (degrees) of the passing polarisation,
   *  measured in body-local beam coordinates at the entry anchor. */
  transmissionAxisDegBeamLocal: number;
  /** Extinction ratio of the rejected polarisation (dB). Higher =
   *  better — Glan-Laser typically 10^5..10^6 (50..60 dB). */
  extinctionRatioDb: number;
  /** Forward transmission (E-ray, fraction of incident power). */
  transmission: number;
  /** Wedge angle between cut plane and optical axis (degrees). 38°
   *  matches the standard Glan-Laser calcite design at 850 nm
   *  (near-Brewster for E-ray transmission, TIR for O-ray). */
  wedgeAngleDeg: number;
  /** Air-gap thickness between the two prisms (mm). Sets the
   *  separation distance E-ray vs reflected-O-ray see at TIR. */
  airGapMm: number;
  /** Operating wavelength range (nm). Calcite birefringence shifts
   *  the optimal wedge angle with wavelength; outside this range the
   *  device's extinction ratio degrades. */
  wavelengthRangeNm: [number, number];
}


export const glanPolarizerPlugin = definePhysicsPlugin<GlanPolarizerParams>({
  id: "glan_polarizer",
  displayName: "Glan-Laser",
  componentTypes: ["glan_polarizer"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "glan_polarizer",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      // intercept_out marks the side exit of the rejected O-ray
      // (~68° from the optical axis through the side face). Optional
      // because most callers only care about the passing beam.
      optional: ["intercept_out"],
      needsDirection: [],
      needsAperture: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Glan-Laser calcite polariser — two right-angle prisms with an air gap. " +
      "intercept_in translates to the beam axis (translation only). The " +
      "rejected polarisation exits the side at ~68° from the optical axis " +
      "via the air gap's TIR; intercept_out can be set to capture that path.",
    defaultParams: {
      transmissionAxisDegBeamLocal: 0.0,
      extinctionRatioDb: 55.0,
      transmission: 0.92,
      wedgeAngleDeg: 38.0,
      airGapMm: 0.05,
      wavelengthRangeNm: [400, 1100],
    },
    intrinsicParamKeys: [
      "wedgeAngleDeg",
      "airGapMm",
      "transmission",
      "extinctionRatioDb",
      "wavelengthRangeNm",
    ],
    stateParamKeys: ["transmissionAxisDegBeamLocal"],
    portDomains: {
      intercept_in: "optical",
      intercept_out: "optical",
    },
  },
});
