/**
 * Sample a TimingProgram at a wall-clock time and decide whether its
 * output is HIGH.
 *
 * After alembic 0045/0046 the program is just a list of [start, end)
 * intervals; output is HIGH inside any interval and LOW outside. The
 * ``invert`` flag on the program flips the result before it leaves the
 * wire (active-low).
 */
import type { TimingProgram } from "../types/digitalTwin";

export type GateState = boolean;

/** Returns true if any interval covers ``tNs`` (with the program's
 *  ``invert`` flag applied). False otherwise. */
export function evaluateProgramAt(program: TimingProgram, tNs: number): GateState {
  const raw = (program.intervals ?? []).some(
    (iv) => tNs >= iv.spinCoreStartNs && tNs < iv.spinCoreEndNs,
  );
  return program.invert ? !raw : raw;
}

/**
 * Per-SceneObject gate-override map at ``tNs``. After alembic 0045/0046
 * TimingPrograms are top-level (not per-object); the binding from an
 * object to the program(s) gating it lives in
 * ``objects.properties.gateBindings[].timingProgramId`` once the binding
 * resolver lands. Until then, no scene-wide gate overrides are emitted —
 * the scrub-time visualisation falls back to the static configured state.
 */
export function buildSceneGateOverrides(
  // Args kept for caller-site compat; ignored until binding resolver lands.
  _args: {
    tNs: number;
    programs: TimingProgram[];
    objects: Array<{ id: string; componentId: string }>;
  },
): Map<string, boolean> {
  return new Map();
}

/** Upper bound of the scrub-time slider, in ns. Returns the max interval
 *  end across all programs, or 1 µs when the scene has no intervals. */
export function inferScrubTimeMaxNs(programs: TimingProgram[]): number {
  let maxNs = 0;
  for (const p of programs) {
    for (const iv of p.intervals ?? []) {
      if (iv.spinCoreEndNs > maxNs) maxNs = iv.spinCoreEndNs;
    }
  }
  return maxNs > 0 ? maxNs : 1000;
}
