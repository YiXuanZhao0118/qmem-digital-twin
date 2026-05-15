import { definePhysicsPlugin } from "../_plugin";

export interface WaveplateParams extends Record<string, unknown> {
  retardanceLambda: number;
  fastAxisDegBeamLocal: number;
  transmission: number;
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
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Pick the flat face on the wireframe (sets intercept_in position). Pick X/Y/Z as the fast-axis direction (stored in directionBodyLocal). Per-instance fast-axis angle around the beam stays in kindParams.fastAxisDegBeamLocal.",
    defaultParams: {
      retardanceLambda: 0.5,
      fastAxisDegBeamLocal: 0.0,
      transmission: 0.99,
    },
    // Phase 3b: split intrinsic (the cut crystal / coating spec) from
    // operating state (the rotation mount the user actually turns).
    //   retardanceLambda — fixed by the crystal cut; 0.5 = HWP, 0.25 = QWP.
    //   transmission     — fixed by AR coating quality.
    //   fastAxisDegBeamLocal — the knob (mount rotation angle).
    intrinsicParamKeys: ["retardanceLambda", "transmission"],
    stateParamKeys: ["fastAxisDegBeamLocal"],
    portDomains: { intercept_in: "optical" },
  },
});
