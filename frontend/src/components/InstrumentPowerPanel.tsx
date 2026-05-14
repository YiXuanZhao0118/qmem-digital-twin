/**
 * Instrument Power — system-wide on/off switches for powered devices.
 *
 * Lists every SceneObject whose Component's element_kind is in
 * ``POWER_KINDS`` (laser, TA, rf_source, rf_amplifier, function_generator,
 * rf_switch, detector, camera, spectrometer, wavemeter). Each row is a power toggle
 * that writes to ``device_states.state.power`` (per-object JSONB — no
 * migration needed).
 *
 * Per-template override: if a Component's ``properties.requiresPower``
 * is explicitly ``false``, that instance is hidden even if its kind is
 * in POWER_KINDS (e.g. a passively-powered receiver). Defaults follow
 * the kind set.
 */
import { Power } from "lucide-react";
import { useMemo } from "react";

import { useSceneStore } from "../store/sceneStore";
import { POWER_KINDS } from "../types/digitalTwin";
import type {
  ComponentItem,
  DeviceState,
  SceneObject,
} from "../types/digitalTwin";
import { FloatingPanel } from "./workspace/FloatingPanel";

type PoweredRow = {
  objectId: string;
  objectName: string;
  componentName: string;
  componentType: string;
  on: boolean;
};

function deviceStatePower(state: DeviceState | undefined): boolean {
  // Default ON unless explicitly toggled OFF. Matches the ray tracer:
  // beams emit when there's no state row, and only stop when the user
  // clicks OFF here.
  if (!state || !state.state) return true;
  const power = (state.state as { power?: unknown }).power;
  return power !== false;
}

function isPowered(
  object: SceneObject,
  component: ComponentItem | undefined,
): boolean {
  if (!component) return false;
  // Per-template override: properties.requiresPower === false hides the
  // toggle even when the kind defaults to powered.
  const props = (component.properties as { requiresPower?: unknown }) ?? {};
  if (props.requiresPower === false) return false;
  return POWER_KINDS.has(component.componentType);
}

export function InstrumentPowerPanel() {
  const objects = useSceneStore((s) => s.scene.objects);
  const components = useSceneStore((s) => s.scene.components);
  const deviceStates = useSceneStore((s) => s.scene.deviceStates);
  const updateDeviceState = useSceneStore((s) => s.updateDeviceState);

  const rows: PoweredRow[] = useMemo(() => {
    const componentById = new Map(components.map((c) => [c.id, c]));
    const stateByObject = new Map(deviceStates.map((d) => [d.objectId, d]));
    const out: PoweredRow[] = [];
    for (const obj of objects) {
      const comp = componentById.get(obj.componentId);
      if (!isPowered(obj, comp)) continue;
      const state = stateByObject.get(obj.id);
      out.push({
        objectId: obj.id,
        objectName: obj.name || "(unnamed)",
        componentName: comp?.name ?? "(unknown component)",
        componentType: comp?.componentType ?? "",
        on: deviceStatePower(state),
      });
    }
    out.sort((a, b) => a.objectName.localeCompare(b.objectName));
    return out;
  }, [objects, components, deviceStates]);

  const togglePower = async (row: PoweredRow) => {
    const next = !row.on;
    try {
      await updateDeviceState(row.objectId, { power: next });
    } catch {
      // sceneStore broadcasts errors; per-row failure is non-fatal.
    }
  };

  return (
    <FloatingPanel
      id="instrument-power"
      title="Instrument Power"
      icon={<Power size={14} />}
    >
      <div className="instrument-power">
        {rows.length === 0 ? (
          <div className="instrument-power-empty">
            No powered instruments in the scene yet. Add a laser, TA, RF source,
            detector, camera, spectrometer, or wavemeter object.
          </div>
        ) : (
          <table className="instrument-power-table">
            <thead>
              <tr>
                <th>Object</th>
                <th>Kind</th>
                <th>Power</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.objectId}>
                  <td>
                    <strong>{row.objectName}</strong>
                    <em className="instrument-power-comp">{row.componentName}</em>
                  </td>
                  <td className="instrument-power-kind">{row.componentType}</td>
                  <td>
                    <button
                      type="button"
                      className={`instrument-power-toggle${row.on ? " on" : " off"}`}
                      onClick={() => void togglePower(row)}
                    >
                      {row.on ? "ON" : "OFF"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </FloatingPanel>
  );
}
