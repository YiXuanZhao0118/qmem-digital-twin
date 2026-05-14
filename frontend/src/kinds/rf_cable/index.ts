import { definePhysicsPlugin } from "../_plugin";

export interface RfCableParams extends Record<string, unknown> {
  lengthMm: number;
  impedanceOhm: number;
  maxFrequencyGhz: number;
  connectorType: string;
  cableType: string;
  jacketOuterDiameterMm: number;
  jacketColor: string;
  workingVoltageVRms: number | null;
  dielectricVoltageVRms: number | null;
  minBendRadiusMm: number;
}

export const rfCablePlugin = definePhysicsPlugin<RfCableParams>({
  id: "rf_cable",
  displayName: "RF Cable",
  // Legacy `sma_cable` componentType promotes to the same kind so old
  // QMEM jumpers in the catalog migrate without DB rewrite.
  componentTypes: ["rf_cable", "sma_cable"],
  assetCategory: "electronics",
  catalogGroup: "RF",
  physics: {
    elementKind: "rf_cable",
    primaryDomain: "rf",
    defaultPhysics: ["rf"],
    anchors: {
      required: ["rf_in", "rf_out"],
      optional: [],
      needsDirection: ["rf_in", "rf_out"],
    },
    alignVariant: "none",
    alignToleranceMm: 25,
    alignSummary:
      "Bidirectional coaxial RF cable. rf_in (End A) and rf_out (End B) mark the two SMA / BNC / N connector tips; both directions are OUTWARD face normals (pointing away from the cable body, the way a mating plug would slide on). Cable physics (impedance, max frequency, connector type, jacket OD) lives in RfCableParams. Spline editing UX (analogous to fiber's Edit fiber path) is a follow-up — current visual is parametric straight cable.",
    defaultParams: {
      lengthMm: 152.0,
      impedanceOhm: 50.0,
      maxFrequencyGhz: 3.0,
      connectorType: "sma",
      cableType: "RG-316",
      jacketOuterDiameterMm: 3.2,
      jacketColor: "#c4a884",
      workingVoltageVRms: null,
      dielectricVoltageVRms: null,
      minBendRadiusMm: 15.0,
    },
  },
});
