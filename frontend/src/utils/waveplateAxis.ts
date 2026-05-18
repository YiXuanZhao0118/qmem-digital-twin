// Effective waveplate fast-axis angle (deg, beam-local).
//
// Composition (2026-05-18 asset-level refactor):
//   asset.anchors[intercept_in].fastAxisDegBodyLocal  — PHY Editor
// + sceneObject.properties.rotationAroundBeamAxisDeg  — Object pane knob
// = effective angle fed to the Jones-matrix solver.

import type { Asset3D, SceneObject } from "../types/digitalTwin";

const INTERCEPT_IN = "intercept_in";

export function computeWaveplateFastAxisDeg(
  sceneObject: SceneObject | { properties?: SceneObject["properties"] } | null | undefined,
  asset: Asset3D | null | undefined,
): number {
  const anchor = asset?.anchors?.find((a) => a.id === INTERCEPT_IN);
  const base = typeof anchor?.fastAxisDegBodyLocal === "number"
    ? anchor.fastAxisDegBodyLocal
    : 0;
  const props = sceneObject?.properties as Record<string, unknown> | undefined;
  const rot = typeof props?.rotationAroundBeamAxisDeg === "number"
    ? (props.rotationAroundBeamAxisDeg as number)
    : 0;
  return base + rot;
}
