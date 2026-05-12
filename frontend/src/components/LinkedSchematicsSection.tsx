/**
 * Linked schematics — Phase F.1 Tier 1 of cross-module integration.
 *
 * Renders inside the Object properties panel (ComponentPanel) when a
 * SceneObject is selected. Shows two chip lists:
 *
 *   ⚡ Linked circuits        — Circuits with scene_object_id == this object
 *   📡 Linked EM analyses     — EmProblems with scene_object_id == this object
 *
 * Each chip is "click to jump" — sets currentModule + selected* in the
 * Zustand store and switches the active tab. "+ New" buttons create a
 * new circuit/em-problem with scene_object_id pre-filled and immediately
 * jump to it.
 *
 * Phase F.1 Tier 1 = navigation only (no automation). Tier 2 will add an
 * inline Run + auto-inject of solver outputs into the device's
 * kindParams. Tier 3 (Phase F.3) is the full cross-module DAG.
 */
import { Plus, Radio, Zap } from "lucide-react";
import { useEffect, useState } from "react";

import {
  createCircuitApi,
  createEmProblemApi,
  fetchCircuitsApi,
  fetchEmProblemsApi,
} from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import type { Circuit, EmProblem } from "../types/digitalTwin";

type Props = {
  sceneObjectId: string;
  /** Used as the default name of newly-created linked rows. */
  sceneObjectName: string;
};

export function LinkedSchematicsSection({ sceneObjectId, sceneObjectName }: Props) {
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [emProblems, setEmProblems] = useState<EmProblem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCurrentModule = useSceneStore((s) => s.setCurrentModule);
  const setSelectedCircuit = useSceneStore((s) => s.setSelectedCircuit);
  const setSelectedEmProblem = useSceneStore((s) => s.setSelectedEmProblem);

  const refresh = async () => {
    try {
      const [cs, ems] = await Promise.all([
        fetchCircuitsApi(50, sceneObjectId),
        fetchEmProblemsApi(50, sceneObjectId),
      ]);
      setCircuits(cs);
      setEmProblems(ems);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    setError(null);
    void refresh();
  }, [sceneObjectId]);

  const jumpToCircuit = (circuitId: string) => {
    setCurrentModule("spice");
    setSelectedCircuit(circuitId);
  };

  const jumpToEm = (emId: string) => {
    setCurrentModule("em_fem");
    setSelectedEmProblem(emId);
  };

  const onNewCircuit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createCircuitApi({
        name: `${sceneObjectName} driver`,
        netlist:
          "* Driver / interface circuit for " + sceneObjectName + "\n.op\n.end\n",
        sceneObjectId,
      });
      // Push into the store so Electronics workspace sees it without a refetch.
      const loadCircuits = useSceneStore.getState().loadCircuits;
      await loadCircuits();
      jumpToCircuit(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onNewEm = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await createEmProblemApi({
        name: `${sceneObjectName} EM`,
        sceneObjectId,
        ports: [
          { id: "p1", name: "input", anchorBindingId: null, impedanceOhm: 50, mode: "tem" },
        ],
        freqRangeGhz: { startGhz: 1, stopGhz: 10, points: 51, scale: "linear" },
      });
      const loadEm = useSceneStore.getState().loadEmProblems;
      await loadEm();
      jumpToEm(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="linked-schematics">
      <h3>
        <Zap size={14} /> Linked schematics
      </h3>

      <div className="linked-row">
        <div className="linked-row-label">⚡ Circuits</div>
        <div className="linked-chips">
          {circuits.length === 0 ? (
            <span className="linked-empty">none</span>
          ) : (
            circuits.map((c) => (
              <button
                key={c.id}
                type="button"
                className="linked-chip"
                onClick={() => jumpToCircuit(c.id)}
                title={`Open ${c.name} in Electronics tab`}
              >
                {c.name}
              </button>
            ))
          )}
          <button
            type="button"
            className="linked-add"
            onClick={onNewCircuit}
            disabled={busy}
            title="Create a new circuit linked to this object"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      <div className="linked-row">
        <div className="linked-row-label">
          <Radio size={11} /> EM
        </div>
        <div className="linked-chips">
          {emProblems.length === 0 ? (
            <span className="linked-empty">none</span>
          ) : (
            emProblems.map((em) => (
              <button
                key={em.id}
                type="button"
                className="linked-chip"
                onClick={() => jumpToEm(em.id)}
                title={`Open ${em.name} in EM tab`}
              >
                {em.name}
              </button>
            ))
          )}
          <button
            type="button"
            className="linked-add"
            onClick={onNewEm}
            disabled={busy}
            title="Create a new EM analysis linked to this object"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      {error && <div className="linked-error">{error}</div>}
    </section>
  );
}
