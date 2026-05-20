import { definePhysicsPlugin } from "../_plugin";
import { glanPolarizerPlugin } from "../glan_polarizer";

/** Nested kindParams for the 3-stage isolator chain. When all three are
 *  present, apply_isolator runs the full apply_glan_laser →
 *  apply_faraday_rotator → apply_glan_laser pipeline; missing any
 *  triggers the legacy single-knob forwardLossDb path. */
export interface IsolatorGlanParams {
  transmissionAxisDegBeamLocal: number;
  transmission: number;
  extinctionRatioDb: number;
  lengthMm?: number;
  refractiveIndex?: number;
  wedgeAngleDeg?: number;
  airGapAstigmatismMm?: number;
  augmentedOffsetXMm?: number;
}

export interface IsolatorFaradayParams {
  faradayRotationDeg: number;
  lengthMm: number;
  refractiveIndex: number;
  augmentedOffsetXMm: number;
  augmentedOffsetYMm: number;
}

export interface IsolatorParams extends Record<string, unknown> {
  forwardLossDb: number;
  isolationDb: number;
  faradayRotationDeg: number;
  transmissionAxisDegBeamLocal: number;
  wavelengthRangeNm: [number, number];
  // Nested 3-stage chain — when all present, the simulator runs the
  // Glan → Faraday → Glan composition with full 5×5 ABCD per stage.
  frontGlan?: IsolatorGlanParams;
  faraday?: IsolatorFaradayParams;
  backGlan?: IsolatorGlanParams;
}

export const isolatorPlugin = definePhysicsPlugin<IsolatorParams>({
  id: "isolator",
  displayName: "Isolator",
  componentTypes: ["isolator"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "isolator",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    // 3-stage architecture (Glan → Faraday → Glan) owns its components
    // separately: the two Glan slabs are sub-Components inside the
    // binding tree (GlanLaserCalcitePrism) and each carries its own
    // intercept_in cut anchor + transmission axis. The ISOLATOR itself
    // only owns the Faraday central plane between them. Legacy anchors
    // intercept_in / intercept_out / front_pbs / back_pbs from the old
    // monolithic PBS+Faraday+PBS model are NOT declared here anymore —
    // beam routing through the isolator goes via the sub-Component
    // ports, and the legacy PBS naming is a dead remnant.
    anchors: {
      required: ["faraday_centre"],
      optional: [],
      needsDirection: ["faraday_centre"],
      // TGG slab has a physical clear aperture (typically ⌀4.7 mm for
      // IO-3-850-HP, ⌀5 mm for IO-5-850-HP). Required so the beam
      // diameter can be clipped against the central plane.
      needsAperture: ["faraday_centre"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Optical isolator = Glan-Laser + Faraday Rotator + Glan-Laser in " +
      "series. The two Glan slabs are sub-Components (GlanLaserCalcitePrism) " +
      "in the isolator's binding tree — each owns its own cut interface " +
      "anchor. The isolator itself only owns faraday_centre: the TGG " +
      "slab's central plane normal to the optical axis. Position = " +
      "isolator body centre, direction = +Z optical axis. Faraday " +
      "physics: m_faraday_slab 5×5 with B_x = B_y = L/n + θ_F rotation " +
      "of chief-ray tilt + E_x/E_y augmented offsets. " +
      "kindParams.faraday.{faradayRotationDeg, lengthMm, refractiveIndex, " +
      "augmentedOffsetXMm, augmentedOffsetYMm} drive the matrix.",
    defaultParams: {
      forwardLossDb: 0.5,
      isolationDb: 40.0,
      faradayRotationDeg: 45.0,
      transmissionAxisDegBeamLocal: 0.0,
      wavelengthRangeNm: [400, 1100],
      // Nested 3-stage chain defaults. Plugin auto-seeds these so any
      // new isolator instance gets the full apply_glan_laser →
      // apply_faraday_rotator → apply_glan_laser composition without
      // the user having to opt in manually. Matches the IO-3-850-HP /
      // IO-5-850-HP physical config (2× GlanLaserCalcitePrism + TGG).
      //
      // ⚠️  PER _plugin.ts COMPOSITE COMPONENT RULE #2: the Glan slab
      // physics defaults are REFERENCED (spread) from
      // glanPolarizerPlugin.defaultParams — never copy-pasted. Override
      // only the per-slot fields (transmissionAxisDegBeamLocal). This
      // keeps standalone GlanLaserCalcitePrism Components and isolator-
      // nested Glan slabs strictly in sync; changing n_e or wedgeAngle
      // in glan_polarizer/index.ts propagates here automatically.
      frontGlan: {
        ...glanPolarizerPlugin.physics.defaultParams,
        // Input polariser: transmission axis along body x (0°).
        transmissionAxisDegBeamLocal: 0.0,
      },
      faraday: {
        faradayRotationDeg: 45.0,
        // TGG body length for 45° rotation at 850 nm with typical NdFeB
        // magnet stack. Compact catalogue model.
        lengthMm: 8.0,
        // TGG ordinary index at 850 nm.
        refractiveIndex: 1.95,
        augmentedOffsetXMm: 0.0,
        augmentedOffsetYMm: 0.0,
      },
      backGlan: {
        ...glanPolarizerPlugin.physics.defaultParams,
        // Output analyser at 45° matches the Faraday-rotated input
        // polarisation → maximum forward transmission for 0° input.
        transmissionAxisDegBeamLocal: 45.0,
      },
    },
  },
});
