/**
 * Solver console — Phase A.6 of the multiphysics platform.
 *
 * Floating panel that exposes the multiphysics ``simulation_runs`` flow
 * to the user:
 *  - "Run" button dispatches POST /api/simulation-runs for the current
 *    module (only optics_seq is wired in Phase A).
 *  - Recent runs list (newest first) shows status, module, age,
 *    and any error message.
 *  - WebSocket ``simulation_run.status_changed`` events update the rows
 *    in place via sceneStore.applyEvent → no polling.
 *
 * Phase B/C will reuse this panel; the only thing that changes is which
 * module ``currentModule`` resolves to.
 */
import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { getModule } from "../../modules/_registry";
import { useSceneStore } from "../../store/sceneStore";
import type { SimulationRunV2 } from "../../types/digitalTwin";
import { FloatingPanel } from "./FloatingPanel";

export function SolverConsole() {
  const currentModule = useSceneStore((state) => state.currentModule);
  const recentRuns = useSceneStore((state) => state.recentSimulationRuns);
  const loadRecentSimulationRuns = useSceneStore(
    (state) => state.loadRecentSimulationRuns,
  );
  const dispatchSimulationRun = useSceneStore(
    (state) => state.dispatchSimulationRun,
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initial fetch on mount + whenever the user switches modules.
  useEffect(() => {
    void loadRecentSimulationRuns();
  }, [loadRecentSimulationRuns]);

  const moduleDef = getModule(currentModule);
  const moduleAvailable = moduleDef.status === "available";

  const activeRun = useMemo(
    () =>
      recentRuns.find(
        (r) => r.module === currentModule && (r.status === "queued" || r.status === "running"),
      ),
    [recentRuns, currentModule],
  );

  const onRun = async () => {
    setBusy(true);
    setError(null);
    try {
      await dispatchSimulationRun({ module: currentModule });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FloatingPanel
      id="solver-console"
      title="Solver console"
      icon={<Play size={14} />}
      badge={moduleDef.displayName}
    >
      <div className="solver-console">
        <button
          type="button"
          className="solver-console-run"
          disabled={busy || !moduleAvailable || !!activeRun}
          onClick={onRun}
          title={
            !moduleAvailable
              ? `${moduleDef.displayName} is not yet implemented`
              : activeRun
                ? "A run is already in progress"
                : `Run ${moduleDef.displayName} solver`
          }
        >
          <Play size={13} />
          <span>
            {busy
              ? "Dispatching…"
              : activeRun
                ? `Running ${activeRun.module}…`
                : `Run ${moduleDef.displayName}`}
          </span>
        </button>

        {error && <div className="solver-console-error">{error}</div>}

        {activeRun && (
          <div className="solver-console-active">
            <div className="solver-console-active-status">
              {activeRun.status === "queued" ? "Queued" : "Running"}
              {typeof activeRun.progress === "number" &&
                ` — ${(activeRun.progress * 100).toFixed(0)}%`}
            </div>
            <div className="solver-console-progress">
              <div
                className="solver-console-progress-fill"
                style={{
                  width:
                    typeof activeRun.progress === "number"
                      ? `${Math.max(2, activeRun.progress * 100)}%`
                      : "8%",
                }}
              />
            </div>
          </div>
        )}

        <div className="solver-console-list">
          <div className="solver-console-list-title">Recent runs</div>
          {recentRuns.length === 0 ? (
            <div className="solver-console-empty">No runs yet.</div>
          ) : (
            recentRuns.slice(0, 6).map((run) => <RunRow key={run.id} run={run} />)
          )}
        </div>
      </div>
    </FloatingPanel>
  );
}

function RunRow({ run }: { run: SimulationRunV2 }) {
  return (
    <div className={`solver-console-run-row status-${run.status}`}>
      <span className={`solver-console-run-status status-${run.status}`}>
        {run.status}
      </span>
      <span className="solver-console-run-module">{run.module}</span>
      <span className="solver-console-run-age" title={run.startedAt}>
        {ageLabel(run.startedAt)}
      </span>
      {run.errorMessage && (
        <span className="solver-console-run-error" title={run.errorMessage}>
          ⚠
        </span>
      )}
    </div>
  );
}

function ageLabel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
