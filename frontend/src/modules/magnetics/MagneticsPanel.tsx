/**
 * Magnetics overlay panel — Phase F+ inside Optics workspace.
 *
 * Floating panel (defaultLayout in WorkspaceProvider; opened via the
 * Window menu) that lets the user:
 *   - Browse / create / select a MagneticsProblem
 *   - Pick coils (multi-select) — including coils linked to
 *     SceneObjects in the current Optics 3D scene
 *   - Configure the eval region (centre + size + grid resolution)
 *   - Click Run -> POST simulation_runs {module:'magnetics_dc'}
 *   - View the resulting |B| volume via FieldViewer (vtk.js)
 *
 * 3D streamline overlay in the Three.js scene is a follow-up commit;
 * for Phase F+ MVP the volume rendering inside the panel is enough to
 * see Helmholtz uniformity / MOT gradient zero.
 */
import { Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createCoilApi,
  createMagneticsProblemApi,
  deleteCoilApi,
  deleteMagneticsProblemApi,
  fetchCoilsApi,
  fetchMagneticsProblemsApi,
  updateMagneticsProblemApi,
} from "../../api/client";
import { useSceneStore } from "../../store/sceneStore";
import type {
  Coil,
  EmFieldPayload,
  MagneticsEvalRegion,
  MagneticsProblem,
} from "../../types/digitalTwin";
import { FieldViewer } from "../em/FieldViewer";
import { FloatingPanel } from "../../components/workspace/FloatingPanel";

const DEFAULT_REGION: MagneticsEvalRegion = {
  centerMm: [0, 0, 0],
  sizeMm: [200, 200, 200],
  gridDim: [16, 16, 16],
};

export function MagneticsPanel() {
  const [coils, setCoils] = useState<Coil[]>([]);
  const [problems, setProblems] = useState<MagneticsProblem[]>([]);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"idle" | "saving" | "running">("idle");
  const [error, setError] = useState<string | null>(null);

  const dispatchSimulationRun = useSceneStore((s) => s.dispatchSimulationRun);
  const recentRuns = useSceneStore((s) => s.recentSimulationRuns);
  const loadRecentRuns = useSceneStore((s) => s.loadRecentSimulationRuns);

  const refresh = async () => {
    try {
      const [cs, ps] = await Promise.all([
        fetchCoilsApi(200),
        fetchMagneticsProblemsApi(100),
      ]);
      setCoils(cs);
      setProblems(ps);
      if (!selectedProblemId && ps.length > 0) setSelectedProblemId(ps[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    void loadRecentRuns("magnetics_dc", 20);
  }, []);

  const selected = useMemo(
    () => problems.find((p) => p.id === selectedProblemId) ?? null,
    [problems, selectedProblemId],
  );

  const onNewProblem = async () => {
    setBusy("saving");
    setError(null);
    try {
      const created = await createMagneticsProblemApi({
        name: `Magnetics ${problems.length + 1}`,
        coilIds: coils.slice(0, 2).map((c) => c.id),
        evalRegion: DEFAULT_REGION,
      });
      setProblems((prev) => [created, ...prev]);
      setSelectedProblemId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onAddDemoCoil = async () => {
    setBusy("saving");
    setError(null);
    try {
      const z = (coils.length % 2 === 0 ? -25 : 25) + (coils.length / 2) * 100;
      const c = await createCoilApi({
        name: `Coil ${coils.length + 1}`,
        shape: "circular_loop",
        params: { radiusMm: 50, turns: 50, positionMm: [0, 0, z] },
        currentA: 1.0,
      });
      setCoils((prev) => [c, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onDeleteCoil = async (id: string) => {
    setBusy("saving");
    try {
      await deleteCoilApi(id);
      setCoils((prev) => prev.filter((c) => c.id !== id));
      if (selected) {
        // also remove from problem.coilIds if referenced
        const next = selected.coilIds.filter((cid) => cid !== id);
        if (next.length !== selected.coilIds.length) {
          await updateMagneticsProblemApi(selected.id, { coilIds: next });
          await refresh();
        }
      }
    } finally {
      setBusy("idle");
    }
  };

  const onDeleteProblem = async (id: string) => {
    setBusy("saving");
    try {
      await deleteMagneticsProblemApi(id);
      setProblems((prev) => prev.filter((p) => p.id !== id));
      if (selectedProblemId === id) setSelectedProblemId(null);
    } finally {
      setBusy("idle");
    }
  };

  const toggleCoil = async (coilId: string) => {
    if (!selected) return;
    const next = selected.coilIds.includes(coilId)
      ? selected.coilIds.filter((id) => id !== coilId)
      : [...selected.coilIds, coilId];
    setBusy("saving");
    try {
      const updated = await updateMagneticsProblemApi(selected.id, { coilIds: next });
      setProblems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } finally {
      setBusy("idle");
    }
  };

  const updateRegion = async (patch: Partial<MagneticsEvalRegion>) => {
    if (!selected) return;
    const nextRegion: MagneticsEvalRegion = { ...selected.evalRegion, ...patch };
    setBusy("saving");
    try {
      const updated = await updateMagneticsProblemApi(selected.id, {
        evalRegion: nextRegion,
      });
      setProblems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } finally {
      setBusy("idle");
    }
  };

  const onRun = async () => {
    if (!selected) return;
    setBusy("running");
    setError(null);
    try {
      await dispatchSimulationRun({
        module: "magnetics_dc",
        params: { magneticsProblemId: selected.id },
      });
      await loadRecentRuns("magnetics_dc", 20);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const latestForProblem = useMemo(() => {
    if (!selected) return null;
    return (
      recentRuns.find(
        (r) =>
          r.module === "magnetics_dc" &&
          (r.params as { magneticsProblemId?: string } | undefined)?.magneticsProblemId ===
            selected.id,
      ) ?? null
    );
  }, [recentRuns, selected?.id]);

  const field = (latestForProblem?.resultSummary as { field?: EmFieldPayload } | null)?.field;

  return (
    <FloatingPanel id="magnetics" title="Magnetics overlay">
      <div className="magnetics-panel">
        {error && <div className="electronics-error">{error}</div>}

        <section className="magnetics-section">
          <h3>Problems</h3>
          <div className="magnetics-row">
            <select
              className="em-editor-select"
              value={selectedProblemId ?? ""}
              onChange={(e) => setSelectedProblemId(e.target.value || null)}
            >
              <option value="">— pick problem —</option>
              {problems.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.coilIds.length} coils)
                </option>
              ))}
            </select>
            <button type="button" className="electronics-icon-btn" onClick={onNewProblem} title="New magnetics problem" disabled={busy !== "idle"}>
              <Plus size={12} />
            </button>
            {selected && (
              <button
                type="button"
                className="electronics-icon-btn"
                onClick={() => onDeleteProblem(selected.id)}
                title="Delete problem"
                disabled={busy !== "idle"}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </section>

        <section className="magnetics-section">
          <h3>Coils</h3>
          <button
            type="button"
            className="electronics-btn"
            onClick={onAddDemoCoil}
            disabled={busy !== "idle"}
            style={{ marginBottom: 4 }}
          >
            <Plus size={12} /> Add Helmholtz-style coil (R=50mm, 50 turns, 1A)
          </button>
          <ul className="magnetics-coil-list">
            {coils.length === 0 && <li className="electronics-empty">No coils yet.</li>}
            {coils.map((c) => {
              const checked = selected?.coilIds.includes(c.id) ?? false;
              return (
                <li key={c.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!selected || busy !== "idle"}
                      onChange={() => toggleCoil(c.id)}
                    />
                    <span>{c.name}</span>
                    <span className="magnetics-coil-meta">
                      {c.shape} · {c.currentA.toFixed(2)} A
                    </span>
                  </label>
                  <button
                    type="button"
                    className="em-port-remove"
                    onClick={() => onDeleteCoil(c.id)}
                    title="Delete coil"
                  >×</button>
                </li>
              );
            })}
          </ul>
        </section>

        {selected && (
          <section className="magnetics-section">
            <h3>Eval region</h3>
            <div className="magnetics-region-grid">
              {(["centerMm", "sizeMm", "gridDim"] as const).map((key) => (
                <div key={key} className="magnetics-region-row">
                  <label>{key}</label>
                  {[0, 1, 2].map((axis) => (
                    <input
                      key={axis}
                      type="number"
                      step={key === "gridDim" ? 1 : 5}
                      value={selected.evalRegion[key][axis]}
                      onChange={(e) => {
                        const next = [...selected.evalRegion[key]] as [number, number, number];
                        next[axis] = parseFloat(e.target.value) || 0;
                        updateRegion({ [key]: next } as Partial<MagneticsEvalRegion>);
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            <button
              type="button"
              className="electronics-btn primary"
              disabled={busy !== "idle" || selected.coilIds.length === 0}
              onClick={onRun}
              style={{ marginTop: 6 }}
            >
              <Play size={12} /> {busy === "running" ? "Running…" : "Run magpylib"}
            </button>
          </section>
        )}

        {latestForProblem && (
          <section className="magnetics-section">
            <h3>Latest result</h3>
            <div className="magnetics-result-meta">
              status: <strong>{latestForProblem.status}</strong>
              {latestForProblem.errorMessage && (
                <div className="electronics-error">{latestForProblem.errorMessage}</div>
              )}
              {field?.available && (
                <FieldStats data={field.data} />
              )}
            </div>
            {field && <FieldViewer field={field} />}
          </section>
        )}
      </div>
    </FloatingPanel>
  );
}

function FieldStats({ data }: { data: number[] }) {
  if (data.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const v of data) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const center = data[Math.floor(data.length / 2)];
  return (
    <div className="magnetics-stats">
      |B| min: <strong>{min.toExponential(3)}</strong> mT &nbsp;·&nbsp; max:{" "}
      <strong>{max.toExponential(3)}</strong> mT &nbsp;·&nbsp; center:{" "}
      <strong>{center.toExponential(3)}</strong> mT
    </div>
  );
}
