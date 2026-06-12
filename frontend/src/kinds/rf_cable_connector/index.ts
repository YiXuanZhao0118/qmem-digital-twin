/**
 * RF Cable Connector — the physical coax connector (SMA / BNC, male /
 * female) that terminates one end of an RF cable. A first-class catalog
 * asset so the 4 real connectors each get their own Asset3D row (plan
 * §4.2).
 *
 * Like the fibre connector, it does NOT independently participate in any
 * trace — the RF link graph reads family/gender/impedance from the two
 * end-connector params when building edges. The backend registers a
 * pass-through anchor op so a standalone hit passes through.
 *
 * Body-frame anchor convention is identical to fiber_connector (plan
 * §3.2): connect_out at origin pointing −X into the cable body; connect_in
 * at (tipMm,0,0) pointing +X is the mating face. RF connectors are
 * axisymmetric so connect_in carries no slow-axis key.
 */
import { definePhysicsPlugin } from "../_plugin";

export interface RfCableConnectorParams extends Record<string, unknown> {
  family: "sma" | "bnc";
  gender: "male" | "female";
  /** Cable-side junction → mating face length (mm) = connect_in.x. */
  tipMm: number;
  impedanceOhm: number;
  maxFreqGhz: number;
  couplingType: "thread" | "bayonet";
}

export const rfCableConnectorPlugin = definePhysicsPlugin<RfCableConnectorParams>({
  id: "rf_cable_connector",
  displayName: "RF Cable Connector",
  componentTypes: ["rf_cable_connector"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_cable_connector",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    anchors: {
      required: ["connect_in", "connect_out"],
      optional: [],
      needsDirection: ["connect_in", "connect_out"],
    },
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Coax cable connector (SMA / BNC, male / female). connect_out (−X, " +
      "origin) pins to the cable spline endpoint; connect_in (+X, at " +
      "tipMm) is the mating face. Mating requires same family + opposite " +
      "gender (plan §4.3). Not aligned standalone.",
    // Generic SMA-male template; the 4 real connectors override per-asset.
    defaultParams: {
      family: "sma",
      gender: "male",
      tipMm: 15.5,
      impedanceOhm: 50.0,
      maxFreqGhz: 18.0,
      couplingType: "thread",
    },
  },
});
