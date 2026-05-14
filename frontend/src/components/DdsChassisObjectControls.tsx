import { useMemo } from "react";
import { Server } from "lucide-react";
import { useSceneStore } from "../store/sceneStore";
import type { ComponentItem } from "../types/digitalTwin";

/** Per-instance controls for the DDS 5×AD9959 1U chassis (Object Panel).
 *
 *  Captures the chassis-level wiring decisions the per-chip Object Panel
 *  can't see:
 *    - REF_CLK source (external TCXO vs internal XTAL) and its base
 *      frequency, fanned out 1:5 to the 5 AD9959 chips' REF_CLK pins
 *    - SYNC daisy-chain / master-slaves topology used to phase-coherently
 *      align the 5 chips' DDS cores
 *    - Which chip (0..4) is the SYNC master that drives the chain
 *
 *  State lives on `SceneObject.properties.ddsChassis` (not kindParams —
 *  instrument_chassis has no PhysicsElement). The 5 child AD9959
 *  SceneObjects each have their own kindParams.referenceClockMhz; this
 *  panel is informational scaffolding that downstream wiring can read
 *  to drive cable routing / sync diagrams. */

export type DdsChassisProperties = {
  refClockSource?: "external_tcxo" | "internal_xtal";
  refClockMhz?: number;
  refClockFanout?: number;
  syncTopology?: "daisy_chain" | "master_slaves" | "standalone";
  syncMasterIndex?: number;
};

const DEFAULTS: Required<DdsChassisProperties> = {
  refClockSource: "external_tcxo",
  refClockMhz: 20.0,
  refClockFanout: 5,
  syncTopology: "daisy_chain",
  syncMasterIndex: 0,
};

export function DdsChassisObjectControls({ component }: { component: ComponentItem }) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  // Pick the currently-selected SceneObject if it points at this component,
  // else the first SceneObject of this component template (catalog view).
  const sceneObject = useSceneStore((state) => {
    const selected =
      state.selectedObjectId &&
      state.scene.objects.find((o) => o.id === state.selectedObjectId);
    if (selected && selected.componentId === component.id) return selected;
    return state.scene.objects.find((o) => o.componentId === component.id) ?? null;
  });

  const props = useMemo(() => {
    const raw = (sceneObject?.properties ?? {}) as { ddsChassis?: DdsChassisProperties };
    const ddsChassis = raw.ddsChassis ?? {};
    return {
      refClockSource: ddsChassis.refClockSource ?? DEFAULTS.refClockSource,
      refClockMhz: ddsChassis.refClockMhz ?? DEFAULTS.refClockMhz,
      refClockFanout: ddsChassis.refClockFanout ?? DEFAULTS.refClockFanout,
      syncTopology: ddsChassis.syncTopology ?? DEFAULTS.syncTopology,
      syncMasterIndex: ddsChassis.syncMasterIndex ?? DEFAULTS.syncMasterIndex,
    };
  }, [sceneObject?.properties]);

  const hasInstance = sceneObject != null;

  const writeProps = async (patch: Partial<DdsChassisProperties>) => {
    if (!sceneObject) return;
    const existing = (sceneObject.properties ?? {}) as Record<string, unknown>;
    const next = {
      ...existing,
      ddsChassis: {
        ...((existing.ddsChassis as DdsChassisProperties | undefined) ?? {}),
        ...patch,
      },
    };
    await updateSceneObject(sceneObject.id, { properties: next });
  };

  return (
    <section className="edit-section">
      <h3>
        <Server size={17} />
        DDS chassis controls
      </h3>
      {!hasInstance && (
        <p style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
          Place this chassis in the scene to edit per-instance parameters.
          Showing catalog defaults.
        </p>
      )}

      {/* Reference clock ----------------------------------------------- */}
      <div className="ad9959-subsection">
        <div className="ad9959-subsection-title">Reference clock</div>
        <label className="ad9959-row">
          <span>Source</span>
          <select
            disabled={!hasInstance}
            value={props.refClockSource}
            onChange={(e) =>
              void writeProps({
                refClockSource: e.target.value as DdsChassisProperties["refClockSource"],
              })
            }
          >
            <option value="external_tcxo">external TCXO</option>
            <option value="internal_xtal">internal XTAL</option>
          </select>
        </label>
        <label className="ad9959-row">
          <span>REF_CLK (MHz)</span>
          <input
            type="number"
            step={0.1}
            min={0}
            disabled={!hasInstance}
            value={props.refClockMhz}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v) || v < 0) return;
              void writeProps({ refClockMhz: v });
            }}
          />
        </label>
        <label className="ad9959-row">
          <span>Fanout</span>
          <input
            type="number"
            step={1}
            min={1}
            max={32}
            disabled={!hasInstance}
            value={props.refClockFanout}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (!Number.isFinite(v) || v < 1) return;
              void writeProps({ refClockFanout: v });
            }}
          />
        </label>
        <div className="ad9959-row ad9959-derived">
          <span>Per-chip REF_CLK</span>
          <code>{props.refClockMhz.toFixed(2)} MHz × {props.refClockFanout}</code>
        </div>
      </div>

      {/* Sync topology ------------------------------------------------- */}
      <div className="ad9959-subsection">
        <div className="ad9959-subsection-title">Sync topology</div>
        <label className="ad9959-row">
          <span>Mode</span>
          <select
            disabled={!hasInstance}
            value={props.syncTopology}
            onChange={(e) =>
              void writeProps({
                syncTopology: e.target.value as DdsChassisProperties["syncTopology"],
              })
            }
          >
            <option value="daisy_chain">daisy_chain (chip₀.SYNC_OUT → chip₁.SYNC_IN → …)</option>
            <option value="master_slaves">master_slaves (master.SYNC_OUT → all slaves)</option>
            <option value="standalone">standalone (no inter-chip sync)</option>
          </select>
        </label>
        <label className="ad9959-row">
          <span>Master chip index</span>
          <input
            type="number"
            step={1}
            min={0}
            max={Math.max(0, props.refClockFanout - 1)}
            disabled={!hasInstance || props.syncTopology === "standalone"}
            value={props.syncMasterIndex}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (!Number.isFinite(v) || v < 0) return;
              void writeProps({ syncMasterIndex: v });
            }}
          />
        </label>
      </div>
    </section>
  );
}
