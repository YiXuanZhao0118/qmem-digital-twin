/**
 * AOM — Acousto-Optic Modulator.
 *
 * Hybrid optical + RF kind: intercept_in / intercept_out are optical
 * ports (require aperture); rf_in is the SMA driver connector. Align
 * variant `translate_and_bragg_rotate` rotates the body 1-D around
 * the lab tilt axis with the entry-port anchor pinned to the beam.
 *
 * Physics formulas live in `optical/kinds/aom/physics.ts` — that file
 * stays where it is (consumed by rayTrace and PhysicsElementPanel) and
 * is re-exported through this plugin folder's `physics.ts` (M6).
 */
import { definePhysicsPlugin } from "../_plugin";

export interface AomParams extends Record<string, unknown> {
  baseEfficiency: number;            // datasheet PEAK efficiency (η at rated drive)
  centerFreqMhz: number;             // design centre frequency (RF bandwidth peak)
  rfPowerForPeakW: number;           // P_peak: RF power for peak η
  peakRefWavelengthNm: number;       // λ_ref for P_peak ∝ λ²
  freqShiftBandwidthMhz: number;     // RF carrier half-bandwidth (±MHz)
  requiresRfDrive: boolean;          // no RF source → η=0 (else rated)
  deflectionPerMhzUrad: number;
  acousticVelocityMps: number;
  modulationBandwidthMhz: number;    // analog AMPLITUDE-mod bandwidth (≠ freq-shift BW)
  refractiveIndex: number;
  figureOfMeritM2: number;
  crystalLengthMm: number;
  acousticBeamWidthMm: number;
  rfPowerMaxW: number;
  acousticAxisBodyLocal: [number, number, number];
  rfPropagationDirectionBodyLocal: [number, number, number];
  diffractionOrder: number;
  braggAngularAcceptanceMrad: number;
  wavelengthRangeNm: [number, number];
}

export const aomPlugin = definePhysicsPlugin<AomParams>({
  id: "aom",
  // Canonical name matches KIND_LABELS (the UI-facing short label).
  // Legacy KIND_REGISTRY.displayName has the longer "AOM (Acousto-Optic
  // Modulator)" — that drift is captured by this plugin choosing the
  // short form, and KIND_REGISTRY consumers will pick it up via M2's
  // derive call.
  displayName: "AOM",
  componentTypes: ["aom"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "aom",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "rf", "thermal"],
    anchors: {
      // acoustic_axis is REQUIRED for the optical (Bragg) calculation: its
      // axisX is the acoustic propagation direction (perpendicular to the
      // intercept_in -> intercept_out optical axis) and is the single source
      // of truth for which way the +-1 orders fan. The optical path does NOT
      // use rf_in (that is only the RF cable connector). rf_in stays declared
      // for RF-link wiring, but the beam trace consumes acoustic_axis.
      required: ["intercept_in", "intercept_out", "acoustic_axis", "rf_in"],
      optional: [],
      needsDirection: ["rf_in", "acoustic_axis"],
      needsAperture: ["intercept_in", "intercept_out"],
    },
    alignVariant: "translate_and_bragg_rotate",
    alignToleranceMm: 25,
    alignSummary:
      "Define intercept_in / intercept_out (both with apertureMm). Align picks whichever port the upstream beam reaches first as the entry, translates that anchor onto the beam line, then rotates the body 1-D around lab tilt axis (pivot = midpoint of the two anchors = Bragg interaction point). Forward traversal uses the selected +1/-1 order; reverse traversal swaps +1 and -1 for the same mechanical Bragg tilt. " +
      "rf_in marks the SMA / coax RF drive connector on the AOM driver housing (position = jack centre on the body, direction = outward face normal = the way a mating cable plug slides on). Used purely for cable-routing visualisation in 3D — not consumed by the Bragg solver.",
    defaultParams: {
      baseEfficiency: 0.85,            // datasheet PEAK η (>85%, nom 90%)
      centerFreqMhz: 80.0,             // design centre (RF bandwidth peak)
      rfPowerForPeakW: 2.2,            // P_peak (MT80-A1.5-IR max RF)
      peakRefWavelengthNm: 1100.0,     // λ_ref for P_peak ∝ λ²
      freqShiftBandwidthMhz: 15.0,     // RF carrier half-bandwidth (±15 MHz)
      requiresRfDrive: false,          // no RF source → show rated diffraction
      deflectionPerMhzUrad: 200.0,
      acousticVelocityMps: 4200.0,
      modulationBandwidthMhz: 10.0,    // analog AMPLITUDE-mod BW (−3 dB), ≠ freq-shift BW
      refractiveIndex: 2.26,
      figureOfMeritM2: 34.5e-15,
      crystalLengthMm: 1.6,
      acousticBeamWidthMm: 1.5,
      rfPowerMaxW: 2.2,
      acousticAxisBodyLocal: [-1, 0, 0],
      rfPropagationDirectionBodyLocal: [-1, 0, 0],
      diffractionOrder: 1,
      // Generic placeholder; the physical value is the external half-width to
      // the first sinc² detuning null = n·v/(f·L). Per-asset defaultParams
      // override it (e.g. MT80-A1.5-IR ⇒ 74.2 mrad at f=80 MHz, L=1.6 mm).
      braggAngularAcceptanceMrad: 2.0,
      wavelengthRangeNm: [400, 1700],
    },
    // Phase 2 / Phase 3a: spec sheet vs knobs.
    //
    // Intrinsic (the crystal itself — replace the AOM hardware to change):
    //   baseEfficiency, acousticVelocityMps, modulationBandwidthMhz,
    //   refractiveIndex, figureOfMeritM2, crystalLengthMm,
    //   acousticBeamWidthMm, rfPowerMaxW (safety cap is a hardware limit),
    //   acousticAxisBodyLocal, rfPropagationDirectionBodyLocal,
    //   braggAngularAcceptanceMrad, deflectionPerMhzUrad.
    //
    // Operating state (knobs the user dials at experiment time):
    //   diffractionOrder. NOTE: centerFreqMhz / rfDrivePowerW are NOT
    //   stored — they are derived live from the upstream rf_source via
    //   `hydrate_aom_rf_drive` / `resolveAomRfDriveFromScene`. The
    //   intrinsic+state union therefore intentionally omits them; they
    //   live in the "derived" tier the Phase-3e ComponentPanel renders
    //   separately.
    intrinsicParamKeys: [
      "baseEfficiency",
      "centerFreqMhz",
      "rfPowerForPeakW",
      "peakRefWavelengthNm",
      "freqShiftBandwidthMhz",
      "requiresRfDrive",
      "deflectionPerMhzUrad",
      "acousticVelocityMps",
      "modulationBandwidthMhz",
      "refractiveIndex",
      "figureOfMeritM2",
      "crystalLengthMm",
      "acousticBeamWidthMm",
      "rfPowerMaxW",
      "acousticAxisBodyLocal",
      "rfPropagationDirectionBodyLocal",
      "braggAngularAcceptanceMrad",
      "wavelengthRangeNm",
    ],
    stateParamKeys: ["diffractionOrder"],
    portDomains: {
      intercept_in: "optical",
      intercept_out: "optical",
      rf_in: "rf",
    },
  },
});
