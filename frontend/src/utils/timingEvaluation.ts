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
  // Find the block covering tNs and return its gate state. Outside any
  // block the device is OFF — channels don't latch past a block's end,
  // matching how SpinCore programs are normally authored (each
  // interval gets an explicit drive).
  if (!program.blocks || program.blocks.length === 0) return null;
  for (const block of program.blocks) {
    if (tNs >= block.tStartNs && tNs < block.tEndNs) {
      return blockGate(block);
    }
  }
  return false;
}

/**
 * Phase RF.3 — evaluate the full waveform value at tNs, not just the
 * boolean gate. Returns:
 *   - `gate`         — same as `evaluateProgramAt`
 *   - `amplitude`    — 0..1 scalar; const = params.amplitude (or 1 if gate), linear_ramp = lerp(start,end), arbitrary = nearest sample, gate_on=1, gate_off=0
 *   - `frequencyMhz` — params.frequencyMhz if the block sets it (else null)
 *   - `phaseDeg`     — params.phaseDeg if the block sets it (else null)
 *
 * Used by the Object panel to show instantaneous RF state when the
 * scrub-time slider is active. Stays pure / synchronous.
 */
export type ProgramValues = {
  gate: GateState;
  amplitude: number;
  frequencyMhz: number | null;
  phaseDeg: number | null;
};

function blockAmplitude(block: TimingBlock, tNs: number): number {
  const params = block.params as Record<string, unknown>;
  switch (block.waveformKind) {
    case "gate_on":
      return 1;
    case "gate_off":
      return 0;
    case "const": {
      if (typeof params.amplitude === "number") return params.amplitude;
      if (typeof params.value === "number") return params.value;
      const g = blockGate(block);
      return g === false ? 0 : 1;
    }
    case "linear_ramp": {
      const start = typeof params.start === "number" ? params.start : 0;
      const end = typeof params.end === "number" ? params.end : 1;
      const span = block.tEndNs - block.tStartNs;
      if (span <= 0) return start;
      const f = (tNs - block.tStartNs) / span;
      return start + (end - start) * Math.max(0, Math.min(1, f));
    }
    case "arbitrary": {
      const samples = Array.isArray(params.samples) ? (params.samples as unknown[]) : [];
      const dtNs = typeof params.dtNs === "number" ? params.dtNs : 0;
      if (samples.length === 0 || dtNs <= 0) return 1;
      const idx = Math.min(samples.length - 1, Math.max(0, Math.floor((tNs - block.tStartNs) / dtNs)));
      const v = samples[idx];
      return typeof v === "number" ? v : 1;
    }
    default:
      return 1;
  }
}

export function evaluateProgramValuesAt(
  program: TimingProgram,
  tNs: number,
): ProgramValues {
  if (!program.blocks || program.blocks.length === 0) {
    return { gate: null, amplitude: 0, frequencyMhz: null, phaseDeg: null };
  }
  for (const block of program.blocks) {
    if (tNs >= block.tStartNs && tNs < block.tEndNs) {
      const params = block.params as Record<string, unknown>;
      return {
        gate: blockGate(block),
        amplitude: blockAmplitude(block, tNs),
        frequencyMhz:
          typeof params.frequencyMhz === "number" ? params.frequencyMhz : null,
        phaseDeg: typeof params.phaseDeg === "number" ? params.phaseDeg : null,
      };
    }
  }
  return { gate: false, amplitude: 0, frequencyMhz: null, phaseDeg: null };
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
