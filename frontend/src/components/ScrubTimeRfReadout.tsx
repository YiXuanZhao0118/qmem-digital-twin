/**
 * Phase RF.3 — instantaneous RF readout pinned to the Object panel.
 *
 * Renders only when:
 *   - `scrubTimeNs` is non-null (the user is actively sampling a time)
 *   - the selected SceneObject has a TimingProgram
 *
 * Shows the gate / amplitude / frequency / phase computed by
 * `evaluateProgramValuesAt` at the current scrub time. Read-only — the
 * authoritative editor is QM timeline editor; this is just feedback.
 */
import { Activity } from "lucide-react";

import { useSceneStore } from "../store/sceneStore";
import { evaluateProgramValuesAt } from "../utils/timingEvaluation";

export function ScrubTimeRfReadout({ sceneObjectId }: { sceneObjectId: string }) {
  const scrubTimeNs = useSceneStore((s) => s.scrubTimeNs);
  const programs = useSceneStore((s) => s.scene.timingPrograms);

  if (scrubTimeNs === null) return null;
  const program = programs?.find((p) => p.objectId === sceneObjectId);
  if (!program) return null;

  const values = evaluateProgramValuesAt(program, scrubTimeNs);
  const ampPct = Math.round(values.amplitude * 100);

  return (
    <section className="scrub-rf-readout">
      <h3>
        <Activity size={12} /> RF @ t = {scrubTimeNs.toFixed(0)} ns
      </h3>
      <div className="scrub-rf-grid">
        <span className="scrub-rf-label">Gate</span>
        <span
          className={`scrub-rf-value scrub-rf-gate-${
            values.gate === true ? "on" : values.gate === false ? "off" : "na"
          }`}
        >
          {values.gate === true ? "ON" : values.gate === false ? "OFF" : "—"}
        </span>

        <span className="scrub-rf-label">Amplitude</span>
        <span className="scrub-rf-value">
          {values.amplitude.toFixed(3)}
          <em className="scrub-rf-bar-wrapper">
            <span
              className="scrub-rf-bar"
              style={{ width: `${Math.max(0, Math.min(100, ampPct))}%` }}
            />
          </em>
        </span>

        <span className="scrub-rf-label">Frequency</span>
        <span className="scrub-rf-value">
          {values.frequencyMhz !== null ? `${values.frequencyMhz.toFixed(3)} MHz` : "—"}
        </span>

        <span className="scrub-rf-label">Phase</span>
        <span className="scrub-rf-value">
          {values.phaseDeg !== null ? `${values.phaseDeg.toFixed(1)}°` : "—"}
        </span>
      </div>
    </section>
  );
}
