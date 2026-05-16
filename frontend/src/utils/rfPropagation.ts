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
  TimingProgram,
} from "../types/digitalTwin";
import { isPhysicsPlugin, type RfTransferSignal } from "../kinds/_plugin";
import { pluginForKind } from "../kinds/_plugins";

/** Singleton empty set for the default "nothing powered off" case —
 *  avoids allocating a fresh Set per buildRfPropagation call. */
const EMPTY_POWERED_OFF: ReadonlySet<string> = new Set<string>();

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
  /** Pre-resolved TTL state per rf_switch object (HIGH | LOW). Populated
   *  in `buildRfPropagation`'s pre-pass before BFS starts so the switch
   *  transfer can decide which throw is active without re-walking the
   *  graph. Other passthrough kinds ignore this field. */
  switchTtlStates: ReadonlyMap<string, "HIGH" | "LOW">;
  /** Object ids whose Instrument Power toggle is OFF
   *  (`device_states.state.power === false`). A transfer that finds its
   *  own objectId here returns null to drop the signal — the physical
   *  device has no DC bias and passes nothing. */
  poweredOffObjectIds: ReadonlySet<string>;
}) => Array<{ outputAnchorName: string; outgoing: RfSignalState }> | null;

const rfAmplifierTransfer: PassthroughTransfer = ({
  incoming,
  kindParams,
  anchors,
  objectId,
  poweredOffObjectIds,
}) => {
  if (poweredOffObjectIds.has(objectId)) return null;
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

type RfSwitchParamsShape = {
  ttlActiveHighThrow?: number;
  ttlState?: "HIGH" | "LOW";
  throwCount?: number;
  insertionLossDb?: number;
};

const rfSwitchTransfer: PassthroughTransfer = ({
  incoming,
  kindParams,
  anchors,
  objectId,
  switchTtlStates,
  poweredOffObjectIds,
}) => {
  if (poweredOffObjectIds.has(objectId)) return null;
  const params = (kindParams as RfSwitchParamsShape) ?? {};
  const state = switchTtlStates.get(objectId) ?? params.ttlState ?? "LOW";
  const highThrowRaw = params.ttlActiveHighThrow;
  const highThrow =
    typeof highThrowRaw === "number" && Number.isFinite(highThrowRaw) ? Math.trunc(highThrowRaw) : 2;
  let active: number;
  if (state === "HIGH") {
    active = highThrow;
  } else {
    const throwCountRaw = params.throwCount;
    const throwCount =
      typeof throwCountRaw === "number" && Number.isFinite(throwCountRaw)
        ? Math.trunc(throwCountRaw)
        : 2;
    if (throwCount === 2) {
      active = 3 - highThrow;
    } else {
      // SP3T+ on a single TTL line: LOW is ambiguous → no path active.
      return [];
    }
  }
  const targetName = `RF${active}`;
  const activeAnchor = anchors.find(
    (a) => a.id === "rf_out" && (a.name ?? "").toUpperCase() === targetName,
  );
  if (!activeAnchor) return [];
  const ilDbRaw = params.insertionLossDb;
  const ilDb =
    typeof ilDbRaw === "number" && Number.isFinite(ilDbRaw) ? ilDbRaw : 1.0;
  const ilLinear = Math.pow(10, -ilDb / 20);
  const outgoing: RfSignalState = {
    frequencyMhz: incoming.frequencyMhz,
    vpp: incoming.vpp * ilLinear,
    sourceObjectId: incoming.sourceObjectId,
    sourceAnchorName: incoming.sourceAnchorName,
    cumulativeGainDb: incoming.cumulativeGainDb - ilDb,
    passthroughObjectIds: [...incoming.passthroughObjectIds, objectId],
    saturated: incoming.saturated,
  };
  return [{ outputAnchorName: activeAnchor.name ?? activeAnchor.id, outgoing }];
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
  rf_switch: rfSwitchTransfer,
};

/** Geometric "does ``tNs`` fall inside any HIGH interval of the program?".
 *  Pure interval lookup. Intervals always assert HIGH (positive logic) —
 *  the PPG's `restState` does NOT flip interval meaning. Rest state is
 *  consulted separately, only when the user has scrub stopped (see
 *  `idleRestMode` in `buildRfPropagation`). */
function ppgIntervalCovers(
  program: TimingProgram | undefined,
  tNs: number,
): boolean {
  if (!program) return false;
  for (const iv of program.intervals ?? []) {
    if (iv.spinCoreStartNs <= tNs && iv.spinCoreEndNs > tNs) return true;
  }
  return false;
}

/** Look up a passthrough transfer for the given kind. Prefers the
 *  plugin-declared `rfTransfer` (Phase 5 pattern); falls back to the
 *  module-level `PASSTHROUGH_BY_KIND` map for kinds that pre-date the
 *  migration. Returns `null` for sinks / un-passthrough kinds. */
function lookupPassthrough(elementKind: string): PassthroughTransfer | null {
  // rf_switch routing needs the pre-resolved TTL map and is not portable to
  // the plugin-level `rfTransfer` (which doesn't see global propagation
  // context); always use the local transfer for it.
  if (elementKind === "rf_switch") return PASSTHROUGH_BY_KIND.rf_switch ?? null;
  const plugin = pluginForKind(elementKind);
  if (plugin && isPhysicsPlugin(plugin) && plugin.physics.rfTransfer) {
    const tr = plugin.physics.rfTransfer;
    return ({ inputAnchorName, incoming, kindParams, anchors, objectId, poweredOffObjectIds }) => {
      // Power gate runs before the plugin's RF transfer: an unbiased
      // passthrough produces no output regardless of what its own
      // physics says.
      if (poweredOffObjectIds.has(objectId)) return null;
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
  /** TimingPrograms in the scene; used by the rf_switch TTL resolver to
   *  decide a switch's active throw when a PPG is wired to its ttl_in.
   *  Pass an empty array (or omit) to fall back to the switch's manual
   *  ttlState param. */
  timingPrograms?: readonly TimingProgram[];
  /** Current scrub-time cursor in ns. When provided, every PPG-driven
   *  switch evaluates its bound TimingProgram at this time (HIGH iff
   *  any interval covers it) — so routing follows the scrub bar in
   *  real time. Ignored when ``idleRestMode`` is true. */
  scrubTimeNs?: number | null;
  /** True when sampling the system's "scrub stopped" idle state. In
   *  this mode the switch TTL comes from the PPG's `restState` only —
   *  intervals are NOT consulted. Used by the propagation schedule to
   *  build the dedicated rest snapshot returned when the scrub-time
   *  bar is OFF. */
  idleRestMode?: boolean;
  /** Object ids whose `device_states.state.power` is False (Instrument
   *  Power panel toggle OFF). rf_source seeding is skipped for these,
   *  and rf_amplifier / rf_switch transfers drop incoming signal. Pass
   *  an empty set (or omit) when nothing is powered off. */
  poweredOffObjectIds?: ReadonlySet<string>;
}): RfPropagationResult {
  const { objects, components, assets, physicsElements } = args;
  const timingPrograms = args.timingPrograms ?? [];
  const scrubTimeNs = args.scrubTimeNs ?? 0;
  const idleRestMode = args.idleRestMode === true;
  const poweredOffObjectIds = args.poweredOffObjectIds ?? EMPTY_POWERED_OFF;
  const cables = readCables(objects, physicsElements);
  const adj = buildAdjacency(cables);
  const anchorsByObj = buildAnchorsByObject(objects, components, assets);
  const peByObj = new Map<string, PhysicsElement>();
  for (const pe of physicsElements) peByObj.set(pe.objectId, pe);

  // TTL pre-pass: for each rf_switch, look one hop up its ttl_in cable.
  // If the peer is a PPG with a bound TimingProgram, derive HIGH/LOW
  // by evaluating the program at the current scrub time; else use the
  // switch's manual `ttlState` param.
  const programById = new Map<string, TimingProgram>();
  for (const p of timingPrograms) programById.set(p.id, p);
  const switchTtlStates = new Map<string, "HIGH" | "LOW">();
  for (const pe of physicsElements) {
    if (pe.elementKind !== "rf_switch") continue;
    const anchors = anchorsByObj.get(pe.objectId) ?? [];
    const ttl = anchors.find((a) => a.id === "ttl_in");
    const manual =
      ((pe.kindParams as { ttlState?: "HIGH" | "LOW" })?.ttlState) ?? "LOW";
    if (!ttl) {
      switchTtlStates.set(pe.objectId, manual);
      continue;
    }
    const ttlName = ttl.name ?? ttl.id;
    const peers = adj.get(portKey(pe.objectId, ttlName)) ?? [];
    let derived: "HIGH" | "LOW" | null = null;
    for (const peer of peers) {
      const peerPe = peByObj.get(peer.targetObjectId);
      if (!peerPe || peerPe.elementKind !== "programmable_pulse_generator") continue;
      const ppgParams = peerPe.kindParams as
        | { timingProgramId?: string; restState?: "HIGH" | "LOW" }
        | undefined;
      if (idleRestMode) {
        // Scrub-stop / idle: rest_state alone drives the TTL. We don't
        // consult the program here (the user can wire a PPG without a
        // program and still pick HIGH or LOW idle).
        derived = ppgParams?.restState === "HIGH" ? "HIGH" : "LOW";
        break;
      }
      const programId = ppgParams?.timingProgramId;
      if (!programId) continue;
      const program = programById.get(programId);
      // Active scrub: intervals always assert HIGH (positive logic).
      // restState is intentionally NOT applied here — the user's spec
      // is that rest only affects the idle / scrub-stopped state, not
      // the meaning of the user-drawn HIGH blocks during playback.
      derived = ppgIntervalCovers(program, scrubTimeNs) ? "HIGH" : "LOW";
      break;
    }
    switchTtlStates.set(pe.objectId, derived ?? manual);
  }

  const signalAtPort = new Map<RfPortKey, RfSignalState>();

  // BFS queue. Each entry says "this is the signal that arrived at port K".
  type Visit = { key: RfPortKey; signal: RfSignalState };
  const queue: Visit[] = [];

  // Seed: every rf_source channel's anchor emits its raw signal AT that
  // anchor (the source itself). Then we walk outward via cables.
  //
  // Seeding strategy — per-anchor, not per-explicit-channel:
  //   1. Index any persisted `channels[]` entries by anchorName so the
  //      user's typed freq / amp can override the default for that
  //      anchor.
  //   2. Walk EVERY rf_out anchor on the source asset and emit one seed
  //      per anchor. Anchors with a matching channels[] entry use the
  //      persisted values; the rest fall back to 80 MHz / amp = 1.0
  //      (same defaults as `EditableAd9959Row`).
  //
  //   The earlier version short-circuited when channels[] had ANY entry,
  //   which broke multi-channel chains the moment the user committed
  //   only CH0: CH1..CH3 had no explicit channel and got no seed, so
  //   any cable hanging off CH1/CH2/CH3 saw "no upstream". Anchoring on
  //   the asset's rf_out list instead guarantees every physical SMA
  //   port emits a signal regardless of edit history.
  for (const pe of physicsElements) {
    if (pe.elementKind !== "rf_source") continue;
    // Power gate: unbiased AD9959 / synth produces nothing on any anchor.
    if (poweredOffObjectIds.has(pe.objectId)) continue;
    const params = pe.kindParams as RfSourceParams;
    const explicitChannels = params.channels ?? [];
    const persistedByAnchor = new Map<
      string,
      { frequencyMhz: number; amplitudeScale: number }
    >();
    for (const ch of explicitChannels) {
      if (!ch.anchorName) continue;
      persistedByAnchor.set(ch.anchorName, {
        frequencyMhz: ch.frequencyMhz,
        amplitudeScale: ch.amplitudeScale ?? 0,
      });
    }
    const anchors = anchorsByObj.get(pe.objectId) ?? [];
    type SourceSeed = { anchorName: string; frequencyMhz: number; amplitudeScale: number };
    const seeds: SourceSeed[] = [];
    for (const a of anchors) {
      if (a.id !== "rf_out") continue;
      const anchorName = a.name ?? a.id;
      const persisted = persistedByAnchor.get(anchorName);
      seeds.push({
        anchorName,
        frequencyMhz: persisted?.frequencyMhz ?? 80.0,
        amplitudeScale: persisted?.amplitudeScale ?? 1.0,
      });
    }
    // If the source asset has no anchor metadata (degenerate case —
    // catalog row predates the anchor contract), fall back to whatever
    // explicit channels[] does contain so we still emit something.
    if (seeds.length === 0) {
      for (const ch of explicitChannels) {
        if (!ch.anchorName) continue;
        seeds.push({
          anchorName: ch.anchorName,
          frequencyMhz: ch.frequencyMhz,
          amplitudeScale: ch.amplitudeScale ?? 0,
        });
      }
    }
    for (const seed of seeds) {
      const signal: RfSignalState = {
        frequencyMhz: seed.frequencyMhz,
        vpp: seed.amplitudeScale * AD9959_VPP_FULL_SCALE,
        sourceObjectId: pe.objectId,
        sourceAnchorName: seed.anchorName,
        cumulativeGainDb: 0,
        passthroughObjectIds: [],
        saturated: false,
      };
      const sourceKey = portKey(pe.objectId, seed.anchorName);
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
        switchTtlStates,
        poweredOffObjectIds,
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
