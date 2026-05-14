import { definePhysicsPlugin } from "../_plugin";

export interface DichroicMirrorParams extends Record<string, unknown> {
  cutoffWavelengthNm: number;
  passBand: "long" | "short" | "band";
  transmission: number;
  reflectivity: number;
}

export const dichroicMirrorPlugin = definePhysicsPlugin<DichroicMirrorParams>({
  id: "dichroic_mirror",
  displayName: "Dichroic Mirror",
  componentTypes: ["dichroic_mirror"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "dichroic_mirror",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    anchors: {
      required: ["intercept_face"],
      optional: [],
      needsDirection: ["intercept_face"],
    },
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Same as mirror — face center + normal direction, then user aims via U/V + rotation.",
    defaultParams: {
      cutoffWavelengthNm: 700.0,
      passBand: "long",
      transmission: 0.95,
      reflectivity: 0.95,
    },
  },
});
