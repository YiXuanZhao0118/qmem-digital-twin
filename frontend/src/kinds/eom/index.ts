/**
 * EOM — electro-optic modulator.
 *
 * Two modulation regimes share one kind, selected by `modulationKind`:
 *
 *   - "phase"     — a bulk crystal that adds a drive-dependent retardance
 *                   δ = π·V/Vπ to the slow Jones component. The beam keeps
 *                   its incoming tilt/offset and propagates through a slab.
 *   - "amplitude" — a Mach-Zehnder intensity modulator. The two arms
 *                   interfere, so the drive shows up as a power transmission
 *                   T(φ) rather than a retardance:
 *
 *                       φ = π·(V_rf/Vπ_rf + V_bias/Vπ_bias)
 *                       T = IL · (1 + m·cos φ) / (1 + m),   m = (r−1)/(r+1)
 *
 *                   with r = 10^(extinctionRatioDb/10) and IL =
 *                   10^(−insertionLossDb/10). T peaks at exactly IL and
 *                   bottoms out at IL/r, which is what a datasheet quotes.
 *
 * `fiberPigtailed` picks the geometry, independently of the modulation:
 * a pigtailed part guides the light internally, so the output leaves
 * `intercept_out` as the pigtail's fundamental mode (waist = coreMfdUm/2,
 * incoming tilt erased) exactly like the fiber op — NOT as a free-space
 * beam that propagated the length of the package. A bulk part keeps the
 * slab passthrough.
 *
 * `driveVoltageV` / `biasVoltageV` are the two KNOBS (`stateParamKeys`): the
 * asset carries a baseline, a per-instance value lives in
 * SceneObject.dynamic_sources and wins, and that is what a sequence drives.
 *
 * Polarization: a guided modulator is single-polarization. Whenever the part
 * is a waveguide (an MZ always is; so is anything pigtailed) only the
 * component on `intercept_in`'s axisY — the TM / modulated axis — passes,
 * and the orthogonal one is suppressed by `polarizationExtinctionRatioDb`.
 * The output is linear on that axis. A bulk phase crystal is NOT filtered:
 * it stays a pure retarder.
 */
import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";

export interface EomParams extends Record<string, unknown> {
  vPiV: number;
  modulationKind: "phase" | "amplitude";
  /** DC bias half-wave voltage. Only read when modulationKind is amplitude. */
  biasVPiV: number;
  /**
   * Polarization extinction of the WAVEGUIDE, dB. A guided modulator is
   * single-polarization: only the component on the anchor's axisY (the TM /
   * modulated axis) gets through, the orthogonal one is suppressed by this
   * much. Read whenever the part is a waveguide — modulationKind
   * "amplitude" (an MZ always is one) or fiberPigtailed.
   */
  polarizationExtinctionRatioDb: number;
  /** Fibre-to-fibre (or face-to-face) loss at peak transmission, dB. */
  insertionLossDb: number;
  /** On/off contrast of the MZ, dB. Only read when modulationKind is amplitude. */
  extinctionRatioDb: number;
  /** Pigtailed part: the output is re-emitted as the fibre's fundamental mode. */
  fiberPigtailed: boolean;
  /** Pigtail mode-field diameter (µm) — sets the exit waist when pigtailed. */
  coreMfdUm: number;
  /** RF drive, V. A KNOB: per-instance in dynamic_sources, driven by a sequence. */
  driveVoltageV: number;
  /** DC bias, V. The other knob — sets the operating point on the MZ curve. */
  biasVoltageV: number;
  wavelengthRangeNm: [number, number];
}

const EOM_ROLES: RolesMap = {
  intercept_in: { min: 1, domain: "optical", aperture: true, fastAxis: true },
  intercept_out: { min: 0, domain: "optical" },
  // The RF drive jack on the modulator housing. Optional: a bulk crystal in
  // a mount has no connector of its own. Like the AOM's rf_in it is used for
  // cable routing only — the drive voltage reaches the op through
  // dynamic_sources.driveVoltageV, not through the RF graph.
  rf_in: { min: 0, domain: "rf", direction: true },
};

export const eomPlugin = definePhysicsPlugin<EomParams>({
  id: "eom",
  displayName: "EOM",
  componentTypes: ["eom"],
  assetCategory: "optical",
  catalogGroup: "Active / Nonlinear",
  physics: {
    elementKind: "eom",
    primaryDomain: "optical",
    defaultPhysics: ["optical", "rf"],
    roles: EOM_ROLES,
    anchors: anchorContractFromRoles(EOM_ROLES),
    // No whole-object align. A pigtailed modulator's ports are the FC/APC
    // connectors bound at them, each on its own flexible pigtail, so they
    // are aligned one at a time (Object panel -> Align -> "Align End A/B",
    // `PigtailEndAlignControls`) while the box stays bolted down. Pointing
    // the whole part at a beam would drag the other end off whatever it was
    // already plugged into — the same reason `fiber` opts out. Tolerance
    // stays 25 mm: the per-end UX uses it.
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Per-END align: each port connector (binding properties.portAnchor) "
      + "snaps to a beam or fibre receptacle within 25 mm, persisted as an "
      + "ObjectBinding delta. The instrument body does not move.",
    // The two drive voltages are the only per-instance knobs; everything
    // else is spec-sheet. Declaring stateParamKeys is what puts them in the
    // Object panel (via the asset's tunableParams seed) and their values in
    // SceneObject.dynamic_sources.
    intrinsicParamKeys: [
      "vPiV",
      "modulationKind",
      "biasVPiV",
      "insertionLossDb",
      "extinctionRatioDb",
      "polarizationExtinctionRatioDb",
      "fiberPigtailed",
      "coreMfdUm",
      "wavelengthRangeNm",
    ],
    stateParamKeys: ["driveVoltageV", "biasVoltageV"],
    defaultParams: {
      vPiV: 5.0,
      modulationKind: "phase",
      biasVPiV: 5.0,
      insertionLossDb: 0.0,
      extinctionRatioDb: 30.0,
      polarizationExtinctionRatioDb: 20.0,
      fiberPigtailed: false,
      coreMfdUm: 5.3,
      driveVoltageV: 0.0,
      biasVoltageV: 0.0,
      wavelengthRangeNm: [400, 1700],
    },
  },
});
