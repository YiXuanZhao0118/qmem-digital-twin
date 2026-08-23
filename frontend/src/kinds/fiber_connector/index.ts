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
 * mating axis = +X"). **Renamed 2026-08-23 (alembic 0135)** from
 * `connect_out` / `connect_in`, so the whole fibre vocabulary reads from the
 * FIBRE's point of view instead of three unrelated conventions:
 *
 *     fiber_root ── the fibre is anchored into the cable here
 *     fiber_out  ── the fibre comes out of its own connector here
 *     fiber_in   ── a fibre goes into an instrument here (the chassis socket,
 *                   on the DEVICE asset — see kinds/detector)
 *
 * Note these are about where the FIBRE is, not which way the light travels:
 * both ends of a patch cable use this same asset, so one end's `fiber_out`
 * emits and the other's receives. Light direction is carried by axisX.
 *
 *     (−X) ◄── cable body / spline ──┐
 *   wire ════════════════╪══[ connector ]══╪──►  (+X) outward
 *                   fiber_root         fiber_out
 *                   x = 0              x = +tipMm
 *
 *   - fiber_root: origin (0,0,0), direction −X (into the cable body).
 *       The spline endpoint node pins here; −X is the spline tangent at
 *       the endpoint, so the endpoint resolver never re-negates.
 *   - fiber_out:  (tipMm,0,0), direction +X (outward / mating face).
 *       The ferrule end face — light enters/exits free space here, and
 *       the cable-level intercept_in/out port anchor derives from it. It
 *       carries the MALE connector type (`fc_pc_male` / `fc_apc_male`); the
 *       socket it mates into is a `fiber_in` carrying `*_female`.
 *       `axisY` keys the PM slow axis (PM-to-PM mating compares the two
 *       ends' axisY angle).
 *
 *   NOT in `anchor_tracer.PRIMARY_ANCHOR_IDS` — the connector is passthrough
 *   and the traced coupling happens on the synthesized `intercept_in/out`
 *   that `_synth_fiber_slot` derives from `fiber_out`. Coax keeps
 *   `connect_in` / `connect_out`: the rename was scoped to fibre, and a
 *   `fiber_*` id would be a lie on an SMA.
 */
import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  portDomainsFromRoles,
  type RolesMap,
} from "../_plugin";

export interface FiberConnectorParams extends Record<string, unknown> {
  polish: "PC" | "APC" | "UPC";
  polishAngleDeg: number;
  fiberType: "single_mode" | "multi_mode" | "polarization_maintaining";
  /** Mode-field diameter (µm). null for multi-mode. */
  mfdUm: number | null;
  na: number;
  /** PM connectors are keyed to the slow axis; SM/MM are axisymmetric. */
  slowAxisKeyed: boolean;
  returnLossDb: number;
  wavelengthRangeNm: [number, number];
}

const FIBER_CONNECTOR_ROLES: RolesMap = {
  fiber_out: { min: 1, domain: "optical", direction: true, aperture: true },
  fiber_root: { min: 1, domain: "optical", direction: true },
};

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
    roles: FIBER_CONNECTOR_ROLES,
    anchors: anchorContractFromRoles(FIBER_CONNECTOR_ROLES),
    // Derived from the roles above, which already say both anchors are
    // optical. Needed because `resolvePortDomain`'s id-prefix fallback knows
    // `intercept_*` / `fiber_*` / `rf_*` but not `connect_*`, so without this
    // the ASSET3D editor resolved domain=null for `connect_in` and hid its
    // connectorType dropdown — leaving the ferrule's `fc_*_male` value
    // invisible and uneditable in the one place it is meant to be curated.
    portDomains: portDomainsFromRoles(FIBER_CONNECTOR_ROLES),
    // Connectors align via the cable binding (their connect_out pins to
    // the spline endpoint), never standalone — so no own align variant.
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Fibre patch-cable connector. fiber_root pins to the spline endpoint; " +
      "fiber_out is the ferrule end face (anchor-defined) where light " +
      "enters/exits free space and the cable-level intercept port derives " +
      "from. PM connectors key the slow axis via fiber_out.axisY. The model " +
      "geometry/tip is defined entirely by the fiber_out/fiber_root anchors. " +
      "Not aligned standalone.",
    // Physics-essential template (spec params only; geometry lives on the
    // anchors). The real connectors override these per-asset; seeding is
    // additive from this template.
    defaultParams: {
      polish: "PC",
      polishAngleDeg: 0.0,
      fiberType: "single_mode",
      mfdUm: 5.3,
      na: 0.13,
      slowAxisKeyed: false,
      returnLossDb: 40.0,
      wavelengthRangeNm: [770.0, 790.0],
    },
  },
});
