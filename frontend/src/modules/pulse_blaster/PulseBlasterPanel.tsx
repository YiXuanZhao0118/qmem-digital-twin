/**
 * PulseBlaster wiring panel — Phase F+ timing infrastructure.
 *
 * 24-row grid (configurable for PB-PRO 32) where each physical TTL output
 * channel of the SpinCore PulseBlaster gets:
 *   - a label  ("AOM RF gate", "EOM trigger", "Camera shutter", ...)
 *   - a target Component (the lab device whose gate this channel drives)
 *   - invert (bool — channel HIGH means device gate LOW, useful for
 *     active-low triggers)
 *   - enabled (bool)
 *
 * The actual gating sequence per device stays in TimingProgram (per-
 * Component); this panel is the wiring layer that says "channel N is
 * physically connected to which Component."
 *
 * Phase PB.3 will use these bindings to drive a "scrub time" mode that
 * cascades channel state changes -> kindParam toggles in the 3D scene.
 * Phase PB.4 will use them to export a single SpinCore opcode stream
 * that drives a real PulseBlaster.
 */
import { Code2, Download, Save, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  bulkUpsertPulseBlasterChannelsApi,
  compilePulseBlasterApi,
  fetchPulseBlasterChannelsApi,
  type PulseBlasterCompile,
} from "../../api/client";
import { FloatingPanel } from "../../components/workspace/FloatingPanel";
import { useSceneStore } from "../../store/sceneStore";
import type { PulseBlasterChannel } from "../../types/digitalTwin";

const N_CHANNELS = 24;

type Row = {
  channelIndex: number;
  label: string;
  targetComponentId: string | null;
  invert: boolean;
  enabled: boolean;
};

function blankRows(): Row[] {
  return Array.from({ length: N_CHANNELS }, (_, i) => ({
    channelIndex: i,
    label: "",
    targetComponentId: null,
    invert: false,
    enabled: true,
  }));
}

function fillFromBackend(backend: PulseBlasterChannel[]): Row[] {
  const out = blankRows();
  for (const ch of backend) {
    if (ch.channelIndex >= 0 && ch.channelIndex < N_CHANNELS) {
      out[ch.channelIndex] = {
        channelIndex: ch.channelIndex,
        label: ch.label,
        targetComponentId: ch.targetComponentId,
        invert: ch.invert,
        enabled: ch.enabled,
      };
    }
  }
  return out;
}

export function PulseBlasterPanel() {
  const components = useSceneStore((s) => s.scene.components);
  const [rows, setRows] = useState<Row[]>(blankRows);
  const [original, setOriginal] = useState<Row[]>(blankRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<PulseBlasterCompile | null>(null);
  const [compiling, setCompiling] = useState(false);

  const loadGlobalChannels = useSceneStore((s) => s.loadPulseBlasterChannels);

  const refresh = async () => {
    try {
      const backend = await fetchPulseBlasterChannelsApi();
      const filled = fillFromBackend(backend);
      setRows(filled);
      setOriginal(filled);
      // Keep the global cache fresh so LinkedSchematics chips and the
      // PB.3 scrub-time evaluator see the same data.
      void loadGlobalChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(rows) !== JSON.stringify(original),
    [rows, original],
  );

  const updateRow = (idx: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const onSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await bulkUpsertPulseBlasterChannelsApi(
        rows.map((r) => ({
          channelIndex: r.channelIndex,
          label: r.label,
          targetComponentId: r.targetComponentId,
          invert: r.invert,
          enabled: r.enabled,
        })),
      );
      const filled = fillFromBackend(saved);
      setRows(filled);
      setOriginal(filled);
      void loadGlobalChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCompile = async () => {
    setCompiling(true);
    setError(null);
    try {
      const result = await compilePulseBlasterApi();
      setCompiled(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompiling(false);
    }
  };

  const onDownloadPython = () => {
    if (!compiled) return;
    const blob = new Blob([compiled.pythonSource], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pulse_blaster_program.py";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <FloatingPanel id="pulse-blaster" title="PulseBlaster wiring" icon={<Zap size={14} />}>
      <div className="pb-panel">
        <div className="pb-panel-header">
          <span className="pb-panel-hint">
            Map each physical TTL channel to the Component its wire drives.
            Per-device gating sequence still lives in QM timeline editor.
          </span>
          <div className="pb-panel-actions">
            <button
              type="button"
              className="electronics-btn primary"
              onClick={onSave}
              disabled={!dirty || busy}
              title={dirty ? "Save all 24 rows" : "No changes"}
            >
              <Save size={12} /> {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="electronics-btn"
              onClick={onCompile}
              disabled={compiling}
              title="Compile bound channels + their TimingPrograms into a SpinCore opcode stream"
            >
              <Code2 size={12} /> {compiling ? "Compiling…" : "Compile"}
            </button>
          </div>
        </div>
        {error && <div className="electronics-error">{error}</div>}
        <table className="pb-table">
          <thead>
            <tr>
              <th>Ch</th>
              <th>Label</th>
              <th>Target component</th>
              <th title="Inverted (HIGH on PB = LOW on device)">Inv</th>
              <th title="Enabled (channel emits 0 when disabled)">En</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.channelIndex} className={r.enabled ? "" : "pb-row-disabled"}>
                <td className="pb-ch">{r.channelIndex}</td>
                <td>
                  <input
                    type="text"
                    value={r.label}
                    placeholder="(unused)"
                    onChange={(e) => updateRow(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    value={r.targetComponentId ?? ""}
                    onChange={(e) => updateRow(i, { targetComponentId: e.target.value || null })}
                  >
                    <option value="">— none —</option>
                    {components.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.invert}
                    onChange={(e) => updateRow(i, { invert: e.target.checked })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => updateRow(i, { enabled: e.target.checked })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {compiled && (
          <div className="pb-compile-result">
            <div className="pb-compile-meta">
              <span>
                <strong>{compiled.instructions.length}</strong> instructions ·{" "}
                <strong>{compiled.boundChannelCount}</strong> bound components ·{" "}
                <strong>{compiled.totalDurationNs.toFixed(0)}</strong> ns total
              </span>
              <button
                type="button"
                className="electronics-btn"
                onClick={onDownloadPython}
                title="Download as a .py file you can paste into a SpinCore spinapi script"
              >
                <Download size={12} /> .py
              </button>
            </div>
            <table className="pb-instr-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>TTL (24-bit)</th>
                  <th>Op</th>
                  <th>Length</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {compiled.instructions.map((inst) => (
                  <tr key={inst.index}>
                    <td className="pb-ch">{inst.index}</td>
                    <td className="pb-instr-ttl">
                      0x{inst.outputState.toString(16).toUpperCase().padStart(6, "0")}
                    </td>
                    <td className="pb-instr-op">{inst.opcode}</td>
                    <td className="pb-instr-len">
                      {inst.lengthNs > 0 ? `${inst.lengthNs.toFixed(0)} ns` : "—"}
                    </td>
                    <td className="pb-instr-note">{inst.label ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="pb-compile-source">
              <summary>spinapi Python source</summary>
              <pre>{compiled.pythonSource}</pre>
            </details>
          </div>
        )}
      </div>
    </FloatingPanel>
  );
}
