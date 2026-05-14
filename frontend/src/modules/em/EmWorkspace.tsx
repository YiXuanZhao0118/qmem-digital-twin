/**
 * EM workspace — Phase C.7 of the multiphysics platform.
 *
 * Three-pane layout, same shell idea as ElectronicsWorkspace:
 *   - left:   EM problems list + Mesh upload chip
 *   - center: selected EM problem editor (ports, freq sweep, mesh pick)
 *   - right:  latest run's S-parameters — reuses the Smith chart +
 *             magnitude plot from Phase B.7's Touchstone viewer because
 *             palace's output happens to be the same shape (freqHz +
 *             sParams dict with [re, im] entries).
 *
 * Phase C.5 ships a mock palace solver that returns a synthetic
 * Lorentzian S-matrix so this UI is exercisable end-to-end without
 * the workstation. Phase C.4 swaps the runner to SshWorkstationRunner
 * with no UI change.
 */
import { Play, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useResizablePanes } from "../../components/workspace/useResizablePanes";
import { useSceneStore } from "../../store/sceneStore";
import type { EmFieldPayload } from "../../types/digitalTwin";
import { FieldViewer } from "./FieldViewer";
import { NetworkAnalysisChart } from "./NetworkAnalysisChart";

const STARTER_FREQ_SWEEP = {
  startGhz: 1,
  stopGhz: 10,
  points: 51,
  scale: "linear" as const,
};

const STARTER_PORTS = [
  { id: "p1", name: "input", anchorBindingId: null, impedanceOhm: 50, mode: "tem" as const },
  { id: "p2", name: "output", anchorBindingId: null, impedanceOhm: 50, mode: "tem" as const },
];

export function EmWorkspace() {
  const emProblems = useSceneStore((s) => s.emProblems);
  const selectedId = useSceneStore((s) => s.selectedEmProblemId);
  const setSelected = useSceneStore((s) => s.setSelectedEmProblem);
  const loadEm = useSceneStore((s) => s.loadEmProblems);
  const createEm = useSceneStore((s) => s.createEmProblem);
  const updateEm = useSceneStore((s) => s.updateEmProblem);
  const deleteEm = useSceneStore((s) => s.deleteEmProblem);
  const meshes = useSceneStore((s) => s.meshes);
  const loadMeshes = useSceneStore((s) => s.loadMeshes);
  const uploadMesh = useSceneStore((s) => s.uploadMesh);
  const dispatchSimulationRun = useSceneStore((s) => s.dispatchSimulationRun);
  const recentRuns = useSceneStore((s) => s.recentSimulationRuns);
  const loadRecentRuns = useSceneStore((s) => s.loadRecentSimulationRuns);

  const [busy, setBusy] = useState<"idle" | "saving" | "running" | "uploading">("idle");
  const [error, setError] = useState<string | null>(null);
  const meshInputRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const { startDrag } = useResizablePanes({
    id: "em",
    containerRef: workspaceRef,
  });

  useEffect(() => {
    void loadEm();
    void loadMeshes();
    void loadRecentRuns("em_fem", 20);
  }, [loadEm, loadMeshes, loadRecentRuns]);

  const selected = useMemo(
    () => emProblems.find((e) => e.id === selectedId) ?? null,
    [emProblems, selectedId],
  );

  const onNew = async () => {
    setError(null);
    setBusy("saving");
    try {
      await createEm({
        name: `EM problem ${emProblems.length + 1}`,
        ports: STARTER_PORTS,
        freqRangeGhz: STARTER_FREQ_SWEEP,
        boundaryConditions: { pecAnchorBindingIds: [], absorbingAnchorBindingIds: [] },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete EM problem "${selected.name}"?`)) return;
    setError(null);
    setBusy("saving");
    try {
      await deleteEm(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onRun = async () => {
    if (!selected) return;
    setError(null);
    setBusy("running");
    try {
      await dispatchSimulationRun({
        module: "em_fem",
        params: { emProblemId: selected.id },
      });
      await loadRecentRuns("em_fem", 20);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onMeshUpload = async (file: File | null) => {
    if (!file) return;
    setError(null);
    setBusy("uploading");
    try {
      await uploadMesh(file);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        (err instanceof Error ? err.message : String(err));
      setError(msg);
    } finally {
      setBusy("idle");
    }
  };

  const latestForEm = useMemo(() => {
    if (!selected) return null;
    return (
      recentRuns.find(
        (r) =>
          r.module === "em_fem" &&
          (r.params as { emProblemId?: string } | undefined)?.emProblemId === selected.id,
      ) ?? null
    );
  }, [recentRuns, selected?.id]);

  return (
    <div ref={workspaceRef} className="electronics-workspace">
      <aside className="electronics-sidebar">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">EM problems</span>
          <button
            type="button"
            className="electronics-icon-btn"
            title="New EM problem"
            onClick={onNew}
            disabled={busy !== "idle"}
          >
            <Plus size={14} />
          </button>
        </header>
        <ul className="electronics-circuit-list">
          {emProblems.length === 0 && (
            <li className="electronics-empty">No EM problems — click + to add one.</li>
          )}
          {emProblems.map((em) => (
            <li
              key={em.id}
              className={`electronics-circuit-row${em.id === selectedId ? " active" : ""}`}
              onClick={() => setSelected(em.id)}
            >
              <span className="electronics-circuit-name">{em.name}</span>
              <span className="electronics-circuit-bytes">{em.ports.length}p</span>
            </li>
          ))}
        </ul>

        <header className="electronics-sidebar-header" style={{ marginTop: "auto" }}>
          <span className="electronics-sidebar-title">Meshes</span>
          <button
            type="button"
            className="electronics-icon-btn"
            title="Upload .msh"
            onClick={() => meshInputRef.current?.click()}
            disabled={busy !== "idle"}
          >
            <Upload size={14} />
          </button>
          <input
            ref={meshInputRef}
            type="file"
            accept=".msh"
            style={{ display: "none" }}
            onChange={(e) => onMeshUpload(e.target.files?.[0] ?? null)}
          />
        </header>
        <ul className="electronics-circuit-list" style={{ flex: "0 0 auto", maxHeight: 140 }}>
          {meshes.length === 0 && (
            <li className="electronics-empty">No meshes uploaded.</li>
          )}
          {meshes.map((m) => (
            <li key={m.id} className="electronics-circuit-row">
              <span className="electronics-circuit-name">{m.name}</span>
              <span className="electronics-circuit-bytes">
                {(m.fileSizeBytes / 1024).toFixed(0)}KB
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <div
        className="ws-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize problems panel"
        onPointerDown={startDrag("left")}
      />

      <section className="electronics-editor">
        {selected ? (
          <EmProblemEditor
            problem={selected}
            meshes={meshes}
            onSave={async (patch) => {
              setError(null);
              setBusy("saving");
              try {
                await updateEm(selected.id, patch);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy("idle");
              }
            }}
            onRun={onRun}
            onDelete={onDelete}
            busy={busy}
          />
        ) : (
          <div className="electronics-no-selection">
            Select an EM problem on the left, or click + to create one.
          </div>
        )}
        {error && <div className="electronics-error">{error}</div>}
      </section>

      <div
        className="ws-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize results panel"
        onPointerDown={startDrag("right")}
      />

      <aside className="electronics-results">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">Latest run</span>
        </header>
        {latestForEm ? (
          <EmRunResultPreview run={latestForEm} />
        ) : (
          <div className="electronics-empty">
            No run for this problem yet — click <strong>Run</strong>.
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EM problem editor (center pane)
// ---------------------------------------------------------------------------

type EditorProps = {
  problem: ReturnType<typeof useSceneStore.getState>["emProblems"][number];
  meshes: ReturnType<typeof useSceneStore.getState>["meshes"];
  onSave: (patch: {
    name: string;
    meshId: string | null;
    ports: typeof problem.ports;
    freqRangeGhz: NonNullable<typeof problem.freqRangeGhz>;
  }) => Promise<void>;
  onRun: () => Promise<void>;
  onDelete: () => Promise<void>;
  busy: "idle" | "saving" | "running" | "uploading";
};

function EmProblemEditor({ problem, meshes, onSave, onRun, onDelete, busy }: EditorProps) {
  const [name, setName] = useState(problem.name);
  const [meshId, setMeshId] = useState<string | null>(problem.meshId);
  const [ports, setPorts] = useState(problem.ports);
  const [freq, setFreq] = useState(
    problem.freqRangeGhz ?? { startGhz: 1, stopGhz: 10, points: 51, scale: "linear" as const },
  );

  // Re-sync drafts when the selected problem changes.
  useEffect(() => {
    setName(problem.name);
    setMeshId(problem.meshId);
    setPorts(problem.ports);
    setFreq(
      problem.freqRangeGhz ?? { startGhz: 1, stopGhz: 10, points: 51, scale: "linear" as const },
    );
  }, [problem.id]);

  const dirty =
    problem.name !== name ||
    problem.meshId !== meshId ||
    JSON.stringify(problem.ports) !== JSON.stringify(ports) ||
    JSON.stringify(problem.freqRangeGhz) !== JSON.stringify(freq);

  return (
    <>
      <header className="electronics-editor-header">
        <input
          type="text"
          className="electronics-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="electronics-btn"
          disabled={!dirty || busy !== "idle"}
          onClick={() => onSave({ name, meshId, ports, freqRangeGhz: freq })}
        >
          {busy === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="electronics-btn primary"
          disabled={busy !== "idle"}
          onClick={onRun}
          title="Run palace (mock in Phase C.5; real in C.4)"
        >
          <Play size={14} /> {busy === "running" ? "Running…" : "Run"}
        </button>
        <button
          type="button"
          className="electronics-btn danger"
          disabled={busy !== "idle"}
          onClick={onDelete}
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </header>

      <div className="em-editor-body">
        <section className="em-editor-section">
          <h3>Mesh</h3>
          <select
            className="em-editor-select"
            value={meshId ?? ""}
            onChange={(e) => setMeshId(e.target.value || null)}
          >
            <option value="">— none —</option>
            {meshes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.elementCount ? ` (${m.elementCount} el)` : ""}
              </option>
            ))}
          </select>
        </section>

        <section className="em-editor-section">
          <h3>Frequency sweep</h3>
          <div className="em-editor-row">
            <label>
              Start (GHz)
              <input
                type="number"
                step="0.1"
                value={freq.startGhz}
                onChange={(e) => setFreq({ ...freq, startGhz: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Stop (GHz)
              <input
                type="number"
                step="0.1"
                value={freq.stopGhz}
                onChange={(e) => setFreq({ ...freq, stopGhz: parseFloat(e.target.value) || 0 })}
              />
            </label>
            <label>
              Points
              <input
                type="number"
                min={2}
                max={2001}
                value={freq.points}
                onChange={(e) => setFreq({ ...freq, points: parseInt(e.target.value) || 51 })}
              />
            </label>
            <label>
              Scale
              <select
                value={freq.scale}
                onChange={(e) =>
                  setFreq({ ...freq, scale: e.target.value as "linear" | "log" })
                }
              >
                <option value="linear">linear</option>
                <option value="log">log</option>
              </select>
            </label>
          </div>
        </section>

        <section className="em-editor-section">
          <h3>Ports</h3>
          <table className="em-port-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Z₀ (Ω)</th>
                <th>Mode</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ports.map((p, idx) => (
                <tr key={p.id}>
                  <td>
                    <input
                      type="text"
                      value={p.id}
                      onChange={(e) => {
                        const next = [...ports];
                        next[idx] = { ...p, id: e.target.value };
                        setPorts(next);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={p.name}
                      onChange={(e) => {
                        const next = [...ports];
                        next[idx] = { ...p, name: e.target.value };
                        setPorts(next);
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      step="1"
                      value={p.impedanceOhm}
                      onChange={(e) => {
                        const next = [...ports];
                        next[idx] = { ...p, impedanceOhm: parseFloat(e.target.value) || 50 };
                        setPorts(next);
                      }}
                    />
                  </td>
                  <td>
                    <select
                      value={p.mode}
                      onChange={(e) => {
                        const next = [...ports];
                        next[idx] = { ...p, mode: e.target.value as "te" | "tm" | "tem" };
                        setPorts(next);
                      }}
                    >
                      <option value="tem">tem</option>
                      <option value="te">te</option>
                      <option value="tm">tm</option>
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="em-port-remove"
                      title="Remove port"
                      onClick={() => setPorts(ports.filter((_, i) => i !== idx))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            className="electronics-btn"
            style={{ marginTop: 6 }}
            onClick={() =>
              setPorts([
                ...ports,
                {
                  id: `p${ports.length + 1}`,
                  name: `port${ports.length + 1}`,
                  anchorBindingId: null,
                  impedanceOhm: 50,
                  mode: "tem",
                },
              ])
            }
          >
            + Add port
          </button>
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Result preview (right pane)
// ---------------------------------------------------------------------------

function EmRunResultPreview({
  run,
}: {
  run: ReturnType<typeof useSceneStore.getState>["recentSimulationRuns"][number];
}) {
  const rs = run.resultSummary as
    | {
        emProblemName?: string;
        nPorts?: number;
        z0?: number;
        freqHz?: number[];
        sParams?: Record<string, [number, number][]>;
        solverNote?: string;
        field?: EmFieldPayload;
      }
    | null;

  return (
    <div className="electronics-result-preview">
      <dl className="electronics-result-meta">
        <div>
          <dt>Status</dt>
          <dd className={`status-${run.status}`}>{run.status}</dd>
        </div>
        {rs?.emProblemName && (
          <div>
            <dt>Problem</dt>
            <dd>{rs.emProblemName}</dd>
          </div>
        )}
        {typeof rs?.nPorts === "number" && (
          <div>
            <dt>Ports</dt>
            <dd>{rs.nPorts}</dd>
          </div>
        )}
        {typeof rs?.z0 === "number" && (
          <div>
            <dt>Z₀ (Ω)</dt>
            <dd>{rs.z0.toFixed(0)}</dd>
          </div>
        )}
      </dl>
      {rs?.solverNote && (
        <div className="em-solver-note">{rs.solverNote}</div>
      )}
      {run.errorMessage && (
        <div className="electronics-error">{run.errorMessage}</div>
      )}
      {rs?.sParams && rs.freqHz && run.status === "completed" && (
        <NetworkAnalysisChart
          freqHz={rs.freqHz}
          nPorts={rs.nPorts ?? 1}
          sParams={rs.sParams}
        />
      )}
      {rs?.field && run.status === "completed" && <FieldViewer field={rs.field} />}
    </div>
  );
}
