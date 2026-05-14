/**
 * LaserSourceControls — split out of PhysicsElementPanel.tsx
 * (god-file). 540-line inspector for the V2-synthesised
 * laser_source kindParams (beam power / wavelength, spectrum,
 * polarization, spatial mode X/Y, transverse mode).
 *
 * Backend translation note (kept here next to the code that
 * depends on it): the GET translator (V2 Phase 3, alembic 0029)
 * synthesises the legacy kindParams shape from
 * `objects.properties.opticalSources[].beam`, so this panel can
 * keep reading the V1-style fields. PUT goes back via
 * upsertOpticalElement; the backend translator routes the
 * V2-tracked fields back into opticalSources[0].beam.
 */
import { useEffect, useState } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type {
  ComponentItem,
  PhysicsElement,
  SceneObject,
} from "../../types/digitalTwin";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";

function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

/** Fixed-format UI for laser_source kindParams (V2 synthesised shape).
 *
 *  Reads element.kindParams as the source of truth. The backend's GET
 *  translator (V2 Phase 3, alembic 0029) synthesises the legacy shape
 *  from objects.properties.opticalSources[].beam, so the panel reads
 *  the V1-style fields here. On save, upsertOpticalElement PUTs the
 *  legacy kindParams back; the backend's PUT translator routes the
 *  V2-tracked fields into opticalSources[0].beam, leaving kindParams
 *  empty in DB.
 *
 *  Layout (one section per logical group; numeric inputs commit on
 *  Enter / blur to avoid validation churn):
 *    1. Beam:     power (mW), wavelength (nm)
 *    2. Spectrum: linewidth shape selector + dependent FWHM input(s)
 *    3. Polarization: Jones preset selector + 4 raw inputs
 *    4. Spatial mode (X / Y): waist (μm), offset (mm), M²
 *    5. Transverse mode: family + indices
 */
export function LaserSourceControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: NonNullable<ReturnType<typeof useSceneStore.getState>["scene"]["physicsElements"][number]>;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type LinewidthShape = "delta" | "gaussian" | "lorentzian" | "voigt";
  type TransverseKind = "TEM00" | "TEM_mn" | "LG_pl" | "multimode";
  type AxisMode = { waistUm?: number; waistZOffsetMm?: number; mSquared?: number };
  type SpectrumComponent = {
    kind?: string;
    lineshape?: LinewidthShape;
    fwhmMhz?: number;
    voigtGaussianFwhmMhz?: number;
    voigtLorentzianFwhmMhz?: number;
    amplitude?: number;
    offsetMhz?: number;
  };
  type LaserKindParams = {
    nominalPowerMw?: number;
    centerWavelengthNm?: number;
    spectrum?: { centerThz?: number; components?: SpectrumComponent[] };
    spatialModeX?: AxisMode;
    spatialModeY?: AxisMode;
    transverseMode?: { kind?: TransverseKind; indicesM?: number; indicesN?: number; indicesP?: number; indicesL?: number };
    polarization?: { exRe?: number; exIm?: number; eyRe?: number; eyIm?: number };
  };

  const params = (element.kindParams ?? {}) as LaserKindParams;

  // ---- field readers (with fall-backs to V2 defaults) ----------------
  const powerMw = params.nominalPowerMw ?? 1.0;
  const wavelengthNm = params.centerWavelengthNm ?? 780.241;
  const firstComponent = params.spectrum?.components?.[0] ?? {};
  const lineshape: LinewidthShape = (firstComponent.lineshape as LinewidthShape) ?? "delta";
  const fwhmMhz = firstComponent.fwhmMhz ?? 1.0;
  const voigtG = firstComponent.voigtGaussianFwhmMhz ?? 0.5;
  const voigtL = firstComponent.voigtLorentzianFwhmMhz ?? 0.5;
  const sx: AxisMode = params.spatialModeX ?? {};
  const sy: AxisMode = params.spatialModeY ?? {};
  const tm = params.transverseMode ?? { kind: "TEM00" };
  const pol = params.polarization ?? { exRe: 1, exIm: 0, eyRe: 0, eyIm: 0 };

  // Polarization preset detection
  const isClose = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;
  const polPreset: string = (() => {
    const inv2 = 1 / Math.SQRT2;
    if (isClose(pol.exRe ?? 0, 1) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, 0) && isClose(pol.eyIm ?? 0, 0)) return "H";
    if (isClose(pol.exRe ?? 0, 0) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, 1) && isClose(pol.eyIm ?? 0, 0)) return "V";
    if (isClose(pol.exRe ?? 0, inv2) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, inv2) && isClose(pol.eyIm ?? 0, 0)) return "+45";
    if (isClose(pol.exRe ?? 0, inv2) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, -inv2) && isClose(pol.eyIm ?? 0, 0)) return "-45";
    if (isClose(pol.exRe ?? 0, inv2) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, 0) && isClose(pol.eyIm ?? 0, inv2)) return "RCP";
    if (isClose(pol.exRe ?? 0, inv2) && isClose(pol.exIm ?? 0, 0) && isClose(pol.eyRe ?? 0, 0) && isClose(pol.eyIm ?? 0, -inv2)) return "LCP";
    return "custom";
  })();

  // ---- writer: shallow-merge a patch into kindParams + persist -------
  const persist = async (patch: Partial<LaserKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Numeric input cell that commits on blur / Enter (uncontrolled-ish).
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

  // ---- handlers ------------------------------------------------------
  const setLineshape = (next: LinewidthShape) => {
    const base: SpectrumComponent = { kind: "main", lineshape: next, amplitude: 1.0, offsetMhz: 0.0 };
    if (next === "gaussian" || next === "lorentzian") base.fwhmMhz = fwhmMhz;
    if (next === "voigt") {
      base.voigtGaussianFwhmMhz = voigtG;
      base.voigtLorentzianFwhmMhz = voigtL;
    }
    void persist({ spectrum: { centerThz: params.spectrum?.centerThz, components: [base] } });
  };

  const setSpatial = (axis: "X" | "Y", patch: Partial<AxisMode>) => {
    const key = axis === "X" ? "spatialModeX" : "spatialModeY";
    const current = (axis === "X" ? sx : sy) ?? {};
    void persist({ [key]: { ...current, ...patch } } as Partial<LaserKindParams>);
  };

  const setTransverseKind = (next: TransverseKind) => {
    const out: NonNullable<LaserKindParams["transverseMode"]> = { kind: next };
    if (next === "TEM_mn") {
      out.indicesM = tm.indicesM ?? 0;
      out.indicesN = tm.indicesN ?? 0;
    } else if (next === "LG_pl") {
      out.indicesP = tm.indicesP ?? 0;
      out.indicesL = tm.indicesL ?? 0;
    }
    void persist({ transverseMode: out });
  };

  const setPolPreset = (next: string) => {
    if (next === "custom") return;
    const inv2 = 1 / Math.SQRT2;
    const presets: Record<string, [number, number, number, number]> = {
      H: [1, 0, 0, 0],
      V: [0, 0, 1, 0],
      "+45": [inv2, 0, inv2, 0],
      "-45": [inv2, 0, -inv2, 0],
      RCP: [inv2, 0, 0, inv2],
      LCP: [inv2, 0, 0, -inv2],
    };
    const j = presets[next];
    if (!j) return;
    void persist({ polarization: { exRe: j[0], exIm: j[1], eyRe: j[2], eyIm: j[3] } });
  };

  // ---- shared section style -----------------------------------------
  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 };

  return (
    <div className="snap-to-beam">
      {/* Beam basics */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Beam</div>
        <div style={grid2}>
          <NumberCell
            label="Power"
            suffix="mW"
            value={powerMw}
            step={0.1}
            onCommit={(v) => v >= 0 && void persist({ nominalPowerMw: v })}
          />
          <NumberCell
            label="Wavelength"
            suffix="nm"
            value={wavelengthNm}
            step={0.001}
            onCommit={(v) => v > 0 && void persist({ centerWavelengthNm: v })}
          />
        </div>
      </div>

      {/* Spectrum / linewidth */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Spectrum</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Linewidth shape</span>
          <select
            value={lineshape}
            onChange={(e) => setLineshape(e.target.value as LinewidthShape)}
          >
            <option value="delta">delta (ideal)</option>
            <option value="gaussian">gaussian</option>
            <option value="lorentzian">lorentzian</option>
            <option value="voigt">voigt</option>
          </select>
        </label>
        {(lineshape === "gaussian" || lineshape === "lorentzian") && (
          <NumberCell
            label="FWHM"
            suffix="MHz"
            value={fwhmMhz}
            step={0.1}
            onCommit={(v) =>
              v > 0 &&
              void persist({
                spectrum: {
                  centerThz: params.spectrum?.centerThz,
                  components: [{ kind: "main", lineshape, fwhmMhz: v, amplitude: 1.0, offsetMhz: 0 }],
                },
              })
            }
          />
        )}
        {lineshape === "voigt" && (
          <div style={grid2}>
            <NumberCell
              label="Gaussian FWHM"
              suffix="MHz"
              value={voigtG}
              onCommit={(v) =>
                v > 0 &&
                void persist({
                  spectrum: {
                    centerThz: params.spectrum?.centerThz,
                    components: [{
                      kind: "main", lineshape: "voigt",
                      voigtGaussianFwhmMhz: v, voigtLorentzianFwhmMhz: voigtL,
                      amplitude: 1.0, offsetMhz: 0,
                    }],
                  },
                })
              }
            />
            <NumberCell
              label="Lorentzian FWHM"
              suffix="MHz"
              value={voigtL}
              onCommit={(v) =>
                v > 0 &&
                void persist({
                  spectrum: {
                    centerThz: params.spectrum?.centerThz,
                    components: [{
                      kind: "main", lineshape: "voigt",
                      voigtGaussianFwhmMhz: voigtG, voigtLorentzianFwhmMhz: v,
                      amplitude: 1.0, offsetMhz: 0,
                    }],
                  },
                })
              }
            />
          </div>
        )}
      </div>

      {/* Polarization */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Polarization</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Preset</span>
          <select value={polPreset} onChange={(e) => setPolPreset(e.target.value)}>
            <option value="H">H — horizontal</option>
            <option value="V">V — vertical</option>
            <option value="+45">+45°</option>
            <option value="-45">−45°</option>
            <option value="RCP">RCP</option>
            <option value="LCP">LCP</option>
            <option value="custom">custom</option>
          </select>
        </label>
        <div style={grid2}>
          <NumberCell
            label="Eₓ_re"
            value={pol.exRe ?? 0}
            step={0.05}
            onCommit={(v) => void persist({ polarization: { ...pol, exRe: v } })}
          />
          <NumberCell
            label="Eₓ_im"
            value={pol.exIm ?? 0}
            step={0.05}
            onCommit={(v) => void persist({ polarization: { ...pol, exIm: v } })}
          />
          <NumberCell
            label="Eᵧ_re"
            value={pol.eyRe ?? 0}
            step={0.05}
            onCommit={(v) => void persist({ polarization: { ...pol, eyRe: v } })}
          />
          <NumberCell
            label="Eᵧ_im"
            value={pol.eyIm ?? 0}
            step={0.05}
            onCommit={(v) => void persist({ polarization: { ...pol, eyIm: v } })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Jones is normalised at solver time; total power stays in Power (mW) above.
        </div>
      </div>

      {/* Spatial mode */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Spatial mode (Gaussian)</div>
        <div style={{ marginBottom: 4, fontSize: 10, opacity: 0.7 }}>X axis</div>
        <div style={grid3}>
          <NumberCell
            label="waist"
            suffix="μm"
            value={sx.waistUm ?? 500}
            step={1}
            onCommit={(v) => v > 0 && setSpatial("X", { waistUm: v })}
          />
          <NumberCell
            label="z offset"
            suffix="mm"
            value={sx.waistZOffsetMm ?? 0}
            onCommit={(v) => setSpatial("X", { waistZOffsetMm: v })}
          />
          <NumberCell
            label="M²"
            value={sx.mSquared ?? 1}
            step={0.05}
            onCommit={(v) => v >= 1 && setSpatial("X", { mSquared: v })}
          />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 10, opacity: 0.7 }}>Y axis</div>
        <div style={grid3}>
          <NumberCell
            label="waist"
            suffix="μm"
            value={sy.waistUm ?? 500}
            step={1}
            onCommit={(v) => v > 0 && setSpatial("Y", { waistUm: v })}
          />
          <NumberCell
            label="z offset"
            suffix="mm"
            value={sy.waistZOffsetMm ?? 0}
            onCommit={(v) => setSpatial("Y", { waistZOffsetMm: v })}
          />
          <NumberCell
            label="M²"
            value={sy.mSquared ?? 1}
            step={0.05}
            onCommit={(v) => v >= 1 && setSpatial("Y", { mSquared: v })}
          />
        </div>
      </div>

      {/* Transverse mode */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Transverse mode</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Family</span>
          <select
            value={tm.kind ?? "TEM00"}
            onChange={(e) => setTransverseKind(e.target.value as TransverseKind)}
          >
            <option value="TEM00">TEM00 (HG 0,0)</option>
            <option value="TEM_mn">TEM_mn (Hermite-Gauss)</option>
            <option value="LG_pl">LG_pl (Laguerre-Gauss)</option>
            <option value="multimode">multimode</option>
          </select>
        </label>
        {(tm.kind === "TEM_mn" || tm.kind === "TEM00") && (
          <>
            <div style={grid2}>
              <NumberCell
                label="m"
                value={tm.indicesM ?? 0}
                step={1}
                onCommit={(v) => {
                  if (!Number.isInteger(v) || v < 0) return;
                  // Any non-zero index promotes Family to TEM_mn so the
                  // chosen (m, n) actually drives the HG mode rather than
                  // being silently ignored under TEM00.
                  const nextN = tm.indicesN ?? 0;
                  const promote = v > 0 || nextN > 0;
                  void persist({
                    transverseMode: {
                      ...tm,
                      kind: promote ? "TEM_mn" : "TEM00",
                      indicesM: v,
                      indicesN: nextN,
                    },
                  });
                }}
              />
              <NumberCell
                label="n"
                value={tm.indicesN ?? 0}
                step={1}
                onCommit={(v) => {
                  if (!Number.isInteger(v) || v < 0) return;
                  const nextM = tm.indicesM ?? 0;
                  const promote = v > 0 || nextM > 0;
                  void persist({
                    transverseMode: {
                      ...tm,
                      kind: promote ? "TEM_mn" : "TEM00",
                      indicesM: nextM,
                      indicesN: v,
                    },
                  });
                }}
              />
            </div>
            {/* HG mode reference card — formula at the waist plane (z=0) plus
                first few Hermite polynomials so the user can sanity-check
                what (m, n) produce. Pure markup, no math library; the
                non-ASCII chars (₀ ₓ ᵧ ξ √ · ² etc.) live in the bundle as
                UTF-8 strings. */}
            <div
              style={{
                marginTop: 6,
                padding: "6px 8px",
                background: "rgba(56, 189, 248, 0.04)",
                borderLeft: "1px dashed rgba(56, 189, 248, 0.4)",
                fontSize: 10.5,
                lineHeight: 1.55,
                opacity: 0.85,
              }}
            >
              <div style={{ fontWeight: 600, color: "#38bdf8", marginBottom: 3 }}>
                Hermite-Gauss reference
              </div>
              <div style={{ marginBottom: 4 }}>
                Field at the waist (<i>z</i> = 0):
              </div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", marginBottom: 4 }}>
                <i>E</i><sub>m,n</sub>(<i>x</i>,<i>y</i>,0) = <i>E</i>₀ · <i>H</i><sub>m</sub>(√2 <i>x</i>/<i>w</i><sub>0x</sub>) · <i>H</i><sub>n</sub>(√2 <i>y</i>/<i>w</i><sub>0y</sub>) · exp(−<i>x</i>²/<i>w</i><sub>0x</sub>² − <i>y</i>²/<i>w</i><sub>0y</sub>²)
              </div>
              <div style={{ marginBottom: 3 }}>First few Hermite polynomials:</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", marginBottom: 3 }}>
                <div><i>H</i>₀(ξ) = 1 &nbsp;<span style={{ opacity: 0.6 }}>(TEM₀₀, pure Gaussian)</span></div>
                <div><i>H</i>₁(ξ) = 2ξ &nbsp;<span style={{ opacity: 0.6 }}>(2 lobes)</span></div>
                <div><i>H</i>₂(ξ) = 4ξ² − 2 &nbsp;<span style={{ opacity: 0.6 }}>(3 lobes)</span></div>
                <div><i>H</i><sub>n+1</sub>(ξ) = 2ξ <i>H</i><sub>n</sub>(ξ) − 2<i>n</i> <i>H</i><sub>n−1</sub>(ξ)</div>
              </div>
              <div style={{ opacity: 0.7 }}>
                <i>w</i><sub>0x</sub>, <i>w</i><sub>0y</sub> are the X / Y waist
                values from the Spatial mode section above.
              </div>
            </div>
          </>
        )}
        {tm.kind === "LG_pl" && (
          <>
            <div style={grid2}>
              <NumberCell
                label="p (radial)"
                value={tm.indicesP ?? 0}
                step={1}
                onCommit={(v) =>
                  Number.isInteger(v) && v >= 0 &&
                  void persist({ transverseMode: { ...tm, indicesP: v } })
                }
              />
              <NumberCell
                label="ℓ (azimuthal)"
                value={tm.indicesL ?? 0}
                step={1}
                onCommit={(v) =>
                  Number.isInteger(v) &&
                  void persist({ transverseMode: { ...tm, indicesL: v } })
                }
              />
            </div>
            {/* LG mode reference card — formula at the waist plane (z=0)
                in cylindrical coords plus first few associated Laguerre
                polynomials. Pure markup, no math library. */}
            <div
              style={{
                marginTop: 6,
                padding: "6px 8px",
                background: "rgba(56, 189, 248, 0.04)",
                borderLeft: "1px dashed rgba(56, 189, 248, 0.4)",
                fontSize: 10.5,
                lineHeight: 1.55,
                opacity: 0.85,
              }}
            >
              <div style={{ fontWeight: 600, color: "#38bdf8", marginBottom: 3 }}>
                Laguerre-Gauss reference
              </div>
              <div style={{ marginBottom: 4 }}>
                Field at the waist (<i>z</i> = 0) in cylindrical (<i>r</i>, φ):
              </div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", marginBottom: 4, lineHeight: 1.45 }}>
                <i>E</i><sub>p,ℓ</sub>(<i>r</i>,φ,0) = <i>E</i>₀ · √(2 <i>p</i>! / [π (<i>p</i>+|ℓ|)!]) · (1/<i>w</i>₀) · (√2 <i>r</i>/<i>w</i>₀)<sup>|ℓ|</sup> · <i>L</i><sub><i>p</i></sub><sup>|ℓ|</sup>(2<i>r</i>²/<i>w</i>₀²) · exp(−<i>r</i>²/<i>w</i>₀²) · <i>e</i><sup>iℓφ</sup>
              </div>
              <div style={{ marginBottom: 3 }}>Indices:</div>
              <div style={{ marginLeft: 8, marginBottom: 3 }}>
                <div>· <strong>p</strong> (radial, ≥ 0): number of bright rings = p + 1</div>
                <div>· <strong>ℓ</strong> (azimuthal, topological charge): vortex size + helical phase rate. ℓ ≠ 0 ⇒ dark on-axis singularity</div>
              </div>
              <div style={{ marginBottom: 3 }}>First few associated Laguerre polynomials:</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", marginBottom: 3 }}>
                <div><i>L</i><sub>0</sub><sup>α</sup>(<i>x</i>) = 1 &nbsp;<span style={{ opacity: 0.6 }}>(LG p=0: single ring/spot)</span></div>
                <div><i>L</i><sub>1</sub><sup>α</sup>(<i>x</i>) = 1 + α − <i>x</i></div>
                <div><i>L</i><sub>2</sub><sup>α</sup>(<i>x</i>) = ½(<i>x</i>² − 2(α+2)<i>x</i> + (α+1)(α+2))</div>
                <div>(<i>p</i>+1)<i>L</i><sub><i>p</i>+1</sub><sup>α</sup>(<i>x</i>) = (2<i>p</i>+1+α−<i>x</i>)<i>L</i><sub><i>p</i></sub><sup>α</sup>(<i>x</i>) − (<i>p</i>+α)<i>L</i><sub><i>p</i>−1</sub><sup>α</sup>(<i>x</i>)</div>
              </div>
              <div style={{ opacity: 0.7 }}>
                <i>w</i>₀ uses the avg of <i>w</i><sub>0x</sub>, <i>w</i><sub>0y</sub>;
                LG modes are circularly symmetric. <i>e</i><sup>iℓφ</sup> is
                a phase factor — only visible in the Wavefront phase plot,
                not the intensity.
              </div>
            </div>
          </>
        )}
      </div>

      {/* Visualization (scene-only — physics unaffected) */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Visualization</div>
        <EmissionVisualRow
          sceneObject={sceneObject}
          emissionKey="main"
          label="Beam color"
          fallbackColorHex={wavelengthHex(wavelengthNm)}
          showVisibilityToggle={false}
        />
      </div>

      <p className="snap-to-beam-empty" style={{ marginTop: 8, fontSize: 10, opacity: 0.65 }}>
        V2: this form edits <code>objects.properties.opticalSources[].beam</code> via the
        backend translator; <code>kindParams</code> in DB stays empty for laser_source.
      </p>
    </div>
  );
}
