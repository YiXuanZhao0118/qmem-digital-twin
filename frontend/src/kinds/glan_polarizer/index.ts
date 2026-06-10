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
  /** Crystal body length along the optical axis (mm). Drives the ABCD
   *  B-coefficient = L/n in the Glan slab operator. */
  lengthMm: number;
  /** E-ray refractive index of the calcite body along the optical axis.
   *  For calcite at 850 nm: n_e ≈ 1.48. */
  refractiveIndex: number;
  /** Cut-plane normal in body-local coordinates. Same role as PBS's
   *  ``coatingNormalBodyLocal`` — the slanted air-gap interface inside
   *  a Glan-Laser is physically a TIR reflector, equivalent to a PBS's
   *  diagonal cement plane. Default [0, cos(38°), sin(38°)] points
   *  along +Y/+Z (the cut tilted 38° from the optical axis Z, with the
   *  rejected O-ray reflecting toward -Y to exit the side face). */
  coatingNormalBodyLocal: [number, number, number];
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
    // Anchor convention mirrors beam_splitter (PBS): intercept_in marks
    // the SLANTED CUT INTERFACE (not the entry face). Position = body
    // centre, direction = cut-plane normal (= coatingNormalBodyLocal),
    // aperture = active interface size. The cut behaves as a TIR
    // reflector for the O-ray, so it is the optically relevant surface
    // — the same role PBS's diagonal cement plane plays.
    anchors: {
      required: ["intercept_in"],
      // intercept_out marks the side exit of the rejected O-ray
      // (~67-68° from the optical axis through the side face).
      optional: ["intercept_out"],
      needsDirection: ["intercept_in"],
      needsAperture: ["intercept_in"],
      // Transmission (e-ray) axis — transverse reference edited as axisY.
      needsFastAxis: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Glan-Laser calcite polariser — two right-angle prisms with an air " +
      "gap. intercept_in marks the slanted cut interface (the TIR " +
      "reflector): position = body centre, direction = cut-plane normal " +
      "(coatingNormalBodyLocal, default [0, cos(38°), sin(38°)] for a " +
      "wedge tilted 38° from the optical axis), aperture = active " +
      "interface size. Same role as a PBS cube's diagonal cement plane. " +
      "The rejected O-ray exits the side at ~67-68° from the optical " +
      "axis; intercept_out captures that path.",
    defaultParams: {
      transmissionAxisDegBeamLocal: 0.0,
      extinctionRatioDb: 55.0,
      lengthMm: 7.5,
      // Calcite E-ray index at 850 nm. Drives B = L/n in the slab op.
      refractiveIndex: 1.48,
      // [0, cos(38.5°), sin(38.5°)] = cut-plane normal for a 38.5° wedge.
      // Same role as PBS's diagonal cement plane normal.
      coatingNormalBodyLocal: [0, 0.7826081692851781, 0.6225146366376195],
      wavelengthRangeNm: [400, 1100],
    },
    intrinsicParamKeys: [
      "lengthMm",
      "refractiveIndex",
      "extinctionRatioDb",
      "coatingNormalBodyLocal",
      "wavelengthRangeNm",
    ],
    stateParamKeys: ["transmissionAxisDegBeamLocal"],
    portDomains: {
      intercept_in: "optical",
      intercept_out: "optical",
    },
  },
});
