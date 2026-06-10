import { definePhysicsPlugin } from "../_plugin";

export interface WaveplateParams extends Record<string, unknown> {
  retardanceDeg: number;
  lengthMm: number;
  refractiveIndex: number;
  wavelengthRangeNm: [number, number];
}

export const waveplatePlugin = definePhysicsPlugin<WaveplateParams>({
  id: "waveplate",
  displayName: "Waveplate",
  componentTypes: ["waveplate"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "waveplate",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_in"],
      optional: [],
      needsDirection: ["intercept_in"],
      needsAperture: ["intercept_in"],
      needsFastAxis: ["intercept_in"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Pick the flat face on the wireframe (sets intercept_in position). Asset-level fast-axis angle is set in PHY Editor → Optical → Components on the intercept_in anchor (fastAxisDegBodyLocal). Per-instance rotation around the beam axis is set in the Object panel.",
    defaultParams: {
      retardanceDeg: 180,            // HWP; op reads degrees (QWP = 90)
      lengthMm: 2,                   // slab L for q-propagation L/n
      refractiveIndex: 1.54,         // crystalline quartz n_o
      wavelengthRangeNm: [400, 1100],
    },
    intrinsicParamKeys: [
      "retardanceDeg",
      "lengthMm",
      "refractiveIndex",
      "wavelengthRangeNm",
    ],
    stateParamKeys: [],
    portDomains: { intercept_in: "optical" },
  },
});
