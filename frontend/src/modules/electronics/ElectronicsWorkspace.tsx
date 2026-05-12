/**
 * Electronics workspace — Phase B.4 of the multiphysics platform.
 *
 * Three-pane layout:
 *   - left:   circuits sidebar (list / new / delete / select)
 *   - center: SPICE netlist editor (textarea for B.4; monaco lands in B.5)
 *   - right:  most recent run's resultSummary (raw JSON for B.4;
 *             uPlot waveform chart lands in B.6)
 *
 * Run button: POST /api/simulation-runs {module:'spice', params:{circuitId}}.
 * Status updates flow through the SolverConsole panel (Phase A.6) — this
 * workspace just shows the most recent finished run for the active circuit.
 */
import { Play, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import { NetlistEditor } from "./NetlistEditor";
import { WaveformChart } from "./WaveformChart";

const STARTER_NETLIST = `* New circuit — replace with your own
* Example: voltage divider DC operating point
V1 in 0 1
R1 in mid 1k
R2 mid 0 1k
.op
.end
`;

export function ElectronicsWorkspace() {
  const circuits = useSceneStore((state) => state.circuits);
  const selectedCircuitId = useSceneStore((state) => state.selectedCircuitId);
  const setSelectedCircuit = useSceneStore((state) => state.setSelectedCircuit);
  const loadCircuits = useSceneStore((state) => state.loadCircuits);
  const createCircuit = useSceneStore((state) => state.createCircuit);
  const updateCircuit = useSceneStore((state) => state.updateCircuit);
  const deleteCircuit = useSceneStore((state) => state.deleteCircuit);
  const dispatchSimulationRun = useSceneStore((state) => state.dispatchSimulationRun);
  const recentRuns = useSceneStore((state) => state.recentSimulationRuns);
  const loadRecentSimulationRuns = useSceneStore(
    (state) => state.loadRecentSimulationRuns,
  );

  const [draftName, setDraftName] = useState("");
  const [draftNetlist, setDraftNetlist] = useState("");
  const [busy, setBusy] = useState<"idle" | "saving" | "running">("idle");
  const [error, setError] = useState<string | null>(null);

  // Initial fetch on mount.
  useEffect(() => {
    void loadCircuits();
    void loadRecentSimulationRuns("spice", 20);
  }, [loadCircuits, loadRecentSimulationRuns]);

  const selected = useMemo(
    () => circuits.find((c) => c.id === selectedCircuitId) ?? null,
    [circuits, selectedCircuitId],
  );

  // When the selected circuit changes, sync the draft fields.
  useEffect(() => {
    if (selected) {
      setDraftName(selected.name);
      setDraftNetlist(selected.netlist);
    } else {
      setDraftName("");
      setDraftNetlist("");
    }
  }, [selected?.id]);

  const dirty =
    selected !== null &&
    (selected.name !== draftName || selected.netlist !== draftNetlist);

  const onNew = async () => {
    setError(null);
    setBusy("saving");
    try {
      await createCircuit({
        name: `Circuit ${circuits.length + 1}`,
        netlist: STARTER_NETLIST,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onSave = async () => {
    if (!selected || !dirty) return;
    setError(null);
    setBusy("saving");
    try {
      await updateCircuit(selected.id, { name: draftName, netlist: draftNetlist });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const onDelete = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete circuit "${selected.name}"?`)) return;
    setError(null);
    setBusy("saving");
    try {
      await deleteCircuit(selected.id);
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
      // Save first if dirty so the solver runs the version on screen.
      if (dirty) {
        await updateCircuit(selected.id, { name: draftName, netlist: draftNetlist });
      }
      await dispatchSimulationRun({
        module: "spice",
        params: { circuitId: selected.id },
      });
      // Refresh the runs list so the new row appears at the top of the
      // right-side results panel — WS event will flip its status, but
      // we want it visible immediately.
      await loadRecentSimulationRuns("spice", 20);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("idle");
    }
  };

  const latestForCircuit = useMemo(() => {
    if (!selected) return null;
    return (
      recentRuns.find(
        (r) =>
          r.module === "spice" &&
          (r.params as { circuitId?: string } | undefined)?.circuitId === selected.id,
      ) ?? null
    );
  }, [recentRuns, selected?.id]);

  return (
    <div className="electronics-workspace">
      <aside className="electronics-sidebar">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">Circuits</span>
          <button
            type="button"
            className="electronics-icon-btn"
            title="New circuit"
            onClick={onNew}
            disabled={busy !== "idle"}
          >
            <Plus size={14} />
          </button>
        </header>
        <ul className="electronics-circuit-list">
          {circuits.length === 0 && (
            <li className="electronics-empty">No circuits yet — click + to add one.</li>
          )}
          {circuits.map((c) => (
            <li
              key={c.id}
              className={`electronics-circuit-row${c.id === selectedCircuitId ? " active" : ""}`}
              onClick={() => setSelectedCircuit(c.id)}
            >
              <span className="electronics-circuit-name">{c.name}</span>
              <span className="electronics-circuit-bytes">
                {c.netlist.length} B
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <section className="electronics-editor">
        {selected ? (
          <>
            <header className="electronics-editor-header">
              <input
                type="text"
                className="electronics-name-input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Circuit name"
              />
              <button
                type="button"
                className="electronics-btn"
                onClick={onSave}
                disabled={!dirty || busy !== "idle"}
                title={dirty ? "Save changes" : "No changes"}
              >
                <Save size={14} />
                <span>{busy === "saving" ? "Saving…" : "Save"}</span>
              </button>
              <button
                type="button"
                className="electronics-btn primary"
                onClick={onRun}
                disabled={busy !== "idle"}
                title="Run ngspice on this netlist"
              >
                <Play size={14} />
                <span>{busy === "running" ? "Running…" : "Run"}</span>
              </button>
              <button
                type="button"
                className="electronics-btn danger"
                onClick={onDelete}
                disabled={busy !== "idle"}
                title="Delete circuit"
              >
                <Trash2 size={14} />
              </button>
            </header>
            <div className="electronics-netlist-host">
              <NetlistEditor value={draftNetlist} onChange={setDraftNetlist} />
            </div>
          </>
        ) : (
          <div className="electronics-no-selection">
            Select a circuit on the left, or click + to create one.
          </div>
        )}
        {error && <div className="electronics-error">{error}</div>}
      </section>

      <aside className="electronics-results">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">Latest run</span>
        </header>
        {latestForCircuit ? (
          <RunResultPreview run={latestForCircuit} />
        ) : (
          <div className="electronics-empty">
            No run for this circuit yet — click <strong>Run</strong>.
          </div>
        )}
      </aside>
    </div>
  );
}

function RunResultPreview({
  run,
}: {
  run: ReturnType<typeof useSceneStore.getState>["recentSimulationRuns"][number];
}) {
  const rs = run.resultSummary as
    | {
        analysisName?: string;
        isComplex?: boolean;
        variables?: string[];
        pointCount?: number;
        data?: Record<string, unknown>;
      }
    | null;

  return (
    <div className="electronics-result-preview">
      <dl className="electronics-result-meta">
        <div>
          <dt>Status</dt>
          <dd className={`status-${run.status}`}>{run.status}</dd>
        </div>
        {rs?.analysisName && (
          <div>
            <dt>Analysis</dt>
            <dd>{rs.analysisName}</dd>
          </div>
        )}
        {typeof rs?.pointCount === "number" && (
          <div>
            <dt>Points</dt>
            <dd>{rs.pointCount}</dd>
          </div>
        )}
        {rs?.isComplex !== undefined && (
          <div>
            <dt>Complex?</dt>
            <dd>{rs.isComplex ? "yes" : "no"}</dd>
          </div>
        )}
      </dl>
      {run.errorMessage && (
        <div className="electronics-error">{run.errorMessage}</div>
      )}
      {rs?.variables && rs.variables.length > 0 && (
        <div className="electronics-variables">
          <strong>X:</strong> {rs.variables[0]}
          {rs.variables.length > 1 && (
            <>
              {" "}— <strong>Y:</strong> {rs.variables.slice(1).join(", ")}
            </>
          )}
        </div>
      )}
      {rs?.data && rs.variables && run.status === "completed" && (
        <WaveformChart runId={run.id} result={rs} />
      )}
      {rs?.data && (
        <details className="electronics-result-data">
          <summary>Raw data (JSON, first 4 KB)</summary>
          <pre>{JSON.stringify(rs.data, null, 2).slice(0, 4000)}</pre>
        </details>
      )}
    </div>
  );
}
