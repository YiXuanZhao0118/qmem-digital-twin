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
  /** Wedge angle between cut plane and optical axis (degrees). 38.5°
   *  matches the standard Glan-Laser calcite design at 850 nm
   *  (near-Brewster for E-ray transmission, TIR for O-ray). */
  wedgeAngleDeg: number;
  /** Air-gap thickness between the two prisms (mm). Sets the
   *  separation distance E-ray vs reflected-O-ray see at TIR. */
  airGapMm: number;
  /** Crystal body length along the optical axis (mm). Default 7.5 mm
   *  matches the compact GlanLaserCalcitePrism catalogue model. Drives
   *  the ABCD B-coefficient = L/n in the astigmatic Glan slab operator. */
  lengthMm: number;
  /** E-ray refractive index of the calcite body along the optical axis.
   *  For calcite at 850 nm: n_e ≈ 1.48. */
  refractiveIndex: number;
  /** x-axis astigmatic B correction (mm) introduced by refraction at
   *  the slanted air-gap interface. Empirical — typical calcite Glan-
   *  Laser at 38.5° wedge with ~50-100 µm air gap sits in the
   *  +0.03..+0.08 mm range. Default 0.05 mm. */
  airGapAstigmatismMm: number;
  /** Augmented offset M[0,4] = E_x (mm). Constant lateral shift of the
   *  optical axis along x — reflects manufacturing tolerances or a
   *  deliberate decenter. Independent of input tilt; defaults to 0. */
  augmentedOffsetXMm: number;
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
      transmission: 0.92,
      wedgeAngleDeg: 38.5,
      airGapMm: 0.05,
      lengthMm: 7.5,
      // Calcite E-ray index at 850 nm. Drives B_x, B_y = L/n in the
      // astigmatic Glan slab ABCD operator (m_glan_slab).
      refractiveIndex: 1.48,
      // Empirical x-axis astigmatism from refraction at the 38.5° wedge
      // for a ~50 µm calcite air gap; midpoint of the typical
      // +0.03..+0.08 mm range. Set to 0 to fall back to symmetric L/n.
      airGapAstigmatismMm: 0.05,
      // Constant lateral shift M[0,4] = E_x; 0 for ideal alignment.
      augmentedOffsetXMm: 0.0,
      // [0, cos(38.5°), sin(38.5°)] = cut-plane normal for a 38.5° wedge.
      // Equivalent to PBS's [√2/2, √2/2, 0] but tilted into YZ since the
      // Glan-Laser cut runs across the optical axis instead of across a
      // transverse pair of cube faces.
      coatingNormalBodyLocal: [0, 0.7826081692851781, 0.6225146366376195],
      wavelengthRangeNm: [400, 1100],
    },
    intrinsicParamKeys: [
      "wedgeAngleDeg",
      "airGapMm",
      "lengthMm",
      "refractiveIndex",
      "airGapAstigmatismMm",
      "augmentedOffsetXMm",
      "transmission",
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
