/**
 * Optical nonlinear-crystal calculator — Phase Optics-Crystal.
 *
 * Reuses the same shared module shell (.electronics-workspace +
 * .em-editor-* form widgets) as Cavity / Electronics / EM. Three
 * panes:
 *   - left:   crystal preset list + global parameters (kind, pump λ,
 *             temperature, poling period override)
 *   - center: phase-match result table + auto-computed SPDC tuning
 *             curve (signal/idler vs T)
 *   - right:  SHG efficiency calculator + result card
 */
import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useResizablePanes } from "../../components/workspace/useResizablePanes";
import {
  computeCrystalPhaseMatchApi,
  computeCrystalShgApi,
  computeCrystalSpdcTuningApi,
  fetchCrystalCatalogApi,
  type CrystalCatalogResult,
  type CrystalPhaseMatchResult,
  type CrystalShgResult,
  type CrystalSpdcTuningResult,
  type CrystalSummary,
  type NLKind,
} from "../../api/client";
import { useSceneStore } from "../../store/sceneStore";
import { TuningChart } from "./TuningChart";

type Preset = {
  id: string;
  label: string;
  description: string;
  crystalId: string;
  kind: NLKind;
  pumpNm: number;
  signalNm: number;
  tC: number;
};

const PRESETS: Preset[] = [
  {
    id: "ppktp_cs_d1",
    label: "PPKTP 447.5 → 895 (Cs D1)",
    description:
      "Degenerate Type-0 SPDC for Cs 6²S₁/₂ → 6²P₁/₂ memory at 894.6 nm.",
    crystalId: "ppktp",
    kind: "type0_eee",
    pumpNm: 447.5,
    signalNm: 895.0,
    tC: 25.0,
  },
  {
    id: "ppktp_cs_d2",
    label: "PPKTP 426 → 852 (Cs D2)",
    description: "Degenerate Type-0 SPDC for Cs 6²S₁/₂ → 6²P₃/₂ at 852.3 nm.",
    crystalId: "ppktp",
    kind: "type0_eee",
    pumpNm: 426.0,
    signalNm: 852.0,
    tC: 25.0,
  },
  {
    id: "ppktp_405_810",
    label: "PPKTP 405 → 810 (Ti:Sa)",
    description: "Classical entangled-photon source. Degenerate Type-0 SPDC.",
    crystalId: "ppktp",
    kind: "type0_eee",
    pumpNm: 405.0,
    signalNm: 810.0,
    tC: 25.0,
  },
  {
    id: "ppln_1064_532",
    label: "PPLN 1064 → 532 (SHG)",
    description: "MgO:PPLN second-harmonic generation. Type-0 e+e→e at d_33.",
    crystalId: "ppln_mgo",
    kind: "type0_eee",
    pumpNm: 532.0,
    signalNm: 1064.0,
    tC: 25.0,
  },
];

const KIND_LABELS: Record<NLKind, string> = {
  type0_eee: "Type-0 (e+e → e)",
  type1_ooe: "Type-I (o+o → e)",
  type2_oeo: "Type-II (o+e → o)",
  type2_eoe: "Type-II (e+o → e)",
};

function fmt(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-3)) {
    return value.toExponential(digits);
  }
  return value.toFixed(digits);
}

export function CrystalWorkspace() {
  const [catalog, setCatalog] = useState<CrystalCatalogResult | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>("ppktp_cs_d1");

  // Form state (mirrors a preset; user can override).
  const [crystalId, setCrystalId] = useState("ppktp");
  const [kind, setKind] = useState<NLKind>("type0_eee");
  const [pumpNm, setPumpNm] = useState(447.5);
  const [signalNm, setSignalNm] = useState(895.0);
  const [tC, setTC] = useState(25.0);

  // SHG sub-form. Default fundamental tracks the default preset's signal
  // wavelength (PPKTP Cs D1: 895 nm) so the "SHG of the SPDC daughter" use
  // case shows the right Δk-matching numbers on first load.
  const [shgFundamentalNm, setShgFundamentalNm] = useState(895.0);
  const [shgPumpW, setShgPumpW] = useState(1.0);
  const [shgLengthMm, setShgLengthMm] = useState(10.0);
  const [shgWaistUm, setShgWaistUm] = useState(50.0);

  const [phaseMatch, setPhaseMatch] = useState<CrystalPhaseMatchResult | null>(null);
  const [tuning, setTuning] = useState<CrystalSpdcTuningResult | null>(null);
  const [shg, setShg] = useState<CrystalShgResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dispatchSimulationRun = useSceneStore((s) => s.dispatchSimulationRun);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const { startDrag } = useResizablePanes({
    id: "crystal",
    containerRef: workspaceRef,
  });

  // Load catalog once.
  useEffect(() => {
    void (async () => {
      try {
        const c = await fetchCrystalCatalogApi();
        setCatalog(c);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  // Sequential phase-match → SPDC tuning + SHG. Single fn so the Run
  // button can call it directly, bypassing the auto-debounce.
  const runCompute = async (signal?: { cancelled: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const pm = await computeCrystalPhaseMatchApi({
        crystalId,
        kind,
        pumpNm,
        signalNm,
        tC,
      });
      if (signal?.cancelled) return;
      setPhaseMatch(pm);

      const [tu, shgRes] = await Promise.all([
        computeCrystalSpdcTuningApi({
          crystalId,
          kind,
          pumpNm,
          polingUm: pm.polingPeriodUm ?? undefined,
          tMinC: Math.max(0, tC - 40),
          tMaxC: tC + 40,
          tPoints: 41,
        }),
        computeCrystalShgApi({
          crystalId,
          kind,
          fundamentalNm: shgFundamentalNm,
          pPumpW: shgPumpW,
          crystalLengthMm: shgLengthMm,
          beamWaistUm: shgWaistUm,
          tC,
          polingUm: pm.polingPeriodUm ?? undefined,
        }),
      ]);
      if (signal?.cancelled) return;
      setTuning(tu);
      setShg(shgRes);
    } catch (err) {
      if (signal?.cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhaseMatch(null);
      setTuning(null);
      setShg(null);
    } finally {
      if (!signal?.cancelled) setBusy(false);
    }
  };

  // Run button: keep the live inline result, but ALSO dispatch a real
  // SimulationRun so the configuration is saved in SolverConsole.
  const runAndPersist = async () => {
    await runCompute();
    try {
      await dispatchSimulationRun({
        module: "optics_crystal",
        params: {
          crystalId,
          kind,
          pumpNm,
          signalNm,
          tC,
          shgFundamentalNm,
          shgPumpW,
          shgLengthMm,
          shgWaistUm,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    const signal = { cancelled: false };
    const handle = window.setTimeout(() => {
      void runCompute(signal);
    }, 250);
    return () => {
      signal.cancelled = true;
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    crystalId,
    kind,
    pumpNm,
    signalNm,
    tC,
    shgFundamentalNm,
    shgPumpW,
    shgLengthMm,
    shgWaistUm,
  ]);

  const onPickPreset = (p: Preset) => {
    setActivePresetId(p.id);
    setCrystalId(p.crystalId);
    setKind(p.kind);
    setPumpNm(p.pumpNm);
    setSignalNm(p.signalNm);
    setTC(p.tC);
    // Suggest SHG fundamental = 2·pump (degenerate SHG ↔ SPDC pair).
    setShgFundamentalNm(p.signalNm);
  };

  const activeCrystal: CrystalSummary | null = useMemo(() => {
    if (!catalog) return null;
    return catalog.crystals.find((c) => c.id === crystalId) ?? null;
  }, [catalog, crystalId]);

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
          <span className="electronics-sidebar-title">Configuration</span>
        </header>
        <div className="em-editor-body" style={{ paddingTop: 10 }}>
          <div className="em-editor-row" style={{ gridTemplateColumns: "1fr" }}>
            <label>
              Crystal
              <select
                value={crystalId}
                onChange={(e) => {
                  setActivePresetId(null);
                  setCrystalId(e.target.value);
                }}
              >
                {catalog?.crystals.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.fullName}
                    {c.isQpm ? " · QPM" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="em-editor-row" style={{ gridTemplateColumns: "1fr" }}>
            <label>
              Interaction kind
              <select
                value={kind}
                onChange={(e) => {
                  setActivePresetId(null);
                  setKind(e.target.value as NLKind);
                }}
              >
                {(activeCrystal?.kinds ?? Object.keys(KIND_LABELS)).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k as NLKind] ?? k}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="em-editor-row">
            <label>
              Pump λ (nm)
              <input
                type="number"
                min={200}
                step={0.5}
                value={pumpNm}
                onChange={(e) => {
                  setActivePresetId(null);
                  setPumpNm(Number(e.target.value) || 0);
                }}
              />
            </label>
            <label>
              Signal λ (nm)
              <input
                type="number"
                min={200}
                step={0.5}
                value={signalNm}
                onChange={(e) => {
                  setActivePresetId(null);
                  setSignalNm(Number(e.target.value) || 0);
                }}
              />
            </label>
          </div>
          <div className="em-editor-row">
            <label>
              Temperature (°C)
              <input
                type="number"
                min={-10}
                max={200}
                step={1}
                value={tC}
                onChange={(e) => {
                  setActivePresetId(null);
                  setTC(Number(e.target.value));
                }}
              />
            </label>
          </div>
          {activeCrystal && (
            <p className="cavity-preset-desc" style={{ marginTop: 4 }}>
              {activeCrystal.description}
            </p>
          )}
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
          <span className="electronics-sidebar-title">Phase matching</span>
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
        </header>
        <div className="em-editor-body">
          {error && <div className="electronics-error">{error}</div>}
          {phaseMatch && (
            <>
              <dl className="cavity-metrics">
                <div>
                  <dt>QPM period Λ</dt>
                  <dd>
                    {phaseMatch.polingPeriodUm !== null
                      ? `${fmt(phaseMatch.polingPeriodUm, 4)} µm`
                      : "BPM (angle θ)"}
                  </dd>
                </div>
                <div>
                  <dt>Idler λ</dt>
                  <dd>{fmt(phaseMatch.idlerNm, 2)} nm</dd>
                </div>
                <div>
                  <dt>n(pump)</dt>
                  <dd>{fmt(phaseMatch.nPump, 4)}</dd>
                </div>
                <div>
                  <dt>n(signal)</dt>
                  <dd>{fmt(phaseMatch.nSignal, 4)}</dd>
                </div>
                <div>
                  <dt>n(idler)</dt>
                  <dd>{fmt(phaseMatch.nIdler, 4)}</dd>
                </div>
                <div>
                  <dt>Δk_bulk</dt>
                  <dd>{fmt(phaseMatch.deltaKBulkPerMm, 1)} rad/mm</dd>
                </div>
              </dl>
              {phaseMatch.warnings.length > 0 && (
                <ul className="cavity-warnings">
                  {phaseMatch.warnings.map((w, i) => (
                    <li key={i}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tuning && tuning.rows.length > 0 && (
            <>
              <header className="electronics-sidebar-header" style={{ marginTop: 12 }}>
                <span className="electronics-sidebar-title">
                  SPDC tuning vs temperature
                </span>
                {tuning.autoPolingUm !== null && (
                  <span className="cavity-busy" style={{ marginLeft: "auto" }}>
                    @ Λ = {fmt(tuning.autoPolingUm, 4)} µm
                  </span>
                )}
              </header>
              <TuningChart
                tC={tuning.rows.map((r) => r.tC)}
                signalNm={tuning.rows.map((r) => r.signalNm)}
                idlerNm={tuning.rows.map((r) => r.idlerNm)}
              />
            </>
          )}
        </div>
      </section>

      <div
        className="ws-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize SHG panel"
        onPointerDown={startDrag("right")}
      />

      <aside className="electronics-results">
        <header className="electronics-sidebar-header">
          <span className="electronics-sidebar-title">SHG efficiency</span>
        </header>
        <div className="em-editor-body">
          <div className="em-editor-row">
            <label>
              Fundamental λ (nm)
              <input
                type="number"
                min={400}
                step={1}
                value={shgFundamentalNm}
                onChange={(e) => setShgFundamentalNm(Number(e.target.value))}
              />
            </label>
            <label>
              Pump power (W)
              <input
                type="number"
                min={0}
                step={0.1}
                value={shgPumpW}
                onChange={(e) => setShgPumpW(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="em-editor-row">
            <label>
              Crystal length (mm)
              <input
                type="number"
                min={0.1}
                step={1}
                value={shgLengthMm}
                onChange={(e) => setShgLengthMm(Number(e.target.value))}
              />
            </label>
            <label>
              Beam waist (µm)
              <input
                type="number"
                min={1}
                step={5}
                value={shgWaistUm}
                onChange={(e) => setShgWaistUm(Number(e.target.value))}
              />
            </label>
          </div>
          {shg && (
            <dl className="cavity-metrics" style={{ marginTop: 10 }}>
              <div>
                <dt>SH wavelength</dt>
                <dd>{fmt(shg.secondHarmonicNm, 2)} nm</dd>
              </div>
              <div>
                <dt>d_eff</dt>
                <dd>{fmt(shg.dEffPmPerV, 2)} pm/V</dd>
              </div>
              <div>
                <dt>P (2ω)</dt>
                <dd>{fmt(shg.pShW, 4)} W</dd>
              </div>
              <div>
                <dt>η = P_2ω / P_ω</dt>
                <dd>
                  {fmt(shg.eta * 100, 4)} %
                </dd>
              </div>
              <div>
                <dt>sinc² rolloff</dt>
                <dd>{fmt(shg.sincFactor, 4)}</dd>
              </div>
              <div>
                <dt>Δk·L/2</dt>
                <dd>
                  {fmt(shg.deltaKEffectivePerMm * shgLengthMm * 0.5, 3)} rad
                </dd>
              </div>
            </dl>
          )}
        </div>
      </aside>
    </div>
  );
}
