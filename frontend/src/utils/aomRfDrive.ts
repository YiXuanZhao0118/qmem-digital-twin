// AOM RF drive resolver — frontend mirror of `hydrate_aom_rf_drive` in
// `backend/app/solvers/optics_seq.py`. Used by:
//   - `rayTrace.ts` AOM branch (Bragg angle + sideband intensities)
//   - `AomAdjustControls` in `PhysicsElementPanel.tsx` (live η preview +
//     "Synced from …" read-out)
//
// After Phase B (RF link single-source-of-truth) the AOM's `centerFreqMhz`
// and `rfDrivePowerW` are no longer stored on the AOM itself. They are
// resolved at read time from the upstream `rf_source` channel by walking
// the rf_cable graph.
//
// Phase 1 (post-Phase B) generalised the walk from "direct source→AOM
// cable only" to a full BFS through any number of passthrough nodes
// (rf_amplifier today; rf_switch / attenuator / filter as the kind set
// grows). The traversal lives in `rfPropagation.ts`; this module is now
// a thin AOM-specific façade so existing callers keep their narrow
// signature.

import type { Asset3D, ComponentItem, PhysicsElement, SceneObject } from "../types/digitalTwin";
import {
  AD9959_VPP_FULL_SCALE,
  RF_LOAD_Z_OHM,
  buildRfPropagation,
  portKey,
  vppToPowerW,
} from "./rfPropagation";

// Re-export the canonical constants so older imports keep working without
// having to know about the new module split.
export { AD9959_VPP_FULL_SCALE, RF_LOAD_Z_OHM, vppToPowerW };

export type ResolvedAomRfDrive = {
  frequencyMhz: number;
  /** Average power (W) into the 50 Ω load, derived from the propagation
   *  result (Vpp²/(8·Z)). After Phase 1 this already includes any in-line
   *  amplifier gains and output-power clamps along the chain. */
  drivePowerW: number;
  /** Object id + anchor name of the originating rf_source CH — useful for
   *  the "Synced from <source> · <CH>" read-out. Even after a multi-hop
   *  chain this points to the actual DDS channel, not the intermediate
   *  amplifier. */
  sourceObjectId: string;
  sourceAnchorName: string;
  /** Cumulative linear gain (dB) applied along the chain — 0 for a direct
   *  source→AOM hookup, ≈29 for one ZHL-1-2W in line. Exposed so callers
   *  can flag "amplified by …" in the UI. */
  cumulativeGainDb: number;
  /** True when an amplifier's output-power clamp limited the resolved Vpp.
   *  Solver + UI can warn the user about the saturation. */
  saturated: boolean;
};

/** Resolve the live RF drive (freq, power) feeding an AOM by following
 *  the rf_cable graph backwards from the AOM's rf_in anchor through any
 *  number of amplifiers / switches to the originating rf_source channel.
 *
 *  Returns `null` when the AOM has no rf_in cable, or the chain doesn't
 *  trace back to an rf_source.
 *
 *  The function delegates to `buildRfPropagation`; if you need the signal
 *  at multiple ports in one render, call `buildRfPropagation` directly
 *  and look up `signalAtPort.get(portKey(aomId, "rf_in"))` to avoid
 *  rebuilding the propagation map each time. */
export function resolveAomRfDriveFromScene(
  aomObjectId: string,
  objects: SceneObject[],
  components: ComponentItem[],
  assets: Asset3D[],
  physicsElements: PhysicsElement[],
): ResolvedAomRfDrive | null {
  const prop = buildRfPropagation({ objects, components, assets, physicsElements });
  // Try each anchor name we know the AOM might use for its RF input. In
  // practice the asset's rf_in anchor name IS "rf_in" — we look it up
  // explicitly rather than scanning so the API is predictable.
  // (The asset anchor's `name` defaults to the same string as its `id`
  // when no explicit display name is set, which is the case for all AOM
  // assets in the catalog.)
  const componentById = new Map(components.map((c) => [c.id, c]));
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const aomObj = objects.find((o) => o.id === aomObjectId);
  if (!aomObj) return null;
  const aomComp = componentById.get(aomObj.componentId);
  const aomAsset = aomComp?.asset3dId ? assetById.get(aomComp.asset3dId) : undefined;
  const rfIn = aomAsset?.anchors?.find((a) => a.id === "rf_in");
  if (!rfIn) return null;
  const signal = prop.signalAtPort.get(portKey(aomObjectId, rfIn.name ?? rfIn.id));
  if (!signal) return null;
  return {
    frequencyMhz: signal.frequencyMhz,
    drivePowerW: vppToPowerW(signal.vpp),
    sourceObjectId: signal.sourceObjectId,
    sourceAnchorName: signal.sourceAnchorName,
    cumulativeGainDb: signal.cumulativeGainDb,
    saturated: signal.saturated,
  };
}
