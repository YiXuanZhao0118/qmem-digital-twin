import { Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, ElementKind, OpticalElement, OpticalPort } from "../../types/digitalTwin";
import { DEFAULT_KIND_PARAMS, KIND_GROUPS, KIND_LABELS } from "../../utils/opticalDefaults";

type Props = {
  component: ComponentItem;
};

function findElement(elements: OpticalElement[], componentId: string): OpticalElement | undefined {
  return elements.find((item) => item.componentId === componentId);
}

export function OpticalElementPanel({ component }: Props) {
  const opticalElements = useSceneStore((state) => state.scene.opticalElements);
  const opticalLinks = useSceneStore((state) => state.scene.opticalLinks);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const deleteOpticalElement = useSceneStore((state) => state.deleteOpticalElement);
  const runOpticalSimulation = useSceneStore((state) => state.runOpticalSimulation);

  const existing = findElement(opticalElements, component.id);

  const [kind, setKind] = useState<ElementKind>((existing?.elementKind as ElementKind) ?? "laser_source");
  const [paramsText, setParamsText] = useState<string>(() =>
    JSON.stringify(existing?.kindParams ?? DEFAULT_KIND_PARAMS[kind], null, 2),
  );
  const [waveLow, setWaveLow] = useState<number>(existing?.wavelengthRangeNm?.[0] ?? 400);
  const [waveHigh, setWaveHigh] = useState<number>(existing?.wavelengthRangeNm?.[1] ?? 1100);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<string>("");

  // Re-sync when the underlying element changes (e.g., websocket update)
  useEffect(() => {
    if (existing) {
      setKind(existing.elementKind as ElementKind);
      setParamsText(JSON.stringify(existing.kindParams, null, 2));
      setWaveLow(existing.wavelengthRangeNm?.[0] ?? 400);
      setWaveHigh(existing.wavelengthRangeNm?.[1] ?? 1100);
    }
  }, [existing?.componentId, existing?.updatedAt]);

  const incomingLinks = useMemo(
    () => opticalLinks.filter((link) => link.toComponentId === component.id),
    [opticalLinks, component.id],
  );
  const outgoingLinks = useMemo(
    () => opticalLinks.filter((link) => link.fromComponentId === component.id),
    [opticalLinks, component.id],
  );

  const ports = (existing?.inputPorts ?? []).concat(existing?.outputPorts ?? []);

  const onLoadDefaults = () => {
    setParamsText(JSON.stringify(DEFAULT_KIND_PARAMS[kind], null, 2));
    setError("");
  };

  const onKindChange = (next: ElementKind) => {
    setKind(next);
    setParamsText(JSON.stringify(DEFAULT_KIND_PARAMS[next], null, 2));
    setError("");
  };

  const onSave = async () => {
    setError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(paramsText);
    } catch (e) {
      setError(`JSON parse error: ${(e as Error).message}`);
      return;
    }
    if (waveLow <= 0 || waveHigh <= waveLow) {
      setError("Invalid wavelength range (need 0 < low < high).");
      return;
    }
    setBusy(true);
    try {
      await upsertOpticalElement({
        componentId: component.id,
        elementKind: kind,
        wavelengthRangeNm: [waveLow, waveHigh],
        kindParams: parsed,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!existing) return;
    if (!window.confirm("Delete this optical element record?")) return;
    setBusy(true);
    try {
      await deleteOpticalElement(component.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRun = async () => {
    setBusy(true);
    setRunResult("");
    try {
      const result = await runOpticalSimulation();
      const lines: string[] = [`run ${result.runId.slice(0, 8)}: ${result.segmentCount} segments`];
      if (result.errors.length) lines.push("errors:", ...result.errors.map((e) => `  - ${e}`));
      if (result.warnings.length) lines.push("warnings:", ...result.warnings.map((w) => `  - ${w}`));
      setRunResult(lines.join("\n"));
    } catch (e) {
      setRunResult(`Failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="optical-panel">
      <header className="optical-panel-header">
        <h3>Optical Element</h3>
        <button type="button" className="optical-run-btn" onClick={onRun} disabled={busy}>
          <Play size={14} /> Run Solver
        </button>
      </header>

      <div className="optical-form">
        <label className="optical-row">
          <span>Element kind</span>
          <select value={kind} onChange={(e) => onKindChange(e.target.value as ElementKind)}>
            {KIND_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.kinds.map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div className="optical-row optical-wavelength">
          <span>Wavelength range (nm)</span>
          <div className="number-pair">
            <input
              type="number"
              step="any"
              value={waveLow}
              onChange={(e) => setWaveLow(Number(e.target.value))}
            />
            <span>—</span>
            <input
              type="number"
              step="any"
              value={waveHigh}
              onChange={(e) => setWaveHigh(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="optical-row">
          <div className="optical-row-header">
            <span>Kind params (JSON)</span>
            <button type="button" className="link-btn" onClick={onLoadDefaults}>
              Load default
            </button>
          </div>
          <textarea
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
            spellCheck={false}
            rows={Math.min(20, paramsText.split("\n").length + 1)}
            className="optical-params-editor"
          />
        </div>

        {error ? <div className="optical-error">{error}</div> : null}
        {runResult ? <pre className="optical-run-output">{runResult}</pre> : null}

        <div className="optical-actions">
          <button type="button" className="primary" onClick={onSave} disabled={busy}>
            {existing ? "Update" : "Create"}
          </button>
          {existing ? (
            <button type="button" className="danger" onClick={onDelete} disabled={busy}>
              <Trash2 size={14} /> Delete
            </button>
          ) : null}
        </div>
      </div>

      {existing && ports.length ? (
        <div className="optical-ports">
          <h4>Ports</h4>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>ID</th>
                <th>Label</th>
                <th>Kind</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((port: OpticalPort) => (
                <tr key={`${port.role}-${port.portId}`}>
                  <td>{port.role}</td>
                  <td><code>{port.portId}</code></td>
                  <td>{port.label ?? "—"}</td>
                  <td>{port.kind ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {existing && (incomingLinks.length || outgoingLinks.length) ? (
        <div className="optical-links">
          <h4>Links</h4>
          {incomingLinks.length ? (
            <div>
              <div className="optical-links-label">Incoming</div>
              {incomingLinks.map((link) => (
                <div key={link.id} className="optical-link-row">
                  <code>{link.fromComponentId.slice(0, 8)}…/{link.fromPort}</code> → <code>{link.toPort}</code>
                  <span className="optical-link-distance">{link.freeSpaceMm.toFixed(1)} mm</span>
                </div>
              ))}
            </div>
          ) : null}
          {outgoingLinks.length ? (
            <div>
              <div className="optical-links-label">Outgoing</div>
              {outgoingLinks.map((link) => (
                <div key={link.id} className="optical-link-row">
                  <code>{link.fromPort}</code> → <code>{link.toComponentId.slice(0, 8)}…/{link.toPort}</code>
                  <span className="optical-link-distance">{link.freeSpaceMm.toFixed(1)} mm</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
