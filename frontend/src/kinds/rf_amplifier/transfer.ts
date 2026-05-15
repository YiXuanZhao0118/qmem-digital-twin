// Phase 5 — RF transfer function for rf_amplifier, declared at the plugin
// level so adding a new RF passthrough kind doesn't require editing the
// central `rfPropagation.ts` registry.
//
// The walker (utils/rfPropagation.ts) prefers `plugin.physics.rfTransfer`
// when set; this file is the canonical example of the pattern. Pure
// function, synchronous, no side effects. Backend parity lives in
// `backend/app/solvers/rf_propagation.py:_rf_amplifier_transfer`.

import type { RfTransfer, RfTransferOutput } from "../_plugin";
import type { RfAmplifierParams } from "../../types/digitalTwin";

/** Vpp ↔ W under a 50 Ω sinusoid: P = Vpp² / (8·Z). Kept local to this
 *  module so the transfer is self-contained and doesn't reach across the
 *  utils/rfPropagation barrier. */
function powerWToVpp(p: number, zOhm = 50): number {
  return Math.sqrt(8 * zOhm * Math.max(0, p));
}
function dbmToW(dbm: number): number {
  return Math.pow(10, (dbm - 30) / 10);
}

export const rfAmplifierTransfer: RfTransfer = ({
  incoming,
  kindParams,
  anchors,
  objectId,
}) => {
  const params = kindParams as RfAmplifierParams;
  // ZHL-1-2W has one rf_out anchor; future multi-output amps would map
  // input to multiple outputs, but that's out of scope for the canonical
  // single-port case here.
  const outAnchor = anchors.find((a) => a.id === "rf_out");
  if (!outAnchor) return null;

  const gainDb = params.gainDb ?? 0;
  const gainLinear = Math.pow(10, gainDb / 20);
  let outVpp = incoming.vpp * gainLinear;
  let saturated = incoming.saturated;

  // Output-power clamp (max output ⇒ Vpp ceiling). When the amp would
  // exceed its spec, clip to the spec and mark saturated so the UI /
  // solver can warn.
  const maxDbm = params.outputPowerMaxDbm;
  if (typeof maxDbm === "number" && Number.isFinite(maxDbm)) {
    const maxVpp = powerWToVpp(dbmToW(maxDbm));
    if (outVpp > maxVpp) {
      outVpp = maxVpp;
      saturated = true;
    }
  }

  const out: RfTransferOutput = {
    outputAnchorName: outAnchor.name ?? outAnchor.id,
    outgoing: {
      frequencyMhz: incoming.frequencyMhz,
      vpp: outVpp,
      sourceObjectId: incoming.sourceObjectId,
      sourceAnchorName: incoming.sourceAnchorName,
      cumulativeGainDb: incoming.cumulativeGainDb + gainDb,
      passthroughObjectIds: [...incoming.passthroughObjectIds, objectId],
      saturated,
    },
  };
  return [out];
};
