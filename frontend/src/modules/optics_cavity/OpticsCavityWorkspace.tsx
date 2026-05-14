/**
 * Optical-cavity calculator workspace — Phase Optics-Cavity.
 *
 * Reuses the shared three-pane Module shell (.electronics-workspace
 * + .electronics-sidebar/-editor/-results + .em-editor-* form widgets)
 * so it looks consistent with Electronics and EM. Cavity-only widgets
 * (preset cards, metrics grid, Airy chart, stability pill) live under
 * the .cavity-* namespace.
 *
 * Pure analytical: the API call is sub-millisecond, so we just
 * compute on every input change (debounced 250 ms) and render the
 * bundle.
 */
import { Activity, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useResizablePanes } from "../../components/workspace/useResizablePanes";
import {
  computeCavityApi,
  type CavityComputeRequest,
  type CavityComputeResult,
  type CavityKind,
  type CavityMirrorIn,
} from "../../api/client";
import { useSceneStore } from "../../store/sceneStore";
import { AiryChart } from "./AiryChart";

type Preset = {
  id: string;
  label: string;
  description: string;
  request: CavityComputeRequest;
};

const PRESETS: Preset[] = [
  {
    id: "filter_852",
    label: "Cs 852 nm filter cavity",
    description: "Narrowband filter for the 6S→6P D2 line. R=0.99 symmetric, 100 mm.",
    request: {
      kind: "linear",
      lengthMm: 100,
      wavelengthNm: 852.0,
      mirrors: [{ reflectivity: 0.99 }, { reflectivity: 0.99 }],
      intracavityLoss: 0.001,
      refractiveIndex: 1.0,
      spectrumSpanFsr: 4,
      spectrumPoints: 401,
    },
  },
  {
    id: "buildup_780",
    label: "Rb 780 nm build-up cavity",
    description: "High-finesse two-mirror cavity for Rb saturated absorption.",
    request: {
      kind: "linear",
      lengthMm: 50,
      wavelengthNm: 780.241,
      mirrors: [
        { reflectivity: 0.998, radiusCurvatureMm: 250.0 },
        { reflectivity: 0.998, radiusCurvatureMm: 250.0 },
      ],
      intracavityLoss: 0.0005,
      refractiveIndex: 1.0,
      spectrumSpanFsr: 4,
      spectrumPoints: 401,
    },
  },
  {
    id: "ring_894",
    label: "Cs 894 nm ring reference",
    description: "3-mirror triangular ring, 300 mm round-trip, R=0.995 each.",
    request: {
      kind: "ring_tri",
      lengthMm: 300,
      wavelengthNm: 894.347,
      mirrors: [
        { reflectivity: 0.995 },
        { reflectivity: 0.995 },
        { reflectivity: 0.995 },
      ],
      intracavityLoss: 0.001,
      refractiveIndex: 1.0,
      spectrumSpanFsr: 4,
      spectrumPoints: 401,
    },
  },
];

type DraftMirror = CavityMirrorIn;
type Draft = Omit<CavityComputeRequest, "mirrors"> & { mirrors: DraftMirror[] };

const DEFAULT_DRAFT: Draft = {
  kind: "linear",
  lengthMm: 100,
  wavelengthNm: 852.0,
  mirrors: [{ reflectivity: 0.99 }, { reflectivity: 0.99 }],
  intracavityLoss: 0.0,
  refractiveIndex: 1.0,
  spectrumSpanFsr: 4,
  spectrumPoints: 401,
};

const KIND_LABELS: Record<CavityKind, string> = {
  linear: "Linear (Fabry-Perot)",
  ring_tri: "Ring — triangle (3 mirrors)",
  ring_bow: "Ring — bowtie (4 mirrors)",
};

const KIND_MIRROR_COUNT: Record<CavityKind, number> = {
  linear: 2,
  ring_tri: 3,
  ring_bow: 4,
};

function fmtNumber(value: number, fractionDigits = 3): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(fractionDigits);
  }
  return value.toFixed(fractionDigits);
}

export function OpticsCavityWorkspace() {
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [activePresetId, setActivePresetId] = useState<string | null>("filter_852");
  const [result, setResult] = useState<CavityComputeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const { startDrag } = useResizablePanes({
    id: "optics",
    containerRef: workspaceRef,
  });
  const dispatchSimulationRun = useSceneStore((s) => s.dispatchSimulationRun);

  const runCompute = async (current: Draft) => {
    setBusy(true);
    setError(null);
    try {
      const res = await computeCavityApi(current);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Run button: keep the live inline result, but ALSO dispatch a real
  // SimulationRun so the configuration shows up in SolverConsole and the
  // user can come back to it later (Phase Optics-Cavity).
  const runAndPersist = async () => {
    await runCompute(draft);
    try {
      await dispatchSimulationRun({
        module: "optics_cavity",
        params: draft as unknown as Record<string, unknown>,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void runCompute(draft);
    }, 250);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const onPickPreset = (preset: Preset) => {
    setActivePresetId(preset.id);
    setDraft({
      ...preset.request,
      mirrors: preset.request.mirrors.map((m) => ({ ...m })),
    });
  };

  const onSetKind = (kind: CavityKind) => {
    setActivePresetId(null);
    setDraft((prev) => {
      const want = KIND_MIRROR_COUNT[kind];
      let mirrors = [...prev.mirrors];
      while (mirrors.length < want) mirrors.push({ reflectivity: 0.99 });
      if (mirrors.length > want) mirrors = mirrors.slice(0, want);
      return { ...prev, kind, mirrors };
    });
  };

  const onSetMirror = (idx: number, patch: Partial<DraftMirror>) => {
    setActivePresetId(null);
    setDraft((prev) => ({
      ...prev,
      mirrors: prev.mirrors.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    }));
  };

  const onAddMirror = () => {
    setActivePresetId(null);
    setDraft((prev) => ({ ...prev, mirrors: [...prev.mirrors, { reflectivity: 0.99 }] }));
  };

  const onRemoveMirror = (idx: number) => {
    setActivePresetId(null);
    setDraft((prev) => ({
      ...prev,
      mirrors: prev.mirrors.filter((_, i) => i !== idx),
    }));
  };

  const stabilityPill = useMemo(() => {
    if (!result || result.stable === null) return null;
    return result.stable ? (
      <span className="cavity-pill stable">stable (g₁g₂ = {fmtNumber(result.g1g2 ?? 0)})</span>
    ) : (
      <span className="cavity-pill unstable">unstable (g₁g₂ = {fmtNumber(result.g1g2 ?? 0)})</span>
    );
  }, [result]);

  return (
    <div ref={workspaceRef} className="electronics-workspace">
      <aside className="electronics-sidebar">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">Presets</span>
        </header>
        <ul className="electronics-circuit-list">
          {PRESETS.map((p) => (
            <li
              key={p.id}
              className={`electronics-circuit-row cavity-preset-row${
                activePresetId === p.id ? " active" : ""
              }`}
              onClick={() => onPickPreset(p)}
              title={p.description}
            >
              <span className="electronics-circuit-name">
                <strong>{p.label}</strong>
                <span className="cavity-preset-desc">{p.description}</span>
              </span>
            </li>
          ))}
        </ul>

        <header className="electronics-sidebar-header" style={{ marginTop: "auto" }}>
          <span className="electronics-sidebar-title">Geometry</span>
        </header>
        <div className="em-editor-body" style={{ paddingTop: 10 }}>
          <div className="em-editor-row" style={{ gridTemplateColumns: "1fr" }}>
            <label>
              Cavity kind
              <select
                value={draft.kind}
                onChange={(e) => onSetKind(e.target.value as CavityKind)}
              >
                {(Object.keys(KIND_LABELS) as CavityKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="em-editor-row">
            <label>
              {draft.kind === "linear" ? "Mirror sep. L (mm)" : "Round-trip path (mm)"}
              <input
                type="number"
                min={0.1}
                step={1}
                value={draft.lengthMm}
                onChange={(e) => {
                  setActivePresetId(null);
                  setDraft((p) => ({ ...p, lengthMm: Number(e.target.value) || 0 }));
                }}
              />
            </label>
            <label>
              Wavelength (nm)
              <input
                type="number"
                min={1}
                step={0.001}
                value={draft.wavelengthNm}
                onChange={(e) => {
                  setActivePresetId(null);
                  setDraft((p) => ({ ...p, wavelengthNm: Number(e.target.value) || 0 }));
                }}
              />
            </label>
          </div>
          <div className="em-editor-row">
            <label>
              Loss (one-pass)
              <input
                type="number"
                min={0}
                max={0.5}
                step={0.0005}
                value={draft.intracavityLoss}
                onChange={(e) => {
                  setActivePresetId(null);
                  setDraft((p) => ({
                    ...p,
                    intracavityLoss: Number(e.target.value) || 0,
                  }));
                }}
              />
            </label>
            <label>
              Refractive index n
              <input
                type="number"
                min={1}
                step={0.001}
                value={draft.refractiveIndex}
                onChange={(e) => {
                  setActivePresetId(null);
                  setDraft((p) => ({
                    ...p,
                    refractiveIndex: Number(e.target.value) || 1,
                  }));
                }}
              />
            </label>
          </div>
          <div className="em-editor-row" style={{ gridTemplateColumns: "1fr" }}>
            <label>
              Spectrum span (× FSR)
              <input
                type="number"
                min={0.5}
                max={50}
                step={0.5}
                value={draft.spectrumSpanFsr}
                onChange={(e) => {
                  setActivePresetId(null);
                  setDraft((p) => ({
                    ...p,
                    spectrumSpanFsr: Number(e.target.value) || 4,
                  }));
                }}
              />
            </label>
          </div>
        </div>
      </aside>

      <div
        className="ws-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize presets panel"
        onPointerDown={startDrag("left")}
      />

      <section className="electronics-editor">
        <header className="electronics-editor-header">
          <span className="electronics-sidebar-title">Mirrors ({draft.mirrors.length})</span>
          <button
            type="button"
            className="electronics-btn primary"
            onClick={() => void runAndPersist()}
            disabled={busy}
            title="Run + save this configuration to SolverConsole"
            style={{ marginLeft: "auto" }}
          >
            <Play size={11} /> {busy ? "Computing…" : "Run"}
          </button>
          <button
            type="button"
            className="electronics-btn"
            onClick={onAddMirror}
            title="Add a mirror"
          >
            <Plus size={11} /> Add mirror
          </button>
        </header>
        <div className="em-editor-body">
          <table className="em-port-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Reflectivity (intensity)</th>
                <th>Radius of curvature (mm)</th>
                <th aria-label="remove" />
              </tr>
            </thead>
            <tbody>
              {draft.mirrors.map((m, i) => (
                <tr key={i}>
                  <td className="cavity-row-idx">{i}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={0.99999}
                      step={0.001}
                      value={m.reflectivity}
                      onChange={(e) =>
                        onSetMirror(i, {
                          reflectivity: Math.min(0.99999, Number(e.target.value) || 0),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      placeholder="flat (∞)"
                      step={1}
                      value={m.radiusCurvatureMm ?? ""}
                      onChange={(e) =>
                        onSetMirror(i, {
                          radiusCurvatureMm:
                            e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="electronics-icon-btn"
                      onClick={() => onRemoveMirror(i)}
                      disabled={draft.mirrors.length <= 1}
                      title="Remove this mirror"
                    >
                      <Trash2 size={11} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <div className="electronics-error">{error}</div>}
        </div>
      </section>

      <div
        className="ws-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize metrics panel"
        onPointerDown={startDrag("right")}
      />

      <aside className="electronics-results">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">
            <Activity size={11} /> Derived metrics
          </span>
          {busy && <span className="cavity-busy">computing…</span>}
        </header>
        <div className="em-editor-body">
          {stabilityPill}
          {result && (
            <>
              <dl className="cavity-metrics">
                <div>
                  <dt>FSR</dt>
                  <dd>{fmtNumber(result.fsrMhz)} MHz</dd>
                </div>
                <div>
                  <dt>Finesse</dt>
                  <dd>{fmtNumber(result.finesse, 1)}</dd>
                </div>
                <div>
                  <dt>Linewidth (FWHM)</dt>
                  <dd>
                    {fmtNumber(result.linewidthMhz)} MHz
                    <br />
                    <span className="cavity-sub">{fmtNumber(result.linewidthPm)} pm</span>
                  </dd>
                </div>
                <div>
                  <dt>Quality factor Q</dt>
                  <dd>{fmtNumber(result.qualityFactor, 0)}</dd>
                </div>
                <div>
                  <dt>Photon lifetime</dt>
                  <dd>{fmtNumber(result.photonLifetimeNs, 2)} ns</dd>
                </div>
                <div>
                  <dt>Round-trip R</dt>
                  <dd>{fmtNumber(result.rtReflectivity, 4)}</dd>
                </div>
                {result.waistUm !== null && (
                  <div>
                    <dt>TEM₀₀ waist</dt>
                    <dd>{fmtNumber(result.waistUm, 1)} µm</dd>
                  </div>
                )}
                <div>
                  <dt>Resonance ν₀</dt>
                  <dd>{fmtNumber(result.resonanceFrequencyThz, 4)} THz</dd>
                </div>
              </dl>
              {result.warnings.length > 0 && (
                <ul className="cavity-warnings">
                  {result.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
              <AiryChart
                freqOffsetMhz={result.spectrumFreqOffsetMhz}
                transmission={result.spectrumTransmission}
                reflection={result.spectrumReflection}
                fwhmMhz={result.linewidthMhz}
              />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
