/**
 * Phase PB.3 — sample a TimingProgram at a wall-clock time and decide
 * whether the device's gate is on.
 *
 * The program holds an ordered list of TimingBlocks with [tStartNs,
 * tEndNs). At a given t_ns we find the covering block (or the most
 * recent one that ended before t_ns) and map its waveform_kind to a
 * boolean:
 *
 *   gate_on        -> true
 *   gate_off       -> false
 *   const          -> params.gateOn (bool, default true if amplitude>0)
 *   linear_ramp    -> true while inside the block (assume non-zero edge)
 *   arbitrary      -> params.gateOn (bool, default true)
 *
 * Returns `null` when we have no opinion (no program, no covering or
 * preceding block) so the caller can fall back to the static visual
 * setting on the SceneObject.
 */
import type { PulseBlasterChannel, TimingBlock, TimingProgram } from "../types/digitalTwin";

export type GateState = boolean | null;

function blockGate(block: TimingBlock): GateState {
  switch (block.waveformKind) {
    case "gate_on":
      return true;
    case "gate_off":
      return false;
    case "const": {
      const p = block.params as { gateOn?: unknown; amplitude?: unknown };
      if (typeof p.gateOn === "boolean") return p.gateOn;
      if (typeof p.amplitude === "number") return p.amplitude !== 0;
      return true;
    }
    case "linear_ramp":
      return true;
    case "arbitrary": {
      const p = block.params as { gateOn?: unknown };
      return typeof p.gateOn === "boolean" ? p.gateOn : true;
    }
    default:
      return null;
  }
}

export function evaluateProgramAt(program: TimingProgram, tNs: number): GateState {
  if (!program.blocks || program.blocks.length === 0) return null;

  const sorted = [...program.blocks].sort((a, b) => a.tStartNs - b.tStartNs);
  let lastResolved: GateState = null;

  for (const block of sorted) {
    if (block.tStartNs > tNs) break;
    if (tNs >= block.tStartNs && tNs < block.tEndNs) {
      return blockGate(block);
    }
    const g = blockGate(block);
    if (g !== null) lastResolved = g;
  }
  return lastResolved;
}

/**
 * Resolve gate state for an entire Component template. PulseBlaster
 * channels bind by Component, but TimingProgram lives per-SceneObject.
 * We pick the first SceneObject of this component that has a program
 * (a component with N instances normally shares one program, applied
 * symbolically). Then we apply PB inversion if any bound channel says
 * `invert: true` — that flip happens once at the wire, so multiple
 * inverted channels still result in a single inversion.
 */
export function evaluateComponentGateAt(args: {
  componentId: string;
  tNs: number;
  programs: TimingProgram[];
  sceneObjectIds: string[];
  pulseBlasterChannels: PulseBlasterChannel[];
}): GateState {
  const { componentId, tNs, programs, sceneObjectIds, pulseBlasterChannels } = args;
  let raw: GateState = null;
  for (const sid of sceneObjectIds) {
    const program = programs.find((p) => p.objectId === sid);
    if (!program) continue;
    const g = evaluateProgramAt(program, tNs);
    if (g !== null) {
      raw = g;
      break;
    }
  }
  if (raw === null) return null;
  const inverted = pulseBlasterChannels.some(
    (c) => c.enabled && c.invert && c.targetComponentId === componentId,
  );
  return inverted ? !raw : raw;
}

/**
 * Build a per-SceneObject gate-override map for the whole scene at
 * scrubTimeNs. Returns Map<sceneObjectId, boolean>. SceneObjects whose
 * component resolves to `null` (no program, no PB binding with active
 * inversion) are simply absent from the map — callers should treat
 * "absent" as "no override, render as configured".
 */
export function buildSceneGateOverrides(args: {
  tNs: number;
  programs: TimingProgram[];
  objects: Array<{ id: string; componentId: string }>;
  pulseBlasterChannels: PulseBlasterChannel[];
}): Map<string, boolean> {
  const { tNs, programs, objects, pulseBlasterChannels } = args;
  const out = new Map<string, boolean>();

  const objectsByComp = new Map<string, string[]>();
  for (const o of objects) {
    if (!objectsByComp.has(o.componentId)) objectsByComp.set(o.componentId, []);
    objectsByComp.get(o.componentId)!.push(o.id);
  }

  for (const [componentId, sceneObjectIds] of objectsByComp) {
    const gate = evaluateComponentGateAt({
      componentId,
      tNs,
      programs,
      sceneObjectIds,
      pulseBlasterChannels,
    });
    if (gate === null) continue;
    for (const sid of sceneObjectIds) out.set(sid, gate);
  }

  return out;
}

/** Total duration of the longest program in the scene, in ns. Used as
 *  the upper bound of the scrub-time slider. Falls back to 1 µs when
 *  the scene has no programs. */
export function inferScrubTimeMaxNs(programs: TimingProgram[]): number {
  let maxNs = 0;
  for (const p of programs) {
    if (p.durationNs > maxNs) maxNs = p.durationNs;
    for (const b of p.blocks ?? []) {
      if (b.tEndNs > maxNs) maxNs = b.tEndNs;
    }
  }
  return maxNs > 0 ? maxNs : 1000;
}
