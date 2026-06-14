/**
 * Mirror — flat reflective optical element.
 *
 * Render: CylinderGeometry (disc) with optical axis along local +X,
 * +X face is the reflective surface. Rendered procedurally via
 * `createPrimitive` switch case in loadAsset.ts. M6 will inline that
 * geometry into this folder's `renderer.ts`.
 */
import {
  anchorContractFromRoles,
  definePhysicsPlugin,
  type RolesMap,
} from "../_plugin";
import { renderMirror } from "./renderer";

export interface MirrorParams extends Record<string, unknown> {
  reflectivity: number;
  wavelengthRangeNm: [number, number];
}

const MIRROR_ROLES: RolesMap = {
  intercept_face: { min: 1, domain: "optical", direction: true, aperture: true },
};

export const mirrorPlugin = definePhysicsPlugin<MirrorParams>({
  id: "mirror",
  displayName: "Mirror",
  componentTypes: ["mirror"],
  assetCategory: "optical",
  catalogGroup: "Passive",
  renderer: renderMirror,
  physics: {
    elementKind: "mirror",
    primaryDomain: "optical",
    defaultPhysics: ["optical"],
    roles: MIRROR_ROLES,
    anchors: anchorContractFromRoles(MIRROR_ROLES),
    alignVariant: "translate_anchor_to_beam",
    alignToleranceMm: 25,
    alignSummary:
      "Reflective face center translates onto incoming beam. User dials in U/V offset + rx/ry/rz to aim reflection. The face needs a normal direction so the ray-tracer knows which side of the plane the beam reflects off.",
    defaultParams: { reflectivity: 0.99, wavelengthRangeNm: [400, 1100] },
  },
});
