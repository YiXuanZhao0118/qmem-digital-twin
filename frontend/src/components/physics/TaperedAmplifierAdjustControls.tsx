/**
 * TaperedAmplifierAdjustControls — split out of PhysicsElementPanel.tsx
 * (god-file). 730-line inspector for a TA SceneObject:
 *
 *   - Live wavelength / drive current input
 *   - 2-D gain table (drive current x input power) +
 *     1-D ASE-vs-current table
 *   - Forward / backward output power readout (lerps the tables)
 *   - Front / back beam mode editor
 *   - Per-emission visualisation overrides (forward + backward, with
 *     the backward toggle so the user can hide the input-side ASE)
 *
 * AseSampleRow / GainSampleRow types + the interpolateAseUi helper
 * live alongside the component (they're TA-internal).
 */
import { useEffect, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";
import { EmissionVisualRow, SectionCard } from "./_shared";
import { PolarizationEditor } from "./PolarizationEditor";

function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

/** TA-specific controls: live wavelength + drive current + computed
 *  forward / backward power readout. Drives ase_samples and (later)
 *  gain_samples interpolation. */
type AseSampleRow = {
  driveCurrentMa: number;
  forwardPowerMw: number;
  backwardPowerMw: number;
};
type GainSampleRow = {
  inputPowerMw: number;
  driveCurrentMa: number;
  forwardPowerMw: number;
  backwardPowerMw: number;
};

/** Linear interpolation of (drive_current → fwd, bwd) ASE samples — must
 *  mirror the ray-tracer's interpolateAse. */
function interpolateAseUi(samples: AseSampleRow[], driveCurrentMa: number) {
  if (!samples.length) return { forwardMw: 0, backwardMw: 0 };
  const sorted = [...samples].sort((a, b) => a.driveCurrentMa - b.driveCurrentMa);
  if (driveCurrentMa <= sorted[0].driveCurrentMa) {
    return { forwardMw: sorted[0].forwardPowerMw, backwardMw: sorted[0].backwardPowerMw };
  }
  const last = sorted[sorted.length - 1];
  if (driveCurrentMa >= last.driveCurrentMa) {
    return { forwardMw: last.forwardPowerMw, backwardMw: last.backwardPowerMw };
  }
  for (let i = 1; i < sorted.length; i++) {
    if (driveCurrentMa <= sorted[i].driveCurrentMa) {
      const a = sorted[i - 1];
      const b = sorted[i];
      const t = (driveCurrentMa - a.driveCurrentMa) / (b.driveCurrentMa - a.driveCurrentMa);
      return {
        forwardMw: a.forwardPowerMw + (b.forwardPowerMw - a.forwardPowerMw) * t,
        backwardMw: a.backwardPowerMw + (b.backwardPowerMw - a.backwardPowerMw) * t,
      };
    }
  }
  return { forwardMw: 0, backwardMw: 0 };
}

export function TaperedAmplifierAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: NonNullable<ReturnType<typeof useSceneStore.getState>["scene"]["physicsElements"][number]>;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type AxisMode = { waistUm?: number; mSquared?: number; waistZOffsetMm?: number };
  type Jones = { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
  type TransverseKind = "TEM00" | "TEM_mn" | "LG_pl" | "multimode";
  type TransverseMode = { kind?: TransverseKind; indicesM?: number; indicesN?: number; indicesP?: number; indicesL?: number };
  type AseContinuous = { powerMw?: number; bandwidthNm?: number; centerOffsetNm?: number };
  type TaKindParams = {
    // operating point
    centerWavelengthNm?: number;
    driveCurrentMa?: number;
    driveCurrentMaxMa?: number;
    // steady-state (legacy bare-chip)
    smallSignalGainDb?: number;
    saturationPowerMw?: number;
    minInputPowerMw?: number | null;
    maxInputPowerMw?: number | null;
    inputAcceptanceRadiusMm?: number | null;
    ase?: AseContinuous;
    // beam profile
    inputSpatialModeX?: AxisMode | null;
    inputSpatialModeY?: AxisMode | null;
    inputPolarization?: Jones;
    inputTransverseMode?: TransverseMode;
    outputSpatialModeX?: AxisMode;
    outputSpatialModeY?: AxisMode;
    outputTransverseMode?: TransverseMode;
    outputPolarization?: Jones;
    backwardSpatialModeX?: AxisMode | null;
    backwardSpatialModeY?: AxisMode | null;
    // lookup tables (advanced — edited via API for now)
    aseSamples?: AseSampleRow[];
    gainSamples?: GainSampleRow[];
  };

  const params = (element.kindParams ?? {}) as TaKindParams;
  const wavelengthNm = params.centerWavelengthNm ?? 852;
  const driveCurrentMa = params.driveCurrentMa ?? 2400;
  const maxCurrentMa = params.driveCurrentMaxMa ?? 5000;
  const aseSamples = params.aseSamples ?? [];

  const smallSignalGainDb = params.smallSignalGainDb ?? 30.0;
  const saturationPowerMw = params.saturationPowerMw ?? 500.0;
  const minInputPowerMw = params.minInputPowerMw ?? 10.0;
  const maxInputPowerMw = params.maxInputPowerMw ?? 30.0;
  const inputAcceptanceRadiusMm = params.inputAcceptanceRadiusMm ?? 25.0;
  const aseCont: AseContinuous = params.ase ?? {};

  const isx: AxisMode = params.inputSpatialModeX ?? {};
  const isy: AxisMode = params.inputSpatialModeY ?? {};
  const osx: AxisMode = params.outputSpatialModeX ?? {};
  const osy: AxisMode = params.outputSpatialModeY ?? {};
  // backwardSpatialModeX/Y intentionally unread here — the editor was
  // removed by user request. Stored values pass through via the
  // shallow-merge `persist` calls below; ray-tracer / solver still use
  // them when present (rayTrace.ts:1689, optical_solver.py:499-500).
  const inPol: Jones = params.inputPolarization ?? { exRe: 0, exIm: 0, eyRe: 1, eyIm: 0 };
  const outPol: Jones = params.outputPolarization ?? { exRe: 0, exIm: 0, eyRe: 1, eyIm: 0 };
  const inTm: TransverseMode = params.inputTransverseMode ?? { kind: "TEM00" };
  const outTm: TransverseMode = params.outputTransverseMode ?? { kind: "TEM00" };

  // Live readout of forward / backward ASE power at the configured drive
  // current (no seed; gain_samples will replace this once a real upstream
  // beam is detected — that's a future 2-pass-trace feature).
  const { forwardMw, backwardMw } = interpolateAseUi(aseSamples, driveCurrentMa);

  const persist = async (patch: Partial<TaKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  const setSpatial = (
    key: "inputSpatialModeX" | "inputSpatialModeY" | "outputSpatialModeX" | "outputSpatialModeY" | "backwardSpatialModeX" | "backwardSpatialModeY",
    current: AxisMode | null,
    patch: Partial<AxisMode>,
  ) => {
    void persist({ [key]: { ...(current ?? {}), ...patch } } as Partial<TaKindParams>);
  };

  const setAse = (patch: Partial<AseContinuous>) => {
    void persist({ ase: { ...aseCont, ...patch } });
  };


  const buildTransverseMode = (next: TransverseKind, prev: TransverseMode): TransverseMode => {
    const out: TransverseMode = { kind: next };
    if (next === "TEM_mn") {
      out.indicesM = prev.indicesM ?? 0;
      out.indicesN = prev.indicesN ?? 0;
    } else if (next === "LG_pl") {
      out.indicesP = prev.indicesP ?? 0;
      out.indicesL = prev.indicesL ?? 0;
    }
    return out;
  };
  const setInTransverseKind = (next: TransverseKind) => {
    void persist({ inputTransverseMode: buildTransverseMode(next, inTm) });
  };
  const setOutTransverseKind = (next: TransverseKind) => {
    void persist({ outputTransverseMode: buildTransverseMode(next, outTm) });
  };

  // Numeric input cell that commits on blur / Enter.
  const NumberCell = ({
    label,
    value,
    step = 0.1,
    onCommit,
    suffix,
    style,
  }: {
    label: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    suffix?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(value.toString());
    useEffect(() => setDraft(value.toString()), [value]);
    const commit = (raw: string) => {
      const v = Number(raw);
      if (!Number.isFinite(v)) return;
      onCommit(v);
    };
    return (
      <label className="component-editor-coord" style={style}>
        <span style={{ fontSize: 11 }}>{label}{suffix ? ` (${suffix})` : ""}</span>
        <input
          type="number"
          step={step}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </label>
    );
  };



  return (
    <div className="snap-to-beam">
      {/* Anchor mapping legend — explains which kindParams group attaches
          to which physical anchor on the asset. Asset anchors are seeded
          in seed.py (intercept_in @ +X face = seed; intercept_out @ -X
          face = amplified output). */}
      <SectionCard id="physics.tapered_amplifier.anchor-map" title="Anchor map">
        <div style={{ fontSize: 10, opacity: 0.85, lineHeight: 1.5 }}>
          <div><code>intercept_in</code> &nbsp;=&nbsp; seed face (+X) &nbsp;←&nbsp; Input beam profile · backward ASE exits here</div>
          <div><code>intercept_out</code> &nbsp;=&nbsp; output face (−X) &nbsp;←&nbsp; Output beam profile · forward amplified emission</div>
        </div>
      </SectionCard>

      {/* Operating point */}
      <SectionCard id="physics.tapered_amplifier.operating-point" title="Operating point" defaultOpen>
        <div className="physics-grid-3">
          <NumberCell
            label="Wavelength"
            suffix="nm"
            value={wavelengthNm}
            step={0.1}
            onCommit={(v) => v > 0 && void persist({ centerWavelengthNm: v })}
          />
          <NumberCell
            label="Drive current"
            suffix="mA"
            value={driveCurrentMa}
            step={50}
            onCommit={(v) =>
              v >= 0 && void persist({ driveCurrentMa: Math.min(v, maxCurrentMa) })
            }
          />
          <NumberCell
            label="Max current"
            suffix="mA"
            value={maxCurrentMa}
            step={50}
            onCommit={(v) => v > 0 && void persist({ driveCurrentMaxMa: v })}
          />
        </div>
        <div style={{ opacity: 0.75, marginTop: 4, fontSize: 10, lineHeight: 1.55 }}>
          ASE @ {driveCurrentMa.toFixed(0)} mA:
          <div style={{ marginTop: 2 }}>
            forward <strong>{forwardMw.toFixed(1)} mW</strong> · amplified emission
          </div>
          <div>
            backward <strong>{backwardMw.toFixed(1)} mW</strong> · ASE leak through seed facet
          </div>
          {aseSamples.length === 0
            ? " (no aseSamples — solver falls back to the single-direction continuous ASE below)"
            : null}
        </div>
      </SectionCard>

      {/* Steady-state gain (no lookup) */}
      <SectionCard id="physics.tapered_amplifier.steady-gain" title="Steady-state gain">
        <div className="physics-grid-2">
          <NumberCell
            label="Small-signal gain"
            suffix="dB"
            value={smallSignalGainDb}
            step={0.5}
            onCommit={(v) => void persist({ smallSignalGainDb: v })}
          />
          <NumberCell
            label="Saturation power"
            suffix="mW"
            value={saturationPowerMw}
            step={10}
            onCommit={(v) => v > 0 && void persist({ saturationPowerMw: v })}
          />
          <NumberCell
            label="Min input"
            suffix="mW"
            value={minInputPowerMw}
            step={1}
            onCommit={(v) => v >= 0 && void persist({ minInputPowerMw: v })}
          />
          <NumberCell
            label="Max input"
            suffix="mW"
            value={maxInputPowerMw}
            step={1}
            onCommit={(v) => v >= 0 && void persist({ maxInputPowerMw: v })}
          />
          <NumberCell
            label="Acceptance radius"
            suffix="mm"
            value={inputAcceptanceRadiusMm}
            step={1}
            onCommit={(v) => v > 0 && void persist({ inputAcceptanceRadiusMm: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Used when no aseSamples / gainSamples lookup tables are present.
        </div>
      </SectionCard>

      {/* ASE (continuous fallback). The legacy `ase.power_mw` field is
          single-direction — the solver applies it as the FORWARD ASE at
          intercept_out only, so it intentionally does NOT split per-port.
          The accurate per-anchor split lives in `aseSamples` (shown in
          the Operating-point readout above). When `aseSamples` is empty
          the solver falls back to the value below for forward only;
          backward ASE is implicitly zero in that fallback path. */}
      <SectionCard
        id="physics.tapered_amplifier.ase-fallback"
        title={<>ASE fallback <span style={{ opacity: 0.7, fontWeight: 400 }}>(used when aseSamples is empty)</span></>}
      >
        <div className="physics-grid-3">
          <NumberCell
            label="Forward power @ intercept_out"
            suffix="mW"
            value={aseCont.powerMw ?? 5.0}
            step={0.5}
            onCommit={(v) => v >= 0 && setAse({ powerMw: v })}
          />
          <NumberCell
            label="Bandwidth"
            suffix="nm"
            value={aseCont.bandwidthNm ?? 1.0}
            step={0.1}
            onCommit={(v) => v > 0 && setAse({ bandwidthNm: v })}
          />
          <NumberCell
            label="Center offset"
            suffix="nm"
            value={aseCont.centerOffsetNm ?? 0.0}
            step={0.1}
            onCommit={(v) => setAse({ centerOffsetNm: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Single-direction (forward-only) legacy field. For real per-port
          values (forward at <code>intercept_out</code>, backward at
          <code>intercept_in</code>), populate <code>aseSamples</code>
          via the API.
        </div>
      </SectionCard>

      {/* Input beam profile — applies at the intercept_in (+X / seed) anchor */}
      <SectionCard
        id="physics.tapered_amplifier.input-beam"
        title={<>Input beam profile <span style={{ opacity: 0.7, fontWeight: 400 }}>@ <code>intercept_in</code></span></>}
      >
        <div style={{ marginBottom: 4, fontSize: 10, opacity: 0.7 }}>X axis</div>
        <div className="physics-grid-3">
          <NumberCell label="waist" suffix="μm" value={isx.waistUm ?? 600} step={10}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeX", isx, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={isx.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("inputSpatialModeX", isx, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={isx.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeX", isx, { mSquared: v })} />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 10, opacity: 0.7 }}>Y axis</div>
        <div className="physics-grid-3">
          <NumberCell label="waist" suffix="μm" value={isy.waistUm ?? 600} step={10}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeY", isy, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={isy.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("inputSpatialModeY", isy, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={isy.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeY", isy, { mSquared: v })} />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 11, opacity: 0.85 }}>
          Input polarization
        </div>
        <PolarizationEditor
          value={inPol}
          onChange={(j) => void persist({ inputPolarization: j })}
        />
        <label className="component-editor-coord" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 11 }}>Transverse mode</span>
          <select
            value={inTm.kind ?? "TEM00"}
            onChange={(e) => setInTransverseKind(e.target.value as TransverseKind)}
          >
            <option value="TEM00">TEM₀₀</option>
            <option value="TEM_mn">TEM_mn</option>
            <option value="LG_pl">LG_pl</option>
            <option value="multimode">multimode</option>
          </select>
        </label>
        {inTm.kind === "TEM_mn" && (
          <div className="physics-grid-2">
            <NumberCell label="m" value={inTm.indicesM ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "TEM_mn", indicesM: Math.round(v) } })} />
            <NumberCell label="n" value={inTm.indicesN ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "TEM_mn", indicesN: Math.round(v) } })} />
          </div>
        )}
        {inTm.kind === "LG_pl" && (
          <div className="physics-grid-2">
            <NumberCell label="p" value={inTm.indicesP ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "LG_pl", indicesP: Math.round(v) } })} />
            <NumberCell label="ℓ" value={inTm.indicesL ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "LG_pl", indicesL: Math.round(v) } })} />
          </div>
        )}
      </SectionCard>

      {/* Output beam profile — applies at the intercept_out (−X / amplified) anchor */}
      <SectionCard
        id="physics.tapered_amplifier.output-beam"
        title={<>Output beam profile <span style={{ opacity: 0.7, fontWeight: 400 }}>@ <code>intercept_out</code></span></>}
      >
        <div style={{ marginBottom: 4, fontSize: 10, opacity: 0.7 }}>X axis</div>
        <div className="physics-grid-3">
          <NumberCell label="waist" suffix="μm" value={osx.waistUm ?? 500} step={10}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeX", osx, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={osx.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("outputSpatialModeX", osx, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={osx.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeX", osx, { mSquared: v })} />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 10, opacity: 0.7 }}>Y axis</div>
        <div className="physics-grid-3">
          <NumberCell label="waist" suffix="μm" value={osy.waistUm ?? 50} step={5}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeY", osy, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={osy.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("outputSpatialModeY", osy, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={osy.mSquared ?? 8.0} step={0.1}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeY", osy, { mSquared: v })} />
        </div>
        <label className="component-editor-coord" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 11 }}>Transverse mode</span>
          <select
            value={outTm.kind ?? "TEM00"}
            onChange={(e) => setOutTransverseKind(e.target.value as TransverseKind)}
          >
            <option value="TEM00">TEM₀₀</option>
            <option value="TEM_mn">TEM_mn</option>
            <option value="LG_pl">LG_pl</option>
            <option value="multimode">multimode</option>
          </select>
        </label>
        {outTm.kind === "TEM_mn" && (
          <div className="physics-grid-2">
            <NumberCell label="m" value={outTm.indicesM ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "TEM_mn", indicesM: Math.round(v) } })} />
            <NumberCell label="n" value={outTm.indicesN ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "TEM_mn", indicesN: Math.round(v) } })} />
          </div>
        )}
        {outTm.kind === "LG_pl" && (
          <div className="physics-grid-2">
            <NumberCell label="p" value={outTm.indicesP ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "LG_pl", indicesP: Math.round(v) } })} />
            <NumberCell label="ℓ" value={outTm.indicesL ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "LG_pl", indicesL: Math.round(v) } })} />
          </div>
        )}
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 11, opacity: 0.85 }}>
          Output polarization
        </div>
        <PolarizationEditor
          value={outPol}
          onChange={(j) => void persist({ outputPolarization: j })}
        />
      </SectionCard>

      {/* Backward beam profile editor removed by user request — when not
          set in kindParams, the ray-tracer (rayTrace.ts:1689) and solver
          (optical_solver.py:499-500) both fall back to the forward
          profile, so the backward ASE arrow still has a sensible waist.
          Values pre-set via the API are still honoured. */}

      {/* Visualization — per-instance beam colour for the two emissions.
          Backward (input-port ASE) also has a Show toggle so the user can
          declutter the scene by hiding it; hiding skips the trace entirely
          so downstream optics also stop reflecting it. */}
      <SectionCard id="physics.tapered_amplifier.visualization" title="Visualization">
        <EmissionVisualRow
          sceneObject={sceneObject}
          emissionKey="forward"
          label="Output (forward)"
          fallbackColorHex={wavelengthHex(wavelengthNm)}
          showVisibilityToggle={false}
        />
        <EmissionVisualRow
          sceneObject={sceneObject}
          emissionKey="backward"
          label="Input (backward ASE)"
          fallbackColorHex={wavelengthHex(wavelengthNm)}
          showVisibilityToggle={true}
        />
      </SectionCard>

      {/* Lookup-table summary (sampled tables — edit via API for now) */}
      <SectionCard id="physics.tapered_amplifier.lookup-tables" title="Lookup tables">
        <div style={{ opacity: 0.75, fontSize: 10 }}>
          aseSamples: <strong>{aseSamples.length}</strong> rows · gainSamples:{" "}
          <strong>{(params.gainSamples ?? []).length}</strong> rows.
          {aseSamples.length === 0 && (params.gainSamples ?? []).length === 0
            ? " None present — solver uses the steady-state + ASE values above."
            : " Solver interpolates these in preference to the steady-state values."}
        </div>
      </SectionCard>

    </div>
  );
}
