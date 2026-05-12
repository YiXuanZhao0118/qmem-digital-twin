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
import { Antenna, Clock, Play, Plus, Radio, Zap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createCircuitApi,
  createEmProblemApi,
  fetchCircuitsApi,
  fetchEmProblemsApi,
  fetchRfChainApi,
  replaceRfChainApi,
} from "../api/client";
import { useSceneStore } from "../store/sceneStore";
import type { Circuit, EmProblem, RfChainNode, RfNodeKind } from "../types/digitalTwin";
import { useWorkspace } from "./workspace/WorkspaceProvider";

// Default 3-node chain seeded when the user clicks "+" on an empty RF row.
// Designed for an AOM: DDS @ 80 MHz → +30 dB amplifier → 80 MHz bandpass.
function defaultChainFor(terminalSceneObjectId: string) {
  return [
    {
      terminalSceneObjectId,
      positionInChain: 0,
      nodeKind: "dds" as RfNodeKind,
      label: "DDS 80 MHz",
      gainDb: 0,
      kindParams: { frequencyMhz: 80, powerDbm: 0 },
    },
    {
      terminalSceneObjectId,
      positionInChain: 1,
      nodeKind: "amplifier" as RfNodeKind,
      label: "+30 dB amp",
      gainDb: 30,
      kindParams: {},
    },
    {
      terminalSceneObjectId,
      positionInChain: 2,
      nodeKind: "filter_bandpass" as RfNodeKind,
      label: "BPF 70-90 MHz",
      gainDb: -1.5,
      kindParams: { centerMhz: 80, bandwidthMhz: 20 },
    },
  ];
}

const RF_NODE_GLYPH: Record<RfNodeKind, string> = {
  dds: "DDS",
  synthesizer: "SYN",
  amplifier: "AMP",
  attenuator: "ATT",
  filter_bandpass: "BPF",
  filter_lowpass: "LPF",
  filter_highpass: "HPF",
  splitter: "SPL",
  combiner: "CMB",
  mixer: "MIX",
  switch: "SW",
  isolator: "ISO",
  circulator: "CIR",
  coax: "COAX",
  device: "DEV",
};

type Props = {
  sceneObjectId: string;
  /** Used as the default name of newly-created linked rows. */
  sceneObjectName: string;
  /**
   * Component template id for the selected SceneObject. PulseBlaster
   * channels bind by `targetComponentId`, not by SceneObject — every
   * instance of a Component shares the same TTL routing. May be null
   * if the selection is a bare object (rare).
   */
  componentId: string | null;
};

export function LinkedSchematicsSection({
  sceneObjectId,
  sceneObjectName,
  componentId,
}: Props) {
  const [circuits, setCircuits] = useState<Circuit[]>([]);
  const [emProblems, setEmProblems] = useState<EmProblem[]>([]);
  const [rfChain, setRfChain] = useState<RfChainNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCurrentModule = useSceneStore((s) => s.setCurrentModule);
  const setSelectedCircuit = useSceneStore((s) => s.setSelectedCircuit);
  const setSelectedEmProblem = useSceneStore((s) => s.setSelectedEmProblem);
  const dispatchSimulationRun = useSceneStore((s) => s.dispatchSimulationRun);
  const recentRuns = useSceneStore((s) => s.recentSimulationRuns);
  const pbChannels = useSceneStore((s) => s.pulseBlasterChannels);
  const { togglePanelVisible, focusPanel } = useWorkspace();

  // Map of circuit/em-problem id -> latest run status (just pulled from
  // the global recentRuns store; no extra fetch).
  const lastRunStatus = useMemo(() => {
    const out = new Map<string, string>();
    for (const r of recentRuns) {
      const params = (r.params as { circuitId?: string; emProblemId?: string }) ?? {};
      const key = params.circuitId ?? params.emProblemId;
      if (key && !out.has(key)) out.set(key, r.status);
    }
    return out;
  }, [recentRuns]);

  const refresh = async () => {
    try {
      const [cs, ems, rf] = await Promise.all([
        fetchCircuitsApi(50, sceneObjectId),
        fetchEmProblemsApi(50, sceneObjectId),
        fetchRfChainApi(sceneObjectId),
      ]);
      setCircuits(cs);
      setEmProblems(ems);
      setRfChain(rf);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    setError(null);
    void refresh();
  }, [sceneObjectId]);

  // PulseBlaster channels bind by Component, not by SceneObject — same
  // TTL line drives every instance of a given component.
  const boundChannels = useMemo(() => {
    if (!componentId) return [];
    return pbChannels
      .filter((c) => c.enabled && c.targetComponentId === componentId)
      .sort((a, b) => a.channelIndex - b.channelIndex);
  }, [pbChannels, componentId]);

  const openPulseBlasterPanel = () => {
    togglePanelVisible("pulse-blaster", true);
    focusPanel("pulse-blaster");
  };

  // Chain dBm summation: source (first DDS/synth node) kindParams.powerDbm + Σ gainDb of all later nodes.
  const chainOutputDbm = useMemo(() => {
    if (rfChain.length === 0) return null;
    const sorted = [...rfChain].sort((a, b) => a.positionInChain - b.positionInChain);
    const sourceKind = sorted[0].nodeKind;
    if (sourceKind !== "dds" && sourceKind !== "synthesizer") return null;
    const sourceDbm = Number(
      (sorted[0].kindParams as { powerDbm?: number })?.powerDbm ?? 0,
    );
    const totalGain = sorted.slice(1).reduce((acc, n) => acc + (n.gainDb ?? 0), 0);
    return sourceDbm + totalGain;
  }, [rfChain]);

  const onSeedRfChain = async () => {
    setBusy(true);
    setError(null);
    try {
      const seeded = await replaceRfChainApi(
        sceneObjectId,
        defaultChainFor(sceneObjectId),
      );
      setRfChain(seeded);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onJumpRfNode = (node: RfChainNode) => {
    if (node.linkedCircuitId) {
      jumpToCircuit(node.linkedCircuitId);
    } else if (node.linkedEmProblemId) {
      jumpToEm(node.linkedEmProblemId);
    }
  };

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

  const onRunCircuit = async (circuitId: string) => {
    setBusy(true);
    setError(null);
    try {
      await dispatchSimulationRun({ module: "spice", params: { circuitId } });
      const loadRecent = useSceneStore.getState().loadRecentSimulationRuns;
      await loadRecent("spice", 20);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onRunEm = async (emProblemId: string) => {
    setBusy(true);
    setError(null);
    try {
      await dispatchSimulationRun({
        module: "em_fem",
        params: { emProblemId },
      });
      const loadRecent = useSceneStore.getState().loadRecentSimulationRuns;
      await loadRecent("em_fem", 20);
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
            circuits.map((c) => {
              const status = lastRunStatus.get(c.id);
              return (
                <span key={c.id} className="linked-chip-group">
                  <button
                    type="button"
                    className="linked-chip"
                    onClick={() => jumpToCircuit(c.id)}
                    title={`Open ${c.name} in Electronics tab`}
                  >
                    {c.name}
                    {status && <em className={`linked-status status-${status}`}>{status}</em>}
                  </button>
                  <button
                    type="button"
                    className="linked-run"
                    onClick={() => onRunCircuit(c.id)}
                    title={`Run ${c.name} via ngspice`}
                    disabled={busy}
                  >
                    <Play size={9} />
                  </button>
                </span>
              );
            })
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
            emProblems.map((em) => {
              const status = lastRunStatus.get(em.id);
              return (
                <span key={em.id} className="linked-chip-group">
                  <button
                    type="button"
                    className="linked-chip"
                    onClick={() => jumpToEm(em.id)}
                    title={`Open ${em.name} in EM tab`}
                  >
                    {em.name}
                    {status && <em className={`linked-status status-${status}`}>{status}</em>}
                  </button>
                  <button
                    type="button"
                    className="linked-run"
                    onClick={() => onRunEm(em.id)}
                    title={`Run ${em.name} via palace (mock)`}
                    disabled={busy}
                  >
                    <Play size={9} />
                  </button>
                </span>
              );
            })
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

      <div className="linked-row">
        <div className="linked-row-label">
          <Antenna size={11} /> RF chain
          {chainOutputDbm !== null && (
            <em className="linked-rf-dbm" title="Computed power at chain output (source dBm + Σ gain)">
              {chainOutputDbm >= 0 ? "+" : ""}
              {chainOutputDbm.toFixed(1)} dBm
            </em>
          )}
        </div>
        <div className="linked-chips">
          {rfChain.length === 0 ? (
            <span className="linked-empty">no RF chain</span>
          ) : (
            [...rfChain]
              .sort((a, b) => a.positionInChain - b.positionInChain)
              .map((node) => {
                const linked = !!(node.linkedCircuitId || node.linkedEmProblemId);
                return (
                  <button
                    key={node.id}
                    type="button"
                    className={`linked-chip rf-chip rf-chip-${node.nodeKind}`}
                    onClick={() => onJumpRfNode(node)}
                    disabled={!linked}
                    title={
                      linked
                        ? `Open linked ${node.linkedCircuitId ? "circuit" : "EM problem"}`
                        : `${node.label || node.nodeKind} — no linked schematic`
                    }
                  >
                    <span className="rf-chip-tag">{RF_NODE_GLYPH[node.nodeKind]}</span>
                    {node.label || node.nodeKind}
                    {node.gainDb !== 0 && (
                      <em className="rf-chip-gain">
                        {node.gainDb > 0 ? "+" : ""}
                        {node.gainDb.toFixed(1)} dB
                      </em>
                    )}
                  </button>
                );
              })
          )}
          {rfChain.length === 0 && (
            <button
              type="button"
              className="linked-add"
              onClick={onSeedRfChain}
              disabled={busy}
              title="Seed a default DDS → amp → BPF chain for this device"
            >
              <Plus size={11} />
            </button>
          )}
        </div>
      </div>

      <div className="linked-row">
        <div className="linked-row-label">
          <Clock size={11} /> Timing
        </div>
        <div className="linked-chips">
          {boundChannels.length === 0 ? (
            <span className="linked-empty">no TTL channel</span>
          ) : (
            boundChannels.map((c) => (
              <button
                key={c.channelIndex}
                type="button"
                className={`linked-chip pb-chip${c.invert ? " pb-chip-inv" : ""}`}
                onClick={openPulseBlasterPanel}
                title={`PulseBlaster ch${c.channelIndex}: ${c.label || "(unlabeled)"}${
                  c.invert ? " — inverted (active-low)" : ""
                }. Click to open wiring panel.`}
              >
                <span className="pb-chip-idx">{c.channelIndex}</span>
                {c.label || "(unlabeled)"}
                {c.invert && <em className="pb-chip-inv-mark">/INV</em>}
              </button>
            ))
          )}
          <button
            type="button"
            className="linked-add"
            onClick={openPulseBlasterPanel}
            title="Open PulseBlaster wiring panel to bind a TTL channel"
          >
            <Plus size={11} />
          </button>
        </div>
      </div>

      {error && <div className="linked-error">{error}</div>}
    </section>
  );
}
