/**
 * RF propagation schedule — precompute one `RfPropagationResult` per
 * section of the user's Pulse & Timing program, keyed by the section's
 * left boundary. Section boundaries are the union of all interval
 * start/end times across every TimingProgram in the scene. Within a
 * section the TTL state of every PPG channel is constant, the switch
 * routing is constant, and therefore the propagation map is constant.
 *
 * Consumers (RfLinkPanel cable animation, DigitalTwinViewer AOM beam
 * gating, anyone else that needs "what RF is where at time t?") build
 * the schedule once against [scene + programs] and then do a cheap
 * binary-search lookup on every scrub event. Before this module each
 * scrub frame ran a full graph walk — fine for small scenes but wasted
 * work when the answer is piecewise-constant in time.
 *
 * The schedule is closed under "no programs / no switches": you still
 * get a single-snapshot schedule that always returns the same map, so
 * callers don't need a special case for the static path.
 */
import type {
  Asset3D,
  ComponentItem,
  PhysicsElement,
  SceneObject,
  TimingProgram,
} from "../types/digitalTwin";

import {
  type RfPropagationResult,
  buildRfPropagation,
  portKey,
} from "./rfPropagation";

export type RfPropagationSchedule = {
  /** Section left edges in ns. boundaries[i] is the start of snapshot i.
   *  Always contains 0 as the first element. The right edge of section
   *  i is boundaries[i+1] (or +Infinity for the last section). */
  readonly boundaries: readonly number[];
  /** Propagation snapshots, length === boundaries.length. snapshots[i]
   *  is valid for tNs ∈ [boundaries[i], boundaries[i+1]) during ACTIVE
   *  scrubbing. Computed with `idleRestMode=false` so intervals drive
   *  the switch TTL — PPG.restState is NOT consulted here. */
  readonly snapshots: readonly RfPropagationResult[];
  /** Dedicated "scrub stopped" snapshot, computed with `idleRestMode=true`
   *  so every PPG-driven switch TTL falls back to the PPG's restState
   *  (ignoring intervals). Returned by `getRfSnapshotAt(null)`. */
  readonly restSnapshot: RfPropagationResult;
};

type BuildArgs = {
  objects: readonly SceneObject[];
  components: readonly ComponentItem[];
  assets: readonly Asset3D[];
  physicsElements: readonly PhysicsElement[];
  timingPrograms?: readonly TimingProgram[];
  /** Forwarded to every snapshot — see `buildRfPropagation` for semantics.
   *  Power state is a property of the scene, not of the scrub time, so it
   *  applies uniformly to every section and to the rest snapshot. */
  poweredOffObjectIds?: ReadonlySet<string>;
};

/** Collect every distinct boundary across the program intervals + 0. */
function collectSectionStarts(
  timingPrograms: readonly TimingProgram[] | undefined,
): number[] {
  const set = new Set<number>([0]);
  for (const p of timingPrograms ?? []) {
    for (const iv of p.intervals ?? []) {
      if (Number.isFinite(iv.spinCoreStartNs) && iv.spinCoreStartNs >= 0) {
        set.add(iv.spinCoreStartNs);
      }
      if (Number.isFinite(iv.spinCoreEndNs) && iv.spinCoreEndNs >= 0) {
        set.add(iv.spinCoreEndNs);
      }
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

export function buildRfPropagationSchedule(args: BuildArgs): RfPropagationSchedule {
  const starts = collectSectionStarts(args.timingPrograms);
  const snapshots: RfPropagationResult[] = [];
  for (const s of starts) {
    // Sample propagation at the section's start tick. The pre-pass
    // inside buildRfPropagation walks `ppgIntervalCovers(program, t)`
    // which is half-open on the right (interval covers [start, end)),
    // so sampling at the LEFT edge of each section is the canonical
    // representative for that whole section. `idleRestMode=false` is
    // explicit: time-keyed snapshots ignore restState entirely.
    snapshots.push(
      buildRfPropagation({ ...args, scrubTimeNs: s, idleRestMode: false }),
    );
  }
  // Separate "scrub stopped" snapshot — switch TTL comes from the PPG's
  // restState alone, intervals are not consulted. This is what `null`
  // scrub time resolves to.
  const restSnapshot = buildRfPropagation({
    ...args,
    scrubTimeNs: 0,
    idleRestMode: true,
  });
  return { boundaries: starts, snapshots, restSnapshot };
}

/** Find the snapshot valid at time `tNs`.
 *  - `null` / `undefined` → returns the dedicated `restSnapshot` (scrub
 *    stopped, switch TTL = PPG.restState).
 *  - Finite `tNs` → returns the time-keyed snapshot for the section
 *    containing it; intervals drive switch TTL there. */
export function getRfSnapshotAt(
  schedule: RfPropagationSchedule,
  tNs: number | null | undefined,
): RfPropagationResult {
  if (tNs === null || tNs === undefined || !Number.isFinite(tNs)) {
    return schedule.restSnapshot;
  }
  const n = schedule.snapshots.length;
  if (n === 0) {
    // Defensive: a build with no objects/programs can't really hit this
    // (we always seed `0`), but return the rest snapshot rather than
    // crash.
    return schedule.restSnapshot;
  }
  if (tNs <= schedule.boundaries[0]) {
    return schedule.snapshots[0];
  }
  // Binary search for the largest boundary ≤ tNs.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (schedule.boundaries[mid] <= tNs) lo = mid;
    else hi = mid - 1;
  }
  return schedule.snapshots[lo];
}

/**
 * Derive the per-AOM gate map from a propagation snapshot. An AOM is
 * gated OFF (entry value `false`) when its rf_in port has no signal
 * or zero Vpp in this snapshot — i.e. the upstream switch routed the
 * carrier away from it, or the source itself is silent.
 *
 * Used by the 3D viewer's ray-tracer (`gateOverrides`) to skip the
 * Bragg diffraction pair on un-driven AOMs, so the beam visually
 * passes straight through.
 */
export function buildAomGateOverridesFromSnapshot(
  snapshot: RfPropagationResult,
  scene: {
    objects: readonly SceneObject[];
    components: readonly ComponentItem[];
    assets: readonly Asset3D[];
    physicsElements: readonly PhysicsElement[];
  },
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const pe of scene.physicsElements) {
    if (pe.elementKind !== "aom") continue;
    const obj = scene.objects.find((o) => o.id === pe.objectId);
    if (!obj) continue;
    const comp = scene.components.find((c) => c.id === obj.componentId);
    if (!comp || !comp.asset3dId) continue;
    const asset = scene.assets.find((a) => a.id === comp.asset3dId);
    if (!asset || !Array.isArray(asset.anchors)) continue;
    const rfIn = asset.anchors.find((a) => a.id === "rf_in");
    if (!rfIn) continue;
    const anchorName = rfIn.name ?? rfIn.id;
    const sig = snapshot.signalAtPort.get(portKey(pe.objectId, anchorName));
    if (!sig || sig.vpp <= 0) out.set(pe.objectId, false);
  }
  return out;
}
