// RF signal propagation through the cable graph — single source of truth for
// "what RF signal is at this port?".
//
// Replaces the direct-only resolver in `aomRfDrive.ts` (which assumed
// rf_source ↔ AOM cables). With this module a cable chain like
//
//     AD9959.CH0 ──cable──► ZHL-1-2W.rf_in │ rf_out ──cable──► AOM.rf_in
//
// gets traversed end-to-end: the source channel's Vpp is propagated through
// the amplifier's gain, output-power clamp is applied, and the resulting
// state is recorded at every port the signal passes. Consumers (the RF link
// panel, the AOM Bragg solver, the backend `hydrate_aom_rf_drive` helper)
// then look up `signalAtPort.get(objectId|anchorName)` instead of duplicating
// graph-walk logic.
//
// Algorithm: forward BFS from each rf_source channel's anchor. Each visited
// port records the signal that ARRIVES at it. For "passthrough" objects
// (currently rf_amplifier — rf_switch is in the registry but we keep it as
// future work since switch state depends on TimingProgram), we additionally
// emit the transformed signal at the object's rf_out anchor(s) and continue
// the walk. Cycles are blocked by the visited-set on port keys.

import type {
  Anchor,
  Asset3D,
  ComponentItem,
  PhysicsElement,
  RfAmplifierParams,
  RfCableEndpointLink,
  RfSourceParams,
  SceneObject,
} from "../types/digitalTwin";
import { isPhysicsPlugin, type RfTransferSignal } from "../kinds/_plugin";
import { pluginForKind } from "../kinds/_plugins";

/** AD9959 single-ended into 50 Ω at default Rset has ~1.0 Vpp full-scale. */
export const AD9959_VPP_FULL_SCALE = 1.0;
/** RF load impedance for Vpp ↔ W conversion (P = Vpp² / (8·Z)). */
export const RF_LOAD_Z_OHM = 50.0;

/** Vpp ↔ W under a sinusoid into resistive Z: P = Vpp² / (8·Z). */
export function vppToPowerW(vpp: number, zOhm: number = RF_LOAD_Z_OHM): number {
  return (vpp * vpp) / (8 * zOhm);
}

/** W → Vpp inverse: Vpp = √(8·Z·P). */
export function powerWToVpp(p: number, zOhm: number = RF_LOAD_Z_OHM): number {
  return Math.sqrt(8 * zOhm * Math.max(0, p));
}

/** dBm → W. */
export function dbmToW(dbm: number): number {
  return Math.pow(10, (dbm - 30) / 10);
}

/** Port identifier: `${objectId}|${anchorName}`. anchorName is unique within
 *  a SceneObject's asset, so this is sufficient for graph keys. */
export type RfPortKey = string;

export function portKey(objectId: string, anchorName: string): RfPortKey {
  return `${objectId}|${anchorName}`;
}

export type RfSignalState = {
  frequencyMhz: number;
  vpp: number;
  /** rf_source object id that originated this signal. */
  sourceObjectId: string;
  /** rf_source anchor (channel anchorName) that originated this signal. */
  sourceAnchorName: string;
  /** Cumulative linear gain applied from the source to this point.
   *  1.0 means no amplification (raw source). 10^(gainDb/20) for a single
   *  ZHL-1-2W. Useful for the panel readout. */
  cumulativeGainDb: number;
  /** SceneObject ids of passthrough nodes (amplifiers, switches) traversed
   *  on the way to this port. Ordered source → here. */
  passthroughObjectIds: readonly string[];
  /** True when an output-power clamp (P1dB / max-output) limited the Vpp
   *  along the chain. The panel can flag this. */
  saturated: boolean;
};

// Compile-time pin: RfSignalState must stay assignable to RfTransferSignal
// (the structural type defined in `kinds/_plugin.ts` so plugin transfers
// don't have to depend on this module). If you change the shape of one,
// update the other — the assignment line below will fail to type-check
// when they drift, surfacing the mismatch immediately.
const _signalTypePin: RfTransferSignal | null = null as unknown as RfSignalState | null;
void _signalTypePin;

export type RfPropagationResult = {
  /** Signal arriving at (or emitted from) each port in the scene. For
   *  source rf_out ports this is the source's own state; for sink rf_in
   *  ports it's the post-chain state; for passthrough rf_out ports it's
   *  the post-transform state. */
  signalAtPort: ReadonlyMap<RfPortKey, RfSignalState>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CableEndpoint = { targetObjectId: string; targetAnchorName: string };

/** A cable between two ports, plus the cable's own SceneObject id. */
type CableEdge = {
  cableObjectId: string;
  a: CableEndpoint;
  b: CableEndpoint;
};

function readCables(
  objects: readonly SceneObject[],
  physicsElements: readonly PhysicsElement[],
): CableEdge[] {
  const peByObj = new Map<string, PhysicsElement>();
  for (const pe of physicsElements) peByObj.set(pe.objectId, pe);
  const edges: CableEdge[] = [];
  for (const obj of objects) {
    const pe = peByObj.get(obj.id);
    if (pe?.elementKind !== "rf_cable") continue;
    const eps = (obj.properties as {
      rfCableEndpoints?: { A?: RfCableEndpointLink; B?: RfCableEndpointLink };
    }).rfCableEndpoints;
    const a = eps?.A;
    const b = eps?.B;
    if (!a || !b) continue;
    edges.push({
      cableObjectId: obj.id,
      a: { targetObjectId: a.targetObjectId, targetAnchorName: a.targetAnchorName },
      b: { targetObjectId: b.targetObjectId, targetAnchorName: b.targetAnchorName },
    });
  }
  return edges;
}

/** Indexed view of cables: port key → list of peer endpoints. Undirected,
 *  since cables don't carry intrinsic direction. */
function buildAdjacency(edges: readonly CableEdge[]): Map<RfPortKey, CableEndpoint[]> {
  const adj = new Map<RfPortKey, CableEndpoint[]>();
  const push = (key: RfPortKey, peer: CableEndpoint) => {
    const arr = adj.get(key);
    if (arr) arr.push(peer);
    else adj.set(key, [peer]);
  };
  for (const e of edges) {
    push(portKey(e.a.targetObjectId, e.a.targetAnchorName), e.b);
    push(portKey(e.b.targetObjectId, e.b.targetAnchorName), e.a);
  }
  return adj;
}

/** Anchors keyed by SceneObject id. Resolves through Component → Asset3D. */
function buildAnchorsByObject(
  objects: readonly SceneObject[],
  components: readonly ComponentItem[],
  assets: readonly Asset3D[],
): Map<string, readonly Anchor[]> {
  const compById = new Map<string, ComponentItem>(components.map((c) => [c.id, c]));
  const assetById = new Map<string, Asset3D>(assets.map((a) => [a.id, a]));
  const out = new Map<string, readonly Anchor[]>();
  for (const obj of objects) {
    const c = compById.get(obj.componentId);
    const a = c?.asset3dId ? assetById.get(c.asset3dId) : undefined;
    out.set(obj.id, a?.anchors ?? []);
  }
  return out;
}

/** Find an anchor by its role (rf_in / rf_out). Returns the first match —
 *  for kinds with multiple rf_out anchors (rf_switch) the caller needs a
 *  kind-specific resolver. For now (rf_amplifier) the single-port-per-role
 *  assumption holds. */
function findAnchorByRole(
  anchors: readonly Anchor[],
  role: "rf_in" | "rf_out",
): Anchor | undefined {
  return anchors.find((a) => a.id === role);
}

// ---------------------------------------------------------------------------
// Transfer functions per passthrough kind
// ---------------------------------------------------------------------------

/** A passthrough description: given an input port and its incoming signal,
 *  return the (output port name, transformed signal) pairs to fan out to.
 *  Returns null for sinks (AOM, horn_antenna, …) so the BFS stops there. */
type PassthroughTransfer = (args: {
  inputAnchorName: string;
  incoming: RfSignalState;
  kindParams: unknown;
  anchors: readonly Anchor[];
  objectId: string;
}) => Array<{ outputAnchorName: string; outgoing: RfSignalState }> | null;

const rfAmplifierTransfer: PassthroughTransfer = ({
  incoming,
  kindParams,
  anchors,
  objectId,
}) => {
  const params = kindParams as RfAmplifierParams;
  const outAnchor = findAnchorByRole(anchors, "rf_out");
  if (!outAnchor) return null;
  const gainDb = params.gainDb ?? 0;
  const gainLinear = Math.pow(10, gainDb / 20);
  let outVpp = incoming.vpp * gainLinear;
  let saturated = incoming.saturated;
  const maxDbm = params.outputPowerMaxDbm;
  if (typeof maxDbm === "number" && Number.isFinite(maxDbm)) {
    const maxW = dbmToW(maxDbm);
    const maxVpp = powerWToVpp(maxW);
    if (outVpp > maxVpp) {
      outVpp = maxVpp;
      saturated = true;
    }
  }
  const outgoing: RfSignalState = {
    frequencyMhz: incoming.frequencyMhz,
    vpp: outVpp,
    sourceObjectId: incoming.sourceObjectId,
    sourceAnchorName: incoming.sourceAnchorName,
    cumulativeGainDb: incoming.cumulativeGainDb + gainDb,
    passthroughObjectIds: [...incoming.passthroughObjectIds, objectId],
    saturated,
  };
  return [{ outputAnchorName: outAnchor.name ?? outAnchor.id, outgoing }];
};

/** Legacy registry of passthrough transfers — kept as a fallback for
 *  kinds that haven't migrated to declaring `rfTransfer` at the plugin
 *  level (Phase 5). The walker first consults
 *  `plugin.physics.rfTransfer`; if absent, it falls back here. New RF
 *  passthrough kinds should declare `rfTransfer` in their plugin folder
 *  instead — see `kinds/rf_amplifier/transfer.ts` for the canonical
 *  example. */
const PASSTHROUGH_BY_KIND: Record<string, PassthroughTransfer | undefined> = {
  rf_amplifier: rfAmplifierTransfer,
};

/** Look up a passthrough transfer for the given kind. Prefers the
 *  plugin-declared `rfTransfer` (Phase 5 pattern); falls back to the
 *  module-level `PASSTHROUGH_BY_KIND` map for kinds that pre-date the
 *  migration. Returns `null` for sinks / un-passthrough kinds. */
function lookupPassthrough(elementKind: string): PassthroughTransfer | null {
  const plugin = pluginForKind(elementKind);
  if (plugin && isPhysicsPlugin(plugin) && plugin.physics.rfTransfer) {
    const tr = plugin.physics.rfTransfer;
    return ({ inputAnchorName, incoming, kindParams, anchors, objectId }) => {
      const result = tr({
        inputAnchorName,
        incoming,
        kindParams: (kindParams ?? {}) as Readonly<Record<string, unknown>>,
        anchors,
        objectId,
      });
      if (!result) return null;
      // Adapt readonly arrays from the plugin contract back into the
      // mutable arrays the walker has historically used. Cheap; runs
      // once per passthrough hop.
      return result.map((r) => ({
        outputAnchorName: r.outputAnchorName,
        outgoing: {
          ...r.outgoing,
          passthroughObjectIds: [...r.outgoing.passthroughObjectIds],
        } as RfSignalState,
      }));
    };
  }
  return PASSTHROUGH_BY_KIND[elementKind] ?? null;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export function buildRfPropagation(args: {
  objects: readonly SceneObject[];
  components: readonly ComponentItem[];
  assets: readonly Asset3D[];
  physicsElements: readonly PhysicsElement[];
}): RfPropagationResult {
  const { objects, components, assets, physicsElements } = args;
  const cables = readCables(objects, physicsElements);
  const adj = buildAdjacency(cables);
  const anchorsByObj = buildAnchorsByObject(objects, components, assets);
  const peByObj = new Map<string, PhysicsElement>();
  for (const pe of physicsElements) peByObj.set(pe.objectId, pe);

  const signalAtPort = new Map<RfPortKey, RfSignalState>();

  // BFS queue. Each entry says "this is the signal that arrived at port K".
  type Visit = { key: RfPortKey; signal: RfSignalState };
  const queue: Visit[] = [];

  // Seed: every rf_source channel's anchor emits its raw signal AT that
  // anchor (the source itself). Then we walk outward via cables.
  for (const pe of physicsElements) {
    if (pe.elementKind !== "rf_source") continue;
    const params = pe.kindParams as RfSourceParams;
    for (const ch of params.channels ?? []) {
      if (!ch.anchorName) continue;
      const signal: RfSignalState = {
        frequencyMhz: ch.frequencyMhz,
        vpp: (ch.amplitudeScale ?? 0) * AD9959_VPP_FULL_SCALE,
        sourceObjectId: pe.objectId,
        sourceAnchorName: ch.anchorName,
        cumulativeGainDb: 0,
        passthroughObjectIds: [],
        saturated: false,
      };
      const sourceKey = portKey(pe.objectId, ch.anchorName);
      signalAtPort.set(sourceKey, signal);
      queue.push({ key: sourceKey, signal });
    }
  }

  // BFS. The visited set is implicit: a port keeps the FIRST signal we
  // recorded for it. If two source channels feed into the same downstream
  // port (e.g. via a combiner), we'd need to model superposition — for
  // Phase 1 this is out of scope and we just keep the first arrival.
  while (queue.length > 0) {
    const { key, signal } = queue.shift()!;
    const neighbors = adj.get(key);
    if (!neighbors) continue;
    for (const peer of neighbors) {
      const peerKey = portKey(peer.targetObjectId, peer.targetAnchorName);
      if (signalAtPort.has(peerKey)) continue;
      // Record the signal arriving at the peer port. For sink ports
      // (AOM rf_in, horn_antenna rf_in, …) this is the final answer.
      signalAtPort.set(peerKey, signal);
      // If the peer object is a passthrough, transform the signal and
      // emit at its output ports.
      const peerPe = peByObj.get(peer.targetObjectId);
      if (!peerPe) continue;
      const transfer = lookupPassthrough(peerPe.elementKind);
      if (!transfer) continue;
      const anchors = anchorsByObj.get(peer.targetObjectId) ?? [];
      const outputs = transfer({
        inputAnchorName: peer.targetAnchorName,
        incoming: signal,
        kindParams: peerPe.kindParams,
        anchors,
        objectId: peer.targetObjectId,
      });
      if (!outputs) continue;
      for (const out of outputs) {
        const outKey = portKey(peer.targetObjectId, out.outputAnchorName);
        if (signalAtPort.has(outKey)) continue;
        signalAtPort.set(outKey, out.outgoing);
        queue.push({ key: outKey, signal: out.outgoing });
      }
    }
  }

  return { signalAtPort };
}
