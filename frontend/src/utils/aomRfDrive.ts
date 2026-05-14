// AOM RF drive resolver — frontend mirror of `hydrate_aom_rf_drive` in
// `backend/app/solvers/optics_seq.py`. Used by:
//   - `rayTrace.ts` AOM branch (Bragg angle + sideband intensities)
//   - `AomAdjustControls` in `PhysicsElementPanel.tsx` (live η preview +
//     "Synced from …" read-out)
//
// After Phase B (RF link single-source-of-truth) the AOM's `centerFreqMhz`
// and `rfDrivePowerW` are no longer stored on the AOM itself. They are
// resolved at read time from the upstream `rf_source` channel via the
// AOM's rf_in `rfCableEndpoints` link. Vpp ↔ W conversion mirrors the
// backend exactly so the frontend ray-trace and the backend solver agree.
//
// Keep these constants in sync with the same names in
// `RfLinkPanel.tsx` and `optics_seq.py` — they encode the AD9959 → 50 Ω
// drive-level model. Stays here so all consumers import from one spot.

import type { PhysicsElement, RfSourceParams, SceneObject } from "../types/digitalTwin";

/** AD9959 single-ended into 50 Ω at default Rset has ~1.0 Vpp full-scale. */
export const AD9959_VPP_FULL_SCALE = 1.0;
/** RF load impedance for Vpp ↔ W conversion (P = Vpp² / (8·Z)). */
export const RF_LOAD_Z_OHM = 50.0;

export type ResolvedAomRfDrive = {
  frequencyMhz: number;
  /** Average power (W) into the 50 Ω load, derived from amplitudeScale via
   *  Vpp = amp × full_scale and P = Vpp²/(8·Z). */
  drivePowerW: number;
  /** Object id + anchor name of the upstream rf_source CH that drives
   *  this AOM — useful for "Synced from <source> · <CH>" read-outs. */
  sourceObjectId: string;
  sourceAnchorName: string;
};

type RfCableEndpoint = { targetObjectId: string; targetAnchorName: string };
type RfCableEndpointsProps = {
  rfCableEndpoints?: { A?: RfCableEndpoint; B?: RfCableEndpoint };
};

/** Vpp ↔ W conversion under a sinusoid into resistive Z:
 *      P_avg = (Vpp / (2√2))² / Z = Vpp² / (8 · Z)
 *  Matches the formula used in `hydrate_aom_rf_drive` (backend). */
export function vppToPowerW(vpp: number, zOhm: number = RF_LOAD_Z_OHM): number {
  return (vpp * vpp) / (8 * zOhm);
}

/** Resolve the live RF drive (freq, power) feeding an AOM by following
 *  the rf_cable that connects the AOM's rf_in anchor to an rf_source
 *  channel. Returns `null` when the AOM has no upstream cable link or
 *  the linked target is missing / not an rf_source. */
export function resolveAomRfDriveFromScene(
  aomObjectId: string,
  objects: SceneObject[],
  physicsElements: PhysicsElement[],
): ResolvedAomRfDrive | null {
  // Find a cable that touches this AOM, then identify the source side.
  for (const obj of objects) {
    const pe = physicsElements.find((p) => p.objectId === obj.id);
    if (pe?.elementKind !== "rf_cable") continue;
    const eps = (obj.properties as RfCableEndpointsProps).rfCableEndpoints;
    const a = eps?.A;
    const b = eps?.B;
    if (!a || !b) continue;
    let src: RfCableEndpoint | undefined;
    if (a.targetObjectId === aomObjectId) src = b;
    else if (b.targetObjectId === aomObjectId) src = a;
    if (!src) continue;
    const srcPe = physicsElements.find((p) => p.objectId === src!.targetObjectId);
    if (srcPe?.elementKind !== "rf_source") continue;
    const channels = (srcPe.kindParams as RfSourceParams).channels ?? [];
    const ch = channels.find((c) => c.anchorName === src!.targetAnchorName);
    if (!ch) continue;
    const freqMhz = ch.frequencyMhz;
    const amp = ch.amplitudeScale ?? 0;
    const vpp = amp * AD9959_VPP_FULL_SCALE;
    return {
      frequencyMhz: freqMhz,
      drivePowerW: vppToPowerW(vpp),
      sourceObjectId: src.targetObjectId,
      sourceAnchorName: src.targetAnchorName,
    };
  }
  return null;
}
