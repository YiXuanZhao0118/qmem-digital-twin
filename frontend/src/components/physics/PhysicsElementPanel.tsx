import { Sparkles } from "lucide-react";
import * as THREE from "three";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";

import { useSceneStore } from "../../store/sceneStore";
import type { ComponentItem, ElementKind, PhysicsElement, SceneObject } from "../../types/digitalTwin";
import {
  DOMAIN_TITLES,
  KIND_LABELS,
  componentTypeToElementKind,
  domainForElementKind,
} from "../../utils/elementDefaults";
import {
  findSnapToBeam,
  perpendicularBasis,
} from "../../utils/beamPlacement";
import {
  DEFAULT_STAGE1_MODE,
  DEFAULT_STAGE2_SIGN,
  aomBodyFrameBodyLocal,
  aomTraversalSignFromEntryPort,
  braggAngleRad,
  diffractionEfficiency,
  effectiveAomOrderForTraversal,
  expectedInputDotD2,
  phaseModulationDepth,
  resolveTraversalSign,
  sidebandIntensitiesOnBragg,
  type Stage1RotationMode,
  type Stage2SignConvention,
} from "../../optical/kinds/aom/physics";
import {
  bodyLocalDirToThree,
  labDirToThree,
  rotateLabDir,
  threeToLabPointMm,
} from "../../optical/frames";
import {
  getEffectiveApertureMm,
  getPerObjectAperture,
  getRfDirectionBodyLocal,
  setPerObjectAperture,
  type V2Aperture,
} from "../../utils/v2Bindings";
import { resolveAomRfDriveFromScene } from "../../utils/aomRfDrive";
import {
  type EmissionKey,
  getEmissionVisual,
  setEmissionVisualPatch,
} from "../../utils/emissionVisuals";
import { wavelengthToColor } from "../../three/opticalBeams";

function wavelengthHex(wavelengthNm: number): string {
  return `#${wavelengthToColor(wavelengthNm).getHexString()}`;
}

/** Per-emission visualisation row: native colour picker + reset button +
 *  optional show/hide toggle. Used by both LaserSourceControls (1 row,
 *  no toggle) and TaperedAmplifierAdjustControls (forward + backward;
 *  backward includes the toggle so the user can hide the input-side ASE).
 *  Persists via updateSceneObject so the value lives on the SceneObject's
 *  per-instance properties.emissionVisuals[key]. */
function EmissionVisualRow({
  sceneObject,
  emissionKey,
  label,
  fallbackColorHex,
  showVisibilityToggle,
}: {
  sceneObject: SceneObject;
  emissionKey: EmissionKey;
  label: string;
  fallbackColorHex: string;
  showVisibilityToggle: boolean;
}) {
  const updateSceneObject = useSceneStore((s) => s.updateSceneObject);
  const visual = getEmissionVisual(sceneObject, emissionKey);
  const hasOverride = visual.colorHex !== null;
  const displayHex = visual.colorHex ?? fallbackColorHex;

  const persist = (patch: Partial<{ colorHex: string | null; visible: boolean }>) => {
    void updateSceneObject(sceneObject.id, {
      properties: setEmissionVisualPatch(sceneObject, emissionKey, patch),
    });
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 11, minWidth: 70 }}>{label}</span>
      <input
        type="color"
        value={displayHex}
        onChange={(e) => persist({ colorHex: e.target.value })}
        style={{ width: 32, height: 22, padding: 0, border: "1px solid rgba(255,255,255,0.2)", borderRadius: 3, cursor: "pointer" }}
        title="Beam colour for this emission"
      />
      <span style={{ fontSize: 10, opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>{displayHex}</span>
      {hasOverride ? (
        <button
          type="button"
          onClick={() => persist({ colorHex: null })}
          style={{ fontSize: 10, padding: "1px 6px" }}
          title="Reset to wavelength-derived colour"
        >Reset</button>
      ) : (
        <span style={{ fontSize: 10, opacity: 0.5 }}>(λ default)</span>
      )}
      {showVisibilityToggle && (
        <label style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: "auto", fontSize: 10 }}>
          <input
            type="checkbox"
            checked={visual.visible}
            onChange={(e) => persist({ visible: e.target.checked })}
          />
          <span>Show</span>
        </label>
      )}
    </div>
  );
}

type Props = {
  component: ComponentItem;
  /** The specific scene-object instance whose optical params are being
   *  edited. Per-object optical chain (alembic 0014). When omitted, the
   *  panel renders an empty-state hint asking to select an object. */
  sceneObject?: SceneObject;
};

function findElementForObject(elements: PhysicsElement[], objectId: string): PhysicsElement | undefined {
  return elements.find((item) => item.objectId === objectId);
}

export function PhysicsElementPanel({ component, sceneObject }: Props) {
  const physicsElements = useSceneStore((state) => state.scene.physicsElements);
  const autoRegisterOptical = useSceneStore((state) => state.autoRegisterOptical);

  const existing = sceneObject
    ? findElementForObject(physicsElements, sceneObject.id)
    : undefined;
  const mappedKind = componentTypeToElementKind(component.componentType);

  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const onAutoRegister = async () => {
    if (!mappedKind || existing) return;
    setError("");
    setBusy(true);
    try {
      const created = await autoRegisterOptical(component.id);
      if (!created) {
        setError("This component type has no optical mapping.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Use the existing element's kind when registered; fall back to the
  // mapped kind for the not-yet-registered preview. Defaults to optical.
  const activeKind = (existing?.elementKind as ElementKind | undefined) ?? mappedKind ?? null;
  const domain = domainForElementKind(activeKind);
  const panelTitle = DOMAIN_TITLES[domain];

  return (
    <section className={`physics-panel physics-panel-${domain}`}>
      <header className="physics-panel-header">
        <h3>{panelTitle}</h3>
      </header>

      {!existing && mappedKind && (
        <div className="physics-auto-register">
          <div className="physics-auto-register-text">
            <strong>Not yet registered.</strong>
            <span>
              Component type <code>{component.componentType}</code> maps to{" "}
              <code>{KIND_LABELS[mappedKind]}</code>. One click to add the
              solver-visible row with sensible defaults — you can fine-tune the
              params below afterwards.
            </span>
          </div>
          <button
            type="button"
            className="primary-button physics-auto-register-btn"
            onClick={onAutoRegister}
            disabled={busy}
          >
            <Sparkles size={14} />
            Auto-register as {KIND_LABELS[mappedKind]}
          </button>
        </div>
      )}

      {error ? <div className="physics-error">{error}</div> : null}

      {existing && sceneObject && (
        <AdjustErrorBoundary key={sceneObject.id}>
          <AlignToBeamSection sceneObject={sceneObject} elementKind={existing.elementKind as ElementKind} element={existing} />
        </AdjustErrorBoundary>
      )}
    </section>
  );
}

/** Catches transient render errors from kind-specific adjust panels —
 *  most commonly fires during HMR module swaps when a stale reference
 *  briefly throws before the next frame recovers. Resets when the
 *  selected object id changes (key prop) so re-selecting always gives a
 *  clean retry. */
class AdjustErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("Adjust panel transient error:", error.message);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          Adjust panel hit a transient error ({this.state.error.message}).
          Re-select the object to retry.
        </div>
      );
    }
    return this.props.children;
  }
}

/** Align section — replaces the old Ports table + Links list + Snap-to-beam
 *  button with a single per-kind alignment UI:
 *
 *  - mirror / dichroic_mirror  →  align face center to beam, then user
 *                                  can dial in beam offset (x,y) on the
 *                                  face + mirror angle (rx,ry,rz) so the
 *                                  reflection points exactly where wanted.
 *  - other optical kinds       →  one-click alignment of intercept_in
 *                                  (and intercept_out for TA / line-shape)
 *                                  to the nearest beam center.
 *  - emitters (laser/TA)       →  not aligned (they originate the beam).
 */
function AlignToBeamSection({
  sceneObject,
  elementKind,
  element,
}: {
  sceneObject: SceneObject;
  elementKind: ElementKind;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );

  const fromName = candidate
    ? scene.objects.find((o) => o.id === candidate.fromObjectId)?.name ?? candidate.fromObjectId.slice(0, 6)
    : null;

  const isMirror = elementKind === "mirror" || elementKind === "dichroic_mirror";
  const isEmitter = elementKind === "laser_source" || elementKind === "tapered_amplifier";
  const isWaveplate = elementKind === "waveplate";
  const isBeamSplitter = elementKind === "beam_splitter";
  const isLens = elementKind === "lens_biconvex"
    || elementKind === "lens_plano_convex"
    || elementKind === "lens_cylindrical";

  const onAlign = async () => {
    if (!candidate) return;
    setBusy(true);
    setFeedback(null);
    try {
      await updateSceneObject(sceneObject.id, {
        xMm: candidate.newBodyPos.x,
        yMm: candidate.newBodyPos.y,
        zMm: candidate.newBodyPos.z,
      });
      setFeedback(
        `${candidate.anchorId} aligned to ${fromName} axis (was ${candidate.missMm.toFixed(1)} mm off, now 0).`,
      );
    } catch (err) {
      setFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (elementKind === "tapered_amplifier") {
    return <TaperedAmplifierAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "aom") {
    return <AomAdjustControls sceneObject={sceneObject} element={element} />;
  }
  if (elementKind === "laser_source") {
    return <LaserSourceControls sceneObject={sceneObject} element={element} />;
  }
  if (isEmitter) {
    return (
      <div className="snap-to-beam snap-to-beam-empty">
        Emitters originate the beam — alignment is for downstream optics.
      </div>
    );
  }
  // RF kinds don't propagate as optical beams, so "Align intercept to beam"
  // (which projects onto optical beam_paths / __rayTraceDebug) is meaningless
  // for rf_source / horn_antenna / rf_cable. Skip the snap-to-beam block
  // entirely for the RF domain — rf_cable has its own "Align RF" buttons
  // in ComponentPanel that snap to rf_in/rf_out anchors instead.
  if (
    elementKind === "rf_source"
    || elementKind === "horn_antenna"
    || elementKind === "rf_cable"
  ) {
    return null;
  }

  return (
    <div className="snap-to-beam">
      {candidate ? (
        <>
          <div className="snap-to-beam-info">
            <strong>Nearest beam:</strong>{" "}
            {fromName} ({candidate.fromPort}) —{" "}
            <code>{candidate.anchorId}</code> would shift{" "}
            <strong>{candidate.missMm.toFixed(2)} mm</strong> to land on axis.
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => void onAlign()}
            disabled={busy}
          >
            {isMirror ? "Align face center to beam" : "Align intercept to beam"}
          </button>
          {/* Mirror-specific: after aligning, expose offset (on face) +
              rotation (controls reflection direction). */}
          {isMirror && <MirrorAdjustControls sceneObject={sceneObject} />}
          {/* Waveplate-specific: rotate the plate clockwise around the beam
              axis to set the fast-axis angle (Jones-matrix theta). */}
          {isWaveplate && (
            <WaveplateAdjustControls sceneObject={sceneObject} element={element} />
          )}
          {/* Beam-splitter / PBS-specific: split ratio, polarising flag,
              extinction ratio, and overall transmission. */}
          {isBeamSplitter && (
            <BeamSplitterControls sceneObject={sceneObject} element={element} />
          )}
          {/* Lens-specific (biconvex / plano-convex / cylindrical):
              focal length, NA or cylindrical axis, transmission,
              material, GVD. */}
          {isLens && (
            <LensControls sceneObject={sceneObject} element={element} />
          )}
          {/* V2: per-object aperture override (asset apertureMm becomes a
              default seed; the editable value lives on the SceneObject). */}
          <PerObjectApertureEditor sceneObject={sceneObject} />
        </>
      ) : (
        <div className="snap-to-beam-empty">
          No beam axis within 25 mm of any intercept anchor.
        </div>
      )}
      {feedback && <div className="snap-to-beam-feedback">{feedback}</div>}
    </div>
  );
}

/** Per-object aperture editor — V2.
 *
 *  Aperture used to live on Asset3D.anchors[].apertureMm and was edited in
 *  the PHY Editor (Layer 2). Per V2 (docs/optical-schema-v2.md §3),
 *  aperture is per-physical-instance: the asset value is just a default
 *  seed, and the user overrides it on the SceneObject. We write to
 *  objects.properties.perAnchorApertures[anchorId] (a transitional
 *  flat map covering anchors that have no V2 binding yet — AOM
 *  intercept_in/out, lens intercept_in, etc.). For kinds whose existing
 *  binding already carries geometry (mirror's opticalSurface), future
 *  cleanup will fold the aperture into that binding's payload — the
 *  reader helper getEffectiveApertureMm hides the distinction.
 */
function PerObjectApertureEditor({ sceneObject }: { sceneObject: SceneObject }) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);

  const component = scene.components.find((c) => c.id === sceneObject.componentId);
  const asset = component?.asset3dId
    ? scene.assets.find((a) => a.id === component.asset3dId)
    : undefined;
  // Surface every anchor whose asset seed carries an apertureMm — those
  // are the ones the consumer code reads (beam intercept tests, AOM align,
  // apertureCheck). Anchors with no apertureMm seed are out of scope here;
  // a future kind contract may extend the list.
  const anchors = (asset?.anchors ?? []).filter(
    (a) =>
      a.apertureMm != null ||
      // Always show the aperture editor for AOM intercept ports even if
      // the seed is missing — that is the canonical kind that needs an
      // explicit per-instance value.
      a.id === "intercept_in" ||
      a.id === "intercept_out",
  );
  if (!anchors.length) return null;

  const onChange = async (anchorId: string, rMm: number | null) => {
    const next: V2Aperture | null = rMm != null && rMm > 0 ? { shape: "circle", rMm } : null;
    const newProps = setPerObjectAperture(sceneObject.properties, anchorId, next);
    await updateSceneObject(sceneObject.id, { properties: newProps });
  };

  return (
    <div
      className="snap-to-beam-aperture"
      style={{
        marginTop: 8,
        padding: "6px 8px",
        borderLeft: "2px solid #facc15",
        background: "rgba(250, 204, 21, 0.08)",
        fontSize: 11,
      }}
    >
      <div style={{ color: "#facc15", fontWeight: 600, marginBottom: 4 }}>
        Aperture (per-object)
      </div>
      <div style={{ opacity: 0.7, marginBottom: 6 }}>
        Asset value is a default seed; per-object override lives on this
        SceneObject. Set 0 / blank to reuse the asset default.
      </div>
      {anchors.map((a) => {
        const eff = getEffectiveApertureMm(sceneObject, a, a.id);
        const override = getPerObjectAperture(sceneObject, a.id);
        const overrideRadius = override && override.shape === "circle" ? override.rMm : null;
        return (
          <label
            key={a.id}
            className="component-editor-coord"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 80px",
              gap: 6,
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <span>
              <code style={{ fontSize: 10 }}>{a.id}</code>
              {overrideRadius == null && (
                <span style={{ marginLeft: 6, opacity: 0.55, fontSize: 10 }}>
                  (asset default {a.apertureMm?.toFixed(2) ?? "—"} mm)
                </span>
              )}
            </span>
            <input
              type="number"
              step={0.1}
              min={0}
              placeholder={a.apertureMm?.toFixed(2) ?? ""}
              value={overrideRadius != null ? overrideRadius.toString() : ""}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw.trim() === "") {
                  void onChange(a.id, null);
                  return;
                }
                const v = Number(raw);
                if (!Number.isFinite(v)) return;
                void onChange(a.id, v);
              }}
              title={
                eff != null
                  ? `Effective aperture: ${eff.toFixed(2)} mm`
                  : "No aperture set; consumers fall back to a kind default."
              }
            />
          </label>
        );
      })}
    </div>
  );
}

/** Mirror-only secondary controls: live position offset of the BEAM on the
 *  reflection face (translates mirror along axis-perpendicular u/v) and
 *  mirror rotation (rx/ry/rz — controls where the reflected beam goes). */
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
function LaserSourceControls({
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

function MirrorAdjustControls({ sceneObject }: { sceneObject: SceneObject }) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  // Cache the perpendicular basis from the nearest beam axis at render time.
  // Each input change translates the mirror by u*Δ or v*Δ.
  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );
  const axisDir = candidate?.axisDirection ?? null;

  const onTransverse = (basis: "u" | "v", deltaMm: number) => {
    if (!axisDir || !Number.isFinite(deltaMm)) return;
    const { u, v } = perpendicularBasis(axisDir);
    const dir = basis === "u" ? u : v;
    void updateSceneObject(sceneObject.id, {
      xMm: sceneObject.xMm + dir.x * deltaMm,
      yMm: sceneObject.yMm + dir.y * deltaMm,
      zMm: sceneObject.zMm + dir.z * deltaMm,
    });
  };

  const onRotate = (axis: "rxDeg" | "ryDeg" | "rzDeg", value: number) => {
    if (!Number.isFinite(value)) return;
    void updateSceneObject(sceneObject.id, { [axis]: value });
  };

  return (
    <div className="mirror-adjust">
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field">
          <span>Beam Δ on face — U (mm)</span>
          <input
            type="number"
            step={0.1}
            defaultValue="0"
            onBlur={(e) => onTransverse("u", Number(e.target.value))}
          />
        </label>
        <label className="mirror-adjust-field">
          <span>V (mm)</span>
          <input
            type="number"
            step={0.1}
            defaultValue="0"
            onBlur={(e) => onTransverse("v", Number(e.target.value))}
          />
        </label>
      </div>
      <div className="mirror-adjust-row">
        {(["rxDeg", "ryDeg", "rzDeg"] as const).map((key) => (
          <label key={key} className="mirror-adjust-field">
            <span>{key.replace("Deg", "").toUpperCase()} (°)</span>
            <input
              type="number"
              step={0.5}
              value={sceneObject[key]}
              onChange={(e) => onRotate(key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>
      <p className="mirror-adjust-hint">
        Δ inputs apply on blur (translate mirror perpendicular to beam — beam
        lands off-center on the face). Rotation updates live.
      </p>
    </div>
  );
}

/** Waveplate-specific control: a single "Fast axis angle" input that rotates
 *  the waveplate clockwise around the beam axis. Two effects every change:
 *    1. The SceneObject's Euler is composed with a rotation_around_beam_axis
 *       quaternion by Δ degrees, so the mesh visually spins around the beam.
 *       Snap-to-beam first (so local +X aligns with the beam) — otherwise the
 *       rotation tilts the body out of axis.
 *    2. `kindParams.fastAxisDeg` is set to the absolute angle, so the Jones
 *       matrix downstream sees the new fast-axis orientation. A λ/2 plate at
 *       angle θ rotates linear polarisation by 2θ.
 *  Convention: positive angle = clockwise when looking ALONG the beam (i.e.
 *  rotation about the +beam axis with right-hand rule = +Δ). */
function WaveplateAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const scene = useSceneStore((state) => state.scene);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  const candidate = useMemo(
    () => findSnapToBeam(sceneObject.id, scene),
    [scene, sceneObject.id],
  );

  type WaveplateKindParams = {
    fastAxisDegBeamLocal?: number;
    fastAxisDeg?: number;  // V2 Phase 5 legacy alias kept for read fallback
    retardanceLambda?: number;
    transmission?: number;
    groupDelayPs?: number;
    gvdFs2?: number;
  };

  const params = (element.kindParams ?? {}) as WaveplateKindParams;

  // ---- field readers (with V2 default fallbacks) --------------------------
  const fastAxisDeg = typeof params.fastAxisDegBeamLocal === "number"
    ? params.fastAxisDegBeamLocal
    : typeof params.fastAxisDeg === "number" ? params.fastAxisDeg : 0;
  const retardance = params.retardanceLambda ?? 0.5;
  const transmission = params.transmission ?? 0.99;
  const groupDelayPs = params.groupDelayPs ?? 0;
  const gvdFs2 = params.gvdFs2 ?? 0;

  const platePreset: "HWP" | "QWP" | "custom" =
    Math.abs(retardance - 0.5) < 1e-6 ? "HWP"
    : Math.abs(retardance - 0.25) < 1e-6 ? "QWP"
    : "custom";

  // ---- writer: shallow-merge a patch into kindParams + persist ------------
  // Drops the legacy `fastAxisDeg` alias on every save so the row converges
  // to the canonical V2 shape.
  const persist = async (patch: Partial<WaveplateKindParams>) => {
    const { fastAxisDeg: _legacy, ...rest } = params;
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...rest, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Fast-axis rotation commit — keep the quaternion-around-beam math from
  // the original control; it composes Δθ around `candidate.axisDirection`
  // into the SceneObject Euler so the 3D mesh tracks the user's typed
  // angle. If the object isn't snap-aligned, kindParams still update so
  // the Jones simulation sees the new angle.
  const commitFastAxis = async (next: number) => {
    if (!Number.isFinite(next)) return;
    const delta = next - fastAxisDeg;
    if (Math.abs(delta) < 1e-6) return;

    const updates: Partial<SceneObject> = {};
    if (candidate?.axisDirection) {
      const dir = candidate.axisDirection;
      const beamAxisThree = labDirToThree(dir).normalize();
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(
        beamAxisThree,
        THREE.MathUtils.degToRad(delta),
      );
      const currentEuler = new THREE.Euler(
        THREE.MathUtils.degToRad(sceneObject.rxDeg),
        THREE.MathUtils.degToRad(sceneObject.rzDeg),
        THREE.MathUtils.degToRad(-sceneObject.ryDeg),
        "YXZ",
      );
      const currentQuat = new THREE.Quaternion().setFromEuler(currentEuler);
      const newQuat = deltaQuat.multiply(currentQuat);
      const newEuler = new THREE.Euler().setFromQuaternion(newQuat, "YXZ");
      updates.rxDeg = THREE.MathUtils.radToDeg(newEuler.x);
      updates.rzDeg = THREE.MathUtils.radToDeg(newEuler.y);
      updates.ryDeg = -THREE.MathUtils.radToDeg(newEuler.z);
    }
    await Promise.all([
      Object.keys(updates).length > 0
        ? updateSceneObject(sceneObject.id, updates)
        : Promise.resolve(),
      persist({ fastAxisDegBeamLocal: next }),
    ]);
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

  // ---- handlers -----------------------------------------------------------
  const setPlatePreset = (next: "HWP" | "QWP" | "custom") => {
    if (next === "HWP") void persist({ retardanceLambda: 0.5 });
    else if (next === "QWP") void persist({ retardanceLambda: 0.25 });
    // "custom" leaves the existing retardance value unchanged so the user
    // can type a new one in the input below.
  };

  // ---- shared section style (mirrors LaserSourceControls) -----------------
  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  return (
    <div className="snap-to-beam">
      {/* Plate type */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Plate type</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Preset</span>
          <select
            value={platePreset}
            onChange={(e) => setPlatePreset(e.target.value as "HWP" | "QWP" | "custom")}
          >
            <option value="HWP">HWP — λ/2 (linear rotates by 2×θ)</option>
            <option value="QWP">QWP — λ/4 (linear ↔ circular at ±45°)</option>
            <option value="custom">custom retardance</option>
          </select>
        </label>
        {platePreset === "custom" && (
          <NumberCell
            label="Retardance"
            suffix="λ"
            value={retardance}
            step={0.01}
            onCommit={(v) => v > 0 && void persist({ retardanceLambda: v })}
          />
        )}
      </div>

      {/* Fast axis orientation around beam */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Fast axis</div>
        <NumberCell
          label="Angle around beam"
          suffix="° CW"
          value={fastAxisDeg}
          step={1}
          onCommit={(v) => void commitFastAxis(v)}
        />
        {!candidate ? (
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 10 }}>
            ⚠ Snap-align to beam first so the rotation stays around the optical axis.
          </div>
        ) : (
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            Rotation composes around the local beam axis; the 3D mesh follows.
          </div>
        )}
      </div>

      {/* Throughput */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
      </div>

      {/* Dispersion (advanced) */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Dispersion</div>
        <div style={grid2}>
          <NumberCell
            label="Group delay"
            suffix="ps"
            value={groupDelayPs}
            step={0.01}
            onCommit={(v) => void persist({ groupDelayPs: v })}
          />
          <NumberCell
            label="GVD"
            suffix="fs²"
            value={gvdFs2}
            step={1}
            onCommit={(v) => void persist({ gvdFs2: v })}
          />
        </div>
      </div>
    </div>
  );
}

/** Beam-splitter / PBS controls. Mirrors the LaserSourceControls and
 *  WaveplateAdjustControls layout: section blocks with field-level commits
 *  to kindParams via upsertOpticalElement. Geometry (coating normal, PBS
 *  transmission axis) lives on V2 anchor bindings — these controls only
 *  cover the transfer-physics knobs (split ratio, polarising flag,
 *  extinction ratio, overall transmission). */
function BeamSplitterControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type BeamSplitterKindParams = {
    splitRatioTransmitted?: number;
    polarizing?: boolean;
    extinctionRatioDb?: number;
    transmission?: number;
  };

  const params = (element.kindParams ?? {}) as BeamSplitterKindParams;

  const splitT = params.splitRatioTransmitted ?? 0.5;
  const polarizing = params.polarizing ?? false;
  const extinctionDb = params.extinctionRatioDb ?? 30.0;
  const transmission = params.transmission ?? 0.99;

  const persist = async (patch: Partial<BeamSplitterKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Numeric input that commits on blur / Enter.
  const NumberCell = ({
    label,
    value,
    step = 0.01,
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

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  const reflected = Math.max(0, Math.min(1, 1 - splitT));

  return (
    <div className="snap-to-beam">
      {/* Splitter type */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Splitter type</div>
        <label className="component-editor-coord" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11 }}>Mode</span>
          <select
            value={polarizing ? "PBS" : "BS"}
            onChange={(e) => void persist({ polarizing: e.target.value === "PBS" })}
          >
            <option value="BS">Non-polarising (BS) — split by amplitude</option>
            <option value="PBS">Polarising (PBS) — split by polarisation</option>
          </select>
        </label>
        <div style={{ opacity: 0.6, fontSize: 10 }}>
          {polarizing
            ? "Transmits p, reflects s (per V2 polarizationReference binding)."
            : "Splits both polarisations by the ratio below."}
        </div>
      </div>

      {/* Split ratio — non-polarising only. For PBS the split is dictated
          by the input polarisation (p transmits, s reflects), so the
          amplitude-ratio knob is hidden. */}
      {!polarizing && (
        <div style={sectionStyle}>
          <div style={titleStyle}>Split ratio</div>
          <div style={grid2}>
            <NumberCell
              label="Transmitted"
              value={splitT}
              step={0.01}
              onCommit={(v) => v >= 0 && v <= 1 && void persist({ splitRatioTransmitted: v })}
            />
            <label className="component-editor-coord">
              <span style={{ fontSize: 11 }}>Reflected (derived)</span>
              <input type="number" value={reflected.toFixed(3)} disabled readOnly />
            </label>
          </div>
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            0 = full reflect · 0.5 = 50/50 · 1 = full transmit. Reflected is auto = 1 − T.
          </div>
        </div>
      )}

      {/* Polarising-only: extinction ratio */}
      {polarizing && (
        <div style={sectionStyle}>
          <div style={titleStyle}>Polarising extinction</div>
          <NumberCell
            label="Extinction ratio"
            suffix="dB"
            value={extinctionDb}
            step={1}
            onCommit={(v) => v >= 0 && void persist({ extinctionRatioDb: v })}
          />
          <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
            Power leakage of the rejected polarisation: 10^(−ER/10). 30 dB = 0.001.
          </div>
        </div>
      )}

      {/* Throughput */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Overall efficiency multiplier on top of the split ratio (coating losses, AR, etc.).
        </div>
      </div>
    </div>
  );
}

/** Lens controls — handles all 3 lens kinds (biconvex / plano-convex /
 *  cylindrical). Spherical lenses share `LensSphericalParams` (focal_mm,
 *  numerical_aperture, transmission, material, gvd_fs2); cylindrical
 *  lenses use `LensCylindricalParams` which swaps `numerical_aperture`
 *  for `cylindrical_axis` ("x" or "y"). The two are merged into one UI
 *  here, with the kind-specific field rendered conditionally. The
 *  per-object aperture (`clear_aperture_mm`) lives on the SceneObject
 *  (PerObjectApertureEditor) per V2 §3, so it is intentionally not
 *  surfaced here. */
function LensControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);

  type LensKindParams = {
    focalMm?: number;
    numericalAperture?: number | null;
    cylindricalAxis?: "x" | "y";
    transmission?: number;
    gvdFs2?: number;
    material?: string | null;
  };

  const params = (element.kindParams ?? {}) as LensKindParams;
  const isCylindrical = element.elementKind === "lens_cylindrical";
  const isPlanoConvex = element.elementKind === "lens_plano_convex";

  const focalMm = params.focalMm ?? 100;
  const na = typeof params.numericalAperture === "number" ? params.numericalAperture : 0.1;
  const cylAxis: "x" | "y" = params.cylindricalAxis === "y" ? "y" : "x";
  const transmission = params.transmission ?? 0.99;
  const gvdFs2 = params.gvdFs2 ?? 0;
  const material = params.material ?? "";

  const persist = async (patch: Partial<LensKindParams>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  // Numeric input that commits on blur / Enter.
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

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };

  // Quick reference: f-number when both NA and focal length are known.
  const fNumber = na > 0 ? 1 / (2 * na) : null;

  return (
    <div className="snap-to-beam">
      {/* Optics */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Optics</div>
        <div style={grid2}>
          <NumberCell
            label="Focal length"
            suffix="mm"
            value={focalMm}
            step={1}
            onCommit={(v) => Math.abs(v) > 0 && void persist({ focalMm: v })}
          />
          {isCylindrical ? (
            <label className="component-editor-coord">
              <span style={{ fontSize: 11 }}>Cylindrical axis</span>
              <select
                value={cylAxis}
                onChange={(e) => void persist({ cylindricalAxis: e.target.value as "x" | "y" })}
              >
                <option value="x">x — focuses Y, leaves X collimated</option>
                <option value="y">y — focuses X, leaves Y collimated</option>
              </select>
            </label>
          ) : (
            <NumberCell
              label="Numerical aperture"
              value={na}
              step={0.01}
              onCommit={(v) => v >= 0 && void persist({ numericalAperture: v })}
            />
          )}
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          {isCylindrical
            ? "Cylindrical: power along one axis only — used for beam shaping or compensating astigmatism."
            : isPlanoConvex
              ? "Plano-convex: one flat, one curved surface. Aperture lives on the SceneObject."
              : "Biconvex: both surfaces curved."}
          {!isCylindrical && fNumber !== null
            ? ` · f/# ≈ ${fNumber.toFixed(2)}`
            : ""}
        </div>
      </div>

      {/* Throughput / material */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Throughput</div>
        <NumberCell
          label="Transmission"
          value={transmission}
          step={0.01}
          onCommit={(v) => v >= 0 && v <= 1 && void persist({ transmission: v })}
        />
        <label className="component-editor-coord" style={{ marginTop: 6 }}>
          <span style={{ fontSize: 11 }}>Material</span>
          <select
            value={material}
            onChange={(e) => void persist({ material: e.target.value || null })}
          >
            <option value="">(unspecified)</option>
            <option value="BK7">N-BK7 — visible / NIR</option>
            <option value="fused_silica">Fused silica — UV / NIR / low GVD</option>
            <option value="CaF2">CaF₂ — UV–MIR</option>
            <option value="ZnSe">ZnSe — MIR / CO₂ optics</option>
            <option value="sapphire">Sapphire — UV–MIR, hard</option>
            <option value="custom">custom (set via JSON)</option>
          </select>
        </label>
      </div>

      {/* Dispersion */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Dispersion</div>
        <NumberCell
          label="GVD"
          suffix="fs²"
          value={gvdFs2}
          step={1}
          onCommit={(v) => void persist({ gvdFs2: v })}
        />
      </div>
    </div>
  );
}

/** AOM-specific controls. Two user requests:
 *
 *   (1) "Align laser to AOM aperture" — analogous to the TA align: scan
 *       the live ray-trace for a beam whose closest-approach hits the
 *       AOM body, pick the AOM face (left or right) that is on the
 *       INCOMING side of that ray, then translate the AOM so the chosen
 *       face centre sits exactly on the ray's infinite line. Rotation
 *       is preserved — the user is responsible for first orienting the
 *       AOM along the desired beam axis.
 *
 *   (2) "Choose which diffraction order is the primary output" — radio
 *       picker (−1 / 0 / +1). Persists to kindParams.diffractionOrder
 *       which both the ray-tracer (rayTrace.ts AOM branch) and the
 *       backend solver consume. Order 0 = RF off (transmitted only);
 *       ±1 = the deflected branch is rotated by ±2·θ_B. Live readouts
 *       below the picker show the current Bragg angle and η so the
 *       user can sanity-check the choice. */
function AomAdjustControls({
  sceneObject,
  element,
}: {
  sceneObject: SceneObject;
  element: PhysicsElement;
}) {
  const upsertOpticalElement = useSceneStore((state) => state.upsertOpticalElement);
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);

  const params = (element.kindParams ?? {}) as {
    // Phase B: centerFreqMhz / rfDrivePowerW were removed from AOMParams.
    // The panel resolves them live from the upstream rf_source via
    // `resolveAomRfDriveFromScene` and overlays them onto `physicsParams`
    // (constructed below) for the physics formulas.
    acousticVelocityMPerS?: number;
    refractiveIndex?: number;
    baseEfficiency?: number;
    figureOfMeritM2?: number;
    crystalLengthMm?: number;
    acousticBeamWidthMm?: number;
    rfPowerMaxW?: number;
    diffractionOrder?: number;
    // Phase 5: new frame-suffixed names; legacy names kept for read
    // compat across un-migrated rows.
    acousticAxisBodyLocal?: number[];
    acousticAxisLocal?: number[];
    rfPropagationDirectionBodyLocal?: number[];
    rfPropagationDirectionLocal?: number[];
    braggAngularAcceptanceMrad?: number;
    maxDiffractionOrder?: number;
    sidebandVisibilityThreshold?: number;
    braggTiltAxisDegLab?: number;
    braggTiltAxisAngleDeg?: number;  // legacy
    /** Phase 7 (AOM align rewrite): optional override for the body-local
     *  pivot used by the Bragg rotation. Defaults to the midpoint of
     *  the asset's intercept_in / intercept_out anchors. */
    braggInteractionPointMmBodyLocal?: number[] | null;
    /** Phase 7.4 align rewrite: how Stage 1 pins the rotation about
     *  beam direction (the only DoF left after the Bragg constraint
     *  beam·D2 = sin θ_B is imposed). See physics.ts for the modes. */
    stage1RotationMode?: Stage1RotationMode;
    /** Phase 7.4 align rewrite: whether the user-selected order m maps
     *  to the same physical lab side regardless of state ("lab-fixed"),
     *  or flips with state-B traversal ("physical-traversal"). */
    stage2SignConvention?: Stage2SignConvention;
  };
  // (Phase 7.1) `braggTiltAxisDegLab` legacy field reading removed —
  // align now derives the tilt axis from b̂_world × â_world. Schema
  // field is kept for backward compat with stored data but no longer
  // consulted by either UI or align.
  const componentRef = scene.components.find((c) => c.id === sceneObject.componentId);
  const compProps = (componentRef?.properties ?? {}) as { wavelengthRangeNm?: number[] };

  // Phase B (RF link single-source-of-truth): the AOM's centerFreqMhz and
  // rfDrivePowerW are no longer stored on the AOM. They are resolved live
  // from the upstream rf_source channel via the rf_cable link. The
  // resolver mirrors `hydrate_aom_rf_drive` in optics_seq.py so the panel
  // shows exactly what the backend solver will see.
  const upstreamDrive = useMemo(
    () => resolveAomRfDriveFromScene(sceneObject.id, scene.objects, scene.physicsElements),
    [scene.objects, scene.physicsElements, sceneObject.id],
  );
  const upstreamRf = useMemo<{ sourceName: string; channelName: string } | null>(() => {
    if (!upstreamDrive) return null;
    const srcObj = scene.objects.find((o) => o.id === upstreamDrive.sourceObjectId);
    return {
      sourceName: srcObj?.name ?? "rf_source",
      channelName: upstreamDrive.sourceAnchorName,
    };
  }, [upstreamDrive, scene.objects]);
  // Effective params overlay: physics formulas below still expect
  // `centerFreqMhz` / `rfDrivePowerW` on the params object. Inject the
  // resolved live values so braggAngleRad / diffractionEfficiency /
  // phaseModulationDepth all see the upstream-derived values without any
  // signature changes. Falls through to defaults when orphan.
  const effectiveCenterFreqMhz = upstreamDrive?.frequencyMhz ?? 80;
  const effectiveRfDrivePowerW = upstreamDrive
    ? Math.min(upstreamDrive.drivePowerW, params.rfPowerMaxW ?? Number.POSITIVE_INFINITY)
    : undefined;
  const physicsParams = {
    ...params,
    centerFreqMhz: effectiveCenterFreqMhz,
    rfDrivePowerW: effectiveRfDrivePowerW,
  } as typeof params & { centerFreqMhz: number; rfDrivePowerW?: number };
  const wavelengthForAngleNm = (() => {
    const range = compProps.wavelengthRangeNm;
    if (Array.isArray(range) && range.length === 2) {
      return (range[0] + range[1]) / 2;
    }
    return 780;
  })();

  // Phase 7: physics formulas live in optical/kinds/aom/physics.ts. The
  // panel computes the on-Bragg case at the rated mid-band so the user
  // sees the operating-point of the AOM; the ray-tracer applies the
  // same formulas plus an off-Bragg `braggAngularFactor` per actual
  // beam direction. Single source = panel ↔ scene cannot disagree.
  const thetaBRad = braggAngleRad(physicsParams, wavelengthForAngleNm);
  const thetaBMrad = thetaBRad * 1e3;
  const efficiencyEst = diffractionEfficiency(physicsParams, wavelengthForAngleNm, thetaBRad);
  const phaseModDepth = phaseModulationDepth(
    physicsParams, wavelengthForAngleNm, thetaBRad, efficiencyEst,
  );

  const orderRaw = params.diffractionOrder;
  const currentOrder: -1 | 0 | 1 =
    orderRaw === 0 ? 0 : orderRaw === -1 ? -1 : 1;
  const braggAcceptanceMrad = params.braggAngularAcceptanceMrad ?? 2.0;
  // 2026-05-10: RF direction now lives on the Asset3D as `rf_direction`
  // anchor; the helper falls back to legacy kindParams keys for
  // un-migrated rows.
  const _assetForRf = (() => {
    const c = scene.components.find((cc) => cc.id === sceneObject.componentId);
    return c?.asset3dId ? scene.assets.find((aa) => aa.id === c.asset3dId) ?? null : null;
  })();
  const _rfDir = getRfDirectionBodyLocal(_assetForRf, params as Record<string, unknown>)
    ?? { x: -1, y: 0, z: 0 };
  const rfDirectionLocal = [_rfDir.x, _rfDir.y, _rfDir.z];
  const opticalCarrierThz = 299_792_458 / (wavelengthForAngleNm * 1e-9) / 1e12;
  const maxDiffractionOrder = Math.max(1, Math.min(10, Math.round(params.maxDiffractionOrder ?? 3)));
  const sidebandVisibilityThreshold = Math.max(0, Math.min(1, params.sidebandVisibilityThreshold ?? 0.01));

  const intensityByOrder = sidebandIntensitiesOnBragg(
    currentOrder, efficiencyEst, phaseModDepth, maxDiffractionOrder,
  );
  const zerothIntensity = intensityByOrder.get(0)!;
  const selectedFirstOrderIntensity = currentOrder === 0 ? 0 : efficiencyEst;

  const orders: number[] = [];
  for (let nn = -maxDiffractionOrder; nn <= maxDiffractionOrder; nn++) orders.push(nn);

  const sidebandRows: Array<{
    order: number;
    angleMrad: number;
    frequencyOffsetMhz: number;
    centerFrequencyThz: number;
    intensity: number;
    matched: boolean;
    visible: boolean; // would the ray-tracer draw it?
  }> = orders.map((order) => {
    const intensity = intensityByOrder.get(order) ?? 0;
    const matched = order === currentOrder;
    const alwaysShow = order === 0 || order === currentOrder;
    return {
      order,
      // Convention (2026-05-11 datasheet match): each order m sits at
      // m·2·θ_B from the input (the full Bragg deflection angle, equal
      // to m·λ·f/v in air; matches AA Opto MT80 datasheet's `Δθ = λF/V`).
      // θ_B here is the EXTERNAL (lab-frame) Bragg half-angle returned
      // by physics.ts braggAngleRad — see `physics.ts` for the convention.
      angleMrad: order === 0 ? 0 : order * 2 * thetaBMrad,
      frequencyOffsetMhz: order * effectiveCenterFreqMhz,
      centerFrequencyThz: opticalCarrierThz + order * effectiveCenterFreqMhz * 1e-6,
      intensity,
      matched,
      visible: alwaysShow || intensity >= sidebandVisibilityThreshold,
    };
  });

  const persist = async (patch: Record<string, unknown>) => {
    await upsertOpticalElement({
      objectId: sceneObject.id,
      elementKind: element.elementKind,
      kindParams: { ...params, ...patch },
      inputPorts: element.inputPorts,
      outputPorts: element.outputPorts,
    });
  };

  const setOrder = (order: -1 | 0 | 1) => {
    if (order === currentOrder) return;
    void persist({ diffractionOrder: order });
  };

  // (Removed in Phase 7) The "Flip RF" control is intentionally absent.
  // With braggTiltAxisDegLab defining the rotation plane and
  // diffractionOrder ∈ {-1, 0, +1} selecting which side of that plane
  // the diffracted ray emerges, the ±1 geometry is fully determined.
  // Flipping `acousticAxisBodyLocal` was a redundant second path to
  // the same swap (it negates the dot in the Bragg constraint, which
  // is equivalent to flipping orderSign). Keeping both knobs let users
  // accidentally set inconsistent state. The acoustic axis is now
  // treated as fixed asset metadata (MT80 default body -X, transducer
  // -> absorber); to swap which side gets +1, change the order radio
  // instead.

  // RF drive power slider — η depends on it via the closed-form sin².
  // RF drive power is committed via the NumberCell in the RF Settings
  // block (top of the AOM panel). The old text-input row with rfDraft/
  // commitRfPower local state was removed when RF settings were split
  // out — keeping the rfMax cap so the NumberCell onCommit can clamp.
  const rfMax = params.rfPowerMaxW ?? 2.0;

  // Phase B: RF drive power is no longer stored on the AOM. "Max η"
  // now simply pegs the baseEfficiency override at 0.99 — the user
  // selects the actual drive level in the RF link panel (AD9959 CH Vpp).
  // The closed-form rfPowerForPeakEfficiencyW remains available for
  // panel readouts but the button no longer writes to a removed field.
  const maximiseEfficiency = () => {
    void persist({ baseEfficiency: 0.99 });
  };

  // Align the AOM body to the upstream beam in two stages, sharing a
  // single Bragg sign convention with rayTrace.ts via the helpers in
  // optical/kinds/aom/physics.ts (`expectedInputDotD2`,
  // `diffractedDirection`).
  //
  // Anchor contract (Phase 7.4 rewrite — vibe-coding-log 2026-05-08):
  //
  //   - Asset MUST declare both `intercept_in` and `intercept_out`
  //     anchors with `apertureMm` set. Migration 0021 backfills these.
  //
  //   - Body frame: D1 = unit(intercept_out − intercept_in)  (optical
  //     axis), D2 = rfPropagationDirectionBodyLocal (acoustic / RFin
  //     axis), D3 = D1 × D2 (Bragg rotation axis). For canonical MT80:
  //     D1 = body+Y, D2 = body−X, D3 = body+Z.
  //
  //   - State: sign of (in→out)·beam in WORLD picks state A
  //     (entry=intercept_in) or B (entry=intercept_out).
  //
  //   - Stage 1 (snap optical axis ∥ beam): pick D1_target = ±beam,
  //     D3_target by `params.stage1RotationMode`:
  //       "min-rot"  — minimum-angle rotation from current pose.
  //       "upright"  — D3 closest to lab+Z (default — keeps the AOM
  //                    body upright on a horizontal optical table).
  //       "keep-d2"  — D2 closest to its current lab direction.
  //     D2_target = D3_target × D1_target (right-handed).
  //
  //   - Stage 2 (Bragg rotation): rotate body about D3_target by
  //       ω = −traversalSignRaw · arcsin(expectedInputDotD2(...))
  //     so beam·D2_body lands on the value `physics.ts` derives from
  //     the user-selected order m and `params.stage2SignConvention`.
  //
  //   - Pivot for Stage 2: midpoint of in/out anchors (or
  //     `kindParams.braggInteractionPointMmBodyLocal` override). Pivot
  //     only matters for the "rock around interaction point" UX feel;
  //     the final pose is determined by orientation + entry-on-beam
  //     translation, which makes the math pivot-independent.
  //
  //   - Translation: after the full rotation, project the entry
  //     anchor's lab position onto the beam line.
  const [alignBusy, setAlignBusy] = useState(false);
  const [alignFeedback, setAlignFeedback] = useState<string | null>(null);

  const ALIGN_TOLERANCE_MM = 25;

  const alignToLaser = async () => {
    setAlignBusy(true);
    setAlignFeedback(null);
    try {
      // [1] Locate Asset3D and validate the anchor contract.
      const componentRow = scene.components.find((c) => c.id === sceneObject.componentId);
      const assetRow = componentRow?.asset3dId
        ? scene.assets.find((a) => a.id === componentRow.asset3dId)
        : undefined;
      if (!componentRow) {
        setAlignFeedback("AOM Component row not found in scene store.");
        return;
      }
      if (!assetRow) {
        setAlignFeedback(
          "AOM has no Asset3D — open PHY Editor → Optical → optical_component to assign or define anchors.",
        );
        return;
      }
      const inAnchor = assetRow.anchors.find((a) => a.id === "intercept_in");
      const outAnchor = assetRow.anchors.find((a) => a.id === "intercept_out");
      const missing: string[] = [];
      if (!inAnchor) missing.push("intercept_in");
      if (!outAnchor) missing.push("intercept_out");
      if (missing.length) {
        setAlignFeedback(
          `AOM asset ${assetRow.name} is missing ${missing.join(" and ")}. ` +
          "Open PHY Editor → Optical → optical_component and add the port anchor(s).",
        );
        return;
      }
      // V2: aperture is per-instance now. Use the effective aperture
      // (per-object override → asset anchor seed) and only block alignment
      // if neither path provides one.
      const inEffAp = getEffectiveApertureMm(sceneObject, inAnchor!, "intercept_in");
      const outEffAp = getEffectiveApertureMm(sceneObject, outAnchor!, "intercept_out");
      if (inEffAp == null || inEffAp <= 0) missing.push("intercept_in.aperture");
      if (outEffAp == null || outEffAp <= 0) missing.push("intercept_out.aperture");
      if (missing.length) {
        setAlignFeedback(
          `AOM ${sceneObject.name} has anchor(s) without aperture: ${missing.join(", ")}. ` +
          "Edit per-object aperture in the Object panel before aligning.",
        );
        return;
      }

      // [2] Body-local D1/D2/D3 from anchors + RF direction.
      const inBody = inAnchor!.positionMmBodyLocal;
      const outBody = outAnchor!.positionMmBodyLocal;
      const rfBody = {
        x: rfDirectionLocal[0],
        y: rfDirectionLocal[1],
        z: rfDirectionLocal[2],
      };
      const bodyFrame = aomBodyFrameBodyLocal(inBody, outBody, rfBody);
      if (!bodyFrame) {
        setAlignFeedback(
          "Cannot derive D1/D2/D3 from this asset — in/out anchors coincide " +
          "or RF direction is parallel/zero. Open PHY Editor and fix.",
        );
        return;
      }
      const D1Body = bodyFrame.D1;
      const D2Body = bodyFrame.D2;
      const D3Body = bodyFrame.D3;

      // [3] Current world-frame anchor positions (for upstream-beam search).
      const bodyToLab = (bodyMm: { x: number; y: number; z: number }) => {
        const rotated = rotateLabDir(bodyMm, sceneObject);
        return {
          x: sceneObject.xMm + rotated.x,
          y: sceneObject.yMm + rotated.y,
          z: sceneObject.zMm + rotated.z,
        };
      };
      const inLab = bodyToLab(inBody);
      const outLab = bodyToLab(outBody);

      // [4] Walk live ray-trace segments, pick the upstream beam whose
      //     closest-approach hits one of the AOM anchors. Beam-first
      //     (smaller forward t) wins as the entry port.
      type TraceSeg = {
        sourceObjectId: string;
        startThree: { x: number; y: number; z: number };
        endThree: { x: number; y: number; z: number };
      };
      const traces: TraceSeg[] = (typeof window !== "undefined"
        ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
        : undefined) ?? [];
      type Match = {
        portId: "intercept_in" | "intercept_out";
        entryBody: { x: number; y: number; z: number };
        entryT: number;
        otherT: number;
        closest: { x: number; y: number; z: number };
        dir: { x: number; y: number; z: number };
        miss: number;
        otherMiss: number;
        sourceId: string;
      };
      let best: Match | null = null;
      for (const seg of traces) {
        if (seg.sourceObjectId === sceneObject.id) continue;
        const a = threeToLabPointMm(seg.startThree);
        const b = threeToLabPointMm(seg.endThree);
        const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
        if (lenSq < 1e-6) continue;
        const segLen = Math.sqrt(lenSq);
        const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
        const projects = (
          [inLab, outLab] as { x: number; y: number; z: number }[]
        ).map((p) => {
          const t = (p.x - a.x) * dir.x + (p.y - a.y) * dir.y + (p.z - a.z) * dir.z;
          const closest = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
          const miss = Math.hypot(p.x - closest.x, p.y - closest.y, p.z - closest.z);
          return { t, closest, miss };
        });
        const [pIn, pOut] = projects;
        if (pIn.t < 0 && pOut.t < 0) continue;

        const candidates: Array<Match> = [];
        if (pIn.miss <= ALIGN_TOLERANCE_MM && pIn.t >= 0) {
          candidates.push({
            portId: "intercept_in",
            entryBody: { ...inBody },
            entryT: pIn.t,
            otherT: pOut.t,
            closest: pIn.closest,
            dir,
            miss: pIn.miss,
            otherMiss: pOut.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        if (pOut.miss <= ALIGN_TOLERANCE_MM && pOut.t >= 0) {
          candidates.push({
            portId: "intercept_out",
            entryBody: { ...outBody },
            entryT: pOut.t,
            otherT: pIn.t,
            closest: pOut.closest,
            dir,
            miss: pOut.miss,
            otherMiss: pIn.miss,
            sourceId: seg.sourceObjectId,
          });
        }
        candidates.sort((m1, m2) => m1.entryT - m2.entryT);
        const local = candidates[0];
        if (!local) continue;
        if (!best || local.miss < best.miss || (local.miss === best.miss && local.entryT < best.entryT)) {
          best = local;
        }
      }
      if (!best) {
        setAlignFeedback(
          `No upstream beam reaches either AOM port within ${ALIGN_TOLERANCE_MM} mm. ` +
          "Rotate the AOM toward the desired beam first, or check the upstream chain is emitting.",
        );
        return;
      }

      // [5] Ambiguity guard — AOM nearly perpendicular to beam.
      // V2: use the effective per-object aperture (already validated > 0
      // on entry above).
      const entryAp = best.portId === "intercept_in" ? inEffAp! : outEffAp!;
      const apertureDiamMm = 2 * entryAp;
      if (
        best.otherMiss <= ALIGN_TOLERANCE_MM &&
        best.otherT >= 0 &&
        Math.abs(best.entryT - best.otherT) < apertureDiamMm
      ) {
        setAlignFeedback(
          "AOM is nearly perpendicular to the beam — both ports are within one aperture of the same point on the beam. " +
          "Rotate the body manually first so the beam clearly enters one port and exits the other.",
        );
        return;
      }

      // [6] State (A/B). traversalSignRaw is the *physical* state; what
      //     we feed to expectedInputDotD2 may be over-ridden by the
      //     "lab-fixed" stage-2 sign convention.
      const traversalSignRaw = aomTraversalSignFromEntryPort(best.portId);
      const stage2SignConvention = params.stage2SignConvention ?? DEFAULT_STAGE2_SIGN;
      const traversalSignForExpect = resolveTraversalSign(traversalSignRaw, stage2SignConvention);
      const effectiveOrder = effectiveAomOrderForTraversal(currentOrder, traversalSignRaw);
      const isStateB = traversalSignRaw < 0;

      // ─────────────────────────────────────────────────────────────────
      // Three-step alignment (user's decomposition, 2026-05-11):
      //   Step A: translate (in+out)/2 onto the beam line
      //   Step B: rotate so D1·beam = cos(θ_corr) where θ_corr = ±θ_B
      //   Step C: spin around D3 so beam stays in the (D1, D2) plane
      //           (i.e. beam·D3 = 0 and the in/out anchors track the beam)
      //
      // Stage 1 + Stage 2 + entry-anchor translation (the previous
      // implementation) decomposed the same final pose into "D1∥beam,
      // then tilt by θ_B about D3, then translate entry to beam". The
      // new implementation arrives at the same target geometry directly:
      //
      //   D3_target_lab = projection of (lab axis or current D3) onto
      //                   the plane perpendicular to beam — Step C
      //   D1_target_lab = s·cos(θ_B)·beam + m·s'·sin(θ_B)·(D3_target × beam)
      //                   — Step B (s = traversalSignRaw, s' = traversalSignForExpect)
      //   D2_target_lab = D3_target × D1_target (right-handed triad)
      //   pos_new       = midpoint_foot − R_new · midpoint_body — Step A
      //
      // The D1_target formula is derived from the Bragg condition
      //   beam · D2 = expectedInputDotD2(m, s', θ_B) = −m·s'·sin(θ_B)
      // combined with beam · D1 = s·cos(θ_B), beam · D3 = 0. Verified by
      // the residual check below: |arcsin(beam·D2_new) − arcsin(expected)| < 1 mrad.
      // ─────────────────────────────────────────────────────────────────
      const beamUnit = best.dir;
      const cross3 = (
        a: { x: number; y: number; z: number },
        b: { x: number; y: number; z: number },
      ) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
      });
      const projectOntoPerp = (
        v: { x: number; y: number; z: number },
        unitN: { x: number; y: number; z: number },
      ): { x: number; y: number; z: number } | null => {
        const dot = v.x * unitN.x + v.y * unitN.y + v.z * unitN.z;
        const proj = {
          x: v.x - dot * unitN.x,
          y: v.y - dot * unitN.y,
          z: v.z - dot * unitN.z,
        };
        const m = Math.hypot(proj.x, proj.y, proj.z);
        return m > 1e-6 ? { x: proj.x / m, y: proj.y / m, z: proj.z / m } : null;
      };

      // Step C: pick D3_target perpendicular to beam. `stage1RotationMode`
      //   keeps the same UI semantics as before — it now decides which
      //   reference axis to project onto ⊥-beam to get D3:
      //     "upright"  → D3 ≈ projection of lab+Z (chassis vertical)
      //     "min-rot"  → D3 ≈ projection of current D3_lab (least disturbance)
      //     "keep-d2"  → D3 = current_D2_lab × beam (preserves acoustic-axis side)
      const D2WorldCurrent = rotateLabDir(D2Body, sceneObject);
      const D3WorldCurrent = rotateLabDir(D3Body, sceneObject);
      const stage1Mode: Stage1RotationMode = params.stage1RotationMode ?? DEFAULT_STAGE1_MODE;
      let D3TargetLab: { x: number; y: number; z: number } | null = null;
      if (stage1Mode === "min-rot") {
        D3TargetLab =
          projectOntoPerp(D3WorldCurrent, beamUnit) ??
          projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
          projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      } else if (stage1Mode === "keep-d2") {
        // D3 such that current D2 stays on the same side: D3 = unit(D2 × beam).
        const raw = cross3(D2WorldCurrent, beamUnit);
        const mag = Math.hypot(raw.x, raw.y, raw.z);
        D3TargetLab =
          mag > 1e-6
            ? { x: raw.x / mag, y: raw.y / mag, z: raw.z / mag }
            : projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
              projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
              projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      } else {
        // "upright" (default)
        D3TargetLab =
          projectOntoPerp({ x: 0, y: 0, z: 1 }, beamUnit) ??
          projectOntoPerp({ x: 0, y: 1, z: 0 }, beamUnit) ??
          projectOntoPerp({ x: 1, y: 0, z: 0 }, beamUnit);
      }
      if (!D3TargetLab) {
        setAlignFeedback(
          "Cannot pick D3 perpendicular to beam — beam direction degenerate against all reference axes. " +
          "Rotate the AOM manually first or move the upstream beam off the lab-Z axis.",
        );
        return;
      }

      // Step B: derive D1_target and D2_target in lab from the Bragg
      // condition. e2 = D3_target × beam is the unit perpendicular to
      // beam in the (D1, D2) plane.
      const e2 = cross3(D3TargetLab, beamUnit);
      const cosT = Math.cos(thetaBRad);
      const sinT = Math.sin(thetaBRad);
      // s = traversalSignRaw (+1 = beam ‖ +D1, state A; −1 = state B).
      // s' = traversalSignForExpect (lab-fixed convention may set this
      //      to +1 always; physical-traversal mirrors s).
      const sRaw = traversalSignRaw;
      const sExpect = traversalSignForExpect;
      const D1TargetLab = {
        x: sRaw * cosT * beamUnit.x + currentOrder * sExpect * sinT * e2.x,
        y: sRaw * cosT * beamUnit.y + currentOrder * sExpect * sinT * e2.y,
        z: sRaw * cosT * beamUnit.z + currentOrder * sExpect * sinT * e2.z,
      };
      const D2TargetLab = cross3(D3TargetLab, D1TargetLab);

      // Build R_new (basis change): body's {D1, D2, D3} → lab targets.
      //   M_body   has body-local D1/D2/D3 as columns
      //   M_target has world target D1/D2/D3 as columns
      //   R_new = M_target · M_body^{-1}
      const D1BodyThree = bodyLocalDirToThree(D1Body);
      const D2BodyThree = bodyLocalDirToThree(D2Body);
      const D3BodyThree = bodyLocalDirToThree(D3Body);
      const mBody = new THREE.Matrix4().makeBasis(D1BodyThree, D2BodyThree, D3BodyThree);
      const D1TargetThree = labDirToThree(D1TargetLab).normalize();
      const D2TargetThree = labDirToThree(D2TargetLab).normalize();
      const D3TargetThree = labDirToThree(D3TargetLab).normalize();
      const mTarget = new THREE.Matrix4().makeBasis(D1TargetThree, D2TargetThree, D3TargetThree);
      const mBodyInv = mBody.clone().invert();
      const mAlign = new THREE.Matrix4().multiplyMatrices(mTarget, mBodyInv);
      const finalQuat = new THREE.Quaternion().setFromRotationMatrix(mAlign);

      // For the feedback message we still want to report the equivalent
      // "Stage 2 omega" (= the angle by which D1 deviates from beam) so
      // the user can sanity-check it equals ±θ_B per the chosen order.
      const expectedDotD2 = expectedInputDotD2(currentOrder, traversalSignForExpect, thetaBRad);
      const omegaRad = -traversalSignRaw * Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1));

      // Step A: translate so MIDPOINT of (intercept_in, intercept_out) sits
      // on the beam line. We project the OLD midpoint onto the beam to
      // pick the foot, then set pos_new so the body's midpoint maps to
      // that foot under R_new.
      const midpointBody = {
        x: 0.5 * (inBody.x + outBody.x),
        y: 0.5 * (inBody.y + outBody.y),
        z: 0.5 * (inBody.z + outBody.z),
      };
      const midpointLabOld = bodyToLab(midpointBody);
      // best.closest is the foot of the perpendicular from the OLD entry
      // anchor onto the beam — it's a known point on the beam ray. We
      // project the OLD midpoint onto the same beam ray to get the
      // midpoint's own foot.
      const beamRef = best.closest;
      const tMid =
        (midpointLabOld.x - beamRef.x) * beamUnit.x +
        (midpointLabOld.y - beamRef.y) * beamUnit.y +
        (midpointLabOld.z - beamRef.z) * beamUnit.z;
      const midpointFoot = {
        x: beamRef.x + tMid * beamUnit.x,
        y: beamRef.y + tMid * beamUnit.y,
        z: beamRef.z + tMid * beamUnit.z,
      };
      const rotatedBodyOffset = (bodyMm: { x: number; y: number; z: number }) => {
        const v3 = bodyLocalDirToThree(bodyMm);
        v3.applyQuaternion(finalQuat);
        return { x: v3.x, y: -v3.z, z: v3.y };
      };
      const rotatedMidpoint = rotatedBodyOffset(midpointBody);
      let nextXMm = midpointFoot.x - rotatedMidpoint.x;
      let nextYMm = midpointFoot.y - rotatedMidpoint.y;
      let nextZMm = midpointFoot.z - rotatedMidpoint.z;
      // After the above, the midpoint of (in, out) sits exactly at
      // midpointFoot which is on the beam line by construction. The in
      // and out anchors are then offset from that midpoint by ±L/2·D1,
      // where D1 makes angle θ_B with beam — so each port sits at
      // L/2·sin(θ_B) ⊥-distance from the beam (typically <0.1 mm for an
      // AOM).

      // [11] Verify Bragg: compute residual = arcsin(beam · D2_new) − arcsin(expectedDotD2).
      const D2NewThree = bodyLocalDirToThree(D2Body);
      D2NewThree.applyQuaternion(finalQuat).normalize();
      const D2NewLab = { x: D2NewThree.x, y: -D2NewThree.z, z: D2NewThree.y };
      const beamDotD2New = beamUnit.x * D2NewLab.x + beamUnit.y * D2NewLab.y + beamUnit.z * D2NewLab.z;
      const residualMrad = (
        Math.asin(THREE.MathUtils.clamp(beamDotD2New, -1, 1)) -
        Math.asin(THREE.MathUtils.clamp(expectedDotD2, -1, 1))
      ) * 1e3;

      // [12] Decompose finalQuat back to SceneObject Euler.
      const finalEuler = new THREE.Euler().setFromQuaternion(finalQuat, "YXZ");
      const nextRxDeg = THREE.MathUtils.radToDeg(finalEuler.x);
      const nextRzDeg = THREE.MathUtils.radToDeg(finalEuler.y);
      const nextRyDeg = -THREE.MathUtils.radToDeg(finalEuler.z);

      // [13] Aperture clipping warning (best-effort; ray-tracer doesn't
      //      publish per-segment 1/e² waist, so use upstream seed waist
      //      as a coarse upper bound).
      const sourceObj = scene.objects.find((o) => o.id === best!.sourceId);
      const sourceComp = sourceObj
        ? scene.components.find((c) => c.id === sourceObj.componentId)
        : undefined;
      const sourceProps = (sourceComp?.properties ?? {}) as { beamWaistMm?: number };
      const upstreamWaistMm =
        typeof sourceProps.beamWaistMm === "number" ? sourceProps.beamWaistMm : null;
      const clippingWarning =
        upstreamWaistMm !== null && upstreamWaistMm > entryAp
          ? ` ⚠ upstream beam waist ${upstreamWaistMm.toFixed(2)} mm > entry aperture ${entryAp.toFixed(2)} mm — beam will clip.`
          : "";

      // [14] Persist + feedback.
      await updateSceneObject(sceneObject.id, {
        xMm: nextXMm,
        yMm: nextYMm,
        zMm: nextZMm,
        rxDeg: nextRxDeg,
        ryDeg: nextRyDeg,
        rzDeg: nextRzDeg,
      });
      const sourceName = sourceObj?.name ?? best!.sourceId.slice(0, 6);
      const stateLabel = isStateB ? "B (entry=out)" : "A (entry=in)";
      const orderLabel = currentOrder === 0 ? "0th" : currentOrder > 0 ? "+1" : "-1";
      const traversalNote =
        traversalSignRaw < 0 && currentOrder !== 0 && stage2SignConvention === "physical-traversal"
          ? ` (state-B traversal flips selected ${currentOrder > 0 ? "+1" : "-1"} → physical ${effectiveOrder > 0 ? "+1" : "-1"})`
          : "";
      setAlignFeedback(
        `Aligned (${stage1Mode}): midpoint on beam, D1·beam = cos(θ_B) ` +
        `for state ${stateLabel}, m=${orderLabel}${traversalNote}. ` +
        `Equivalent ω = ${(omegaRad * 1e3).toFixed(3)} mrad about D3. ` +
        `Bragg residual ${residualMrad.toFixed(3)} mrad. ` +
        `Source: ${sourceName} beam.${clippingWarning}`,
      );
    } catch (err) {
      setAlignFeedback(`Align failed: ${(err as Error).message}`);
    } finally {
      setAlignBusy(false);
    }
  };

  // Structured kindParams editor — mirrors the LaserSourceControls /
  // WaveplateAdjustControls style. Rendered above the existing RF drive +
  // sideband-table block. Each section commits via `persist()` and uses a
  // local NumberCell that draftss / commits on blur or Enter.
  const NumberCell = ({
    label,
    suffix,
    value,
    step = 0.1,
    onCommit,
    placeholder,
    style,
  }: {
    label: string;
    suffix?: string;
    value: number;
    step?: number;
    onCommit: (v: number) => void;
    placeholder?: string;
    style?: React.CSSProperties;
  }) => {
    const [draft, setDraft] = useState(Number.isFinite(value) ? value.toString() : "");
    useEffect(() => setDraft(Number.isFinite(value) ? value.toString() : ""), [value]);
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
          placeholder={placeholder}
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

  const sectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(56, 189, 248, 0.06)",
    borderLeft: "2px solid #38bdf8",
    fontSize: 11,
  };
  const titleStyle: React.CSSProperties = { color: "#38bdf8", fontWeight: 600, marginBottom: 6 };
  // RF subsection — amber accent matches the .physics-panel-rf chrome so the
  // user sees at a glance which knobs belong to the RF input vs the optical
  // crystal. AOM is a hybrid kind (optical body + RF drive), so the panel
  // exposes both. (User feedback 2026-05-13: keep RF settings visually
  // separated from optical settings.)
  const rfSectionStyle: React.CSSProperties = {
    marginTop: 8,
    padding: "6px 8px",
    background: "rgba(245, 158, 11, 0.08)",
    borderLeft: "2px solid #f59e0b",
    fontSize: 11,
  };
  const rfTitleStyle: React.CSSProperties = { color: "#b45309", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" };
  const opticalTitleStyle: React.CSSProperties = { color: "#0369a1", fontWeight: 700, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" };
  const groupHeaderStyle: React.CSSProperties = { marginTop: 12, marginBottom: 4, fontSize: 10 };
  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 };
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 };

  const useBaseEfficiencyOverride = typeof params.baseEfficiency === "number";

  return (
    <div className="mirror-adjust">
      {/* RF Settings — drive carrier + power. Hybrid kinds (AOM/EOM) expose
          their RF input here so the RF-related knobs aren't mixed in with
          the optical crystal / Bragg math. */}
      <div style={groupHeaderStyle}><span style={rfTitleStyle}>RF Settings</span></div>
      <div style={rfSectionStyle}>
        <div style={{ ...titleStyle, color: "#b45309" }}>RF carrier &amp; drive</div>
        {upstreamRf ? (
          <div
            style={{
              padding: 8,
              background: "#1c1c22",
              borderRadius: 4,
              border: "1px dashed #3e3e48",
              fontSize: 11,
              color: "#cfcfd8",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ color: "#8e8e9a", fontSize: 10 }}>
              Synced from <strong style={{ color: "#cfcfd8" }}>{upstreamRf.sourceName}</strong>
              {" · "}
              <strong style={{ color: "#cfcfd8" }}>{upstreamRf.channelName}</strong>
              {" "}via rf_cable — edit in the RF link panel.
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span>
                Carrier f:{" "}
                <strong>{effectiveCenterFreqMhz.toFixed(1)} MHz</strong>
              </span>
              <span>
                RF drive: <strong>{(effectiveRfDrivePowerW ?? 0).toFixed(3)} W</strong>
              </span>
              <span style={{ marginLeft: "auto" }}>
                RF max:{" "}
                <NumberCell
                  label=""
                  suffix="W"
                  value={params.rfPowerMaxW ?? 2}
                  step={0.1}
                  onCommit={(v) => v > 0 && void persist({ rfPowerMaxW: v })}
                />
              </span>
            </div>
          </div>
        ) : (
          <div
            style={{
              padding: 8,
              background: "#1c1c22",
              borderRadius: 4,
              border: "1px dashed #b45309",
              fontSize: 11,
              color: "#cfcfd8",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ color: "#d49a3a", fontSize: 10 }}>
              ⚠ This AOM has no upstream rf_cable. Connect its rf_in anchor
              to an rf_source channel in the RF link panel to drive it.
              Until then the closed-form efficiency falls back to
              baseEfficiency and the sideband Δf = 80 MHz default.
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <span>
                Carrier f: <strong>{effectiveCenterFreqMhz.toFixed(1)} MHz</strong>{" "}
                <span style={{ color: "#8e8e9a" }}>(default)</span>
              </span>
              <span style={{ marginLeft: "auto" }}>
                RF max:{" "}
                <NumberCell
                  label=""
                  suffix="W"
                  value={params.rfPowerMaxW ?? 2}
                  step={0.1}
                  onCommit={(v) => v > 0 && void persist({ rfPowerMaxW: v })}
                />
              </span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={maximiseEfficiency}
            title="Peg baseEfficiency at 0.99 (closed-form η no longer writes back to AOMParams after Phase B — RF drive is owned by the upstream AD9959 channel in the RF link panel)."
          >
            Max η (override)
          </button>
        </div>
        <div style={{ opacity: 0.7, marginTop: 4, fontSize: 10 }}>
          Drives the acoustic wave that diffracts the beam (RF chain terminates here).
          {effectiveRfDrivePowerW != null ? (
            <> Live P_d = <strong>{effectiveRfDrivePowerW.toFixed(4)} W</strong>, capped at {rfMax.toFixed(2)} W.</>
          ) : (
            <> No upstream — P_d undefined (closed-form η disabled).</>
          )}
        </div>
      </div>

      {/* Optical Settings — crystal physics, Bragg geometry, efficiency, sideband. */}
      <div style={groupHeaderStyle}><span style={opticalTitleStyle}>Optical Settings</span></div>
      {/* Acoustic crystal — knobs that affect θ_B and Δθ on the optical side. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Acoustic crystal</div>
        <div style={grid2}>
          <NumberCell
            label="Acoustic v"
            suffix="m/s"
            value={params.acousticVelocityMPerS ?? 4200}
            step={50}
            onCommit={(v) => v > 0 && void persist({ acousticVelocityMPerS: v })}
          />
          <NumberCell
            label="Refractive n"
            value={params.refractiveIndex ?? 2.26}
            step={0.01}
            onCommit={(v) => v > 0 && void persist({ refractiveIndex: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          External Bragg half-angle θ_B = arcsin(λ·f/(2·v)) = <strong>{thetaBMrad.toFixed(2)} mrad</strong> @ {wavelengthForAngleNm.toFixed(0)} nm.
          {" "}Full 0→±1 separation 2θ_B = <strong>{(2 * thetaBMrad).toFixed(2)} mrad</strong>{" "}
          (matches datasheet's Δθ = λ·f/v).
        </div>
      </div>

      {/* Crystal geometry — feed the closed-form sin² formula. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Crystal geometry</div>
        <div style={grid3}>
          <NumberCell
            label="Crystal length L"
            suffix="mm"
            value={params.crystalLengthMm ?? 25}
            step={1}
            onCommit={(v) => v > 0 && void persist({ crystalLengthMm: v })}
          />
          <NumberCell
            label="Acoustic beam W"
            suffix="mm"
            value={params.acousticBeamWidthMm ?? 1.5}
            step={0.1}
            onCommit={(v) => v > 0 && void persist({ acousticBeamWidthMm: v })}
          />
          <NumberCell
            label="Figure of merit M₂"
            suffix="m²/W"
            value={params.figureOfMeritM2 ?? 3.4e-14}
            step={1e-15}
            onCommit={(v) => v > 0 && void persist({ figureOfMeritM2: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Used by the closed-form η = sin²((π·L / 2λ·cosθ_B) · √(2·M₂·P_d/W)).{" "}
          For TeO₂-L (longitudinal mode) at 850 nm, M₂ ≈ 3.4×10⁻¹⁴ m²/W.
        </div>
      </div>

      {/* Efficiency — closed-form vs override; angular acceptance. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Efficiency</div>
        <label className="component-editor-coord" style={{ marginBottom: 6, display: "flex", flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={useBaseEfficiencyOverride}
            onChange={(e) => {
              if (e.target.checked) {
                // Set baseEfficiency to current closed-form result so the
                // checkbox flip doesn't surprise the user with a jump.
                void persist({ baseEfficiency: efficiencyEst });
              } else {
                // Remove baseEfficiency so closed-form takes over.
                const { baseEfficiency: _drop, ...rest } = params;
                void upsertOpticalElement({
                  objectId: sceneObject.id,
                  elementKind: element.elementKind,
                  kindParams: rest,
                  inputPorts: element.inputPorts,
                  outputPorts: element.outputPorts,
                });
              }
            }}
          />
          <span style={{ fontSize: 11 }}>
            Override closed-form (set η directly — useful when datasheet η doesn't match the M₂/L/W combo)
          </span>
        </label>
        <div style={grid2}>
          {useBaseEfficiencyOverride && (
            <NumberCell
              label="η (override)"
              value={params.baseEfficiency ?? 0.85}
              step={0.01}
              onCommit={(v) => v >= 0 && v <= 1 && void persist({ baseEfficiency: v })}
            />
          )}
          <NumberCell
            label="Bragg angular acceptance"
            suffix="mrad"
            value={params.braggAngularAcceptanceMrad ?? 2}
            step={0.1}
            onCommit={(v) => v > 0 && void persist({ braggAngularAcceptanceMrad: v })}
          />
        </div>
        <div style={{ opacity: 0.6, marginTop: 4, fontSize: 10 }}>
          Live η at λ ≈ {wavelengthForAngleNm.toFixed(0)} nm
          {effectiveRfDrivePowerW != null
            ? <>, P_d = {effectiveRfDrivePowerW.toFixed(4)} W</>
            : <>, P_d undefined</>}:{" "}
          <strong>{(efficiencyEst * 100).toFixed(1)}%</strong>.
          {useBaseEfficiencyOverride
            ? " (using override)"
            : " (closed-form sin²)"}
        </div>
      </div>

      {/* (RF drive power, RF max and Max η button moved into the RF
          Settings group at the top of this panel — 2026-05-13.) */}
      <p className="mirror-adjust-hint">
        Bragg angle θ_B at λ ≈ {wavelengthForAngleNm.toFixed(0)} nm:{" "}
        <strong>{thetaBMrad.toFixed(2)} mrad</strong> ({(thetaBRad * 180 / Math.PI).toFixed(3)}°).
        Estimated efficiency η = <strong>{(efficiencyEst * 100).toFixed(1)}%</strong>.
        {" "}Angular acceptance = <strong>{braggAcceptanceMrad.toFixed(2)} mrad</strong>.
      </p>
      <div className="mirror-adjust-hint" style={{ opacity: 0.9 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", fontWeight: 600 }}>Sideband</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Angle</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Shift</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Center</th>
              <th style={{ textAlign: "right", fontWeight: 600 }}>Intensity</th>
            </tr>
          </thead>
          <tbody>
            {sidebandRows.map((row) => {
              const orderLabel = row.order > 0 ? `+${row.order}` : `${row.order}`;
              const isHighlighted = row.order === 0 || row.matched;
              const visibleStyle: React.CSSProperties = isHighlighted
                ? { background: "rgba(245, 158, 11, 0.10)", fontWeight: 600 }
                : row.visible
                  ? {}
                  : { opacity: 0.45 };
              return (
                <tr key={row.order} style={visibleStyle}>
                  <td>
                    {orderLabel}
                    {row.matched ? " ◀ selected" : ""}
                    {!row.visible ? " (hidden)" : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>{row.angleMrad.toFixed(2)} mrad</td>
                  <td style={{ textAlign: "right" }}>{row.frequencyOffsetMhz > 0 ? "+" : ""}{row.frequencyOffsetMhz.toFixed(1)} MHz</td>
                  <td style={{ textAlign: "right" }}>{row.centerFrequencyThz.toFixed(6)} THz</td>
                  <td style={{ textAlign: "right" }}>{(row.intensity * 100).toFixed(row.intensity < 0.01 ? 3 : 1)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mirror-adjust-hint" style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
          Spawning orders ±{maxDiffractionOrder}; visibility threshold ={" "}
          {(sidebandVisibilityThreshold * 100).toFixed(1)}% of input. Orders below
          this don't draw a ray (0 and the selected ±1 always show).
        </p>
        {currentOrder !== 0 ? (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(245, 158, 11, 0.12)", borderLeft: "2px solid rgb(245, 158, 11)", fontSize: 12 }}>
            <strong>Visible beams (0th ↔ {currentOrder > 0 ? "+1" : "−1"}):</strong>{" "}
            angular separation ={" "}
            <strong>{(2 * thetaBMrad).toFixed(3)} mrad</strong>{" "}
            ({(2 * thetaBRad * 180 / Math.PI).toFixed(4)}°).
            <br />
            Intensity split — 0th: <strong>{(zerothIntensity * 100).toFixed(1)}%</strong>,{" "}
            {currentOrder > 0 ? "+1" : "−1"}: <strong>{(selectedFirstOrderIntensity * 100).toFixed(1)}%</strong>.
          </div>
        ) : (
          <div style={{ marginTop: 6, padding: "4px 8px", background: "rgba(0,0,0,0.05)", borderLeft: "2px solid rgba(0,0,0,0.3)", fontSize: 12 }}>
            <strong>Visible beam:</strong> only 0th order — RF off, no diffraction, no angular separation.
          </div>
        )}
      </div>
      <div className="mirror-adjust-row" role="radiogroup" aria-label="Diffraction order">
        <span style={{ alignSelf: "center", fontSize: 12, opacity: 0.8 }}>Output order:</span>
        {([-1, 0, 1] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={currentOrder === opt}
            className={currentOrder === opt ? "primary-button" : "secondary-button"}
            onClick={() => setOrder(opt)}
            style={{ minWidth: 56 }}
          >
            {opt > 0 ? `+${opt}` : opt === 0 ? "0" : `${opt}`}
          </button>
        ))}
      </div>
      <div className="mirror-adjust-row">
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Show up to ±N order</span>
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={maxDiffractionOrder}
            onChange={(e) => {
              const v = Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1)));
              void persist({ maxDiffractionOrder: v });
            }}
          />
        </label>
        <label className="mirror-adjust-field" style={{ flex: 1 }}>
          <span>Visibility threshold (%)</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={(sidebandVisibilityThreshold * 100).toFixed(2)}
            onChange={(e) => {
              const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
              void persist({ sidebandVisibilityThreshold: pct / 100 });
            }}
          />
        </label>
      </div>
      <p className="mirror-adjust-hint" style={{ opacity: 0.8 }}>
        {currentOrder === 0
          ? "0 = RF off — all power on the transmitted (zeroth) path."
          : `${currentOrder > 0 ? "+1" : "−1"} = diffracted by ${currentOrder > 0 ? "+" : "−"}2θ_B; ` +
            `zeroth retains (1−η) ≈ ${((1 - efficiencyEst) * 100).toFixed(1)}%.`}
      </p>
      {/* (Phase 7.1 移除) Bragg tilt axis r (°) 手動輸入。Tilt 軸現在
          自動 = b̂×â（PHY Editor 的 intercept_in/out 定義 b̂、Component
          metadata 的 acousticAxisBodyLocal 定義 â），純幾何推導，沒有
          獨立 DoF。Schema 中的 `braggTiltAxisDegLab` 保留供舊資料讀取，
          但 align 不再讀取這個欄位。 */}
      <button
        type="button"
        className="primary-button"
        onClick={() => void alignToLaser()}
        disabled={alignBusy}
        title="Pick the AOM port (intercept_in / intercept_out) that the upstream beam reaches first, translate that anchor onto the beam line, then rotate the body 1-D around the tilt axis (defined in PHY Editor by α — body-local, ⊥ b̂; pivot = midpoint = Bragg interaction point) so dir·acoustic = orderSign·sin(θ_B)."
      >
        {alignBusy ? "Aligning…" : "Align AOM port + Bragg"}
      </button>
      {alignFeedback && (
        <div className="snap-to-beam-feedback" style={{ marginTop: 6 }}>
          {alignFeedback}
        </div>
      )}
    </div>
  );
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

function TaperedAmplifierAdjustControls({
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

  // Polarization preset detection (mirrors LaserSourceControls).
  const isClose = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) < tol;
  const detectPolPreset = (p: Jones): string => {
    const inv2 = 1 / Math.SQRT2;
    if (isClose(p.exRe ?? 0, 1) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, 0) && isClose(p.eyIm ?? 0, 0)) return "H";
    if (isClose(p.exRe ?? 0, 0) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, 1) && isClose(p.eyIm ?? 0, 0)) return "V";
    if (isClose(p.exRe ?? 0, inv2) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, inv2) && isClose(p.eyIm ?? 0, 0)) return "+45";
    if (isClose(p.exRe ?? 0, inv2) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, -inv2) && isClose(p.eyIm ?? 0, 0)) return "-45";
    if (isClose(p.exRe ?? 0, inv2) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, 0) && isClose(p.eyIm ?? 0, inv2)) return "RCP";
    if (isClose(p.exRe ?? 0, inv2) && isClose(p.exIm ?? 0, 0) && isClose(p.eyRe ?? 0, 0) && isClose(p.eyIm ?? 0, -inv2)) return "LCP";
    return "custom";
  };
  const inPolPreset = detectPolPreset(inPol);
  const outPolPreset = detectPolPreset(outPol);

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

  const polPresetJones = (next: string): [number, number, number, number] | null => {
    const inv2 = 1 / Math.SQRT2;
    const presets: Record<string, [number, number, number, number]> = {
      H: [1, 0, 0, 0],
      V: [0, 0, 1, 0],
      "+45": [inv2, 0, inv2, 0],
      "-45": [inv2, 0, -inv2, 0],
      RCP: [inv2, 0, 0, inv2],
      LCP: [inv2, 0, 0, -inv2],
    };
    return presets[next] ?? null;
  };
  const setInPolPreset = (next: string) => {
    if (next === "custom") return;
    const j = polPresetJones(next);
    if (!j) return;
    void persist({ inputPolarization: { exRe: j[0], exIm: j[1], eyRe: j[2], eyIm: j[3] } });
  };
  const setOutPolPreset = (next: string) => {
    if (next === "custom") return;
    const j = polPresetJones(next);
    if (!j) return;
    void persist({ outputPolarization: { exRe: j[0], exIm: j[1], eyRe: j[2], eyIm: j[3] } });
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

  // 2-point align: rotates + translates the TA so the incoming beam
  // passes through BOTH intercept_in and intercept_out (read from the
  // Asset3D, so phy-edit changes drive the alignment). Predecessor read
  // component.properties.apertureForwardMmBodyLocal / mesh bbox and only
  // translated, which silently ignored phy-edit anchor edits.
  const updateSceneObject = useSceneStore((state) => state.updateSceneObject);
  const scene = useSceneStore((state) => state.scene);

  const alignInputToLaser = async () => {
    const componentRow = scene.components.find((c) => c.id === sceneObject.componentId);
    const assetRow = componentRow?.asset3dId
      ? scene.assets.find((a) => a.id === componentRow.asset3dId)
      : undefined;
    if (!componentRow) {
      window.alert("TA Component row not found in scene store.");
      return;
    }
    if (!assetRow) {
      window.alert(
        "TA has no Asset3D — open PHY Editor → Optical → optical_component to assign or define anchors.",
      );
      return;
    }
    const inAnchor = assetRow.anchors?.find((a) => a.id === "intercept_in");
    const outAnchor = assetRow.anchors?.find((a) => a.id === "intercept_out");
    const missing: string[] = [];
    if (!inAnchor) missing.push("intercept_in");
    if (!outAnchor) missing.push("intercept_out");
    if (missing.length) {
      window.alert(
        `TA asset ${assetRow.name} is missing ${missing.join(" and ")}. ` +
        "Open PHY Editor → Optical → optical_component and add the port anchor(s).",
      );
      return;
    }

    const inBody = inAnchor!.positionMmBodyLocal;
    const outBody = outAnchor!.positionMmBodyLocal;
    const axisBodyRaw = {
      x: outBody.x - inBody.x,
      y: outBody.y - inBody.y,
      z: outBody.z - inBody.z,
    };
    const axisLen = Math.hypot(axisBodyRaw.x, axisBodyRaw.y, axisBodyRaw.z);
    if (axisLen < 1e-3) {
      window.alert(
        "Cannot derive TA body axis — intercept_in and intercept_out coincide. " +
        "Open PHY Editor and separate the two anchors.",
      );
      return;
    }
    const axisBodyUnit = {
      x: axisBodyRaw.x / axisLen,
      y: axisBodyRaw.y / axisLen,
      z: axisBodyRaw.z / axisLen,
    };

    // Use CURRENT intercept_in lab position as the "which beam did the
    // user mean" hint — closest beam wins. The pose tells us intent
    // before we move the chip.
    const bodyToLab = (bodyMm: { x: number; y: number; z: number }) => {
      const rotated = rotateLabDir(bodyMm, sceneObject);
      return {
        x: sceneObject.xMm + rotated.x,
        y: sceneObject.yMm + rotated.y,
        z: sceneObject.zMm + rotated.z,
      };
    };
    const inLabCurrent = bodyToLab(inBody);

    type TraceSeg = {
      sourceObjectId: string;
      startThree: { x: number; y: number; z: number };
      endThree: { x: number; y: number; z: number };
    };
    const traces: TraceSeg[] = (typeof window !== "undefined"
      ? (window as unknown as { __rayTraceDebug?: TraceSeg[] }).__rayTraceDebug
      : undefined) ?? [];
    const ALIGN_TOLERANCE_MM = 25;
    type Match = {
      origin: { x: number; y: number; z: number };
      dir: { x: number; y: number; z: number };
      closest: { x: number; y: number; z: number };
      miss: number;
      tForward: number;
      sourceId: string;
    };
    let best: Match | null = null;
    let closestAny: Match | null = null;
    for (const seg of traces) {
      // Skip segments emitted by the TA itself — its own ASE would have
      // the chip align to itself.
      if (seg.sourceObjectId === sceneObject.id) continue;
      const a = threeToLabPointMm(seg.startThree);
      const b = threeToLabPointMm(seg.endThree);
      const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const lenSq = ab.x ** 2 + ab.y ** 2 + ab.z ** 2;
      if (lenSq < 1e-6) continue;
      const segLen = Math.sqrt(lenSq);
      const dir = { x: ab.x / segLen, y: ab.y / segLen, z: ab.z / segLen };
      const toAp = {
        x: inLabCurrent.x - a.x,
        y: inLabCurrent.y - a.y,
        z: inLabCurrent.z - a.z,
      };
      const t = toAp.x * dir.x + toAp.y * dir.y + toAp.z * dir.z;
      const closest = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
      const miss = Math.hypot(
        inLabCurrent.x - closest.x,
        inLabCurrent.y - closest.y,
        inLabCurrent.z - closest.z,
      );
      const cand: Match = { origin: a, dir, closest, miss, tForward: t, sourceId: seg.sourceObjectId };
      if (!closestAny || miss < closestAny.miss) closestAny = cand;
      if (miss > ALIGN_TOLERANCE_MM || t < 0) continue;
      if (!best || miss < best.miss) best = cand;
    }
    if (!closestAny) {
      window.alert("No beam axis found in the current trace.");
      return;
    }
    if (!best) {
      window.alert(
        `No incoming beam is within ${ALIGN_TOLERANCE_MM.toFixed(1)} mm of the INPUT face. ` +
        `Closest beam is ${closestAny.miss.toFixed(2)} mm away — move the TA closer or check the upstream chain.`,
      );
      return;
    }

    // Map body's in→out axis to the beam direction (positive, not
    // anti-parallel): intercept_in lands UPSTREAM, intercept_out
    // DOWNSTREAM. setFromUnitVectors handles parallel/anti-parallel
    // degenerate cases (picks any 180° rotation about a perpendicular
    // axis).
    const beamUnit = best.dir;
    const axisBodyThree = bodyLocalDirToThree(axisBodyUnit).normalize();
    const beamThree = labDirToThree(beamUnit).normalize();
    const finalQuat = new THREE.Quaternion().setFromUnitVectors(axisBodyThree, beamThree);

    // Translate so the rotated intercept_in lands on best.closest — the
    // foot of the OLD intercept_in projection onto the beam. Picking
    // this foot preserves the user's along-beam placement.
    const inBodyThree = bodyLocalDirToThree(inBody);
    inBodyThree.applyQuaternion(finalQuat);
    const rotatedInOffsetLab = { x: inBodyThree.x, y: -inBodyThree.z, z: inBodyThree.y };
    const foot = best.closest;
    const nextXMm = foot.x - rotatedInOffsetLab.x;
    const nextYMm = foot.y - rotatedInOffsetLab.y;
    const nextZMm = foot.z - rotatedInOffsetLab.z;

    // Decompose quaternion into SceneObject Euler — order "YXZ" with
    // (three.x, three.y, -three.z) ↔ (rxDeg, rzDeg, ryDeg). See
    // sceneObjectToQuaternion in optical/frames.ts; wrong order silently
    // misplaces the chip.
    const finalEuler = new THREE.Euler().setFromQuaternion(finalQuat, "YXZ");
    const nextRxDeg = THREE.MathUtils.radToDeg(finalEuler.x);
    const nextRzDeg = THREE.MathUtils.radToDeg(finalEuler.y);
    const nextRyDeg = -THREE.MathUtils.radToDeg(finalEuler.z);

    await updateSceneObject(sceneObject.id, {
      xMm: nextXMm,
      yMm: nextYMm,
      zMm: nextZMm,
      rxDeg: nextRxDeg,
      ryDeg: nextRyDeg,
      rzDeg: nextRzDeg,
    });
  };

  return (
    <div className="snap-to-beam">
      {/* Anchor mapping legend — explains which kindParams group attaches
          to which physical anchor on the asset. Asset anchors are seeded
          in seed.py (intercept_in @ +X face = seed; intercept_out @ -X
          face = amplified output). */}
      <div style={{ ...sectionStyle, background: "rgba(56, 189, 248, 0.03)" }}>
        <div style={{ ...titleStyle, marginBottom: 4 }}>Anchor map</div>
        <div style={{ fontSize: 10, opacity: 0.85, lineHeight: 1.5 }}>
          <div><code>intercept_in</code> &nbsp;=&nbsp; seed face (+X) &nbsp;←&nbsp; Input beam profile · backward ASE exits here</div>
          <div><code>intercept_out</code> &nbsp;=&nbsp; output face (−X) &nbsp;←&nbsp; Output beam profile · forward amplified emission</div>
        </div>
      </div>

      {/* Operating point */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Operating point</div>
        <div style={grid3}>
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
      </div>

      {/* Steady-state gain (no lookup) */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Steady-state gain</div>
        <div style={grid2}>
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
      </div>

      {/* ASE (continuous fallback). The legacy `ase.power_mw` field is
          single-direction — the solver applies it as the FORWARD ASE at
          intercept_out only, so it intentionally does NOT split per-port.
          The accurate per-anchor split lives in `aseSamples` (shown in
          the Operating-point readout above). When `aseSamples` is empty
          the solver falls back to the value below for forward only;
          backward ASE is implicitly zero in that fallback path. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>
          ASE fallback <span style={{ opacity: 0.7, fontWeight: 400 }}>(used when aseSamples is empty)</span>
        </div>
        <div style={grid3}>
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
      </div>

      {/* Input beam profile — applies at the intercept_in (+X / seed) anchor */}
      <div style={sectionStyle}>
        <div style={titleStyle}>
          Input beam profile <span style={{ opacity: 0.7, fontWeight: 400 }}>@ <code>intercept_in</code></span>
        </div>
        <div style={{ marginBottom: 4, fontSize: 10, opacity: 0.7 }}>X axis</div>
        <div style={grid3}>
          <NumberCell label="waist" suffix="μm" value={isx.waistUm ?? 600} step={10}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeX", isx, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={isx.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("inputSpatialModeX", isx, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={isx.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeX", isx, { mSquared: v })} />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 10, opacity: 0.7 }}>Y axis</div>
        <div style={grid3}>
          <NumberCell label="waist" suffix="μm" value={isy.waistUm ?? 600} step={10}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeY", isy, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={isy.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("inputSpatialModeY", isy, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={isy.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("inputSpatialModeY", isy, { mSquared: v })} />
        </div>
        <label className="component-editor-coord" style={{ marginTop: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11 }}>Input polarization</span>
          <select value={inPolPreset} onChange={(e) => setInPolPreset(e.target.value)}>
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
          <NumberCell label="Eₓ_re" value={inPol.exRe ?? 0} step={0.05}
            onCommit={(v) => void persist({ inputPolarization: { ...inPol, exRe: v } })} />
          <NumberCell label="Eₓ_im" value={inPol.exIm ?? 0} step={0.05}
            onCommit={(v) => void persist({ inputPolarization: { ...inPol, exIm: v } })} />
          <NumberCell label="Eᵧ_re" value={inPol.eyRe ?? 1} step={0.05}
            onCommit={(v) => void persist({ inputPolarization: { ...inPol, eyRe: v } })} />
          <NumberCell label="Eᵧ_im" value={inPol.eyIm ?? 0} step={0.05}
            onCommit={(v) => void persist({ inputPolarization: { ...inPol, eyIm: v } })} />
        </div>
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
          <div style={grid2}>
            <NumberCell label="m" value={inTm.indicesM ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "TEM_mn", indicesM: Math.round(v) } })} />
            <NumberCell label="n" value={inTm.indicesN ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "TEM_mn", indicesN: Math.round(v) } })} />
          </div>
        )}
        {inTm.kind === "LG_pl" && (
          <div style={grid2}>
            <NumberCell label="p" value={inTm.indicesP ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "LG_pl", indicesP: Math.round(v) } })} />
            <NumberCell label="ℓ" value={inTm.indicesL ?? 0} step={1}
              onCommit={(v) => void persist({ inputTransverseMode: { ...inTm, kind: "LG_pl", indicesL: Math.round(v) } })} />
          </div>
        )}
      </div>

      {/* Output beam profile — applies at the intercept_out (−X / amplified) anchor */}
      <div style={sectionStyle}>
        <div style={titleStyle}>
          Output beam profile <span style={{ opacity: 0.7, fontWeight: 400 }}>@ <code>intercept_out</code></span>
        </div>
        <div style={{ marginBottom: 4, fontSize: 10, opacity: 0.7 }}>X axis</div>
        <div style={grid3}>
          <NumberCell label="waist" suffix="μm" value={osx.waistUm ?? 500} step={10}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeX", osx, { waistUm: v })} />
          <NumberCell label="z offset" suffix="mm" value={osx.waistZOffsetMm ?? 0} step={0.1}
            onCommit={(v) => setSpatial("outputSpatialModeX", osx, { waistZOffsetMm: v })} />
          <NumberCell label="M²" value={osx.mSquared ?? 1.5} step={0.05}
            onCommit={(v) => v > 0 && setSpatial("outputSpatialModeX", osx, { mSquared: v })} />
        </div>
        <div style={{ marginTop: 6, marginBottom: 4, fontSize: 10, opacity: 0.7 }}>Y axis</div>
        <div style={grid3}>
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
          <div style={grid2}>
            <NumberCell label="m" value={outTm.indicesM ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "TEM_mn", indicesM: Math.round(v) } })} />
            <NumberCell label="n" value={outTm.indicesN ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "TEM_mn", indicesN: Math.round(v) } })} />
          </div>
        )}
        {outTm.kind === "LG_pl" && (
          <div style={grid2}>
            <NumberCell label="p" value={outTm.indicesP ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "LG_pl", indicesP: Math.round(v) } })} />
            <NumberCell label="ℓ" value={outTm.indicesL ?? 0} step={1}
              onCommit={(v) => void persist({ outputTransverseMode: { ...outTm, kind: "LG_pl", indicesL: Math.round(v) } })} />
          </div>
        )}
        <label className="component-editor-coord" style={{ marginTop: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 11 }}>Output polarization</span>
          <select value={outPolPreset} onChange={(e) => setOutPolPreset(e.target.value)}>
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
          <NumberCell label="Eₓ_re" value={outPol.exRe ?? 0} step={0.05}
            onCommit={(v) => void persist({ outputPolarization: { ...outPol, exRe: v } })} />
          <NumberCell label="Eₓ_im" value={outPol.exIm ?? 0} step={0.05}
            onCommit={(v) => void persist({ outputPolarization: { ...outPol, exIm: v } })} />
          <NumberCell label="Eᵧ_re" value={outPol.eyRe ?? 1} step={0.05}
            onCommit={(v) => void persist({ outputPolarization: { ...outPol, eyRe: v } })} />
          <NumberCell label="Eᵧ_im" value={outPol.eyIm ?? 0} step={0.05}
            onCommit={(v) => void persist({ outputPolarization: { ...outPol, eyIm: v } })} />
        </div>
      </div>

      {/* Backward beam profile editor removed by user request — when not
          set in kindParams, the ray-tracer (rayTrace.ts:1689) and solver
          (optical_solver.py:499-500) both fall back to the forward
          profile, so the backward ASE arrow still has a sensible waist.
          Values pre-set via the API are still honoured. */}

      {/* Visualization — per-instance beam colour for the two emissions.
          Backward (input-port ASE) also has a Show toggle so the user can
          declutter the scene by hiding it; hiding skips the trace entirely
          so downstream optics also stop reflecting it. */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Visualization</div>
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
      </div>

      {/* Lookup-table summary (sampled tables — edit via API for now) */}
      <div style={sectionStyle}>
        <div style={titleStyle}>Lookup tables</div>
        <div style={{ opacity: 0.75, fontSize: 10 }}>
          aseSamples: <strong>{aseSamples.length}</strong> rows · gainSamples:{" "}
          <strong>{(params.gainSamples ?? []).length}</strong> rows.
          {aseSamples.length === 0 && (params.gainSamples ?? []).length === 0
            ? " None present — solver uses the steady-state + ASE values above."
            : " Solver interpolates these in preference to the steady-state values."}
        </div>
      </div>

      {/* Alignment */}
      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          className="primary-button"
          onClick={() => void alignInputToLaser()}
          title="Rotate + translate the TA so the nearest beam (within 25 mm of intercept_in) passes through both intercept_in and intercept_out. Reads anchor positions from PHY Editor."
        >
          Align INPUT to laser beam
        </button>
        <p className="mirror-adjust-hint" style={{ opacity: 0.7, marginTop: 4 }}>
          INPUT seed port is on the +X face for this TA model; output is on the
          opposite face. Without a seed the chip leaks ASE in both directions
          (see live readout above); once a seed beam reaches the input port,
          the gain table will saturate the forward output and partly suppress
          the backward emission.
        </p>
      </div>
    </div>
  );
}
