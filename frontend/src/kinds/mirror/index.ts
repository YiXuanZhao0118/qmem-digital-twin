/**
 * Mirror — flat reflective optical element.
 *
 * Render: CylinderGeometry (disc) with optical axis along local +X,
 * +X face is the reflective surface. Rendered procedurally via
 * `createPrimitive` switch case in loadAsset.ts. M6 will inline that
 * geometry into this folder's `renderer.ts`.
 */
import { definePhysicsPlugin } from "../_plugin";

export interface MirrorParams extends Record<string, unknown> {
  reflectivity: number;
}

export const mirrorPlugin = definePhysicsPlugin<MirrorParams>({
  id: "mirror",
  displayName: "Mirror",
  componentTypes: ["mirror"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  physics: {
    elementKind: "mirror",
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
      "Reflective face center translates onto incoming beam. User dials in U/V offset + rx/ry/rz to aim reflection. The face needs a normal direction so the ray-tracer knows which side of the plane the beam reflects off.",
    defaultParams: { reflectivity: 0.99 },
  },
});
