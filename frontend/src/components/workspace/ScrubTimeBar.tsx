/**
 * Phase PB.3 — scrub-time bar.
 *
 * Pinned to the bottom of the workspace canvas. Dragging the slider
 * sets `scrubTimeNs` in the scene store, which cascades through every
 * device's TimingProgram (and any PulseBlaster channels bound to it)
 * and gates the corresponding beam emission in the 3D scene.
 *
 * "Stop" clears `scrubTimeNs` (renders fall back to static visibility
 * flags); the bar collapses to a thin "Scrub time" pill until the user
 * activates it again.
 */
import { Clock, Play, Square } from "lucide-react";
import { useMemo } from "react";

import { useSceneStore } from "../../store/sceneStore";
import { inferScrubTimeMaxNs } from "../../utils/timingEvaluation";

function formatTimeNs(tNs: number): string {
  if (tNs >= 1_000_000) return `${(tNs / 1_000_000).toFixed(3)} ms`;
  if (tNs >= 1_000) return `${(tNs / 1_000).toFixed(3)} µs`;
  return `${tNs.toFixed(0)} ns`;
}

export function ScrubTimeBar() {
  const scrubTimeNs = useSceneStore((s) => s.scrubTimeNs);
  const setScrubTimeNs = useSceneStore((s) => s.setScrubTimeNs);
  const programs = useSceneStore((s) => s.scene.timingPrograms);

  const maxNs = useMemo(() => inferScrubTimeMaxNs(programs ?? []), [programs]);
  const active = scrubTimeNs !== null;

  if (!active) {
    return (
      <button
        type="button"
        className="scrub-time-pill"
        onClick={() => setScrubTimeNs(0)}
        title="Start scrub-time playback (samples device gates at time t)"
      >
        <Play size={11} /> Scrub time
      </button>
    );
  }

  const t = scrubTimeNs ?? 0;

  return (
    <div className="scrub-time-bar">
      <Clock size={12} className="scrub-time-icon" />
      <input
        type="range"
        min={0}
        max={maxNs}
        step={Math.max(1, Math.round(maxNs / 1000))}
        value={t}
        onChange={(e) => setScrubTimeNs(Number(e.target.value))}
        className="scrub-time-range"
      />
      <span className="scrub-time-readout" title={`${t} ns of ${maxNs} ns`}>
        {formatTimeNs(t)} / {formatTimeNs(maxNs)}
      </span>
      <button
        type="button"
        className="scrub-time-stop"
        onClick={() => setScrubTimeNs(null)}
        title="Stop scrub — return to static gate visibility"
      >
        <Square size={10} /> Stop
      </button>
    </div>
  );
}
