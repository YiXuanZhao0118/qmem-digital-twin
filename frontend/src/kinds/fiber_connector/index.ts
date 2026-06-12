/**
 * Fiber Connector — the physical fibre-optic connector (FC ferrule) that
 * terminates one end of a patch cable. A first-class catalog asset so the
 * 9 real connectors (APC/PC × PM/SM/MM) each get their own Asset3D row
 * (see the connector refactor plan §4.1).
 *
 * The connector itself does NOT independently participate in the trace —
 * its physics (MFD / NA / polish / return loss) is read by the cable-body
 * op from the two end-connector params. The backend registers a
 * pass-through anchor op (`anchor_ops/connector.py`) so a connector that
 * is ever hit standalone passes the beam straight through instead of
 * being absorbed as a terminal sink.
 *
 * Body-frame anchor convention (the most important contract — plan §3.2;
 * matches the existing `bakeConnectorFrame()` "cable-side end at x=0,
 * mating axis = +X"):
 *
 *     (−X) ◄── cable body / spline ──┐
 *   wire ════════════════╪══[ connector ]══╪──►  (+X) outward
 *                   connect_out        connect_in
 *                   x = 0              x = +tipMm
 *
 *   - connect_out: origin (0,0,0), direction −X (into the cable body).
 *       The spline endpoint node pins here; −X is the spline tangent at
 *       the endpoint, so the endpoint resolver never re-negates.
 *   - connect_in:  (tipMm,0,0), direction +X (outward / mating face).
 *       The ferrule end face — light enters/exits free space here, and
 *       the cable-level intercept_in/out port anchor derives from it.
 *       `axisY` keys the PM slow axis (PM-to-PM mating compares the two
 *       ends' axisY angle).
 */
import { definePhysicsPlugin } from "../_plugin";

export interface FiberConnectorParams extends Record<string, unknown> {
  /** Connector housing family. FC for now; SC/LC are a future split. */
  housing: "FC" | "SC" | "LC" | "ST";
  polish: "PC" | "APC" | "UPC";
  polishAngleDeg: number;
  fiberType: "single_mode" | "multi_mode" | "polarization_maintaining";
  /** Mode-field diameter (µm). null for multi-mode (use coreUm instead). */
  mfdUm: number | null;
  na: number;
  coreUm: number;
  claddingUm: number;
  /** Cable-side junction → ferrule tip length (mm) = connect_in.x. */
  tipMm: number;
  apertureDiameterMm: number;
  glassIndexAtDesignLambda: number;
  /** PM connectors are keyed to the slow axis; SM/MM are axisymmetric. */
  slowAxisKeyed: boolean;
  returnLossDb: number;
  wavelengthRangeNm: [number, number];
}

export const fiberConnectorPlugin = definePhysicsPlugin<FiberConnectorParams>({
  id: "fiber_connector",
  displayName: "Fiber Connector",
  componentTypes: ["fiber_connector"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "fiber_connector",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["connect_in", "connect_out"],
      optional: [],
      needsDirection: ["connect_in", "connect_out"],
      // connect_in carries the fibre-core aperture; connect_out is the
      // wire junction and needs no aperture.
      needsAperture: ["connect_in"],
    },
    // Connectors align via the cable binding (their connect_out pins to
    // the spline endpoint), never standalone — so no own align variant.
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Fibre patch-cable connector (FC ferrule). connect_out (−X, origin) " +
      "pins to the spline endpoint; connect_in (+X, at tipMm) is the " +
      "ferrule end face where light enters/exits free space and the " +
      "cable-level intercept port derives from. PM connectors key the " +
      "slow axis via connect_in.axisY. Not aligned standalone.",
    // Generic FC/PC single-mode template. The 9 real connectors override
    // these per-asset (plan §4.1); seeding is additive from this template.
    defaultParams: {
      housing: "FC",
      polish: "PC",
      polishAngleDeg: 0.0,
      fiberType: "single_mode",
      mfdUm: 5.3,
      na: 0.13,
      coreUm: 4.4,
      claddingUm: 125.0,
      tipMm: 36.28,
      apertureDiameterMm: 0.125,
      glassIndexAtDesignLambda: 1.4506,
      slowAxisKeyed: false,
      returnLossDb: 40.0,
      wavelengthRangeNm: [770.0, 790.0],
    },
  },
});
