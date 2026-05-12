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
import { Save, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  bulkUpsertPulseBlasterChannelsApi,
  fetchPulseBlasterChannelsApi,
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

  const refresh = async () => {
    try {
      const backend = await fetchPulseBlasterChannelsApi();
      const filled = fillFromBackend(backend);
      setRows(filled);
      setOriginal(filled);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FloatingPanel id="pulse-blaster" title="PulseBlaster wiring" icon={<Zap size={14} />}>
      <div className="pb-panel">
        <div className="pb-panel-header">
          <span className="pb-panel-hint">
            Map each physical TTL channel to the Component its wire drives.
            Per-device gating sequence still lives in QM timeline editor.
          </span>
          <button
            type="button"
            className="electronics-btn primary"
            onClick={onSave}
            disabled={!dirty || busy}
            title={dirty ? "Save all 24 rows" : "No changes"}
          >
            <Save size={12} /> {busy ? "Saving…" : "Save"}
          </button>
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
      </div>
    </FloatingPanel>
  );
}
